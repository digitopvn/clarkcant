import { type Instant, feedbackPrepareRequestSchema, feedbackPublishRequestSchema, feedbackReportIdSchema } from "@clarkcant/contracts";
import { getConversation, getFeedbackReport } from "@clarkcant/storage";

import { type PublishOptions, prepareFeedback, publishAndDescribe } from "../application/product-feedback.ts";
import { type NodeServices, buildTimeline } from "../services.ts";
import { appendHostReply } from "./conversations.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * The product feedback family (#510): what the host-owned Feedback Composer calls.
 *
 *   POST /feedback/reports { request, conversationId? }
 *       prepare a report — compose, redact, classify, search for what is already filed — and keep it as a draft.
 *       Nothing is filed. Answers `{ draft, diagnostics }`: the exact title and body that would be sent, and the
 *       safe diagnostics in the person's words.
 *   GET /feedback/reports/:reportId
 *       the report as it stands: `{ draft, status, publication? }`.
 *   POST /feedback/reports/:reportId/publish { conversationId }
 *       file it — or, for one sent before without a trustworthy answer, find out by its marker what that came to —
 *       and write the result card into the conversation. Answers `{ publication, eligibility?, messageId, timeline }`.
 *
 * Publishing from here is the person's own Create issue, so it is person-only (`isPersonOnlyRoute`): an AI client or a
 * remote surface that wants a report filed asks Clark, whose `report_feedback` the execution policy decides.
 */
export interface FeedbackRouteDeps {
  services: NodeServices;
  request: GatewayRequest;
  segments: string[];
  at: () => string;
  /** Tests shorten the read-back waits. */
  publishOptions?: PublishOptions;
}

export async function handleFeedbackRoutes(deps: FeedbackRouteDeps): Promise<GatewayResponse | undefined> {
  const { services, request, segments } = deps;
  if (segments[0] !== "feedback" || segments[1] !== "reports") return undefined;
  // SAFETY: the gateway's clock is `nowInstant` or a test's injected instant.
  const at = (): Instant => deps.at() as Instant;

  if (segments.length === 2) {
    if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "a report is prepared with POST");
    const body = readJson(request);
    if (!body.ok) return body.response;
    const parsed = feedbackPrepareRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(400, "INVALID_SCHEMA", `${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}`);
    }
    const conversationId = parsed.data.conversationId;
    if (conversationId !== undefined && getConversation(services.runtime.db, conversationId) === undefined) {
      return fail(404, "CONVERSATION_NOT_FOUND", `no conversation ${conversationId}`);
    }
    const prepared = await prepareFeedback(services, {
      request: parsed.data.request,
      ...(conversationId === undefined ? {} : { conversationId }),
      at,
    });
    if (!prepared.ok) return fail(500, prepared.code, prepared.message);
    return json(201, { draft: prepared.draft, diagnostics: prepared.diagnostics });
  }

  const reportId = feedbackReportIdSchema.safeParse(segments[2]);
  if (!reportId.success) return fail(404, "REPORT_NOT_FOUND", "no such report");

  if (segments.length === 3) {
    if (request.method !== "GET") return fail(405, "METHOD_NOT_ALLOWED", "a report is read with GET");
    const record = getFeedbackReport(services.runtime.db, reportId.data);
    if (record === undefined || record.principalId !== services.runtime.identity.ownerPrincipalId) {
      return fail(404, "REPORT_NOT_FOUND", `no report ${reportId.data}`);
    }
    return json(200, { draft: record.draft, status: record.status, ...(record.publication === undefined ? {} : { publication: record.publication }) });
  }

  if (segments.length === 4 && segments[3] === "publish") {
    if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "a report is published with POST");
    const body = readJson(request);
    if (!body.ok) return body.response;
    const parsed = feedbackPublishRequestSchema.safeParse(body.value);
    if (!parsed.success) return fail(400, "INVALID_SCHEMA", "conversationId is required");
    const { conversationId } = parsed.data;
    if (getConversation(services.runtime.db, conversationId) === undefined) {
      return fail(404, "CONVERSATION_NOT_FOUND", `no conversation ${conversationId}`);
    }
    const described = await publishAndDescribe(
      services,
      { reportId: reportId.data, conversationId, authority: { kind: "person" }, at },
      deps.publishOptions,
    );
    if (!described.ok) return fail(described.status ?? 409, described.code ?? "REPORT_FAILED", described.text);
    const appended = appendHostReply(services, {
      conversationId,
      blocks: [{ type: "text", format: "plain", content: described.text, streaming: false }, ...described.blocks],
      at: at(),
    });
    return json(200, {
      publication: described.publication,
      ...(described.eligibility === undefined ? {} : { eligibility: described.eligibility }),
      messageId: appended.messageId,
      timeline: buildTimeline(services, { conversationId, afterSequence: 0 }),
    });
  }

  return fail(404, "NOT_FOUND", `no feedback handler for ${request.method} ${request.path}`);
}

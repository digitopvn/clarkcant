import { readFileSync } from "node:fs";
import { homedir, release } from "node:os";

import {
  type DiagnosticLine,
  type EffectRecord,
  FEEDBACK_REPOSITORY,
  type FeedbackCard,
  type FeedbackDraft,
  type FeedbackIssueRef,
  type FeedbackKind,
  type FeedbackPublication,
  type FeedbackRelated,
  type FeedbackRequest,
  HANDLING_PREREQUISITES,
  type HandlingEligibility,
  type Instant,
  type IssueMention,
  type MessageBlock,
  type PhilosophyFit,
  type SafeDiagnostics,
  type TurnOrigin,
  advanceEffect,
  feedbackMarker,
} from "@clarkcant/contracts";
import { applyTaskEvent, decideExecution, readExecutionPolicy, recordEffectExecution, requestApproval } from "@clarkcant/core";
import {
  activeTaskGoalsMentioningIssue,
  appendEvent,
  asJsonValue,
  getEffect,
  getFeedbackReport,
  getTask,
  insertFeedbackReport,
  payloadDigest,
  transaction,
  updateFeedbackReport,
  upsertEffect,
  type FeedbackReportRecord,
} from "@clarkcant/storage";

import { preferredAppIntentLocale } from "../app-intents.ts";
import type { NodeServices } from "../services.ts";
import { nodeWork } from "../work-supervisor.ts";
import { type OpenedActionEffect, openActionEffect, settleActionEffect } from "./action-effects.ts";
import {
  classifyPhilosophy,
  composeIssueBody,
  composeOccurrenceComment,
  diagnosticLines,
  errorFingerprint,
  excerpt,
  issueRef,
  keywordsOf,
  manualIssueUrl,
  rankRelated,
  reportTitle,
  scrubOutbound,
} from "./feedback-compose.ts";
import {
  type FeedbackGithub,
  type FeedbackGithubClient,
  FeedbackGithubError,
  type GithubIssue,
  createNodeFeedbackGithub,
} from "./feedback-github.ts";

/**
 * Product feedback, end to end (#510): the one host-owned service every way of filing a report reaches.
 *
 * `/report`, a sentence to Clark (`report_feedback`), voice, and the Feedback Composer's Create issue all end here, so
 * what is shared, how it is redacted, where it goes and what is claimed about it are decided once:
 *
 *   1. **Prepare.** The person's words, the evidence they selected and — unless they turned it off — the safe
 *      diagnostics the node already knows, each through the shared redaction, composed into an issue with only the
 *      sections somebody wrote. Its philosophy fit is classified, and GitHub is searched for what is already filed.
 *      Kept as a draft under its own `rpt_` id.
 *   2. **Publish.** One external write, in the effect ledger before it is sent: a new issue, or a comment on the open
 *      issue it duplicates. Success is claimed only after GitHub is read back and holds the report's hidden marker.
 *      A write that got no trustworthy answer is `unknown` and is found again by that marker, never sent twice.
 *   3. **Eligibility.** Whether Clark may offer to handle the issue. Every check is real; this build's last answer is
 *      that handling is not available yet, because the backend it needs (#402, #508) does not exist.
 *
 * Who decides a publish: the person, when they press Create issue on the host's composer (a person-only route) or
 * approve the host's card; otherwise the execution policy, as for any external write.
 */

export type FeedbackServices = Pick<NodeServices, "runtime" | "conductor" | "currentModel" | "feedbackGithub">;

type Locale = "vi" | "en";

/** How long after a write with no answer an absent marker is trusted to mean GitHub never filed it. */
export const FEEDBACK_RECONCILE_GRACE_MS = 2 * 60_000;
/** How long the host's approval card for a report stays answerable. */
const APPROVAL_TTL_MS = 15 * 60_000;
const CAPABILITY_REF = "clark.feedback.publish";

/** The node's GitHub for reports: the injected one (tests, the browser fixture) or the person's own. */
export function feedbackGithubOf(services: Pick<NodeServices, "runtime" | "feedbackGithub">): FeedbackGithub {
  return services.feedbackGithub ?? createNodeFeedbackGithub(services);
}

function localeOf(services: Pick<NodeServices, "runtime">, at: () => Instant): Locale {
  return preferredAppIntentLocale({ db: services.runtime.db, now: at }, services.runtime.identity.ownerPrincipalId);
}

function sayIn(locale: Locale): (vi: string, en: string) => string {
  return (vi, en) => (locale === "vi" ? vi : en);
}

let cachedVersion: string | undefined;

/** ClarkCant's own version, from the workspace manifest it runs from; `unknown` when it cannot be read. */
export function clarkVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const manifest = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    cachedVersion = typeof manifest.version === "string" && manifest.version.length <= 40 ? manifest.version : "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

function osName(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform;
}

/**
 * The facts this node may share about itself by default. Read from the process and the node's own settings, never
 * from the conversation: no transcript, prompt, file, environment variable, log, path or credential reaches it. The
 * error, when the report is about one, is kept as a redacted 300-character excerpt and a fingerprint.
 */
export function collectSafeDiagnostics(
  services: Pick<NodeServices, "runtime" | "currentModel">,
  request: FeedbackRequest,
  at: Instant,
): SafeDiagnostics {
  const model = services.currentModel?.();
  const scrub = (text: string): string => scrubOutbound(text, homedir());
  return {
    clarkVersion: clarkVersion(),
    os: `${osName(process.platform)} ${release()}`.slice(0, 80),
    arch: process.arch.slice(0, 20),
    runtime: `node ${process.versions.node}`.slice(0, 60),
    locale: localeOf(services, () => at),
    inputMode: request.source,
    ...(model === undefined ? {} : { provider: model.provider.slice(0, 80), model: model.id.slice(0, 120) }),
    ...(request.subsystem === undefined ? {} : { subsystem: scrub(request.subsystem).slice(0, 80) }),
    ...(request.error?.code === undefined ? {} : { errorCode: scrub(request.error.code).slice(0, 120) }),
    ...(request.error === undefined
      ? {}
      : {
          errorMessage: excerpt(scrub(request.error.message), 300),
          errorFingerprint: errorFingerprint(request.error.code, scrub(request.error.message)),
        }),
    capturedAt: at,
  };
}

export type PrepareOutcome =
  | { ok: true; draft: FeedbackDraft; diagnostics: DiagnosticLine[] }
  | { ok: false; code: "STORE_FAILED"; message: string };

async function searchRelated(
  client: FeedbackGithubClient,
  repository: string,
  query: { title: string; description: string; fingerprint?: string; now: number },
): Promise<{ related: FeedbackRelated[]; duplicateOf?: FeedbackIssueRef } | { unavailable: string }> {
  const words = keywordsOf(`${query.title} ${query.description}`, 5);
  const candidates: GithubIssue[] = [];
  try {
    if (query.fingerprint !== undefined) candidates.push(...(await client.searchIssues(`repo:${repository} is:issue ${query.fingerprint}`)));
    if (words.length > 0) candidates.push(...(await client.searchIssues(`repo:${repository} is:issue ${words.join(" OR ")}`)));
  } catch (cause) {
    return { unavailable: cause instanceof Error ? cause.message.slice(0, 300) : "GitHub search failed" };
  }
  return rankRelated(candidates, query);
}

/**
 * Prepare a report: compose, redact, classify and search, then keep it as a draft. Nothing leaves the machine here
 * except the search, which carries only keywords of the already-redacted text and the error fingerprint.
 */
export async function prepareFeedback(
  services: FeedbackServices,
  input: { request: FeedbackRequest; conversationId?: string; at: () => Instant },
): Promise<PrepareOutcome> {
  const { request } = input;
  const at = input.at();
  const home = homedir();
  const scrub = (text: string): string => scrubOutbound(text, home);
  const github = feedbackGithubOf(services);
  const reportId = services.conductor.newId("rpt");
  const diagnostics = request.includeDiagnostics ? collectSafeDiagnostics(services, request, at) : undefined;
  const title = scrub(reportTitle(request.kind, request)).slice(0, 256);
  const description = scrub(request.description);
  const philosophy: PhilosophyFit | undefined =
    request.kind === "feature" || request.philosophy !== undefined
      ? classifyPhilosophy(
          [description, request.feature?.outcome, request.feature?.proposal].filter((part) => part !== undefined).join("\n"),
          request.philosophy === undefined
            ? undefined
            : { verdict: request.philosophy.verdict, ...(request.philosophy.note === undefined ? {} : { note: scrub(request.philosophy.note) }) },
        )
      : undefined;
  const found = await searchRelated(github.reader(), github.repository, {
    title,
    description,
    ...(diagnostics?.errorFingerprint === undefined ? {} : { fingerprint: diagnostics.errorFingerprint }),
    now: Date.parse(at),
  });
  const related = "unavailable" in found ? [] : found.related;
  const duplicateOf = "unavailable" in found ? undefined : found.duplicateOf;
  const body = composeIssueBody({ reportId, request, diagnostics, related, philosophy, scrub });
  const draft: FeedbackDraft = {
    reportId,
    kind: request.kind,
    source: request.source,
    repository: github.repository,
    title,
    body,
    labels: [request.kind === "bug" ? "bug" : "enhancement"],
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(philosophy === undefined ? {} : { philosophy }),
    related,
    relatedSearch: "unavailable" in found ? { state: "unavailable", reason: found.unavailable } : { state: "checked" },
    ...(duplicateOf === undefined ? {} : { duplicateOf, occurrence: composeOccurrenceComment({ reportId, request, diagnostics, scrub }) }),
    createdAt: at,
  };
  try {
    insertFeedbackReport(services.runtime.db, {
      reportId,
      principalId: services.runtime.identity.ownerPrincipalId,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      status: "draft",
      draft,
      createdAt: at,
      updatedAt: at,
    });
  } catch (cause) {
    return { ok: false, code: "STORE_FAILED", message: `the report could not be kept: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  return { ok: true, draft, diagnostics: diagnosticLines(diagnostics, localeOf(services, input.at)) };
}

/** Who decided this publish: the person (their Create issue, or their approval), or the execution policy for Clark. */
export type PublishAuthority = { kind: "person" } | { kind: "policy"; origin?: TurnOrigin };

export type PublishOutcome =
  | { ok: true; publication: FeedbackPublication; record: FeedbackReportRecord; approvalCard?: MessageBlock }
  | { ok: false; status: 404 | 409; code: string; message: string };

export interface PublishOptions {
  /** Waits between read-back attempts, in milliseconds. */
  readBackDelaysMs?: readonly number[];
  /** How long an unanswered attempt is given to appear on GitHub before its absence counts. */
  reconcileGraceMs?: number;
}

const DEFAULT_READ_BACK_DELAYS_MS = [0, 1000, 3000] as const;

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/** What an approval for a report covers: exactly this title and body, to exactly this place. */
export function feedbackPublishDigest(draft: FeedbackDraft): string {
  return payloadDigest(
    asJsonValue({
      kind: "feedback-publish",
      reportId: draft.reportId,
      repository: draft.repository,
      title: draft.title,
      body: draft.duplicateOf === undefined ? draft.body : (draft.occurrence ?? draft.body),
      ...(draft.duplicateOf === undefined ? {} : { commentOn: draft.duplicateOf.number }),
    }),
  );
}

/** Where it lands: the duplicate's issue for a comment, else the new issue. */
function describeWrite(draft: FeedbackDraft, locale: Locale): string {
  const say = sayIn(locale);
  return draft.duplicateOf === undefined
    ? say(
        `Tạo issue “${draft.title}” trên ${draft.repository}`,
        `Open issue “${draft.title}” on ${draft.repository}`,
      )
    : say(
        `Thêm một lần gặp lại vào issue #${String(draft.duplicateOf.number)} (“${draft.duplicateOf.title}”) trên ${draft.repository}`,
        `Add another occurrence to issue #${String(draft.duplicateOf.number)} (“${draft.duplicateOf.title}”) on ${draft.repository}`,
      );
}

function ledgerNow(): Instant {
  return new Date().toISOString() as Instant;
}

/**
 * Settle a report's effect on what GitHub was observed to hold, after the write itself went unanswered.
 *
 * Not the person's answer (`reconcileEffect` is that, and words its record as theirs): the evidence here is GitHub's
 * own list, read by the node. `unknown` moves only to `confirmed` or `failed` (`advanceEffect`), and an uncertain task
 * settles in the same write.
 */
function settleObserved(services: FeedbackServices, effect: EffectRecord, outcome: "confirmed" | "failed", evidence: string): void {
  if (effect.state !== "unknown" && effect.state !== "submitted") return;
  const deps = { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: ledgerNow, newId: services.conductor.newId };
  const at = deps.now();
  const from = effect.state === "submitted" ? advanceEffect(effect, { to: "unknown", at, reason: "the write's answer was never received" }) : { ok: true as const, effect };
  if (!from.ok) return;
  const moved = advanceEffect(from.effect, { to: outcome, at, evidence: evidence.slice(0, 1000) });
  if (!moved.ok) return;
  try {
    transaction(deps.db, () => {
      upsertEffect(deps.db, moved.effect);
      const task = getTask(deps.db, effect.taskId);
      appendEvent(deps.db, {
        eventId: deps.newId("evt"),
        kind: "effect.reconciled",
        stream: "task",
        nodeId: deps.nodeId,
        ...(task === undefined ? {} : { conversationId: task.conversationId }),
        taskId: effect.taskId,
        document: { taskId: effect.taskId, effectId: effect.effectId, outcome, decidedBy: "github-read-back", source: "observed", at },
        occurredAt: at,
      });
    });
    const task = getTask(deps.db, effect.taskId);
    if (task?.state === "uncertain") applyTaskEvent(deps, effect.taskId, outcome === "confirmed" ? "reconcile.succeeded" : "reconcile.failed");
    else if (task?.state === "running") {
      applyTaskEvent(deps, effect.taskId, "run.verifying");
      applyTaskEvent(deps, effect.taskId, outcome === "confirmed" ? "verify.passed" : "verify.failed");
    }
  } catch (cause) {
    process.stderr.write(`feedback: could not settle ${effect.effectId} (${cause instanceof Error ? cause.message : String(cause)})\n`);
  }
}

type MarkerLookup =
  | { kind: "found"; issue: FeedbackIssueRef; commentUrl?: string }
  | { kind: "absent" }
  | { kind: "lookup-failed"; reason: string };

/** Find the report on GitHub by its marker: the new issue it opened, or its comment on the duplicate. */
async function findByMarker(client: FeedbackGithubClient, draft: FeedbackDraft, since: Instant): Promise<MarkerLookup> {
  const marker = feedbackMarker(draft.reportId);
  try {
    if (draft.duplicateOf !== undefined) {
      const comment = await client.findCommentWithMarker(draft.duplicateOf.number, marker, since);
      return comment === undefined ? { kind: "absent" } : { kind: "found", issue: draft.duplicateOf, commentUrl: comment.url };
    }
    const issue = await client.findIssueWithMarker(marker, since);
    return issue === undefined ? { kind: "absent" } : { kind: "found", issue: issueRef(issue) };
  } catch (cause) {
    return { kind: "lookup-failed", reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

function save(
  services: FeedbackServices,
  record: FeedbackReportRecord,
  status: FeedbackReportRecord["status"],
  publication: FeedbackPublication,
  effectId?: string,
): FeedbackReportRecord {
  const at = ledgerNow();
  const moved = updateFeedbackReport(services.runtime.db, { reportId: record.reportId, status, publication, ...(effectId === undefined ? {} : { effectId }), at });
  // Already published by a concurrent attempt: what GitHub was read back holding wins.
  if (!moved) return getFeedbackReport(services.runtime.db, record.reportId) ?? record;
  return { ...record, status, publication, ...(effectId === undefined ? {} : { effectId }), updatedAt: at };
}

function published(record: FeedbackReportRecord, found: { issue: FeedbackIssueRef; commentUrl?: string }): FeedbackPublication {
  return {
    status: "published",
    reportId: record.reportId,
    mode: record.draft.duplicateOf === undefined ? "created" : "commented",
    issue: found.issue,
    ...(found.commentUrl === undefined ? {} : { commentUrl: found.commentUrl }),
    confirmedAt: ledgerNow(),
  };
}

/**
 * Publish a prepared report, or find out what an earlier publish of it came to.
 *
 * A report already published answers with what it is. One sent before without a trustworthy answer is looked for by
 * its marker first, and sent again only once GitHub's own list shows it absent well after the attempt — and never when
 * GitHub itself answered that it was filed.
 */
export async function publishFeedback(
  services: FeedbackServices,
  input: { reportId: string; conversationId: string; authority: PublishAuthority; at: () => Instant },
  options: PublishOptions = {},
): Promise<PublishOutcome> {
  let record = getFeedbackReport(services.runtime.db, input.reportId);
  if (record === undefined || record.principalId !== services.runtime.identity.ownerPrincipalId) {
    return { ok: false, status: 404, code: "REPORT_NOT_FOUND", message: `no report ${input.reportId} on this node` };
  }
  if (record.status === "published" && record.publication?.status === "published") {
    return { ok: true, publication: record.publication, record };
  }
  const github = feedbackGithubOf(services);
  const locale = localeOf(services, input.at);
  const say = sayIn(locale);
  const draft = record.draft;
  if (draft.repository !== FEEDBACK_REPOSITORY && services.feedbackGithub === undefined) {
    return { ok: false, status: 409, code: "WRONG_REPOSITORY", message: `reports go to ${FEEDBACK_REPOSITORY} only` };
  }

  // An earlier attempt that never got a trustworthy answer: look before anything is sent again.
  if (record.status === "publishing" || record.status === "unknown") {
    const effect = record.effectId === undefined ? undefined : getEffect(services.runtime.db, record.effectId);
    const lookup = await findByMarker(github.reader(), draft, record.updatedAt);
    if (lookup.kind === "found") {
      if (effect !== undefined) settleObserved(services, effect, "confirmed", `GitHub holds the report's marker in #${String(lookup.issue.number)}`);
      record = save(services, record, "published", published(record, lookup));
      return { ok: true, publication: record.publication as FeedbackPublication, record };
    }
    if (lookup.kind === "lookup-failed") {
      const publication: FeedbackPublication = {
        status: "unknown",
        reportId: record.reportId,
        reason: say(
          `Chưa kiểm tra được GitHub (${lookup.reason}). Báo cáo không được gửi lại cho tới khi biết chắc.`,
          `GitHub could not be checked (${lookup.reason}). The report is not sent again until it is known.`,
        ).slice(0, 600),
      };
      record = save(services, record, "unknown", publication);
      return { ok: true, publication: record.publication ?? publication, record };
    }
    const effectState = effect?.state;
    const settledFiled = effectState === "confirmed";
    // Measured on the same clock the attempt was stamped with.
    const tooSoon = Date.parse(ledgerNow()) - Date.parse(record.updatedAt) < (options.reconcileGraceMs ?? FEEDBACK_RECONCILE_GRACE_MS);
    if (settledFiled || tooSoon) {
      const publication: FeedbackPublication = {
        status: "unknown",
        reportId: record.reportId,
        reason: (settledFiled
          ? say(
              "GitHub đã trả lời là đã nhận, nhưng chưa tìm thấy báo cáo theo dấu của nó. Kiểm tra lại sau ít phút.",
              "GitHub answered that it was filed, but the report cannot be found by its marker yet. Check again in a few minutes.",
            )
          : say(
              "Chưa thấy báo cáo trên GitHub. Có thể GitHub vẫn đang xử lý; kiểm tra lại sau ít phút, nó không được gửi lại trước đó.",
              "The report is not on GitHub yet. GitHub may still be processing it; check again in a few minutes. It is not sent again before then.",
            )
        ).slice(0, 600),
      };
      record = save(services, record, "unknown", publication);
      return { ok: true, publication: record.publication ?? publication, record };
    }
    // Absent from GitHub's own list well after the attempt: it was never filed, and sending it now is the first time.
    if (effect !== undefined) settleObserved(services, effect, "failed", "GitHub's list holds no issue or comment with the report's marker");
  }

  // Who decides. The person's Create issue or approval is the decision; Clark's request is the policy's.
  const operationDigest = feedbackPublishDigest(draft);
  const description = describeWrite(draft, locale);
  if (input.authority.kind === "policy") {
    const origin = input.authority.origin;
    const execution = readExecutionPolicy({ db: services.runtime.db, now: input.at }, services.runtime.identity.ownerPrincipalId);
    const decided = decideExecution({
      policy: execution,
      action: { kind: "effect", category: "external-write", operationDigest },
      intent: origin === undefined ? { kind: "interactive" } : { kind: "interactive", origin },
    });
    if (decided.kind === "deny") {
      const publication: FeedbackPublication = { status: "refused", reportId: record.reportId, reason: decided.reason.slice(0, 600) };
      record = save(services, record, "draft", publication);
      return { ok: true, publication: record.publication ?? publication, record };
    }
    const coordination = { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: input.at, newId: services.conductor.newId };
    if (decided.kind === "ask") {
      const approval = requestApproval(coordination, {
        operationDigest,
        operationDescription: description.slice(0, 2000),
        effectCategory: "external-write",
        ttlMs: APPROVAL_TTL_MS,
      });
      const publication: FeedbackPublication = { status: "approval-required", reportId: record.reportId, approvalId: approval.approvalId };
      record = save(services, record, "draft", publication);
      const approvalCard = {
        type: "approval-card",
        owner: "host",
        approvalId: approval.approvalId,
        operationDescription: approval.operationDescription,
        operationDigest: approval.operationDigest,
        payload: JSON.stringify({ kind: "feedback-publish", reportId: record.reportId }),
        effectCategory: "external-write",
        expiresAt: approval.expiresAt,
        decider: approval.decider,
        decision: approval.decision,
        ...(origin === undefined ? {} : { origin }),
      } as MessageBlock;
      return { ok: true, publication: record.publication ?? publication, record, approvalCard };
    }
    recordEffectExecution(coordination, {
      principalId: services.runtime.identity.ownerPrincipalId,
      mode: execution.mode,
      decision: decided,
      category: "external-write",
      operationDigest,
      conversationId: input.conversationId,
      description: `Clark: ${description}`,
      ...(origin === undefined ? {} : { origin }),
    });
  }

  const current = record;
  const attempt = github.withWriter((client) => sendAndReadBack(services, client, current, input.conversationId, description, options));
  if (!attempt.ok) {
    const body = draft.duplicateOf === undefined ? draft.body : (draft.occurrence ?? draft.body);
    const publication: FeedbackPublication = {
      status: "needs-access",
      reportId: record.reportId,
      reason: say(
        `Chưa gửi được: ${attempt.reason}. Thêm token GitHub (secret “github_token”) để Clark gửi giúp, hoặc tự mở issue với nội dung đã chuẩn bị.`,
        `Not filed: ${attempt.reason}. Add a GitHub token (secret “github_token”) for Clark to file it, or open the issue yourself with the prepared text.`,
      ).slice(0, 600),
      manualUrl:
        draft.duplicateOf === undefined
          ? manualIssueUrl(draft.repository, draft.title, body, draft.labels)
          : draft.duplicateOf.url,
    };
    record = save(services, record, "draft", publication);
    return { ok: true, publication: record.publication ?? publication, record };
  }
  const sent = await attempt.result;
  return { ok: true, publication: sent.publication as FeedbackPublication, record: sent };
}

/** The write itself, inside the token's one use: ledger first, then GitHub, then GitHub read back. */
async function sendAndReadBack(
  services: FeedbackServices,
  client: FeedbackGithubClient,
  record: FeedbackReportRecord,
  conversationId: string,
  description: string,
  options: PublishOptions,
): Promise<FeedbackReportRecord> {
  const draft = record.draft;
  const say = sayIn(localeOf(services, ledgerNow));
  let opened: OpenedActionEffect;
  try {
    opened = openActionEffect(services, {
      conversationId,
      principalId: services.runtime.identity.ownerPrincipalId,
      capabilityRef: CAPABILITY_REF,
      args: { reportId: draft.reportId, repository: draft.repository, ...(draft.duplicateOf === undefined ? {} : { commentOn: draft.duplicateOf.number }) },
      intent: description,
      effectCategory: "external-write",
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return save(services, record, "failed", {
      status: "failed",
      reportId: record.reportId,
      reason: say(`Chưa gửi: không ghi được vào sổ hiệu ứng (${reason}).`, `Not sent: the effect ledger could not hold it (${reason}).`).slice(0, 600),
      retryable: true,
    });
  }
  let sending = save(services, record, "publishing", { status: "unknown", reportId: record.reportId, reason: "sending" }, opened.effect.effectId);

  let written: { issueNumber: number; commentId?: number };
  try {
    if (draft.duplicateOf === undefined) {
      const issue = await client.createIssue({ title: draft.title, body: draft.body, labels: draft.labels });
      written = { issueNumber: issue.number };
    } else {
      const comment = await client.createComment(draft.duplicateOf.number, draft.occurrence ?? draft.body);
      written = { issueNumber: draft.duplicateOf.number, commentId: comment.id };
    }
  } catch (cause) {
    const failure = cause instanceof FeedbackGithubError ? cause : new FeedbackGithubError("no-answer", cause instanceof Error ? cause.message : String(cause));
    if (failure.kind !== "no-answer") {
      settleActionEffect(services, opened, {
        kind: "not-sent",
        reason: failure.kind === "refused" ? `GitHub refused it, so nothing was filed (${failure.message})` : failure.message,
      });
      return save(services, sending, "failed", {
        status: "failed",
        reportId: record.reportId,
        reason: say(`Không gửi được: ${failure.message}. Không có gì được tạo.`, `Not filed: ${failure.message}. Nothing was created.`).slice(0, 600),
        retryable: failure.retryable,
      });
    }
    // Sent, and no answer to trust. Look once now; otherwise it is unknown and found again by its marker.
    const lookup = await findByMarker(client, draft, sending.updatedAt);
    if (lookup.kind === "found") {
      settleActionEffect(services, opened, { kind: "answered", evidence: `GitHub holds the report's marker in #${String(lookup.issue.number)}` });
      return save(services, sending, "published", published(sending, lookup));
    }
    settleActionEffect(services, opened, { kind: "no-answer", stopped: false, reason: failure.message });
    return save(services, sending, "unknown", {
      status: "unknown",
      reportId: record.reportId,
      reason: say(
        `Đã gửi nhưng GitHub không trả lời rõ (${failure.message}). Clark sẽ tìm lại theo dấu của báo cáo, không gửi lại.`,
        `Sent, but GitHub's answer never arrived (${failure.message}). Clark finds it again by the report's marker and does not send it twice.`,
      ).slice(0, 600),
    });
  }

  // GitHub answered. Success is what reading it back shows, not what the answer said.
  const marker = feedbackMarker(draft.reportId);
  for (const delay of options.readBackDelaysMs ?? DEFAULT_READ_BACK_DELAYS_MS) {
    await sleep(delay);
    try {
      if (written.commentId !== undefined) {
        const comment = await client.getComment(written.commentId);
        if (comment !== undefined && comment.body.includes(marker) && draft.duplicateOf !== undefined) {
          settleActionEffect(services, opened, { kind: "answered", evidence: `read back comment ${comment.url} with the report's marker` });
          return save(services, sending, "published", published(sending, { issue: draft.duplicateOf, commentUrl: comment.url }));
        }
      } else {
        const issue = await client.getIssue(written.issueNumber);
        if (issue !== undefined && issue.body.includes(marker)) {
          settleActionEffect(services, opened, { kind: "answered", evidence: `read back #${String(issue.number)} with the report's marker` });
          return save(services, sending, "published", published(sending, { issue: issueRef(issue) }));
        }
      }
    } catch {
      // A read that failed is another attempt, not an answer.
    }
  }
  // GitHub said it was filed; it could not be read back yet. The ledger keeps GitHub's answer; the report stays unknown.
  settleActionEffect(services, opened, { kind: "answered", evidence: `GitHub answered with #${String(written.issueNumber)}; reading it back did not succeed yet` });
  sending = save(services, sending, "unknown", {
    status: "unknown",
    reportId: record.reportId,
    reason: say(
      `GitHub trả lời là đã nhận (#${String(written.issueNumber)}) nhưng chưa đọc lại được. Kiểm tra lại sau ít phút.`,
      `GitHub answered with #${String(written.issueNumber)}, but it could not be read back yet. Check again in a few minutes.`,
    ).slice(0, 600),
  });
  return sending;
}

const BLOCKER_MENTION = /(?:blocked by|depends on|waiting on|bị chặn bởi|phụ thuộc(?: vào)?)\s+#(\d{1,7})/giu;

/**
 * Whether Clark may offer to handle issue `#issueNumber` now, checked against GitHub as it is, in the order a person
 * would rule it out. Every check must pass before the last one — and the last one, in this build, never does: the
 * canonical background execution backend (#402) and the `dev` release contract (#508) it needs are not available yet.
 * So this never returns `eligible: true` today, and nothing offers a Handle button.
 */
export async function checkHandlingEligibility(
  services: Pick<NodeServices, "runtime" | "feedbackGithub">,
  input: { issueNumber: number; philosophy?: PhilosophyFit; at: () => Instant },
): Promise<HandlingEligibility> {
  const say = sayIn(localeOf(services, input.at));
  const github = feedbackGithubOf(services);
  const client = github.reader();
  const no = (
    code: Extract<HandlingEligibility, { eligible: false }>["code"],
    reason: string,
    blockers: IssueMention[] = [],
    suggestion?: "plan-split",
  ): HandlingEligibility => ({
    eligible: false,
    code,
    reason: reason.slice(0, 600),
    blockers: blockers.slice(0, 10),
    ...(suggestion === undefined ? {} : { suggestion }),
  });
  let issue: GithubIssue | undefined;
  try {
    issue = await client.getIssue(input.issueNumber);
  } catch (cause) {
    return no("unreadable", say(`Chưa đọc được issue #${String(input.issueNumber)}: ${cause instanceof Error ? cause.message : String(cause)}.`, `Issue #${String(input.issueNumber)} could not be read: ${cause instanceof Error ? cause.message : String(cause)}.`));
  }
  if (issue === undefined || issue.isPullRequest) {
    return no("unreadable", say(`GitHub không có issue #${String(input.issueNumber)} trong ${github.repository}.`, `GitHub has no issue #${String(input.issueNumber)} in ${github.repository}.`));
  }
  if (!issue.url.startsWith(`https://github.com/${github.repository}/issues/`)) {
    return no("wrong-repository", say(`Issue này không thuộc ${github.repository}.`, `This issue is not in ${github.repository}.`));
  }
  if (issue.state === "closed") return no("issue-closed", say("Issue đã đóng.", "The issue is closed."));
  const labels = issue.labels.map((label) => label.toLowerCase());
  if (/^epic\b/iu.test(issue.title) || labels.includes("epic")) {
    return no("epic", say("Đây là một epic: cần lập kế hoạch và chia nhỏ trước, không xử lý trong một lần.", "This is an epic: it is planned and split first, not handled in one change."), [], "plan-split");
  }
  if (issue.assignees.length > 0) {
    return no("assigned", say(`Issue đã có người nhận (${issue.assignees.join(", ")}).`, `The issue is assigned (${issue.assignees.join(", ")}).`));
  }
  if (labels.includes("in progress") || labels.includes("in review")) {
    return no("in-progress", say("Issue đang được làm hoặc review.", "The issue is already in progress or in review."));
  }
  const mentioned = [...issue.body.matchAll(BLOCKER_MENTION)].map((match) => Number(match[1])).filter((n) => n !== issue.number);
  if (labels.includes("external-gate")) {
    return no("external-gate", say("Issue chờ một điều kiện bên ngoài (external-gate).", "The issue waits on an external gate."));
  }
  if (labels.includes("blocked")) {
    return no("blocked", say("Issue đang bị chặn.", "The issue is blocked."), mentioned.map((number) => ({ number })));
  }
  let activity: Awaited<ReturnType<FeedbackGithubClient["issueActivity"]>>;
  try {
    activity = await client.issueActivity(issue.number);
  } catch (cause) {
    return no("unreadable", say(`Chưa đọc được hoạt động của issue: ${cause instanceof Error ? cause.message : String(cause)}.`, `The issue's activity could not be read: ${cause instanceof Error ? cause.message : String(cause)}.`));
  }
  if (activity.openPullRequests.length > 0) {
    return no("open-pull-request", say("Đã có pull request đang mở cho issue này.", "An open pull request already references this issue."), activity.openPullRequests);
  }
  if (activity.claimedBy !== undefined) {
    return no("in-progress", say(`${activity.claimedBy} đã nhận issue này trong bình luận.`, `${activity.claimedBy} has claimed this issue in a comment.`));
  }
  const openBlockers: IssueMention[] = [];
  for (const number of mentioned.slice(0, 5)) {
    try {
      const blocker = await client.getIssue(number);
      if (blocker !== undefined && blocker.state === "open") openBlockers.push({ number, title: blocker.title.slice(0, 300), url: blocker.url });
    } catch {
      openBlockers.push({ number });
    }
  }
  if (openBlockers.length > 0) {
    return no("blocked", say("Issue phụ thuộc vào việc khác chưa xong.", "The issue depends on work that is still open."), openBlockers);
  }
  const busy = [
    ...activeTaskGoalsMentioningIssue(services.runtime.db, issue.number),
    ...nodeWork()
      .list()
      .map((view) => view.title)
      .filter((title) => new RegExp(`#${String(issue.number)}(?!\\d)`, "u").test(title)),
  ];
  if (busy.length > 0) {
    return no("active-clark-work", say("Clark đang có việc dở dang cho issue này.", "Clark already has work under way on this issue."));
  }
  if (input.philosophy?.verdict === "material-conflict") {
    return no(
      "philosophy-conflict",
      say(
        "Yêu cầu xung đột với triết lý sản phẩm; cần người quyết định đổi triết lý, chọn hướng tương thích hoặc từ chối.",
        "The request conflicts with the product philosophy; a person decides whether to change it, adopt a compatible alternative, or decline.",
      ),
    );
  }
  return no(
    "handling-unavailable",
    say(
      "Clark chưa thể tự xử lý issue: backend chạy nền chuẩn (#402) và hợp đồng nhánh dev/phát hành (#508) chưa có.",
      "Clark cannot handle issues yet: the canonical background execution backend (#402) and the dev-branch release contract (#508) are not available.",
    ),
    [...HANDLING_PREREQUISITES],
  );
}

/** The Feedback Composer, summoned into the conversation: kind, starting words, and exactly what would be shared. */
export function feedbackComposeCard(
  services: FeedbackServices,
  input: { kind?: FeedbackKind; description?: string; source: FeedbackRequest["source"]; at: () => Instant },
): FeedbackCard {
  const at = input.at();
  const preview = collectSafeDiagnostics(services, { kind: input.kind ?? "bug", description: "-", source: input.source, includeDiagnostics: true }, at);
  return {
    type: "feedback-card",
    owner: "host",
    cardId: services.conductor.newId("card"),
    stage: "compose",
    repository: feedbackGithubOf(services).repository,
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.description === undefined || input.description.trim() === "" ? {} : { description: input.description.trim().slice(0, 4000) }),
    diagnostics: diagnosticLines(preview, localeOf(services, input.at)),
    updatedAt: at,
  };
}

/** What a publish came to, as the host's card, written when it happened. */
export function feedbackResultCard(
  services: FeedbackServices,
  input: { record: FeedbackReportRecord; publication: FeedbackPublication; eligibility?: HandlingEligibility; at: () => Instant },
): FeedbackCard {
  const { draft } = input.record;
  return {
    type: "feedback-card",
    owner: "host",
    cardId: services.conductor.newId("card"),
    stage: "result",
    repository: draft.repository,
    kind: draft.kind,
    diagnostics: diagnosticLines(draft.diagnostics, localeOf(services, input.at)),
    reportId: draft.reportId,
    title: draft.title,
    publication: input.publication,
    related: draft.related,
    ...(draft.philosophy === undefined ? {} : { philosophy: draft.philosophy }),
    ...(input.eligibility === undefined ? {} : { eligibility: input.eligibility }),
    updatedAt: input.at(),
  };
}

/** One sentence about a publication, in the person's language: what is known, and nothing more. */
export function describePublication(publication: FeedbackPublication, locale: Locale): string {
  const say = sayIn(locale);
  switch (publication.status) {
    case "published":
      return publication.mode === "created"
        ? say(`Đã tạo issue #${String(publication.issue.number)}: ${publication.issue.url}`, `Opened issue #${String(publication.issue.number)}: ${publication.issue.url}`)
        : say(
            `Đã có issue trùng đang mở, nên Clark thêm lần gặp này vào #${String(publication.issue.number)}: ${publication.commentUrl ?? publication.issue.url}`,
            `An open issue already covers this, so Clark added this occurrence to #${String(publication.issue.number)}: ${publication.commentUrl ?? publication.issue.url}`,
          );
    case "unknown":
      return say(`Chưa biết kết quả: ${publication.reason}`, `Outcome not known yet: ${publication.reason}`);
    case "failed":
      return say(`Chưa gửi được báo cáo. ${publication.reason}`, `The report was not filed. ${publication.reason}`);
    case "needs-access":
      return publication.reason;
    case "approval-required":
      return say(
        "Báo cáo đã sẵn sàng; chính sách thực thi muốn bạn duyệt trước khi gửi lên GitHub. Chưa có gì được gửi.",
        "The report is ready; your execution policy asks you to approve it before it goes to GitHub. Nothing has been sent.",
      );
    case "refused":
      return say(`Chính sách thực thi không cho gửi lên GitHub: ${publication.reason}. Chưa có gì được gửi.`, `Your execution policy does not allow writing to GitHub: ${publication.reason}. Nothing was sent.`);
  }
}

/** The issue a publication landed in, when it landed. */
function landedIssue(publication: FeedbackPublication): number | undefined {
  return publication.status === "published" ? publication.issue.number : undefined;
}

/**
 * Prepare and publish in one go, and build what the conversation shows: the sentence, the result card, and the host's
 * approval card when the policy asks. Used by `/report bug …`, by `report_feedback` and by an approved card.
 */
export async function fileFeedback(
  services: FeedbackServices,
  input: { request: FeedbackRequest; conversationId: string; authority: PublishAuthority; at: () => Instant },
  options: PublishOptions = {},
): Promise<{ ok: true; text: string; blocks: MessageBlock[]; publication: FeedbackPublication } | { ok: false; text: string }> {
  const locale = localeOf(services, input.at);
  const prepared = await prepareFeedback(services, { request: input.request, conversationId: input.conversationId, at: input.at });
  if (!prepared.ok) return { ok: false, text: prepared.message };
  return await publishAndDescribe(services, { reportId: prepared.draft.reportId, conversationId: input.conversationId, authority: input.authority, at: input.at, locale }, options);
}

/** Publish an existing report and describe it, with eligibility when it landed. */
export async function publishAndDescribe(
  services: FeedbackServices,
  input: { reportId: string; conversationId: string; authority: PublishAuthority; at: () => Instant; locale?: Locale },
  options: PublishOptions = {},
): Promise<{ ok: true; text: string; blocks: MessageBlock[]; publication: FeedbackPublication; eligibility?: HandlingEligibility } | { ok: false; text: string; status?: number; code?: string }> {
  const locale = input.locale ?? localeOf(services, input.at);
  const outcome = await publishFeedback(services, input, options);
  if (!outcome.ok) return { ok: false, text: outcome.message, status: outcome.status, code: outcome.code };
  const issueNumber = landedIssue(outcome.publication);
  const eligibility =
    issueNumber === undefined
      ? undefined
      : await checkHandlingEligibility(services, {
          issueNumber,
          ...(outcome.record.draft.philosophy === undefined ? {} : { philosophy: outcome.record.draft.philosophy }),
          at: input.at,
        });
  const card = feedbackResultCard(services, { record: outcome.record, publication: outcome.publication, ...(eligibility === undefined ? {} : { eligibility }), at: input.at });
  return {
    ok: true,
    text: describePublication(outcome.publication, locale),
    blocks: [card as MessageBlock, ...(outcome.approvalCard === undefined ? [] : [outcome.approvalCard])],
    publication: outcome.publication,
    ...(eligibility === undefined ? {} : { eligibility }),
  };
}

/** Whether an approval card's payload is a report waiting to be filed. */
export function isFeedbackPublishPayload(payload: string): boolean {
  try {
    return (JSON.parse(payload) as { kind?: unknown }).kind === "feedback-publish";
  } catch {
    return false;
  }
}

/** The refusal receipt for a denied report card, in the person's language. */
export function deniedFeedbackLabel(locale: Locale): string {
  return sayIn(locale)("Đã từ chối: báo cáo không được gửi lên GitHub.", "Refused: the report was not sent to GitHub.");
}

/**
 * File a report the person approved on the host's card. The draft is hashed again against the digest the decision
 * covered, so what is filed is what was shown, and a refusal the person set since still stands.
 */
export async function runApprovedFeedbackPublish(
  services: FeedbackServices,
  input: { payload: string; expectedDigest: string; approvalId: string; conversationId: string; at: () => Instant },
  options: PublishOptions = {},
): Promise<{ ok: true; blocks: MessageBlock[]; description: string } | { ok: false; code: string; message: string }> {
  const startedAt = input.at();
  let reportId: unknown;
  try {
    reportId = (JSON.parse(input.payload) as { reportId?: unknown }).reportId;
  } catch {
    return { ok: false, code: "APPROVAL_PAYLOAD_UNREADABLE", message: "the approved payload is not readable" };
  }
  if (typeof reportId !== "string") return { ok: false, code: "APPROVAL_PAYLOAD_UNREADABLE", message: "the approved payload names no report" };
  const record = getFeedbackReport(services.runtime.db, reportId);
  if (record === undefined) return { ok: false, code: "REPORT_NOT_FOUND", message: `no report ${reportId} on this node` };
  if (feedbackPublishDigest(record.draft) !== input.expectedDigest) {
    return { ok: false, code: "APPROVAL_FORGED", message: "the report changed after it was displayed; the decision does not cover what would be sent" };
  }
  const execution = readExecutionPolicy({ db: services.runtime.db, now: input.at }, services.runtime.identity.ownerPrincipalId);
  const now = decideExecution({
    policy: execution,
    action: { kind: "effect", category: "external-write", operationDigest: input.expectedDigest },
    intent: { kind: "interactive" },
  });
  if (now.kind === "deny") return { ok: false, code: "POLICY_REFUSED", message: now.reason };
  const described = await publishAndDescribe(services, { reportId, conversationId: input.conversationId, authority: { kind: "person" }, at: input.at }, options);
  if (!described.ok) return { ok: false, code: described.code ?? "REPORT_FAILED", message: described.text };
  // The receipt carries the approval id, so the card it answered reads as decided, including after a reload.
  const receipt = {
    type: "tool-activity",
    toolCallId: `feedback-${input.approvalId}`,
    name: "report_feedback",
    label: described.text.slice(0, 300),
    status: "done",
    args: { approvalId: input.approvalId, decision: "granted", reportId },
    startedAt,
    endedAt: input.at(),
  } as MessageBlock;
  return {
    ok: true,
    blocks: [receipt, ...described.blocks],
    description: `filed product report ${reportId} on ${record.draft.repository} after the person approved it`,
  };
}

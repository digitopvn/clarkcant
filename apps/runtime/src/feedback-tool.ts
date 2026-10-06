import { type FeedbackRequest, type Instant, type TurnOrigin, feedbackRequestSchema } from "@clarkcant/contracts";
import type { ToolDefinition } from "@clarkcant/pi-adapter";

import { type FeedbackServices, feedbackComposeCard, fileFeedback } from "./application/product-feedback.ts";

/**
 * `report_feedback`: a bug report or a feature request about ClarkCant itself, from a sentence or from voice (#510).
 *
 * The same service `/report` and the Feedback Composer reach (`application/product-feedback.ts`), so the model only
 * says what the person said, section by section. Diagnostics, redaction, the repository, duplicates, the publish and its
 * outcome are the host's: the model cannot add a diagnostic, aim a report elsewhere, or claim it was filed. Filing is an
 * external write the execution policy decides, like any other.
 */

export interface FeedbackToolDeps {
  services: () => FeedbackServices;
  conversationId: string;
  /** Which surface the message came in on, read at call time: the tool list outlives any one message. */
  channel: () => "voice" | "chat";
  /** Who asked for the turn, handed to the execution policy. Absent is the person. */
  origin?: () => TurnOrigin | undefined;
  now?: () => Instant;
}

const ACTIONS = ["file", "compose"] as const;

const sectionText = { type: "string", maxLength: 2000 } as const;

export function createFeedbackTool(input: FeedbackToolDeps): ToolDefinition {
  const now = input.now ?? ((): Instant => new Date().toISOString() as Instant);
  return {
    name: "report_feedback",
    label: "Báo lỗi / đề xuất",
    description:
      "File a bug report or a feature request about ClarkCant itself on its GitHub repository, when the person asks to " +
      "report a problem with Clark or wants Clark to have a capability. Use action compose to put the Feedback Composer " +
      "in the conversation for the person to review and send; use file to prepare and send it now. Fill only what the " +
      "person actually said: never invent reproduction steps, expected behaviour, frequency or impact — leave a field out " +
      "and the issue says it is not known yet. Do not paste transcripts, prompts, files, logs or paths; the host adds " +
      "safe diagnostics itself and redacts secrets. For a feature, keep the person's outcome and give your reading of its " +
      "fit with ClarkCant's philosophy (aligned, aligned-with-constraints, material-conflict) — a conflict is still filed " +
      "as asked. The host searches for duplicates and adds to an open duplicate instead of opening another. Filing follows " +
      "the execution policy: it may run now, wait on an approval card only the person can approve, or be refused; the " +
      "result says which, and says the issue exists only once GitHub was read back holding it.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "description"],
      properties: {
        action: { type: "string", enum: [...ACTIONS], description: "file (default) or compose." },
        kind: { type: "string", enum: ["bug", "feature"] },
        description: { type: "string", maxLength: 4000, description: "What the person said, in their words." },
        title: { type: "string", maxLength: 200, description: "A short title, only if the person's words suggest one." },
        subsystem: { type: "string", maxLength: 80, description: "The part of ClarkCant it is about, e.g. voice, composer, widgets." },
        includeDiagnostics: { type: "boolean", description: "Share safe diagnostics (version, OS, runtime, model). Default true." },
        bug: {
          type: "object",
          additionalProperties: false,
          properties: { actual: sectionText, expected: sectionText, reproduction: { type: "string", maxLength: 4000 }, frequency: sectionText, impact: sectionText },
        },
        feature: {
          type: "object",
          additionalProperties: false,
          properties: {
            problem: sectionText,
            outcome: sectionText,
            example: sectionText,
            proposal: sectionText,
            nonGoals: sectionText,
            acceptance: sectionText,
            replaceability: sectionText,
          },
        },
        error: {
          type: "object",
          additionalProperties: false,
          required: ["message"],
          properties: { code: { type: "string", maxLength: 120 }, message: { type: "string", maxLength: 2000 } },
          description: "The error the report is about, as the person or this conversation saw it.",
        },
        philosophy: {
          type: "object",
          additionalProperties: false,
          required: ["verdict"],
          properties: {
            verdict: { type: "string", enum: ["aligned", "aligned-with-constraints", "material-conflict"] },
            note: { type: "string", maxLength: 1000 },
          },
        },
      },
    },
    promptSnippet: "report_feedback — file a bug report or feature request about ClarkCant (only what the person said)",
    execute: async (params: Record<string, unknown>): Promise<{ text: string; hostCard?: Record<string, unknown> }> => {
      const action = params.action === undefined ? "file" : params.action;
      if (action !== "file" && action !== "compose") return { text: `"${String(action)}" is not an action; use file or compose.` };
      const source = input.channel() === "voice" ? "voice" : "chat";
      const { action: _action, ...fields } = params;
      const parsed = feedbackRequestSchema.safeParse({ ...fields, source });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { text: `The report is not valid: ${issue?.path.join(".") || "report"}: ${issue?.message ?? "invalid"}. Nothing was filed.` };
      }
      const request: FeedbackRequest = parsed.data;
      const services = input.services();
      if (action === "compose") {
        const card = feedbackComposeCard(services, { kind: request.kind, description: request.description, source, at: now });
        return {
          text: "The Feedback Composer is in the conversation. Nothing is filed until the person presses Create issue.",
          hostCard: card as unknown as Record<string, unknown>,
        };
      }
      const origin = input.origin?.();
      const filed = await fileFeedback(services, {
        request,
        conversationId: input.conversationId,
        authority: origin === undefined ? { kind: "policy" } : { kind: "policy", origin },
        at: now,
      });
      if (!filed.ok) return { text: `${filed.text} Nothing was filed.` };
      // The result card, and after it the host's approval card when the policy asks the person first.
      const [card, ...rest] = filed.blocks;
      const status = filed.publication.status;
      const caution =
        status === "published"
          ? ""
          : status === "approval-required"
            ? " Do not say it was filed: it waits on the person's approval."
            : " Do not say it was filed.";
      return {
        text: `${filed.text}${caution}`,
        ...(card === undefined ? {} : { hostCard: card as unknown as Record<string, unknown> }),
        ...(rest.length === 0 ? {} : { hostBlocks: rest as unknown as Record<string, unknown>[] }),
      };
    },
  };
}

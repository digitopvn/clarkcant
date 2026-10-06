import { type FeedbackRequest, type Instant, feedbackRequestSchema } from "@clarkcant/contracts";
import type { ToolDefinition } from "@clarkcant/pi-adapter";

import { type FeedbackServices, composeFeedback } from "./application/product-feedback.ts";

/**
 * `report_feedback`: a bug report or a feature request about ClarkCant itself, from a sentence or from voice (#510).
 *
 * The same service `/report` and the Feedback Composer reach (`application/product-feedback.ts`), so the model only
 * says what the person said, section by section. Diagnostics, redaction, the repository and duplicates are the host's:
 * the model cannot add a diagnostic, aim a report elsewhere, or claim it was filed.
 *
 * The tool prepares and shows; it never files. Its answer is the host's composer card holding the exact redacted
 * issue, and only the person's own Create issue on that card publishes it. Publishing conversation content is public and
 * cannot be taken back, and a turn — possibly steered by text it read — must not approve its own external write.
 * Earlier builds had a `file` action; it is gone, and a call that still asks for it is told so and gets the card.
 */

export interface FeedbackToolDeps {
  services: () => FeedbackServices;
  conversationId: string;
  /** Which surface the message came in on, read at call time: the tool list outlives any one message. */
  channel: () => "voice" | "chat";
  now?: () => Instant;
}

const sectionText = { type: "string", maxLength: 2000 } as const;

export function createFeedbackTool(input: FeedbackToolDeps): ToolDefinition {
  const now = input.now ?? ((): Instant => new Date().toISOString() as Instant);
  return {
    name: "report_feedback",
    label: "Báo lỗi / đề xuất",
    description:
      "Prepare a bug report or a feature request about ClarkCant itself for its GitHub repository, when the person asks to " +
      "report a problem with Clark or wants Clark to have a capability. It does not file anything: it puts the exact " +
      "redacted issue in the conversation as the host's card, and the report is filed only if the person reads it and " +
      "presses Create issue. Fill only what the person actually said: never invent reproduction steps, expected " +
      "behaviour, frequency or impact — leave a field out and the issue says it is not known yet. Do not paste " +
      "transcripts, prompts, files, logs or paths; the host adds safe diagnostics itself and redacts secrets. For a " +
      "feature, keep the person's outcome and give your reading of its fit with ClarkCant's philosophy (aligned, " +
      "aligned-with-constraints, material-conflict) — a conflict is still prepared as asked. The host searches for " +
      "duplicates and, when an open one exists, the card offers to add to it instead of opening another. Never say the " +
      "report was filed: say it is ready for the person to check and send.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "description"],
      properties: {
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
    promptSnippet: "report_feedback — prepare a bug report or feature request about ClarkCant for the person to check and send",
    execute: async (params: Record<string, unknown>): Promise<{ text: string; hostCard?: Record<string, unknown> }> => {
      const source = input.channel() === "voice" ? "voice" : "chat";
      // `action` is no longer a parameter. A call that still sends one is not refused for it, and is told the truth.
      const { action, ...fields } = params;
      const askedToFile = action === "file";
      const parsed = feedbackRequestSchema.safeParse({ ...fields, source });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { text: `The report is not valid: ${issue?.path.join(".") || "report"}: ${issue?.message ?? "invalid"}. Nothing was prepared or filed.` };
      }
      const request: FeedbackRequest = parsed.data;
      const composed = await composeFeedback(input.services(), { request, conversationId: input.conversationId, at: now });
      if (!composed.ok) return { text: `${composed.text} Nothing was prepared or filed.` };
      const [card] = composed.blocks;
      return {
        text:
          `${composed.text} Do not say it was filed: it is filed only if the person presses Create issue on the card.` +
          (askedToFile ? " (This tool no longer files reports itself; it prepared the report instead.)" : ""),
        ...(card === undefined ? {} : { hostCard: card as unknown as Record<string, unknown> }),
      };
    },
  };
}

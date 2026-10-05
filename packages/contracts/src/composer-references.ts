import { z } from "zod";

import { slashCommandSchema } from "./slash-commands.ts";

/**
 * What a person points at from the composer: a skill with `/`, and a project, a file, a service, a conversation, a
 * piece of background work or a notice with `@`.
 *
 * Three rules shape this contract:
 *
 * 1. **A reference is a pointer, not a grant.** Naming a folder does not let Clark read it, naming a service does not
 *    widen what its tools may do, and naming a conversation does not open it. Whatever the turn then does goes through
 *    the tools and the policy it would have gone through anyway.
 * 2. **The node decides what a reference means, at send time.** The picker offers what was true when it opened; the
 *    node checks each reference again when the message is sent, so a skill removed or edited since, a file deleted or a
 *    project now outside the approved roots is refused by name instead of being quietly replaced by something else.
 * 3. **A path is relative to the project that holds it.** Never absolute, never a drive, never `..`: the reference says
 *    where something is inside a project the node already indexed, and the node resolves it against that project.
 *
 * One contract for the composer and the inbox: "Ask Clark" about a notice is the same reference a person could have
 * typed, not a second way of pasting text into a prompt.
 */

/** The version of the wire shape a message carries its references in. */
export const COMPOSER_REFERENCES_VERSION = 1;

/** References in one message. It bounds the prompt a message can ask the node to build. */
export const COMPOSER_REFERENCES_MAX = 8;

/** The display label a reference carries, as it was when it was chosen. */
const labelSchema = z.string().min(1).max(120);
const idSchema = z.string().min(1).max(128);

/**
 * A path inside a project, as a person would write it: forward slashes, no leading slash, no drive, no `..`.
 *
 * Refused rather than normalised, because a reference whose shape is a way out of the project is a mistake or an
 * attempt, and neither should be silently turned into something else. The node still resolves the real path and
 * checks it is inside the project, because a symlink can leave a directory that no `..` ever named.
 */
export const projectRelativePathSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine((path) => !path.startsWith("/") && !path.includes("\\") && !/^[a-zA-Z]:/.test(path), {
    error: "must be relative to the project, with forward slashes",
  })
  .refine((path) => path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."), {
    error: "must not contain empty, '.' or '..' segments",
  });

/** Where a skill comes from, in words a person recognises. */
export const skillSourceSchema = z.enum(["personal", "project", "package"]);
export type SkillSource = z.infer<typeof skillSourceSchema>;

export const composerReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("skill"),
    skillId: idSchema,
    source: skillSourceSchema,
    /** A digest of the skill's content when it was chosen, so an edited skill is reported rather than run. */
    revision: z.string().min(8).max(128),
    label: labelSchema,
  }),
  z.strictObject({ kind: z.literal("project"), projectId: idSchema, label: labelSchema }),
  z.strictObject({ kind: z.literal("file"), projectId: idSchema, path: projectRelativePathSchema, label: labelSchema }),
  z.strictObject({ kind: z.literal("folder"), projectId: idSchema, path: projectRelativePathSchema, label: labelSchema }),
  /** A service a package runs, which Clark reaches over MCP. Named by the key the service host lists it under. */
  z.strictObject({ kind: z.literal("mcp-server"), serviceKey: idSchema, label: labelSchema }),
  z.strictObject({ kind: z.literal("conversation"), conversationId: idSchema, label: labelSchema }),
  z.strictObject({ kind: z.literal("background-work"), workId: idSchema, label: labelSchema }),
  z.strictObject({ kind: z.literal("notice"), noticeId: idSchema, label: labelSchema }),
]);
export type ComposerReference = z.infer<typeof composerReferenceSchema>;
export type ComposerReferenceKind = ComposerReference["kind"];

/** How a message carries its references: versioned, so a later shape is refused by an older node rather than misread. */
export const composerReferencesSchema = z.strictObject({
  version: z.literal(COMPOSER_REFERENCES_VERSION),
  items: z.array(composerReferenceSchema).max(COMPOSER_REFERENCES_MAX),
});
export type ComposerReferences = z.infer<typeof composerReferencesSchema>;

/** The two characters that open the picker. */
export const composerTriggerSchema = z.enum(["/", "@"]);
export type ComposerTrigger = z.infer<typeof composerTriggerSchema>;

/**
 * One row the picker shows.
 *
 * The row carries the reference it would insert rather than a callback: choosing it changes the draft and nothing
 * else. `disabledReason` is a sentence, because a row that cannot be chosen has to say why.
 */
export const composerReferenceSuggestionSchema = z.strictObject({
  key: z.string().min(1).max(300),
  trigger: composerTriggerSchema,
  kind: z.enum(["skill", "project", "file", "folder", "mcp-server", "conversation", "background-work", "notice"]),
  label: labelSchema,
  note: z.string().max(200).optional(),
  disabledReason: z.string().max(200).optional(),
  ref: composerReferenceSchema,
});

/**
 * A slash command the node answers itself (`slash-commands.ts`).
 *
 * Choosing it writes `/<command> ` into the draft and nothing else: it is not a reference the message carries, it is
 * what the message says, and the node reads it from the text when it is sent.
 */
export const composerCommandSuggestionSchema = z.strictObject({
  key: z.string().min(1).max(300),
  trigger: z.literal("/"),
  kind: z.literal("command"),
  label: labelSchema,
  note: z.string().max(200).optional(),
  command: slashCommandSchema,
});

export const composerSuggestionSchema = z.union([composerReferenceSuggestionSchema, composerCommandSuggestionSchema]);
export type ComposerSuggestion = z.infer<typeof composerSuggestionSchema>;
export type ComposerReferenceSuggestion = z.infer<typeof composerReferenceSuggestionSchema>;

/** `GET /composer/suggestions`. */
export const composerSuggestionsResponseSchema = z.strictObject({
  trigger: composerTriggerSchema,
  query: z.string().max(200),
  suggestions: z.array(composerSuggestionSchema).max(20),
});
export type ComposerSuggestionsResponse = z.infer<typeof composerSuggestionsResponseSchema>;

/**
 * A reference as it is stored on the message that carried it.
 *
 * `note` is what the node found when it checked the reference at send time, in a short sentence: "12 KB", "đang chạy",
 * "đã xong". It is read back when the turn's prompt is built, so the conversation reopened later shows what was sent.
 */
export const referenceBlockSchema = z.strictObject({
  type: z.literal("reference"),
  reference: composerReferenceSchema,
  note: z.string().max(300).optional(),
});
export type ReferenceBlock = z.infer<typeof referenceBlockSchema>;

/** The token a reference is shown as in the draft: the trigger it was chosen with, then its label. */
export function referenceToken(reference: ComposerReference): string {
  return `${reference.kind === "skill" ? "/" : "@"}${reference.label}`;
}

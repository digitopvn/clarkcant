import { z } from "zod";

import { THINKING_LEVELS } from "./preferences.ts";
import { instantSchema } from "./primitives.ts";

/**
 * The commands a person can type after `/` in the composer.
 *
 * Each one is answered by the host, in the conversation, as an agent message carrying a widget: nothing about the
 * application is hidden behind a screen of its own, and nothing needs one. `/sessions` lists the work running in the
 * background and the conversations before this one, `/login` and `/logout` sign in to and out of AI providers,
 * `/thinking` sets how hard the next turn thinks, `/background` runs a request beside the conversation, `/new`
 * starts a conversation of its own while keeping this one, `/changelog` shows what this version of Clark changed
 * (`/changelog 1.4`: what changed after 1.4), `/report` files a bug report or a feature request on ClarkCant itself
 * (`/report bug …`, `/report feature …`; alone, it brings up the Feedback Composer), and `/develop` lets the person
 * choose a folder to develop a widget from live in the conversation (`/develop <folder>`: that folder; `/develop forget`:
 * the folders Clark may develop in because the person chose them, to take one back).
 * `/model` brings up the model picker: every provider and model this node can run, which one is in use, which providers
 * are signed in, and a choice that changes nothing until the person confirms it (`/model <words>`: the picker, searching
 * for those words).
 *
 * The node is the one place that decides what a command means; the composer offers the same list after `/`, so a
 * command is something a person can find rather than something they have to know.
 */
export const SLASH_COMMANDS = ["new", "sessions", "login", "logout", "thinking", "background", "changelog", "report", "develop", "model"] as const;
export const slashCommandSchema = z.enum(SLASH_COMMANDS);
export type SlashCommand = z.infer<typeof slashCommandSchema>;

/** A command as typed: its name, and whatever followed it, trimmed. */
export interface TypedSlashCommand {
  command: SlashCommand;
  argument: string;
}

/**
 * The command a message is, if it is one.
 *
 * Only a message that starts with one of the names above, followed by the end or by whitespace: `/newsletter ideas` is
 * a sentence, and `/sessions` in the middle of one is a sentence too. Case is ignored in the name, never in what follows.
 */
export function parseSlashCommand(text: string): TypedSlashCommand | undefined {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (match === null) return undefined;
  const name = (match[1] ?? "").toLowerCase();
  const parsed = slashCommandSchema.safeParse(name);
  return parsed.success ? { command: parsed.data, argument: (match[2] ?? "").trim() } : undefined;
}

const idSchema = z.string().min(1).max(160);

/**
 * What a button on a command card does, as a closed set.
 *
 * A card names an action and never a route or a callback: the page carries it out through the same capability its own
 * control uses — the preference Settings writes, the conversation the inbox opens, the sign-in the provider runs — so a
 * click on a card and a click in Settings cannot drift apart.
 */
export const commandCardActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("open-conversation"), conversationId: idSchema }),
  z.strictObject({ kind: z.literal("new-conversation") }),
  /** `null` goes back to the model's own default. */
  z.strictObject({ kind: z.literal("set-thinking"), level: z.enum(THINKING_LEVELS).nullable() }),
  /** Starts the provider's own sign-in, in the card: a browser page, a code to type, or a key to paste. */
  z.strictObject({ kind: z.literal("provider-sign-in"), providerId: idSchema, method: z.enum(["oauth", "api_key"]) }),
  z.strictObject({ kind: z.literal("provider-sign-out"), providerId: idSchema }),
  /**
   * Starts a live widget dev session for a folder, as the person, through the person-only `POST /widget-dev/sessions`.
   * `root` is the folder the card names: the one Clark suggested, the command's argument, or a stopped session's folder.
   * Without it the page asks the person for one: the OS folder dialog on the desktop when the node runs on the same
   * machine, and a typed path otherwise. A card never starts a session by itself; only the person's press does, and
   * the folder they start is one Clark may then develop in as well.
   */
  z.strictObject({ kind: z.literal("develop-folder"), root: z.string().min(1).max(1000).optional() }),
  /**
   * Takes back the person's choice of a folder, through the person-only `POST /widget-dev/chosen-folders/forget`: Clark
   * may no longer start sessions in it, or in the folders inside it, unless another folder Clark may use holds it (the
   * answer names that one). Sessions and what they run are left as they are.
   */
  z.strictObject({ kind: z.literal("develop-folder-forget"), root: z.string().min(1).max(1000) }),
]);
export type CommandCardAction = z.infer<typeof commandCardActionSchema>;

/**
 * The widget a slash command answers with.
 *
 * Host-owned: the node builds it from what it holds — the work it runs, the conversations it stores, the providers pi
 * can sign in to — and never accepts one from a model, a widget or a pack. A row is a thing, with what is true of it
 * now and at most a few things that can be done to it; `current` marks the one in use, so a list of choices says which
 * is chosen without the person having to remember.
 *
 * Messages are never rewritten, so a card is what was true when the command ran. What a press then did is the page's to
 * say, beside the button, and is not written back into the card.
 */
export const commandCardSchema = z.strictObject({
  type: z.literal("command-card"),
  owner: z.literal("host"),
  cardId: z.string().min(1).max(128),
  command: slashCommandSchema,
  title: z.string().min(1).max(300),
  detail: z.string().min(1).max(2000).optional(),
  rows: z
    .array(
      z.strictObject({
        rowId: z.string().min(1).max(160),
        label: z.string().min(1).max(300),
        note: z.string().min(1).max(500).optional(),
        badge: z
          .strictObject({
            text: z.string().min(1).max(60),
            tone: z.enum(["neutral", "active", "success", "warning", "danger"]),
          })
          .optional(),
        current: z.boolean().optional(),
        actions: z
          .array(
            z.strictObject({
              actionId: z.string().min(1).max(64),
              label: z.string().min(1).max(60),
              tone: z.enum(["primary", "neutral", "danger"]).optional(),
              action: commandCardActionSchema,
            }),
          )
          .max(4),
      }),
    )
    .max(60),
  /** Said instead of rows when there is nothing to list, so an empty card still answers the command. */
  empty: z.string().min(1).max(500).optional(),
  /**
   * A host-owned control the page draws below the rows from what the node holds when it is drawn, rather than from a
   * list frozen into the message. `model` is the model picker: the node's catalogue, the model in use, which providers
   * are signed in, and a choice applied through `POST /model` only once the person confirms it. `query` is what the
   * picker searches for first (`/model <words>`). A record of the card, without the page's handlers, draws no picker.
   */
  picker: z.strictObject({ kind: z.literal("model"), query: z.string().min(1).max(200).optional() }).optional(),
  updatedAt: instantSchema,
});
export type CommandCard = z.infer<typeof commandCardSchema>;

/** A provider pi can sign in to, as `GET /providers/auth` lists it. Never the credential, only whether there is one. */
export const providerAuthEntrySchema = z.strictObject({
  providerId: idSchema,
  name: z.string().min(1).max(200),
  oauth: z.strictObject({ label: z.string().min(1).max(200), subscription: z.boolean() }).optional(),
  apiKey: z.boolean(),
  configured: z.boolean(),
  source: z.enum(["stored", "runtime", "environment", "models_json", "fallback"]).optional(),
});
export type ProviderAuthEntryView = z.infer<typeof providerAuthEntrySchema>;

export const providerSignInMethodSchema = z.enum(["oauth", "api_key"]);

/**
 * A sign-in in progress, as the card that started it follows it.
 *
 * `prompt` is what the provider is asking now; the answer goes back through `POST /providers/sign-ins/:id/answer` and
 * is never part of this view, so a secret typed into the card is not something any later read can return.
 */
export const providerSignInViewSchema = z.strictObject({
  signInId: idSchema,
  providerId: idSchema,
  method: providerSignInMethodSchema,
  state: z.enum(["running", "waiting", "done", "failed", "cancelled"]),
  events: z
    .array(
      z.union([
        z.strictObject({ type: z.enum(["info", "progress"]), message: z.string().max(2000) }),
        z.strictObject({ type: z.literal("auth_url"), url: z.url(), instructions: z.string().max(2000).optional() }),
        z.strictObject({ type: z.literal("device_code"), userCode: z.string().max(200), verificationUri: z.url() }),
      ]),
    )
    .max(10),
  prompt: z
    .union([
      z.strictObject({
        type: z.enum(["text", "secret", "manual_code"]),
        message: z.string().max(2000),
        placeholder: z.string().max(200).optional(),
      }),
      z.strictObject({
        type: z.literal("select"),
        message: z.string().max(2000),
        options: z
          .array(z.strictObject({ id: z.string().max(200), label: z.string().max(200), description: z.string().max(500).optional() }))
          .max(30),
      }),
    ])
    .optional(),
  error: z.string().max(1000).optional(),
});
export type ProviderSignInView = z.infer<typeof providerSignInViewSchema>;
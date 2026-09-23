/**
 * App-intent and gateway chrome strings.
 *
 * Split out of `messages.ts` because several agents translate the catalog in parallel and each
 * needs a file of its own to edit without colliding; `messages.ts` spreads this in. Everything
 * here is a notice the app-intent executor or the gateway client shows the user, never text the
 * agent itself produced.
 */

export const MESSAGES_INTENTS_VI = {
  "intents.modelSwitchFailed": "Không chuyển được model.",
  "intents.commandLookupFailed": "Không hỏi được node về lệnh đó.",
} as const;

export type MessageIntentsKey = keyof typeof MESSAGES_INTENTS_VI;

export const MESSAGES_INTENTS_EN = {
  "intents.modelSwitchFailed": "Could not switch the model.",
  "intents.commandLookupFailed": "Could not ask the node about that command.",
} as const satisfies Record<MessageIntentsKey, string>;

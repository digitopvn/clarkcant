/**
 * The application-intent registry, node side.
 *
 * ## One place that decides, three places that ask
 *
 * A typed command, a click and a spoken sentence all arrive here and leave with the same decision
 * shape. That is the whole architecture of this file: there is no voice-specific executor and no
 * click-specific one, so "open Settings by voice" cannot drift away from "open Settings by
 * clicking" - there is only one answer to give.
 *
 * ## Why quitting needs a token instead of a confirmation flag
 *
 * The dangerous intent is the one that ends the application, and the danger is not that the person
 * did not mean it; it is that a microphone can hear something that sounds like it. So the node never
 * returns an executable quit from a single request. It returns a token, the token is bound to the
 * principal that asked, it expires in two minutes, and only the confirm route turns it into
 * permission. Nothing in the voice path can skip that, because the voice path only ever receives
 * `needs-confirmation`.
 *
 * ## Why a spent token is remembered instead of deleted
 *
 * The plan said to delete the row on success. That makes a replay indistinguishable from a token
 * that never existed, and the two need different answers: a replay is someone trying the same
 * permission twice and deserves `CONFIRMATION_ALREADY_USED`, while an unknown token is a bad request.
 * So success marks the row spent and the row is left in place; the token still cannot be used again,
 * which is the property that matters.
 */

import { randomUUID } from "node:crypto";

import {
  APP_INTENT_NOT_UNDERSTOOD,
  type AppIntent,
  type AppIntentConfirmationFailure,
  type AppIntentDecision,
  type AppIntentRequest,
  type AppIntentResolution,
  type AppIntentSource,
  type ConfirmationToken,
  type ConversationId,
  type Instant,
  type SettingsTab,
  appIntentSchema,
  describeAppIntent,
} from "@clarkcant/contracts";
import { deletePreference, getPreference, recordAppIntentEvent, resolveAppIntent, setPreference } from "@clarkcant/core";
import { type Database } from "@clarkcant/storage";

export interface AppIntentDeps {
  db: Database;
  nodeId: string;
  now: () => Instant;
  newId: (prefix: string) => string;
}

const PENDING_PREFIX = "app.intent.pending.";

/**
 * Two minutes.
 *
 * Long enough to answer a question that was just asked, short enough that an unanswered token is not
 * a standing permission to quit the application.
 */
const TOKEN_TTL_MS = 120_000;

/** What a pending token holds. `usedAt` is what makes a replay distinguishable from a forgery. */
interface PendingValue {
  kind: string;
  tab?: SettingsTab;
  source?: AppIntentSource;
  at: Instant;
  usedAt?: Instant;
}

function preferenceDeps(deps: AppIntentDeps) {
  return { db: deps.db, now: deps.now };
}

function pendingKey(token: string): string {
  return `${PENDING_PREFIX}${token}`;
}

/**
 * Mint a token for an intent that needs confirming.
 *
 * Scoped to the node rather than to a conversation: the thing being confirmed is a property of the
 * application, and it should not stop working because the window navigated somewhere else.
 */
export function mintConfirmation(
  deps: AppIntentDeps,
  input: { principalId: string; intent: AppIntent; source: AppIntentSource },
): ConfirmationToken {
  const token = randomUUID();
  const value: PendingValue = {
    kind: input.intent.kind,
    ...(input.intent.tab === undefined ? {} : { tab: input.intent.tab }),
    source: input.source,
    at: deps.now(),
  };
  setPreference(preferenceDeps(deps), {
    principalId: input.principalId,
    key: pendingKey(token),
    scope: "node",
    value,
    source: "user",
  });
  return token;
}

export type ConsumeOutcome =
  | { ok: true; intent: AppIntent; source: AppIntentSource }
  | { ok: false; code: AppIntentConfirmationFailure };

/**
 * Turn a token into permission, once.
 *
 * Everything happens in one synchronous pass with no `await` in it, which is what makes the read-then-write
 * safe without an enclosing transaction: this node backs storage with a synchronous engine in a single process,
 * so nothing else can write between the read and the write. Wrapping it in `transaction()` is not possible
 * anyway - `setPreference` opens its own, and the engine refuses a nested one rather than risking a silent
 * commit of the outer scope.
 *
 * A token minted for another principal is not found at all - it is not reported as belonging to someone else,
 * since that would confirm the token exists.
 */
export function consumeConfirmation(
  deps: AppIntentDeps,
  input: { principalId: string; token: string },
): ConsumeOutcome {
  const key = pendingKey(input.token);
  const where = { principalId: input.principalId, key, scope: "node" as const };
  const record = getPreference(preferenceDeps(deps), where);
  if (record === undefined) return { ok: false, code: "CONFIRMATION_NOT_FOUND" };

  const value = record.value as PendingValue;
  if (value.usedAt !== undefined) return { ok: false, code: "CONFIRMATION_ALREADY_USED" };

  const ageMs = Date.parse(deps.now()) - Date.parse(value.at);
  if (!(ageMs >= 0) || ageMs > TOKEN_TTL_MS) {
    deletePreference(preferenceDeps(deps), where);
    return { ok: false, code: "CONFIRMATION_EXPIRED" };
  }

  const parsed = appIntentSchema.safeParse(
    value.tab === undefined ? { kind: value.kind } : { kind: value.kind, tab: value.tab },
  );
  if (!parsed.success) {
    // A row that is not a shapeable intent is not permission; refusing it is the only safe reading.
    deletePreference(preferenceDeps(deps), where);
    return { ok: false, code: "CONFIRMATION_NOT_FOUND" };
  }

  setPreference(preferenceDeps(deps), { ...where, value: { ...value, usedAt: deps.now() }, source: "user" });
  return { ok: true, intent: parsed.data, source: value.source ?? "click" };
}

export interface DecideInput {
  principalId: string;
  request: AppIntentRequest;
  conversationId?: ConversationId;
}

/**
 * Decide what a request means, and record it when it means something.
 *
 * A refusal and a `none` are not audited: nothing was done, so there is nothing to have a record of,
 * and a log of sentences the application declined would be a log of what people said.
 */
export function decideAppIntent(
  deps: AppIntentDeps,
  input: DecideInput,
  mint: (intent: AppIntent) => ConfirmationToken,
): AppIntentResolution {
  const resolution = resolveAppIntent({
    ...(input.request.text === undefined ? {} : { text: input.request.text }),
    ...(input.request.kind === undefined
      ? {}
      : {
          intent: appIntentSchema.parse(
            input.request.tab === undefined
              ? { kind: input.request.kind }
              : { kind: input.request.kind, tab: input.request.tab },
          ),
        }),
    mintConfirmationToken: () => randomUUID() as ConfirmationToken,
  });

  if (resolution.kind === "none" || resolution.kind === "refused") {
    return resolution.kind === "refused" ? resolution : { kind: "none" };
  }

  const intent = resolution.intent;
  if (resolution.kind === "needs-confirmation") {
    // The minted token is replaced here by one that is actually stored: the decision function is pure
    // and cannot write, so the write happens in this layer.
    const token = mint(intent);
    return { ...resolution, confirmationToken: token };
  }
  recordAppIntentEvent(deps, {
    intent,
    source: input.request.source,
    confirmed: false,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
  });
  return resolution;
}

/** The sentence for the one refusal that comes from a request naming no tab. */
export const TAB_MISSING_SAY = APP_INTENT_NOT_UNDERSTOOD;

export type { AppIntentSource };

/** Re-exported so a caller testing a decision does not have to reach for the contract module. */
export { describeAppIntent, type AppIntentDecision };

import { type MessageRecord, isHostWrittenMessage } from "@clarkcant/contracts";
import { conversationMetadata, latestMessages, type Database } from "@clarkcant/storage";

import { contextBundlesFor, contextSourceOf, reportContextBundle } from "../context-bundle.ts";
import {
  CONTEXT_LIMITS,
  type ContextPlan,
  contextDeciderFromEnv,
  contextPlannerFromEnv,
  earlierMessagesFor,
  focusedMemoryBrief,
  planRecap,
  recapWindow,
} from "../context-planner.ts";
import { type DecideDeps, decideSessionRebuild } from "../jev-decider.ts";
import { memoryBrief } from "../memory.ts";
import type { createModelTurn } from "../model-turn.ts";
import { sessionPolicyFromEnv } from "../session-policy.ts";
import { textOfMessage } from "../session-search.ts";
import { planToolDisclosure, toolDisclosureFromEnv } from "../tool-disclosure.ts";

/**
 * What a turn is told from what the node keeps, wired the way the node runs it (#433): the recap for a fresh session,
 * the memory brief, retrieval for background runs, and progressive tool disclosure.
 *
 * A function of its own, not inline in the bootstrap, so a test can drive exactly what the node drives against a real
 * database — the recap's window, what it excludes from the search, and the off switch — without a whole node.
 *
 * Three principals are read here and must stay the same principal on a single-owner node: the owner for memory (memory
 * is written under the owner), the session search's principal for earlier messages (history is indexed under it), and
 * the request's principal for a background bundle (the person who asked). A multi-principal node must reconcile them
 * before relying on any of this.
 */

type ModelTurnOptions = Parameters<typeof createModelTurn>[0];

export type ContextWiring = Pick<
  ModelTurnOptions,
  "history" | "recapPlanner" | "memoryBrief" | "backgroundContext" | "toolDisclosure" | "onToolDisclosureFailed" | "sessionPolicy"
>;

export interface ContextWiringDeps {
  env: Record<string, string | undefined>;
  db: () => Database;
  /** Whose memory a turn reads. */
  ownerPrincipalId: () => string;
  /** Whose history index earlier messages are searched in; undefined before the search surface exists. */
  historyPrincipalId: () => string | undefined;
  /** The Jev selector, when this node has one; only asked when `CLARKCANT_CONTEXT_DECIDER=jev`. */
  decider: () => DecideDeps | undefined;
  newId: (prefix: string) => string;
}

/** How many messages the recap reads, newest last. */
export const RECAP_READ = 40;

/**
 * One line on stderr when the context planner focused a turn: counts only, never the text it chose or its ids.
 *
 * A focused plan is the planner claiming relevance, and that claim is what an operator measuring it needs to see; an
 * unfocused one is the old behaviour and says nothing new.
 */
function reportContextPlan(input: { conversationId: string; part: "recap" | "memory"; plan: ContextPlan }): void {
  if (!input.plan.focused && input.plan.withheld === 0) return;
  const count = (visibility: string): number => input.plan.entries.filter((entry) => entry.visibility === visibility).length;
  process.stderr.write(
    `${JSON.stringify({
      event: "context-plan",
      conversationId: input.conversationId,
      part: input.part,
      full: count("full"),
      short: count("short"),
      hidden: count("hide"),
      omitted: input.plan.omitted,
      withheld: input.plan.withheld,
      reranked: input.plan.reranked,
    })}\n`,
  );
}

export function contextWiring(deps: ContextWiringDeps): ContextWiring {
  const planner = contextPlannerFromEnv(deps.env);
  // The selector may only reorder a close top-K, and only when an operator opted in; otherwise nothing is asked.
  // Opting in sends the redacted, clipped text of the candidates (memory and earlier messages) to the Jev provider.
  const contextDecider = (): { decider?: DecideDeps } => {
    if (contextDeciderFromEnv(deps.env) !== "jev") return {};
    const decider = deps.decider();
    return decider === undefined ? {} : { decider };
  };

  return {
    // The conversation so far, for a session that has just been created.
    //
    // A session is dropped when a turn fails, because a session that failed a turn is the thing that is broken;
    // the thread is not, so the next message is answered by an agent that has been told what it is joining
    // rather than by one that has never heard of it.
    //
    // The newest forty, not the first forty, whether or not the planner is on: the recap is about where the
    // conversation is, and reading from the start recapped the opening of any thread longer than forty messages.
    //
    // A sentence the host wrote so a turn could run is left out: the recap labels its lines as the person's or the
    // agent's, and that one is neither. The reply that followed it carries what happened.
    history: async (conversationId) =>
      latestMessages(deps.db(), conversationId, RECAP_READ)
        .filter((record) => !isHostWrittenMessage(record))
        .filter((record): record is MessageRecord & { role: "user" | "assistant" } => record.role === "user" || record.role === "assistant")
        .map((record) => ({ role: record.role, text: textOfMessage(record), messageId: record.messageId })),

    // Focuses that recap on the message being answered. Off restores the fixed newest-twelve recap.
    ...(planner === "off"
      ? {}
      : {
          recapPlanner: async ({ conversationId, query, messages, allowed }) => {
            const db = deps.db();
            const principalId = deps.historyPrincipalId();
            // Only what the recap repeats; an older message that was read but not repeated must stay findable.
            const exclude = new Set(
              recapWindow(messages).flatMap((message) => (message.messageId === undefined ? [] : [message.messageId])),
            );
            const { earlier, withheld } =
              principalId === undefined
                ? { earlier: [], withheld: 0 }
                : await earlierMessagesFor(
                    { db, ...contextDecider() },
                    { principalId, conversationId, query, exclude, shown: CONTEXT_LIMITS.earlierShown, allowed },
                  );
            const total = conversationMetadata(db, conversationId).messageCount;
            const planned = planRecap({ messages, query, earlier, total, allowed, earlierWithheld: withheld });
            reportContextPlan({ conversationId, part: "recap", plan: planned.plan });
            return { text: planned.text, earlier: planned.earlier };
          },
        }),

    /*
     * What was remembered, for the turn about to run.
     *
     * Read per turn rather than captured once, so a record somebody deletes in the Memory tab stops being sent on the
     * very next turn. Focused on the turn's text unless the planner is off: what matches comes first, the rest follows
     * newest first, and with no match the brief is exactly the unfocused one.
     */
    memoryBrief: async (conversationId, query, allowed) => {
      const db = deps.db();
      const principalId = deps.ownerPrincipalId();
      if (planner === "off") {
        return memoryBrief({ db, now: () => new Date().toISOString(), newId: deps.newId }, { principalId, conversationId });
      }
      // Withheld by data class before the selector or the provider sees a note (#433); off keeps the old brief exactly.
      const planned = await focusedMemoryBrief({ db, ...contextDecider() }, { principalId, conversationId, query, allowed });
      reportContextPlan({ conversationId, part: "memory", plan: planned.plan });
      return planned.text;
    },

    /*
     * Shared retrieval for background requests: one pass per request and conversation revision, read on demand
     * through the principal-scoped readers so a note deleted meanwhile is not sent. Off with the planner.
     */
    ...(planner === "off"
      ? {}
      : {
          backgroundContext: async ({ conversationId, principalId, text }) => {
            const bundles = contextBundlesFor(deps.db());
            const bundle = await bundles.bundleFor({ principalId, conversationId, query: text });
            reportContextBundle({ conversationId, purpose: "background", bundle, stats: bundles.stats() });
            // A source rather than a reader: which items the run may read depends on the model it is routed to.
            return contextSourceOf(bundles, bundle, principalId);
          },
        }),

    /*
     * Progressive tool disclosure, only when an operator asked for it. The set grows within a session and never leaves
     * what the session was created with; one stderr line per change says what was offered and why.
     */
    ...(toolDisclosureFromEnv(deps.env) === "all"
      ? {}
      : {
          toolDisclosure: async (input) => {
            const plan = await planToolDisclosure({ mode: "progressive", ...input, ...contextDecider() });
            if (plan.active !== undefined) {
              process.stderr.write(
                `${JSON.stringify({
                  event: "tool-disclosure",
                  conversationId: input.conversationId,
                  reason: plan.reason,
                  families: plan.families,
                  active: plan.active.length,
                  registered: input.registered.length,
                })}\n`,
              );
            }
            return { active: plan.active };
          },
          onToolDisclosureFailed: ({ conversationId, reason }) => {
            process.stderr.write(`${JSON.stringify({ event: "tool-disclosure", conversationId, reason })}\n`);
          },
        }),

    /*
     * Whether a conversation's next turn reuses its session or starts a fresh one, only when an operator asked: `observe`
     * reports what it would decide, `rebuild` acts on it. The selector is asked only in the unclear band, and only with
     * the same opt-in as every other context decision; it is shown counts, never the conversation.
     */
    ...(() => {
      const mode = sessionPolicyFromEnv(deps.env);
      if (mode === "off") return {};
      return {
        sessionPolicy: {
          mode,
          ask: async (telemetry) => {
            const { decider } = contextDecider();
            if (decider === undefined) return undefined;
            return await decideSessionRebuild(decider, {
              idleSeconds: telemetry.idleMs / 1000,
              contextTokens: telemetry.contextTokens ?? 0,
              topicShift: telemetry.topicShift,
              turns: telemetry.turns,
            });
          },
        },
      };
    })(),
  };
}

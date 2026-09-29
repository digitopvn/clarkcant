import { z } from "zod";

import { effectCategorySchema, instantSchema } from "./primitives.ts";
import { taskResourceSchema } from "./tasks.ts";

/**
 * Signals and the standing requests that answer them.
 *
 * A person says "when X happens, do Y". What they said is kept as a persistent intent: plain data a deterministic
 * matcher reads, never a prompt a model re-interprets each time. Something happening anywhere — a label on an issue,
 * a timer coming due, a peer's news — arrives as a Signal, one shape whatever its source, and the matcher decides
 * which intents it answers. Provider payloads stay the provider adapter's business; the core only ever sees this.
 */

/** Where a signal came from, in the only terms the core needs. */
export const signalSourceKindSchema = z.enum(["external", "peer", "system", "timer", "local"]);
export type SignalSourceKind = z.infer<typeof signalSourceKindSchema>;

/** Dotted, lower-case words: `github.issue.labeled`, `timer.fired`. Never free text a matcher would have to parse. */
export const signalTopicSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/, "a topic is dotted lower-case words, such as timer.fired");

export const SIGNAL_PAYLOAD_MAX_BYTES = 64 * 1024;

export const signalInputSchema = z
  .object({
    source: z
      .object({
        kind: signalSourceKindSchema,
        provider: z.string().min(1).max(80).optional(),
        /** Which source instance: a repository, a peer, a timer. Dedupe is per source. */
        sourceId: z.string().min(1).max(200),
      })
      .strict(),
    topic: signalTopicSchema,
    subject: z
      .object({
        type: z.string().min(1).max(80).optional(),
        id: z.string().min(1).max(200).optional(),
        refs: z.record(z.string().min(1).max(80), z.string().max(500)).optional(),
      })
      .strict()
      .optional(),
    payload: z.record(z.string(), z.unknown()),
    occurredAt: instantSchema,
    /** The same fact delivered twice carries the same key, and is recorded once. */
    dedupeKey: z.string().min(1).max(300),
    /**
     * How the signal reached this node. `selfGenerated` marks a signal Clark's own work caused — a label Clark set, a
     * comment Clark wrote — which an intent ignores unless it was set up to react to its own effects.
     */
    provenance: z
      .object({
        selfGenerated: z.boolean().optional(),
        via: z.string().max(200).optional(),
      })
      .catchall(z.unknown())
      .default({}),
  })
  .strict();
export type SignalInput = z.input<typeof signalInputSchema>;

export const signalSchema = signalInputSchema.extend({
  signalId: z.string().min(1).max(100),
  receivedAt: instantSchema,
});
export type Signal = z.infer<typeof signalSchema>;

/**
 * One condition on a signal, by path.
 *
 * The path reads the signal itself — `payload.label`, `subject.refs.repository`, `source.provider` — with dots between
 * keys and a number for an array position. Four operators and nothing else, so what an intent matches is decided by
 * reading it, the same way every time.
 */
export const matchConditionSchema = z
  .discriminatedUnion("op", [
    z.object({ path: z.string().min(1).max(200), op: z.literal("equals"), value: z.unknown() }).strict(),
    z.object({ path: z.string().min(1).max(200), op: z.literal("in"), value: z.array(z.unknown()).min(1).max(50) }).strict(),
    z.object({ path: z.string().min(1).max(200), op: z.literal("contains"), value: z.unknown() }).strict(),
    z.object({ path: z.string().min(1).max(200), op: z.literal("exists") }).strict(),
  ]);
export type MatchCondition = z.infer<typeof matchConditionSchema>;

/** When a timer intent fires: every so many minutes from when it was set up, or once at a time. */
export const automationScheduleSchema = z.union([
  z.object({ everyMinutes: z.number().int().min(1).max(60 * 24 * 31) }).strict(),
  z.object({ at: instantSchema }).strict(),
]);
export type AutomationSchedule = z.infer<typeof automationScheduleSchema>;

export const persistentIntentStateSchema = z.enum(["active", "paused", "removed"]);
export type PersistentIntentState = z.infer<typeof persistentIntentStateSchema>;

/**
 * What to do when an intent matches.
 *
 * `task` runs ordinary Clark work with the intent's folders and effects; `remind` only says so in the conversation and
 * the inbox, which is what a person asking to be reminded wants and nothing more.
 */
export const intentActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("task"),
      goal: z.string().min(1).max(2000),
      resources: z.array(taskResourceSchema).min(1).max(8),
      /** The effects this automation was given. A risky one outside this list is asked about, in every mode. */
      allowedCategories: z.array(effectCategorySchema).max(8),
      /**
       * A paired node that runs the task instead of this one, under a grant this node's owner wrote for it. The folders
       * are that node's, and it runs the task only within what its own owner allows this node.
       */
      executor: z.string().min(1).max(128).optional(),
      /**
       * The grant this node's owner wrote for the executor when the automation was set up. Its runs go under that grant
       * and no other, and it is withdrawn when the automation is paused or removed. Absent on an automation set up before
       * grants were recorded, whose runs go under any live grant that covers them.
       */
      grantId: z.string().min(1).max(128).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("remind"), message: z.string().min(1).max(2000) }).strict(),
]);
export type IntentAction = z.infer<typeof intentActionSchema>;

export const persistentIntentSchema = z
  .object({
    intentId: z.string().min(1).max(100),
    principalId: z.string().min(1).max(200),
    /** Where the person set it up, which is where it reports. */
    conversationId: z.string().min(1).max(200),
    /** What the person would say it does, in their words. The only part of it they ever need to read. */
    summary: z.string().min(1).max(300),
    when: z.object({ topic: signalTopicSchema }).strict(),
    match: z.array(matchConditionSchema).max(16),
    do: intentActionSchema,
    schedule: automationScheduleSchema.optional(),
    state: persistentIntentStateSchema,
    /** Whether a signal Clark's own work caused may start this intent again. Off unless asked for. */
    allowSelfTriggered: z.boolean(),
    revision: z.number().int().min(0),
    nextFireAt: instantSchema.optional(),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();
export type PersistentIntent = z.infer<typeof persistentIntentSchema>;

export const intentRunStateSchema = z.enum(["pending", "started", "reminded", "failed"]);
export type IntentRunState = z.infer<typeof intentRunStateSchema>;

/** One intent answering one signal. There is never a second: (intent, signal) is unique. */
export const intentRunSchema = z
  .object({
    runId: z.string().min(1).max(100),
    intentId: z.string().min(1).max(100),
    signalId: z.string().min(1).max(100),
    /** The task this run creates, chosen when the run is recorded so a crash can never create a second one. */
    taskId: z.string().min(1).max(100),
    state: intentRunStateSchema,
    reason: z.string().max(1000).optional(),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();
export type IntentRun = z.infer<typeof intentRunSchema>;

import { z } from "zod";

import type { SemanticValue } from "./widget-semantic.ts";

/**
 * Cards that say where something stands: one status, the progress of one thing, a few labelled facts.
 *
 * Everything on these cards is what the model wrote when it placed them. None of them reads a task, a connection or a
 * dataset, so none of them can say it is live: the node's own task and connection cards are host-owned and built from
 * its records, and a model has no records to build one from. A card may say when its facts were true (`asOf`), and
 * then says it in words; it never shows a freshness badge.
 *
 * One description serves the node and the page. The node refuses props that fail `statusCardProblems` before an
 * instance exists; the page reads the same props with `readStatusCard` and draws only what passes, so a card the node
 * would refuse is never drawn as though it were fine.
 */

export const STATUS_TONES = ["neutral", "info", "success", "warning", "danger"] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

export const STEP_STATUSES = ["done", "current", "pending", "failed", "skipped"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const MAX_PROGRESS_STEPS = 12;
export const MAX_DETAIL_ITEMS = 24;

/**
 * A day, or an instant with its offset.
 *
 * A time without an offset is refused: "as of 09:00" means a different moment to every reader in another timezone, and
 * the card cannot know which one the model meant.
 */
export const AS_OF_PATTERN = "^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?(?:Z|[+-]\\d{2}:\\d{2}))?$";
const asOfSchema = z.string().max(40).regex(new RegExp(AS_OF_PATTERN, "u"));

const titleSchema = z.string().max(200);

export const statusCardSchema = z.strictObject({
  title: titleSchema.optional(),
  label: z.string().min(1).max(120),
  tone: z.enum(STATUS_TONES),
  detail: z.string().max(500).optional(),
  asOf: asOfSchema.optional(),
});
export type StatusCard = z.infer<typeof statusCardSchema>;

export const progressStepSchema = z.strictObject({
  label: z.string().min(1).max(120),
  status: z.enum(STEP_STATUSES),
  detail: z.string().max(200).optional(),
});
export type ProgressStep = z.infer<typeof progressStepSchema>;

export const progressCardSchema = z.strictObject({
  title: titleSchema.optional(),
  /** What is progressing, in the model's words. */
  label: z.string().max(200).optional(),
  value: z.number().nonnegative().optional(),
  max: z.number().positive().optional(),
  unit: z.string().max(20).optional(),
  steps: z.array(progressStepSchema).min(1).max(MAX_PROGRESS_STEPS).optional(),
  asOf: asOfSchema.optional(),
});
export type ProgressCard = z.infer<typeof progressCardSchema>;

export const detailItemSchema = z.strictObject({
  label: z.string().min(1).max(80),
  value: z.string().min(1).max(300),
});
export type DetailItem = z.infer<typeof detailItemSchema>;

export const detailsCardSchema = z.strictObject({
  title: titleSchema.optional(),
  items: z.array(detailItemSchema).min(1).max(MAX_DETAIL_ITEMS),
  asOf: asOfSchema.optional(),
});
export type DetailsCard = z.infer<typeof detailsCardSchema>;

export type StatusCardKind = "status" | "progress" | "details";

export type StatusCardContent =
  | { kind: "status"; card: StatusCard }
  | { kind: "progress"; card: ProgressCard }
  | { kind: "details"; card: DetailsCard };

/* ------------------------------------------------------------------ *
 * Reading and checking
 * ------------------------------------------------------------------ */

function parsed(kind: StatusCardKind, props: unknown): StatusCardContent | undefined {
  if (kind === "status") {
    const result = statusCardSchema.safeParse(props);
    return result.success ? { kind, card: result.data } : undefined;
  }
  if (kind === "progress") {
    const result = progressCardSchema.safeParse(props);
    return result.success ? { kind, card: result.data } : undefined;
  }
  const result = detailsCardSchema.safeParse(props);
  return result.success ? { kind, card: result.data } : undefined;
}

/** Whether an `asOf` names a day that exists: the pattern alone would let 2026-02-30 through. */
function asOfProblem(asOf: string | undefined): string | undefined {
  if (asOf === undefined) return undefined;
  const [year, month, day] = asOf.slice(0, 10).split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!real || Number.isNaN(Date.parse(asOf))) return `"asOf" is not a real date or time: ${asOf}`;
  return undefined;
}

function progressProblems(card: ProgressCard): string[] {
  const problems: string[] = [];
  const determinate = card.value !== undefined || card.max !== undefined;
  if (determinate && card.steps !== undefined) {
    problems.push("a progress card shows either a value of a maximum or a list of steps, not both");
  } else if (!determinate && card.steps === undefined) {
    problems.push("a progress card needs a value and a maximum, or steps; there is no progress without either");
  }
  if (determinate && (card.value === undefined || card.max === undefined)) {
    problems.push("a value and a maximum go together");
  }
  if (card.value !== undefined && card.max !== undefined && card.value > card.max) {
    problems.push(`the value ${String(card.value)} is above the maximum ${String(card.max)}`);
  }
  if (card.unit !== undefined && card.steps !== undefined) problems.push("a unit goes with a value, not with steps");
  const current = (card.steps ?? []).filter((step) => step.status === "current").length;
  if (current > 1) problems.push(`${String(current)} steps are current; at most one step is`);
  return problems;
}

function detailsProblems(card: DetailsCard): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const item of card.items) {
    if (seen.has(item.label)) repeated.add(item.label);
    seen.add(item.label);
  }
  return repeated.size === 0 ? [] : [`labels repeat: ${[...repeated].slice(0, 5).join(", ")}; each fact needs its own label`];
}

/** Everything wrong with a card's props: what the schema says, then what it cannot say. */
export function statusCardProblems(kind: StatusCardKind, props: unknown): string[] {
  const content = parsed(kind, props);
  if (content === undefined) return [`the props do not describe a ${kind} card`];
  const problems: string[] = [];
  const asOf = asOfProblem(content.card.asOf);
  if (asOf !== undefined) problems.push(asOf);
  if (content.kind === "progress") problems.push(...progressProblems(content.card));
  if (content.kind === "details") problems.push(...detailsProblems(content.card));
  return problems;
}

/** The card its props describe, or `undefined` when the node would refuse them. */
export function readStatusCard(kind: StatusCardKind, props: unknown): StatusCardContent | undefined {
  const content = parsed(kind, props);
  return content !== undefined && statusCardProblems(kind, props).length === 0 ? content : undefined;
}

/* ------------------------------------------------------------------ *
 * Progress arithmetic
 * ------------------------------------------------------------------ */

/** The whole percentage a determinate card shows, or `undefined` for steps. */
export function progressPercent(card: ProgressCard): number | undefined {
  if (card.value === undefined || card.max === undefined || card.max <= 0) return undefined;
  return Math.round((Math.min(card.value, card.max) / card.max) * 100);
}

/** How many steps are finished (done or skipped) of how many, and the one in progress. */
export function stepCounts(steps: readonly ProgressStep[]): { finished: number; total: number; failed: number; current?: ProgressStep } {
  const current = steps.find((step) => step.status === "current");
  return {
    finished: steps.filter((step) => step.status === "done" || step.status === "skipped").length,
    total: steps.length,
    failed: steps.filter((step) => step.status === "failed").length,
    ...(current === undefined ? {} : { current }),
  };
}

/* ------------------------------------------------------------------ *
 * What the card says, as text and as semantic state
 * ------------------------------------------------------------------ */

function withAsOf(text: string, asOf: string | undefined): string {
  return asOf === undefined ? text : `${text} (as of ${asOf})`;
}

/**
 * The card as one plain sentence: the text alternative a reader gets when it cannot be drawn.
 *
 * Built from the props, so a transcript that outlives the renderer still says what the card said.
 */
export function statusCardText(content: StatusCardContent): string {
  const title = content.card.title !== undefined && content.card.title !== "" ? `${content.card.title}: ` : "";
  if (content.kind === "status") {
    const { label, tone, detail, asOf } = content.card;
    return withAsOf(`${title}${label} (${tone})${detail === undefined || detail === "" ? "" : `. ${detail}`}`, asOf);
  }
  if (content.kind === "progress") {
    const card = content.card;
    const subject = card.label !== undefined && card.label !== "" ? `${card.label}: ` : "";
    if (card.steps === undefined) {
      const unit = card.unit === undefined || card.unit === "" ? "" : ` ${card.unit}`;
      return withAsOf(`${title}${subject}${String(card.value)} of ${String(card.max)}${unit} (${String(progressPercent(card))}%)`, card.asOf);
    }
    const steps = card.steps.map((step) => `${step.label} [${step.status}]`).join("; ");
    const counts = stepCounts(card.steps);
    return withAsOf(`${title}${subject}${String(counts.finished)} of ${String(counts.total)} steps finished. ${steps}`, card.asOf);
  }
  const items = content.card.items.map((item) => `${item.label}: ${item.value}`).join("; ");
  return withAsOf(`${title}${items}`, content.card.asOf);
}

/**
 * What the card means for voice and `inspect_ui`: a summary and a few values, all from its props.
 *
 * Bounded by `normalizeSemanticDoc` afterwards; the lists here are already short enough that clipping them loses the
 * tail of a long card rather than its point.
 */
export function statusCardSemantic(content: StatusCardContent): {
  title?: string;
  summary: string;
  values: Record<string, SemanticValue>;
} {
  const title = content.card.title !== undefined && content.card.title !== "" ? { title: content.card.title } : {};
  const asOf = content.card.asOf === undefined ? {} : { asOf: content.card.asOf };
  if (content.kind === "status") {
    const { label, tone, detail } = content.card;
    return {
      ...title,
      summary: `Status as stated when shown: ${label} (${tone})`,
      values: { label, tone, ...(detail === undefined || detail === "" ? {} : { detail }), ...asOf },
    };
  }
  if (content.kind === "progress") {
    const card = content.card;
    const subject = card.label !== undefined && card.label !== "" ? card.label : "Progress";
    if (card.steps === undefined) {
      const percent = progressPercent(card) ?? 0;
      const unit = card.unit === undefined || card.unit === "" ? "" : ` ${card.unit}`;
      return {
        ...title,
        summary: `${subject} as stated when shown: ${String(card.value)} of ${String(card.max)}${unit} (${String(percent)}%)`,
        values: {
          value: card.value ?? 0,
          max: card.max ?? 0,
          percent,
          ...(card.unit === undefined || card.unit === "" ? {} : { unit: card.unit }),
          ...asOf,
        },
      };
    }
    const counts = stepCounts(card.steps);
    const failed = card.steps.filter((step) => step.status === "failed").map((step) => step.label);
    return {
      ...title,
      summary:
        `${subject} as stated when shown: ${String(counts.finished)} of ${String(counts.total)} steps finished` +
        (counts.current === undefined ? "" : `; current: ${counts.current.label}`) +
        (failed.length === 0 ? "" : `; failed: ${failed.join(", ")}`),
      values: {
        stepsFinished: counts.finished,
        stepsTotal: counts.total,
        steps: card.steps.map((step) => `${step.label}: ${step.status}`),
        ...(counts.current === undefined ? {} : { currentStep: counts.current.label }),
        ...(failed.length === 0 ? {} : { failedSteps: failed }),
        ...asOf,
      },
    };
  }
  const items = content.card.items;
  return {
    ...title,
    summary: `${String(items.length)} fact(s) as stated when shown`,
    values: { count: items.length, items: items.map((item) => `${item.label}: ${item.value}`), ...asOf },
  };
}

import { z } from "zod";

import { clipWithMarker, hiddenCharacterProblem, sliceCodePoints } from "./text-rules.ts";
import { SNAPSHOT_TEXT_LIMIT } from "./widgets.ts";
import { SEMANTIC_LIMITS, type SemanticValue } from "./widget-semantic.ts";

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

/**
 * One line of the model's words, as a card shows it.
 *
 * Refused when it holds a line break, a control, a bidi control or an invisible character, with a reason that names
 * it; otherwise read in NFC and trimmed, so a label of spaces is empty and two labels that look the same are the same.
 * The length is the model's own, before trimming, as its JSON Schema counts it.
 */
function oneLine(max: number, required: boolean) {
  return z
    .string()
    .max(max, `is longer than ${String(max)} characters`)
    .superRefine((value, ctx) => {
      const problem = hiddenCharacterProblem(value);
      if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
    })
    .transform((value) => value.normalize("NFC").trim())
    .refine((value) => !required || value !== "", "is empty");
}

const titleSchema = oneLine(200, false);

export const statusCardSchema = z.strictObject({
  title: titleSchema.optional(),
  label: oneLine(120, true),
  tone: z.enum(STATUS_TONES),
  detail: oneLine(500, false).optional(),
  asOf: asOfSchema.optional(),
});
export type StatusCard = z.infer<typeof statusCardSchema>;

export const progressStepSchema = z.strictObject({
  label: oneLine(120, true),
  status: z.enum(STEP_STATUSES),
  detail: oneLine(200, false).optional(),
});
export type ProgressStep = z.infer<typeof progressStepSchema>;

export const progressCardSchema = z.strictObject({
  title: titleSchema.optional(),
  /** What is progressing, in the model's words. */
  label: oneLine(200, false).optional(),
  value: z.number().nonnegative().optional(),
  max: z.number().positive().optional(),
  unit: oneLine(20, false).optional(),
  steps: z.array(progressStepSchema).min(1).max(MAX_PROGRESS_STEPS).optional(),
  asOf: asOfSchema.optional(),
});
export type ProgressCard = z.infer<typeof progressCardSchema>;

export const detailItemSchema = z.strictObject({
  label: oneLine(80, true),
  value: oneLine(300, true),
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

/** At most this many schema problems in one refusal, so one bad list cannot flood it. */
const MAX_SCHEMA_PROBLEMS = 5;

type Parsed = { ok: true; content: StatusCardContent } | { ok: false; problems: string[] };

function schemaProblems(error: z.ZodError): string[] {
  return error.issues.slice(0, MAX_SCHEMA_PROBLEMS).map((issue) => {
    const where = issue.path.length === 0 ? "props" : `"${issue.path.map(String).join(".")}"`;
    return `${where}: ${issue.message}`;
  });
}

function parsed(kind: StatusCardKind, props: unknown): Parsed {
  if (kind === "status") {
    const result = statusCardSchema.safeParse(props);
    return result.success ? { ok: true, content: { kind, card: result.data } } : { ok: false, problems: schemaProblems(result.error) };
  }
  if (kind === "progress") {
    const result = progressCardSchema.safeParse(props);
    return result.success ? { ok: true, content: { kind, card: result.data } } : { ok: false, problems: schemaProblems(result.error) };
  }
  const result = detailsCardSchema.safeParse(props);
  return result.success ? { ok: true, content: { kind, card: result.data } } : { ok: false, problems: schemaProblems(result.error) };
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

/**
 * Everything wrong with a card's props: what the schema says, then what it cannot say.
 *
 * Labels are compared as the card reads them, in NFC and trimmed, so "Owner" and "Owner " are the same label.
 */
export function statusCardProblems(kind: StatusCardKind, props: unknown): string[] {
  const result = parsed(kind, props);
  if (!result.ok) return result.problems;
  const content = result.content;
  const problems: string[] = [];
  const asOf = asOfProblem(content.card.asOf);
  if (asOf !== undefined) problems.push(asOf);
  if (content.kind === "progress") problems.push(...progressProblems(content.card));
  if (content.kind === "details") problems.push(...detailsProblems(content.card));
  return problems;
}

/** The card its props describe, or `undefined` when the node would refuse them. */
export function readStatusCard(kind: StatusCardKind, props: unknown): StatusCardContent | undefined {
  const result = parsed(kind, props);
  return result.ok && statusCardProblems(kind, props).length === 0 ? result.content : undefined;
}

/* ------------------------------------------------------------------ *
 * Progress arithmetic
 * ------------------------------------------------------------------ */

/**
 * The whole percentage a determinate card shows, or `undefined` for steps.
 *
 * Rounded, except that a card says 100% only when the value is the maximum: 999 of 1000 is 99%, never a finished bar
 * over work that is not finished. (Rounding down instead would show 57 of 100 as 56%, since 0.57 × 100 is not 57 in
 * floating point.)
 */
export function progressPercent(card: ProgressCard): number | undefined {
  if (card.value === undefined || card.max === undefined || card.max <= 0) return undefined;
  const percent = Math.round((Math.min(card.value, card.max) / card.max) * 100);
  return percent === 100 && card.value < card.max ? 99 : percent;
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
 * `head`, as many of `facts` as fit in `limit`, then `tail`, saying how many facts were left out.
 *
 * Facts are kept whole and in order: a reader gets the first ones in full and is told the rest exist, rather than a
 * sentence cut in the middle of a value.
 */
function fitFacts(head: string, facts: readonly string[], tail: string, noun: [string, string], limit: number): string {
  const whole = `${head}${facts.join("; ")}${tail}`;
  if (whole.length <= limit) return whole;
  for (let kept = facts.length - 1; kept >= 0; kept -= 1) {
    const left = facts.length - kept;
    const more = `and ${String(left)} more ${left === 1 ? noun[0] : noun[1]}`;
    const text = `${head}${facts.slice(0, kept).join("; ")}${kept === 0 ? "" : "; "}…${more}${tail}`;
    if (text.length <= limit) return text;
  }
  return clipWithMarker(`${head}…${tail}`, limit);
}

/**
 * The card as one plain sentence: the text alternative a reader gets when it cannot be drawn.
 *
 * Built from the props, so a transcript that outlives the renderer still says what the card said. Never longer than
 * `limit`: a long card keeps its first facts or steps whole and says how many more it had. The default is what a
 * snapshot keeps; a card placed as a section of a layout passes `SECTION_TEXT_LIMIT`. A snapshot holding more could not
 * be read back, and a conversation with one in it could not be opened.
 */
export function statusCardText(content: StatusCardContent, limit: number = SNAPSHOT_TEXT_LIMIT): string {
  const title = content.card.title !== undefined && content.card.title !== "" ? `${content.card.title}: ` : "";
  const asOf = content.card.asOf === undefined ? "" : withAsOf("", content.card.asOf);
  if (content.kind === "status") {
    const { label, tone, detail } = content.card;
    return clipWithMarker(`${title}${label} (${tone})${detail === undefined || detail === "" ? "" : `. ${detail}`}${asOf}`, limit);
  }
  if (content.kind === "progress") {
    const card = content.card;
    const subject = card.label !== undefined && card.label !== "" ? `${card.label}: ` : "";
    if (card.steps === undefined) {
      const unit = card.unit === undefined || card.unit === "" ? "" : ` ${card.unit}`;
      return clipWithMarker(`${title}${subject}${String(card.value)} of ${String(card.max)}${unit} (${String(progressPercent(card))}%)${asOf}`, limit);
    }
    const counts = stepCounts(card.steps);
    return fitFacts(
      `${title}${subject}${String(counts.finished)} of ${String(counts.total)} steps finished. `,
      card.steps.map((step) => `${step.label} [${step.status}]`),
      asOf,
      ["step", "steps"],
      limit,
    );
  }
  return fitFacts(title, content.card.items.map((item) => `${item.label}: ${item.value}`), asOf, ["fact", "facts"], limit);
}

/** How much of a list entry a label may take, so the value or status next to it survives the entry's own limit. */
const SEMANTIC_LABEL = 32;

function shortLabel(label: string): string {
  return label.length <= SEMANTIC_LABEL ? label : `${sliceCodePoints(label, SEMANTIC_LABEL - 1)}…`;
}

/**
 * What the card means for voice and `inspect_ui`: a summary and a few values, all from its props.
 *
 * Bounded by `normalizeSemanticDoc` afterwards, which keeps the first entries of a list and the start of each entry.
 * So a step's status comes before its label, a fact's label is shortened before its value, and a summary says when
 * only the first facts are listed.
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
        steps: card.steps.map((step) => `${step.status}: ${step.label}`),
        ...(counts.current === undefined ? {} : { currentStep: counts.current.label }),
        ...(failed.length === 0 ? {} : { failedSteps: failed }),
        ...asOf,
      },
    };
  }
  const items = content.card.items;
  const listed = Math.min(items.length, SEMANTIC_LIMITS.list);
  return {
    ...title,
    summary:
      `${String(items.length)} fact(s) as stated when shown` +
      (listed < items.length ? `; the first ${String(listed)} of ${String(items.length)} are listed` : ""),
    values: { count: items.length, items: items.map((item) => `${shortLabel(item.label)}: ${item.value}`), ...asOf },
  };
}
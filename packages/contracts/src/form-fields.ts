import { z } from "zod";

/**
 * The fields a person fills in: one choice or one input on its own, or several in a form.
 *
 * One description serves the page and the node. The page checks a value with `checkFieldValue` as the person types, and
 * the node checks the submitted values with the same function before a bound action runs, so the two can only disagree
 * when the page was bypassed — and then the node's answer is the one that counts. `formInputSchema` is the same rules
 * as JSON Schema, which is what an action binding records as the input it accepts.
 *
 * There is no field for a secret. A password, token or key typed into a widget would sit in the draft, in the action
 * record and in the model's context; credentials go through the host's own connection and vault flows instead, so a
 * field that asks for one is refused by name.
 */

export const CHOICE_KINDS = ["chips", "select", "multiselect", "radio", "checkbox", "toggle"] as const;
export const INPUT_KINDS = ["text", "number", "date", "date-range", "time", "slider"] as const;
export const FIELD_KINDS = [...CHOICE_KINDS, ...INPUT_KINDS] as const;
export type ChoiceKind = (typeof CHOICE_KINDS)[number];
export type InputKind = (typeof INPUT_KINDS)[number];
export type FieldKind = (typeof FIELD_KINDS)[number];

export const MAX_FORM_FIELDS = 20;
export const MAX_FIELD_OPTIONS = 50;
export const MAX_TEXT_LENGTH = 4000;

/** Kinds whose value is one of the options, or several of them. */
const SINGLE_CHOICE: ReadonlySet<FieldKind> = new Set(["select", "radio"]);
const MULTI_CHOICE: ReadonlySet<FieldKind> = new Set(["chips", "multiselect"]);
const BOOLEAN_KINDS: ReadonlySet<FieldKind> = new Set(["checkbox", "toggle"]);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Words a field asking for a secret is named with; matched on the name and the label, in English and Vietnamese. */
const SECRET_PATTERN =
  /pass(word|code|phrase)|secret|token|api[\s_-]?key|private[\s_-]?key|\bpin\b|\botp\b|\bcvv\b|\bcvc\b|\bssn\b|credential|mật\s*khẩu|mã\s*pin|khóa\s*bí\s*mật/iu;

const optionSchema = z.strictObject({
  value: z.string().min(1).max(120),
  label: z.string().min(1).max(120),
});
export type FieldOption = z.infer<typeof optionSchema>;

export const formFieldSchema = z.strictObject({
  /** The key the value is submitted under: an identifier, so it can be an argument name. */
  name: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/u, "a field name is a letter followed by letters, digits or _ (at most 40)"),
  label: z.string().min(1).max(120),
  kind: z.enum(FIELD_KINDS),
  required: z.boolean().optional(),
  help: z.string().max(300).optional(),
  placeholder: z.string().max(120).optional(),
  options: z.array(optionSchema).max(MAX_FIELD_OPTIONS).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  step: z.number().positive().finite().optional(),
  minLength: z.int().nonnegative().max(MAX_TEXT_LENGTH).optional(),
  maxLength: z.int().positive().max(MAX_TEXT_LENGTH).optional(),
  multiline: z.boolean().optional(),
});
export type FormField = z.infer<typeof formFieldSchema>;

/** What a field's value is, once filled. */
export type FieldValue = string | number | boolean | string[] | { start: string; end: string };

/**
 * Problems with a field as described, before anyone fills it in.
 *
 * The rules a schema alone cannot say: a choice needs options and a toggle has none, a slider needs a range, a
 * minimum sits below its maximum, and no field asks for a secret.
 */
export function checkField(field: FormField): string[] {
  const problems: string[] = [];
  const where = `field "${field.name}"`;
  if (SECRET_PATTERN.test(field.name) || SECRET_PATTERN.test(field.label)) {
    problems.push(
      `${where} asks for a secret; a widget never collects one — passwords, tokens and keys go through the host's connection flow`,
    );
  }
  const options = field.options ?? [];
  if (SINGLE_CHOICE.has(field.kind) || MULTI_CHOICE.has(field.kind)) {
    if (options.length === 0) problems.push(`${where} (${field.kind}) needs options`);
    const values = options.map((option) => option.value);
    if (new Set(values).size !== values.length) problems.push(`${where} has two options with the same value`);
  } else if (options.length > 0) {
    problems.push(`${where} (${field.kind}) takes no options`);
  }
  if (field.kind === "slider" && (field.min === undefined || field.max === undefined)) {
    problems.push(`${where} (slider) needs min and max`);
  }
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
    problems.push(`${where} has a min above its max`);
  }
  if (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength) {
    problems.push(`${where} has a minLength above its maxLength`);
  }
  const numeric = field.kind === "number" || field.kind === "slider";
  if (!numeric && (field.min !== undefined || field.max !== undefined || field.step !== undefined)) {
    problems.push(`${where} (${field.kind}) takes no min, max or step`);
  }
  if (field.kind !== "text" && (field.minLength !== undefined || field.maxLength !== undefined || field.multiline !== undefined)) {
    problems.push(`${where} (${field.kind}) takes no minLength, maxLength or multiline`);
  }
  return problems;
}

/** Problems with a set of fields: each field's own, a bounded count, and names that do not repeat. */
export function checkFields(fields: readonly FormField[]): string[] {
  const problems: string[] = [];
  if (fields.length === 0) problems.push("a form needs at least one field");
  if (fields.length > MAX_FORM_FIELDS) problems.push(`a form has ${String(fields.length)} fields; at most ${String(MAX_FORM_FIELDS)}`);
  const names = new Set<string>();
  for (const field of fields) {
    if (names.has(field.name)) problems.push(`two fields are named "${field.name}"`);
    names.add(field.name);
    problems.push(...checkField(field));
  }
  return problems;
}

/**
 * A single choice or input described by a widget's props, as the field it is: named `name`, with the starting value
 * left out. `undefined` when the props do not describe a field at all.
 */
export function fieldFromProps(props: Readonly<Record<string, unknown>>, name = "value"): FormField | undefined {
  const { value: _value, ...described } = props;
  const parsed = formFieldSchema.safeParse({ ...described, name });
  return parsed.success ? parsed.data : undefined;
}
/** A form's fields as its props hold them, or `undefined` when they are not fields a form can hold. */
export function parseFields(value: unknown): FormField[] | undefined {
  const parsed = z.array(formFieldSchema).max(MAX_FORM_FIELDS).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
/** Whether a value counts as not filled in: required fields refuse it, optional ones leave it out. */
export function isEmptyValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0)
  );
}

function decimalsOf(value: number): number {
  const text = String(value);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** Whether `value` lands on the step grid that starts at `base`, without floating-point noise deciding. */
function onStep(value: number, base: number, step: number): boolean {
  const scale = 10 ** Math.max(decimalsOf(value), decimalsOf(base), decimalsOf(step));
  const offset = Math.round((value - base) * scale);
  return offset % Math.round(step * scale) === 0;
}

function isRealDate(text: string): boolean {
  if (!DATE_PATTERN.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

/**
 * Why a value does not fit a field, or `undefined` when it does.
 *
 * The sentence is shown under the field on the page and returned by the node, so it names the rule rather than the
 * field: the field's own label sits beside it.
 */
export function checkFieldValue(field: FormField, value: unknown): string | undefined {
  if (isEmptyValue(value)) return field.required === true ? "required" : undefined;
  const optionValues = new Set((field.options ?? []).map((option) => option.value));
  switch (field.kind) {
    case "text": {
      if (typeof value !== "string") return "expected text";
      const length = [...value].length;
      if (length > (field.maxLength ?? MAX_TEXT_LENGTH)) return `at most ${String(field.maxLength ?? MAX_TEXT_LENGTH)} characters`;
      if (field.minLength !== undefined && length < field.minLength) return `at least ${String(field.minLength)} characters`;
      return undefined;
    }
    case "number":
    case "slider": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "expected a number";
      if (field.min !== undefined && value < field.min) return `at least ${String(field.min)}`;
      if (field.max !== undefined && value > field.max) return `at most ${String(field.max)}`;
      if (field.step !== undefined && !onStep(value, field.min ?? 0, field.step)) return `in steps of ${String(field.step)}`;
      return undefined;
    }
    case "date":
      return typeof value === "string" && isRealDate(value) ? undefined : "expected a date (YYYY-MM-DD)";
    case "time":
      return typeof value === "string" && TIME_PATTERN.test(value) ? undefined : "expected a time (HH:MM)";
    case "date-range": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return "expected a start and an end date";
      const { start, end, ...rest } = value as Record<string, unknown>;
      if (Object.keys(rest).length > 0) return "expected only a start and an end date";
      if (typeof start !== "string" || !isRealDate(start) || typeof end !== "string" || !isRealDate(end)) {
        return "expected a start and an end date (YYYY-MM-DD)";
      }
      return start <= end ? undefined : "the end comes before the start";
    }
    case "select":
    case "radio":
      return typeof value === "string" && optionValues.has(value) ? undefined : "expected one of the options";
    case "chips":
    case "multiselect": {
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && optionValues.has(item))) {
        return "expected options from the list";
      }
      return new Set(value).size === value.length ? undefined : "an option is chosen twice";
    }
    case "checkbox":
    case "toggle":
      if (typeof value !== "boolean") return "expected on or off";
      // A required checkbox is one the person has to tick, such as agreeing to something.
      return field.required === true && !value ? "required" : undefined;
  }
}

/**
 * Check submitted values against the fields: every problem by field name, plus any value that names no field.
 *
 * An unknown key is refused rather than dropped, for the same reason a bound action refuses one: a page that sends a
 * field it was never given is broken or probing.
 */
export function checkFormValues(
  fields: readonly FormField[],
  values: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const problems: Record<string, string> = {};
  const names = new Set(fields.map((field) => field.name));
  for (const key of Object.keys(values)) {
    if (!names.has(key)) problems[key] = "not a field of this form";
  }
  for (const field of fields) {
    const problem = checkFieldValue(field, values[field.name]);
    if (problem !== undefined) problems[field.name] = problem;
  }
  return problems;
}

/** The value a field starts with when nothing was typed yet. */
export function emptyValueOf(field: FormField): FieldValue | undefined {
  if (BOOLEAN_KINDS.has(field.kind)) return false;
  if (MULTI_CHOICE.has(field.kind)) return [];
  return undefined;
}

/** One field's value as JSON Schema: the rules above that a schema can say. */
export function fieldJsonSchema(field: FormField): Record<string, unknown> {
  const titled = { title: field.label };
  const options = (field.options ?? []).map((option) => option.value);
  switch (field.kind) {
    case "text":
      return {
        ...titled,
        type: "string",
        maxLength: field.maxLength ?? MAX_TEXT_LENGTH,
        ...(field.minLength === undefined ? {} : { minLength: field.minLength }),
      };
    case "number":
    case "slider":
      return {
        ...titled,
        type: "number",
        ...(field.min === undefined ? {} : { minimum: field.min }),
        ...(field.max === undefined ? {} : { maximum: field.max }),
      };
    case "date":
      return { ...titled, type: "string", pattern: DATE_PATTERN.source };
    case "time":
      return { ...titled, type: "string", pattern: TIME_PATTERN.source };
    case "date-range":
      return {
        ...titled,
        type: "object",
        additionalProperties: false,
        properties: { start: { type: "string", pattern: DATE_PATTERN.source }, end: { type: "string", pattern: DATE_PATTERN.source } },
        required: ["start", "end"],
      };
    case "select":
    case "radio":
      return { ...titled, type: "string", enum: options };
    case "chips":
    case "multiselect":
      return { ...titled, type: "array", items: { type: "string", enum: options }, uniqueItems: true, maxItems: options.length };
    case "checkbox":
    case "toggle":
      return { ...titled, type: "boolean", ...(field.required === true ? { enum: [true] } : {}) };
  }
}

/** The input a form's bound action accepts: exactly its fields, the required ones required. */
export function formInputSchema(fields: readonly FormField[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(fields.map((field) => [field.name, fieldJsonSchema(field)])),
    required: fields.filter((field) => field.required === true).map((field) => field.name),
  };
}

/** A value as a person reads it, for the message a submitted form becomes and for a text alternative. */
export function describeFieldValue(field: FormField, value: unknown): string {
  if (isEmptyValue(value)) return "—";
  const labelOf = (item: string): string => field.options?.find((option) => option.value === item)?.label ?? item;
  if (Array.isArray(value)) return value.map((item) => labelOf(String(item))).join(", ");
  if (typeof value === "boolean") return value ? "✓" : "✗";
  if (typeof value === "object" && value !== null) {
    const range = value as { start?: unknown; end?: unknown };
    return `${String(range.start)} – ${String(range.end)}`;
  }
  return labelOf(String(value));
}

/* ------------------------------------------------------------------ *
 * Lists
 * ------------------------------------------------------------------ */

export const MAX_LIST_ITEMS = 200;
export const LIST_PAGE_SIZES = { min: 5, max: 50, default: 10 } as const;

export const listItemSchema = z.strictObject({
  /** Stable across redraws: selection and an item's action both name the item by it. */
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  subtitle: z.string().max(300).optional(),
  meta: z.string().max(80).optional(),
});
export type ListItem = z.infer<typeof listItemSchema>;

/** A list's items as its props hold them, or `undefined` when they are not items a list can hold. */
export function parseListItems(value: unknown): ListItem[] | undefined {
  const parsed = z.array(listItemSchema).max(MAX_LIST_ITEMS).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
/** Problems with a list's items the schema cannot see: ids that repeat. */
export function checkListItems(items: readonly ListItem[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) repeated.add(item.id);
    seen.add(item.id);
  }
  return repeated.size === 0 ? [] : [`item ids repeat: ${[...repeated].slice(0, 5).join(", ")}; each item needs its own id`];
}

/** One page of a list, and the numbers its pagination says. A page past the end shows the last one. */
export function listPage<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
): { rows: T[]; page: number; pageCount: number; total: number } {
  const size = Math.min(LIST_PAGE_SIZES.max, Math.max(LIST_PAGE_SIZES.min, Math.floor(pageSize)));
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(pageCount, Math.max(1, Math.floor(page)));
  return { rows: items.slice((current - 1) * size, current * size), page: current, pageCount, total: items.length };
}

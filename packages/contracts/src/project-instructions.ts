import { z } from "zod";

/**
 * A project's conditional instructions: `<project>/.clarkcant/instructions.json` (#433, #454).
 *
 * An open contract: the node reads it, `clarkcant instructions check` validates it, and anything else that writes or
 * checks the file uses this same schema. A rule names a condition and the snippets
 * (`<project>/.clarkcant/instructions/<name>.md`) stated while it holds. An instruction is guidance; it grants nothing.
 *
 * Versioned: a file written now says `"version": 1` (`projectInstructionsFileSchema`). A file written before the field
 * was required has none and is still read, as version 1 (`readProjectInstructions`). A version this build does not know
 * is not read at all, rather than read as something it may not mean.
 */

export const PROJECT_INSTRUCTIONS_VERSION = 1;

/** Where the file is, relative to the project folder. */
export const PROJECT_INSTRUCTIONS_PATH = ".clarkcant/instructions.json";

export const PROJECT_INSTRUCTION_LIMITS = {
  /** Rules read from one file; a reader ignores the rest, and a file written with more is invalid. */
  rules: 32,
  /** Snippets one rule may include. */
  includesPerRule: 8,
  /** Values one condition may list. */
  valuesPerCondition: 16,
  /** Bytes of the file; a larger one is not read. */
  fileBytes: 64 * 1024,
  /** Characters of one path glob. */
  globChars: 200,
  /** `*`, `**` and `?` in one path glob. */
  globWildcards: 16,
  /** Folders in one path glob, after a run of `**` counts as one. */
  globSegments: 32,
  /**
   * Characters of all path globs in one file together. Matching costs at most glob characters × path characters for each
   * path checked, so this bounds the work per path whatever the file says; a reader leaves out a rule that would go over.
   */
  globCharsPerFile: 4_000,
} as const;

export const INSTRUCTION_OPERATIONS = ["read", "write", "command", "test", "deploy"] as const;
export type InstructionOperation = (typeof INSTRUCTION_OPERATIONS)[number];
export const INSTRUCTION_ROLES = ["foreground", "background", "task"] as const;
export type InstructionRole = (typeof INSTRUCTION_ROLES)[number];

/** A snippet's name: `<project>/.clarkcant/instructions/<name>.md`, so nothing a rule says can point anywhere else. */
export const instructionNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, { error: "must be a snippet name of lowercase letters, digits and -" });

/** A path glob with `/` between folders and backslashes read as `/`, without a leading `./`. */
export function normalInstructionGlob(glob: string): string {
  return glob.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Why a path glob cannot be used, or `undefined` when it can. The bounds keep matching cheap whoever wrote the file. */
export function instructionGlobProblem(glob: string): string | undefined {
  const pattern = normalInstructionGlob(glob);
  if (pattern === "") return "must not be empty";
  if (pattern.length > PROJECT_INSTRUCTION_LIMITS.globChars) {
    return `must be at most ${String(PROJECT_INSTRUCTION_LIMITS.globChars)} characters`;
  }
  if ((pattern.match(/[*?]/g) ?? []).length > PROJECT_INSTRUCTION_LIMITS.globWildcards) {
    return `must have at most ${String(PROJECT_INSTRUCTION_LIMITS.globWildcards)} wildcards`;
  }
  let segments = 0;
  let previous = "";
  for (const segment of pattern.split("/")) {
    if (segment === "" || (segment === "**" && previous === "**")) continue;
    segments += 1;
    previous = segment;
  }
  if (segments === 0) return "must name at least one folder or file";
  if (segments > PROJECT_INSTRUCTION_LIMITS.globSegments) {
    return `must have at most ${String(PROJECT_INSTRUCTION_LIMITS.globSegments)} folders`;
  }
  return undefined;
}

/** The characters a rule's path globs count towards `PROJECT_INSTRUCTION_LIMITS.globCharsPerFile`. */
export function instructionRuleGlobChars(rule: { when?: { path?: string | readonly string[] | undefined } }): number {
  const path = rule.when?.path;
  if (path === undefined) return 0;
  return (typeof path === "string" ? [path] : path).reduce((total, glob) => total + normalInstructionGlob(glob).length, 0);
}

const globCharsPerFileProblem = (): string =>
  `takes the file's path globs over ${String(PROJECT_INSTRUCTION_LIMITS.globCharsPerFile)} characters in all; a node leaves this rule out`;

/**
 * One value or a list of 1 to `valuesPerCondition` of them. The union's own error would only say "Invalid input", so the
 * message names the value that is wrong and why, the way the field's schema words it.
 */
const oneOrMany = <T extends z.ZodType>(schema: T, what: string) =>
  z.union(
    [
      schema,
      z
        .array(schema)
        .min(1, { error: oneOrManyExpected(what) })
        .max(PROJECT_INSTRUCTION_LIMITS.valuesPerCondition, { error: oneOrManyExpected(what) }),
    ],
    { error: (issue) => oneOrManyProblem(schema, what, issue.input) },
  );

const oneOrManyExpected = (what: string): string =>
  `must be ${what} or a list of 1 to ${String(PROJECT_INSTRUCTION_LIMITS.valuesPerCondition)} of them`;

function oneOrManyProblem(schema: z.ZodType, what: string, input: unknown): string {
  const most = PROJECT_INSTRUCTION_LIMITS.valuesPerCondition;
  const expected = oneOrManyExpected(what);
  // A value of the wrong type or outside the allowed set is said in the field's own words; any other problem (too long,
  // not a usable glob) keeps the item schema's message, which already says what to change.
  const problem = (value: unknown, wrong: string): string | undefined => {
    const parsed = schema.safeParse(value);
    if (parsed.success) return undefined;
    const issue = parsed.error.issues[0];
    return issue === undefined || issue.code === "invalid_type" || issue.code === "invalid_value" ? wrong : issue.message;
  };
  if (!Array.isArray(input)) return problem(input, expected) ?? expected;
  if (input.length === 0 || input.length > most) return expected;
  for (const [index, item] of input.entries()) {
    const found = problem(item, `must be ${what}`);
    if (found !== undefined) return `item [${String(index)}] ${found}`;
  }
  return expected;
}
const conditionText = z.string().min(1).max(200);
// The glob bounds include empty and too long, so the base is a plain string: one message per problem.
const pathGlob = z.string().refine((glob) => instructionGlobProblem(glob) === undefined, {
  error: (issue) => instructionGlobProblem(String(issue.input)) ?? "is not a usable path glob",
});

/** One rule: when its condition holds, its snippets are stated. Every condition named must hold. */
export const projectInstructionRuleSchema = z.strictObject({
  when: z
    .strictObject({
      /** The project folder's name, compared without case. */
      project: oneOrMany(conditionText, "a folder name").optional(),
      /** A glob relative to the project. */
      path: oneOrMany(pathGlob, "a path glob").optional(),
      operation: oneOrMany(z.enum(INSTRUCTION_OPERATIONS), `one of ${INSTRUCTION_OPERATIONS.join(", ")}`).optional(),
      /** The tool or capability that touched the path. */
      capability: oneOrMany(conditionText, "a tool or capability name").optional(),
      role: oneOrMany(z.enum(INSTRUCTION_ROLES), `one of ${INSTRUCTION_ROLES.join(", ")}`).optional(),
      /** A skill the message being answered references. */
      skill: oneOrMany(conditionText, "a skill name").optional(),
    })
    .default({}),
  include: z.array(instructionNameSchema).min(1).max(PROJECT_INSTRUCTION_LIMITS.includesPerRule),
  /** Restated every turn it applies, rather than once per session. */
  pin: z.boolean().optional(),
});
export type ProjectInstructionRule = z.infer<typeof projectInstructionRuleSchema>;

/**
 * An editor's JSON schema reference. The only extra top-level key a file may carry: any other unknown top-level key makes
 * the whole file unreadable, while an unknown key inside a rule or its `when` leaves out only that rule.
 */
const schemaReference = z.string().max(2_000).optional();

/** The file as it is written or created now: `version` is required and every rule must be valid. */
export const projectInstructionsFileSchema = z
  .strictObject({
    $schema: schemaReference,
    version: z.literal(PROJECT_INSTRUCTIONS_VERSION, { error: `must be the number ${String(PROJECT_INSTRUCTIONS_VERSION)}` }),
    rules: z.array(projectInstructionRuleSchema).max(PROJECT_INSTRUCTION_LIMITS.rules),
  })
  .superRefine((file, context) => {
    for (const index of rulesOverGlobChars(file.rules)) {
      context.addIssue({ code: "custom", path: ["rules", index, "when", "path"], message: globCharsPerFileProblem() });
    }
  });

/**
 * The rules, by index, that a reader leaves out for taking the file's path globs over
 * `PROJECT_INSTRUCTION_LIMITS.globCharsPerFile`: counted the way a reader counts, over the rules that parse, in file
 * order, a rule that goes over measured out and the next one measured without it.
 */
function rulesOverGlobChars(rules: readonly unknown[]): number[] {
  const over: number[] = [];
  let total = 0;
  for (const [index, entry] of rules.entries()) {
    const rule = projectInstructionRuleSchema.safeParse(entry);
    if (!rule.success) continue;
    const chars = instructionRuleGlobChars(rule.data);
    if (total + chars > PROJECT_INSTRUCTION_LIMITS.globCharsPerFile) over.push(index);
    else total += chars;
  }
  return over;
}
export type ProjectInstructionsFile = z.infer<typeof projectInstructionsFileSchema>;

/**
 * Why a reader could not use a file at all: larger than `PROJECT_INSTRUCTION_LIMITS.fileBytes`, not JSON, not an object
 * of this shape, or a `version` this build does not know. Only the last two come from `readProjectInstructions`; the
 * first two are found by whoever reads the bytes.
 */
export const PROJECT_INSTRUCTIONS_INVALID_REASONS = ["too-large", "not-json", "shape", "unknown-version"] as const;
export type ProjectInstructionsInvalidReason = (typeof PROJECT_INSTRUCTIONS_INVALID_REASONS)[number];

/** The `version` a file names when it is a number this build does not read, or `undefined`. */
function unknownVersion(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("version" in value)) return undefined;
  const { version } = value as { version: unknown };
  return typeof version === "number" && version !== PROJECT_INSTRUCTIONS_VERSION ? version : undefined;
}

/** The one line that says a file's version cannot be read here, and what to do about it. */
function unknownVersionProblem(version: number): string {
  const known = String(PROJECT_INSTRUCTIONS_VERSION);
  return version > PROJECT_INSTRUCTIONS_VERSION
    ? `version ${String(version)} is newer than this build reads (${known}); update ClarkCant`
    : `version ${String(version)} is not one ClarkCant reads; write "version": ${known}`;
}

/**
 * What is wrong with a file as it would be written now, one line each, or nothing when it is valid. A missing `version`
 * is a problem here even though a reader still accepts it, and the rest of the file is checked as if it said version 1.
 * A numeric `version` this build does not know is the only line: the rest of the file may be valid in that version.
 */
export function projectInstructionsProblems(value: unknown): string[] {
  const version = unknownVersion(value);
  if (version !== undefined) return [unknownVersionProblem(version)];
  const problems: string[] = [];
  let candidate = value;
  if (typeof value === "object" && value !== null && !Array.isArray(value) && !("version" in value)) {
    problems.push(
      `version: missing; write "version": ${String(PROJECT_INSTRUCTIONS_VERSION)} (a node still reads a file without it as version ${String(PROJECT_INSTRUCTIONS_VERSION)})`,
    );
    candidate = { version: PROJECT_INSTRUCTIONS_VERSION, ...value };
  }
  const parsed = projectInstructionsFileSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const at = issue.path
        .map((part, index) => (typeof part === "number" ? `[${String(part)}]` : `${index === 0 ? "" : "."}${String(part)}`))
        .join("");
      problems.push(`${at === "" ? "file" : at}: ${issue.message}`);
    }
    // The file-wide count is a refinement, which does not run while another rule is invalid: said here too, so one check
    // lists every problem.
    const rules = typeof candidate === "object" && candidate !== null && "rules" in candidate ? candidate.rules : undefined;
    for (const index of Array.isArray(rules) ? rulesOverGlobChars(rules) : []) {
      const line = `rules[${String(index)}].when.path: ${globCharsPerFileProblem()}`;
      if (!problems.includes(line)) problems.push(line);
    }
  }
  return problems;
}

/** What a reader accepts around the rules: `version` may be missing, and the rules are checked one by one. */
const readableFileSchema = z.strictObject({
  $schema: schemaReference,
  version: z.literal(PROJECT_INSTRUCTIONS_VERSION).optional(),
  rules: z.array(z.unknown()).max(1_000),
});

export type ProjectInstructionsRead =
  | { ok: true; version: typeof PROJECT_INSTRUCTIONS_VERSION; rules: ProjectInstructionRule[] }
  | { ok: false; reason: "unknown-version"; version: number }
  | { ok: false; reason: "shape" };

/**
 * The file as a reader uses it, or why it cannot be used: a `version` this build does not know, or not an object of
 * this shape. A file with no `version` is version 1. A rule that does not parse is left out on its own and the rest
 * still apply; only the first `PROJECT_INSTRUCTION_LIMITS.rules` entries are read, and a rule whose path globs would take
 * the file over `PROJECT_INSTRUCTION_LIMITS.globCharsPerFile` is left out too, in file order.
 */
export function readProjectInstructions(value: unknown): ProjectInstructionsRead {
  const version = unknownVersion(value);
  if (version !== undefined) return { ok: false, reason: "unknown-version", version };
  const file = readableFileSchema.safeParse(value);
  if (!file.success) return { ok: false, reason: "shape" };
  const rules: ProjectInstructionRule[] = [];
  let globChars = 0;
  for (const entry of file.data.rules.slice(0, PROJECT_INSTRUCTION_LIMITS.rules)) {
    const rule = projectInstructionRuleSchema.safeParse(entry);
    if (!rule.success) continue;
    const chars = instructionRuleGlobChars(rule.data);
    if (globChars + chars > PROJECT_INSTRUCTION_LIMITS.globCharsPerFile) continue;
    globChars += chars;
    rules.push(rule.data);
  }
  return { ok: true, version: PROJECT_INSTRUCTIONS_VERSION, rules };
}

/** The `.md` file a rule's `include` name points to, relative to the folder that holds the instructions file. */
export function projectInstructionSnippetPath(name: string): string {
  return `instructions/${name}.md`;
}
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

const oneOrMany = <T extends z.ZodType>(schema: T) =>
  z.union([schema, z.array(schema).min(1).max(PROJECT_INSTRUCTION_LIMITS.valuesPerCondition)]);
const conditionText = z.string().min(1).max(200);
const pathGlob = conditionText.refine((glob) => instructionGlobProblem(glob) === undefined, {
  error: (issue) => instructionGlobProblem(String(issue.input)) ?? "is not a usable path glob",
});

/** One rule: when its condition holds, its snippets are stated. Every condition named must hold. */
export const projectInstructionRuleSchema = z.strictObject({
  when: z
    .strictObject({
      /** The project folder's name, compared without case. */
      project: oneOrMany(conditionText).optional(),
      /** A glob relative to the project. */
      path: oneOrMany(pathGlob).optional(),
      operation: oneOrMany(z.enum(INSTRUCTION_OPERATIONS)).optional(),
      /** The tool or capability that touched the path. */
      capability: oneOrMany(conditionText).optional(),
      role: oneOrMany(z.enum(INSTRUCTION_ROLES)).optional(),
      /** A skill the message being answered references. */
      skill: oneOrMany(conditionText).optional(),
    })
    .default({}),
  include: z.array(instructionNameSchema).min(1).max(PROJECT_INSTRUCTION_LIMITS.includesPerRule),
  /** Restated every turn it applies, rather than once per session. */
  pin: z.boolean().optional(),
});
export type ProjectInstructionRule = z.infer<typeof projectInstructionRuleSchema>;

/** The file as it is written or created now: `version` is required and every rule must be valid. */
export const projectInstructionsFileSchema = z.strictObject({
  version: z.literal(PROJECT_INSTRUCTIONS_VERSION),
  rules: z.array(projectInstructionRuleSchema).max(PROJECT_INSTRUCTION_LIMITS.rules),
});
export type ProjectInstructionsFile = z.infer<typeof projectInstructionsFileSchema>;

/**
 * What is wrong with a file as it would be written now, one line each, or nothing when it is valid. A missing `version`
 * is a problem here even though a reader still accepts it, and the rest of the file is checked as if it said version 1.
 */
export function projectInstructionsProblems(value: unknown): string[] {
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
  }
  return problems;
}

/** What a reader accepts around the rules: `version` may be missing, and the rules are checked one by one. */
const readableFileSchema = z.strictObject({
  version: z.literal(PROJECT_INSTRUCTIONS_VERSION).optional(),
  rules: z.array(z.unknown()).max(1_000),
});

/**
 * The file as a reader uses it, or `undefined` when it cannot be used: not an object of this shape, or a version this
 * build does not know. A file with no `version` is version 1. A rule that does not parse is left out on its own and the
 * rest still apply; only the first `PROJECT_INSTRUCTION_LIMITS.rules` entries are read.
 */
export function readProjectInstructions(
  value: unknown,
): { version: typeof PROJECT_INSTRUCTIONS_VERSION; rules: ProjectInstructionRule[] } | undefined {
  const file = readableFileSchema.safeParse(value);
  if (!file.success) return undefined;
  const rules: ProjectInstructionRule[] = [];
  for (const entry of file.data.rules.slice(0, PROJECT_INSTRUCTION_LIMITS.rules)) {
    const rule = projectInstructionRuleSchema.safeParse(entry);
    if (rule.success) rules.push(rule.data);
  }
  return { version: PROJECT_INSTRUCTIONS_VERSION, rules };
}

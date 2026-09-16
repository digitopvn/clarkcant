/**
 * Loading a local `.env` into the process environment.
 *
 * The node needs provider credentials to run a live model, and `.env` is where an operator
 * puts them. Two properties matter more than the parsing:
 *
 * - An existing variable always wins. A deployment that sets the real secret in its own
 *   environment must not have it overwritten by a file that happens to sit in the checkout.
 * - No value is ever logged or returned. The function reports which names it took, because
 *   "the node cannot find a credential" and "the node found the wrong one" are different
 *   problems and an operator needs to tell them apart without a secret appearing in a log.
 */

export interface EnvFileResult {
  /** Names that were added to the environment. Never values. */
  loaded: string[];
  /** Names present in the file but skipped because the environment already had them. */
  overridden: string[];
  /** The file was not there, which is a normal state rather than an error. */
  missing: boolean;
}

/**
 * Parse `.env` content.
 *
 * Deliberately small: `NAME=value`, optional surrounding quotes, `#` comments, blank lines.
 * Anything more elaborate belongs to a tool designed for it, and a configuration format
 * with its own quirks is a configuration format that surprises someone.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null) continue;
    const name = match[1];
    const raw = match[2];
    if (name === undefined || raw === undefined) continue;
    let value = raw;
    const quoted = /^(["'])(.*)\1$/.exec(value);
    const inner = quoted?.[2];
    if (inner !== undefined) value = inner;
    if (value === "" || value.startsWith("#")) continue;
    values[name] = value;
  }
  return values;
}

/**
 * Apply a `.env` file to an environment object, without overwriting what is already set.
 *
 * Mutating the passed object rather than returning a new one is intentional: the point is to
 * make the variables visible to `process.env`, so that a child process spawned through the
 * execution supervisor can receive an allowlisted subset of them.
 */
export function applyEnvFile(
  path: string,
  target: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): EnvFileResult {
  let content: string;
  try {
    content = readFile(path);
  } catch {
    return { loaded: [], overridden: [], missing: true };
  }

  const loaded: string[] = [];
  const overridden: string[] = [];
  for (const [name, value] of Object.entries(parseEnvFile(content))) {
    if (target[name] !== undefined && target[name] !== "") {
      overridden.push(name);
      continue;
    }
    target[name] = value;
    loaded.push(name);
  }
  return { loaded, overridden, missing: false };
}

/**
 * The environment variable names a provider key can arrive under.
 *
 * Named rather than derived, because this list is what an execution profile has to allow
 * through for a live model to work, and a profile that guessed would silently hand a child
 * process nothing.
 */
export const PROVIDER_KEY_VARIABLES: Record<string, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
};

/** The variable a provider's key is expected in, or undefined for an unknown provider. */
export function keyVariableFor(provider: string): string | undefined {
  return PROVIDER_KEY_VARIABLES[provider];
}

export interface ModelSelection {
  provider: string;
  id: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

/**
 * Limits on a conversation turn.
 *
 * A conversation is the path with no approval step in front of it, so it is the one that most
 * needs a ceiling: every message is a provider call the user pays for, and a model that decides
 * to loop would otherwise do so until someone noticed the bill. The defaults are generous enough
 * that a normal answer never reaches them, because a limit that fires on ordinary use teaches the
 * user to raise it rather than to trust it.
 */
export interface ModelBudget {
  maxWallClockMs: number;
  maxTokens: number;
}

export const DEFAULT_MODEL_BUDGET: ModelBudget = { maxWallClockMs: 120_000, maxTokens: 32_000 };

/**
 * The turn budget, from the environment.
 *
 * A value that is not a positive number is ignored rather than clamped: silently turning a
 * mistyped limit into a different limit is worse than using the default, because the operator
 * would believe a restriction is in force when it is not.
 */
export function modelBudgetFromEnv(env: NodeJS.ProcessEnv): ModelBudget {
  const read = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };
  return {
    maxWallClockMs: read("CC_MODEL_MAX_WALL_CLOCK_MS", DEFAULT_MODEL_BUDGET.maxWallClockMs),
    maxTokens: read("CC_MODEL_MAX_TOKENS", DEFAULT_MODEL_BUDGET.maxTokens),
  };
}

/**
 * The model a node should run on, from its environment.
 *
 * Both halves are required together. A provider without a model, or a model without a
 * provider, is a half-configured node, and resolving a default in that case would hide a
 * misconfiguration behind a model nobody chose.
 */
export function modelFromEnv(env: NodeJS.ProcessEnv): ModelSelection | undefined {
  const provider = env.CC_MODEL_PROVIDER?.trim();
  const id = env.CC_MODEL_ID?.trim();
  if (provider === undefined || provider === "" || id === undefined || id === "") return undefined;

  const thinking = env.CC_MODEL_THINKING?.trim();
  const allowed = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  const thinkingLevel = allowed.find((level) => level === thinking);

  return { provider, id, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) };
}

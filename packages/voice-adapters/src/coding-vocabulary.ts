import {
  MAX_RECOGNITION_TERMS,
  MAX_RECOGNITION_TERM_LENGTH,
  type RecognitionContext,
  type RecognitionTerm,
  type RecognitionTermKind,
  recognitionContextSchema,
  redactSecrets,
} from "@clarkcant/contracts";

/**
 * The coding vocabulary a voice session is recognized against.
 *
 * Built from what the person is working on right now - the project, its packages, the files and symbols the
 * conversation has been about, the branch, the issues, the tools, the models - plus a small glossary of terms every
 * coding conversation uses. Ranked by how relevant each one is to this session, bounded to a size a recognizer can
 * use, and passed through the repository's one secret redaction before it can reach an external provider: a term
 * that redaction would change is dropped whole rather than sent as `[redacted]`, because a placeholder is not
 * vocabulary and a half-redacted token is still part of a secret.
 *
 * Nothing here reads the disk or the network. The node gathers the sources; this decides what of them is vocabulary.
 */

export interface VocabularySources {
  /** Newest or most relevant first, in every list: position is part of the ranking. */
  repositories?: readonly string[];
  packages?: readonly string[];
  paths?: readonly string[];
  branches?: readonly string[];
  symbols?: readonly string[];
  issues?: readonly string[];
  tools?: readonly string[];
  models?: readonly string[];
  providers?: readonly string[];
  /** Recent conversation text, used to rank what this session is about. Read here, never sent anywhere. */
  recentText?: readonly string[];
}

export interface GlossaryEntry {
  text: string;
  kind: RecognitionTermKind;
  aliases?: readonly string[];
}

/**
 * Terms a coding conversation uses whatever the project.
 *
 * Aliases are mis-hearings observed for that term and no other ("stale closer", "Jeff" for Jev). Spacing variants such
 * as "use effect" are not listed: the normaliser derives them from the spelling, so they cannot drift from it.
 */
export const CODING_GLOSSARY: readonly GlossaryEntry[] = [
  { text: "TypeScript", kind: "glossary" },
  { text: "JavaScript", kind: "glossary" },
  { text: "React", kind: "glossary" },
  { text: "useEffect", kind: "symbol" },
  { text: "useMemo", kind: "symbol" },
  { text: "useState", kind: "symbol" },
  { text: "useCallback", kind: "symbol" },
  { text: "useRef", kind: "symbol" },
  { text: "pnpm", kind: "glossary", aliases: ["pnp m", "pnpn", "p and pm"] },
  { text: "GitHub", kind: "glossary" },
  { text: "worktree", kind: "glossary" },
  { text: "WebSocket", kind: "glossary" },
  { text: "OAuth", kind: "glossary", aliases: ["oh auth"] },
  { text: "MCP", kind: "glossary" },
  { text: "Pi", kind: "glossary" },
  { text: "Jev", kind: "glossary", aliases: ["Jeff"] },
  { text: "Playwright", kind: "glossary", aliases: ["play write", "playwrite"] },
  { text: "Vitest", kind: "glossary", aliases: ["vite test"] },
  { text: "Node.js", kind: "glossary", aliases: ["node j s"] },
  { text: "Electron", kind: "glossary" },
  { text: "Zod", kind: "glossary" },
  { text: "SQLite", kind: "glossary", aliases: ["sequel lite", "sql lite"] },
  { text: "ESLint", kind: "glossary", aliases: ["e s lint", "es lint"] },
  { text: "Corepack", kind: "glossary", aliases: ["core pack"] },
  { text: "Gemini", kind: "provider" },
  { text: "ClarkCant", kind: "repository", aliases: ["clark can't", "clark cant"] },
  { text: "API", kind: "glossary" },
  { text: "JSON", kind: "glossary" },
  { text: "CLI", kind: "glossary" },
  { text: "SSE", kind: "glossary" },
  { text: "stale closure", kind: "glossary", aliases: ["stale closer", "stale clothes"] },
  { text: "dependency array", kind: "glossary" },
  { text: "pull request", kind: "glossary" },
  { text: "merge conflict", kind: "glossary" },
  { text: "rebase", kind: "glossary", aliases: ["re base"] },
  { text: "git stash", kind: "command" },
  { text: "git status", kind: "command" },
  { text: "git rebase", kind: "command" },
  { text: "git reset", kind: "command" },
  { text: "git push", kind: "command" },
  { text: "git pull", kind: "command" },
  { text: "git commit", kind: "command" },
  { text: "git checkout", kind: "command" },
  { text: "pnpm install", kind: "command" },
  { text: "pnpm verify", kind: "command" },
];

/**
 * How much each kind starts with.
 *
 * What the session itself names outranks what any session might: a symbol or a path from this conversation is the term
 * most likely to be said next, and the glossary is the floor.
 */
const KIND_BASE: Record<RecognitionTermKind, number> = {
  symbol: 0.5,
  path: 0.5,
  repository: 0.5,
  package: 0.45,
  branch: 0.4,
  model: 0.4,
  issue: 0.35,
  tool: 0.35,
  provider: 0.35,
  command: 0.3,
  glossary: 0.2,
};

const SOURCE_KINDS: ReadonlyArray<[keyof VocabularySources, RecognitionTermKind]> = [
  ["repositories", "repository"],
  ["packages", "package"],
  ["paths", "path"],
  ["branches", "branch"],
  ["symbols", "symbol"],
  ["issues", "issue"],
  ["tools", "tool"],
  ["models", "model"],
  ["providers", "provider"],
];

/** Most terms taken from any one source, so a project with three hundred dependencies cannot crowd out the rest. */
const MAX_PER_SOURCE = 40;

export interface BuildContextOptions {
  languageHints?: readonly string[];
  maxTerms?: number;
  /** Include `CODING_GLOSSARY`. On by default. */
  glossary?: boolean;
}

/** Build the bounded, ranked, redacted recognition context for a session. */
export function buildRecognitionContext(sources: VocabularySources, options: BuildContextOptions = {}): RecognitionContext {
  const maxTerms = Math.max(0, Math.min(options.maxTerms ?? MAX_RECOGNITION_TERMS, MAX_RECOGNITION_TERMS));
  const recent = (sources.recentText ?? []).join("\n").toLowerCase();
  const byKey = new Map<string, RecognitionTerm>();

  const offer = (text: string, kind: RecognitionTermKind, position: number, count: number, aliases?: readonly string[]): void => {
    const term = vocabularyTerm(text);
    if (term === undefined) return;
    const recency = count <= 1 ? 0.2 : 0.2 * (1 - position / count);
    const mentioned = recent === "" ? 0 : Math.min(0.3, 0.1 * mentions(recent, term.toLowerCase()));
    const weight = round(Math.min(1, KIND_BASE[kind] + recency + mentioned));
    const key = term.toLowerCase();
    const existing = byKey.get(key);
    if (existing !== undefined && existing.weight >= weight) return;
    const safeAliases = (aliases ?? []).map(vocabularyTerm).filter((alias): alias is string => alias !== undefined).slice(0, 8);
    byKey.set(key, { text: term, kind, weight, ...(safeAliases.length === 0 ? {} : { aliases: safeAliases }) });
  };

  for (const [source, kind] of SOURCE_KINDS) {
    const values = (sources[source] as readonly string[] | undefined) ?? [];
    const taken = values.slice(0, MAX_PER_SOURCE);
    taken.forEach((value, index) => offer(value, kind, index, taken.length));
  }
  if (options.glossary !== false) {
    // Glossary entries carry no recency: their order is not a statement about this session.
    for (const entry of CODING_GLOSSARY) offer(entry.text, entry.kind, 0, 1, entry.aliases);
  }

  const terms = [...byKey.values()]
    .sort((left, right) => right.weight - left.weight || left.text.localeCompare(right.text))
    .slice(0, maxTerms);
  return recognitionContextSchema.parse({
    version: 1,
    languageHints: [...new Set(options.languageHints ?? [])].slice(0, 4),
    terms,
  });
}

/**
 * A candidate as vocabulary, or nothing.
 *
 * Refused: empty, longer than the bound, more than four words (a sentence, not a term), no letter at all - except an
 * issue reference such as `#468`, which tells a recognizer how the number is written - and anything the shared
 * redaction would touch.
 */
export function vocabularyTerm(raw: string): string | undefined {
  const text = raw.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (text === "" || text.length > MAX_RECOGNITION_TERM_LENGTH) return undefined;
  if (text.split(" ").length > 4) return undefined;
  if (!/\p{L}/u.test(text) && !/^#\d{1,7}$/u.test(text)) return undefined;
  if (redactSecrets(text) !== text) return undefined;
  return text;
}

/**
 * Terms worth recognizing that a conversation has mentioned: code spans, paths, identifiers, branches, issue numbers.
 *
 * Read from text the node already holds. Bounded per kind, newest mention first, and only shapes that are clearly
 * code: a capitalised ordinary word is not a symbol.
 */
export function vocabularyFromText(texts: readonly string[], limit = 30): Pick<VocabularySources, "paths" | "symbols" | "issues" | "branches"> {
  const paths = new Set<string>();
  const symbols = new Set<string>();
  const issues = new Set<string>();
  const branches = new Set<string>();
  // Newest last in the input; newest first in the output.
  for (const text of [...texts].reverse()) {
    for (const match of text.matchAll(/`([^`\n]{2,80})`/gu)) classify(match[1]!.trim());
    for (const match of text.matchAll(/(?<![\w/.-])(?:[\w-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,6}\b/gu)) addBounded(paths, match[0]);
    for (const match of text.matchAll(/(?<![\w/.-])[A-Za-z][\w-]*\.(?:tsx?|jsx?|mjs|cjs|json|md|css|ya?ml|py|rs|go|sql|toml)\b/gu)) addBounded(paths, match[0]);
    for (const match of text.matchAll(/(?<![\w#])#\d{1,7}\b/gu)) addBounded(issues, match[0]);
    for (const match of text.matchAll(/\b(?:feat|fix|perf|docs|chore|refactor|test|release|hotfix)\/[\w.-]+/gu)) addBounded(branches, match[0]);
    for (const match of text.matchAll(/\b(?:[a-z]+(?:[A-Z][a-z0-9]+)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z0-9]+(?:_[a-z0-9]+)+)\b/gu)) addBounded(symbols, match[0]);
  }
  return {
    paths: [...paths].slice(0, limit),
    symbols: [...symbols].slice(0, limit),
    issues: [...issues].slice(0, limit),
    branches: [...branches].slice(0, limit),
  };

  function classify(code: string): void {
    if (/\s/u.test(code)) return;
    if (/[/\\]|\.[A-Za-z0-9]{1,6}$/u.test(code)) addBounded(paths, code);
    else if (/^[A-Za-z_$][\w$]*(?:\(\))?$/u.test(code)) addBounded(symbols, code.replace(/\(\)$/u, ""));
  }

  function addBounded(into: Set<string>, value: string): void {
    if (into.size < limit * 2) into.add(value);
  }
}

function mentions(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1 && count < 5; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

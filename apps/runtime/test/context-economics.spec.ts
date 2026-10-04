import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate, openDatabase, type Database } from "@clarkcant/storage";

import { earlierMessagesFor, legacyRecap, planRecap, recapWindow, type RecapMessage } from "../src/context-planner.ts";
import { CORE_TOOLS, TOOL_FAMILIES, familyOf, planToolDisclosure, type ToolDisclosureMode } from "../src/tool-disclosure.ts";

import { ECONOMICS_CORPUS, RECAP_CASES, type EconomicsConversation } from "./context-economics-corpus.ts";
import { seedMessage } from "./conversation-message-seed.ts";

/**
 * What progressive tool disclosure and the focused recap cost and save, measured offline.
 *
 * Every tool's schema sits in the system prompt, which is the prefix the provider caches. Fewer tools is fewer tokens,
 * but a changed tool set is a changed prefix, and a changed prefix is written to the cache again at a premium instead of
 * read from it at a discount. So this simulates the cache rather than counting schema tokens alone, and compares:
 *
 * - `all`: every tool on every turn (the default);
 * - `progressive`: the shipped planner, grow-only within a session;
 * - `per-turn`: an exact set chosen fresh every turn — the dynamic selection the issue asks to measure before anyone
 *   makes it a default. It is not shipped; it is here to show what it would cost.
 *
 * Every number below is an estimate under the labelled assumptions, printed for the reader. The test asserts only what
 * must hold whatever the numbers are; it never asserts a number chosen to pass. Latency, real cache behaviour and task
 * success need a live A/B with provider credentials and are not measured here.
 *
 * In-sample: the family hints were written while looking at this corpus, so its wrong-tool rate is a best case for the
 * hints, not a held-out result. A held-out corpus, or the live A/B, is what would say how they generalise.
 */

/** Printed with every table, so a number is never read without what it is. */
const SAMPLE_NOTE = "in-sample (the hints were written against this corpus; not a held-out result)";

/** Labelled assumptions, not measurements. */
const ASSUMED = {
  /** The system prompt without tool schemas: instructions, personal instructions, memory brief. */
  baseSystemTokens: 2500,
  replyTokens: 250,
  /** USD per million tokens, at a representative frontier-model list price. */
  inputPerM: 3,
  cacheWritePerM: 3.75,
  cacheReadPerM: 0.3,
  charsPerToken: 4,
} as const;

const SOURCE_DIR = join(import.meta.dirname, "..", "src");

/**
 * The runtime's tool definitions and an estimate of each one's schema size.
 *
 * Read from the source: each definition from its `name` to its `execute`, which holds the name, label, description,
 * prompt snippet and parameter schema the model is sent. Source text is a proxy for the serialised schema, and chars/4
 * is a proxy for tokens; both are labelled estimates.
 */
function toolCatalogue(): Map<string, number> {
  const sizes = new Map<string, number>();
  const files = readdirSync(SOURCE_DIR, { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(".ts"));
  for (const file of files) {
    const source = readFileSync(join(SOURCE_DIR, file), "utf8");
    for (const match of source.matchAll(/name:\s*(?:"([a-z_]+)"|(SHOW_VIEW_TOOL)),\s*\n\s*label:/g)) {
      const name = match[1] ?? "show_view";
      const end = source.indexOf("execute", match.index);
      if (end === -1) continue;
      const span = source.slice(match.index, end);
      // A definition, not a receipt that happens to carry a tool's name and a label.
      if (!span.includes("description") || !span.includes("parameters") || span.length > 20_000) continue;
      const tokens = Math.ceil(span.replace(/\s+/g, " ").length / ASSUMED.charsPerToken);
      const known = sizes.get(name);
      if (known === undefined || tokens < known) sizes.set(name, tokens);
    }
  }
  return sizes;
}

const tokensOf = (text: string): number => Math.ceil(text.length / ASSUMED.charsPerToken);

type Mode = ToolDisclosureMode | "per-turn";

interface ModeResult {
  turns: number;
  schemaTokens: number;
  promptTokens: number;
  cacheWrite: number;
  cacheRead: number;
  uncached: number;
  costUsd: number;
  toolChanges: number;
  wrongTool: number;
  violations: string[];
}

async function simulate(mode: Mode, corpus: readonly EconomicsConversation[], sizes: Map<string, number>): Promise<ModeResult> {
  const registered = [...sizes.keys()];
  const result: ModeResult = {
    turns: 0,
    schemaTokens: 0,
    promptTokens: 0,
    cacheWrite: 0,
    cacheRead: 0,
    uncached: 0,
    costUsd: 0,
    toolChanges: 0,
    wrongTool: 0,
    violations: [],
  };
  for (const conversation of corpus) {
    let current: readonly string[] | undefined;
    let usedLastTurn: readonly string[] = [];
    let cachedPrefix = 0;
    let historyTokens = 0;
    let previousTools: string | undefined;
    for (const [index, turn] of conversation.turns.entries()) {
      if (index === 0 || turn.fresh === true) {
        // A new session: nothing cached, nothing narrowed, and the history arrives as a recap of the same size.
        current = undefined;
        usedLastTurn = [];
        cachedPrefix = 0;
        previousTools = undefined;
      }
      let active: readonly string[];
      if (mode === "all") {
        active = registered;
      } else {
        const plan = await planToolDisclosure({
          mode: "progressive",
          registered,
          current: mode === "per-turn" ? undefined : current,
          text: turn.text,
          usedLastTurn: mode === "per-turn" ? [] : usedLastTurn,
        });
        active = plan.active ?? current ?? registered;
      }

      const where = `${mode} ${conversation.id}#${String(index)}`;
      if (active.some((tool) => !registered.includes(tool))) result.violations.push(`${where}: a tool outside the registered set`);
      if (CORE_TOOLS.some((tool) => registered.includes(tool) && !active.includes(tool))) result.violations.push(`${where}: core tool missing`);
      if (mode === "progressive" && current !== undefined && current.some((tool) => !active.includes(tool))) {
        result.violations.push(`${where}: the set shrank within a session`);
      }

      const toolKey = [...active].sort().join(",");
      const schema = active.reduce((sum, tool) => sum + (sizes.get(tool) ?? 0), 0);
      const prompt = ASSUMED.baseSystemTokens + schema + historyTokens + tokensOf(turn.text);
      if (previousTools !== undefined && toolKey !== previousTools) result.toolChanges += 1;
      // The prefix the cache can serve: everything before this turn's message, unless the tools — and so the system
      // prompt in front of everything — changed, in which case the whole prompt is written again.
      // A fresh session writes its system prompt, tools and recap; a later turn's prefix is what the last turn left in
      // the cache. This turn's own message and the reply before it are new input, at the uncached price, either way.
      const prefix = previousTools === undefined ? Math.min(ASSUMED.baseSystemTokens + schema + historyTokens, prompt) : Math.min(cachedPrefix, prompt);
      const read = previousTools === toolKey ? prefix : 0;
      const written = prefix - read;
      const uncached = prompt - prefix;
      result.cacheRead += read;
      result.cacheWrite += written;
      result.uncached += uncached;
      result.costUsd += (read * ASSUMED.cacheReadPerM + written * ASSUMED.cacheWritePerM + uncached * ASSUMED.inputPerM) / 1_000_000;
      result.schemaTokens += schema;
      result.promptTokens += prompt;
      result.turns += 1;
      const missing = turn.needs.filter((tool) => registered.includes(tool) && !active.includes(tool));
      if (missing.length > 0) result.wrongTool += 1;

      // The model used what it needed and was offered; a missing tool is a turn spent asking or failing.
      usedLastTurn = turn.needs.filter((tool) => active.includes(tool));
      current = mode === "all" ? undefined : active;
      previousTools = toolKey;
      historyTokens += tokensOf(turn.text) + ASSUMED.replyTokens;
      cachedPrefix = prompt + ASSUMED.replyTokens;
    }
  }
  return result;
}

describe("tool disclosure economics (offline estimate)", () => {
  const sizes = toolCatalogue();
  const results = new Map<Mode, ModeResult>();

  beforeAll(async () => {
    for (const mode of ["all", "progressive", "per-turn"] as const) results.set(mode, await simulate(mode, ECONOMICS_CORPUS, sizes));
    const all = results.get("all");
    const rows = [...results.entries()].map(([mode, result]) => ({
      mode,
      turns: result.turns,
      "schema tok/turn": Math.round(result.schemaTokens / result.turns),
      "cache write": result.cacheWrite,
      "cache read": result.cacheRead,
      uncached: result.uncached,
      "tool-set changes": result.toolChanges,
      "cost USD": Number(result.costUsd.toFixed(4)),
      "vs all": all === undefined ? "" : `${(((result.costUsd - all.costUsd) / all.costUsd) * 100).toFixed(1)}%`,
      "wrong-tool turns": `${String(result.wrongTool)}/${String(result.turns)}`,
    }));
    const familyTokens = Object.entries(TOOL_FAMILIES).map(([family, entry]) => ({
      family,
      tokens: entry.tools.reduce((sum, tool) => sum + (sizes.get(tool) ?? 0), 0),
    }));
    const always = [...sizes.entries()].filter(([tool]) => familyOf(tool) === undefined).reduce((sum, [, tokens]) => sum + tokens, 0);
    console.log(
      `[context-economics] ${SAMPLE_NOTE}; ${String(sizes.size)} tools, ~${String([...sizes.values()].reduce((a, b) => a + b, 0))} schema tokens in all, ` +
        `~${String(always)} always offered; assumptions ${JSON.stringify(ASSUMED)}`,
    );
    console.table(familyTokens);
    console.table(rows);
  });

  it("reads a catalogue that holds every tool the planner names", () => {
    const named = [...CORE_TOOLS, ...Object.values(TOOL_FAMILIES).flatMap((family) => family.tools)];
    expect(named.filter((tool) => !sizes.has(tool))).toEqual([]);
  });

  it("never misses a tool when everything is offered", () => {
    expect(results.get("all")?.wrongTool).toBe(0);
    expect(results.get("all")?.toolChanges).toBe(0);
  });

  it("only ever offers registered tools, keeps the core, and only grows within a session", () => {
    for (const result of results.values()) expect(result.violations).toEqual([]);
  });
});

describe("recap relevance (offline)", () => {
  let dir: string;
  let db: Database;
  const PRINCIPAL = "prin_owner";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-context-economics-"));
    db = openDatabase({ path: join(dir, "node.sqlite") });
    migrate(db);
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports whether each recap carries the decision a fresh session needs", async () => {
    const rows: Record<string, string | number>[] = [];
    for (const recapCase of RECAP_CASES) {
      const messages: RecapMessage[] = recapCase.messages.map((message, index) => ({
        ...message,
        messageId: `${recapCase.id}_${String(index)}`,
      }));
      for (const message of messages) {
        seedMessage(db, {
          messageId: message.messageId ?? "",
          role: message.role,
          text: message.text,
          principalId: PRINCIPAL,
          conversationId: recapCase.id,
          createdAt: "2026-10-04T08:00:00.000Z",
        });
      }
      const decision = recapCase.messages[recapCase.decisionIndex]?.text ?? "";
      const latest = messages.slice(-40);
      const { earlier } = await earlierMessagesFor(
        { db },
        {
          principalId: PRINCIPAL,
          conversationId: recapCase.id,
          query: recapCase.question,
          exclude: new Set(recapWindow(latest).map((message) => message.messageId ?? "")),
        },
      );
      const recaps = {
        // What shipped before: the first forty messages read, the last twelve of those recapped.
        "first-40": legacyRecap(messages.slice(0, 40)),
        "latest-12": legacyRecap(latest),
        // The recap and the earlier messages it hands over as data, together: both reach the model.
        planned: (() => {
          const planned = planRecap({ messages: latest, query: recapCase.question, earlier, total: messages.length });
          return [planned.text, planned.earlier].filter((part) => part !== "").join("\n\n");
        })(),
      };
      const row: Record<string, string | number> = { case: recapCase.id, messages: messages.length };
      for (const [name, text] of Object.entries(recaps)) row[name] = `${text.includes(decision) ? "yes" : "no"} (${String(tokensOf(text))} tok)`;
      rows.push(row);
      // The planned recap keeps the newest messages whatever it adds: the newest is always there whole.
      expect(recaps.planned).toContain(messages.at(-1)?.text ?? "");
      // And it never loses what the fixed recap had.
      if (recaps["latest-12"].includes(decision)) expect(recaps.planned).toContain(decision);
    }
    console.log(`[context-economics] ${SAMPLE_NOTE}; does the recap carry the labelled decision?`);
    console.table(rows);
  });
});

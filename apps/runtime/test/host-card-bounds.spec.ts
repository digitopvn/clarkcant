import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CapabilityRef,
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type ExecutionPolicyConfig,
  type Instant,
  type MessageBlock,
  messageBlockSchema,
} from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, registerCapability, writeRegisteredPreference } from "@clarkcant/core";
import { type Database, migrate, openDatabase } from "@clarkcant/storage";

import { invokeCapability } from "../src/application/capability-invoke.ts";
import { createAskUserQuestionTool } from "../src/ask-user-question.ts";
import type { InteractionDeps } from "../src/interactions.ts";
import { createAskUserTool, createRunCommandTool } from "../src/node-tools.ts";
import { ownedResources, preflightCommand } from "../src/preflight.ts";
import { createRequestSecretTool } from "../src/request-secret.ts";
import { runGuardedCommand } from "../src/run-command.ts";
import type { ServiceHost } from "../src/service-host.ts";

/**
 * Every host card a tool builds from model input must satisfy its own contract.
 *
 * The conductor strict-parses each host card a tool hands back and leaves out one that fails, so a value one character
 * past a bound costs the person the whole card: the question they were meant to answer, the form for a secret, the
 * approval for a command. These tests run the real tools and builders on input at and past each bound and parse what
 * they build with the schema the conductor uses. A value that is only read is shortened between characters with an
 * ellipsis; a value that is sent back — an option, a secret's name, its consumers, a command — is refused at the tool
 * with a reason the model can act on, and no card is built.
 */

const AT = "2026-10-03T10:00:00.000Z" as Instant;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

let dir: string;
let db: Database;
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-host-card-bounds-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
  counter = 0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${String(counter)}`;
}

/** Parses a card the way the conductor does, failing with the issues rather than a bare `false`. */
function expectValidCard(card: Record<string, unknown> | undefined): MessageBlock {
  expect(card).toBeDefined();
  const parsed = messageBlockSchema.safeParse(card);
  expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  if (!parsed.success) throw new Error("unreachable");
  return parsed.data;
}

type ToolAnswer = { text: string; hostCard?: Record<string, unknown>; hostBlocks?: Record<string, unknown>[] };

describe("the question and form cards ask_user builds", () => {
  const ask = async (params: Record<string, unknown>): Promise<ToolAnswer> =>
    (await createAskUserTool(newId, () => AT).execute(params)) as ToolAnswer;

  it("builds a question card the contract accepts, waiting for an answer", async () => {
    const answer = await ask({ question: "Dùng môi trường nào?", options: [{ label: "staging" }, { label: "production", detail: "thật" }] });
    const card = expectValidCard(answer.hostCard);
    expect(card).toMatchObject({
      type: "question-card",
      questionType: "single-choice",
      prompt: "Dùng môi trường nào?",
      status: "waiting",
      allowOther: false,
      options: [
        { id: "option-1", label: "staging" },
        { id: "option-2", label: "production", description: "thật" },
      ],
    });
  });

  it("parses at every bound, and shortens the details and the spoken form that are only read", async () => {
    const options = Array.from({ length: 6 }, (_, index) => ({
      label: `${String(index)}${"l".repeat(199)}`,
      detail: "d".repeat(900),
    }));
    const answer = await ask({ question: "q".repeat(500), options });
    const card = expectValidCard(answer.hostCard);
    if (card.type !== "question-card") throw new Error("expected a question card");
    expect(card.prompt).toHaveLength(500);
    expect(card.options.map((option) => option.label)).toEqual(options.map((option) => option.label));
    expect(card.options[0]?.description).toBe(`${"d".repeat(499)}…`);
    // Six long labels say more than the card can hold out loud; the end of the list is what is cut.
    expect(card.voicePrompt).toHaveLength(500);
    expect(card.voicePrompt.endsWith("…")).toBe(true);
  });

  it("shortens a detail between characters, never inside one", async () => {
    const answer = await ask({ question: "Chọn một", options: [{ label: "a", detail: "😀".repeat(300) }, { label: "b" }] });
    const card = expectValidCard(answer.hostCard);
    if (card.type !== "question-card") throw new Error("expected a question card");
    expect(card.options[0]?.description).toBe(`${"😀".repeat(249)}…`);
    expect(LONE_SURROGATE.test(card.options[0]?.description ?? "")).toBe(false);
  });

  it("refuses a question or a label past its bound, naming it, rather than building a card that is dropped", async () => {
    const long = await ask({ question: "q".repeat(501), options: [{ label: "a" }, { label: "b" }] });
    expect(long.hostCard).toBeUndefined();
    expect(long.text).toContain("question");
    expect(long.text).toContain("500");

    const label = await ask({ question: "Chọn một", options: [{ label: "a" }, { label: "l".repeat(201) }] });
    expect(label.hostCard).toBeUndefined();
    expect(label.text).toContain("options.1.label");
    expect(label.text).toContain("200");
  });

  it("offers a repeated label once, and refuses more answers than a question offers", async () => {
    const repeated = await ask({ question: "Chọn một", options: [{ label: "a" }, { label: "a" }, { label: "b" }] });
    const card = expectValidCard(repeated.hostCard);
    if (card.type !== "question-card") throw new Error("expected a question card");
    expect(card.options.map((option) => option.label)).toEqual(["a", "b"]);

    const onlyOne = await ask({ question: "Chọn một", options: [{ label: "a" }, { label: "a" }] });
    expect(onlyOne.hostCard).toBeUndefined();

    const seven = await ask({ question: "Chọn một", options: Array.from({ length: 7 }, (_, index) => ({ label: String(index) })) });
    expect(seven.hostCard).toBeUndefined();
    expect(seven.text).toContain("tối đa 6");
  });

  it("builds a form at every bound, shortening the title, labels and placeholders that are only read", async () => {
    const fields = Array.from({ length: 12 }, (_, index) => ({
      label: `${String(index)}${"l".repeat(300)}`,
      kind: "select",
      options: [...Array.from({ length: 20 }, (_, choice) => `${String(choice)}${"c".repeat(198)}`), "0".concat("c".repeat(198))],
      placeholder: "p".repeat(300),
    }));
    const answer = await ask({ question: "q", title: "t".repeat(400), fields });
    const card = expectValidCard(answer.hostCard);
    if (card.type !== "form-card") throw new Error("expected a form card");
    expect(card.title).toBe(`${"t".repeat(299)}…`);
    expect(card.fields).toHaveLength(12);
    expect(card.fields[0]?.label).toHaveLength(200);
    expect(card.fields[0]?.placeholder).toBe(`${"p".repeat(199)}…`);
    // The repeated choice is offered once, and each choice is the value sent back, whole.
    expect(card.fields[0]?.options).toHaveLength(20);
    expect(card.fields[0]?.options?.[0]).toBe(`0${"c".repeat(198)}`);
  });

  it("refuses a form past a bound it cannot shorten, rather than building a card that is dropped", async () => {
    const thirteen = await ask({ question: "q", fields: Array.from({ length: 13 }, (_, index) => ({ label: String(index) })) });
    expect(thirteen.hostCard).toBeUndefined();
    expect(thirteen.text).toContain("tối đa 12");

    const manyChoices = await ask({
      question: "q",
      fields: [{ label: "Màu", kind: "select", options: Array.from({ length: 21 }, (_, index) => String(index)) }],
    });
    expect(manyChoices.hostCard).toBeUndefined();
    expect(manyChoices.text).toContain("tối đa 20");

    const longChoice = await ask({ question: "q", fields: [{ label: "Màu", kind: "select", options: ["c".repeat(201)] }] });
    expect(longChoice.hostCard).toBeUndefined();
    expect(longChoice.text).toContain("200");

    const untitled = await ask({ fields: [{ label: "Tên" }] });
    expect(untitled.hostCard).toBeUndefined();
  });
});

describe("the question card ask_user_question records", () => {
  function interactions(): { deps: InteractionDeps; appended: MessageBlock[] } {
    const appended: MessageBlock[] = [];
    return {
      appended,
      deps: {
        conversationId: "conv_bounds",
        now: () => AT,
        newId,
        blocks: () => appended,
        append: ({ blocks }) => appended.push(...blocks),
      },
    };
  }

  it("parses with the longest question and the most options, shortening only what it says out loud", async () => {
    const { deps, appended } = interactions();
    const options = Array.from({ length: 8 }, (_, index) => ({ id: `o${String(index)}`, label: `${String(index)}${"l".repeat(199)}` }));
    const answer = (await createAskUserQuestionTool(deps).execute({ question: "q".repeat(500), kind: "multi-choice", options })) as ToolAnswer;
    const [card] = answer.hostBlocks ?? [];
    const parsed = expectValidCard(card);
    if (parsed.type !== "question-card") throw new Error("expected a question card");
    expect(parsed.voicePrompt).toHaveLength(500);
    // The card the transcript keeps is the same one.
    expect(appended).toEqual([card]);
  });
});

describe("the credential card request_secret builds", () => {
  const request = async (params: Record<string, unknown>): Promise<ToolAnswer> =>
    (await createRequestSecretTool({ db, principalId: "owner_1", newId, now: () => AT, nodeId: "node_local" }).execute(
      params,
    )) as ToolAnswer;

  it("parses at every bound, shortening the label, the purpose and the description that are only read", async () => {
    const consumers = Array.from({ length: 10 }, (_, index) => `command:${String(index)}${"x".repeat(9)}`);
    const consumer = consumers.join(",");
    expect(consumer.length).toBeLessThanOrEqual(200);
    const answer = await request({
      name: "n".repeat(120),
      label: "l".repeat(400),
      description: "d".repeat(1500),
      consumer: `${consumer}, ${consumers[0] ?? ""}`,
    });
    const card = expectValidCard(answer.hostCard);
    if (card.type !== "credential-card") throw new Error("expected a credential card");
    expect(card.fields[0]?.name).toBe("n".repeat(120));
    expect(card.fields[0]?.label).toBe(`${"l".repeat(199)}…`);
    expect(card.purpose).toBe(`${"d".repeat(999)}…`);
    expect(card.description).toBe(card.purpose);
    // Listed once each, as the node records them.
    expect(card.consumer).toBe(consumer);
  });

  it("shortens a purpose built from a long label", async () => {
    const answer = await request({ name: "token", label: "😀".repeat(600) });
    const card = expectValidCard(answer.hostCard);
    if (card.type !== "credential-card") throw new Error("expected a credential card");
    expect(card.purpose.length).toBeLessThanOrEqual(1000);
    expect(LONE_SURROGATE.test(card.purpose)).toBe(false);
    expect(LONE_SURROGATE.test(card.fields[0]?.label ?? "")).toBe(false);
  });

  it("refuses a name or consumers the card cannot carry whole, because the form sends them back", async () => {
    const name = await request({ name: "n".repeat(121), label: "x", description: "x" });
    expect(name.hostCard).toBeUndefined();
    expect(name.text).toContain("120");

    const many = await request({
      name: "token",
      label: "x",
      description: "x",
      consumer: Array.from({ length: 11 }, (_, index) => `command:c${String(index)}`).join(","),
    });
    expect(many.hostCard).toBeUndefined();
    expect(many.text).toContain("tối đa 10");

    const long = await request({ name: "token", label: "x", description: "x", consumer: `command:${"c".repeat(200)}` });
    expect(long.hostCard).toBeUndefined();
    expect(long.text).toContain("200");
  });
});

describe("the cards run_command builds", () => {
  let work: string;

  beforeEach(() => {
    work = join(dir, "work");
    mkdirSync(work, { recursive: true });
  });

  function runCommandTool(mode: ExecutionPolicyConfig["mode"]): ReturnType<typeof createRunCommandTool> {
    const policy: ExecutionPolicyConfig = {
      ...DEFAULT_EXECUTION_POLICY_CONFIG,
      mode,
      guardrails: { ...DEFAULT_EXECUTION_POLICY_CONFIG.guardrails, enabled: false },
    };
    return createRunCommandTool({
      approvals: () => ({ db, nodeId: "node_local", now: () => AT, newId }),
      autonomy: () => policy,
      resources: () => ownedResources([work]),
      fallbackCwd: () => work,
      guardrails: async () => ({ status: "allow" }),
      narrowing: [],
      newId: () => "run_bounds",
      run: async () => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, timedOut: false }),
    });
  }

  function approvalCount(): number {
    return (db.prepare("SELECT COUNT(*) AS count FROM approvals").get() as { count: number }).count;
  }

  it("records a run with a long reason in blocks that parse, the reason shortened in the line a reader sees", async () => {
    const answer = (await runCommandTool("autonomous").execute({ command: "pnpm build", why: "w".repeat(5000) })) as ToolAnswer;
    const blocks = (answer.hostBlocks ?? []).map(expectValidCard);
    expect(blocks.map((block) => block.type)).toEqual(["tool-activity", "evidence"]);
    const [activity] = blocks;
    if (activity?.type !== "tool-activity") throw new Error("expected a tool-activity block");
    expect(activity.label).toHaveLength(300);
    expect(activity.label.endsWith("…")).toBe(true);
    expect(activity.args).toMatchObject({ command: "pnpm build", cwd: work });
  });

  it("shows a folder too long for the card by its end, and keeps it whole in the record", async () => {
    const preflight = preflightCommand({ command: "pnpm build", cwd: work, resources: ownedResources([work]) });
    if (!preflight.ok || preflight.envelope.kind !== "command") throw new Error("the preflight refused a plain command");
    const cwd = join(work, ...Array.from({ length: 30 }, (_, index) => `${String(index)}${"f".repeat(49)}`));
    const ran = await runGuardedCommand({
      operationId: "op_bounds",
      envelope: { ...preflight.envelope, cwd },
      run: async () => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, timedOut: false }),
      now: () => AT,
    });
    const [activity] = ran.blocks.map((block) => expectValidCard(block as unknown as Record<string, unknown>));
    if (activity?.type !== "tool-activity") throw new Error("expected a tool-activity block");
    expect(activity.path?.startsWith("…")).toBe(true);
    expect(activity.path?.length).toBe(1000);
    expect(activity.path?.endsWith(`29${"f".repeat(49)}`)).toBe(true);
    expect(activity.args["cwd"]).toBe(cwd);
  });

  it("asks with an approval card that parses, the longest command whole and a long reason shortened", async () => {
    const command = `pnpm build --filter ${"a".repeat(1980)}`;
    expect(command).toHaveLength(2000);
    const answer = (await runCommandTool("ask").execute({ command, why: "w".repeat(5000) })) as ToolAnswer;
    const card = expectValidCard(answer.hostCard);
    if (card.type !== "approval-card") throw new Error("expected an approval card");
    expect(card.operationDescription).toHaveLength(2000);
    expect(card.operationDescription.endsWith("…")).toBe(true);
    expect(JSON.parse(card.payload ?? "{}")).toMatchObject({ command, cwd: work });
    // The approval on record says what the card says.
    const stored = db.prepare("SELECT operation_description FROM approvals WHERE approval_id = ?").get(card.approvalId) as {
      operation_description: string;
    };
    expect(stored.operation_description).toBe(card.operationDescription);
  });

  it("refuses a command whose payload is too long for the card, before any approval exists, and runs nothing", async () => {
    // Within the command's own limit, but each quote is two characters once written into the payload.
    const command = `pnpm build --filter "${'\\"'.repeat(980)}"`;
    expect(command.length).toBeLessThanOrEqual(2000);
    const answer = (await runCommandTool("ask").execute({ command })) as ToolAnswer;
    expect(answer.hostCard).toBeUndefined();
    expect(answer.text).toContain("4000");
    expect(answer.text).toContain("Không có gì được chạy");
    expect(approvalCount()).toBe(0);
  });
});

describe("the approval card a capability call builds", () => {
  const PACKAGE = "com.example.bounds";
  const GENERATION = `${PACKAGE}@1.0.0:code_1`;
  // The longest ref the contract allows, with the longest summary, for the description the card shows.
  const REF = `com.${"x".repeat(154)}@1` as CapabilityRef;

  function arrange(): void {
    expect(REF).toHaveLength(160);
    registerCapability(
      { db, nodeId: "node_local" },
      {
        ref: REF,
        providedBy: { packageId: PACKAGE, version: "1.0.0", digest: "sha256:bounds", generation: GENERATION },
        executionNodeId: "node_local",
        summary: "s".repeat(400),
        resourceKinds: [],
        effectCategory: "local-write",
        supportsCancellation: false,
        requiresConnection: false,
        readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
        uiAffordances: [],
      },
    );
    const written = writeRegisteredPreference(
      { db, now: () => AT },
      {
        principalId: "owner_1",
        key: EXECUTION_POLICY_PREFERENCE_KEY,
        value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "ask" },
        source: "user",
      },
    );
    if (!written.ok) throw new Error(written.message);
  }

  // Only what `invokeCapability` reads before it asks: which package serves the ref, at which generation.
  const host = { serves: () => ({ packageId: PACKAGE, generationId: GENERATION }) } as unknown as ServiceHost;

  async function call(text: string) {
    return await invokeCapability(
      { db, nodeId: "node_local", principalId: "owner_1", newId, now: () => AT, serviceHost: host },
      { ref: REF, args: { text }, source: "agent" },
    );
  }

  /** The `text` that makes the card's payload exactly `length` characters. */
  function textForPayload(length: number): string {
    const base = JSON.stringify({
      kind: "capability",
      capabilityRef: REF,
      args: { text: "" },
      source: "agent",
      generation: GENERATION,
      effectCategory: "local-write",
    }).length;
    return "t".repeat(length - base);
  }

  it("parses with the longest summary and ref, and a payload at the card's bound", async () => {
    arrange();
    const asked = await call(textForPayload(4000));
    if (asked.kind !== "approval-required") throw new Error(`expected a card, got ${JSON.stringify(asked)}`);
    const card = expectValidCard(asked.card);
    if (card.type !== "approval-card") throw new Error("expected an approval card");
    expect(card.payload).toHaveLength(4000);
  });

  it("refuses arguments one character past the payload's bound, saying why, and asks nothing", async () => {
    arrange();
    const refused = await call(textForPayload(4001));
    expect(refused).toMatchObject({ kind: "refused", code: "APPROVAL_UNAVAILABLE" });
    if (refused.kind !== "refused") throw new Error("unreachable");
    expect(refused.message).toContain("too large to show on an approval card");
    expect((db.prepare("SELECT COUNT(*) AS count FROM approvals").get() as { count: number }).count).toBe(0);
  });
});

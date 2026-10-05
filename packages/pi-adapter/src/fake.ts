import { createHash } from "node:crypto";

import type { Instant } from "@clarkcant/contracts";

import { guardToolResult } from "./tool-result-guard.ts";

import type {
  ModelSwitch,
  ModelCatalogue,
  PiExtension,
  PiSetting,
  PiSkill,
  PiSkillBody,
  PiAdapter,
  ProviderAuthEntry,
  ProviderSignInInteraction,
  ProviderSignInMethod,
  ResourceRefreshRequest,
  ToolDefinition,
  WorkerBrief,
  WorkerEvent,
  WorkerSessionHandle,
} from "./types.ts";

/**
 * One scripted turn: either the model's own words, or a tool call the model decides to make before
 * replying. A worker session's tools arrive with `WorkerBrief.customTools`, active, as on the real
 * adapter, and `setActiveTools` narrows the created ones, so this is the seam by which a scripted
 * prompt can exercise a tool the worker really registered:
 * `run()` calls it through the same `callToolResult` path a live agent loop would use, which means the
 * call is observed by every subscriber exactly like a real tool call, including the `tool-start`/
 * `tool-end` events the worker's evidence collection depends on.
 */
export type ScriptedTurn =
  | string
  | {
      /** The tool to call before the reply, exactly as the worker registered it. */
      callTool: ScriptedToolCall;
      /** The words that follow the call. Defaults to a generic scripted reply. */
      reply?: string;
    }
  | {
      /**
       * Several calls in one turn, in order, the way a model edits, tests, commits and pushes before it answers. A call
       * that throws ends the turn there, as a model that reads a failure stops rather than carrying on regardless.
       */
      callTools: ScriptedToolCall[];
      reply?: string;
    };

/** A skill the fake offers: what a listing shows, plus the instructions a turn that names it is given. */
export interface FakeSkill {
  name: string;
  description: string;
  source: PiSkill["source"];
  body: string;
}

/** Two skills from different places, so a picker has more than one row and more than one source to show. */
export const DEFAULT_FAKE_SKILLS: readonly FakeSkill[] = [
  {
    name: "release-notes",
    description: "Viết ghi chú phát hành từ các thay đổi gần đây.",
    source: "project",
    body: "Gom các thay đổi gần đây thành ghi chú phát hành ngắn, nhóm theo tính năng, sửa lỗi và việc còn lại.",
  },
  {
    name: "review",
    description: "Đọc một thay đổi và chỉ ra lỗi có thật trước khi gộp.",
    source: "personal",
    body: "Đọc thay đổi được chỉ tới. Chỉ nêu lỗi có bằng chứng, xếp theo mức nghiêm trọng.",
  },
];

export interface ScriptedToolCall {
  name: string;
  params: Record<string, unknown>;
}

/**
 * Deterministic in-process adapter.
 *
 * Exists so the whole application can be exercised end to end without a provider
 * account: CI, conformance tests and local development all run against this.
 *
 * It is deliberately honest about what it is. It emits the same event shapes the
 * real adapter does, and it never claims to have inferred anything. Anything that
 * would require a model returns a scripted answer that says so.
 */
export class FakePiAdapter implements PiAdapter {
  readonly #sessions = new Map<
    string,
    {
      handle: WorkerSessionHandle;
      brief: WorkerBrief;
      tools: Map<string, ToolDefinition>;
      activeTools: string[];
      listeners: Set<(event: WorkerEvent) => void>;
      script: ScriptedTurn[];
      disposed: boolean;
      turns: number;
      tokens: number;
      /**
       * Every prompt this session was given, in order.
       *
       * A seam of the test double, not behaviour of the adapter. It exists because some properties can
       * only be observed at this boundary: what the model was actually told, and — more importantly —
       * what it was not. "The prompt names the attachment and no disk path" has no other place to be
       * checked, since the composer's fixture output runs before the turn and never sees the prompt.
       */
      prompts: string[];
    }
  >();

  #counter = 0;
  #aborted = new Set<string>();
  /** Sessions answering a prompt right now. */
  #processing = new Set<string>();
  /** Sessions whose run has made its last check for steered messages and is only settling now. */
  #pastLastCheck = new Set<string>();
  /** Steered messages a run did not take, per session, oldest first. */
  #queued = new Map<string, string[]>();
  #holds = new Map<string, { held: Promise<void>; reached: () => void }>();
  readonly #options: { script?: ScriptedTurn[]; now?: () => Instant };

  #skills: readonly FakeSkill[];

  constructor(options: { script?: ScriptedTurn[]; now?: () => Instant; skills?: readonly FakeSkill[] } = {}) {
    // Assigned rather than declared as a constructor parameter property, because Node's
    // type-stripping loader cannot execute that syntax (enforced by `pnpm invariants`).
    this.#options = options;
    this.#skills = options.skills ?? DEFAULT_FAKE_SKILLS;
  }

  /**
   * Replace the skills this fake offers. A seam of the test double: it is how a test edits or removes a skill between
   * a person choosing it and the message being sent, which is the case the revision exists for.
   */
  setSkills(skills: readonly FakeSkill[]): void {
    this.#skills = skills;
  }

  async availability(): Promise<{ available: boolean; reason?: string; sdkVersion?: string }> {
    return { available: true, sdkVersion: "fake-1.0.0" };
  }

  /**
   * A scripted catalogue, deliberately wider than one provider with one model.
   *
   * The real one is read from the SDK's own list; this exists so the routes and the chooser can be exercised without a
   * provider account. A chooser that only ever saw a single row would never exercise the grouping, and a catalogue
   * with only one model could never show the current one being marked among others.
   */
  async catalogue(): Promise<ModelCatalogue> {
    return [
      {
        id: "fake",
        models: [
          { provider: "fake", id: "fake-model", current: true },
          { provider: "fake", id: "fake-model-large", contextWindow: 500_000, current: false },
        ],
      },
      {
        id: "fake-other",
        models: [{ provider: "fake-other", id: "fake-other-model", current: false }],
      },
    ];
  }

  /**
   * Who is signed in, per provider. `fake` is signed in from the environment, so it cannot be signed out of here;
   * `fake-other` starts signed out and offers both ways in, so a sign-in card has each kind of row to draw.
   */
  readonly #signedIn = new Map<string, ProviderAuthEntry["source"]>([["fake", "environment"]]);

  async providerAuth(): Promise<readonly ProviderAuthEntry[]> {
    const entry = (providerId: string, name: string, oauth: boolean): ProviderAuthEntry => {
      const source = this.#signedIn.get(providerId);
      return {
        providerId,
        name,
        ...(oauth ? { oauth: { label: `${name} account`, subscription: true } } : {}),
        apiKey: true,
        configured: source !== undefined,
        ...(source === undefined ? {} : { source }),
      };
    };
    return [entry("fake", "Fake", false), entry("fake-other", "Fake Other", true)];
  }

  /**
   * A sign-in that asks what the real ones ask: a page to open and the code it shows, or a key. Any non-empty answer
   * signs in, because there is no provider to check it against; it is never kept.
   */
  async signIn(providerId: string, method: ProviderSignInMethod, interaction: ProviderSignInInteraction): Promise<void> {
    if (providerId !== "fake" && providerId !== "fake-other") throw new Error(`no provider "${providerId}"`);
    if (method === "oauth") {
      interaction.notify({ type: "auth_url", url: "https://example.invalid/fake-sign-in", instructions: "Open the page and copy the code it shows." });
    }
    const answer = await interaction.prompt(
      method === "oauth" ? { type: "manual_code", message: "Paste the code from the sign-in page" } : { type: "secret", message: "API key" },
    );
    interaction.signal.throwIfAborted();
    if (answer.trim() === "") throw new Error("nothing was entered");
    this.#signedIn.set(providerId, "stored");
  }

  async signOut(providerId: string): Promise<void> {
    if (this.#signedIn.get(providerId) === "stored") this.#signedIn.delete(providerId);
  }

  /** A scripted list, including both kinds, so a section rendering them has both to render. */
  async extensions(): Promise<readonly PiExtension[]> {
    return [
      { name: "fake-extension", kind: "directory" },
      { name: "fake-hook.ts", kind: "file" },
    ];
  }

  /** A scripted configuration, including a redacted entry so a panel rendering one has one to render. */
  async piSettings(): Promise<readonly PiSetting[]> {
    return [
      { key: "defaultModel", value: "fake-model" },
      { key: "providerApiKey", value: "[redacted]" },
    ];
  }

  async skills(): Promise<readonly PiSkill[]> {
    return [...this.#skills]
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        source: skill.source,
        revision: fakeSkillRevision(skill),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async skillBody(name: string, revision: string): Promise<PiSkillBody> {
    const skill = this.#skills.find((candidate) => candidate.name === name);
    if (skill === undefined) return { ok: false, reason: "missing" };
    if (fakeSkillRevision(skill) !== revision) return { ok: false, reason: "changed" };
    return { ok: true, name, body: skill.body };
  }

  async createWorkerSession(brief: WorkerBrief): Promise<WorkerSessionHandle> {
    this.#counter += 1;
    const sessionId = `fake-session-${this.#counter}`;
    const handle: WorkerSessionHandle = {
      sessionId,
      sessionFile: undefined,
      createdAt: (this.#options.now ?? (() => new Date().toISOString() as Instant))(),
    };
    this.#sessions.set(sessionId, {
      handle,
      brief,
      // The tools a session is created with are registered with it and active, as the real adapter's are; a script can
      // call one until `setActiveTools` narrows it away.
      // Each wrapped in the brief's result guard exactly as the real adapter wraps them, so a test drives the one path.
      tools: new Map((brief.customTools ?? []).map((tool) => [tool.name, guardToolResult(tool, brief.toolResultGuard)])),
      activeTools: [...new Set((brief.customTools ?? []).map((tool) => tool.name))],
      listeners: new Set(),
      script: this.#options.script ?? [],
      disposed: false,
      turns: 0,
      tokens: 0,
      prompts: [],
    });
    return handle;
  }

  async setActiveTools(sessionId: string, toolNames: readonly string[]): Promise<void> {
    const session = this.#require(sessionId);
    // Only what the session was created with can become active, as on the real adapter: a test that activates a
    // name nobody created would otherwise pass here and fail against the SDK.
    session.activeTools = [...new Set(toolNames)].filter((name) => session.tools.has(name));
  }

  /** Test-only: the tools a session currently offers, in the order they were activated. */
  activeToolNames(sessionId: string): readonly string[] {
    return [...this.#require(sessionId).activeTools];
  }

  async refreshResources(
    sessionId: string,
    request: ResourceRefreshRequest,
  ): Promise<{ applied: ResourceRefreshRequest["scope"]; note: string }> {
    this.#require(sessionId);
    return {
      applied: request.scope,
      note: `fake adapter applied ${request.scope} refresh in place for: ${request.reason}`,
    };
  }

  async handoff(sessionId: string, brief: WorkerBrief): Promise<{ successor: WorkerSessionHandle; note: string }> {
    const previous = this.#require(sessionId);
    const successor = await this.createWorkerSession(brief);
    return {
      successor,
      note: `successor session created after ${previous.brief.goal.length} characters of prior brief; task identity is preserved by the caller`,
    };
  }

  /** Every in-place model change a session accepted, in order, so a test can tell a switch from a successor. */
  readonly modelSwitches: { sessionId: string; selection: ModelSwitch }[] = [];

  async switchModel(sessionId: string, selection: ModelSwitch): Promise<void> {
    const session = this.#require(sessionId);
    if (this.#processing.has(sessionId) || this.hasQueuedMessages(sessionId)) {
      throw new Error("a session's model can only change between runs; this one is still running or holds a queued message");
    }
    const { model, thinkingLevel } = selection;
    session.brief = {
      ...session.brief,
      ...(model === undefined ? {} : { model: { ...model } }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    };
    this.modelSwitches.push({ sessionId, selection: { ...selection } });
  }

  subscribe(sessionId: string, listener: (event: WorkerEvent) => void): () => void {
    const session = this.#require(sessionId);
    if (session.listeners.has(listener)) {
      throw new Error("the same listener was subscribed twice; this would duplicate every event");
    }
    session.listeners.add(listener);
    return () => {
      session.listeners.delete(listener);
    };
  }

  /**
   * As Pi does: a steer that reaches a run still taking messages is answered inside it, and one that arrives after the
   * run's last check (or when no run is going) is queued until `continueQueued` runs the session on it.
   */
  async steer(sessionId: string, text: string): Promise<void> {
    this.#require(sessionId);
    if (this.#processing.has(sessionId) && !this.#pastLastCheck.has(sessionId)) {
      this.#emit(sessionId, { type: "text-delta", sessionId, delta: `[steered: ${text}] ` });
      return;
    }
    this.#queued.set(sessionId, [...(this.#queued.get(sessionId) ?? []), text]);
  }

  hasQueuedMessages(sessionId: string): boolean {
    this.#require(sessionId);
    return (this.#queued.get(sessionId) ?? []).length > 0;
  }

  async continueQueued(sessionId: string): Promise<void> {
    this.#require(sessionId);
    const queued = this.#queued.get(sessionId) ?? [];
    if (queued.length === 0) return;
    this.#queued.delete(sessionId);
    await this.#answer(sessionId, async () => {
      for (const text of queued) this.#emit(sessionId, { type: "text-delta", sessionId, delta: `[steered: ${text}] ` });
      await this.run(sessionId, queued.join("\n"));
    });
  }

  /**
   * Test-only: hold the session's next run just after its last check for steered messages, so a test can land a steer
   * in the window where Pi would queue it rather than answer it. Resolve the returned function to let the run settle.
   */
  holdAfterLastCheck(sessionId: string): { reached: Promise<void>; release: () => void } {
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = () => undefined as void;
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });
    this.#holds.set(sessionId, { held, reached });
    return { reached: reachedPromise, release };
  }

  async abort(sessionId: string, reason: string): Promise<void> {
    this.#require(sessionId);
    this.#aborted.add(sessionId);
    this.#emit(sessionId, { type: "text-delta", sessionId, delta: `[aborted: ${reason}]` });
  }

  async dispose(sessionId: string): Promise<void> {
    const session = this.#require(sessionId);
    session.disposed = true;
    // Listeners must be released on dispose; keeping them would leak into the next
    // session and produce exactly the duplicate-handler failure T25 describes.
    session.listeners.clear();
    this.#queued.delete(sessionId);
    this.#holds.delete(sessionId);
    this.#sessions.delete(sessionId);
  }

  usage(sessionId: string): { turns: number; tokens?: number } {
    const session = this.#require(sessionId);
    return { turns: session.turns, tokens: session.tokens };
  }

  /**
   * Satisfies the seam. Kept as a thin call so there is one implementation, not two.
   *
   * A session that is still answering refuses another prompt, as Pi's own session does ("Agent is already processing"):
   * a second message belongs in the running turn through `steer`, and a test must not pass on a path Pi does not allow.
   */
  async prompt(sessionId: string, text: string): Promise<void> {
    this.#require(sessionId);
    await this.#answer(sessionId, () => this.run(sessionId, text).then(() => undefined));
  }

  async #answer(sessionId: string, body: () => Promise<void>): Promise<void> {
    if (this.#processing.has(sessionId)) {
      throw new Error("Agent is already processing. Use steer() to add a message to the running turn.");
    }
    this.#processing.add(sessionId);
    try {
      await body();
      const hold = this.#holds.get(sessionId);
      if (hold !== undefined) {
        this.#holds.delete(sessionId);
        this.#pastLastCheck.add(sessionId);
        hold.reached();
        await hold.held;
      }
    } finally {
      this.#processing.delete(sessionId);
      this.#pastLastCheck.delete(sessionId);
    }
  }

  /** Test-only driver: whether a session is answering a prompt right now. */
  isProcessing(sessionId: string): boolean {
    return this.#processing.has(sessionId);
  }

  /** Test-only driver: the prompts a session has been given, oldest first. */
  promptsFor(sessionId: string): readonly string[] {
    // An unknown session answers with nothing rather than throwing: a test asking "what was it told?"
    // about a session that was disposed is asking a question with an empty answer, not reporting a bug.
    return [...(this.#sessions.get(sessionId)?.prompts ?? [])];
  }

  /** Test-only driver: every prompt across every session, oldest session first. */
  allPrompts(): readonly string[] {
    return [...this.#sessions.values()].flatMap((session) => session.prompts);
  }

  /**
   * Test-only driver: run the scripted reply for a session.
   *
   * A scripted turn that names a tool call is played out through `callToolResult` before the reply is
   * emitted, so a prompt can exercise a tool the worker actually registered rather than only ever
   * producing text. A call whose tool is not registered or not active is not swallowed: it is let
   * through to `callToolResult`'s own refusal, because a script asking for a tool the brief withheld is
   * a fixture bug, not a scenario to hide.
   */
  async run(sessionId: string, prompt: string): Promise<string> {
    const session = this.#require(sessionId);
    session.prompts.push(prompt);
    const turn = session.script.shift();
    const hadToolCalls = typeof turn === "object";

    if (hadToolCalls) {
      for (const call of "callTools" in turn ? turn.callTools : [turn.callTool]) {
        await this.callToolResult(sessionId, call.name, call.params);
      }
    }
    const scripted = typeof turn === "string" ? turn : (turn?.reply ?? `scripted reply to: ${prompt}`);
    session.turns += 1;
    session.tokens += Math.ceil(scripted.length / 4);

    if (this.#aborted.has(sessionId)) {
      this.#emit(sessionId, { type: "settled", sessionId });
      return "";
    }

    for (const chunk of chunkText(scripted)) {
      this.#emit(sessionId, { type: "text-delta", sessionId, delta: chunk });
    }
    this.#emit(sessionId, { type: "turn-end", sessionId, hadToolCalls });
    this.#emit(sessionId, { type: "settled", sessionId });
    return scripted;
  }

  /** Test-only: run a registered tool the way the agent loop would, and answer with its text. */
  async callTool(sessionId: string, toolName: string, params: Record<string, unknown>): Promise<string> {
    return (await this.callToolResult(sessionId, toolName, params)).text;
  }

  /**
   * Test-only: the whole result of a tool call.
   *
   * `callTool` answers with the text, which is what most tests want. This one exists because a tool that
   * read a picture also returns the picture, and a test that only ever sees the text cannot tell that apart
   * from a tool that described the picture instead of handing it over.
   */
  async callToolResult(
    sessionId: string,
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<{ text: string; image?: { mimeType: string; dataBase64: string } }> {
    const session = this.#require(sessionId);
    if (!session.activeTools.includes(toolName)) {
      throw new Error(`tool ${toolName} is not active on ${sessionId}`);
    }
    const tool = session.tools.get(toolName);
    if (!tool) throw new Error(`tool ${toolName} is not registered on ${sessionId}`);
    this.#emit(sessionId, { type: "tool-start", sessionId, toolName, toolCallId: `call-${toolName}` });
    const result = await tool.execute(params);
    this.#emit(sessionId, {
      type: "tool-end",
      sessionId,
      toolName,
      toolCallId: `call-${toolName}`,
      isError: false,
    });
    return result;
  }

  listenerCount(sessionId: string): number {
    // Strict rather than `?? 0`: silently reporting zero for a disposed session would
    // hide exactly the stale-handler bug this method exists to detect.
    return this.#require(sessionId).listeners.size;
  }

  #require(sessionId: string) {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`unknown or disposed session ${sessionId}`);
    return session;
  }

  #emit(sessionId: string, event: WorkerEvent): void {
    for (const listener of this.#sessions.get(sessionId)?.listeners ?? []) {
      listener(event);
    }
  }
}

function chunkText(text: string, size = 12): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks.length > 0 ? chunks : [""];
}

/** The digest the fake reports for a skill: of everything a listing and a turn would see, so any edit changes it. */
export function fakeSkillRevision(skill: FakeSkill): string {
  return createHash("sha256").update(`${skill.name}\n${skill.description}\n${skill.body}`).digest("hex");
}

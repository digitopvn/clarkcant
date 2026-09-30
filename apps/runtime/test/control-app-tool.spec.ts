import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUILTIN_CLARK_THEME_REF, describeAppIntent } from "@clarkcant/contracts";
import { setPreference, type ModelTurnEvent } from "@clarkcant/core";

import type { ThemeRegistry } from "../src/application/themes.ts";
import { controlApp, controlAppRefusalSay, decideControlApp, type ControlAppDeps } from "../src/node-tools.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * `control_app`, the main agent's app-control tool.
 *
 * The properties worth pinning: it never claims success it cannot back up (`NO_ACTIVE_HOST_SURFACE` when
 * nothing is watching this turn), it validates against the same contract a click and a typed command use
 * (a bad tab or a missing alias is refused rather than guessed at), and every delivered request is
 * audited with `source: "agent"` so it can never be mistaken for something a person clicked.
 */

let dir: string;
let services: NodeServices;
let idCount = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-control-app-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

function deps(
  onEvent: () => ((event: ModelTurnEvent) => void) | undefined,
  channel: "voice" | "chat" = "chat",
): ControlAppDeps {
  return {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    now: () => "2026-09-23T00:00:00.000Z" as never,
    newId: (prefix: string) => `${prefix}_test${(idCount += 1)}`,
    principalId: services.runtime.identity.ownerPrincipalId,
    conversationId: "conv_test" as never,
    onEvent,
    channel: () => channel,
  };
}

describe("control_app", () => {
  it("refuses honestly when no foreground surface is watching this turn", () => {
    const result = decideControlApp(deps(() => undefined), { kind: "settings.open" });
    expect(result).toEqual({
      status: "refused",
      reason: "no-active-surface",
      say: expect.stringContaining("Không có màn hình") as unknown as string,
    });
  });

  it("delivers a host-control event and reports success once accepted", () => {
    const delivered: ModelTurnEvent[] = [];
    const result = decideControlApp(deps(() => (event) => delivered.push(event)), { kind: "nav.home" });
    expect(result.status).toBe("delivered");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ type: "host-control", decision: { kind: "intent", intent: { kind: "nav.home" } } });
  });

  it("refuses settings.tab with no tab, without delivering anything", () => {
    const delivered: ModelTurnEvent[] = [];
    const result = decideControlApp(deps(() => (event) => delivered.push(event)), { kind: "settings.tab" });
    expect(result.status).toBe("refused");
    expect(delivered).toHaveLength(0);
  });

  it("refuses model.select with no alias, without delivering anything", () => {
    const delivered: ModelTurnEvent[] = [];
    const result = decideControlApp(deps(() => (event) => delivered.push(event)), { kind: "model.select" });
    expect(result.status).toBe("refused");
    expect(delivered).toHaveLength(0);
  });

  it("delivers model.select carrying the requested alias", () => {
    const delivered: ModelTurnEvent[] = [];
    const result = decideControlApp(deps(() => (event) => delivered.push(event)), {
      kind: "model.select",
      modelAlias: "fast",
    });
    expect(result.status).toBe("delivered");
    expect(delivered[0]).toMatchObject({
      type: "host-control",
      decision: { kind: "intent", intent: { kind: "model.select", modelAlias: "fast" } },
    });
  });

  it("delivers orb.select carrying the requested style, and audits the style", () => {
    const delivered: ModelTurnEvent[] = [];
    const result = decideControlApp(deps(() => (event) => delivered.push(event)), {
      kind: "orb.select",
      orbProfile: "plasma",
    });
    expect(result.status).toBe("delivered");
    expect(delivered[0]).toMatchObject({
      type: "host-control",
      decision: { kind: "intent", intent: { kind: "orb.select", orbProfile: "plasma" } },
    });
    const events = services.runtime.db
      .prepare("SELECT document FROM events WHERE kind = 'app.intent' ORDER BY rowid DESC LIMIT 1")
      .all() as { document: string }[];
    const document = JSON.parse(events[0]!.document) as { kind: string; orbProfile?: string };
    expect(document).toMatchObject({ kind: "orb.select", orbProfile: "plasma" });
  });

  it("refuses orb.select with no style or an unknown one, naming the styles, without delivering anything", () => {
    for (const params of [{ kind: "orb.select" }, { kind: "orb.select", orbProfile: "aurora" }]) {
      const delivered: ModelTurnEvent[] = [];
      const result = decideControlApp(deps(() => (event) => delivered.push(event)), params);
      expect(result.status, JSON.stringify(params)).toBe("refused");
      if (result.status !== "refused") throw new Error("expected a refusal");
      // The model is told what it may pass, so its next call can be a valid one.
      expect(result.say).toContain("pearl");
      expect(delivered).toHaveLength(0);
    }
  });

  it("does not carry an orbProfile on any other kind", () => {
    const delivered: ModelTurnEvent[] = [];
    decideControlApp(deps(() => (event) => delivered.push(event)), { kind: "settings.open", orbProfile: "pearl" });
    expect(delivered[0]).toMatchObject({ type: "host-control", decision: { kind: "intent", intent: { kind: "settings.open" } } });
    const event = delivered[0];
    if (event?.type !== "host-control" || event.decision.kind !== "intent") throw new Error("expected an intent");
    expect(event.decision.intent.orbProfile).toBeUndefined();
  });

  it("delivers inbox.open, so the agent can open the inbox the way a spoken command does", () => {
    const delivered: ModelTurnEvent[] = [];
    const result = decideControlApp(deps(() => (event) => delivered.push(event)), { kind: "inbox.open" });
    expect(result.status).toBe("delivered");
    expect(delivered[0]).toMatchObject({ type: "host-control", decision: { kind: "intent", intent: { kind: "inbox.open" } } });
  });

  it("refuses a kind outside the control_app vocabulary, such as app.quit", () => {
    const result = decideControlApp(deps(() => () => {}), { kind: "app.quit" });
    expect(result).toEqual({ status: "refused", reason: "unsupported", say: expect.any(String) as unknown as string });
  });

  it("audits a delivered request with source: agent", () => {
    decideControlApp(deps(() => () => {}), { kind: "voice.open" });
    const events = services.runtime.db
      .prepare("SELECT document FROM events WHERE kind = 'app.intent' ORDER BY rowid DESC LIMIT 1")
      .all() as { document: string }[];
    expect(events).toHaveLength(1);
    const document = JSON.parse(events[0]!.document) as { source: string; kind: string };
    expect(document.source).toBe("agent");
    expect(document.kind).toBe("voice.open");
  });

  it("audits a delivered request answering a spoken turn with source: voice-agent, not a person's voice", () => {
    decideControlApp(deps(() => () => {}, "voice"), { kind: "nav.home" });
    const events = services.runtime.db
      .prepare("SELECT document FROM events WHERE kind = 'app.intent' ORDER BY rowid DESC LIMIT 1")
      .all() as { document: string }[];
    expect(events).toHaveLength(1);
    const document = JSON.parse(events[0]!.document) as { source: string; kind: string };
    // "voice" is what a person's own spoken command is audited as; the model answering one is not that person.
    expect(document.source).toBe("voice-agent");
    expect(document.kind).toBe("nav.home");
  });

  it("gives every delivered decision its own unguessable control id", () => {
    const delivered: ModelTurnEvent[] = [];
    const first = decideControlApp(deps(() => (event) => delivered.push(event)), { kind: "settings.open" });
    const second = decideControlApp(deps(() => (event) => delivered.push(event)), { kind: "settings.open" });
    if (first.status !== "delivered" || second.status !== "delivered") throw new Error("expected both delivered");
    expect(first.controlId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.controlId).not.toBe(first.controlId);
    expect(delivered.map((event) => (event.type === "host-control" && event.decision.kind === "intent" ? event.decision.controlId : undefined))).toEqual([
      first.controlId,
      second.controlId,
    ]);
  });

  it("never refuses with nothing to say, even for a kind with no sentence of its own", () => {
    // The kinds with a parameter have their own sentence; anything else still gets the kind and the contract's reason.
    expect(controlAppRefusalSay("orb.select", [])).toContain("pearl");
    const generic = controlAppRefusalSay("inbox.open", ["only orb.select may name an orb profile"]);
    expect(generic).toContain("inbox.open");
    expect(generic).toContain("only orb.select may name an orb profile");
    expect(controlAppRefusalSay("inbox.open", []).trim()).not.toBe("");
  });

  it("says a theme refusal and a read-back in the language the person reads the app in", () => {
    const registry: ThemeRegistry = {
      themes: [{ themeRef: BUILTIN_CLARK_THEME_REF, displayName: "Clark Default", provider: { kind: "builtin" } }],
      problems: [],
      unchecked: [],
      documents: new Map(),
      refused: new Map(),
    };
    const withThemes = (): ControlAppDeps => ({ ...deps(() => () => {}), themes: () => registry });
    // Nothing chosen yet: Vietnamese, the language's own default.
    const unset = decideControlApp(withThemes(), { kind: "appearance.set-theme", theme: "camouflage" });
    expect(unset).toMatchObject({ status: "refused", say: expect.stringContaining("Chủ đề") as unknown as string });

    setPreference(
      { db: services.runtime.db, now: () => "2026-09-23T00:00:00.000Z" as never },
      { principalId: services.runtime.identity.ownerPrincipalId, key: "experience.language", scope: "global", value: "en", source: "user" },
    );
    const refused = decideControlApp(withThemes(), { kind: "appearance.set-theme", theme: "camouflage" });
    expect(refused).toMatchObject({ status: "refused", say: expect.stringContaining("cannot be drawn on this node") as unknown as string });
    const delivered = decideControlApp(withThemes(), { kind: "appearance.set-theme", theme: "Clark Default" });
    expect(delivered.status).toBe("delivered");
    expect(delivered.say).toBe(describeAppIntent({ kind: "appearance.set-theme", themeRef: BUILTIN_CLARK_THEME_REF, themeName: "Clark Default" }, "en"));
  });
});

describe("control_app answers with what the screen did", () => {
  /** A live transport: it expects a report for what it forwards, the way the stream route and voice do. */
  function live(sent: ModelTurnEvent[]): () => (event: ModelTurnEvent) => void {
    return () => (event) => {
      if (event.type === "host-control") services.hostControl.expect(event.decision);
      sent.push(event);
    };
  }

  function controlIdOf(event: ModelTurnEvent | undefined): string {
    if (event?.type !== "host-control" || event.decision.kind !== "intent" || event.decision.controlId === undefined) {
      throw new Error("expected an agent-issued host-control event");
    }
    return event.decision.controlId;
  }

  it("is done only once the page reports it ran", async () => {
    const sent: ModelTurnEvent[] = [];
    const answer = controlApp({ ...deps(live(sent)), hostControl: services.hostControl }, { kind: "settings.tab", tab: "ai" });
    await Promise.resolve();
    expect(services.hostControl.settle(controlIdOf(sent[0]), { ran: true, say: "Tôi mở Settings ở tab AI & Routing nhé." })).toBe(true);
    expect(await answer).toEqual({ status: "done", say: expect.stringContaining("AI & Routing") as unknown as string });
  });

  it("is failed, with the page's reason, when the page could not do it", async () => {
    const sent: ModelTurnEvent[] = [];
    const answer = controlApp({ ...deps(live(sent)), hostControl: services.hostControl }, { kind: "model.select", modelAlias: "fast" });
    await Promise.resolve();
    services.hostControl.settle(controlIdOf(sent[0]), { ran: false, say: "Không có profile nào tên fast." });
    const outcome = await answer;
    expect(outcome.status).toBe("failed");
    expect(outcome.say).toContain("Không có profile nào tên fast.");
  });

  it("is unconfirmed at once when no live screen was sent it, rather than stalling the turn", async () => {
    // The plain HTTP message route: it collects the decision for its response and never expects a report.
    const started = Date.now();
    const outcome = await controlApp({ ...deps(() => () => {}), hostControl: services.hostControl }, { kind: "nav.home" });
    expect(outcome).toMatchObject({ status: "unconfirmed", reason: "deferred" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("is unconfirmed, not done, when the screen never answers", async () => {
    const sent: ModelTurnEvent[] = [];
    const delivered = decideControlApp(deps(live(sent)), { kind: "voice.open" });
    if (delivered.status !== "delivered") throw new Error("expected delivered");
    expect(await services.hostControl.wait(delivered.controlId, 20)).toBe("timeout");
    // A report after the tool gave up is not held for anyone.
    expect(services.hostControl.settle(delivered.controlId, { ran: true, say: "late" })).toBe(false);
  });

  it("accepts one report per action, and none for an action nobody is waiting on", async () => {
    const sent: ModelTurnEvent[] = [];
    const answer = controlApp({ ...deps(live(sent)), hostControl: services.hostControl }, { kind: "nav.conversation" });
    await Promise.resolve();
    const controlId = controlIdOf(sent[0]);
    expect(services.hostControl.settle(controlId, { ran: true, say: "" })).toBe(true);
    expect(services.hostControl.settle(controlId, { ran: false, say: "second" })).toBe(false);
    expect(services.hostControl.settle("never-issued", { ran: true, say: "" })).toBe(false);
    // An empty sentence from the page falls back to the read-back rather than telling the model nothing.
    expect((await answer).say).toContain("quay lại cuộc trò chuyện");
  });
});

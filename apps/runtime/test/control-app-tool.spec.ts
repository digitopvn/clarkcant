import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModelTurnEvent } from "@clarkcant/core";

import { decideControlApp, type ControlAppDeps } from "../src/node-tools.ts";
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-control-app-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

function deps(onEvent: () => ((event: ModelTurnEvent) => void) | undefined): ControlAppDeps {
  return {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    now: () => "2026-09-23T00:00:00.000Z" as never,
    newId: (prefix: string) => `${prefix}_test`,
    principalId: services.runtime.identity.ownerPrincipalId,
    conversationId: "conv_test" as never,
    onEvent,
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
});

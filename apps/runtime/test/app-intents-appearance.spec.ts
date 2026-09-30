import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUILTIN_CLARK_THEME_REF, type ThemeDocument, type ThemeListingView } from "@clarkcant/contracts";

import { checkThemeChoice, themeTargets } from "../src/application/appearance-intents.ts";
import type { ThemeRegistry } from "../src/application/themes.ts";
import { decideAppIntent, mintConfirmation, type AppIntentDeps } from "../src/app-intents.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The node's half of the appearance intents.
 *
 * A sentence may name only a theme the node's registry lists, a click or the agent may name one only if the registry
 * would draw it, and a sentence typed, spoken or posted reaches one decision with one read-back. Nothing about the look
 * asks first.
 */

const AT = "2026-09-30T05:00:00.000Z";
const NEO = "package:com.example.themes#neo-brutalism";

function listing(themeRef: string, displayName: string): ThemeListingView {
  return {
    themeRef,
    displayName,
    provider:
      themeRef === BUILTIN_CLARK_THEME_REF
        ? { kind: "builtin" }
        : { kind: "package", packageId: "com.example.themes", version: "1.0.0", digest: "sha256:x", lane: "declarative", sourceTier: "local" },
  };
}

/** A registry with Clark Default and one drawable package theme; `camouflage` stands for anything it does not list. */
function registry(): ThemeRegistry {
  return {
    themes: [listing(BUILTIN_CLARK_THEME_REF, "Clark Default"), listing(NEO, "Neo Brutalism")],
    problems: [],
    unchecked: [],
    documents: new Map<string, ThemeDocument>([
      [NEO, { appearanceApi: { min: 1, max: 1 }, id: "neo-brutalism", displayName: "Neo Brutalism" }],
    ]),
    refused: new Map(),
  };
}

describe("the themes a sentence may name", () => {
  it("offers each listed theme by display name and by id read as words, and Clark by its short name", () => {
    const targets = themeTargets(registry());
    expect(targets).toContainEqual({ phrase: "clark", themeRef: BUILTIN_CLARK_THEME_REF, name: "Clark Default" });
    expect(targets).toContainEqual({ phrase: "Neo Brutalism", themeRef: NEO, name: "Neo Brutalism" });
    expect(targets).toContainEqual({ phrase: "neo brutalism", themeRef: NEO, name: "Neo Brutalism" });
    expect(targets.every((target) => target.themeRef !== "package:com.example.themes#camouflage")).toBe(true);
  });
});

describe("checking a theme choice", () => {
  it("accepts a reference, a display name or an id, and names the theme from the registry", () => {
    for (const asked of [NEO, "Neo Brutalism", "neo-brutalism", "  NEO BRUTALISM "]) {
      const checked = checkThemeChoice(registry(), asked, "en");
      expect(checked, asked).toMatchObject({ ok: true, intent: { kind: "appearance.set-theme", themeRef: NEO, themeName: "Neo Brutalism" } });
      if (checked.ok) expect(checked.readBack).toContain("Neo Brutalism");
    }
    expect(checkThemeChoice(registry(), BUILTIN_CLARK_THEME_REF, "vi")).toMatchObject({ ok: true, intent: { themeName: "Clark Default" } });
  });

  it("refuses a theme this node cannot draw, listing the ones it can", () => {
    for (const asked of ["package:com.example.themes#camouflage", "camouflage", "builtin:nope", "}{ <script>"]) {
      const checked = checkThemeChoice(registry(), asked, "en");
      expect(checked.ok, asked).toBe(false);
      if (!checked.ok) expect(checked.say).toContain("Neo Brutalism");
    }
    // An unchecked argument is bounded before it is shown or read aloud.
    const long = checkThemeChoice(registry(), "x".repeat(500), "vi");
    expect(!long.ok && long.say.length < 400).toBe(true);
  });

  it("refuses when the registry cannot be read, rather than storing a choice the page would ignore", () => {
    expect(checkThemeChoice(undefined, NEO, "vi")).toMatchObject({ ok: false });
  });
});

describe("deciding an appearance intent", () => {
  let dir: string;
  let services: NodeServices;
  let gateway: GatewayDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clarkcant-appearance-intents-"));
    services = bootNodeServices({ dataDir: dir, label: "test node" });
    gateway = { services, now: () => AT };
  });

  afterEach(() => {
    services.runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** `null` is a node with no theme registry to read. */
  function deps(themes: ThemeRegistry | null): AppIntentDeps {
    return {
      db: services.runtime.db,
      nodeId: services.runtime.identity.nodeId,
      now: () => AT as never,
      newId: services.conductor.newId,
      ...(themes === null ? {} : { themes: () => themes }),
    };
  }

  function decide(text: string, source: "chat" | "voice") {
    const principalId = services.runtime.identity.ownerPrincipalId;
    const intentDeps = deps(registry());
    return decideAppIntent(intentDeps, { principalId, request: { text, source } }, (intent) =>
      mintConfirmation(intentDeps, { principalId, intent, source }),
    );
  }

  it("reaches the same decision typed and spoken, without asking first", () => {
    for (const text of ["đổi giao diện sang neo brutalism", "chuyển giao diện sang tối", "đặt lại giao diện", "mở danh sách giao diện"]) {
      const typed = decide(text, "chat");
      expect(typed.kind, text).toBe("intent");
      expect(decide(text, "voice"), text).toEqual(typed);
    }
    expect(decide("đổi giao diện sang neo brutalism", "chat")).toMatchObject({
      kind: "intent",
      intent: { kind: "appearance.set-theme", themeRef: NEO, themeName: "Neo Brutalism" },
      requiresConfirmation: false,
    });
  });

  it("leaves a sentence about some other theme to the conversation", () => {
    for (const text of ["đổi giao diện sang camouflage", "switch my vscode theme to dark", "open the themes folder"]) {
      expect(decide(text, "chat").kind, text).toBe("none");
    }
  });

  it("refuses a theme change when the node cannot read its themes", () => {
    const principalId = services.runtime.identity.ownerPrincipalId;
    const intentDeps = deps(null);
    const decision = decideAppIntent(
      intentDeps,
      { principalId, request: { kind: "appearance.set-theme", themeRef: NEO, source: "click" }, intent: { kind: "appearance.set-theme", themeRef: NEO } },
      (intent) => mintConfirmation(intentDeps, { principalId, intent, source: "click" }),
    );
    expect(decision.kind).toBe("refused");
  });

  async function post(body: unknown): Promise<GatewayResponse> {
    return handleRequest(gateway, {
      method: "POST",
      path: "/app-intents",
      query: {},
      headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
      body: JSON.stringify(body),
    });
  }

  it("answers a click and a sentence over the route through the node's own registry", async () => {
    const clark = await post({ kind: "appearance.set-theme", themeRef: BUILTIN_CLARK_THEME_REF, source: "click" });
    expect(clark.status).toBe(200);
    expect((clark.body as { decision: unknown }).decision).toMatchObject({
      kind: "intent",
      intent: { kind: "appearance.set-theme", themeRef: BUILTIN_CLARK_THEME_REF, themeName: "Clark Default" },
    });
    const typed = await post({ text: "đổi giao diện sang clark default", source: "chat" });
    expect((typed.body as { decision: unknown }).decision).toEqual((clark.body as { decision: unknown }).decision);

    // Nothing is installed on this node, so a package theme is refused rather than stored.
    const missing = await post({ kind: "appearance.set-theme", themeRef: NEO, source: "click" });
    expect((missing.body as { decision: { kind: string } }).decision.kind).toBe("refused");

    const scheme = await post({ kind: "appearance.set-color-scheme", colorScheme: "dark", source: "click" });
    expect((scheme.body as { decision: unknown }).decision).toMatchObject({ kind: "intent", intent: { colorScheme: "dark" } });
    const stray = await post({ kind: "appearance.reset", colorScheme: "dark", source: "click" });
    expect(stray.status).toBe(400);
  });
});

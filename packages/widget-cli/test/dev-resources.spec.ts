import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startDevHost } from "../src/dev-host.ts";
import { createDevTokenBroker, describeSimulatedGrant, simulateResourceGrant } from "../src/dev-resources.ts";
import { applyShellAction, initialState, renderShell } from "../src/dev-shell.ts";

const DECLARED = [{ provider: "example.maps", scopes: ["tiles:read", "geocode:read"], purpose: "Draw the map tiles" }];

describe("simulated resource profiles", () => {
  it("grants or refuses with the node's own decision, and says it was simulated", () => {
    const request = { version: 1 as const, profile: "interactive-heavy" as const };
    const granted = simulateResourceGrant({ request, mode: "granted" });
    expect(granted).toMatchObject({ status: "granted", profile: { name: "interactive-heavy" } });
    expect(describeSimulatedGrant(granted)).toMatch(/^Granted interactive-heavy \(simulated by clark widget dev\): 1 GiB memory, 2 CPUs/);

    const refused = simulateResourceGrant({ request, mode: "refused" });
    expect(refused).toMatchObject({ status: "degraded", requested: "interactive-heavy" });
    expect(describeSimulatedGrant(refused)).toContain("(simulated by clark widget dev)");
    expect(describeSimulatedGrant(refused)).toContain("every action bound to them is unavailable");
  });

  it("cannot refuse what a node never refuses, nor grant what a node never grants", () => {
    // The light profile is today's envelope and is always granted; asking for nothing is asking for it.
    expect(simulateResourceGrant({ request: undefined, mode: "refused" })).toMatchObject({ status: "granted", requested: "interactive-light" });
    // A GPU is never passed through, whatever the simulated policy says.
    expect(simulateResourceGrant({ request: { version: 1, profile: "media-workstation", gpu: true }, mode: "granted" })).toMatchObject({
      status: "degraded",
    });
  });

  it("is a shell control that accepts only its two answers", () => {
    const known = { fixtures: ["default"], capabilities: [] };
    const state = initialState({ fixtures: ["default"], requestedCapabilities: [] });
    expect(state).toMatchObject({ profile: "granted", tokens: "grant" });
    expect(applyShellAction(state, { kind: "resource-profile", value: "refused" }, known).profile).toBe("refused");
    expect(applyShellAction(state, { kind: "resource-profile", value: "smaller" }, known)).toBe(state);
    expect(applyShellAction(state, { kind: "browser-token", value: "refuse" }, known).tokens).toBe("refuse");
    expect(applyShellAction(state, { kind: "browser-token", value: true }, known)).toBe(state);
  });

  it("draws the panels only for a package, and the token panel only when tokens are declared", () => {
    const state = initialState({ fixtures: ["default"], requestedCapabilities: [] });
    const base = {
      packageId: "com.example.maps",
      definitionId: "com.example.maps.view@1",
      fixtures: ["default"],
      requestedCapabilities: [],
      entryUrl: "/index.html",
      definition: { textFallback: "A map", semanticDescription: "A map" },
    };
    expect(renderShell(base, state)).not.toContain("data-dev-resources");

    const light = renderShell({ ...base, resources: { request: undefined, browserTokenProviders: [] } }, state);
    expect(light).toContain("data-dev-resources");
    expect(light).toContain("(nothing declared)");
    expect(light).not.toContain("data-dev-browser-tokens");

    const withTokens = renderShell(
      { ...base, resources: { request: { version: 1, profile: "interactive-heavy" }, browserTokenProviders: ["example.maps"] } },
      applyShellAction(state, { kind: "resource-profile", value: "refused" }, { fixtures: ["default"], capabilities: [] }),
    );
    expect(withTokens).toContain("data-dev-browser-tokens");
    expect(withTokens).toContain('data-dev-profile="refused"');
    expect(withTokens).toContain("Not granted: interactive-heavy is not granted");
  });
});

describe("the simulated tokens@1 provider", () => {
  it("issues a marked random token for a declared request, and keeps no value", () => {
    let mode: "grant" | "refuse" = "grant";
    const tokens = createDevTokenBroker({ declared: DECLARED, mode: () => mode, now: () => Date.parse("2026-10-01T06:00:00.000Z") });

    const issued = tokens.handle({ provider: "example.maps", scopes: ["tiles:read"], ttlSeconds: 300 });
    expect(issued).toMatchObject({
      status: "ok",
      token: { provider: "example.maps", scopes: ["tiles:read"], expiresAt: "2026-10-01T06:05:00.000Z" },
    });
    const value = issued.status === "ok" ? issued.token.value : "";
    expect(value).toMatch(/^dev-simulated-[A-Za-z0-9_-]{24}$/);
    const again = tokens.handle({ provider: "example.maps", scopes: ["tiles:read"] });
    expect(again.status === "ok" ? again.token.value : value).not.toBe(value);
    // The default lifetime is the node's.
    expect(again).toMatchObject({ token: { expiresAt: "2026-10-01T06:15:00.000Z" } });

    mode = "refuse";
    expect(tokens.handle({ provider: "example.maps", scopes: ["tiles:read"] })).toMatchObject({
      status: "refused",
      code: "TOKEN_PROVIDER_UNAVAILABLE",
      message: expect.stringContaining("(simulated by clark widget dev)"),
    });

    expect(tokens.events()).toEqual([
      { provider: "example.maps", outcome: "issued" },
      { provider: "example.maps", outcome: "issued" },
      { provider: "example.maps", outcome: "refused", code: "TOKEN_PROVIDER_UNAVAILABLE" },
    ]);
    expect(JSON.stringify(tokens.events())).not.toContain(value);
  });

  it("refuses with the node's codes what the package did not declare", () => {
    const tokens = createDevTokenBroker({ declared: DECLARED, mode: () => "grant" });
    expect(tokens.handle({ provider: "other.maps", scopes: ["tiles:read"] })).toMatchObject({ code: "TOKEN_PROVIDER_NOT_DECLARED" });
    expect(tokens.handle({ provider: "example.maps", scopes: ["tiles:write"] })).toMatchObject({ code: "TOKEN_SCOPE_NOT_DECLARED" });
    expect(tokens.handle({ provider: "example.maps", scopes: ["tiles:read"], ttlSeconds: 86_400 })).toMatchObject({ code: "SCHEMA_INVALID" });
    expect(tokens.handle("not a request")).toMatchObject({ code: "SCHEMA_INVALID" });
  });
});

describe("the dev host's simulated profile and tokens", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** The notes-service fixture, asking for a larger profile and declaring browser tokens from one provider. */
  function notesPackage(input: { profile?: string; browserTokens?: boolean }): string {
    const root = mkdtempSync(join(tmpdir(), "clark-dev-resources-"));
    created.push(root);
    cpSync(join(process.cwd(), "apps/web/e2e/fixtures/notes-service"), root, { recursive: true });
    const path = join(root, "clarkcant.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { facets: Record<string, unknown>[]; resources?: unknown };
    if (input.profile !== undefined) manifest.resources = { version: 1, profile: input.profile };
    if (input.browserTokens === true) {
      const ui = manifest.facets.find((facet) => facet.kind === "ui");
      if (ui !== undefined) ui.browserTokens = { version: 1, providers: DECLARED };
    }
    writeFileSync(path, JSON.stringify(manifest, null, 2));
    return root;
  }

  it("makes every service action unavailable with the node's sentence when the policy refuses the profile", async () => {
    const host = await startDevHost({ root: notesPackage({ profile: "interactive-heavy" }), port: 0, watchFiles: false });
    try {
      host.apply({ kind: "service-readiness", value: "ready", capabilityRef: "com.example.notes.add@1", status: "ready" });
      const state = (await (await fetch(`${host.url}dev/api/state`)).json()) as { bridgeNonce: string; browserTokens: string[] };
      expect(state.browserTokens).toEqual([]);
      const invoke = async () =>
        (await (
          await fetch(`${host.url}dev/api/service-action`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              kind: "action.invoke",
              nonce: state.bridgeNonce,
              actionBindingId: "binding_notes_add",
              expectedRevision: 0,
              input: {},
              invocationId: "inv_1",
            }),
          })
        ).json()) as { status: string; message?: string };

      expect(await invoke()).toMatchObject({ status: "accepted" });

      host.apply({ kind: "resource-profile", value: "refused" });
      const refused = await invoke();
      expect(refused).toMatchObject({ status: "refused" });
      expect(refused.message).toContain("interactive-heavy is not granted");
      expect(refused.message).toContain("(simulated by clark widget dev)");
      const availability = ((await (await fetch(`${host.url}dev/api/state`)).json()) as {
        actionAvailability: { available: boolean; reason?: string }[];
      }).actionAvailability;
      expect(availability.length).toBeGreaterThan(0);
      expect(availability.every((entry) => !entry.available && entry.reason?.includes("is not granted") === true)).toBe(true);

      const page = await (await fetch(host.url)).text();
      expect(page).toContain("Not granted: interactive-heavy is not granted");
    } finally {
      await host.close();
    }
  });

  it("offers tokens@1 only to a package that declared browser tokens, and answers with the simulated provider", async () => {
    const plain = await startDevHost({ root: notesPackage({}), port: 0, watchFiles: false });
    try {
      const answer = await fetch(`${plain.url}dev/api/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "example.maps", scopes: ["tiles:read"] }),
      });
      expect(await answer.json()).toMatchObject({ status: "refused", code: "EXTENSION_NOT_OFFERED" });
      expect(await (await fetch(plain.url)).text()).not.toContain("data-dev-browser-tokens");
    } finally {
      await plain.close();
    }

    const host = await startDevHost({ root: notesPackage({ browserTokens: true }), port: 0, watchFiles: false });
    try {
      const state = (await (await fetch(`${host.url}dev/api/state`)).json()) as { browserTokens: string[] };
      expect(state.browserTokens).toEqual(["example.maps"]);
      const ask = async () =>
        (await (
          await fetch(`${host.url}dev/api/tokens`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider: "example.maps", scopes: ["tiles:read"] }),
          })
        ).json()) as { status: string; code?: string; token?: { value: string } };

      const issued = await ask();
      expect(issued).toMatchObject({ status: "ok", token: { value: expect.stringMatching(/^dev-simulated-/) } });
      host.apply({ kind: "browser-token", value: "refuse" });
      expect(await ask()).toMatchObject({ status: "refused", code: "TOKEN_PROVIDER_UNAVAILABLE" });
      expect(host.tokenEvents().map((event) => event.outcome)).toEqual(["issued", "refused"]);
      expect(JSON.stringify(host.tokenEvents())).not.toContain(issued.token?.value ?? "dev-simulated-");
      expect(await (await fetch(host.url)).text()).toContain("data-dev-browser-tokens");
    } finally {
      await host.close();
    }
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PREFERENCE_KEYS, type RegisteredPreference } from "@clarkcant/contracts";
import { putPreference } from "@clarkcant/storage";

import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The preferences API over the wire (V17).
 *
 * The negative cases are the substance. An unregistered key is refused by name; a value the key does
 * not accept leaves the previous one in place; and a secret written into the preferences table by
 * some other path is not in the response, because this route answers only for the keys the registry
 * declares. That last one is the property worth a test: it cannot be broken by forgetting a filter.
 */

const AT = "2026-09-16T04:00:00.000Z";

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-preferences-"));
  services = bootNodeServices({ dataDir: dir, label: "preferences test node" });
  deps = { services, now: () => AT as never };
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

async function request(
  method: string,
  path: string,
  options: { body?: unknown; authed?: boolean } = {},
): Promise<GatewayResponse> {
  const outgoing: GatewayRequest = {
    method,
    path,
    query: {},
    headers: options.authed === false ? {} : { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: options.body === undefined ? "" : JSON.stringify(options.body),
  };
  return handleRequest(deps, outgoing);
}

async function preferences(): Promise<RegisteredPreference[]> {
  const response = await request("GET", "/preferences");
  expect(response.status).toBe(200);
  return (response.body as { preferences: RegisteredPreference[] }).preferences;
}

async function current(key: string): Promise<RegisteredPreference | undefined> {
  return (await preferences()).find((preference) => preference.key === key);
}

describe("the preferences route is behind the same token as every other route", () => {
  it("refuses a read without one", async () => {
    expect((await request("GET", "/preferences", { authed: false })).status).toBe(401);
  });

  it("refuses a write without one", async () => {
    const response = await request("PUT", "/preferences/experience.theme", {
      body: { value: "dark" },
      authed: false,
    });
    expect(response.status).toBe(401);
    expect((await current("experience.theme"))?.value).toBe("system");
  });
});

describe("a read answers for every registered key", () => {
  it("marks the ones nobody has set as defaults", async () => {
    const listed = await preferences();
    expect(listed.map((preference) => preference.key)).toEqual([...PREFERENCE_KEYS]);
    const mode = listed.find((preference) => preference.key === "execution.mode");
    expect(mode).toMatchObject({ value: "autonomous", isDefault: true, revision: 0, applies: "immediate" });
    expect(mode?.updatedAt).toBeNull();
  });

  it("reports a written value as a choice with the revision that wrote it", async () => {
    const written = await request("PUT", "/preferences/experience.theme", { body: { value: "dark" } });
    expect(written.status).toBe(200);
    expect((written.body as { preference: RegisteredPreference }).preference).toMatchObject({
      key: "experience.theme",
      scope: "global",
      value: "dark",
      isDefault: false,
      revision: 1,
    });
    expect(await current("experience.theme")).toMatchObject({ value: "dark", isDefault: false, revision: 1 });
  });

  it("counts revisions so a surface can tell its write landed", async () => {
    await request("PUT", "/preferences/experience.density", { body: { value: "compact" } });
    await request("PUT", "/preferences/experience.density", { body: { value: "comfortable" } });
    expect(await current("experience.density")).toMatchObject({ value: "comfortable", revision: 2 });
  });
});

describe("a refusal names the key or the field, and changes nothing", () => {
  it("refuses a key this node does not have", async () => {
    const response = await request("PUT", "/preferences/experience.colorway", { body: { value: "vaporwave" } });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "PREFERENCE_UNKNOWN" });
  });

  it("refuses a value outside the declared clamps and keeps the previous one", async () => {
    await request("PUT", "/preferences/orb.custom", { body: { value: { physics: { stiffness: 120 } } } });
    const refused = await request("PUT", "/preferences/orb.custom", {
      body: { value: { physics: { stiffness: 4000 } } },
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: "PREFERENCE_INVALID" });
    expect((refused.body as { message: string }).message).toContain("stiffness");
    expect((await current("orb.custom"))?.value).toEqual({ physics: { stiffness: 120 } });
  });

  it("refuses a body that names no value at all", async () => {
    const response = await request("PUT", "/preferences/experience.theme", { body: {} });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "INVALID_SCHEMA" });
  });

  it("refuses a body that is not a JSON object", async () => {
    const response = await handleRequest(deps, {
      method: "PUT",
      path: "/preferences/experience.theme",
      query: {},
      headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
      body: "[]",
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "INVALID_SCHEMA" });
  });
});

describe("undo reports what it actually did", () => {
  it("restores the value the write replaced", async () => {
    await request("PUT", "/preferences/experience.theme", { body: { value: "dark" } });
    await request("PUT", "/preferences/experience.theme", { body: { value: "light" } });

    const undone = await request("POST", "/preferences/experience.theme/undo");
    expect(undone.status).toBe(200);
    expect(undone.body).toMatchObject({ undone: true });
    expect((undone.body as { preference: RegisteredPreference }).preference).toMatchObject({ value: "dark" });
    expect(await current("experience.theme")).toMatchObject({ value: "dark", isDefault: false });
  });

  it("says there was nothing to undo rather than reporting a change", async () => {
    const undone = await request("POST", "/preferences/experience.density/undo");
    expect(undone.status).toBe(200);
    expect(undone.body).toMatchObject({ undone: false });
    expect((undone.body as { preference: RegisteredPreference }).preference).toMatchObject({
      value: "comfortable",
      isDefault: true,
    });
  });

  it("refuses an undo for a key this node does not have", async () => {
    const undone = await request("POST", "/preferences/nope/undo");
    expect(undone.status).toBe(404);
    expect(undone.body).toMatchObject({ code: "PREFERENCE_UNKNOWN" });
  });
});

describe("the response cannot carry a value nothing declared", () => {
  it("omits a secret written into the preferences table by another path", async () => {
    // A row like this is what a credential written into the wrong table would look like. The route
    // answers only for registered keys, so it is not in the response — not because a filter
    // remembered to drop it, but because nothing ever reads it.
    putPreference(services.runtime.db, {
      principalId: services.runtime.identity.ownerPrincipalId,
      key: "provider.apiKey",
      value: "sk-live-should-never-be-returned",
      scope: "global",
      source: "user",
      at: AT as never,
    });

    const response = await request("GET", "/preferences");
    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain("sk-live-should-never-be-returned");
    expect(serialised).not.toContain("provider.apiKey");
  });
});

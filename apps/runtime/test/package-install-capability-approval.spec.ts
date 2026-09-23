import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_EXECUTION_POLICY_CONFIG } from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, writeRegisteredPreference } from "@clarkcant/core";

import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * M1: a capability the execution policy would ask about, or refuse, is reported back rather than silently
 * dropped.
 *
 * The package here has `riskTier: "service"`, which `effectCategoryForLane` (install-consent.ts) decides in the
 * `destructive` effect category — separate from the install itself, which is always decided in `local-write`. That
 * separation is what lets this test hold the install's own decision at "execute" (autonomous mode, no rule for
 * `local-write`, so it proceeds) while a policy rule targets only the *capability* decision, proving the two are
 * independently derived rather than one flag covering both.
 */

const AT = "2026-09-23T06:00:00.000Z";
const PACKAGE_ID = "com.example.capability-approval";
const VERSION = "1.0.0";
const DIGEST = "sha256:capability-approval-digest";
const REQUESTED_CAPABILITY = "project.code.write@1";

let dir: string;
let packageRoot: string;
let indexPath: string;
let services: NodeServices;
let deps: GatewayDeps;
let previousIndex: string | undefined;

function directoryEntry(): Record<string, unknown> {
  return {
    packageId: PACKAGE_ID,
    version: VERSION,
    displayName: "Capability approval fixture",
    description: "A package that requests one capability at the service risk lane.",
    source: { kind: "local", path: packageRoot },
    publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    preview: {},
    facets: ["tools"],
    isolations: [{ facetKind: "tools", isolation: "service" }],
    platforms: ["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64"],
    hostApi: { min: 1, max: 1 },
    permissionsSummary: [],
    riskTier: "service",
    sizeBytes: 512,
    digest: DIGEST,
  };
}

function writeIndex(entries: readonly Record<string, unknown>[]): void {
  writeFileSync(indexPath, JSON.stringify(entries));
}

async function request(input: { method: string; path: string; body?: Record<string, unknown> }): Promise<GatewayResponse> {
  const gatewayRequest: GatewayRequest = {
    method: input.method,
    path: input.path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: input.body === undefined ? "" : JSON.stringify(input.body),
  };
  return handleRequest(deps, gatewayRequest);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-install-capability-approval-"));
  packageRoot = join(dir, "package");
  mkdirSync(packageRoot, { recursive: true });
  // A manifest the reader actually parses (unlike the other local-install fixtures' deliberately-incomplete
  // `clarkcant.json`), so `readPackage(...).manifest.requestedCapabilities` really carries the capability this
  // test is about. The one declared facet's own definition file is never written — `readPackage` still returns
  // the manifest when a facet's definition cannot be read, only the facet itself is dropped (with a problem this
  // test does not care about), so nothing here needs a working widget frame.
  writeFileSync(
    join(packageRoot, "clarkcant.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: PACKAGE_ID,
      version: VERSION,
      displayName: "Capability approval fixture",
      description: "A package that requests one capability at the service risk lane.",
      hostApi: { min: 1, max: 1 },
      facets: [{ kind: "widget", id: `${PACKAGE_ID}.tool`, entry: "tool.js", definition: "tool.json", isolation: "isolated-ui" }],
      requestedCapabilities: [REQUESTED_CAPABILITY],
      permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
      platforms: ["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64"],
      publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    }),
  );
  indexPath = join(dir, "directory.json");
  services = bootNodeServices({ dataDir: dir, label: "install capability approval test node" });
  deps = { services, now: () => AT as never };
  previousIndex = process.env["CC_DIRECTORY_INDEX"];
  process.env["CC_DIRECTORY_INDEX"] = indexPath;
});

afterEach(() => {
  if (previousIndex === undefined) delete process.env["CC_DIRECTORY_INDEX"];
  else process.env["CC_DIRECTORY_INDEX"] = previousIndex;
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Sets a rule targeting the `destructive` category only — the category a `service`-lane capability is decided
 * in, never the `local-write` category the install itself is decided in — so the install still runs to
 * completion and only the capability grant is affected. */
function setDestructiveRule(decision: "ask" | "deny"): void {
  const written = writeRegisteredPreference(
    { db: services.runtime.db, now: () => AT as never },
    {
      principalId: services.runtime.identity.ownerPrincipalId,
      key: EXECUTION_POLICY_PREFERENCE_KEY,
      value: {
        ...DEFAULT_EXECUTION_POLICY_CONFIG,
        rules: [{ effectCategory: "destructive", decision }],
      },
      source: "user",
    },
  );
  if (!written.ok) throw new Error(written.message);
}

describe("M1: a capability the policy would ask about or deny is reported, not silently dropped", () => {
  it("creates a real approval for a capability the policy asks about, and lists it as pending", async () => {
    writeIndex([directoryEntry()]);
    setDestructiveRule("ask");

    const response = await request({
      method: "POST",
      path: "/packages/install",
      body: { packageId: PACKAGE_ID, version: VERSION, localDigest: DIGEST },
    });

    // The install itself still ran to completion: only the capability's own category was ruled to ask.
    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(body["state"]).toBe("active");

    const pending = body["pendingCapabilities"] as readonly { ref: string; approvalId: string }[];
    expect(pending).toHaveLength(1);
    const [first] = pending;
    if (first === undefined) throw new Error("expected one pending capability");
    expect(first.ref).toBe(REQUESTED_CAPABILITY);
    expect(typeof first.approvalId).toBe("string");
    expect(body["deniedCapabilities"]).toEqual([]);

    // The pending entry is a real record through the existing approval path (`requestApproval`), not a value
    // this route made up for the response — proven by reading it back from the same table `/packages/install`'s
    // own "asks first" case is asserted against.
    const approvalRow = services.runtime.db
      .prepare("SELECT operation_digest, effect_category FROM approvals WHERE approval_id = ?")
      .get(first.approvalId) as { operation_digest: string; effect_category: string } | undefined;
    expect(approvalRow).toBeDefined();
    expect(approvalRow?.effect_category).toBe("destructive");
    expect(approvalRow?.operation_digest).toBe(`${DIGEST}:${REQUESTED_CAPABILITY}`);

    // Not granted: the generation this install activated does not carry a capability still pending approval.
    const generationId = String(body["generationId"]);
    const generationRow = services.runtime.db
      .prepare("SELECT document FROM package_generations WHERE generation_id = ?")
      .get(generationId) as { document: string };
    const generationDoc = JSON.parse(generationRow.document) as { grantedCapabilities: readonly string[] };
    expect(generationDoc.grantedCapabilities).toEqual([]);
  });

  it("reuses the same pending approval on a second install of the same digest, instead of a duplicate", async () => {
    writeIndex([directoryEntry()]);
    setDestructiveRule("ask");

    const first = await request({
      method: "POST",
      path: "/packages/install",
      body: { packageId: PACKAGE_ID, version: VERSION, localDigest: DIGEST },
    });
    const second = await request({
      method: "POST",
      path: "/packages/install",
      body: { packageId: PACKAGE_ID, version: VERSION, localDigest: DIGEST },
    });

    const firstPending = (first.body as Record<string, unknown>)["pendingCapabilities"] as readonly { approvalId: string }[];
    const secondPending = (second.body as Record<string, unknown>)["pendingCapabilities"] as readonly { approvalId: string }[];
    expect(secondPending[0]?.approvalId).toBe(firstPending[0]?.approvalId);

    const rows = services.runtime.db
      .prepare("SELECT approval_id FROM approvals WHERE operation_digest = ?")
      .all(`${DIGEST}:${REQUESTED_CAPABILITY}`) as { approval_id: string }[];
    expect(rows).toHaveLength(1);
  });

  it("reports a capability the policy denies as denied, and grants it nothing", async () => {
    writeIndex([directoryEntry()]);
    setDestructiveRule("deny");

    const response = await request({
      method: "POST",
      path: "/packages/install",
      body: { packageId: PACKAGE_ID, version: VERSION, localDigest: DIGEST },
    });

    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(body["state"]).toBe("active");
    expect(body["pendingCapabilities"]).toEqual([]);
    expect(body["deniedCapabilities"]).toEqual([REQUESTED_CAPABILITY]);
  });

  it("[fails on the old behaviour] would otherwise silently drop the pending capability from the response", async () => {
    /*
     * This test documents the regression by construction rather than by literally reverting the source: the old
     * `PackageInstallOutcome` shape (before M1) carried no `pendingCapabilities`/`deniedCapabilities` fields at
     * all, so this same assertion — that a capability the policy asks about is visible somewhere in the response
     * — could not have passed against it. Kept as its own case so a future regression that drops the fields
     * again fails here specifically, with a name that says what broke.
     */
    writeIndex([directoryEntry()]);
    setDestructiveRule("ask");

    const response = await request({
      method: "POST",
      path: "/packages/install",
      body: { packageId: PACKAGE_ID, version: VERSION, localDigest: DIGEST },
    });
    const body = response.body as Record<string, unknown>;
    expect(Object.hasOwn(body, "pendingCapabilities")).toBe(true);
    expect(Object.hasOwn(body, "deniedCapabilities")).toBe(true);
  });
});

/**
 * N1: resolving a pending capability approval through its own node-scoped route
 * (`POST /packages/approvals/:id/decision`), not the conversation-scoped one — this approval was never a step
 * in a dispatched task, so it has no conversation to be scoped to.
 */
describe("N1: resolving a pending capability approval", () => {
  async function installAndGetPending(): Promise<{ approvalId: string; ref: string; digest: string }> {
    writeIndex([directoryEntry()]);
    setDestructiveRule("ask");
    const response = await request({
      method: "POST",
      path: "/packages/install",
      body: { packageId: PACKAGE_ID, version: VERSION, localDigest: DIGEST },
    });
    const body = response.body as Record<string, unknown>;
    const pending = (body["pendingCapabilities"] as readonly { ref: string; approvalId: string }[])[0];
    if (pending === undefined) throw new Error("expected a pending capability approval");
    return { approvalId: pending.approvalId, ref: pending.ref, digest: `${DIGEST}:${pending.ref}` };
  }

  it("adds the capability to the generation's grantedCapabilities once approved, and persists it", async () => {
    const { approvalId, ref, digest } = await installAndGetPending();

    const decided = await request({
      method: "POST",
      path: `/packages/approvals/${approvalId}/decision`,
      body: { decision: "granted", digest },
    });

    expect(decided.status).toBe(200);
    const decidedBody = decided.body as Record<string, unknown>;
    expect(decidedBody["decision"]).toBe("granted");
    expect(decidedBody["ref"]).toBe(ref);
    const generationId = decidedBody["generationId"];
    expect(typeof generationId).toBe("string");

    // Persisted: read back the generation's own row, the same one `invocationPreflight` reads at dispatch time
    // (package-install-local-chain.spec.ts) — nothing here is only true in the response.
    const generationRow = services.runtime.db
      .prepare("SELECT document FROM package_generations WHERE generation_id = ?")
      .get(generationId as string) as { document: string };
    const generationDoc = JSON.parse(generationRow.document) as { grantedCapabilities: readonly string[] };
    expect(generationDoc.grantedCapabilities).toContain(ref);

    // Audited: the same effect-execution ledger every other granted effect on this node writes to.
    const activity = await request({ method: "GET", path: "/activity" });
    const effects = (activity.body as { effects: { kind?: string; description?: string }[] }).effects;
    expect(effects.some((effect) => effect.kind === "effect.executed" && effect.description === `grant ${ref} to ${PACKAGE_ID}@${VERSION}`)).toBe(true);
  });

  it("records a denied capability as denied, and grants nothing", async () => {
    const { approvalId, ref, digest } = await installAndGetPending();

    const decided = await request({
      method: "POST",
      path: `/packages/approvals/${approvalId}/decision`,
      body: { decision: "denied", digest },
    });

    expect(decided.status).toBe(200);
    const decidedBody = decided.body as Record<string, unknown>;
    expect(decidedBody["decision"]).toBe("denied");

    const approvalRow = services.runtime.db
      .prepare("SELECT decision FROM approvals WHERE approval_id = ?")
      .get(approvalId) as { decision: string };
    expect(approvalRow.decision).toBe("denied");

    if (typeof decidedBody["generationId"] === "string") {
      const generationRow = services.runtime.db
        .prepare("SELECT document FROM package_generations WHERE generation_id = ?")
        .get(decidedBody["generationId"]) as { document: string };
      const generationDoc = JSON.parse(generationRow.document) as { grantedCapabilities: readonly string[] };
      expect(generationDoc.grantedCapabilities).not.toContain(ref);
    }
  });

  it("is idempotent on a repeated submission of the same decision, rather than an error or a second grant", async () => {
    const { approvalId, ref, digest } = await installAndGetPending();

    const firstDecision = await request({
      method: "POST",
      path: `/packages/approvals/${approvalId}/decision`,
      body: { decision: "granted", digest },
    });
    const secondDecision = await request({
      method: "POST",
      path: `/packages/approvals/${approvalId}/decision`,
      body: { decision: "granted", digest },
    });

    expect(firstDecision.status).toBe(200);
    expect(secondDecision.status).toBe(200);
    expect((secondDecision.body as Record<string, unknown>)["alreadyDecided"]).toBe(true);

    const generationId = (firstDecision.body as Record<string, unknown>)["generationId"] as string;
    const generationRow = services.runtime.db
      .prepare("SELECT document FROM package_generations WHERE generation_id = ?")
      .get(generationId) as { document: string };
    const generationDoc = JSON.parse(generationRow.document) as { grantedCapabilities: readonly string[] };
    // Not duplicated: the ref appears exactly once even though the same grant was submitted twice.
    expect(generationDoc.grantedCapabilities.filter((granted) => granted === ref)).toHaveLength(1);
  });

  it("[fails on the old behaviour] there was no route to resolve a capability approval at all", async () => {
    const { approvalId, digest } = await installAndGetPending();

    const decided = await request({
      method: "POST",
      path: `/packages/approvals/${approvalId}/decision`,
      body: { decision: "granted", digest },
    });

    // Before N1, `/packages/approvals/:id/decision` did not exist, so this same request fell through every route
    // handler to the gateway's catch-all 404 — a caller had no way to ever grant a capability the policy asked
    // about. Kept as its own case so a future regression that removes the route fails here by name.
    expect(decided.status).toBe(200);
  });
});

/**
 * R1: `POST /packages/approvals/:id/decision` is node-scoped and must refuse any approval that is not actually
 * an install-capability approval — before ever committing a decision to it, not after. The previous ordering
 * called `decideApproval` first (mutating the row to granted/denied for real) and only afterward noticed the
 * approval was the wrong shape; by then the conversation-scoped route that actually owns that approval never
 * gets to decide it, and the request it belonged to is stuck forever with an approval that already says
 * "decided".
 */
describe("R1: this route refuses an approval of any other kind before deciding it, not after", () => {
  function insertRawApproval(row: {
    approvalId: string;
    taskId: string | null;
    operationDigest: string;
  }): void {
    services.runtime.db
      .prepare(
        `INSERT INTO approvals
           (approval_id, task_id, effect_id, operation_digest, operation_description, effect_category,
            target_node_id, account, decider, decision, requested_at, expires_at)
         VALUES (?, ?, NULL, ?, 'a task-scoped or non-capability approval', 'local-write',
                 NULL, NULL, 'user', 'pending', ?, ?)`,
      )
      .run(row.approvalId, row.taskId, row.operationDigest, AT, "2026-09-23T07:00:00.000Z");
  }

  it("refuses a task-scoped approval (belongs to a dispatched task) without deciding it", async () => {
    const approvalId = "approval-task-scoped-r1";
    const operationDigest = `${DIGEST}:${REQUESTED_CAPABILITY}`;
    insertRawApproval({ approvalId, taskId: "some-dispatched-task-id", operationDigest });

    const decided = await request({
      method: "POST",
      path: `/packages/approvals/${approvalId}/decision`,
      body: { decision: "granted", digest: operationDigest },
    });

    expect(decided.status).toBeGreaterThanOrEqual(400);
    expect(decided.status).toBeLessThan(500);
    const body = decided.body as Record<string, unknown>;
    expect(body["code"]).toBe("NOT_A_CAPABILITY_APPROVAL");

    // No state change: the row this route was never entitled to decide is still pending, so the conversation
    // route that actually owns it can still decide it later.
    const row = services.runtime.db
      .prepare("SELECT decision FROM approvals WHERE approval_id = ?")
      .get(approvalId) as { decision: string };
    expect(row.decision).toBe("pending");
  });

  it("refuses a non-capability-shaped digest (e.g. the install's own approval, single-colon digest) without deciding it", async () => {
    const approvalId = "approval-non-capability-r1";
    // The install's own approval uses `operationDigest = entry.digest` alone (one colon, `sha256:<hex>`), never
    // the two-colon `${digest}:${ref}` shape a capability approval carries.
    const operationDigest = DIGEST;
    insertRawApproval({ approvalId, taskId: null, operationDigest });

    const decided = await request({
      method: "POST",
      path: `/packages/approvals/${approvalId}/decision`,
      body: { decision: "granted", digest: operationDigest },
    });

    expect(decided.status).toBeGreaterThanOrEqual(400);
    expect(decided.status).toBeLessThan(500);
    const body = decided.body as Record<string, unknown>;
    expect(body["code"]).toBe("NOT_A_CAPABILITY_APPROVAL");

    const row = services.runtime.db
      .prepare("SELECT decision FROM approvals WHERE approval_id = ?")
      .get(approvalId) as { decision: string };
    expect(row.decision).toBe("pending");
  });

  it("[fails on the old behaviour] a task-scoped approval got decided for real before the kind was checked", async () => {
    /*
     * Documents the regression by construction: the old code called `decideApproval` unconditionally first, which
     * would have flipped this task-scoped row to `granted` and only afterward returned `NOT_A_CAPABILITY_APPROVAL`
     * — leaving the row permanently stuck at "decided" with the conversation-scoped route (the one that actually
     * owns it) never getting a chance to act on it. This asserts the row is untouched, which the old ordering
     * could not have satisfied.
     */
    const approvalId = "approval-task-scoped-regression-r1";
    const operationDigest = `${DIGEST}:${REQUESTED_CAPABILITY}`;
    insertRawApproval({ approvalId, taskId: "another-dispatched-task-id", operationDigest });

    await request({
      method: "POST",
      path: `/packages/approvals/${approvalId}/decision`,
      body: { decision: "granted", digest: operationDigest },
    });

    const row = services.runtime.db
      .prepare("SELECT decision, decided_at FROM approvals WHERE approval_id = ?")
      .get(approvalId) as { decision: string; decided_at: string | null };
    expect(row.decision).toBe("pending");
    expect(row.decided_at).toBeNull();
  });
});

/**
 * R2: the decision and the capability grant it authorizes are two writes that must not be allowed to diverge.
 * A retry of an already-decided approval must re-apply a grant that is missing (rather than silently no-op), and
 * an approval that names a digest no active generation carries must be a named failure, not a false success.
 */
describe("R2: a replayed decision re-applies a missing grant, and a missing generation is a named failure", () => {
  async function installAndGetPending(): Promise<{ approvalId: string; ref: string; digest: string }> {
    writeIndex([directoryEntry()]);
    setDestructiveRule("ask");
    const response = await request({
      method: "POST",
      path: "/packages/install",
      body: { packageId: PACKAGE_ID, version: VERSION, localDigest: DIGEST },
    });
    const body = response.body as Record<string, unknown>;
    const pending = (body["pendingCapabilities"] as readonly { ref: string; approvalId: string }[])[0];
    if (pending === undefined) throw new Error("expected a pending capability approval");
    return { approvalId: pending.approvalId, ref: pending.ref, digest: `${DIGEST}:${pending.ref}` };
  }

  it("re-applies the grant on a replayed decision when it is missing from the generation (partial-failure retry)", async () => {
    const { approvalId, ref, digest } = await installAndGetPending();

    const first = await request({
      method: "POST",
      path: `/packages/approvals/${approvalId}/decision`,
      body: { decision: "granted", digest },
    });
    const generationId = (first.body as Record<string, unknown>)["generationId"] as string;

    // Simulate the partial failure R2 is about: the decision committed, but the grant write never landed (a
    // crash between the two, in the pre-fix code's two-transaction world). Strip the ref back out directly.
    const before = services.runtime.db
      .prepare("SELECT document FROM package_generations WHERE generation_id = ?")
      .get(generationId) as { document: string };
    const beforeDoc = JSON.parse(before.document) as { grantedCapabilities: readonly string[] };
    services.runtime.db
      .prepare("UPDATE package_generations SET document = ? WHERE generation_id = ?")
      .run(
        JSON.stringify({ ...beforeDoc, grantedCapabilities: beforeDoc.grantedCapabilities.filter((g) => g !== ref) }),
        generationId,
      );

    // A client retrying the same already-decided submission must converge the state, not just report success.
    const retry = await request({
      method: "POST",
      path: `/packages/approvals/${approvalId}/decision`,
      body: { decision: "granted", digest },
    });

    expect(retry.status).toBe(200);
    expect((retry.body as Record<string, unknown>)["alreadyDecided"]).toBe(true);

    const after = services.runtime.db
      .prepare("SELECT document FROM package_generations WHERE generation_id = ?")
      .get(generationId) as { document: string };
    const afterDoc = JSON.parse(after.document) as { grantedCapabilities: readonly string[] };
    expect(afterDoc.grantedCapabilities).toContain(ref);
  });

  it("returns a named failure, not a false success, when no active generation carries the approval's digest", async () => {
    const { approvalId, digest } = await installAndGetPending();

    // Supersede the generation this approval's digest names, simulating a reinstall that superseded it before
    // the approval was decided.
    services.runtime.db
      .prepare(
        "UPDATE package_generations SET superseded_at = ? WHERE node_id = ? AND digest = ?",
      )
      .run("2026-09-23T06:30:00.000Z", services.runtime.identity.nodeId, DIGEST);

    const decided = await request({
      method: "POST",
      path: `/packages/approvals/${approvalId}/decision`,
      body: { decision: "granted", digest },
    });

    expect(decided.status).toBe(409);
    const body = decided.body as Record<string, unknown>;
    expect(body["code"]).toBe("NO_GENERATION_FOR_APPROVAL");
    // Not a false success: the previous behaviour returned `ok: true` with no `generationId` here.
    expect(body["generationId"]).toBeUndefined();
  });

  it("[fails on the old behaviour] a replayed decision after a missing grant reported success without re-applying it", async () => {
    const { approvalId, ref, digest } = await installAndGetPending();

    const first = await request({
      method: "POST",
      path: `/packages/approvals/${approvalId}/decision`,
      body: { decision: "granted", digest },
    });
    const generationId = (first.body as Record<string, unknown>)["generationId"] as string;

    const before = services.runtime.db
      .prepare("SELECT document FROM package_generations WHERE generation_id = ?")
      .get(generationId) as { document: string };
    const beforeDoc = JSON.parse(before.document) as { grantedCapabilities: readonly string[] };
    services.runtime.db
      .prepare("UPDATE package_generations SET document = ? WHERE generation_id = ?")
      .run(
        JSON.stringify({ ...beforeDoc, grantedCapabilities: beforeDoc.grantedCapabilities.filter((g) => g !== ref) }),
        generationId,
      );

    await request({
      method: "POST",
      path: `/packages/approvals/${approvalId}/decision`,
      body: { decision: "granted", digest },
    });

    // Documents the regression by construction: the old already-decided branch returned success straight from
    // the stored row, without ever re-checking or re-applying the generation's own grant. This asserts the grant
    // really is present after the replay, which the old code's silent no-op could not have satisfied once the
    // grant had gone missing.
    const after = services.runtime.db
      .prepare("SELECT document FROM package_generations WHERE generation_id = ?")
      .get(generationId) as { document: string };
    const afterDoc = JSON.parse(after.document) as { grantedCapabilities: readonly string[] };
    expect(afterDoc.grantedCapabilities).toContain(ref);
  });
});

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type Instant,
  PERSON_ONLY_REFUSAL,
  inboxResponseSchema,
  isPersonOnlyRoute,
  messageBlockSchema,
  platformForHost,
} from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, digestOfDirectory, writeRegisteredPreference } from "@clarkcant/core";
import { allRows } from "@clarkcant/storage";

import { expireInstallApprovals } from "../src/application/install-approval.ts";
import {
  INSTALL_APPROVAL_STREAM,
  installPackage,
  localFilesChangedMessage,
  packageInstallDepsOf,
} from "../src/application/package-install.ts";
import { sweepExpired } from "../src/expiry-notices.ts";
import { createManagePackageTool } from "../src/manage-package-tool.ts";
import { createSearchDirectoryTool } from "../src/node-tools.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { SURFACE_HEADER } from "../src/routes/http.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * An install the person's execution policy asked about, from the question to the answer.
 *
 * The install route asks (`202 APPROVAL_REQUIRED`); the inbox lists the question with what the person needs to decide
 * it; the person's answer on the person-only decision route installs exactly the artifact that was asked about, or
 * installs nothing. Each test drives the gateway the way the app does, and checks what is installed afterwards in
 * `package_generations` rather than trusting the response alone.
 *
 * The listing is a real one-commit git repository, as in `package-install-route.spec.ts`: an approved install fetches
 * and verifies the artifact like any other, so a made-up digest could not stand in for "installs".
 */

const PACKAGE_ID = "com.example.calendar";
const VERSION = "1.2.0";
const HOST_PLATFORM = platformForHost(process.platform, process.arch);

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let indexPath: string;
let repo: string;
let gitRef: string;
let gitDigest: string;
let previousIndex: string | undefined;
let previousAllowLocalGit: string | undefined;

function git(...args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args]);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** Commit `content` as the package's only file and return the ref and the digest a real fetch of it produces. */
function commit(content: string): { ref: string; digest: string } {
  writeFileSync(join(repo, "widget.json"), content);
  git("add", ".");
  git("commit", "--quiet", "-m", "change");
  const digest = digestOfDirectory(repo, { exclude: [".git"] });
  if (!digest.ok) throw new Error(digest.message);
  return { ref: git("rev-parse", "HEAD"), digest: digest.digest };
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageId: PACKAGE_ID,
    version: VERSION,
    displayName: "Calendar Plus",
    description: "A compact agenda and week view.",
    source: { kind: "git", url: repo, ref: gitRef },
    publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    preview: {},
    facets: ["ui"],
    isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
    platforms: [HOST_PLATFORM ?? "web"],
    hostApi: { min: 1, max: 1 },
    permissionsSummary: ["Reads your calendar"],
    riskTier: "isolated-ui",
    sizeBytes: 40_960,
    digest: gitDigest,
    ...overrides,
  };
}

function writeIndex(entries: readonly Record<string, unknown>[]): void {
  writeFileSync(indexPath, JSON.stringify(entries));
}

function writePolicy(value: Record<string, unknown>): void {
  const written = writeRegisteredPreference(
    { db: services.runtime.db, now: () => new Date().toISOString() as Instant },
    { principalId: services.runtime.identity.ownerPrincipalId, key: EXECUTION_POLICY_PREFERENCE_KEY, value, source: "user" },
  );
  if (!written.ok) throw new Error(written.message);
}

/** The person's policy asks before anything is written locally, which is the category an install is decided in. */
function askBeforeInstalling(): void {
  writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, rules: [{ effectCategory: "local-write", decision: "ask" }] });
}

async function call(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<GatewayResponse> {
  return handleRequest(deps, {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}`, ...headers },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

const codeOf = (response: GatewayResponse): unknown => (response.body as { code?: unknown }).code;

/** Ask to install; returns the approval the policy raised. */
async function askToInstall(): Promise<string> {
  const asked = await call("POST", "/packages/install", { packageId: PACKAGE_ID, version: VERSION });
  expect(asked.status).toBe(202);
  expect(codeOf(asked)).toBe("APPROVAL_REQUIRED");
  return (asked.body as { approvalId: string }).approvalId;
}

async function waiting() {
  const response = await call("GET", "/inbox");
  expect(response.status).toBe(200);
  return inboxResponseSchema.parse(response.body).waiting.filter((item) => item.kind === "install-approval");
}

function decide(approvalId: string, decision: "granted" | "denied", digest = gitDigest, headers: Record<string, string> = {}) {
  return call("POST", `/packages/approvals/${approvalId}/decision`, { decision, digest }, headers);
}

const installedVersions = (): string[] =>
  allRows<{ version: string }>(services.runtime.db, "SELECT version FROM package_generations WHERE package_id = ?", PACKAGE_ID).map(
    (row) => row.version,
  );

const approvalDecision = (approvalId: string): string | undefined =>
  allRows<{ decision: string }>(services.runtime.db, "SELECT decision FROM approvals WHERE approval_id = ?", approvalId)[0]?.decision;

const audit = () =>
  allRows<{ document: string }>(services.runtime.db, "SELECT document FROM events WHERE stream = ? ORDER BY rowid", INSTALL_APPROVAL_STREAM).map(
    (row) => JSON.parse(row.document) as { approvalId: string; result: string; code?: string; generationId?: string; digest: string },
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-install-approval-"));
  repo = join(dir, "git-source");
  mkdirSync(repo, { recursive: true });
  git("init", "--quiet");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "fixture");
  ({ ref: gitRef, digest: gitDigest } = commit(JSON.stringify({ id: PACKAGE_ID })));
  indexPath = join(dir, "directory.json");
  services = bootNodeServices({ dataDir: dir, label: "install approval test node" });
  deps = { services, now: () => new Date().toISOString() as Instant };
  previousIndex = process.env["CC_DIRECTORY_INDEX"];
  process.env["CC_DIRECTORY_INDEX"] = indexPath;
  // The fixture's "remote" is a path on this machine, which an install refuses unless a harness opts in, as this does.
  previousAllowLocalGit = process.env["CC_ALLOW_LOCAL_GIT_SOURCES"];
  process.env["CC_ALLOW_LOCAL_GIT_SOURCES"] = "1";
  writeIndex([entry()]);
  askBeforeInstalling();
});

afterEach(() => {
  if (previousIndex === undefined) delete process.env["CC_DIRECTORY_INDEX"];
  else process.env["CC_DIRECTORY_INDEX"] = previousIndex;
  if (previousAllowLocalGit === undefined) delete process.env["CC_ALLOW_LOCAL_GIT_SOURCES"];
  else process.env["CC_ALLOW_LOCAL_GIT_SOURCES"] = previousAllowLocalGit;
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("an install the policy asks about waits in the inbox", () => {
  it("is listed under waiting with the package, the version, what it asks for and the artifact it is about", async () => {
    const approvalId = await askToInstall();
    expect(installedVersions()).toEqual([]);

    expect(await waiting()).toEqual([
      expect.objectContaining({
        kind: "install-approval",
        approvalId,
        packageId: PACKAGE_ID,
        version: VERSION,
        displayName: "Calendar Plus",
        riskTier: "isolated-ui",
        permissions: ["Reads your calendar"],
        operationDigest: gitDigest,
      }),
    ]);
    // Asking again while it waits is the same question, not a second item.
    expect(await askToInstall()).toBe(approvalId);
    expect(await waiting()).toHaveLength(1);
    expect(audit()).toEqual([expect.objectContaining({ approvalId, result: "asked", digest: gitDigest })]);
  });

  it("shows the origins, keys and browser-token providers the listing says the package reaches", async () => {
    const reach = {
      browserTokens: [{ provider: "example.maps", scopes: ["tiles:read"], purpose: "Draws the map tiles." }],
      secrets: [{ name: "CALENDAR_API_KEY", purpose: "Signs the agenda requests in." }],
      origins: [{ origin: "https://api.example.com", purpose: "Reads your agenda.", secret: "CALENDAR_API_KEY" }],
    };
    writeIndex([entry({ declaredReach: reach })]);
    const approvalId = await askToInstall();

    const [item] = await waiting();
    expect(item).toMatchObject({ approvalId, reach });
    // Names and purposes only: there is nothing in the question that could be a key's value.
    expect(Object.keys(item?.kind === "install-approval" ? (item.reach?.secrets[0] ?? {}) : {})).toEqual(["name", "purpose"]);
  });

  it("installs nothing on approval when the artifact declares a reach other than the question showed", async () => {
    // The question shows a browser token; the artifact (one widget file, no manifest) declares none.
    writeIndex([
      entry({
        declaredReach: {
          origins: [],
          secrets: [],
          browserTokens: [{ provider: "example.maps", scopes: ["tiles:read"], purpose: "Draws the map tiles." }],
        },
      }),
    ]);
    const approvalId = await askToInstall();

    const decided = await decide(approvalId, "granted");
    expect(codeOf(decided)).toBe("DECLARED_REACH_MISMATCH");
    expect(installedVersions()).toEqual([]);
  });

  it("is not listed once the directory no longer lists the artifact it asked about", async () => {
    await askToInstall();
    const republished = commit(JSON.stringify({ id: PACKAGE_ID, changed: true }));
    writeIndex([entry({ source: { kind: "git", url: repo, ref: republished.ref }, digest: republished.digest })]);
    expect(await waiting()).toEqual([]);
    writeIndex([]);
    expect(await waiting()).toEqual([]);
  });
});

describe("the person's answer", () => {
  it("installs on Approve, through the same install, once", async () => {
    const approvalId = await askToInstall();

    const approved = await decide(approvalId, "granted");
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ decision: "granted", installed: { packageId: PACKAGE_ID, version: VERSION }, state: "active" });
    const generationId = (approved.body as { generationId: string }).generationId;
    expect(generationId).toContain(`${PACKAGE_ID}@${VERSION}`);
    expect(installedVersions()).toEqual([VERSION]);
    expect(approvalDecision(approvalId)).toBe("granted");
    expect(await waiting()).toEqual([]);

    // A second press is not a second install.
    const again = await decide(approvalId, "granted");
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe("APPROVAL_ALREADY_DECIDED");
    expect(installedVersions()).toEqual([VERSION]);

    expect(audit().map((event) => [event.result, event.code, event.generationId])).toEqual([
      ["asked", undefined, undefined],
      ["installed", undefined, generationId],
      ["refused", "APPROVAL_ALREADY_DECIDED", undefined],
    ]);
  });

  it("installs nothing on Deny", async () => {
    const approvalId = await askToInstall();

    const denied = await decide(approvalId, "denied");
    expect(denied.status).toBe(200);
    expect(denied.body).toEqual({ decision: "denied", packageId: PACKAGE_ID, version: VERSION });
    expect(installedVersions()).toEqual([]);
    expect(approvalDecision(approvalId)).toBe("denied");
    expect(await waiting()).toEqual([]);
    // Approving after a denial does not install either.
    expect(codeOf(await decide(approvalId, "granted"))).toBe("APPROVAL_ALREADY_DECIDED");
    expect(installedVersions()).toEqual([]);
    expect(audit().map((event) => event.result)).toEqual(["asked", "denied", "refused"]);
  });

  it("installs nothing once the approval has expired, decided late or swept", async () => {
    const late = await askToInstall();
    services.runtime.db.prepare("UPDATE approvals SET expires_at = ? WHERE approval_id = ?").run("2020-01-01T00:00:00.000Z", late);
    expect(await waiting()).toEqual([]);
    const decidedLate = await decide(late, "granted");
    expect(decidedLate.status).toBe(409);
    expect(codeOf(decidedLate)).toBe("APPROVAL_EXPIRED");
    expect(installedVersions()).toEqual([]);
    expect(approvalDecision(late)).toBe("expired");

    // Nobody answers the next one: the sweep settles it, audits it once and tells the person nothing was installed.
    const swept = await askToInstall();
    expect(swept).not.toBe(late);
    const past = new Date(Date.now() - 60_000).toISOString();
    services.runtime.db.prepare("UPDATE approvals SET expires_at = ? WHERE approval_id = ?").run(past, swept);
    sweepExpired(services, new Date().toISOString() as Instant);
    sweepExpired(services, new Date().toISOString() as Instant);
    expect(approvalDecision(swept)).toBe("expired");
    expect(installedVersions()).toEqual([]);
    const inbox = inboxResponseSchema.parse((await call("GET", "/inbox")).body);
    expect(inbox.notices.filter((notice) => notice.title === "Yêu cầu cài đặt đã hết hạn, chưa có gì được cài")).toHaveLength(1);
    expect(codeOf(await decide(swept, "granted"))).toBe("APPROVAL_ALREADY_DECIDED");
    expect(installedVersions()).toEqual([]);

    expect(audit().map((event) => [event.approvalId === late ? "late" : "swept", event.result, event.code])).toEqual([
      ["late", "asked", undefined],
      ["late", "expired", "APPROVAL_EXPIRED"],
      ["swept", "asked", undefined],
      ["swept", "expired", undefined],
      ["swept", "refused", "APPROVAL_ALREADY_DECIDED"],
    ]);
  });
});

describe("settling an expired install approval", () => {
  it("leaves one the person decided between the sweep's read and its write as they decided it", async () => {
    const approvalId = await askToInstall();
    expect((await decide(approvalId, "denied")).status).toBe(200);
    // The sweep read the row while it was still pending; by the time it writes, the person has answered.
    expect(expireInstallApprovals(services, [{ approval_id: approvalId, operation_description: "cài" }])).toEqual([]);
    expect(approvalDecision(approvalId)).toBe("denied");
    expect(audit().map((event) => event.result)).toEqual(["asked", "denied"]);
  });
});

describe("an approval stays bound to the artifact it was given for", () => {
  it("does not install a listing republished after the ask, and leaves the question as it was", async () => {
    const approvalId = await askToInstall();
    const republished = commit(JSON.stringify({ id: PACKAGE_ID, changed: true }));
    writeIndex([entry({ source: { kind: "git", url: repo, ref: republished.ref }, digest: republished.digest })]);

    const refused = await decide(approvalId, "granted");
    expect(refused.status).toBe(409);
    expect(codeOf(refused)).toBe("DIGEST_MISMATCH");
    expect(installedVersions()).toEqual([]);
    // Not claimed: nothing was decided on bytes nobody was shown.
    expect(approvalDecision(approvalId)).toBe("pending");
    // Nor does the new digest decide the old question.
    expect(codeOf(await decide(approvalId, "granted", republished.digest))).toBe("APPROVAL_FORGED");
    expect(installedVersions()).toEqual([]);
    expect(audit().map((event) => [event.result, event.code])).toEqual([
      ["asked", undefined],
      ["refused", "DIGEST_MISMATCH"],
      ["refused", "APPROVAL_FORGED"],
    ]);
  });

  it("refuses a decision made on another digest than the one asked about", async () => {
    const approvalId = await askToInstall();
    const forged = await decide(approvalId, "granted", "sha256:0000");
    expect(forged.status).toBe(409);
    expect(codeOf(forged)).toBe("APPROVAL_FORGED");
    expect(approvalDecision(approvalId)).toBe("pending");
    expect(installedVersions()).toEqual([]);
  });

  it("has the install itself refuse an approval given for another artifact", async () => {
    const approvalId = await askToInstall();
    const outcome = await installPackage(
      packageInstallDepsOf(services),
      { packageId: PACKAGE_ID, version: VERSION },
      { approved: { approvalId, digest: "sha256:not-the-listed-one" } },
    );
    expect(outcome).toMatchObject({ kind: "refused", status: 409, code: "DIGEST_MISMATCH" });
    expect(installedVersions()).toEqual([]);
  });

  it("ends what the frames were given under the old code when an install replaces it", async () => {
    writePolicy(DEFAULT_EXECUTION_POLICY_CONFIG);
    const ended: string[] = [];
    const installDeps = { ...packageInstallDepsOf(services), packageCodeEnded: (packageId: string) => ended.push(packageId) };
    expect(await installPackage(installDeps, { packageId: PACKAGE_ID, version: VERSION })).toMatchObject({ kind: "installed" });
    const next = commit(JSON.stringify({ id: PACKAGE_ID, changed: true }));
    writeIndex([entry({ version: "1.3.0", source: { kind: "git", url: repo, ref: next.ref }, digest: next.digest })]);
    ended.length = 0;
    expect(await installPackage(installDeps, { packageId: PACKAGE_ID, version: "1.3.0" })).toMatchObject({ kind: "installed" });
    expect(installedVersions().sort()).toEqual([VERSION, "1.3.0"]);
    // The broker withdraws the tokens the 1.2.0 frames hold, and a mint racing the update is refused.
    expect(ended).toEqual([PACKAGE_ID]);
  });

  it("still honours a policy that now forbids installing, even after Approve", async () => {
    const approvalId = await askToInstall();
    writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, prohibition: "all" });

    const refused = await decide(approvalId, "granted");
    expect(refused.status).toBe(403);
    expect(codeOf(refused)).toBe("POLICY_REFUSED");
    expect(installedVersions()).toEqual([]);
    expect(audit().map((event) => [event.result, event.code])).toEqual([
      ["asked", undefined],
      ["refused", "POLICY_REFUSED"],
    ]);
  });
});

describe("a package listed by a path on this machine", () => {
  /** What the listing says the artifact is. A local listing's digest is the publisher's, not a hash this node made. */
  const LISTED_DIGEST = "sha256:local-calendar-listing";
  let localDir: string;

  /** The content digest an approval pins: the one a git or npm fetch computes over the bytes it holds. */
  const onDisk = (): string => {
    const digest = digestOfDirectory(localDir, { exclude: [".git"] });
    if (!digest.ok) throw new Error(digest.message);
    return digest.digest;
  };

  const generationDigests = (): string[] =>
    allRows<{ digest: string }>(services.runtime.db, "SELECT digest FROM package_generations WHERE package_id = ?", PACKAGE_ID).map(
      (row) => row.digest,
    );

  beforeEach(() => {
    localDir = join(dir, "local-calendar");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, "widget.json"), JSON.stringify({ id: PACKAGE_ID }));
    writeIndex([entry({ source: { kind: "local", path: localDir }, digest: LISTED_DIGEST })]);
  });

  it("installs on Approve, and records the bytes the question was asked about", async () => {
    const approvalId = await askToInstall();
    expect(await waiting()).toEqual([expect.objectContaining({ approvalId, operationDigest: LISTED_DIGEST })]);
    expect(audit()).toEqual([expect.objectContaining({ approvalId, result: "asked", digest: LISTED_DIGEST, localDigest: onDisk() })]);

    const approved = await decide(approvalId, "granted", LISTED_DIGEST);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ decision: "granted", installed: { packageId: PACKAGE_ID, version: VERSION }, state: "active" });
    expect(installedVersions()).toEqual([VERSION]);
    // The generation carries the listing's digest, as a local install that sent it does, so everything that finds a
    // package by its listing (its files, its themes, its capability approvals) finds this one.
    expect(generationDigests()).toEqual([LISTED_DIGEST]);
    expect(approvalDecision(approvalId)).toBe("granted");
    expect(audit().map((event) => event.result)).toEqual(["asked", "installed"]);
  });

  it("refuses Approve when the files changed after the question, and asks again about what they are now", async () => {
    const approvalId = await askToInstall();
    writeFileSync(join(localDir, "widget.json"), JSON.stringify({ id: PACKAGE_ID, changed: true }));

    // Approve could only be refused now, so the question is no longer offered.
    expect(await waiting()).toEqual([]);
    const refused = await decide(approvalId, "granted", LISTED_DIGEST);
    expect(refused.status).toBe(409);
    expect(codeOf(refused)).toBe("DIGEST_MISMATCH");
    expect((refused.body as { message: string }).message).toContain("files on this machine changed after you were asked");
    expect(installedVersions()).toEqual([]);
    expect(approvalDecision(approvalId)).toBe("pending");

    // Installing it again is a new question about the files as they are, not the stale one.
    const askedAgain = await askToInstall();
    expect(askedAgain).not.toBe(approvalId);
    expect((await decide(askedAgain, "granted", LISTED_DIGEST)).status).toBe(200);
    expect(installedVersions()).toEqual([VERSION]);
    expect(audit().map((event) => [event.approvalId === approvalId ? "first" : "again", event.result, event.code])).toEqual([
      ["first", "asked", undefined],
      ["first", "refused", "DIGEST_MISMATCH"],
      ["again", "asked", undefined],
      ["again", "installed", undefined],
    ]);
  });

  it("has the install itself refuse an approval pinned to other files", async () => {
    const approvalId = await askToInstall();
    const pinned = onDisk();
    writeFileSync(join(localDir, "extra.txt"), "added after the question");

    const outcome = await installPackage(
      packageInstallDepsOf(services),
      { packageId: PACKAGE_ID, version: VERSION },
      { approved: { approvalId, digest: LISTED_DIGEST, localDigest: pinned } },
    );
    expect(outcome).toMatchObject({ kind: "refused", status: 409, code: "DIGEST_MISMATCH" });
    // An approval that pinned no files at all is not an approval for whatever is there now either.
    const unpinned = await installPackage(
      packageInstallDepsOf(services),
      { packageId: PACKAGE_ID, version: VERSION },
      { approved: { approvalId, digest: LISTED_DIGEST } },
    );
    expect(unpinned).toMatchObject({ kind: "refused", status: 409, code: "DIGEST_MISMATCH" });
    expect(installedVersions()).toEqual([]);
  });

  describe("installed straight from the listing, in a mode that does not ask first", () => {
    beforeEach(() => writePolicy(DEFAULT_EXECUTION_POLICY_CONFIG));

    const install = (body: Record<string, unknown> = {}) =>
      call("POST", "/packages/install", { packageId: PACKAGE_ID, version: VERSION, ...body });
    const approvals = () => allRows(services.runtime.db, "SELECT approval_id FROM approvals");

    /** The listing as the app shows it: the node's own search card, with what it showed of the files. */
    async function listed(): Promise<Record<string, unknown> | undefined> {
      const tool = createSearchDirectoryTool({ indexPath, newId: () => "market_local" });
      const answer = await tool.execute({ query: "" });
      return (answer.hostCard?.["results"] as Record<string, unknown>[] | undefined)?.[0];
    }

    it("installs with no digest from the client, under the listing's digest, without asking", async () => {
      const installed = await install();
      expect(installed.status).toBe(200);
      expect(installed.body).toMatchObject({ installed: { packageId: PACKAGE_ID, version: VERSION }, state: "active" });
      expect(installedVersions()).toEqual([VERSION]);
      // The same identity an approved install of this listing records, so both find the package by its listing.
      expect(generationDigests()).toEqual([LISTED_DIGEST]);
      expect(approvals()).toEqual([]);
    });

    it("installs the files the listing showed, sent back as the listing carried them", async () => {
      const result = await listed();
      expect(result).toMatchObject({ packageId: PACKAGE_ID, digest: LISTED_DIGEST, contentDigest: onDisk() });

      const installed = await install({ contentDigest: result?.contentDigest });
      expect(installed.status).toBe(200);
      expect(installedVersions()).toEqual([VERSION]);
      expect(generationDigests()).toEqual([LISTED_DIGEST]);
    });

    it("installs nothing when the files changed after they were listed, whatever the mode", async () => {
      const shown = (await listed())?.contentDigest;
      writeFileSync(join(localDir, "widget.json"), JSON.stringify({ id: PACKAGE_ID, changed: true }));

      const refused = await install({ contentDigest: shown });
      expect(refused.status).toBe(409);
      expect(codeOf(refused)).toBe("DIGEST_MISMATCH");
      expect((refused.body as { message: string }).message).toBe(localFilesChangedMessage(PACKAGE_ID, VERSION));
      expect(installedVersions()).toEqual([]);

      // A mode that asks refuses it the same way, rather than asking about files nobody was shown.
      askBeforeInstalling();
      const asked = await install({ contentDigest: shown });
      expect(asked.status).toBe(409);
      expect(codeOf(asked)).toBe("DIGEST_MISMATCH");
      expect(approvals()).toEqual([]);
      expect(installedVersions()).toEqual([]);
    });

    it("refuses a path whose files cannot be read, and installs nothing", async () => {
      rmSync(localDir, { recursive: true, force: true });
      // Nothing to show either: the listing carries no content digest for files it could not read.
      expect(await listed()).not.toHaveProperty("contentDigest");

      const refused = await install();
      expect(refused.status).toBe(400);
      expect(codeOf(refused)).toBe("LOCAL_SOURCE_UNREADABLE");
      expect(installedVersions()).toEqual([]);
      expect(approvals()).toEqual([]);
    });

    it("still installs for a client that names the plan's digest itself, under the digest it named", async () => {
      const installed = await install({ localDigest: "sha256:client-chosen" });
      expect(installed.status).toBe(200);
      expect(installedVersions()).toEqual([VERSION]);
      expect(generationDigests()).toEqual(["sha256:client-chosen"]);
    });

    it("refuses such a client too when it also sends what the listing showed and the files changed since", async () => {
      const shown = (await listed())?.contentDigest;
      writeFileSync(join(localDir, "extra.txt"), "added after the listing");

      const refused = await install({ localDigest: "sha256:client-chosen", contentDigest: shown });
      expect(refused.status).toBe(409);
      expect(codeOf(refused)).toBe("DIGEST_MISMATCH");
      expect(installedVersions()).toEqual([]);
    });

    it("asks about the files the listing showed in a mode that asks, once however often Install is pressed", async () => {
      askBeforeInstalling();
      const shown = (await listed())?.contentDigest;

      const asked = await install({ contentDigest: shown });
      expect(asked.status).toBe(202);
      const approvalId = (asked.body as { approvalId: string }).approvalId;
      expect(audit()).toEqual([expect.objectContaining({ approvalId, result: "asked", digest: LISTED_DIGEST, localDigest: shown })]);
      expect(((await install({ contentDigest: shown })).body as { approvalId: string }).approvalId).toBe(approvalId);
      expect(installedVersions()).toEqual([]);
    });

    it("is a card the conversation accepts as a host card", async () => {
      const tool = createSearchDirectoryTool({ indexPath, newId: () => "market_local" });
      const answer = await tool.execute({ query: "" });
      // The same check a tool's host card passes before it is drawn; a shape it refuses is dropped from the turn.
      expect(messageBlockSchema.safeParse(answer.hostCard).success).toBe(true);
    });
  });
});

describe("machine surfaces cannot install or decide an install", () => {
  it("lists both routes as person-only, matching the raw segments", () => {
    expect(isPersonOnlyRoute("POST", "/packages/install")).toBe(true);
    expect(isPersonOnlyRoute("POST", "//packages//install/")).toBe(true);
    expect(isPersonOnlyRoute("post", "/packages/install?x=1")).toBe(true);
    expect(isPersonOnlyRoute("POST", "/packages/approvals/appr_1/decision")).toBe(true);
    // Reading what is installed, and the rest of package management the agents use, stays reachable.
    expect(isPersonOnlyRoute("GET", "/packages/install")).toBe(false);
    expect(isPersonOnlyRoute("POST", "/packages/uninstall")).toBe(false);
    expect(isPersonOnlyRoute("POST", "/packages/installed")).toBe(false);
    expect(PERSON_ONLY_REFUSAL.message).toContain("installing packages");
  });

  it("refuses a request the MCP endpoint or the relay forwarded, and installs nothing", async () => {
    for (const surface of ["mcp", "relay"]) {
      const install = await call("POST", "/packages/install", { packageId: PACKAGE_ID, version: VERSION }, { [SURFACE_HEADER]: surface });
      expect(install.status, surface).toBe(403);
      expect(codeOf(install), surface).toBe("PERSON_ONLY");
    }
    expect(allRows(services.runtime.db, "SELECT approval_id FROM approvals")).toEqual([]);

    const approvalId = await askToInstall();
    for (const surface of ["mcp", "relay"]) {
      const approve = await decide(approvalId, "granted", gitDigest, { [SURFACE_HEADER]: surface });
      expect(approve.status, surface).toBe(403);
      expect(codeOf(approve), surface).toBe("PERSON_ONLY");
    }
    expect(approvalDecision(approvalId)).toBe("pending");
    expect(installedVersions()).toEqual([]);
    // The person's own surface still decides it.
    expect((await decide(approvalId, "granted")).status).toBe(200);
    expect(installedVersions()).toEqual([VERSION]);
  });

  it("gives the model no way to install: the package tool lists, uninstalls, restores and rolls back only", async () => {
    const tool = createManagePackageTool({
      packages: { runtime: services.runtime, conductor: services.conductor },
      conversationId: "conv_1",
      channel: () => "chat",
    });
    expect(JSON.stringify(tool.parameters)).not.toContain('"install"');
    await tool.execute({ action: "install", packageId: PACKAGE_ID, version: VERSION });
    expect(installedVersions()).toEqual([]);
    expect(allRows(services.runtime.db, "SELECT approval_id FROM approvals")).toEqual([]);
  });
});

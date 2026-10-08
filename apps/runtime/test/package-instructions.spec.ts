import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type Instant,
  MACHINE_SURFACE_HEADER,
  PACKAGE_INSTRUCTION_LIMITS,
  PACKAGE_INSTRUCTIONS_PREFERENCE,
  isPersonOnlyRoute,
  platformForHost,
} from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, digestOfDirectory, writeRegisteredPreference } from "@clarkcant/core";
import { allRows, putPreference } from "@clarkcant/storage";

import {
  auditPackageInstructions,
  enabledPackageInstructionSets,
  packageInstructionsDepsOf,
  requestPackageInstructions,
  runApprovedPackageInstructions,
} from "../src/application/package-instructions.ts";
import { nodeConditionalInstructions } from "../src/bootstrap/model-bootstrap.ts";
import {
  type ActiveInstruction,
  type InstructionTouch,
  type PackageInstructionSet,
  INSTRUCTION_LIMITS,
  PACKAGE_INSTRUCTIONS_NOTE,
  createConditionalInstructions,
  instructionSection,
  taskInstructions,
  turnInstructions,
} from "../src/conditional-instructions.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { createManagePackageTool } from "../src/manage-package-tool.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * Package instructions: conditional rules a package carries, stated only where the person turned them on.
 *
 * What has to hold: installing a package states nothing; its rules apply only inside a project the person enabled them
 * for, and only while that project is inside a granted root; the project's own instructions come first and a package's
 * get their own capped slice; a snippet above the model's data classes is withheld; every package snippet is labelled
 * and audited with the package id and version; a package's `pin` is ignored; and turning it off or uninstalling it
 * removes its rules from the next turn.
 */

const write = (path: string): InstructionTouch => ({ path, operation: "write", capability: "edit_file" });

describe("a package's rules in the matcher", () => {
  let root: string;
  let project: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cc-package-instructions-"));
    project = join(root, "clark");
    mkdirSync(join(project, ".clarkcant", "instructions"), { recursive: true });
    mkdirSync(join(project, "packages", "storage"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const set = (overrides: Partial<PackageInstructionSet> = {}, text = "Viết test trước khi sửa."): PackageInstructionSet => ({
    packageId: "com.example.style",
    version: "1.2.0",
    facets: [
      {
        facetId: "rules",
        rules: [{ when: { path: "packages/**", operation: "write" }, include: ["style"], pin: true }],
        snippets: new Map([["style", text]]),
      },
    ],
    projects: [project],
    ...overrides,
  });

  const reader = (sets: () => readonly PackageInstructionSet[], roots: readonly string[] = [root]) =>
    createConditionalInstructions({ roots: () => roots, packages: sets });

  const state = (touched: InstructionTouch[]) => ({ touched, role: "foreground" as const, skills: [] });

  it("states nothing from a package with no enabled project, and its rules once one is enabled", () => {
    const touched = [write(join(project, "packages", "storage", "a.ts"))];
    expect(reader(() => [set({ projects: [] })]).active(state(touched))).toEqual([]);
    expect(reader(() => []).active(state(touched))).toEqual([]);
    const active = reader(() => [set()]).active(state(touched));
    expect(active).toEqual([
      {
        id: "package:com.example.style@1.2.0#rules/style",
        source: "com.example.style@1.2.0/style",
        text: "Viết test trước khi sửa.",
        pin: false,
        package: { id: "com.example.style", version: "1.2.0", snippet: "style" },
      },
    ]);
  });

  it("applies only inside the enabled project, and only while that project is inside a granted root", () => {
    const other = join(root, "other");
    mkdirSync(join(other, "packages"), { recursive: true });
    expect(reader(() => [set()]).active(state([write(join(other, "packages", "a.ts"))]))).toEqual([]);
    // The root was withdrawn: the enablement stays, the rules do not apply.
    const elsewhere = mkdtempSync(join(tmpdir(), "cc-package-elsewhere-"));
    try {
      expect(reader(() => [set()], [elsewhere]).active(state([write(join(project, "packages", "a.ts"))]))).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
    // `when.project` names the enabled folder.
    const named = set({
      facets: [{ facetId: "rules", rules: [{ when: { project: "other-name" }, include: ["style"] }], snippets: new Map([["style", "x"]]) }],
    });
    expect(reader(() => [named]).active(state([write(join(project, "a.ts"))]))).toEqual([]);
  });

  it("includes only the facet's own snippets, by name", () => {
    writeFileSync(join(project, ".clarkcant", "instructions", "secret.md"), "dự án", "utf8");
    const asks = set({
      facets: [{ facetId: "rules", rules: [{ when: { path: "**" }, include: ["secret"] }], snippets: new Map() }],
    });
    expect(reader(() => [asks]).active(state([write(join(project, "a.ts"))]))).toEqual([]);
  });

  it("puts the project's own first, ignores a package's pin, and labels each package block with its id and version", () => {
    writeFileSync(
      join(project, ".clarkcant", "instructions.json"),
      JSON.stringify({ version: 1, rules: [{ when: { path: "packages/**" }, include: ["own"] }] }),
      "utf8",
    );
    writeFileSync(join(project, ".clarkcant", "instructions", "own.md"), "Quy tắc của dự án.", "utf8");
    const active = reader(() => [set()]).active(state([write(join(project, "packages", "storage", "a.ts"))]));
    expect(active.map((entry) => entry.source)).toEqual(["clark/.clarkcant/instructions/own.md", "com.example.style@1.2.0/style"]);
    // Handed in the other order, the section still states the project's first.
    const first = instructionSection({ active: [...active].reverse(), stated: new Set(), nonce: "n1" });
    const lines = first.text.split("\n");
    expect(lines[1]).toBe(PACKAGE_INSTRUCTIONS_NOTE);
    expect(first.text.indexOf("Quy tắc của dự án.")).toBeLessThan(first.text.indexOf("Viết test trước khi sửa."));
    expect(first.text).toContain(
      `<project-instruction nonce="n1" package="com.example.style@1.2.0" source="com.example.style@1.2.0/style">\nViết test trước khi sửa.\n</project-instruction nonce="n1">`,
    );
    expect(first.packages).toEqual([{ package: { id: "com.example.style", version: "1.2.0", snippet: "style" }, outcome: "stated" }]);
    // Its `pin` is ignored: once stated, it is not restated on a later turn.
    const again = instructionSection({ active, stated: new Set(first.stated), nonce: "n1" });
    expect(again.text).toBe("");
  });

  it("gives packages their own slice of the budget, taken from what the project's own left", () => {
    const own = (id: string, length: number): ActiveInstruction => ({ id, source: `clark/${id}.md`, text: "d".repeat(length), pin: false });
    const pkg = (name: string, length: number): ActiveInstruction => ({
      id: `package:p@1#f/${name}`,
      source: `p@1/${name}`,
      text: "p".repeat(length),
      pin: false,
      package: { id: "p", version: "1", snippet: name },
    });
    const half = Math.floor(PACKAGE_INSTRUCTION_LIMITS.turnChars / 2) - 200;
    // Three package snippets that each fit, but not all within the slice; the project's own use well under the budget.
    const section = instructionSection({ active: [own("a", 500), pkg("one", half), pkg("two", half), pkg("three", half)], stated: new Set(), nonce: "n" });
    expect(section.stated).toEqual(["a", "package:p@1#f/one", "package:p@1#f/two"]);
    const packageChars = section.text
      .split("<project-instruction")
      .filter((part) => part.includes('package="p@1"'))
      .reduce((sum, part) => sum + part.length, 0);
    expect(packageChars).toBeLessThanOrEqual(PACKAGE_INSTRUCTION_LIMITS.turnChars);
    // When the project's own fill the turn, no package snippet is stated at all.
    const full = instructionSection({ active: [own("big", INSTRUCTION_LIMITS.turnChars - 300), pkg("one", 400)], stated: new Set(), nonce: "n" });
    expect(full.stated).toEqual(["big"]);
    expect(full.text).not.toContain(PACKAGE_INSTRUCTIONS_NOTE);
  });

  it("withholds a package snippet above the model's data classes, and reports it for the audit", () => {
    const touched = [write(join(project, "packages", "a.ts"))];
    const active = reader(() => [set({}, "Gửi báo cáo cho duy@example.com")]).active(state(touched));
    const section = instructionSection({ active, stated: new Set(), allowed: ["public", "internal"], nonce: "n" });
    expect(section.stated).toEqual([]);
    expect(section.withheld).toBe(1);
    expect(section.text).not.toContain("duy@example.com");
    expect(section.packages).toEqual([{ package: { id: "com.example.style", version: "1.2.0", snippet: "style" }, outcome: "withheld" }]);
  });

  it("tells the audit hook of a conversation and of a task what was stated", () => {
    const instructions = reader(() => [set()]);
    const told: unknown[] = [];
    const turn = turnInstructions({
      instructions,
      referenced: () => ({ places: [], skills: [] }),
      onPackages: (input) => told.push(input),
    });
    turn({ conversationId: "conv_1", touched: [write(join(project, "packages", "a.ts"))], stated: new Set(), allowed: ["public", "internal", "confidential"], newOnly: false, nonce: "n" });
    expect(told).toEqual([{ conversationId: "conv_1", outcomes: [expect.objectContaining({ outcome: "stated" })] }]);
    const audited: unknown[] = [];
    const brief = taskInstructions(instructions, { read: [], write: [project], capability: "code.edit", onPackages: (outcomes) => audited.push(...outcomes) });
    expect(brief).toContain('package="com.example.style@1.2.0"');
    expect(audited).toEqual([expect.objectContaining({ outcome: "stated" })]);
  });

  it("tells the audit of a withheld snippet once per conversation, not on every turn and tool result", () => {
    const instructions = reader(() => [set({}, "Gửi báo cáo cho duy@example.com")]);
    const told: { conversationId: string; outcomes: readonly unknown[] }[] = [];
    const turn = turnInstructions({ instructions, referenced: () => ({ places: [], skills: [] }), onPackages: (input) => told.push(input) });
    const ask = (conversationId: string, newOnly: boolean) =>
      turn({ conversationId, touched: [write(join(project, "packages", "a.ts"))], stated: new Set(), allowed: ["public", "internal"], newOnly, nonce: "n" });
    ask("conv_1", false);
    ask("conv_1", true);
    ask("conv_1", false);
    ask("conv_2", false);
    expect(told.map((entry) => entry.conversationId)).toEqual(["conv_1", "conv_2"]);
    expect(told[0]?.outcomes).toEqual([expect.objectContaining({ outcome: "withheld" })]);
  });
});

/*
 * On a node: a package listed by a local path, and one fetched from a git source, each installed through the package
 * routes, contribute only after the person turned them on for a project; turning one off or uninstalling it ends that.
 */
describe("installed packages on a node", () => {
  const AT = "2026-10-08T03:00:00.000Z";
  const HOST_PLATFORM = platformForHost(process.platform, process.arch) ?? "web";
  let dir: string;
  let workspace: string;
  let project: string;
  let services: NodeServices;
  let deps: GatewayDeps;
  let indexPath: string;
  let entries: Record<string, unknown>[];
  let previousIndex: string | undefined;
  let previousAllowLocalGit: string | undefined;

  const manifest = (id: string, version = "1.0.0"): Record<string, unknown> => ({
    schemaVersion: 3,
    id,
    version,
    displayName: id,
    description: "A package that carries project instructions.",
    hostApi: { min: 1, max: 1 },
    facets: [{ kind: "instructions", id: "rules", entry: "rules/instructions.json", isolation: "declarative" }],
    requestedCapabilities: [],
    permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
    platforms: ["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64", "web"],
  });

  function writePackage(folder: string, id: string, text: string, version = "1.0.0"): void {
    mkdirSync(join(folder, "rules", "instructions"), { recursive: true });
    writeFileSync(join(folder, "clarkcant.json"), JSON.stringify(manifest(id, version)));
    writeFileSync(
      join(folder, "rules", "instructions.json"),
      JSON.stringify({ version: 1, rules: [{ when: { path: "src/**", operation: "write" }, include: ["style"] }] }),
    );
    writeFileSync(join(folder, "rules", "instructions", "style.md"), text);
  }

  function listing(id: string, source: Record<string, unknown>, digest: string, version = "1.0.0"): Record<string, unknown> {
    return {
      packageId: id,
      version,
      displayName: id,
      description: "A package that carries project instructions.",
      source,
      publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
      preview: {},
      facets: ["instructions"],
      isolations: [{ facetKind: "instructions", isolation: "declarative" }],
      platforms: [HOST_PLATFORM],
      hostApi: { min: 1, max: 1 },
      permissionsSummary: [],
      riskTier: "declarative",
      sizeBytes: 512,
      digest,
    };
  }

  async function call(method: string, path: string, body?: unknown): Promise<GatewayResponse> {
    return handleRequest(deps, {
      method,
      path,
      query: {},
      headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
      body: body === undefined ? "" : JSON.stringify(body),
    });
  }

  /** A package listed by a path on this machine, installed by its id with the digest of its bytes. */
  async function installLocal(version = "1.0.0", text = "Quy tắc của gói cục bộ."): Promise<void> {
    const folder = join(dir, `local-package-${version}`);
    writePackage(folder, "com.example.local", text, version);
    const digest = digestOfDirectory(folder, { exclude: [] });
    if (!digest.ok) throw new Error(digest.message);
    if (!entries.some((entry) => entry["packageId"] === "com.example.local" && entry["version"] === version)) {
      entries.push(listing("com.example.local", { kind: "local", path: folder }, digest.digest, version));
    }
    writeFileSync(indexPath, JSON.stringify(entries));
    const response = await call("POST", "/packages/install", { packageId: "com.example.local", version, localDigest: digest.digest });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  }

  /** A package fetched from a git source and verified against its listed digest. */
  async function installFromGit(): Promise<void> {
    const repo = join(dir, "git-package");
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]): string => {
      const result = spawnSync("git", ["-C", repo, ...args]);
      if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
      return result.stdout.toString().trim();
    };
    git("init", "--quiet");
    git("config", "user.email", "fixture@example.com");
    git("config", "user.name", "fixture");
    git("config", "core.autocrlf", "false");
    writePackage(repo, "com.example.fetched", "Quy tắc của gói đã cài.");
    git("add", ".");
    git("commit", "--quiet", "-m", "package");
    const digest = digestOfDirectory(repo, { exclude: [".git"] });
    if (!digest.ok) throw new Error(digest.message);
    entries.push(listing("com.example.fetched", { kind: "git", url: repo, ref: git("rev-parse", "HEAD") }, digest.digest));
    writeFileSync(indexPath, JSON.stringify(entries));
    const response = await call("POST", "/packages/install", { packageId: "com.example.fetched", version: "1.0.0" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  }

  const tool = () =>
    createManagePackageTool({
      packages: { runtime: services.runtime, conductor: services.conductor },
      instructions: () => packageInstructionsDepsOf(services),
      conversationId: "conv_1",
      channel: () => "chat",
    });

  const stated = (): string[] =>
    (nodeConditionalInstructions({}, services)?.active({ touched: [write(join(project, "src", "a.ts"))], role: "foreground", skills: [] }) ?? []).map(
      (entry) => entry.text,
    );

  const enabled = (): unknown =>
    allRows<{ value: string }>(services.runtime.db, "SELECT value FROM preferences WHERE key = ?", PACKAGE_INSTRUCTIONS_PREFERENCE).map((row) =>
      JSON.parse(row.value) as unknown,
    )[0] ?? [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clarkcant-package-instructions-"));
    workspace = join(dir, "workspace");
    project = join(workspace, "app");
    mkdirSync(join(project, "src"), { recursive: true });
    indexPath = join(dir, "directory.json");
    entries = [];
    writeFileSync(indexPath, "[]");
    services = bootNodeServices({ dataDir: dir, label: "package instructions test node" });
    deps = { services, now: () => AT as Instant };
    putPreference(services.runtime.db, {
      principalId: services.runtime.identity.ownerPrincipalId,
      key: "workspace.roots",
      value: JSON.stringify([workspace]),
      scope: "global",
      source: "user",
      at: AT as Instant,
    });
    previousIndex = process.env["CC_DIRECTORY_INDEX"];
    process.env["CC_DIRECTORY_INDEX"] = indexPath;
    previousAllowLocalGit = process.env["CC_ALLOW_LOCAL_GIT_SOURCES"];
    process.env["CC_ALLOW_LOCAL_GIT_SOURCES"] = "1";
  });

  afterEach(() => {
    if (previousIndex === undefined) delete process.env["CC_DIRECTORY_INDEX"];
    else process.env["CC_DIRECTORY_INDEX"] = previousIndex;
    if (previousAllowLocalGit === undefined) delete process.env["CC_ALLOW_LOCAL_GIT_SOURCES"];
    else process.env["CC_ALLOW_LOCAL_GIT_SOURCES"] = previousAllowLocalGit;
    services.runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("states a local package's and an installed package's rules only after each is enabled for the project", async () => {
    await installLocal();
    await installFromGit();
    expect(stated()).toEqual([]);
    expect(enabledPackageInstructionSets(packageInstructionsDepsOf(services))).toEqual([]);

    const listed = await tool().execute({ action: "list" });
    expect(listed.text).toContain("com.example.local (com.example.local 1.0.0) chưa bật cho dự án nào");

    const local = await tool().execute({ action: "enable_instructions", packageId: "com.example.local", project });
    expect(local.text).toContain("com.example.local");
    expect(stated()).toEqual(["Quy tắc của gói cục bộ."]);

    await tool().execute({ action: "enable_instructions", packageId: "com.example.fetched", project });
    // Packages in id order, so the same enablements state the same text in the same order.
    expect(stated()).toEqual(["Quy tắc của gói đã cài.", "Quy tắc của gói cục bộ."]);
    expect(enabled()).toEqual([
      { project, packageId: "com.example.local" },
      { project, packageId: "com.example.fetched" },
    ]);
  });

  it("refuses a project outside the granted roots and a package with no instructions, and writes nothing", async () => {
    await installLocal();
    const outside = join(dir, "outside");
    mkdirSync(outside);
    const refused = await tool().execute({ action: "enable_instructions", packageId: "com.example.local", project: outside });
    expect(refused.text).toContain("PROJECT_NOT_GRANTED");
    const missing = await tool().execute({ action: "enable_instructions", packageId: "com.example.none", project });
    expect(missing.text).toContain("PACKAGE_NOT_INSTALLED");
    expect(enabled()).toEqual([]);
  });

  it("asks on the host's card when the policy asks, and writes only what the card showed once approved", async () => {
    await installLocal();
    policy("ask");
    const instructions = packageInstructionsDepsOf(services);
    const asked = requestPackageInstructions(instructions, { packageId: "com.example.local", project, enabled: true, source: "agent" });
    expect(asked.kind).toBe("approval-required");
    if (asked.kind !== "approval-required") return;
    expect(asked.card).toMatchObject({ type: "approval-card", owner: "host", effectCategory: "local-write" });
    expect(stated()).toEqual([]);
    const payload = String(asked.card["payload"]);
    const forged = runApprovedPackageInstructions(instructions, {
      payload: payload.replace(project.replace(/\\/g, "\\\\"), join(workspace, "else").replace(/\\/g, "\\\\")),
      expectedDigest: asked.approval.operationDigest,
      approvalId: asked.approval.approvalId,
    });
    expect(forged).toMatchObject({ ok: false, code: "APPROVAL_FORGED" });
    const approved = runApprovedPackageInstructions(instructions, {
      payload,
      expectedDigest: asked.approval.operationDigest,
      approvalId: asked.approval.approvalId,
    });
    expect(approved.ok).toBe(true);
    expect(stated()).toEqual(["Quy tắc của gói cục bộ."]);
  });

  const effects = (): number => allRows<{ document: string }>(services.runtime.db, "SELECT document FROM events WHERE kind = 'effect.executed'").length;

  function policy(decision?: "ask" | "deny"): void {
    const written = writeRegisteredPreference(
      { db: services.runtime.db, now: () => AT as Instant },
      {
        principalId: services.runtime.identity.ownerPrincipalId,
        key: EXECUTION_POLICY_PREFERENCE_KEY,
        value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, rules: decision === undefined ? [] : [{ effectCategory: "local-write", decision }] },
        source: "user",
      },
    );
    expect(written.ok).toBe(true);
  }

  it("turns one project off from Settings against what is stored now, never puts back what was turned off elsewhere, and is person-only", async () => {
    await installLocal();
    await installFromGit();
    await tool().execute({ action: "enable_instructions", packageId: "com.example.local", project });
    await tool().execute({ action: "enable_instructions", packageId: "com.example.fetched", project });
    expect(stated()).toEqual(["Quy tắc của gói đã cài.", "Quy tắc của gói cục bộ."]);

    expect(isPersonOnlyRoute("POST", "/packages/instructions/turn-off")).toBe(true);
    const machine = await handleRequest(deps, {
      method: "POST",
      path: "/packages/instructions/turn-off",
      query: {},
      headers: { authorization: `Bearer ${services.runtime.identity.localToken}`, [MACHINE_SURFACE_HEADER]: "mcp" },
      body: JSON.stringify({ packageId: "com.example.local", project }),
    });
    expect(machine.status).toBe(403);
    expect(isPersonOnlyRoute("PUT", `/preferences/${PACKAGE_INSTRUCTIONS_PREFERENCE}`)).toBe(true);
    expect(enabled()).toHaveLength(2);

    // Clark turns the fetched package off after Settings last read the list; Settings' click names only its own pair.
    await tool().execute({ action: "disable_instructions", packageId: "com.example.fetched", project });
    const off = await call("POST", "/packages/instructions/turn-off", { packageId: "com.example.local", project });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ packageId: "com.example.local", project, removed: true });
    expect(enabled()).toEqual([]);
    expect(stated()).toEqual([]);

    const again = await call("POST", "/packages/instructions/turn-off", { packageId: "com.example.local", project });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ removed: false });
    expect(enabled()).toEqual([]);
    expect((await call("POST", "/packages/instructions/turn-off", { packageId: "com.example.local" })).status).toBe(400);
  });

  it("forgets a package's projects when it is uninstalled, so installing it again under the same id starts with nothing on", async () => {
    await installLocal();
    await installFromGit();
    await tool().execute({ action: "enable_instructions", packageId: "com.example.local", project });
    await tool().execute({ action: "enable_instructions", packageId: "com.example.fetched", project });

    const uninstalled = await call("POST", "/packages/com.example.local/uninstall");
    expect(uninstalled.status, JSON.stringify(uninstalled.body)).toBe(200);
    expect(enabled()).toEqual([{ project, packageId: "com.example.fetched" }]);
    expect(stated()).toEqual(["Quy tắc của gói đã cài."]);

    expect((await call("POST", "/packages/com.example.local/restore")).status).toBe(200);
    expect(stated()).toEqual(["Quy tắc của gói đã cài."]);
    expect((await call("POST", "/packages/com.example.local/uninstall")).status).toBe(200);
    await installLocal("1.0.0", "Quy tắc khác dưới cùng một id.");
    expect(enabled()).toEqual([{ project, packageId: "com.example.fetched" }]);
    expect(stated()).toEqual(["Quy tắc của gói đã cài."]);
  });

  /** Pairs as a node that stopped between an uninstall and its forget would have left them. */
  function leave(pairs: readonly { project: string; packageId: string }[]): void {
    const written = writeRegisteredPreference(
      { db: services.runtime.db, now: () => AT as Instant },
      { principalId: services.runtime.identity.ownerPrincipalId, key: PACKAGE_INSTRUCTIONS_PREFERENCE, value: pairs, source: "user" },
    );
    expect(written.ok).toBe(true);
  }

  it("completes an uninstall whose forget fails, says so, and leaves the pairs to the next boot's cleanup", async () => {
    await installLocal();
    await installFromGit();
    await tool().execute({ action: "enable_instructions", packageId: "com.example.local", project });
    await tool().execute({ action: "enable_instructions", packageId: "com.example.fetched", project });
    const before = effects();
    // The store refuses this one preference: every other write, the uninstall's own included, still lands.
    services.runtime.db.exec(`
      CREATE TRIGGER forget_fails_insert BEFORE INSERT ON preferences WHEN NEW.key = '${PACKAGE_INSTRUCTIONS_PREFERENCE}'
      BEGIN SELECT RAISE(ABORT, 'injected preference failure'); END;
      CREATE TRIGGER forget_fails_update BEFORE UPDATE ON preferences WHEN NEW.key = '${PACKAGE_INSTRUCTIONS_PREFERENCE}'
      BEGIN SELECT RAISE(ABORT, 'injected preference failure'); END;
    `);
    const warnings: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      warnings.push(String(chunk));
      return true;
    });
    let uninstalled: GatewayResponse;
    try {
      uninstalled = await call("POST", "/packages/com.example.local/uninstall");
    } finally {
      spy.mockRestore();
    }
    expect(uninstalled.status, JSON.stringify(uninstalled.body)).toBe(200);
    expect(uninstalled.body).toMatchObject({ action: "uninstall", packageId: "com.example.local" });
    expect(effects()).toBe(before + 1);
    expect(warnings.some((line) => line.includes("package-instructions-forget-failed") && line.includes("com.example.local"))).toBe(true);
    // The pair is still stored, but its package is gone, so nothing is stated from it.
    expect(enabled()).toEqual([
      { project, packageId: "com.example.local" },
      { project, packageId: "com.example.fetched" },
    ]);
    expect(stated()).toEqual(["Quy tắc của gói đã cài."]);

    services.runtime.db.exec("DROP TRIGGER forget_fails_insert; DROP TRIGGER forget_fails_update;");
    services.runtime.close();
    services = bootNodeServices({ dataDir: dir, label: "package instructions test node" });
    deps = { services, now: () => AT as Instant };
    expect(enabled()).toEqual([{ project, packageId: "com.example.fetched" }]);
    expect((await call("POST", "/packages/com.example.local/restore")).status).toBe(200);
    expect(stated()).toEqual(["Quy tắc của gói đã cài."]);
  });

  it("starts a restored package and a freshly installed one with nothing on, whatever pairs were left for its id", async () => {
    await installLocal();
    expect((await call("POST", "/packages/com.example.local/uninstall")).status).toBe(200);
    leave([{ project, packageId: "com.example.local" }]);
    expect((await call("POST", "/packages/com.example.local/restore")).status).toBe(200);
    expect(enabled()).toEqual([]);
    expect(stated()).toEqual([]);

    leave([{ project, packageId: "com.example.fetched" }]);
    await installFromGit();
    expect(enabled()).toEqual([]);
    expect(stated()).toEqual([]);
  });

  it("drops at boot only the pairs whose package is not installed", async () => {
    await installLocal();
    leave([
      { project, packageId: "com.example.local" },
      { project, packageId: "com.example.gone" },
    ]);
    services.runtime.close();
    services = bootNodeServices({ dataDir: dir, label: "package instructions test node" });
    deps = { services, now: () => AT as Instant };
    expect(enabled()).toEqual([{ project, packageId: "com.example.local" }]);
    expect(stated()).toEqual(["Quy tắc của gói cục bộ."]);
  });
  it("keeps a package's projects through an upgrade and a rollback, since it stays installed", async () => {
    await installLocal();
    await tool().execute({ action: "enable_instructions", packageId: "com.example.local", project });
    await installLocal("1.1.0", "Quy tắc của bản 1.1.0.");
    expect(stated()).toEqual(["Quy tắc của bản 1.1.0."]);
    const rolledBack = await call("POST", "/packages/com.example.local/rollback");
    expect(rolledBack.status, JSON.stringify(rolledBack.body)).toBe(200);
    expect(enabled()).toEqual([{ project, packageId: "com.example.local" }]);
    expect(stated()).toEqual(["Quy tắc của gói cục bộ."]);
  });

  it("writes and records nothing when the policy refuses local writes", async () => {
    await installLocal();
    policy("deny");
    const before = effects();
    const refused = await tool().execute({ action: "enable_instructions", packageId: "com.example.local", project });
    expect(refused.text).toContain("POLICY_REFUSED");
    expect(enabled()).toEqual([]);
    expect(effects()).toBe(before);
    expect(stated()).toEqual([]);
  });

  it("records the effect only after the write succeeds", async () => {
    await installLocal();
    const store = (value: unknown): void => {
      const written = writeRegisteredPreference(
        { db: services.runtime.db, now: () => AT as Instant },
        { principalId: services.runtime.identity.ownerPrincipalId, key: PACKAGE_INSTRUCTIONS_PREFERENCE, value, source: "user" },
      );
      expect(written.ok).toBe(true);
    };
    store(Array.from({ length: PACKAGE_INSTRUCTION_LIMITS.enabled }, (_, index) => ({ project, packageId: `com.example.other${String(index)}` })));
    const before = effects();
    const refused = requestPackageInstructions(packageInstructionsDepsOf(services), { packageId: "com.example.local", project, enabled: true, source: "agent" });
    expect(refused.kind).toBe("refused");
    expect(effects()).toBe(before);

    store([]);
    const done = requestPackageInstructions(packageInstructionsDepsOf(services), { packageId: "com.example.local", project, enabled: true, source: "agent" });
    expect(done.kind).toBe("done");
    expect(effects()).toBe(before + 1);
  });

  it("binds the card to the package's version, so a card shown for one version does not turn on another", async () => {
    await installLocal();
    policy("ask");
    const instructions = packageInstructionsDepsOf(services);
    const asked = requestPackageInstructions(instructions, { packageId: "com.example.local", project, enabled: true, source: "agent" });
    if (asked.kind !== "approval-required") throw new Error(`expected a card, got ${asked.kind}`);
    expect(String(asked.card["payload"])).toContain('"version":"1.0.0"');
    policy();
    await installLocal("1.1.0", "Quy tắc của bản 1.1.0.");
    const approved = runApprovedPackageInstructions(instructions, {
      payload: String(asked.card["payload"]),
      expectedDigest: asked.approval.operationDigest,
      approvalId: asked.approval.approvalId,
    });
    expect(approved).toMatchObject({ ok: false, code: "PACKAGE_CHANGED" });
    expect(enabled()).toEqual([]);
    expect(stated()).toEqual([]);
  });
  it("audits each package snippet stated in a conversation with the package id and version", async () => {
    await installLocal();
    await tool().execute({ action: "enable_instructions", packageId: "com.example.local", project });
    const instructions = nodeConditionalInstructions({}, services);
    if (instructions === undefined) throw new Error("instructions are off");
    const turn = turnInstructions({
      instructions,
      referenced: () => ({ places: [], skills: [] }),
      onPackages: ({ conversationId, outcomes }) =>
        auditPackageInstructions(packageInstructionsDepsOf(services), outcomes, `conversation ${conversationId}`),
    });
    turn({
      conversationId: "conv_1",
      touched: [write(join(project, "src", "a.ts"))],
      stated: new Set(),
      allowed: ["public", "internal", "confidential"],
      newOnly: false,
      nonce: "n",
    });
    const rows = allRows<{ kind: string; summary: string; outcome: string; ref: string }>(
      services.runtime.db,
      "SELECT kind, summary, outcome, ref FROM audit_log WHERE kind = 'instructions'",
    );
    expect(rows).toEqual([
      {
        kind: "instructions",
        summary: "conversation conv_1: stated instruction style from package com.example.local 1.0.0",
        outcome: "done",
        ref: "com.example.local@1.0.0#style",
      },
    ]);
  });
});

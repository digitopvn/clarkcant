import { statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  type AppIntentLocale,
  absoluteHostPathProblem,
  type Instant,
  type MessageBlock,
  nowInstant,
  PACKAGE_INSTRUCTIONS_PREFERENCE,
  type PackageInstructionsEnablement,
  packageInstructionsPreferenceSchema,
  type TurnOrigin,
  withPackageInstructions,
} from "@clarkcant/contracts";
import {
  type ApprovalRecord,
  decideExecution,
  type InstalledInstructionsOutcome,
  installedInstructions,
  type InstalledPackageView,
  listInstalledPackages,
  type PreferenceWriteOutcome,
  readDirectory,
  readExecutionPolicy,
  readRegisteredPreference,
  recordEffectExecution,
  requestApproval,
  resolveLocalSource,
  writeRegisteredPreference,
} from "@clarkcant/core";
import { appendAuditEvent, asJsonValue, type Database, payloadDigest } from "@clarkcant/storage";

import { preferredAppIntentLocale } from "../app-intents.ts";
import { type PackageInstructionOutcome, type PackageInstructionSet, realFolderPath } from "../conditional-instructions.ts";
import { hostText } from "../host-text.ts";
import { isWithinRootCased } from "../path-roots.ts";
import { entryFor } from "./themes.ts";

/**
 * Package instructions: which installed packages' conditional instructions apply in which project, and changing that.
 *
 * A package's `instructions` facet is declarative content: rules in the project-instructions contract, and snippets the
 * host states as data. Installing a package states none of it. The person turns a package's instructions on for one
 * project at a time, kept as the node preference `instructions.packages`:
 *
 *   - in Settings, the person's own click on a host-owned, person-only route;
 *   - by asking Clark (`manage_package`), which is an effect the execution policy decides like any other: it runs and is
 *     recorded, or becomes the host's approval card, or is refused. Nothing here asks on its own account, and a package
 *     or a widget never reaches the write.
 *
 * A project must be inside a root the person already granted, both when it is enabled and on every turn it is stated:
 * enabling grants no root, and a root withdrawn since withdraws the package's rules with it. Uninstalling the package, or
 * turning it off, removes its rules from the next turn, because only active generations are read.
 */

export interface PackageInstructionsDeps {
  db: Database;
  nodeId: string;
  dataDir: string;
  principalId: string;
  newId: (prefix: string) => string;
  now: () => Instant;
  /** The node's granted roots, read when asked. */
  roots: () => readonly string[];
}

/** The node fields these reads need, as the gateway's services carry them. */
export function packageInstructionsDepsOf(services: {
  runtime: { db: Database; identity: { nodeId: string; ownerPrincipalId: string }; dataDir: string };
  conductor: { newId: (prefix: string) => string };
  projects: { roots: () => readonly string[] };
}): PackageInstructionsDeps {
  return {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    dataDir: services.runtime.dataDir,
    principalId: services.runtime.identity.ownerPrincipalId,
    newId: services.conductor.newId,
    now: nowInstant,
    roots: () => services.projects.roots(),
  };
}

/** The enabled pairs, as stored; an unreadable value is none. */
export function readPackageInstructionsEnabled(deps: Pick<PackageInstructionsDeps, "db" | "principalId">): PackageInstructionsEnablement[] {
  const stored = readRegisteredPreference({ db: deps.db, now: nowInstant }, { principalId: deps.principalId, key: PACKAGE_INSTRUCTIONS_PREFERENCE })?.value;
  const parsed = packageInstructionsPreferenceSchema.safeParse(stored ?? []);
  return parsed.success ? parsed.data : [];
}

/**
 * One generation's read, by its digest: the same bytes give the same rules, so a turn costs a lookup and the compiled
 * rules stay cached against the same arrays. Bounded; the oldest goes first.
 */
const reads = new Map<string, InstalledInstructionsOutcome>();
const READ_CACHE = 64;

/** An installed package's instructions as this node can read them, or why it cannot. */
export function readPackageInstructions(deps: Pick<PackageInstructionsDeps, "dataDir">, pkg: InstalledPackageView): InstalledInstructionsOutcome {
  const key = `${deps.dataDir}\n${pkg.packageId}\n${pkg.digest}`;
  const known = reads.get(key);
  if (known !== undefined) return known;
  const index = readDirectory({ env: process.env, dataDir: deps.dataDir });
  if (index.kind !== "configured") return { ok: false, code: "UNREADABLE", message: index.reason };
  const listed = entryFor(index.entries, pkg);
  if (listed === undefined) {
    return { ok: false, code: "UNREADABLE", message: `${pkg.packageId}@${pkg.version} is not in the directory, so this node cannot locate its files` };
  }
  const read = installedInstructions({ source: resolveLocalSource(listed, join(deps.dataDir, "package-cache"), pkg) });
  // A package this node could not read is asked again next time; one it read is the same until its digest changes.
  if (read.ok) {
    reads.set(key, read);
    if (reads.size > READ_CACHE) reads.delete(reads.keys().next().value as string);
  }
  return read;
}

function installedOf(deps: Pick<PackageInstructionsDeps, "db" | "nodeId" | "newId">): InstalledPackageView[] {
  return listInstalledPackages({ db: deps.db, nodeId: deps.nodeId, now: nowInstant, newId: deps.newId });
}

/**
 * What the turn's matcher reads: each installed package with instructions and at least one enabled project. Read on
 * every ask, so a change applies to the next turn; a package with nothing enabled is not read at all.
 */
export function enabledPackageInstructionSets(deps: Omit<PackageInstructionsDeps, "now" | "roots">): PackageInstructionSet[] {
  const enabled = readPackageInstructionsEnabled(deps);
  if (enabled.length === 0) return [];
  const sets: PackageInstructionSet[] = [];
  for (const pkg of installedOf(deps)) {
    const projects = enabled.filter((entry) => entry.packageId === pkg.packageId).map((entry) => entry.project);
    if (projects.length === 0) continue;
    const read = readPackageInstructions(deps, pkg);
    if (!read.ok || read.facets.length === 0) continue;
    // Labelled by the package's declared identity: a package installed from a folder records that path as its node id.
    sets.push({ packageId: read.manifestId, version: read.version, facets: read.facets, projects });
  }
  return sets;
}

/** One installed package that carries instructions, and the projects they are on in. */
export interface PackageInstructionsStatus {
  packageId: string;
  /** The declared identity and version the instructions are labelled with. */
  name: string;
  version: string;
  projects: string[];
  /** Rules files of the package that could not be used, named. */
  problems: string[];
}

/** Every installed package that carries instructions, for `manage_package list` and Settings. */
export function packageInstructionsStatus(deps: Omit<PackageInstructionsDeps, "now" | "roots">): PackageInstructionsStatus[] {
  const enabled = readPackageInstructionsEnabled(deps);
  const statuses: PackageInstructionsStatus[] = [];
  for (const pkg of installedOf(deps)) {
    const read = readPackageInstructions(deps, pkg);
    if (!read.ok || (read.facets.length === 0 && read.problems.length === 0)) continue;
    statuses.push({
      packageId: pkg.packageId,
      name: read.manifestId,
      version: read.version,
      projects: enabled.filter((entry) => entry.packageId === pkg.packageId).map((entry) => entry.project),
      problems: read.problems.map((problem) => problem.message),
    });
  }
  return statuses;
}

/** Whether a folder, links resolved, is inside one of the granted roots, links resolved. */
export function projectInGrantedRoot(roots: readonly string[], project: string): boolean {
  let real: string;
  try {
    if (!statSync(project).isDirectory()) return false;
    real = realFolderPath(project);
  } catch {
    return false;
  }
  return roots.some((root) => {
    try {
      return isWithinRootCased(realFolderPath(root), real, false);
    } catch {
      return false;
    }
  });
}

export type PackageInstructionsSource = "click" | "agent" | "voice";

export interface PackageInstructionsChange {
  packageId: string;
  project: string;
  enabled: boolean;
}

/** The one write: the registered preference with one pair added or removed, recorded with who made it. */
export function writePackageInstructions(
  deps: { db: Database; now: () => Instant },
  input: PackageInstructionsChange & { principalId: string; source: PackageInstructionsSource },
): PreferenceWriteOutcome {
  const current = readPackageInstructionsEnabled({ db: deps.db, principalId: input.principalId });
  return writeRegisteredPreference(deps, {
    principalId: input.principalId,
    key: PACKAGE_INSTRUCTIONS_PREFERENCE,
    value: withPackageInstructions(current, { packageId: input.packageId, project: input.project, enabled: input.enabled }),
    source: input.source === "click" ? "user" : "agent",
  });
}

/** What an approval is bound to: exactly this package, this project and this direction. */
export function packageInstructionsDigest(change: PackageInstructionsChange): string {
  return payloadDigest(asJsonValue({ kind: "package-instructions", packageId: change.packageId, project: change.project, enabled: change.enabled }));
}

type Checked = { ok: true; change: PackageInstructionsChange; name: string; version: string } | { ok: false; code: string; message: string };

/**
 * Whether a change can be made at all, before anyone decides it: the project is an absolute folder inside a granted
 * root, and the package is installed and carries instructions. Turning one off needs only that it is on.
 */
function checkChange(deps: Omit<PackageInstructionsDeps, "now">, input: PackageInstructionsChange): Checked {
  const pathProblem = absoluteHostPathProblem(input.project);
  if (pathProblem !== undefined) return { ok: false, code: "PROJECT_INVALID", message: `project ${pathProblem}` };
  const project = resolve(input.project);
  const change = { packageId: input.packageId, project, enabled: input.enabled };
  if (!input.enabled) {
    const on = readPackageInstructionsEnabled(deps).some((entry) => entry.packageId === input.packageId && entry.project === project);
    if (!on) return { ok: false, code: "NOT_ENABLED", message: `${input.packageId}'s instructions are not on for ${project}` };
    return { ok: true, change, name: input.packageId, version: "" };
  }
  if (!projectInGrantedRoot(deps.roots(), project)) {
    return { ok: false, code: "PROJECT_NOT_GRANTED", message: `${project} is not a folder inside a root this node was granted; grant the root first` };
  }
  const pkg = installedOf(deps).find((entry) => entry.packageId === input.packageId);
  if (pkg === undefined) return { ok: false, code: "PACKAGE_NOT_INSTALLED", message: `${input.packageId} is not installed on this node` };
  const read = readPackageInstructions(deps, pkg);
  if (!read.ok) return { ok: false, code: read.code, message: read.message };
  if (read.facets.length === 0) {
    const why = read.problems.map((problem) => problem.message).join("; ");
    return { ok: false, code: "NO_INSTRUCTIONS", message: `${input.packageId} carries no usable instructions${why === "" ? "" : `: ${why}`}` };
  }
  return { ok: true, change, name: read.manifestId, version: read.version };
}

const APPROVAL_TTL_MS = 15 * 60_000;

export type PackageInstructionsRequestOutcome =
  | { kind: "done"; change: PackageInstructionsChange; receipt: string }
  | { kind: "approval-required"; approval: ApprovalRecord; card: Record<string, unknown> }
  | { kind: "refused"; code: string; message: string };

function describeChange(name: string, version: string, change: PackageInstructionsChange, language: AppIntentLocale): string {
  const say = hostText(language).approvals.packageInstructions;
  return change.enabled ? say.enable(name, version, change.project) : say.disable(name, change.project);
}

function receiptOf(name: string, change: PackageInstructionsChange, language: AppIntentLocale): string {
  const say = hostText(language).approvals.packageInstructions;
  return change.enabled ? say.enabled(name, change.project) : say.disabled(name, change.project);
}

/**
 * Clark's request to turn a package's instructions on or off in one project. Checked first, so nothing is written or
 * shown for a change that could not be made; then the execution policy decides, as for any local write.
 */
export function requestPackageInstructions(
  deps: PackageInstructionsDeps,
  input: PackageInstructionsChange & {
    source: Exclude<PackageInstructionsSource, "click">;
    conversationId?: string;
    /** Who asked for the turn that wants this (`TurnOrigin`). Absent is the person. */
    origin?: TurnOrigin;
  },
): PackageInstructionsRequestOutcome {
  const checked = checkChange(deps, input);
  if (!checked.ok) return { kind: "refused", code: checked.code, message: checked.message };
  const { change, name, version } = checked;
  const category = "local-write";
  const operationDigest = packageInstructionsDigest(change);
  const execution = readExecutionPolicy({ db: deps.db, now: deps.now }, deps.principalId);
  const decided = decideExecution({
    policy: execution,
    action: { kind: "effect", category, operationDigest },
    intent: input.origin === undefined ? { kind: "interactive" } : { kind: "interactive", origin: input.origin },
  });
  if (decided.kind === "deny") return { kind: "refused", code: "POLICY_REFUSED", message: decided.reason };
  const language = preferredAppIntentLocale({ db: deps.db, now: deps.now }, deps.principalId);
  const description = describeChange(name, version, change, language);

  if (decided.kind === "execute") {
    recordEffectExecution(deps, {
      principalId: deps.principalId,
      mode: execution.mode,
      decision: decided,
      category,
      operationDigest,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      description: `Clark: ${description}`,
      ...(input.origin === undefined ? {} : { origin: input.origin }),
    });
    const written = writePackageInstructions(deps, { ...change, principalId: deps.principalId, source: input.source });
    if (!written.ok) return { kind: "refused", code: written.code, message: written.message };
    return { kind: "done", change, receipt: receiptOf(name, change, language) };
  }

  const payload = JSON.stringify({ kind: "package-instructions", ...change, source: input.source });
  const approval = requestApproval(deps, {
    operationDigest,
    operationDescription: description,
    effectCategory: category,
    ttlMs: APPROVAL_TTL_MS,
  });
  return {
    kind: "approval-required",
    approval,
    card: {
      type: "approval-card",
      owner: "host",
      approvalId: approval.approvalId,
      operationDescription: approval.operationDescription,
      operationDigest: approval.operationDigest,
      payload,
      effectCategory: category,
      expiresAt: approval.expiresAt,
      decider: approval.decider,
      decision: approval.decision,
      ...(input.origin === undefined ? {} : { origin: input.origin }),
    },
  };
}

/** Whether an approval card's payload is a package instructions change. */
export function isPackageInstructionsPayload(payload: string): boolean {
  try {
    const parsed = JSON.parse(payload) as { kind?: unknown };
    return parsed.kind === "package-instructions";
  } catch {
    return false;
  }
}

/**
 * Make a change a person approved on the host's card. The payload is the card's own and is hashed again against the
 * digest the decision covered, and checked again — the root may have been withdrawn or the package uninstalled while the
 * card waited — so what is written is what was shown and is still possible.
 */
export function runApprovedPackageInstructions(
  deps: PackageInstructionsDeps,
  input: { payload: string; expectedDigest: string; approvalId: string },
): { ok: true; blocks: MessageBlock[]; description: string } | { ok: false; code: string; message: string } {
  let parsed: { packageId?: unknown; project?: unknown; enabled?: unknown; source?: unknown };
  try {
    parsed = JSON.parse(input.payload) as typeof parsed;
  } catch {
    return { ok: false, code: "APPROVAL_PAYLOAD_UNREADABLE", message: "the approved payload is not readable" };
  }
  if (typeof parsed.packageId !== "string" || typeof parsed.project !== "string" || typeof parsed.enabled !== "boolean") {
    return { ok: false, code: "APPROVAL_PAYLOAD_UNREADABLE", message: "the approved payload names no package instructions change" };
  }
  const asked = { packageId: parsed.packageId, project: parsed.project, enabled: parsed.enabled };
  if (packageInstructionsDigest(asked) !== input.expectedDigest) {
    return { ok: false, code: "APPROVAL_FORGED", message: "the operation changed after it was displayed; the decision does not cover what would run" };
  }
  const checked = checkChange(deps, asked);
  if (!checked.ok) return { ok: false, code: checked.code, message: checked.message };
  const execution = readExecutionPolicy(deps, deps.principalId);
  const now = decideExecution({
    policy: execution,
    action: { kind: "effect", category: "local-write", operationDigest: input.expectedDigest },
    intent: { kind: "interactive" },
  });
  if (now.kind === "deny") return { ok: false, code: "POLICY_REFUSED", message: now.reason };
  const startedAt = deps.now();
  const source = parsed.source === "voice" ? "voice" : "agent";
  const written = writePackageInstructions(deps, { ...checked.change, principalId: deps.principalId, source });
  if (!written.ok) return { ok: false, code: written.code, message: written.message };
  const block = {
    type: "tool-activity",
    toolCallId: `package-instructions-${input.approvalId}`,
    name: "manage_package",
    label: receiptOf(checked.name, checked.change, preferredAppIntentLocale(deps, deps.principalId)),
    status: "done",
    // The approval id travels with the receipt so the card it answered reads as decided, including after a reload.
    args: { approvalId: input.approvalId, decision: "granted", packageId: checked.change.packageId, project: checked.change.project, enabled: checked.change.enabled },
    startedAt,
    endedAt: deps.now(),
  } as MessageBlock;
  return {
    ok: true,
    blocks: [block],
    description: `${checked.change.enabled ? "turned on" : "turned off"} ${checked.change.packageId}'s instructions for ${checked.change.project} at Clark's request`,
  };
}

/**
 * Each package snippet a statement stated or withheld, in the node's audit trail: the package id and version, the
 * snippet's name, and where it was stated (`where`: a conversation or a task). Never the snippet's text. A trail that
 * cannot be written does not change what was stated.
 */
export function auditPackageInstructions(
  deps: { db: Database; nodeId: string; principalId: string; newId: (prefix: string) => string; now: () => Instant },
  outcomes: readonly PackageInstructionOutcome[],
  where: string,
): void {
  for (const { package: ref, outcome } of outcomes) {
    try {
      appendAuditEvent(deps.db, {
        auditId: deps.newId("audit"),
        principalId: deps.principalId,
        nodeId: deps.nodeId,
        kind: "instructions",
        summary:
          outcome === "stated"
            ? `${where}: stated instruction ${ref.snippet} from package ${ref.id} ${ref.version}`
            : `${where}: withheld instruction ${ref.snippet} from package ${ref.id} ${ref.version} (above the model's data-class ceiling)`,
        outcome: outcome === "stated" ? "done" : "refused",
        ref: `${ref.id}@${ref.version}#${ref.snippet}`,
        at: deps.now(),
      });
    } catch {
      // The statement stands either way.
    }
  }
}
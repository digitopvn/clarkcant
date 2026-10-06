import {
  canonicalReach,
  declaredReachIsEmpty,
  nowInstant,
  type DirectoryEntry,
  type Principal,
  type WaitingItem,
} from "@clarkcant/contracts";
import {
  decideApproval,
  devConsentScopeOf,
  unreadFieldsOf,
  type DirectoryIndexState,
} from "@clarkcant/core";
import { allRows, oneRow } from "@clarkcant/storage";

import {
  auditInstallApproval,
  findInstallApprovalRequest,
  installPackage,
  localFilesChangedMessage,
  localFilesUnchanged,
  type PackageInstallDeps,
} from "./package-install.ts";
import { reachChangeAgainstInstalled } from "../package-reach-change.ts";
import { readNodeDirectory } from "./widget-dev-store.ts";

/**
 * An install the person's execution policy asked about, from the question to the answer.
 *
 * `installPackage` asks (`approval-required`) and records what it asked about. This is the other half: the inbox lists
 * the question with what the person needs to decide it, and the person's answer on their own surface
 * (`POST /packages/approvals/:id/decision`, a person-only route) either installs exactly the artifact that was asked
 * about - through `installPackage` again, with every check it makes - or installs nothing.
 *
 * Every outcome is written to the same record the question was (`INSTALL_APPROVAL_STREAM`): installed, denied,
 * expired, refused or failed.
 */

type InstallApprovalItem = Extract<WaitingItem, { kind: "install-approval" }>;

/**
 * The directory entry that lists `packageId@version` in `index`, or undefined when none does or none is configured.
 * The caller reads the index once, so listing N questions is not N reads of it.
 */
function listedEntry(index: DirectoryIndexState, packageId: string, version: string): DirectoryEntry | undefined {
  if (index.kind !== "configured") return undefined;
  return index.entries.find((candidate) => candidate.packageId === packageId && candidate.version === version);
}

/**
 * What an install approval names: the artifact, or, for a widget dev session's generation, the consent scope it was
 * asked under. The listing must still name both: the exact files (`digest`) and, for a dev generation, the same scope.
 */
function askedOperation(asked: { digest: string; consentScope?: string }): string {
  return asked.consentScope ?? asked.digest;
}

function stillListedAsAsked(entry: DirectoryEntry | undefined, asked: { digest: string; consentScope?: string }): entry is DirectoryEntry {
  if (entry === undefined || entry.digest !== asked.digest) return false;
  return asked.consentScope === undefined || devConsentScopeOf(entry) === asked.consentScope;
}

/**
 * The install approvals still waiting for the person, oldest first.
 *
 * Only one the directory still lists as the artifact that was asked about. An entry republished under the same version
 * since, or taken out of the listing, would make Approve a button that can only be refused; such a question is left out
 * and the next install of the package asks again about what it is now. Expired ones are left out for the same reason.
 */
export function listPendingInstallApprovals(
  deps: Pick<PackageInstallDeps, "runtime">,
  now: string = nowInstant(),
): InstallApprovalItem[] {
  const { runtime } = deps;
  const rows = allRows<{
    approval_id: string;
    operation_digest: string;
    operation_description: string;
    requested_at: string;
    expires_at: string;
  }>(
    runtime.db,
    `SELECT approval_id, operation_digest, operation_description, requested_at, expires_at FROM approvals
      WHERE task_id IS NULL AND decision = 'pending' AND expires_at > ?
      ORDER BY requested_at, approval_id`,
    now,
  );
  const index = readNodeDirectory(runtime.dataDir);
  return rows.flatMap((row): InstallApprovalItem[] => {
    const asked = findInstallApprovalRequest(runtime.db, runtime.identity.nodeId, row.approval_id);
    if (asked === undefined || askedOperation(asked) !== row.operation_digest) return [];
    const entry = listedEntry(index, asked.packageId, asked.version);
    if (!stillListedAsAsked(entry, asked)) return [];
    // A listing by a path on this machine whose files changed since the question is left out the same way.
    if (!localFilesUnchanged(entry, asked.localDigest)) return [];
    // An update says what it changes against the version that runs now; the question itself is the same as any install's.
    const reachChange = reachChangeAgainstInstalled(runtime, entry, index);
    // What the listing says that this node does not read, so the question does not claim to show all of it.
    const unreadFields = unreadFieldsOf(index, entry);
    return [
      {
        kind: "install-approval",
        approvalId: row.approval_id,
        packageId: entry.packageId,
        version: entry.version,
        displayName: entry.displayName,
        riskTier: entry.riskTier,
        permissions: [...entry.permissionsSummary],
        ...(entry.declaredReach === undefined || declaredReachIsEmpty(entry.declaredReach)
          ? {}
          : { reach: canonicalReach(entry.declaredReach) }),
        ...(reachChange === undefined ? {} : { reachChange }),
        ...(unreadFields === undefined ? {} : { unreadFields }),
        description: row.operation_description,
        operationDigest: row.operation_digest,
        requestedAt: row.requested_at as InstallApprovalItem["requestedAt"],
        expiresAt: row.expires_at as InstallApprovalItem["expiresAt"],
      },
    ];
  });
}

/** Whether this approval is an install the policy asked about, rather than a capability, a command or a task's. */
export function isInstallApproval(deps: Pick<PackageInstallDeps, "runtime">, approvalId: string): boolean {
  return findInstallApprovalRequest(deps.runtime.db, deps.runtime.identity.nodeId, approvalId) !== undefined;
}

export type InstallApprovalDecisionOutcome =
  | { ok: true; decision: "denied"; packageId: string; version: string }
  | {
      ok: true;
      decision: "granted";
      packageId: string;
      version: string;
      generationId: string;
      state: string;
      pendingCapabilities: readonly { ref: string; approvalId: string }[];
      deniedCapabilities: readonly string[];
    }
  | { ok: false; status: number; code: string; message: string };

/**
 * The person's answer to an install approval.
 *
 * In this order, and each step is what keeps an approval bound to what was shown:
 *
 * 1. The digest the person was shown must be the one the question was asked about (`APPROVAL_FORGED` otherwise).
 * 2. Approving checks the listing still names that artifact before anything is decided: a package or version that
 *    changed since the ask is refused (`DIGEST_MISMATCH`) and the approval is left as it was, so nothing is installed
 *    on an approval given for other bytes. A listing by a path on this machine is also checked against the content of
 *    its files when the question was asked, refused the same way when they changed.
 * 3. The approval is claimed through `decideApproval`, the one decide routine every approval goes through: only a user
 *    principal may decide, an expired one becomes `expired` (`APPROVAL_EXPIRED`) and one already decided is not
 *    decided twice (`APPROVAL_ALREADY_DECIDED`) - which is also what keeps a double press from installing twice.
 * 4. Denied: nothing else happens. Granted: `installPackage` runs again with the approval it was given, making every
 *    check the first attempt made, refusing an entry whose digest is no longer the approved one, and still honouring a
 *    policy that now forbids installing.
 */
export async function decideInstallApproval(
  deps: PackageInstallDeps,
  input: {
    approvalId: string;
    decision: "granted" | "denied";
    decidingPrincipal: Principal;
    seenOperationDigest: string;
  },
): Promise<InstallApprovalDecisionOutcome> {
  const { runtime, conductor } = deps;
  const asked = findInstallApprovalRequest(runtime.db, runtime.identity.nodeId, input.approvalId);
  const row = oneRow<{ operation_digest: string; task_id: string | null }>(
    runtime.db,
    "SELECT operation_digest, task_id FROM approvals WHERE approval_id = ?",
    input.approvalId,
  );
  if (asked === undefined || row === undefined || row.task_id !== null || row.operation_digest !== askedOperation(asked)) {
    return { ok: false, status: 409, code: "NOT_AN_INSTALL_APPROVAL", message: "this approval is not an install that was asked about" };
  }
  const audit = (result: "installed" | "denied" | "expired" | "refused" | "failed", extra: { code?: string; generationId?: string } = {}) =>
    auditInstallApproval(deps, {
      approvalId: input.approvalId,
      packageId: asked.packageId,
      version: asked.version,
      digest: asked.digest,
      ...(asked.consentScope === undefined ? {} : { consentScope: asked.consentScope }),
      result,
      ...extra,
    });

  if (input.seenOperationDigest !== askedOperation(asked)) {
    audit("refused", { code: "APPROVAL_FORGED" });
    return {
      ok: false,
      status: 409,
      code: "APPROVAL_FORGED",
      message: "the artifact this decision was made on is not the one the approval asked about, so nothing changed",
    };
  }

  if (input.decision === "granted") {
    const entry = listedEntry(readNodeDirectory(runtime.dataDir), asked.packageId, asked.version);
    if (!stillListedAsAsked(entry, asked)) {
      audit("refused", { code: "DIGEST_MISMATCH" });
      return {
        ok: false,
        status: 409,
        code: "DIGEST_MISMATCH",
        message: `${asked.packageId}@${asked.version} changed in the directory after you were asked, so nothing was installed; install it again to be asked about what it is now`,
      };
    }
    if (!localFilesUnchanged(entry, asked.localDigest)) {
      audit("refused", { code: "DIGEST_MISMATCH" });
      return { ok: false, status: 409, code: "DIGEST_MISMATCH", message: localFilesChangedMessage(asked.packageId, asked.version) };
    }
  }

  const decided = decideApproval(
    { db: runtime.db, nodeId: runtime.identity.nodeId, now: () => nowInstant(), newId: conductor.newId },
    {
      approvalId: input.approvalId,
      decision: input.decision,
      decidingPrincipal: input.decidingPrincipal,
      seenOperationDigest: input.seenOperationDigest,
    },
  );
  if (!decided.ok) {
    audit(decided.code === "APPROVAL_EXPIRED" ? "expired" : "refused", { code: decided.code });
    return { ok: false, status: 409, code: decided.code, message: decided.message };
  }

  if (input.decision === "denied") {
    audit("denied");
    return { ok: true, decision: "denied", packageId: asked.packageId, version: asked.version };
  }

  const installed = await installPackage(
    deps,
    { packageId: asked.packageId, version: asked.version },
    {
      approved: {
        approvalId: input.approvalId,
        digest: askedOperation(asked),
        ...(asked.localDigest === undefined ? {} : { localDigest: asked.localDigest }),
      },
      ...(asked.consentScope === undefined ? {} : { consentScope: asked.consentScope }),
    },
  );
  if (installed.kind === "installed") {
    audit("installed", { generationId: installed.generationId });
    return {
      ok: true,
      decision: "granted",
      packageId: installed.packageId,
      version: installed.version,
      generationId: installed.generationId,
      state: installed.state,
      pendingCapabilities: installed.pendingCapabilities,
      deniedCapabilities: installed.deniedCapabilities,
    };
  }
  if (installed.kind === "approval-required") {
    // Not reachable: an approved install turns `ask` into the person's answer. Said as a failure rather than assumed.
    audit("failed", { code: "APPROVAL_REQUIRED" });
    return { ok: false, status: 409, code: "APPROVAL_REQUIRED", message: installed.message };
  }
  // A digest that changed during the fetch, or a policy that now forbids it, is a refusal; anything else a failure.
  const refusedCodes = new Set(["DIGEST_MISMATCH", "POLICY_REFUSED", "NOT_IN_DIRECTORY"]);
  audit(refusedCodes.has(installed.code) ? "refused" : "failed", { code: installed.code });
  // The approval stays granted - the person did approve - and the install's own refusal is the answer, unchanged.
  return { ok: false, status: installed.status, code: installed.code, message: installed.message };
}

/**
 * Settle the install approvals nobody answered in time: each becomes `expired`, as it would the moment anybody tried
 * to decide it, and the expiry is audited once. Returns what it settled, for the caller that tells the person.
 */
export function expireInstallApprovals(
  deps: Pick<PackageInstallDeps, "runtime" | "conductor">,
  rows: readonly { approval_id: string; operation_description: string }[],
): { approvalId: string; description: string }[] {
  const { runtime } = deps;
  const settled: { approvalId: string; description: string }[] = [];
  for (const row of rows) {
    const asked = findInstallApprovalRequest(runtime.db, runtime.identity.nodeId, row.approval_id);
    if (asked === undefined) continue;
    const changed = runtime.db
      .prepare("UPDATE approvals SET decision = 'expired' WHERE approval_id = ? AND decision = 'pending'")
      .run(row.approval_id);
    if (Number(changed.changes) === 0) continue;
    auditInstallApproval(deps, { approvalId: row.approval_id, ...asked, result: "expired" });
    settled.push({ approvalId: row.approval_id, description: row.operation_description });
  }
  return settled;
}

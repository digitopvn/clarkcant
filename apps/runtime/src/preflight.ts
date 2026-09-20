import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import {
  type EffectCategory,
  type GuardClass,
  type GuardrailConstraint,
  guardClassFor,
} from "@clarkcant/contracts";

import { COMMAND_LIMITS } from "./run-command.ts";

/**
 * The deterministic gate, and the reason autonomy is allowed to be the default.
 *
 * Everything here runs before any model is consulted, costs nothing, and cannot be argued with. That
 * ordering is the architecture: the guardrail is a judgment layer that may narrow what the host already
 * decided is technically possible, and the host's decision is this file.
 *
 * What it does *not* do is as important as what it does. It does not decide whether an operation is
 * wise — that is the guardrail's job. It decides whether the operation is *possible and owned*:
 *
 *   - **Ownership.** Every effect resolves inside a directory this node owns, so an instruction that
 *     arrives from a webpage, a repository README or a model's own improvisation cannot reach outside
 *     the places the operator put in this node's hands. This replaced a folder restriction that had been
 *     removed in favour of an approval card; with the card no longer in the default path, containment
 *     belongs back in the host, where a model cannot talk its way past it.
 *   - **Existence.** A directory that is not there is refused while the model can still correct itself,
 *     rather than becoming a spawn error three layers down.
 *   - **Budget.** A deadline and an output ceiling travel with the operation, so a hang or a flood is
 *     bounded by construction instead of by the good behaviour of whatever was run.
 *   - **Capability existence.** A capability this node has not discovered cannot be invoked, whatever a
 *     proposal claims about it.
 *
 * A denial is written to be read by the model, because the model is holding the turn.
 */

/** Directories this node may act inside. Resolved and deduplicated at construction. */
export interface OwnedResources {
  roots: readonly string[];
}

/**
 * Build the ownership set.
 *
 * Order does not matter; the longest matching root is reported for the receipt. Empty entries are
 * dropped rather than treated as "everything", because `""` resolving to the process's own directory
 * would be a containment check that silently passes for the wrong reason.
 */
export function ownedResources(roots: readonly (string | undefined)[]): OwnedResources {
  const resolved = new Set<string>();
  for (const root of roots) {
    if (root === undefined || root.trim() === "") continue;
    resolved.add(resolve(root));
  }
  return { roots: [...resolved] };
}

/** Whether a path resolves inside one of the owned roots. Equal to a root counts as inside it. */
export function containingRoot(resources: OwnedResources, target: string): string | undefined {
  const absolute = resolve(target);
  // Longest first, so a nested root is reported rather than the tree it sits in.
  const ordered = [...resources.roots].sort((left, right) => right.length - left.length);
  for (const root of ordered) {
    const rel = relative(root, absolute);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return root;
  }
  return undefined;
}

/** What a command looks like, described rather than judged. */
export interface CommandClassification {
  /**
   * A coarse family, e.g. `filesystem.delete`, `git`, `package-manager`, `network`, `build`, `read`.
   *
   * Coarse on purpose: it exists to tell the guardrail what kind of thing is about to happen, and to
   * pick a receipt label. It is never a permission decision.
   */
  commandClass: string;
  destructive: boolean;
  recursive: boolean;
  /**
   * How many arguments look like paths.
   *
   * A cheap proxy rather than a real glob: counting what a command will actually touch means walking
   * the filesystem before deciding whether to touch it, which is both slow and a side channel. It is
   * reported as what it is — a count of path-shaped arguments.
   */
  estimatedTargets: number;
  effectCategory: EffectCategory;
}

/** Commands that read and change nothing, so a guardrail call on them would buy nothing. */
const READ_ONLY = /^\s*(ls|dir|cat|type|head|tail|wc|stat|file|pwd|whoami|node\s+(--version|-v)|pnpm\s+(list|why|outdated)|npm\s+ls|git\s+(status|log|diff|show|branch|remote|describe|rev-parse|ls-files|blame))\b/i;
/** Deleting, overwriting or reformatting: the family a guardrail exists for. */
const DESTRUCTIVE = /\b(rm|rmdir|del|erase|rd|shred|truncate|format|mkfs|fdisk|shutdown|reboot)\b|\bgit\s+(clean\s+-[a-z]*f|reset\s+--hard|push\s+.*--force)\b|\bdd\b/i;
const RECURSIVE = /(^|\s)-[a-z]*r[a-z]*\b|(^|\s)--recursive\b|(^|\s)\/s\b/i;
/** Effects that leave this machine, or reach another account. */
const EXTERNAL = /\bgit\s+push\b|\bnpm\s+publish\b|\bpnpm\s+publish\b|\bgh\s+(pr|issue|release|api)\b|\bcurl\b|\bwget\b|\bscp\b|\bssh\b|\brsync\b|\bdocker\s+push\b/i;
const PACKAGE_MANAGER = /^\s*(pnpm|npm|yarn|pip|pip3|poetry|cargo|go)\b/i;
const BUILD = /^\s*(pnpm|npm|yarn|make|cmake|cargo|go|tsc|vite|vitest|playwright)\b.*\b(build|test|run|install|ci|lint|typecheck)\b/i;

/**
 * Describe a command without judging it.
 *
 * The order matters and is stated so it can be argued with: destructive beats external beats
 * package-manager beats build beats read-only. `git push --force` is destructive *and* external, and
 * the destructive reading is the one worth showing a person afterwards.
 */
export function classifyCommand(command: string): CommandClassification {
  const text = command.trim();
  const destructive = DESTRUCTIVE.test(text);
  const external = EXTERNAL.test(text);
  const readOnly = READ_ONLY.test(text);

  const effectCategory: EffectCategory = destructive
    ? "destructive"
    : external
      ? "external-write"
      : readOnly
        ? "read"
        : "local-write";

  const commandClass = destructive
    ? "filesystem.delete"
    : external
      ? "network"
      : readOnly
        ? "read"
        : PACKAGE_MANAGER.test(text)
          ? "package-manager"
          : BUILD.test(text)
            ? "build"
            : "shell";

  return {
    commandClass,
    destructive,
    recursive: destructive && RECURSIVE.test(text),
    estimatedTargets: countPathArguments(text),
    effectCategory,
  };
}

/** Arguments that look like paths: contain a separator, or start with `.` or `~`. Quotes are ignored. */
function countPathArguments(command: string): number {
  let count = 0;
  for (const token of command.split(/\s+/)) {
    const bare = token.replace(/^['"]|['"]$/g, "");
    if (bare === "" || bare.startsWith("-")) continue;
    if (bare.includes("/") || bare.includes("\\") || bare.startsWith(".") || bare.startsWith("~")) count += 1;
  }
  return count;
}

export type PreflightDenialCode =
  | "EMPTY_COMMAND"
  | "COMMAND_TOO_LONG"
  | "UNKNOWN_DIRECTORY"
  | "OUTSIDE_OWNED_RESOURCES"
  | "CAPABILITY_NOT_DISCOVERED";

export interface CommandEnvelope {
  kind: "command";
  surface: "command";
  command: string;
  /** The directory the command would run in, resolved inside an owned root. */
  cwd: string;
  /** Which owned root contains it, for the receipt. */
  root: string;
  effectCategory: EffectCategory;
  guardClass: GuardClass;
  classification: CommandClassification;
  budget: { timeoutMs: number; maxOutputBytes: number };
}

export interface CapabilityEnvelope {
  kind: "capability";
  surface: "capability";
  capabilityRef: string;
  effectCategory: EffectCategory;
  guardClass: GuardClass;
}

export type PreflightResult =
  | { ok: true; envelope: CommandEnvelope | CapabilityEnvelope }
  | { ok: false; code: PreflightDenialCode; message: string };

/**
 * Decide whether this command can run at all, and inside what envelope.
 *
 * The refusal messages name the condition rather than the rule, because they are read by a model that
 * has to do something next: "outside the folders this node owns" tells it to look for a folder it owns,
 * while "not permitted" tells it to give up.
 */
export function preflightCommand(input: {
  command: unknown;
  cwd?: unknown;
  resources: OwnedResources;
  /** Used when the caller did not name a directory at all, e.g. the node's own working directory. */
  fallbackCwd?: string;
}): PreflightResult {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (command === "") return { ok: false, code: "EMPTY_COMMAND", message: "Cần một lệnh để chạy." };
  if (command.length > COMMAND_LIMITS.maxCommandLength) {
    return {
      ok: false,
      code: "COMMAND_TOO_LONG",
      message: `Lệnh dài hơn ${COMMAND_LIMITS.maxCommandLength} ký tự. Hãy đưa nó vào một tệp rồi chạy tệp đó.`,
    };
  }

  const requested =
    typeof input.cwd === "string" && input.cwd.trim() !== "" ? input.cwd.trim() : (input.fallbackCwd ?? "");
  if (requested === "") {
    return {
      ok: false,
      code: "UNKNOWN_DIRECTORY",
      message: "Cần một thư mục để chạy lệnh, và node này không có thư mục mặc định nào.",
    };
  }

  const cwd = resolve(requested);
  const root = containingRoot(input.resources, cwd);
  if (root === undefined) {
    const owned = input.resources.roots.length === 0 ? "chưa cấu hình thư mục nào" : input.resources.roots.join(", ");
    return {
      ok: false,
      code: "OUTSIDE_OWNED_RESOURCES",
      message: `Thư mục ${cwd} nằm ngoài những thư mục node này sở hữu (${owned}). Hãy chọn một thư mục trong đó.`,
    };
  }

  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return {
      ok: false,
      code: "UNKNOWN_DIRECTORY",
      message: `Thư mục ${cwd} không tồn tại trên node này. Kiểm tra lại đường dẫn rồi thử lại.`,
    };
  }

  const classification = classifyCommand(command);
  return {
    ok: true,
    envelope: {
      kind: "command",
      surface: "command",
      command,
      cwd,
      root,
      effectCategory: classification.effectCategory,
      guardClass: guardClassFor({ surface: "command", effectCategory: classification.effectCategory }),
      classification,
      budget: { timeoutMs: COMMAND_LIMITS.timeoutMs, maxOutputBytes: COMMAND_LIMITS.maxOutputBytes },
    },
  };
}

/**
 * The same gate for a capability or widget action.
 *
 * A capability that has not been discovered on this node does not exist here, whatever a proposal calls
 * it. The message is the one `bindAgentAction` already uses for the same condition, so the two paths
 * cannot drift into two different explanations of one fact.
 */
export function preflightCapability(input: {
  capabilityRef: unknown;
  effectCategory: EffectCategory;
  discovered: ReadonlySet<string>;
}): PreflightResult {
  const ref = typeof input.capabilityRef === "string" ? input.capabilityRef.trim() : "";
  if (ref === "" || !input.discovered.has(ref)) {
    return {
      ok: false,
      code: "CAPABILITY_NOT_DISCOVERED",
      message: `${ref === "" ? "capability không tên" : ref} chưa được discover trên node này, nên chưa gọi được. Discover nó trước.`,
    };
  }
  return {
    ok: true,
    envelope: {
      kind: "capability",
      surface: "capability",
      capabilityRef: ref,
      effectCategory: input.effectCategory,
      guardClass: guardClassFor({ surface: "capability", effectCategory: input.effectCategory }),
    },
  };
}

export type NarrowingResult =
  | { ok: true; envelope: CommandEnvelope; applied: readonly GuardrailConstraint[] }
  | { ok: false; code: "GUARDRAIL_WIDENS"; message: string };

/**
 * Apply what a guardrail asked for, or refuse the whole answer.
 *
 * The single invariant that makes the guardrail a judgment layer rather than an authority: it may only
 * shrink. A constraint that would extend the deadline, raise the output ceiling, or move the directory
 * outside the one the host resolved is refused outright rather than clamped, because clamping would
 * silently turn "widen this" into "do something else" and the caller would never learn that the policy
 * layer is not the one it thought it was talking to.
 */
export function applyGuardrailConstraints(
  envelope: CommandEnvelope,
  constraints: readonly GuardrailConstraint[],
): NarrowingResult {
  let next: CommandEnvelope = envelope;
  const applied: GuardrailConstraint[] = [];

  for (const constraint of constraints) {
    if (constraint.kind === "timeout-ms") {
      if (constraint.value > next.budget.timeoutMs) {
        return {
          ok: false,
          code: "GUARDRAIL_WIDENS",
          message: `guardrail xin thêm thời gian (${constraint.value} ms > ${next.budget.timeoutMs} ms), và nó chỉ được thu hẹp.`,
        };
      }
      next = { ...next, budget: { ...next.budget, timeoutMs: constraint.value } };
    } else if (constraint.kind === "max-output-bytes") {
      if (constraint.value > next.budget.maxOutputBytes) {
        return {
          ok: false,
          code: "GUARDRAIL_WIDENS",
          message: `guardrail xin nới trần output (${constraint.value} > ${next.budget.maxOutputBytes} byte), và nó chỉ được thu hẹp.`,
        };
      }
      next = { ...next, budget: { ...next.budget, maxOutputBytes: constraint.value } };
    } else {
      const target = resolve(constraint.value);
      const insideCurrent = containingRoot({ roots: [next.cwd] }, target) !== undefined;
      // Two checks, not one: inside the directory that was resolved *and* still inside the owned root.
      // A relative path that climbs out of `cwd` would pass the first check on a naive comparison and
      // fail the second, which is the one that matters.
      if (!insideCurrent || containingRoot({ roots: [next.root] }, target) === undefined) {
        return {
          ok: false,
          code: "GUARDRAIL_WIDENS",
          message: `guardrail xin chạy ở ${target}, ngoài thư mục ${next.cwd} mà host đã xác định.`,
        };
      }
      next = { ...next, cwd: target };
    }
    applied.push(constraint);
  }

  return { ok: true, envelope: next, applied };
}

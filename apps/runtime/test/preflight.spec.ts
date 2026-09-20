import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CommandEnvelope,
  applyGuardrailConstraints,
  classifyCommand,
  containingRoot,
  ownedResources,
  preflightCapability,
  preflightCommand,
} from "../src/preflight.ts";
import { COMMAND_LIMITS } from "../src/run-command.ts";

/**
 * The deterministic gate.
 *
 * Every case here is one a model cannot argue its way out of: a folder this node does not own, a
 * directory that is not there, a capability that was never discovered, a "constraint" that tries to
 * widen the envelope it was given. The guardrail is only allowed to be the judgment layer because this
 * file is not negotiable, so these are the tests that make autonomy defensible.
 */
describe("the folders this node owns", () => {
  let base: string;
  let owned: string;
  let outside: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "clarkcant-preflight-"));
    owned = join(base, "owned");
    outside = join(base, "outside");
    mkdirSync(join(owned, "sub"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(owned, "file.txt"), "not a directory");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("treats a root as inside itself, and reports the nested root rather than the tree around it", () => {
    const resources = ownedResources([base, owned]);
    expect(containingRoot(resources, owned)).toBe(owned);
    expect(containingRoot(resources, join(owned, "sub"))).toBe(owned);
  });

  it("owns nothing when it was given nothing", () => {
    expect(ownedResources(["", undefined, "   "]).roots).toEqual([]);
    expect(containingRoot(ownedResources([]), owned)).toBeUndefined();
  });

  it("refuses a command that would run outside them", () => {
    const result = preflightCommand({ command: "ls -la", cwd: outside, resources: ownedResources([owned]) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("OUTSIDE_OWNED_RESOURCES");
    // The message has to be actionable: the model reads it and has to pick somewhere else.
    expect(result.message).toContain(outside);
    expect(result.message).toContain(owned);
  });

  it("refuses everything when no folder is owned at all", () => {
    const result = preflightCommand({ command: "ls", cwd: owned, resources: ownedResources([]) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("OUTSIDE_OWNED_RESOURCES");
    expect(result.message).toContain("chưa cấu hình");
  });

  it("refuses a directory that is not there, and a file pretending to be one", () => {
    const missing = preflightCommand({ command: "ls", cwd: join(owned, "nope"), resources: ownedResources([owned]) });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("UNKNOWN_DIRECTORY");

    const file = preflightCommand({ command: "ls", cwd: join(owned, "file.txt"), resources: ownedResources([owned]) });
    expect(file.ok).toBe(false);
    if (!file.ok) expect(file.code).toBe("UNKNOWN_DIRECTORY");
  });

  it("refuses an empty command and one long enough to be a script", () => {
    const empty = preflightCommand({ command: "  ", cwd: owned, resources: ownedResources([owned]) });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe("EMPTY_COMMAND");

    const long = preflightCommand({
      command: `echo ${"x".repeat(COMMAND_LIMITS.maxCommandLength)}`,
      cwd: owned,
      resources: ownedResources([owned]),
    });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.code).toBe("COMMAND_TOO_LONG");
  });

  it("lets an owned directory through with a budget attached", () => {
    const result = preflightCommand({ command: "git status", cwd: owned, resources: ownedResources([owned]) });
    expect(result.ok).toBe(true);
    if (!result.ok || result.envelope.kind !== "command") return;
    expect(result.envelope.cwd).toBe(owned);
    expect(result.envelope.root).toBe(owned);
    expect(result.envelope.budget).toEqual({
      timeoutMs: COMMAND_LIMITS.timeoutMs,
      maxOutputBytes: COMMAND_LIMITS.maxOutputBytes,
    });
    expect(result.envelope.guardClass).toBe("commands");
  });

  it("uses the fallback directory when the caller named none, and still contains it", () => {
    const inside = preflightCommand({ command: "pwd", resources: ownedResources([owned]), fallbackCwd: join(owned, "sub") });
    expect(inside.ok).toBe(true);

    const outsideFallback = preflightCommand({ command: "pwd", resources: ownedResources([owned]), fallbackCwd: outside });
    expect(outsideFallback.ok).toBe(false);
    if (!outsideFallback.ok) expect(outsideFallback.code).toBe("OUTSIDE_OWNED_RESOURCES");
  });
});

describe("what a command looks like", () => {
  it("reads a recursive delete as destructive", () => {
    const classification = classifyCommand("rm -rf build");
    expect(classification.destructive).toBe(true);
    expect(classification.recursive).toBe(true);
    expect(classification.effectCategory).toBe("destructive");
  });

  it("knows a read-only command when it sees one", () => {
    expect(classifyCommand("git log --oneline -5").effectCategory).toBe("read");
    expect(classifyCommand("pnpm list").effectCategory).toBe("read");
    expect(classifyCommand("git status").commandClass).toBe("read");
  });

  it("treats a push as an external write", () => {
    const push = classifyCommand("git push origin main");
    expect(push.effectCategory).toBe("external-write");
    expect(push.commandClass).toBe("network");
  });

  it("does not let a force push hide behind the git family", () => {
    const forced = classifyCommand("git push --force origin main");
    expect(forced.destructive).toBe(true);
    expect(forced.effectCategory).toBe("destructive");
  });

  it("counts the arguments that look like paths, and nothing else", () => {
    const classification = classifyCommand("rm -rf ./build ../cache /tmp/x --verbose");
    expect(classification.estimatedTargets).toBe(3);
  });

  it("defaults an unknown command to a local write rather than to a read", () => {
    expect(classifyCommand("some-tool --do-it").effectCategory).toBe("local-write");
    expect(classifyCommand("some-tool --do-it").commandClass).toBe("shell");
  });

  it("recognises a build or test run", () => {
    expect(classifyCommand("pnpm vitest run").commandClass).toBe("package-manager");
    expect(classifyCommand("make build").commandClass).toBe("build");
  });

  it("gives the guardrail the shape of a delete without deciding anything", () => {
    const classification = classifyCommand("rm -rf packages/core");
    expect(classification).toMatchObject({
      commandClass: "filesystem.delete",
      destructive: true,
      recursive: true,
      estimatedTargets: 1,
    });
  });
});

describe("capability existence", () => {
  it("refuses a capability this node has not discovered", () => {
    const result = preflightCapability({
      capabilityRef: "capability:github",
      effectCategory: "external-write",
      discovered: new Set(["capability:calendar"]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("CAPABILITY_NOT_DISCOVERED");
  });

  it("refuses a nameless one too", () => {
    const result = preflightCapability({ capabilityRef: "   ", effectCategory: "read", discovered: new Set(["anything"]) });
    expect(result.ok).toBe(false);
  });

  it("governs a discovered capability by how far its effect reaches", () => {
    const result = preflightCapability({
      capabilityRef: "capability:github",
      effectCategory: "external-write",
      discovered: new Set(["capability:github"]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.envelope.kind !== "capability") return;
    expect(result.envelope.guardClass).toBe("external-writes");
  });
});

describe("a guardrail may only narrow", () => {
  const envelope = (): CommandEnvelope => {
    const result = preflightCommand({
      command: "pnpm build",
      cwd: ".",
      resources: ownedResources([process.cwd()]),
    });
    if (!result.ok || result.envelope.kind !== "command") throw new Error("the fixture command did not preflight");
    return result.envelope;
  };

  it("applies a smaller deadline and a smaller ceiling", () => {
    const narrowed = applyGuardrailConstraints(envelope(), [
      { kind: "timeout-ms", value: 30_000 },
      { kind: "max-output-bytes", value: 2_000 },
    ]);
    expect(narrowed.ok).toBe(true);
    if (!narrowed.ok) return;
    expect(narrowed.envelope.budget).toEqual({ timeoutMs: 30_000, maxOutputBytes: 2_000 });
    expect(narrowed.applied).toHaveLength(2);
  });

  it("refuses a longer deadline rather than clamping it", () => {
    const widened = applyGuardrailConstraints(envelope(), [{ kind: "timeout-ms", value: 600_000 }]);
    expect(widened.ok).toBe(false);
    if (widened.ok) return;
    expect(widened.code).toBe("GUARDRAIL_WIDENS");
  });

  it("refuses a larger output ceiling", () => {
    const widened = applyGuardrailConstraints(envelope(), [{ kind: "max-output-bytes", value: 900_000 }]);
    expect(widened.ok).toBe(false);
  });

  it("allows a subdirectory and refuses a climb out of one", () => {
    const down = applyGuardrailConstraints(envelope(), [{ kind: "cwd", value: "packages/core" }]);
    expect(down.ok).toBe(true);
    if (down.ok) expect(down.envelope.cwd.endsWith(join("packages", "core"))).toBe(true);

    const up = applyGuardrailConstraints(envelope(), [{ kind: "cwd", value: ".." }]);
    expect(up.ok).toBe(false);
    if (!up.ok) expect(up.code).toBe("GUARDRAIL_WIDENS");

    // A folder that is absolute and outside the envelope's own, spelled the same way on every platform: the Windows
    // path that used to be here is a relative one on Linux, so the refusal was about something else there.
    const absolute = applyGuardrailConstraints(envelope(), [{ kind: "cwd", value: join(tmpdir(), "clarkcant-elsewhere") }]);
    expect(absolute.ok).toBe(false);
  });

  it("refuses the whole answer when any part of it would widen", () => {
    // Not "apply the good ones": a policy layer that tried to widen is not the one the caller thinks it
    // is talking to, and quietly keeping half of its answer hides that.
    const mixed = applyGuardrailConstraints(envelope(), [
      { kind: "timeout-ms", value: 10_000 },
      { kind: "timeout-ms", value: 600_000 },
    ]);
    expect(mixed.ok).toBe(false);
  });
});

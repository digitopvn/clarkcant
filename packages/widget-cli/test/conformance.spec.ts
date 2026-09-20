import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.ts";
import { runConformance } from "../src/conformance.ts";
import { readPackage } from "@clarkcant/core";

/**
 * The author's three commands, run for real.
 *
 * Every test here scaffolds into a temporary directory and then runs the suite against it, rather than asserting
 * against a checked-in fixture package. That matters for one reason above the others: the suite's job is to refuse
 * a package, and a suite only ever pointed at a good package has never been asked to.
 *
 * The status split is the other thing worth testing. A widget is a browser artifact and this runs in Node, so the
 * checks that need a rendered frame are reported as `requires-dev-host`. A suite that marked them passing because a
 * fixture file exists would be the "do not advertise what is not shipped" rule broken by the tool that is meant to
 * enforce it — so the count is asserted, not just the absence of failures.
 */

const created: string[] = [];

async function tempPackage(template: "blank" | "form" | "dashboard" = "blank"): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "clark-widget-"));
  created.push(root);
  const code = await runCli(["widget", "init", root, "--template", template]);
  expect(code).toBe(0);
  return root;
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("clark widget init", () => {
  it("scaffolds the layout the standard describes", async () => {
    const root = await tempPackage("dashboard");

    for (const path of [
      "clarkcant.json",
      "widgets/main/widget.json",
      "widgets/main/index.html",
      "fixtures/default.json",
      "fixtures/empty.json",
      "fixtures/error.json",
      "fixtures/compact.json",
      "README.md",
      "LICENSE",
    ]) {
      expect(existsSync(join(root, path)), `${path} was not created`).toBe(true);
    }
  });

  it("creates a package that passes its own conformance suite", async () => {
    const result = runConformance(await tempPackage("form"));

    // The template is the first thing an author runs the suite against, so a template that fails would teach them
    // the wrong lesson about what the suite is for.
    expect(result.checks.filter((check) => check.status === "fail").map((check) => check.id)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("refuses an unknown template instead of quietly scaffolding blank", async () => {
    const root = join(tmpdir(), "clark-widget-unknown");
    const code = await runCli(["widget", "init", root, "--template", "nope"]);

    expect(code).toBe(2);
    expect(existsSync(root)).toBe(false);
  });
});

describe("the conformance status split", () => {
  it("reports the browser checks as unverified rather than as passing", async () => {
    const result = runConformance(await tempPackage());
    const unverified = result.checks.filter((check) => check.status === "requires-dev-host").map((check) => check.id);

    // Named individually: the point is that this command does not claim them.
    expect(unverified).toContain("interaction.keyboard");
    expect(unverified).toContain("interaction.touchSize");
    expect(unverified).toContain("interaction.voiceClickParity");
    expect(unverified).toContain("rendering.reducedMotion");
    expect(unverified).toContain("rendering.narrow");
    expect(result.summary["requires-dev-host"]).toBe(unverified.length);
  });

  it("does the checks Node can honestly do", async () => {
    const result = runConformance(await tempPackage());
    const passed = result.checks.filter((check) => check.status === "pass").map((check) => check.id);

    // These are real: the runtime, the frame session and the codec are the same code in a browser and in a test.
    expect(passed).toContain("schema.props.valid");
    expect(passed).toContain("schema.props.malformedRejected");
    expect(passed).toContain("schema.props.additionalRejected");
    expect(passed).toContain("security.forgedNonceRejected");
    expect(passed).toContain("security.wrongSourceRejected");
    expect(passed).toContain("security.noSecretSurface");
    expect(passed).toContain("lifecycle.mount");
    expect(passed).toContain("lifecycle.suspendResume");
    expect(passed).toContain("lifecycle.disposeCleanup");
    expect(passed).toContain("interaction.dedup");
    expect(passed).toContain("interaction.staleRevision");
  });
});

describe("what the suite refuses", () => {
  it("refuses a package whose manifest does not match the schema", async () => {
    const root = await tempPackage();
    writeFileSync(join(root, "clarkcant.json"), JSON.stringify({ schemaVersion: 1, id: "x" }));

    const result = runConformance(root);

    expect(result.ok).toBe(false);
    expect(result.checks.some((check) => check.id === "package.readable" && check.status === "fail")).toBe(true);
  });

  it("refuses a package missing the fixtures the standard requires", async () => {
    const root = await tempPackage();
    rmSync(join(root, "fixtures", "error.json"));

    const result = runConformance(root);

    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.id === "rendering.fixtures");
    expect(check?.status).toBe("fail");
    // Named, so an author knows which one is missing rather than that "a fixture" is.
    expect(check?.detail).toContain("error");
  });

  it("refuses an entry that reaches an origin the manifest does not declare", async () => {
    const root = await tempPackage();
    const entry = join(root, "widgets", "main", "index.html");
    writeFileSync(entry, `${readFileSync(entry, "utf8")}\n<script src="https://cdn.example.test/x.js"></script>\n`);

    const result = runConformance(root);

    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.id === "security.undeclaredNetwork");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("https://cdn.example.test");
  });

  it("refuses props the schema does not allow", async () => {
    const root = await tempPackage();
    // A fixture that violates the schema it is a fixture for: the suite's job is to notice, not to trust the file.
    writeFileSync(join(root, "fixtures", "default.json"), JSON.stringify({ title: "ok", undeclared: true }));

    const result = runConformance(root);

    const check = result.checks.find((c) => c.id === "schema.props.valid");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("undeclared");
  });

  it("fails a package whose facet id disagrees with its definition id", async () => {
    const root = await tempPackage();
    const definitionPath = join(root, "widgets", "main", "widget.json");
    const definition = JSON.parse(readFileSync(definitionPath, "utf8")) as Record<string, unknown>;
    definition["id"] = "com.example.something-else@1";
    writeFileSync(definitionPath, JSON.stringify(definition));

    // Two places saying the same thing, disagreeing: the instance would not resolve to what it renders.
    expect(readPackage(root).problems.join(" ")).toContain("does not match the manifest facet id");
  });
});

describe("clark widget pack", () => {
  it("writes an artifact with a digest, and records what was not verified", async () => {
    const root = await tempPackage();

    expect(await runCli(["widget", "pack", root])).toBe(0);

    const artifact = JSON.parse(readFileSync(join(root, "dist", "artifact.json"), "utf8")) as {
      digest: string;
      files: { path: string }[];
      unverifiedChecks: string[];
      definitionDigest: string;
    };
    expect(artifact.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifact.definitionDigest).toMatch(/^sha256:/);
    expect(artifact.files.map((file) => file.path)).toContain("widgets/main/widget.json");
    // The artifact says what it did not verify, so a reader of the metadata is not left assuming the browser checks
    // passed.
    expect(artifact.unverifiedChecks).toContain("rendering.reducedMotion");
  });

  it("refuses to repack the same version after its bytes changed", async () => {
    const root = await tempPackage();
    expect(await runCli(["widget", "pack", root])).toBe(0);

    const entry = join(root, "widgets", "main", "index.html");
    writeFileSync(entry, `${readFileSync(entry, "utf8")}\n<!-- changed after packing -->\n`);

    // A version whose bytes changed is a different package wearing the same number, and the install path assumes
    // the opposite.
    expect(await runCli(["widget", "pack", root])).toBe(1);
  });

  it("refuses to pack a package that fails conformance", async () => {
    const root = await tempPackage();
    rmSync(join(root, "fixtures", "empty.json"));

    expect(await runCli(["widget", "pack", root])).toBe(1);
    expect(existsSync(join(root, "dist", "artifact.json"))).toBe(false);
  });
});

describe("commands that are not implemented", () => {
  it("prints usage for an unknown command", async () => {
    expect(await runCli(["widget"])).toBe(2);
    expect(await runCli(["nonsense"])).toBe(2);
  });

  it("prepares the submission rather than claiming to have submitted it", async () => {
    /*
     * The plan scopes this as "may initially prepare directory submission", and the difference matters: the command
     * writes what a directory would receive and says that sending it needs an account. A command that looked as
     * though it had already published would be a control whose action does not exist.
     */
    const root = await tempPackage();
    expect(await runCli(["widget", "publish", root])).toBe(0);
    expect(existsSync(join(root, "dist", "directory-entry.json"))).toBe(true);
  });

});

describe("clark widget publish", () => {
  it("prepares a directory entry with the artifact's own digest and the declared risk lane", async () => {
    const root = await tempPackage("dashboard");

    expect(await runCli(["widget", "publish", root])).toBe(0);

    const entry = JSON.parse(readFileSync(join(root, "dist", "directory-entry.json"), "utf8")) as Record<string, unknown>;
    const artifact = JSON.parse(readFileSync(join(root, "dist", "artifact.json"), "utf8")) as { digest: string };

    /*
     * The digest is the artifact's, read from what `pack` produced rather than recomputed. Two computations of the
     * same thing is how a listing comes to name an artifact nobody can produce.
     */
    expect(entry["digest"]).toBe(artifact.digest);
    const manifest = JSON.parse(readFileSync(join(root, "clarkcant.json"), "utf8")) as { id: string };
    expect(entry["packageId"]).toBe(manifest.id);
    expect(entry["riskTier"]).toBe("isolated-ui");
    expect(entry["facets"]).toEqual(["ui"]);
    expect(entry["sizeBytes"]).toBeGreaterThan(0);
    // Every field the standard requires, present — a directory would reject the entry otherwise.
    for (const field of ["version", "displayName", "description", "publisher", "platforms", "hostApi", "permissionsSummary", "preview"]) {
      expect(entry[field], field).toBeDefined();
    }
  });

  it("refuses to publish a package that fails conformance", async () => {
    const root = await tempPackage();
    rmSync(join(root, "fixtures", "error.json"));

    expect(await runCli(["widget", "publish", root])).toBe(1);
    expect(existsSync(join(root, "dist", "directory-entry.json"))).toBe(false);
  });

  it("refuses to prepare the same version twice after its bytes changed", async () => {
    const root = await tempPackage();
    expect(await runCli(["widget", "publish", root])).toBe(0);

    const entry = join(root, "widgets", "main", "index.html");
    writeFileSync(entry, readFileSync(entry, "utf8") + "\n<!-- changed -->\n");

    // A version whose bytes changed is a different package wearing the same number, and a directory that received
    // both would hold two entries nobody can tell apart.
    expect(await runCli(["widget", "publish", root])).toBe(1);
  });
});

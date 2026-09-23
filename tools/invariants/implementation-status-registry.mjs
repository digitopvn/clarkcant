/**
 * The implementation-status registry.
 *
 * A registry that lies is worse than no registry, so this check is not a spelling test on a data
 * file. It holds four properties at once:
 *
 *   - every entry names a workspace package that exists, with that package's declared phase;
 *   - `implemented` names at least one test, and each named test exists in the file it names (the
 *     reason "the schema exists" is not allowed to pass is here: a schema has no title);
 *   - an `implemented` entry's evidence must also be able to run: a title a platform condition skips
 *     (`describe.skipIf(!POSIX)`) is not evidence on a runner where that condition does not hold, so
 *     an entry whose every named test sits under one is rejected rather than reported as green. Two
 *     entries passed exactly that way before this rule existed, which is why it is here;
 *   - every other status names what is missing, and the four external gates this program must keep
 *     open (#2 Calendar account, #3 Computer Use signing, #4 live voice provider, #5 two-host
 *     NodeLink) stay represented by at least one entry, so a gate cannot quietly stop being a gate;
 *   - every `@status-ref` in source resolves, every scope id agrees with
 *     docs/conformance-traceability.md, and no `@implementation-status` marker survives.
 */
import { join } from "node:path";

import { existsSync, readFileSync, readdirSync } from "./context.mjs";
import { platformSkippedTestTitles } from "../platform-skipped-tests.mjs";

export default function run(ctx) {
  const { repoRoot, check, walk, relative, readJson, statusRegistry, statusRegistryError, statusById, REGISTRY_PATH } =
    ctx;
  const c = check("implementation-status-registry");
  const statuses = new Set(["implemented", "partial", "blocked", "not-implemented"]);
  const docStatusOf = {
    implemented: "PASS",
    partial: "PARTIAL",
    blocked: "BLOCKED",
    "not-implemented": "NOT-IMPLEMENTED",
  };

  if (statusRegistryError) {
    c.failures.push(`${REGISTRY_PATH} could not be loaded: ${statusRegistryError.message}`);
  } else if (!Array.isArray(statusRegistry)) {
    c.failures.push(`${REGISTRY_PATH} does not export an IMPLEMENTATION_STATUS array`);
  } else {
    /*
     * Which titles in a cited file a platform condition keeps from running, read once per file. The rule below is
     * about evidence that cannot execute where the check runs, and the POSIX socket suite is the instance of it this
     * repository actually has: `apps/runtime/test/portable-runtime.spec.ts` skips its socket tests on Windows with
     * the reason named.
     */
    const platformSkippedByFile = new Map();
    const platformSkippedIn = (file) => {
      if (!platformSkippedByFile.has(file)) {
        try {
          platformSkippedByFile.set(file, platformSkippedTestTitles(readFileSync(join(repoRoot, file), "utf8")));
        } catch (error) {
          /*
           * A file that cannot be parsed yields no skips, which would read as "everything in it runs". That is the
           * one answer this must never invent, so the file is failed rather than recorded as empty.
           */
          c.failures.push(`${file} could not be read for platform-conditional skips: ${error.message}`);
          platformSkippedByFile.set(file, new Map());
        }
      }
      return platformSkippedByFile.get(file);
    };

    const packagesByName = new Map();
    for (const group of ["packages", "apps", "packs", "examples"]) {
      const groupDir = join(repoRoot, group);
      if (!existsSync(groupDir)) continue;
      for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
        const manifestPath = join(groupDir, entry.name, "package.json");
        if (!existsSync(manifestPath)) continue;
        const manifest = readJson(manifestPath);
        packagesByName.set(manifest.name, { phase: manifest.clarkcant?.phase, path: `${group}/${entry.name}` });
      }
    }

    const seenIds = new Set();
    for (const entry of statusRegistry) {
      const id = entry?.capabilityId;
      const label = typeof id === "string" ? id : "(entry without a capabilityId)";
      if (typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9.-]*$/.test(id)) {
        c.failures.push(`${label} is not a usable capability id`);
      } else if (seenIds.has(id)) {
        c.failures.push(`the registry defines ${id} more than once`);
      } else {
        seenIds.add(id);
      }
      if (!statuses.has(entry.status)) {
        c.failures.push(`${label} has status ${JSON.stringify(entry.status)}, which is not one of the four`);
      }
      if (typeof entry.summary !== "string" || entry.summary.length === 0) {
        c.failures.push(`${label} has no summary`);
      }
      const owner = packagesByName.get(entry.owningPackage);
      if (owner === undefined) {
        c.failures.push(`${label} names owning package ${entry.owningPackage}, which is not a workspace package`);
      } else if (owner.phase !== entry.phase) {
        c.failures.push(
          `${label} says phase ${entry.phase} but ${owner.path} declares clarkcant.phase ${owner.phase}`,
        );
      }

      const evidence = Array.isArray(entry.evidenceTests) ? entry.evidenceTests : [];
      if (!Array.isArray(entry.evidenceTests)) {
        c.failures.push(`${label} has no evidenceTests array`);
      }
      for (const item of evidence) {
        const full = typeof item?.file === "string" ? join(repoRoot, item.file) : null;
        if (full === null || !existsSync(full)) {
          c.failures.push(`${label} names a test file that does not exist: ${item?.file}`);
          continue;
        }
        if (item.test !== undefined && !readFileSync(full, "utf8").includes(item.test)) {
          c.failures.push(`${label} names a test that is not in ${item.file}: "${item.test}"`);
        }
      }

      if (entry.status === "implemented") {
        if (evidence.length === 0) {
          c.failures.push(`${label} is implemented but names no test at all`);
        }
        for (const item of evidence) {
          if (item.test === undefined) {
            c.failures.push(`${label} is implemented but its evidence for ${item?.file} is untitled`);
          }
        }
        /*
         * Evidence that exists and never executes is not evidence. A title inside `describe.skipIf(!POSIX)` is named
         * and present and skipped on every runner where the condition does not hold, so an entry whose whole evidence
         * set is like that is green with nothing executed. One test that runs where the check runs is enough; an
         * entry that genuinely cannot be proven off its platform belongs in `partial`, naming that as the gap.
         */
        const runnable = evidence.filter(
          (item) =>
            typeof item?.file === "string" &&
            typeof item?.test === "string" &&
            existsSync(join(repoRoot, item.file)),
        );
        if (runnable.length > 0 && runnable.every((item) => platformSkippedIn(item.file).has(item.test))) {
          const conditions = [...new Set(runnable.map((item) => platformSkippedIn(item.file).get(item.test)))];
          c.failures.push(
            `${label} is implemented but every test it names is skipped by a platform condition (${conditions.join("; ")}), ` +
              "so on a runner where that condition does not hold it has no executed evidence: " +
              runnable.map((item) => `${item.file} "${item.test}"`).join(", "),
          );
        }
        if (entry.externalGate !== undefined) {
          c.failures.push(`${label} is implemented and still carries an external gate; one of the two is wrong`);
        }
      }
      if (entry.status === "partial" && evidence.length === 0) {
        c.failures.push(`${label} is partial but names no test for the layer that does work`);
      }
      if (entry.status !== "implemented" && typeof entry.externalGate?.reason !== "string") {
        c.failures.push(`${label} is ${entry.status} but does not name what is missing`);
      }
    }

    /* Every `@status-ref` in source has to resolve, and no self-asserting marker may come back. */
    const sources = ["packages", "apps", "packs", "examples"]
      .flatMap((group) => walk(join(repoRoot, group), (path) => /\.tsx?$/.test(path)))
      .map((path) => relative(path));
    let references = 0;
    for (const path of sources) {
      const source = readFileSync(join(repoRoot, path), "utf8");
      for (const match of source.matchAll(/@status-ref\s+([A-Za-z0-9.-]+)/g)) {
        references += 1;
        if (!statusById.has(match[1])) {
          c.failures.push(`${path} references capability ${match[1]}, which the registry does not define`);
        }
      }
      if (source.includes("@implementation-status")) {
        c.failures.push(
          `${path} still carries an @implementation-status marker; status lives in ${REGISTRY_PATH} - point at it with @status-ref <capabilityId>`,
        );
      }
    }
    if (references === 0) {
      c.failures.push("no source file references the registry, so this check has no subject");
    }

    /* Scope ids carry two statuses at once, so they are checked against each other. */
    const tracePath = join(repoRoot, "docs", "conformance-traceability.md");
    const traceability = readFileSync(tracePath, "utf8");
    const documented = new Map();
    for (const line of traceability.split("\n")) {
      const row = line.match(/^\| (V\d{2}) \| (PASS|PARTIAL|BLOCKED|NOT-IMPLEMENTED) \|/);
      if (row) documented.set(row[1], row[2]);
    }
    for (const [id, documentedStatus] of documented) {
      const entry = statusById.get(id);
      if (entry === undefined) {
        c.failures.push(`docs/conformance-traceability.md states ${id} but the registry has no entry for it`);
      } else if (docStatusOf[entry.status] !== documentedStatus) {
        c.failures.push(
          `${id}: registry says ${entry.status} (${docStatusOf[entry.status]}) but the traceability document says ${documentedStatus}`,
        );
      }
    }
    for (const entry of statusRegistry) {
      if (/^V\d{2}$/.test(entry.capabilityId) && !documented.has(entry.capabilityId)) {
        c.failures.push(`the registry carries ${entry.capabilityId}, which docs/conformance-traceability.md omits`);
      }
    }

    /*
     * The external gates are the point of being honest about blocked work, so they stay named.
     * Only the four this program must keep open are pinned to an issue number, and any other issue
     * number is rejected rather than ignored: the header rule that a gap waiting on nothing outside
     * this repository is described by the gap itself is a rule about the field, not advice for the
     * reader, and a rejected number is the only way a check can enforce it.
     */
    const openGates = [2, 3, 4, 5];
    const gateIssues = new Set();
    for (const entry of statusRegistry) {
      const issue = entry.externalGate?.issue;
      if (typeof issue !== "number") continue;
      if (!openGates.includes(issue)) {
        c.failures.push(
          `${entry.capabilityId} pins its external gate to #${issue}; #${openGates.join("/#")} are the only gates this program keeps open, and a gap that waits on nothing outside the repository is described by the gap itself`,
        );
        continue;
      }
      gateIssues.add(issue);
    }
    for (const issue of openGates) {
      if (!gateIssues.has(issue)) {
        c.failures.push(`external gate #${issue} is no longer represented by any registry entry`);
      }
    }

    c.notes.push(
      `${statusRegistry.length} entries (${[...statusRegistry].filter((e) => e.status === "implemented").length} implemented, ` +
        `${[...statusRegistry].filter((e) => e.status === "partial").length} partial, ` +
        `${[...statusRegistry].filter((e) => e.status === "blocked").length} blocked, ` +
        `${[...statusRegistry].filter((e) => e.status === "not-implemented").length} not-implemented) verified against ${packagesByName.size} workspace packages`,
    );
    c.notes.push(`${references} @status-ref reference(s) across ${sources.length} source files`);
    c.notes.push(`${documented.size} V row(s) agree with the registry; gates #${[...gateIssues].sort((a, b) => a - b).join("/#")} represented`);
    const platformSkippedEntries = statusRegistry.filter((entry) =>
      (entry.evidenceTests ?? []).some(
        (item) =>
          typeof item?.file === "string" &&
          typeof item?.test === "string" &&
          existsSync(join(repoRoot, item.file)) &&
          platformSkippedIn(item.file).has(item.test),
      ),
    );
    if (platformSkippedEntries.length > 0) {
      c.notes.push(
        `${platformSkippedEntries.map((entry) => entry.capabilityId).join(", ")} cite a test a platform condition skips on some runners, ` +
          "so their evidence is thinner there than on this one",
      );
    }
    c.notes.push(
      "evidence is checked for existence and for a platform-conditional skip: a runtime condition that is not " +
        "derived from process.platform or process.arch (an opt-in live provider, for instance) is not this check's subject",
    );
  }
}

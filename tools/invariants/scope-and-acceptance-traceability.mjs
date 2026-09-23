/**
 * The blueprint names its scope items V01–V18 and acceptance tests T01–T73. Every
 * one must have its own row in the traceability document, so a reader can find
 * out what is real without reading source.
 */
import { join } from "node:path";

import { existsSync, readFileSync } from "./context.mjs";

export default function run(ctx) {
  const { repoRoot, check, walk } = ctx;
  const c = check("scope-and-acceptance-traceability");
  const tracePath = join(repoRoot, "docs", "conformance-traceability.md");
  if (!existsSync(tracePath)) {
    c.failures.push("docs/conformance-traceability.md is missing");
  } else {
    const source = readFileSync(tracePath, "utf8");
    /*
     * A row marker, not a substring anywhere in the file.
     *
     * The previous version asked `source.includes(id)`, and the prose that introduces this table
     * spells the ranges `V01`–`V18` and `T01`–`T73` out in full - so both ends of each range were
     * satisfied by that sentence alone, and deleting the `| T73 | …` row left every check green. A
     * presence check has to be about the row, because the row is what a reader uses.
     */
    const rowIds = new Set([...source.matchAll(/^\| (V\d{2}|T\d{2}) \|/gm)].map((match) => match[1]));
    for (let i = 1; i <= 18; i += 1) {
      const id = `V${String(i).padStart(2, "0")}`;
      if (!rowIds.has(id)) c.failures.push(`traceability document omits the ${id} row`);
    }
    for (let i = 1; i <= 73; i += 1) {
      const id = `T${String(i).padStart(2, "0")}`;
      if (!rowIds.has(id)) c.failures.push(`traceability document omits the ${id} row`);
    }

    /*
     * A row that cites a test has to cite one that exists.
     *
     * An independent audit found why this belongs here: T73's row and the plan's voice criterion both named a
     * browser journey that was not in the shipped file, and the browser suite was green precisely because the
     * journey was absent - a test that does not exist cannot fail. Checking that an id appears is not checking
     * that its evidence does, so a ledger could cite a test nobody ever wrote and every gate would agree.
     *
     * Only sentence-shaped quoted titles are checked, because rows also quote Vietnamese messages and file names,
     * and those are not claims about a test.
     */
    const specFiles = ["packages", "apps", "packs", "examples"].flatMap((group) =>
      walk(join(repoRoot, group), (f) => f.endsWith(".spec.ts") || f.endsWith(".spec.tsx")),
    );
    const specText = specFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    const citedTitles = new Set();
    for (const line of source.split("\n")) {
      if (!/^\| (?:T|V)\d+ \|/.test(line)) continue;
      for (const match of line.matchAll(/"([a-z][a-z0-9 ,:'’()/.-]{11,})"/g)) citedTitles.add(match[1]);
    }
    let missing = 0;
    for (const title of citedTitles) {
      if (!specText.includes(title)) {
        c.failures.push(`traceability cites a test that exists nowhere: "${title}"`);
        missing += 1;
      }
    }

    /*
     * The loop above is the whole of this check, and its limit is worth naming where the check lives: a
     * row is held to a quoted title only when it quotes one. A companion rule that also accepted a bare
     * spec basename was tried and removed, because it proved nothing about the row it sat on - an
     * unrelated but existing file name (`see widget.spec for the detail`) satisfied it. Proving a PASS or
     * PARTIAL row is what it claims would mean requiring a quoted title that exists on every row, which
     * several rows cannot give: their evidence is an integration path rather than one titled case.
     */
    c.notes.push(
      `${citedTitles.size} cited test titles checked against ${specFiles.length} spec files` +
        (missing === 0 ? "" : `, ${missing} missing`) +
        "; rows that cite a path rather than a quoted title are not matched to a case",
    );
  }
}

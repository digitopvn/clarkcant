/**
 * No checked-in PR body may carry a closing keyword beside an issue reference.
 *
 * Every phase PR of the architecture-consolidation program carried a sentence saying it did not close the
 * external gates. That sentence contained the literal pair, GitHub's parser matched it, and #93 and #125 were
 * closed as a side effect of the merges while each body said the opposite. A negative statement about a closing
 * keyword still contains the keyword.
 *
 * The bodies are committed as a `pr-*-body.md` file inside a plan directory, so this is the one control that
 * could have fired before a PR existed. The check fails when it finds no such file at all, so it cannot pass by
 * having lost its own subject. The matching lives in issue-closing-keywords.mjs so it can be tested, and it
 * deliberately does not fire on prose that merely names an issue number: the honest sentence has to be writable.
 *
 * This is a second rule, not a replacement. The four external gates the program must keep open stay pinned to
 * their issue numbers by the registry check above, which is about a gate being represented rather than about a
 * merge closing something.
 */
import { basename, join } from "node:path";

import { readFileSync } from "./context.mjs";
import { closingKeywordMatches } from "../issue-closing-keywords.mjs";

export default function run(ctx) {
  const { repoRoot, check, walk, relative } = ctx;
  const c = check("pr-bodies-close-nothing");
  const bodies = walk(join(repoRoot, "plans"), (path) => /^pr-.+-body\.md$/.test(basename(path)));

  if (bodies.length === 0) {
    c.failures.push("no pr-*-body.md file is checked in under plans, so this check has no subject");
  }

  let pairs = 0;
  for (const path of bodies) {
    for (const match of closingKeywordMatches(readFileSync(path, "utf8"))) {
      pairs += 1;
      c.failures.push(
        `${relative(path)}:${match.line} contains "${match.matched}", which GitHub reads as closing #${match.reference} ` +
          "when the body is used to open the PR: name the issue without a closing keyword beside it",
      );
    }
  }

  c.notes.push(
    `${bodies.length} checked-in PR body file(s) checked for a closing keyword beside an issue reference; ` +
      `${pairs} such pair(s) found`,
  );
}

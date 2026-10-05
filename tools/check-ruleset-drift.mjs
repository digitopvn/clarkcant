#!/usr/bin/env node
/**
 * Compare the live `main` ruleset with `.github/required-checks.json`, or print the body that applies the file.
 *
 *   node tools/check-ruleset-drift.mjs                         exit 0 when they match, 1 on drift, 2 when unreadable
 *   node tools/check-ruleset-drift.mjs --print-ruleset-payload  print the PUT body for the ruleset and the command
 *
 * The check runs in `.github/workflows/merge-gate-drift.yml` on every push to `main`, daily, and on demand — not on
 * pull requests, because a PR that adds a job legitimately lands before the ruleset is updated to require it. The
 * payload mode never writes anything: applying it is one reviewed `gh api --method PUT` by a repository admin, so
 * CI never holds a token that can change the gate it is judged by.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createGitHubClient, resolveToken } from "./github-rest.mjs";
import { REQUIRED_CHECKS_PATH, diffRuleset, rulesetPayload, validateConfig } from "./required-checks.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Load and validate the committed gate. */
export function loadRequiredChecks(root = repoRoot) {
  return validateConfig(JSON.parse(readFileSync(join(root, REQUIRED_CHECKS_PATH), "utf8")));
}

/**
 * @param {string[]} argv
 * @param {{client?: ReturnType<typeof createGitHubClient>, config?: ReturnType<typeof validateConfig>,
 *   out?: (text: string) => void, err?: (text: string) => void}} [deps]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, deps = {}) {
  const out = deps.out ?? ((text) => process.stdout.write(text));
  const err = deps.err ?? ((text) => process.stderr.write(text));
  const unknown = argv.filter((arg) => arg !== "--print-ruleset-payload");
  if (unknown.length > 0) {
    err(`unknown argument(s): ${unknown.join(" ")}\nusage: node tools/check-ruleset-drift.mjs [--print-ruleset-payload]\n`);
    return 2;
  }

  let config;
  let ruleset;
  try {
    config = deps.config ?? loadRequiredChecks();
    const client = deps.client ?? createGitHubClient({ token: resolveToken() });
    ruleset = await client.request("GET", `/repos/${config.repository}/rulesets/${config.ruleset.id}`);
  } catch (error) {
    err(`cannot compare the merge gate: ${error.message}\n`);
    return 2;
  }

  if (argv.includes("--print-ruleset-payload")) {
    let payload;
    try {
      payload = rulesetPayload(config, ruleset);
    } catch (error) {
      err(`cannot build the ruleset payload: ${error.message}\n`);
      return 2;
    }
    out(`${JSON.stringify(payload, null, 2)}\n`);
    err(
      "Review the body above, then apply it as a repository admin:\n" +
        `  node tools/check-ruleset-drift.mjs --print-ruleset-payload > ruleset.json\n` +
        `  gh api --method PUT repos/${config.repository}/rulesets/${config.ruleset.id} --input ruleset.json\n`,
    );
    return 0;
  }

  const drift = diffRuleset(config, ruleset);
  const label = `ruleset ${config.ruleset.id} "${config.ruleset.name}" on ${config.repository}`;
  if (drift.length === 0) {
    out(`${label} enforces exactly ${REQUIRED_CHECKS_PATH}\n`);
    return 0;
  }
  err(
    `${label} has drifted from ${REQUIRED_CHECKS_PATH}:\n${drift.map((line) => `  ${line}\n`).join("")}` +
      "Apply the committed gate with: node tools/check-ruleset-drift.mjs --print-ruleset-payload (then the gh api PUT it prints),\n" +
      `or, if the live ruleset is right, change ${REQUIRED_CHECKS_PATH} in a PR.\n`,
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}

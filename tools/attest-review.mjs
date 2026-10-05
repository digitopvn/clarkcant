#!/usr/bin/env node
/**
 * Record a review of a PR's current head as an attestation comment.
 *
 *   node tools/attest-review.mjs <pr> --result ready|changes-required --reviewer agent:<name>|human:<login>
 *        [--commit <rev>] [--repo owner/name] [--dry-run]
 *
 * The head SHA is read from the PR itself, so nobody types one. Pass `--commit HEAD` (or any revision) when the
 * review was done on a local checkout: the attestation is refused if that commit is no longer the PR head, because
 * the head would then contain code the reviewer never saw. The comment is posted with the GitHub CLI as the signed-in
 * account, which must have write access for the merge gate to count it. `--dry-run` prints the comment instead.
 *
 * The comment records only the SHA, the result and the reviewer — never the review's reasoning.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { RESULTS, formatAttestation } from "./review-attestation.mjs";

const USAGE = "usage: node tools/attest-review.mjs <pr> --result ready|changes-required --reviewer agent:<name>|human:<login> [--commit <rev>] [--repo owner/name] [--dry-run]";

/**
 * @param {string[]} argv
 * @returns {{pr: string, result: string, reviewer: string, commit?: string, repo?: string, dryRun: boolean}}
 */
export function parseArguments(argv) {
  const options = { dryRun: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    const flag = { "--result": "result", "--reviewer": "reviewer", "--commit": "commit", "--repo": "repo" }[arg];
    if (flag) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value\n${USAGE}`);
      options[flag] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown option ${arg}\n${USAGE}`);
    positional.push(arg);
  }
  if (positional.length !== 1 || !/^[1-9]\d{0,9}$/u.test(positional[0])) throw new Error(`name exactly one PR number\n${USAGE}`);
  if (!RESULTS.includes(options.result)) throw new Error(`--result must be one of ${RESULTS.join(", ")}\n${USAGE}`);
  if (!options.reviewer) throw new Error(`--reviewer is required\n${USAGE}`);
  if (options.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/u.test(options.repo)) throw new Error("--repo must be owner/name");
  return { pr: positional[0], ...options };
}

/**
 * @param {string[]} argv
 * @param {{run?: (command: string, args: string[], input?: string) => string, out?: (text: string) => void}} [deps]
 */
export function main(argv, deps = {}) {
  const run = deps.run ?? ((command, args, input) => execFileSync(command, args, {
    encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"],
  }));
  const out = deps.out ?? ((text) => process.stdout.write(text));
  const options = parseArguments(argv);
  const repoArgs = options.repo ? ["--repo", options.repo] : [];

  const view = JSON.parse(run("gh", ["pr", "view", options.pr, ...repoArgs, "--json", "headRefOid,state"]));
  if (view.state !== "OPEN") throw new Error(`PR ${options.pr} is ${String(view.state).toLowerCase()}, not open`);
  const sha = String(view.headRefOid).toLowerCase();

  if (options.commit !== undefined) {
    const reviewed = run("git", ["rev-parse", "--verify", "--end-of-options", `${options.commit}^{commit}`]).trim().toLowerCase();
    if (reviewed !== sha) {
      throw new Error(`the reviewed commit ${reviewed.slice(0, 7)} is not PR ${options.pr}'s head ${sha.slice(0, 7)}; review the current head before attesting`);
    }
  }

  const body = formatAttestation({ sha, result: options.result, reviewer: options.reviewer });
  if (options.dryRun) {
    out(`${body}\n`);
    return;
  }
  run("gh", ["pr", "comment", options.pr, ...repoArgs, "--body-file", "-"], body);
  out(`Attested ${options.result} for PR ${options.pr} at ${sha}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

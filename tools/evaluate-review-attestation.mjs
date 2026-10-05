#!/usr/bin/env node
/**
 * Set the `review attestation` commit status on a PR's current head, from the attestations posted on the PR.
 *
 * Run by `.github/workflows/review-attestation.yml` from the default branch's own checkout: it reads the event
 * payload from GITHUB_EVENT_PATH and everything else from the GitHub API, never from PR-head files, and never puts
 * comment or PR text anywhere a shell would read it. The decision itself is tools/review-attestation.mjs.
 *
 * Which PRs it evaluates:
 * - `pull_request_target` and `issue_comment` on a PR: that PR;
 * - `workflow_dispatch`: the PR in ATTESTATION_PR, or every open PR when it is empty (for example right after the
 *   gate is first required, so open PRs get a status without waiting for their next push or comment).
 *
 * Environment: GITHUB_TOKEN (statuses: write, pull-requests: read, issues: read), GITHUB_REPOSITORY,
 * GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, optional ATTESTATION_PR, GITHUB_SERVER_URL and GITHUB_RUN_ID.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createGitHubClient, GitHubRequestError } from "./github-rest.mjs";
import { REVIEW_ATTESTATION_CONTEXT, canAttest, evaluateAttestations, parseAttestation } from "./review-attestation.mjs";

/** GitHub lists at most this many files for one PR; a larger PR is never treated as documentation-only. */
const PR_FILES_LIMIT = 3000;

/**
 * The PR numbers an event asks to evaluate. `null` means every open PR.
 *
 * @param {string} eventName
 * @param {any} payload the parsed event payload
 * @param {string | undefined} requested the workflow_dispatch input
 * @returns {number[] | null}
 */
export function pullRequestsForEvent(eventName, payload, requested) {
  if (eventName === "pull_request_target" || eventName === "pull_request") {
    return [Number(payload?.pull_request?.number)].filter(Number.isSafeInteger);
  }
  if (eventName === "issue_comment") {
    return payload?.issue?.pull_request ? [Number(payload.issue.number)].filter(Number.isSafeInteger) : [];
  }
  if (eventName === "workflow_dispatch") {
    const text = (requested ?? "").trim();
    if (text === "") return null;
    if (!/^[1-9]\d{0,9}$/u.test(text)) throw new Error(`ATTESTATION_PR must be a PR number, got "${text.slice(0, 20)}"`);
    return [Number(text)];
  }
  throw new Error(`unsupported event "${eventName}"`);
}

/**
 * Evaluate one PR and set its status. Returns what was decided, or null for a closed PR.
 *
 * @param {{client: ReturnType<typeof createGitHubClient>, repository: string, number: number, runUrl?: string}} input
 */
export async function evaluatePullRequest({ client, repository, number, runUrl }) {
  const pull = await client.request("GET", `/repos/${repository}/pulls/${number}`);
  if (pull.state !== "open") return null;
  const headSha = String(pull.head?.sha ?? "").toLowerCase();

  const files = await client.paginate(`/repos/${repository}/pulls/${number}/files`, { limit: PR_FILES_LIMIT });
  const complete = files.length === pull.changed_files && files.length < PR_FILES_LIMIT;
  // A rename lists its new path; its old path is the other half of the change and must be classified too.
  const changedFiles = complete ? files.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean)) : null;

  const rawComments = await client.paginate(`/repos/${repository}/issues/${number}/comments`, { limit: 10000 });
  const comments = rawComments.map((comment) => ({
    id: comment.id,
    author: comment.user?.login ?? "",
    createdAt: comment.created_at,
    body: comment.body ?? "",
    url: comment.html_url,
  }));

  // Permission is looked up only for accounts that posted a marker, once each.
  const permissions = new Map();
  for (const comment of comments) {
    if (comment.author === "" || permissions.has(comment.author) || parseAttestation(comment.body).kind === "none") continue;
    permissions.set(comment.author, await permissionOf(client, repository, comment.author));
  }

  const decision = evaluateAttestations({
    headSha,
    changedFiles,
    comments,
    isWriter: (login) => canAttest(permissions.get(login)),
  });
  await client.request("POST", `/repos/${repository}/statuses/${headSha}`, {
    state: decision.state,
    context: REVIEW_ATTESTATION_CONTEXT,
    description: decision.description,
    ...(decision.targetUrl ?? runUrl ? { target_url: decision.targetUrl ?? runUrl } : {}),
  });
  return { number, headSha, ...decision };
}

/** An account's permission on the repository; an account GitHub does not know as a collaborator has none. */
async function permissionOf(client, repository, login) {
  try {
    const result = await client.request("GET", `/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`);
    return result?.permission ?? "none";
  } catch (error) {
    if (error instanceof GitHubRequestError && error.status === 404) return "none";
    throw error;
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{client?: ReturnType<typeof createGitHubClient>, log?: (text: string) => void}} [deps]
 */
export async function main(env, deps = {}) {
  const log = deps.log ?? ((text) => process.stdout.write(text));
  const repository = env.GITHUB_REPOSITORY ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error("GITHUB_REPOSITORY must be owner/name");
  if (!deps.client && !env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required to set the commit status");
  const client = deps.client ?? createGitHubClient({ token: env.GITHUB_TOKEN });
  const payload = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`
    : undefined;

  let numbers = pullRequestsForEvent(env.GITHUB_EVENT_NAME ?? "", payload, env.ATTESTATION_PR);
  if (numbers === null) {
    const open = await client.paginate(`/repos/${repository}/pulls?state=open`);
    numbers = open.map((pull) => pull.number);
  }
  if (numbers.length === 0) {
    log("No pull request to evaluate.\n");
    return;
  }

  let failures = 0;
  for (const number of numbers) {
    try {
      const result = await evaluatePullRequest({ client, repository, number, runUrl });
      log(result === null
        ? `#${number}: not open, left as it is\n`
        : `#${number} ${result.headSha.slice(0, 7)}: ${result.state} — ${result.description}\n`);
    } catch (error) {
      failures += 1;
      log(`#${number}: could not be evaluated: ${error.message}\n`);
    }
  }
  if (failures > 0) throw new Error(`${failures} pull request(s) could not be evaluated`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main(process.env);
  } catch (error) {
    process.stderr.write(`review attestation: ${error.message}\n`);
    process.exitCode = 1;
  }
}

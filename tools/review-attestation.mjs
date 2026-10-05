/**
 * Final-head review attestation: what a reviewer posts, and how the merge gate decides from it.
 *
 * A reviewer — an agent or a person with write access — records a review as a PR comment carrying one
 * machine-readable marker: the full head SHA that was reviewed, the result, and who reviewed it (`agent:<name>` or
 * `human:<login>`). Nothing else is recorded; reasoning stays in the review itself. `tools/attest-review.mjs` writes
 * the comment from the PR's live head so nobody types a SHA.
 *
 * The gate (`.github/workflows/review-attestation.yml`, through `tools/evaluate-review-attestation.mjs`) sets the
 * `review attestation` commit status on the PR's current head from this module's decision:
 *
 * - a PR that changes only documentation and plans (the prose allowlist in `tools/ci-test-scope.mjs`) passes with
 *   no attestation;
 * - otherwise only markers in comments by accounts with write access count — anyone else's comment, edited or not,
 *   is ignored;
 * - the newest counted marker (by comment creation time) decides: `ready` for the exact current head passes,
 *   `changes-required` fails, and a marker for any other SHA leaves the gate pending, so a push always needs a
 *   fresh review of the new head.
 *
 * This module does no I/O, so the decision is unit-tested on its own.
 */
import { classifyPaths } from "./ci-test-scope.mjs";

export const REVIEW_ATTESTATION_CONTEXT = "review attestation";
export const MARKER_NAME = "clarkcant-review-attestation";
export const MARKER_VERSION = "v1";
export const RESULTS = Object.freeze(["ready", "changes-required"]);

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REVIEWER = /^(?:agent|human):[A-Za-z0-9][A-Za-z0-9._@/+-]{0,63}$/u;
const MARKER = new RegExp(`<!--\\s*${MARKER_NAME}\\s+(\\S+)\\s+([\\s\\S]*?)\\s*-->`, "gu");
const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);
const DESCRIPTION_LIMIT = 140;

/** Whether a repository permission name allows writing (and so attesting). */
export function canAttest(permission) {
  return WRITE_PERMISSIONS.has(permission);
}

const short = (sha) => sha.slice(0, 7);

/**
 * Validate an attestation's fields; throws on anything the gate would not accept.
 *
 * @param {{sha: string, result: string, reviewer: string}} attestation
 */
function validate({ sha, result, reviewer }) {
  if (typeof sha !== "string" || !SHA.test(sha)) throw new Error("sha must be a full lowercase commit SHA");
  if (!RESULTS.includes(result)) throw new Error(`result must be one of ${RESULTS.join(", ")}`);
  if (typeof reviewer !== "string" || !REVIEWER.test(reviewer)) {
    throw new Error("reviewer must be agent:<name> or human:<login> (letters, digits and ._@/+- only, at most 64)");
  }
}

/**
 * The comment body that records one review. Only the marker is machine-read; the sentence above it is for people.
 *
 * @param {{sha: string, result: string, reviewer: string}} attestation
 */
export function formatAttestation(attestation) {
  validate(attestation);
  const { sha, result, reviewer } = attestation;
  const marker = JSON.stringify({ sha, result, reviewer });
  const verdict = result === "ready" ? "ready to merge" : "changes required";
  return [
    `**Review attestation:** ${verdict} at \`${sha}\`, reviewed by \`${reviewer}\`.`,
    "",
    "A push to this PR makes this attestation stale; the new head needs its own review.",
    "",
    `<!-- ${MARKER_NAME} ${MARKER_VERSION} ${marker} -->`,
  ].join("\n");
}

/**
 * The attestation a comment body carries.
 *
 * @param {string} body
 * @returns {{kind: "none"} | {kind: "malformed", reason: string} | {kind: "valid", sha: string, result: string, reviewer: string}}
 */
export function parseAttestation(body) {
  const markers = [...String(body ?? "").matchAll(MARKER)];
  if (markers.length === 0) return { kind: "none" };
  if (markers.length > 1) return { kind: "malformed", reason: "more than one attestation marker in one comment" };
  const [, version, json] = markers[0];
  if (version !== MARKER_VERSION) return { kind: "malformed", reason: `unknown marker version "${version}"` };
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    return { kind: "malformed", reason: "marker payload is not JSON" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "malformed", reason: "marker payload is not an object" };
  }
  try {
    validate(value);
  } catch (error) {
    return { kind: "malformed", reason: error.message };
  }
  return { kind: "valid", sha: value.sha, result: value.result, reviewer: value.reviewer };
}

/** A status description GitHub accepts (at most 140 characters). */
function describe(text) {
  return text.length <= DESCRIPTION_LIMIT ? text : `${text.slice(0, DESCRIPTION_LIMIT - 1)}…`;
}

/**
 * Decide the `review attestation` status for a PR head.
 *
 * @param {object} input
 * @param {string} input.headSha the PR's current head commit
 * @param {string[] | null} input.changedFiles every path the PR changes, or null when the list is unavailable or
 *   incomplete (which never counts as documentation-only)
 * @param {{id: number, author: string, createdAt: string, body: string, url?: string}[]} input.comments
 * @param {(login: string) => boolean} input.isWriter whether the account has write access to the repository
 * @returns {{state: "success" | "failure" | "pending", description: string, targetUrl?: string}}
 */
export function evaluateAttestations({ headSha, changedFiles, comments, isWriter }) {
  if (typeof headSha !== "string" || !SHA.test(headSha)) throw new Error("headSha must be a full lowercase commit SHA");

  if (Array.isArray(changedFiles) && classifyPaths(changedFiles).full === false) {
    return {
      state: "success",
      description: describe("Documentation and plans only: no code review attestation is required for this change"),
    };
  }

  let ignored = 0;
  let malformed = 0;
  const valid = [];
  for (const comment of comments) {
    const parsed = parseAttestation(comment.body);
    if (parsed.kind === "none") continue;
    if (!isWriter(comment.author)) {
      ignored += 1;
      continue;
    }
    if (parsed.kind === "malformed") {
      malformed += 1;
      continue;
    }
    valid.push({ ...parsed, author: comment.author, createdAt: comment.createdAt, id: comment.id, url: comment.url });
  }

  const notes = [
    malformed > 0 ? `${malformed} malformed` : "",
    ignored > 0 ? `${ignored} from accounts without write access ignored` : "",
  ].filter(Boolean).join("; ");
  const suffix = notes ? ` (${notes})` : "";

  if (valid.length === 0) {
    return {
      state: "pending",
      description: describe(`No review attestation for ${short(headSha)}: run node tools/attest-review.mjs${suffix}`),
    };
  }

  valid.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
  const newest = valid.at(-1);
  const by = `${newest.reviewer} (@${newest.author})`;
  const target = newest.url ? { targetUrl: newest.url } : {};

  if (newest.sha !== headSha) {
    return {
      state: "pending",
      description: describe(`Newest attestation (${newest.result}) is for ${short(newest.sha)}, not head ${short(headSha)}: review the new head`),
      ...target,
    };
  }
  if (newest.result === "changes-required") {
    return { state: "failure", description: describe(`Changes required at ${short(headSha)} by ${by}`), ...target };
  }
  return { state: "success", description: describe(`Ready: ${short(headSha)} reviewed by ${by}`), ...target };
}

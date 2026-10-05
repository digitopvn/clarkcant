/**
 * The merge gate's single committed source of truth, `.github/required-checks.json`, and everything compared with it.
 *
 * The file names the ruleset that gates `main`, every check context it must require, whether a PR must be up to
 * date with `main` before it merges (`strict`), and every CI job that deliberately does not gate, each with its
 * reason. Two comparisons keep it honest:
 *
 * - offline, `compareWithWorkflow` checks it against the jobs `.github/workflows/ci.yml` actually reports, so a job
 *   added or renamed in a PR fails `pnpm invariants` in that same PR (tools/invariants/required-checks-match-workflow.mjs);
 * - live, `diffRuleset` checks it against the active ruleset, so a settings change, or a file change nobody applied,
 *   fails the scheduled drift check (tools/check-ruleset-drift.mjs). `rulesetPayload` turns the file into the exact
 *   body that applies it.
 *
 * Everything here is pure; reading files and calling GitHub belong to the callers.
 */

export const REQUIRED_CHECKS_PATH = ".github/required-checks.json";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.trim() !== "" && value === value.trim();

/**
 * Validate the parsed file. Throws one error listing every problem.
 *
 * @param {unknown} raw
 * @returns {{
 *   repository: string, ruleset: {id: number, name: string}, strict: boolean, integrationId: number,
 *   workflow: string, requiredJobs: string[], requiredStatuses: Record<string, string>,
 *   nonGatingJobs: Record<string, string>
 * }}
 */
export function validateConfig(raw) {
  const problems = [];
  if (!isObject(raw)) throw new Error(`${REQUIRED_CHECKS_PATH} must be a JSON object`);
  if (typeof raw.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/u.test(raw.repository)) problems.push("repository must be owner/name");
  if (!isObject(raw.ruleset) || !Number.isSafeInteger(raw.ruleset.id) || raw.ruleset.id <= 0 || !nonEmptyString(raw.ruleset.name)) {
    problems.push("ruleset must be { id: positive integer, name: string }");
  }
  if (typeof raw.strict !== "boolean") problems.push("strict must be true or false");
  if (!Number.isSafeInteger(raw.integrationId) || raw.integrationId <= 0) problems.push("integrationId must be a positive integer");
  if (!nonEmptyString(raw.workflow)) problems.push("workflow must name the CI workflow file");
  if (!Array.isArray(raw.requiredJobs) || raw.requiredJobs.length === 0 || !raw.requiredJobs.every(nonEmptyString)) {
    problems.push("requiredJobs must be a non-empty list of check names");
  }
  for (const key of ["requiredStatuses", "nonGatingJobs"]) {
    if (!isObject(raw[key]) || !Object.entries(raw[key]).every(([name, value]) => nonEmptyString(name) && nonEmptyString(value))) {
      problems.push(`${key} must map each check name to a non-empty explanation`);
    }
  }
  if (problems.length === 0) {
    const seen = new Set();
    for (const name of [...raw.requiredJobs, ...Object.keys(raw.requiredStatuses)]) {
      if (seen.has(name)) problems.push(`"${name}" is required twice`);
      seen.add(name);
    }
    for (const name of Object.keys(raw.nonGatingJobs)) {
      if (seen.has(name)) problems.push(`"${name}" is listed both as required and as intentionally non-gating`);
    }
  }
  if (problems.length > 0) throw new Error(`${REQUIRED_CHECKS_PATH}: ${problems.join("; ")}`);
  return raw;
}

/** Every context the ruleset must require, in file order: CI jobs first, then statuses written by other workflows. */
export function requiredContexts(config) {
  return [...config.requiredJobs, ...Object.keys(config.requiredStatuses)];
}

/**
 * Compare the file with the jobs the CI workflow reports.
 *
 * @param {ReturnType<typeof validateConfig>} config
 * @param {{id: string, contexts: string[], hasJobCondition: boolean}[]} jobs from tools/workflow-job-contexts.mjs
 * @param {{statusWriters?: Record<string, string>}} [options] context name to the workflow file that writes it
 * @returns {string[]} failures; empty when the file and the workflow agree
 */
export function compareWithWorkflow(config, jobs, { statusWriters = {} } = {}) {
  const failures = [];
  const byContext = new Map();
  for (const job of jobs) {
    for (const context of job.contexts) {
      if (byContext.has(context)) {
        failures.push(`jobs "${byContext.get(context).id}" and "${job.id}" both report "${context}", so requiring it cannot tell them apart`);
      }
      byContext.set(context, job);
    }
  }

  for (const context of config.requiredJobs) {
    const job = byContext.get(context);
    if (!job) {
      failures.push(`required check "${context}" is not reported by any job in ${config.workflow}: a renamed or removed job no longer gates merges — update ${REQUIRED_CHECKS_PATH} and the ruleset together`);
    } else if (job.hasJobCondition) {
      failures.push(`required job "${job.id}" has a job-level \`if:\`; GitHub counts a skipped job as passing, so it could satisfy "${context}" without running`);
    }
  }
  // A job whose dependency fails is skipped, and a skipped check passes: every dependency of a required job must
  // itself be required, so its failure blocks the merge on its own.
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  for (const job of jobs) {
    if (!job.contexts.some((context) => config.requiredJobs.includes(context))) continue;
    for (const dependency of job.needs ?? []) {
      const needed = jobsById.get(dependency);
      if (!needed || !needed.contexts.every((context) => config.requiredJobs.includes(context))) {
        failures.push(`required job "${job.id}" needs "${dependency}", which is not required: if it fails, "${job.id}" is skipped, and a skipped check counts as passing`);
      }
    }
  }
  for (const context of Object.keys(config.nonGatingJobs)) {
    if (!byContext.has(context)) failures.push(`"${context}" is listed as intentionally non-gating but no job in ${config.workflow} reports it`);
  }
  for (const [context, job] of byContext) {
    if (!config.requiredJobs.includes(context) && !Object.hasOwn(config.nonGatingJobs, context)) {
      failures.push(`job "${job.id}" reports "${context}", which ${REQUIRED_CHECKS_PATH} neither requires nor lists as intentionally non-gating: add it to requiredJobs (and the ruleset) or to nonGatingJobs with the reason`);
    }
  }
  for (const [context, writer] of Object.entries(config.requiredStatuses)) {
    if (statusWriters[context] === undefined) {
      failures.push(`required status "${context}" is not written by any known workflow`);
    } else if (statusWriters[context] !== writer) {
      failures.push(`required status "${context}" is written by ${statusWriters[context]}, but ${REQUIRED_CHECKS_PATH} names ${writer}`);
    }
  }
  return failures;
}

/** The single `required_status_checks` rule of a ruleset, or an error explaining why there is not exactly one. */
function statusRule(ruleset) {
  const rules = Array.isArray(ruleset?.rules) ? ruleset.rules.filter((rule) => rule?.type === "required_status_checks") : [];
  if (rules.length !== 1) return { error: `the ruleset has ${rules.length} required_status_checks rules, expected exactly 1` };
  return { rule: rules[0] };
}

/**
 * Every difference between the file and a ruleset as GitHub returns it (`GET /repos/{owner}/{repo}/rulesets/{id}`).
 *
 * @param {ReturnType<typeof validateConfig>} config
 * @param {any} ruleset
 * @returns {string[]} human-readable drift lines; empty when the live ruleset enforces exactly the file
 */
export function diffRuleset(config, ruleset) {
  const drift = [];
  if (ruleset?.id !== config.ruleset.id) drift.push(`ruleset id is ${ruleset?.id}, file names ${config.ruleset.id}`);
  if (ruleset?.name !== config.ruleset.name) drift.push(`ruleset name is "${ruleset?.name}", file names "${config.ruleset.name}"`);
  if (ruleset?.target !== "branch") drift.push(`ruleset target is "${ruleset?.target}", expected "branch"`);
  if (ruleset?.enforcement !== "active") drift.push(`ruleset enforcement is "${ruleset?.enforcement}", expected "active"`);
  const include = ruleset?.conditions?.ref_name?.include;
  if (!Array.isArray(include) || !include.some((ref) => ref === "~DEFAULT_BRANCH" || ref === "refs/heads/main")) {
    drift.push("ruleset does not target the default branch (conditions.ref_name.include lacks ~DEFAULT_BRANCH)");
  }

  const { rule, error } = statusRule(ruleset);
  if (error) return [...drift, error];
  const parameters = rule.parameters ?? {};
  if (parameters.strict_required_status_checks_policy !== config.strict) {
    drift.push(`strict_required_status_checks_policy: ruleset ${parameters.strict_required_status_checks_policy}, file ${config.strict}`);
  }

  const live = new Map();
  for (const check of parameters.required_status_checks ?? []) {
    if (live.has(check.context)) drift.push(`ruleset requires "${check.context}" more than once`);
    live.set(check.context, check.integration_id);
  }
  const expected = requiredContexts(config);
  for (const context of expected) {
    if (!live.has(context)) {
      drift.push(`+ "${context}" is required by the file but not by the ruleset`);
    } else if (live.get(context) !== config.integrationId) {
      drift.push(`~ "${context}" must come from integration ${config.integrationId}, ruleset accepts ${live.get(context) ?? "any source"}`);
    }
  }
  for (const context of live.keys()) {
    if (!expected.includes(context)) drift.push(`- "${context}" is required by the ruleset but not by the file`);
  }
  return drift;
}

/**
 * The exact body for `PUT /repos/{owner}/{repo}/rulesets/{id}` that makes the ruleset enforce the file.
 *
 * Built from the live ruleset so every other rule, condition and bypass actor is carried over unchanged; only the
 * required-status-checks rule is replaced. The live ruleset must include `bypass_actors`, which GitHub returns only
 * to a caller with write access to it: a body without them would not round-trip the ruleset faithfully.
 *
 * @param {ReturnType<typeof validateConfig>} config
 * @param {any} ruleset
 */
export function rulesetPayload(config, ruleset) {
  if (ruleset?.id !== config.ruleset.id) throw new Error(`fetched ruleset ${ruleset?.id}, file names ${config.ruleset.id}`);
  if (!Array.isArray(ruleset.bypass_actors)) {
    throw new Error("the ruleset was read without bypass_actors (GitHub returns them only to a caller who can edit the ruleset); authenticate as a repository admin");
  }
  const { rule, error } = statusRule(ruleset);
  if (error) throw new Error(error);
  const required = {
    type: "required_status_checks",
    parameters: {
      ...rule.parameters,
      strict_required_status_checks_policy: config.strict,
      required_status_checks: requiredContexts(config).map((context) => ({ context, integration_id: config.integrationId })),
    },
  };
  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    conditions: ruleset.conditions,
    bypass_actors: ruleset.bypass_actors.map(({ actor_id, actor_type, bypass_mode }) => ({ actor_id, actor_type, bypass_mode })),
    rules: ruleset.rules.map((entry) => (entry.type === "required_status_checks" ? required : entry)),
  };
}

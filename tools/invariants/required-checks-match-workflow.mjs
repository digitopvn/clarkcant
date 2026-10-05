/**
 * The committed merge gate names exactly the jobs CI runs.
 *
 * `.github/required-checks.json` is the one source of truth for what must pass before a PR merges into `main`. A CI
 * job that is added, renamed or turned into a matrix changes the check names GitHub reports; if the gate is not
 * changed with it, the new job gates nothing, or a required name waits for a check that will never report. This
 * check expands every job name in `.github/workflows/ci.yml` (matrix and `include` included) offline and fails, in
 * the same PR, when:
 *
 * - a required check is reported by no job;
 * - a job is neither required nor listed as intentionally non-gating with a reason;
 * - a required job can be skipped, by a job-level `if:` or by a failing dependency that is not itself required
 *   (GitHub counts a skipped check as passing);
 * - a required status written outside CI is not written by the workflow the file names.
 *
 * Whether the live ruleset matches the file needs the network, so that lives in tools/check-ruleset-drift.mjs.
 */
import { join } from "node:path";

import { existsSync, readFileSync } from "./context.mjs";
import { REQUIRED_CHECKS_PATH, compareWithWorkflow, requiredContexts, validateConfig } from "../required-checks.mjs";
import { REVIEW_ATTESTATION_CONTEXT } from "../review-attestation.mjs";
import { workflowJobsFromYaml } from "../workflow-job-contexts.mjs";

/** The workflow that writes the review attestation status, and the script it must run to do so. */
export const REVIEW_ATTESTATION_WORKFLOW = ".github/workflows/review-attestation.yml";
const REVIEW_ATTESTATION_SCRIPT = "tools/evaluate-review-attestation.mjs";

export default function run(ctx) {
  const { repoRoot, check } = ctx;
  const c = check("required-checks-match-workflow");

  let config;
  try {
    config = validateConfig(JSON.parse(readFileSync(join(repoRoot, REQUIRED_CHECKS_PATH), "utf8")));
  } catch (error) {
    c.failures.push(`${REQUIRED_CHECKS_PATH} cannot be read: ${error.message}`);
    return;
  }

  let jobs;
  try {
    jobs = workflowJobsFromYaml(readFileSync(join(repoRoot, config.workflow), "utf8"));
  } catch (error) {
    c.failures.push(`${config.workflow} cannot be expanded into check names: ${error.message}`);
    return;
  }

  const statusWriters = {};
  const writerPath = join(repoRoot, REVIEW_ATTESTATION_WORKFLOW);
  if (existsSync(writerPath) && readFileSync(writerPath, "utf8").includes(REVIEW_ATTESTATION_SCRIPT)
    && existsSync(join(repoRoot, REVIEW_ATTESTATION_SCRIPT))) {
    statusWriters[REVIEW_ATTESTATION_CONTEXT] = REVIEW_ATTESTATION_WORKFLOW;
  }

  c.failures.push(...compareWithWorkflow(config, jobs, { statusWriters }));
  const reported = jobs.reduce((total, job) => total + job.contexts.length, 0);
  c.notes.push(
    `${jobs.length} job(s) in ${config.workflow} report ${reported} check(s); ${REQUIRED_CHECKS_PATH} requires ` +
      `${requiredContexts(config).length} context(s), strict=${config.strict}, ${Object.keys(config.nonGatingJobs).length} intentionally non-gating`,
  );
}

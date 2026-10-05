/**
 * The check contexts a workflow's jobs report, computed offline the way GitHub computes them.
 *
 * A required status check names a job by the context GitHub gives its check run: the job's `name`, with every
 * `${{ matrix.<key> }}` filled in for each matrix combination, or the job id when it has no name. A matrix job with no
 * name is reported as `<id> (<value>, <value>, ...)`. Combinations follow GitHub's documented rules: the cartesian
 * product of the matrix's own keys, minus every `exclude` entry, then each `include` entry is merged into every
 * combination whose original values it does not overwrite, or added as a new combination when it fits none.
 *
 * A name or matrix this cannot expand exactly (an expression other than `matrix.<key>`, a matrix built by
 * `fromJSON`, an object-valued matrix entry in a name) throws, so a gate built on it cannot silently miss a job.
 */
import { parseYamlSubset } from "./yaml-subset-parser.mjs";

const MATRIX_REFERENCE = /\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}/gu;
const ANY_EXPRESSION = /\$\{\{/u;

/** GitHub shows a matrix value the way it was typed after YAML parsing: numbers and booleans as JavaScript prints them. */
function display(value, where) {
  if (value === null || typeof value === "object") {
    throw new Error(`${where}: a matrix value that is not a string, number or boolean cannot be shown in a job name`);
  }
  return String(value);
}

/** @param {Record<string, unknown>} entry */
function isPlainObject(entry) {
  return entry !== null && typeof entry === "object" && !Array.isArray(entry);
}

/**
 * Every combination a `strategy.matrix` produces, in GitHub's order.
 *
 * @param {unknown} matrix
 * @param {string} jobId
 * @returns {Record<string, unknown>[]}
 */
export function expandMatrix(matrix, jobId) {
  if (matrix === undefined || matrix === null) return [{}];
  if (!isPlainObject(matrix)) {
    throw new Error(`job "${jobId}": strategy.matrix is not a literal mapping (an expression such as fromJSON cannot be expanded offline)`);
  }
  const { include = [], exclude = [], ...axes } = matrix;
  for (const [key, list] of Object.entries({ include, exclude })) {
    if (!Array.isArray(list) || !list.every(isPlainObject)) {
      throw new Error(`job "${jobId}": strategy.matrix.${key} must be a list of mappings`);
    }
  }
  const keys = Object.keys(axes);
  for (const key of keys) {
    if (!Array.isArray(axes[key]) || axes[key].length === 0) {
      throw new Error(`job "${jobId}": strategy.matrix.${key} must be a non-empty literal list`);
    }
  }

  let combinations = keys.length === 0 ? [] : [{}];
  for (const key of keys) {
    combinations = combinations.flatMap((combination) => axes[key].map((value) => ({ ...combination, [key]: value })));
  }
  combinations = combinations.filter((combination) => !exclude.some((entry) =>
    Object.entries(entry).every(([key, value]) => combination[key] === value)));

  const originals = combinations.map((combination) => ({ ...combination }));
  const extra = [];
  for (const entry of include) {
    let matched = false;
    combinations.forEach((combination, index) => {
      const overwritesOriginal = Object.entries(entry).some(([key, value]) =>
        Object.hasOwn(originals[index], key) && originals[index][key] !== value);
      if (overwritesOriginal) return;
      Object.assign(combination, entry);
      matched = true;
    });
    if (!matched) extra.push({ ...entry });
  }
  return [...combinations, ...extra];
}

/**
 * The context one job reports for one matrix combination.
 *
 * @param {string} jobId
 * @param {unknown} name the job's `name`, or undefined
 * @param {Record<string, unknown>} combination
 * @param {boolean} hasMatrix
 */
function contextFor(jobId, name, combination, hasMatrix) {
  if (name === undefined || name === null) {
    if (!hasMatrix || Object.keys(combination).length === 0) return jobId;
    const values = Object.values(combination).map((value) => display(value, `job "${jobId}"`));
    return `${jobId} (${values.join(", ")})`;
  }
  if (typeof name !== "string") return String(name);
  const filled = name.replace(MATRIX_REFERENCE, (_whole, key) => {
    if (!Object.hasOwn(combination, key)) {
      throw new Error(`job "${jobId}": its name uses matrix.${key}, which a combination does not define`);
    }
    return display(combination[key], `job "${jobId}"`);
  });
  if (ANY_EXPRESSION.test(filled)) {
    throw new Error(`job "${jobId}": its name "${name}" uses an expression other than matrix.<key>, which cannot be expanded offline`);
  }
  return filled;
}

/**
 * Every job of a parsed workflow with the contexts it reports.
 *
 * @param {unknown} workflow a parsed workflow document
 * @returns {{id: string, contexts: string[], hasJobCondition: boolean, needs: string[]}[]}
 */
export function workflowJobs(workflow) {
  if (!isPlainObject(workflow) || !isPlainObject(workflow.jobs)) {
    throw new Error("the workflow has no `jobs` mapping");
  }
  return Object.entries(workflow.jobs).map(([id, job]) => {
    if (!isPlainObject(job)) throw new Error(`job "${id}" is not a mapping`);
    if (job.uses !== undefined) {
      throw new Error(`job "${id}" calls a reusable workflow, whose check names cannot be expanded offline`);
    }
    const matrix = isPlainObject(job.strategy) ? job.strategy.matrix : undefined;
    const hasMatrix = matrix !== undefined && matrix !== null;
    const contexts = expandMatrix(matrix, id).map((combination) => contextFor(id, job.name, combination, hasMatrix));
    const needs = job.needs === undefined || job.needs === null ? [] : [job.needs].flat().map(String);
    return { id, contexts, hasJobCondition: job.if !== undefined, needs };
  });
}

/**
 * Parse workflow YAML text and return its jobs with their contexts.
 *
 * @param {string} text
 */
export function workflowJobsFromYaml(text) {
  return workflowJobs(parseYamlSubset(text));
}

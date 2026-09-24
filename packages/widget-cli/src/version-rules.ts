import type { WidgetDefinition } from "@clarkcant/contracts";

/**
 * What a published definition promised, and the checks a new version is held to against it.
 *
 * Instances, stored state and action bindings outlive the version that created them: a node keeps a widget's state
 * across an update, and an update that quietly changes what that state means, what the widget may do or which keys it
 * persists breaks people's data on machines the publisher never sees. So `clark widget publish` compares the
 * definitions it is about to describe with the ones it described last time, and refuses the changes that need a new
 * major version or a state migration before they reach a directory.
 *
 * - A changed `stateSchema` needs a higher `stateVersion` and migration steps from the previously published one;
 *   migrations are what carry stored state forward, and without them the node can only open old state read-only.
 * - Steps already published are history: a node may have migrated with them, so changing one splits the same
 *   stateVersion into two meanings. New steps may be added.
 * - `stateVersion` never goes down; there is no migration down.
 * - Changing which keys are view-only (`ephemeralStateKeys`), what the widget can effect (`effectCategories`) or
 *   asking for a new capability changes what persisted state and bindings mean, so it needs a new major version of
 *   the definition. Dropping a requested capability does not.
 * - A definition disappearing from the package needs a new major version of the package: existing instances name it.
 */

export interface PublishedDefinition {
  version: string;
  stateVersion: number;
  stateSchema: unknown;
  ephemeralStateKeys: readonly string[];
  stateMigrations: readonly unknown[];
  effectCategories: readonly string[];
  requestedCapabilities: readonly string[];
}

export interface PublishedDefinitions {
  packageVersion: string;
  definitions: Record<string, PublishedDefinition>;
}

/** The part of each definition a later version is compared against, keyed by definition id. */
export function publishedDefinitions(packageVersion: string, definitions: readonly WidgetDefinition[]): PublishedDefinitions {
  const out: Record<string, PublishedDefinition> = {};
  for (const definition of definitions) {
    out[definition.id] = {
      version: definition.version,
      stateVersion: definition.stateVersion ?? 0,
      stateSchema: definition.stateSchema ?? null,
      ephemeralStateKeys: [...(definition.ephemeralStateKeys ?? [])].sort(),
      stateMigrations: definition.stateMigrations ?? [],
      effectCategories: [...definition.effectCategories].sort(),
      requestedCapabilities: [...definition.requestedCapabilities].sort(),
    };
  }
  return { packageVersion, definitions: out };
}

/** The major number of a semantic version, or undefined when it does not start with one. */
function major(version: string): number | undefined {
  const match = /^v?(\d+)\./.exec(version);
  return match === null ? undefined : Number(match[1]);
}

/** Key order is not meaning: two schemas that differ only in the order their keys were written are the same schema. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

/** Each rule a new version breaks, in words a publisher can act on. Empty means it may be published. */
export function versionRuleViolations(previous: PublishedDefinitions, next: PublishedDefinitions): string[] {
  const problems: string[] = [];
  const packageMajorBumped = (major(next.packageVersion) ?? 0) > (major(previous.packageVersion) ?? 0);

  for (const [id, before] of Object.entries(previous.definitions)) {
    const after = next.definitions[id];
    if (after === undefined) {
      if (!packageMajorBumped) {
        problems.push(
          `${id} was published in ${previous.packageVersion} and is gone from ${next.packageVersion}; existing instances name it, so removing it needs a new major package version`,
        );
      }
      continue;
    }

    if (after.stateVersion < before.stateVersion) {
      problems.push(`${id}: stateVersion went from ${String(before.stateVersion)} down to ${String(after.stateVersion)}; there is no migration down`);
    }
    if (!same(before.stateSchema, after.stateSchema) && after.stateVersion <= before.stateVersion) {
      problems.push(`${id}: stateSchema changed but stateVersion is still ${String(after.stateVersion)}; raise it and add a migration step`);
    }
    // Checked from the published version whenever it rises, schema change or not: conformance only sees the chain
    // from its lowest step, and state stored at a version below that step would open read-only for everyone.
    if (after.stateVersion > before.stateVersion) {
      const froms = new Set(after.stateMigrations.map((step) => (step as { from?: unknown }).from));
      for (let version = before.stateVersion; version < after.stateVersion; version += 1) {
        if (!froms.has(version)) {
          problems.push(`${id}: no migration step from stateVersion ${String(version)}, so state stored by ${before.version} could not be carried forward`);
        }
      }
    }
    for (const step of before.stateMigrations) {
      if (!after.stateMigrations.some((candidate) => same(candidate, step))) {
        const from = (step as { from?: unknown }).from;
        problems.push(`${id}: the published migration step from stateVersion ${String(from)} was changed or removed; published steps may only be added to`);
      }
    }

    const breaking: string[] = [];
    if (!same(before.ephemeralStateKeys, after.ephemeralStateKeys)) breaking.push("ephemeralStateKeys");
    if (!same(before.effectCategories, after.effectCategories)) breaking.push("effectCategories");
    const added = after.requestedCapabilities.filter((ref) => !before.requestedCapabilities.includes(ref));
    if (added.length > 0) breaking.push(`requestedCapabilities (+${added.join(", +")})`);
    if (breaking.length > 0 && !((major(after.version) ?? 0) > (major(before.version) ?? 0))) {
      problems.push(
        `${id}: ${breaking.join(", ")} changed between ${before.version} and ${after.version}; that changes what stored state and bindings mean, so it needs a new major version of the definition (or a new definition id)`,
      );
    }
  }
  return problems;
}

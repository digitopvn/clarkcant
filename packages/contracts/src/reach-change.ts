import { z } from "zod";

import { browserTokenProviderSchema, browserTokenScopeSchema } from "./browser-token.ts";
import { canonicalReach, declaredReachOf, type DeclaredReach, type ReachFacet } from "./declared-reach.ts";
import type { DirectoryEntry } from "./directory.ts";
import { networkOriginSchema } from "./network-origin.ts";
import {
  DEFAULT_RESOURCE_PROFILE,
  RESOURCE_PROFILES,
  resourceProfileNameSchema,
  type ResourceProfile,
  type ResourceProfileName,
  type ResourceRequest,
} from "./resource-profiles.ts";
import { egressSecretNameSchema } from "./service-egress.ts";
import { connectionScopeSchema } from "./service-connection.ts";

/**
 * What changes in what a package reaches when the installed version is replaced by another one.
 *
 * Shown on an update notice and on the install question an update raises, so the person sees what the new version can
 * reach that the installed one could not, before it is applied. It decides nothing: an update is decided by the
 * execution policy exactly as any install is, and this only says what that decision is about.
 *
 * Profiles are not ranked. `media-workstation` has more memory and CPUs than `background-compute`, which runs jobs for
 * longer, so neither is "bigger". Each bounded limit the two profiles resolve to is compared on its own, and the
 * offscreen behaviour too (`authorized-playback` lets a frame keep running out of view, `suspend` does not). Origins,
 * secrets, browser-token scopes and account connections are compared as sets: what was added and what was removed.
 *
 * A key is also compared by where it goes: each (key, origin) pair the host adds that key to requests for. Moving a key
 * to another origin, or sending it to one more, is an added pair, so it is wider even when the origins and the keys
 * are the same sets. A GPU request is compared too: this node never grants one, so asking for it stops the package.
 *
 * `wider` when anything was added or any limit went up, even when something else went down (a mixed change is wider,
 * and both halves are listed). `narrower` when something was removed or went down and nothing widened. `unchanged`
 * otherwise, including a different purpose sentence for the same origin, which changes what is said and not what is
 * reached.
 *
 * Each list carries at most `REACH_CHANGE_LIST_MAX` items and counts the rest in `addedMore` / `removedMore`, so a
 * large change always fits the schema it is read with. The verdict is worked out from every item, not only the listed
 * ones.
 */

/** The most items one added or removed list carries; the rest are counted, not listed. */
export const REACH_CHANGE_LIST_MAX = 32;

/** The bounded limits a resource profile resolves to, each compared on its own. Larger is always more reach. */
export const PROFILE_LIMIT_NAMES = [
  "memoryMib",
  "cpus",
  "pids",
  "tmpfsMib",
  "callDeadlineMs",
  "jobDeadlineMs",
  "maxActiveJobs",
  "artifactMaxBytes",
  "inputMaxBytes",
  "inputMaxMediaSeconds",
] as const;
export const profileLimitNameSchema = z.enum(PROFILE_LIMIT_NAMES);
export type ProfileLimitName = z.infer<typeof profileLimitNameSchema>;

function limitsOf(profile: ResourceProfile): Record<ProfileLimitName, number> {
  return {
    memoryMib: profile.container.memoryMib,
    cpus: profile.container.cpus,
    pids: profile.container.pids,
    tmpfsMib: profile.container.tmpfsMib,
    callDeadlineMs: profile.callDeadlineMs,
    jobDeadlineMs: profile.jobDeadlineMs,
    maxActiveJobs: profile.maxActiveJobs,
    artifactMaxBytes: profile.artifactMaxBytes,
    inputMaxBytes: profile.input.maxBytes,
    inputMaxMediaSeconds: profile.input.maxMediaSeconds,
  };
}

const OFFSCREEN_ORDER: readonly ResourceProfile["offscreen"][] = ["suspend", "authorized-playback"];

/** Added and removed items of one set, each list capped, with how many more there are beyond the cap. */
function setChangeSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({
    added: z.array(item).max(REACH_CHANGE_LIST_MAX),
    removed: z.array(item).max(REACH_CHANGE_LIST_MAX),
    /** Items added beyond the ones listed. Absent when every one is listed. */
    addedMore: z.int().positive().optional(),
    /** Items removed beyond the ones listed. Absent when every one is listed. */
    removedMore: z.int().positive().optional(),
  });
}

const purposeSchema = z.string().min(1).max(300);

export const reachChangeSchema = z.strictObject({
  verdict: z.enum(["wider", "narrower", "unchanged"]),
  /** Present when the profile differs: the two names, and every limit and the offscreen behaviour that changed. */
  profile: z
    .strictObject({
      from: resourceProfileNameSchema,
      to: resourceProfileNameSchema,
      limits: z
        .array(z.strictObject({ limit: profileLimitNameSchema, from: z.number().nonnegative(), to: z.number().nonnegative() }))
        .max(PROFILE_LIMIT_NAMES.length),
      offscreen: z
        .strictObject({ from: z.enum(["suspend", "authorized-playback"]), to: z.enum(["suspend", "authorized-playback"]) })
        .optional(),
    })
    .optional(),
  /** By origin; the purpose is the one the version that has it states. */
  origins: setChangeSchema(z.strictObject({ origin: networkOriginSchema, purpose: purposeSchema })),
  /** Present when the GPU request differs. This node never grants a GPU, so `to: true` means it will not run here. */
  gpu: z.strictObject({ from: z.boolean(), to: z.boolean() }).optional(),
  /** By name, never a value. */
  secrets: setChangeSchema(z.strictObject({ name: egressSecretNameSchema, purpose: purposeSchema })),
  /**
   * Where each key goes: one key and one origin the host adds it to requests for, per item. `also` marks an added
   * pair whose key the installed version already sent, and still sends, to another origin.
   */
  keyDestinations: setChangeSchema(
    z.strictObject({ name: egressSecretNameSchema, origin: networkOriginSchema, also: z.literal(true).optional() }),
  ),
  /** One provider and one scope per item, so a scope added to a provider already declared is its own item. */
  browserTokens: setChangeSchema(z.strictObject({ provider: browserTokenProviderSchema, scope: browserTokenScopeSchema })),
  /** One provider and one scope per item. */
  connectionScopes: setChangeSchema(z.strictObject({ provider: z.string().min(1).max(64), scope: connectionScopeSchema })),
  /** One provider and one endpoint its credential goes to per item. */
  connectionEndpoints: setChangeSchema(z.strictObject({ provider: z.string().min(1).max(64), endpoint: networkOriginSchema })),
});
export type ReachChange = z.infer<typeof reachChangeSchema>;

/**
 * What is shown for an update of an installed package: the change, or `unknown` when the two versions could not be
 * compared (the installed manifest or the new version's listing could not be read). Said, so silence is never read as
 * "no change".
 */
export const reachChangeViewSchema = z.union([reachChangeSchema, z.strictObject({ verdict: z.literal("unknown") })]);
export type ReachChangeView = z.infer<typeof reachChangeViewSchema>;

/** What one version of a package reaches: its declared reach, the profile it requests and whether it asks for a GPU. */
export interface ReachSnapshot {
  reach: DeclaredReach;
  profile: ResourceProfileName;
  gpu?: boolean | undefined;
}

/** What a manifest reaches: the declaration the host enforces, and the profile it requests (absent: the default). */
export function reachSnapshotOfManifest(manifest: {
  facets: readonly ReachFacet[];
  resources?: ResourceRequest | undefined;
}): ReachSnapshot {
  return {
    reach: declaredReachOf(manifest),
    profile: manifest.resources?.profile ?? DEFAULT_RESOURCE_PROFILE,
    gpu: manifest.resources?.gpu === true,
  };
}

/**
 * What a listing says a version reaches. Both fields are binding (the install refuses an artifact that declares
 * anything else), and an absent one means none: no reach, and the default profile.
 */
export function reachSnapshotOfListing(entry: Pick<DirectoryEntry, "declaredReach" | "resources">): ReachSnapshot {
  return {
    reach: canonicalReach(entry.declaredReach ?? { origins: [], secrets: [], browserTokens: [] }),
    profile: entry.resources?.profile ?? DEFAULT_RESOURCE_PROFILE,
    gpu: entry.resources?.gpu === true,
  };
}

/** Items in `next` and not in `before`, and the other way round, by key; the first item for a key wins. */
function diff<T>(before: readonly T[], next: readonly T[], key: (item: T) => string): { added: T[]; removed: T[] } {
  const index = (items: readonly T[]): Map<string, T> => {
    const map = new Map<string, T>();
    for (const item of items) if (!map.has(key(item))) map.set(key(item), item);
    return map;
  };
  const a = index(before);
  const b = index(next);
  const sorted = (map: Map<string, T>, other: Map<string, T>): T[] =>
    [...map.entries()]
      .filter(([k]) => !other.has(k))
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([, item]) => item);
  return { added: sorted(b, a), removed: sorted(a, b) };
}

function tokenPairs(reach: DeclaredReach): { provider: string; scope: string }[] {
  return reach.browserTokens.flatMap((entry) => entry.scopes.map((scope) => ({ provider: entry.provider, scope })));
}

function connectionScopePairs(reach: DeclaredReach): { provider: string; scope: string }[] {
  return (reach.connections ?? []).flatMap((entry) => entry.scopes.map((scope) => ({ provider: entry.provider, scope: scope.scope })));
}

function keyDestinationPairs(reach: DeclaredReach): { name: string; origin: string }[] {
  return reach.origins.flatMap((entry) => (entry.secret === undefined ? [] : [{ name: entry.secret, origin: entry.origin }]));
}

/** At most `REACH_CHANGE_LIST_MAX` items per list, and how many were left out. */
function capped<T>(set: { added: T[]; removed: T[] }): { added: T[]; removed: T[]; addedMore?: number; removedMore?: number } {
  const over = (items: T[]): number => Math.max(0, items.length - REACH_CHANGE_LIST_MAX);
  return {
    added: set.added.slice(0, REACH_CHANGE_LIST_MAX),
    removed: set.removed.slice(0, REACH_CHANGE_LIST_MAX),
    ...(over(set.added) === 0 ? {} : { addedMore: over(set.added) }),
    ...(over(set.removed) === 0 ? {} : { removedMore: over(set.removed) }),
  };
}

function connectionEndpointPairs(reach: DeclaredReach): { provider: string; endpoint: string }[] {
  return (reach.connections ?? []).flatMap((entry) => entry.endpoints.map((endpoint) => ({ provider: entry.provider, endpoint })));
}

/** The pure comparison: what `next` reaches against what `installed` reaches. */
export function compareReach(installed: ReachSnapshot, next: ReachSnapshot): ReachChange {
  const before = canonicalReach(installed.reach);
  const after = canonicalReach(next.reach);
  const pair = (item: { provider: string; scope: string }): string => JSON.stringify([item.provider, item.scope]);

  const origins = diff(
    before.origins.map(({ origin, purpose }) => ({ origin, purpose })),
    after.origins.map(({ origin, purpose }) => ({ origin, purpose })),
    (item) => item.origin,
  );
  const secrets = diff(before.secrets, after.secrets, (item) => item.name);
  const destination = (item: { name: string; origin: string }): string => JSON.stringify([item.name, item.origin]);
  const beforeDestinations = keyDestinationPairs(before);
  const afterDestinations = keyDestinationPairs(after);
  // Keys the new version still sends where the installed one did: a pair added for one of them sends it "also" there.
  const afterKeys = new Set(afterDestinations.map(destination));
  const kept = new Set(beforeDestinations.filter((item) => afterKeys.has(destination(item))).map((item) => item.name));
  const destinations = diff(beforeDestinations, afterDestinations, destination);
  const keyDestinations = {
    added: destinations.added.map((item) => ({ name: item.name, origin: item.origin, ...(kept.has(item.name) ? { also: true as const } : {}) })),
    removed: destinations.removed.map((item) => ({ name: item.name, origin: item.origin })),
  };
  const browserTokens = diff(tokenPairs(before), tokenPairs(after), pair);
  const connectionScopes = diff(connectionScopePairs(before), connectionScopePairs(after), pair);
  const connectionEndpoints = diff(connectionEndpointPairs(before), connectionEndpointPairs(after), (item) =>
    JSON.stringify([item.provider, item.endpoint]),
  );

  let up = false;
  let down = false;
  let profile: ReachChange["profile"];
  if (installed.profile !== next.profile) {
    const from = RESOURCE_PROFILES[installed.profile];
    const to = RESOURCE_PROFILES[next.profile];
    const fromLimits = limitsOf(from);
    const toLimits = limitsOf(to);
    const limits = PROFILE_LIMIT_NAMES.filter((name) => fromLimits[name] !== toLimits[name]).map((name) => ({
      limit: name,
      from: fromLimits[name],
      to: toLimits[name],
    }));
    for (const limit of limits) {
      if (limit.to > limit.from) up = true;
      else down = true;
    }
    const offscreenFrom = OFFSCREEN_ORDER.indexOf(from.offscreen);
    const offscreenTo = OFFSCREEN_ORDER.indexOf(to.offscreen);
    if (offscreenTo > offscreenFrom) up = true;
    if (offscreenTo < offscreenFrom) down = true;
    profile = {
      from: installed.profile,
      to: next.profile,
      limits,
      ...(from.offscreen === to.offscreen ? {} : { offscreen: { from: from.offscreen, to: to.offscreen } }),
    };
  }

  const gpuFrom = installed.gpu === true;
  const gpuTo = next.gpu === true;
  if (gpuTo && !gpuFrom) up = true;
  if (gpuFrom && !gpuTo) down = true;

  const sets = [origins, secrets, keyDestinations, browserTokens, connectionScopes, connectionEndpoints];
  if (sets.some((set) => set.added.length > 0)) up = true;
  if (sets.some((set) => set.removed.length > 0)) down = true;

  return {
    verdict: up ? "wider" : down ? "narrower" : "unchanged",
    ...(profile === undefined ? {} : { profile }),
    ...(gpuFrom === gpuTo ? {} : { gpu: { from: gpuFrom, to: gpuTo } }),
    origins: capped(origins),
    secrets: capped(secrets),
    keyDestinations: capped(keyDestinations),
    browserTokens: capped(browserTokens),
    connectionScopes: capped(connectionScopes),
    connectionEndpoints: capped(connectionEndpoints),
  };
}

/**
 * Why a listing's resource request is not the one the package makes, or `undefined` when they agree. A listing
 * without the field says the package asks for the default profile and no GPU.
 */
export function declaredResourcesMismatch(
  listed: ResourceRequest | undefined,
  declared: ResourceRequest | undefined,
): string | undefined {
  const shown = { profile: listed?.profile ?? DEFAULT_RESOURCE_PROFILE, gpu: listed?.gpu === true };
  const actual = { profile: declared?.profile ?? DEFAULT_RESOURCE_PROFILE, gpu: declared?.gpu === true };
  if (shown.profile === actual.profile && shown.gpu === actual.gpu) return undefined;
  return `the listing shows the resource profile ${shown.profile}${shown.gpu ? " with a GPU" : ""}, and the package requests ${actual.profile}${actual.gpu ? " with a GPU" : ""}`;
}

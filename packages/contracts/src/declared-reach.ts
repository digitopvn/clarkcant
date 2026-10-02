import { z } from "zod";

import { browserTokenProviderSchema, browserTokenScopeSchema, type BrowserTokens } from "./browser-token.ts";
import { networkOriginSchema } from "./network-origin.ts";
import { egressSecretNameSchema, type ServiceEgress } from "./service-egress.ts";
import { connectionScopeSchema, type ServiceConnectionRequirement } from "./service-connection.ts";

/**
 * What a package reaches beyond its sandbox, as the person is shown it before installing: the provider origins its
 * services reach through the host, the secrets those requests need (by name and purpose, never a value), and the
 * providers its frames may be given a browser token from, with the scopes, and the accounts its services work on: the
 * provider, the scopes asked for and the endpoints the connection's credential goes to.
 *
 * Derived from the manifest's own `egress`, `browserTokens` and `connection` declarations, which are what the host enforces. A
 * directory entry repeats it so a listing and an install question can show it before any byte is fetched, and the
 * install refuses an artifact whose manifest declares anything else, so what the person was shown is what they agreed
 * to.
 */

const purposeSchema = z.string().min(1).max(300);

export const declaredReachSchema = z.strictObject({
  origins: z
    .array(
      z.strictObject({
        origin: networkOriginSchema,
        purpose: purposeSchema,
        /** The secret the host adds to requests to this origin, by name. */
        secret: egressSecretNameSchema.optional(),
      }),
    )
    .max(64),
  secrets: z.array(z.strictObject({ name: egressSecretNameSchema, purpose: purposeSchema })).max(64),
  browserTokens: z
    .array(
      z.strictObject({
        provider: browserTokenProviderSchema,
        scopes: z.array(browserTokenScopeSchema).min(1).max(64),
        purpose: purposeSchema,
      }),
    )
    .max(64),
  /** Accounts the services connect to. Absent and empty mean the same: the package connects to none. */
  connections: z
    .array(
      z.strictObject({
        provider: z.string().min(1).max(64),
        displayName: z.string().min(1).max(120),
        scopes: z.array(z.strictObject({ scope: connectionScopeSchema, purpose: purposeSchema })).min(1).max(16),
        endpoints: z.array(networkOriginSchema).min(1).max(8),
      }),
    )
    .max(8)
    .optional(),
});
export type DeclaredReach = z.infer<typeof declaredReachSchema>;

/** The facet fields reach is read from; any manifest facet satisfies it. */
export interface ReachFacet {
  kind: string;
  egress?: ServiceEgress | undefined;
  browserTokens?: BrowserTokens | undefined;
  connection?: ServiceConnectionRequirement | undefined;
}

/** Sorted by a key and with repeats removed, so two lists of the same items compare equal. */
function canonical<T>(items: readonly T[], key: (item: T) => string): T[] {
  const unique = new Map<string, T>();
  for (const item of items) unique.set(key(item), item);
  return [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, item]) => item);
}

/**
 * One canonical form of a reach. Two facets naming the same origin, secret or provider for different purposes keep
 * both, so a listing never shows less than one of the facets says.
 */
export function canonicalReach(reach: DeclaredReach): DeclaredReach {
  const connections = canonical(
    (reach.connections ?? []).map((entry) => ({
      provider: entry.provider,
      displayName: entry.displayName,
      scopes: canonical(entry.scopes.map((scope) => ({ scope: scope.scope, purpose: scope.purpose })), (scope) => JSON.stringify([scope.scope, scope.purpose])),
      endpoints: [...new Set(entry.endpoints)].sort(),
    })),
    (entry) => JSON.stringify([entry.provider, entry.displayName, entry.scopes, entry.endpoints]),
  );
  return {
    origins: canonical(
      reach.origins.map((entry) => ({
        origin: entry.origin,
        purpose: entry.purpose,
        ...(entry.secret === undefined ? {} : { secret: entry.secret }),
      })),
      (entry) => JSON.stringify([entry.origin, entry.purpose, entry.secret ?? ""]),
    ),
    secrets: canonical(
      reach.secrets.map((entry) => ({ name: entry.name, purpose: entry.purpose })),
      (entry) => JSON.stringify([entry.name, entry.purpose]),
    ),
    browserTokens: canonical(
      reach.browserTokens.map((entry) => ({ provider: entry.provider, scopes: [...new Set(entry.scopes)].sort(), purpose: entry.purpose })),
      (entry) => JSON.stringify([entry.provider, entry.scopes, entry.purpose]),
    ),
    // Only present when there is one, so a package that connects to nothing keeps the form it always had.
    ...(connections.length === 0 ? {} : { connections }),
  };
}

/** The reach a manifest declares, in canonical form. */
export function declaredReachOf(manifest: { facets: readonly ReachFacet[] }): DeclaredReach {
  const reach: DeclaredReach = { origins: [], secrets: [], browserTokens: [] };
  for (const facet of manifest.facets) {
    if (facet.kind === "tools" && facet.egress !== undefined) {
      for (const entry of facet.egress.origins) {
        reach.origins.push({
          origin: entry.origin,
          purpose: entry.purpose,
          ...(entry.credential === undefined ? {} : { secret: entry.credential.secret }),
        });
      }
      reach.secrets.push(...facet.egress.secrets);
    }
    if (facet.kind === "tools" && facet.connection !== undefined) {
      (reach.connections ??= []).push({
        provider: facet.connection.provider,
        displayName: facet.connection.displayName,
        scopes: facet.connection.scopes,
        endpoints: facet.connection.endpoints,
      });
    }
    if (facet.kind === "ui" && facet.browserTokens !== undefined) reach.browserTokens.push(...facet.browserTokens.providers);
  }
  return canonicalReach(reach);
}

export function declaredReachIsEmpty(reach: DeclaredReach): boolean {
  return (
    reach.origins.length === 0 &&
    reach.secrets.length === 0 &&
    reach.browserTokens.length === 0 &&
    (reach.connections?.length ?? 0) === 0
  );
}

/**
 * Why what a listing showed is not what the package declares, or `undefined` when they agree.
 *
 * A listing without the field says the package reaches nothing. The order a publisher wrote is not a mismatch; a
 * missing origin, a different purpose or an extra scope is.
 */
export function declaredReachMismatch(listed: DeclaredReach | undefined, declared: DeclaredReach): string | undefined {
  const shown = canonicalReach(listed ?? { origins: [], secrets: [], browserTokens: [] });
  const actual = canonicalReach(declared);
  const parts: string[] = [];
  if (JSON.stringify(shown.origins) !== JSON.stringify(actual.origins)) parts.push("the origins it reaches");
  if (JSON.stringify(shown.secrets) !== JSON.stringify(actual.secrets)) parts.push("the secrets it needs");
  if (JSON.stringify(shown.browserTokens) !== JSON.stringify(actual.browserTokens)) parts.push("the browser tokens it asks for");
  if (JSON.stringify(shown.connections ?? []) !== JSON.stringify(actual.connections ?? [])) parts.push("the accounts it connects to");
  return parts.length === 0 ? undefined : `the listing does not show ${parts.join(", ")} as the package declares them`;
}

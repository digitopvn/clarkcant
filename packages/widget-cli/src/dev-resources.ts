import { randomBytes } from "node:crypto";

import {
  BROWSER_TOKEN_LIMITS,
  decideResourceProfile,
  describeResourceProfile,
  type BrowserTokenDeclaration,
  type ResourceGrant,
  type ResourceRequest,
} from "@clarkcant/contracts";
import { checkBrowserTokenRequest, type BrowserTokenSupport } from "@clarkcant/integration-sdk";
import type { FrameTokenOutcome } from "@clarkcant/widget-host";
import { tokenRequestSchema } from "@clarkcant/widget-sdk";

/**
 * Resource profiles and browser tokens in `clark widget dev`, simulated.
 *
 * A package that asks for a larger profile has to work when the node grants it and when the node does not: its
 * services are then not started, and every action bound to them is unavailable with the node's sentence. A widget that
 * asks for a browser token has to handle the token and a refusal. The dev host answers both with the same decision
 * function and the same request check the node uses, and the shell's controls choose which answer comes back.
 *
 * Nothing here is real: no container is sized, no provider is asked, and a simulated token is random bytes that open
 * nothing. Every answer says it was simulated.
 */

export const SIMULATED = "(simulated by clark widget dev)";

export type DevProfileMode = "granted" | "refused";
export type DevTokenMode = "grant" | "refuse";

/**
 * The grant the node would decide, with the shell choosing whether its execution policy refuses.
 *
 * The decision is `decideResourceProfile` itself, so what cannot be refused on a node cannot be refused here either:
 * `interactive-light` is always granted, and a GPU is never granted, whichever mode the shell is in.
 */
export function simulateResourceGrant(input: { request: ResourceRequest | undefined; mode: DevProfileMode }): ResourceGrant {
  return decideResourceProfile({
    request: input.request,
    needsContainer: true,
    // The dev host does not ask an engine, so the capacity check is the one part of the node's decision not simulated.
    capacity: undefined,
    policyRefusal: input.mode === "refused" ? `the execution policy refused it ${SIMULATED}` : undefined,
  });
}

/** The sentence the shell shows for a grant, labelled as simulated. */
export function describeSimulatedGrant(grant: ResourceGrant): string {
  if (grant.status === "degraded") {
    return `Not granted: ${grant.reason}. Services are not started, and every action bound to them is unavailable.`;
  }
  const notes = grant.notes.length === 0 ? "" : ` ${grant.notes.join("; ")}.`;
  return `Granted ${grant.profile.name} ${SIMULATED}: ${describeResourceProfile(grant.profile)}.${notes}`;
}

export interface DevTokenEvent {
  provider: string;
  outcome: "issued" | "refused";
  code?: string;
}

const DEV_TOKEN_EVENTS = 200;

/**
 * The simulated `tokens@1` broker.
 *
 * A request is held to the package's declaration by `checkBrowserTokenRequest`, so an undeclared provider or scope, or
 * a lifetime too long, is refused with the node's code. The simulated provider is the most permissive a node accepts —
 * scoped, revocable, every declared scope, the longest lifetime — so a refusal the author sees is the package's own,
 * or the shell's "refuse" control, which answers as a node with no adapter for the provider does.
 *
 * The events name the provider and the outcome; the value is never kept, as on a node.
 */
export function createDevTokenBroker(input: {
  declared: readonly BrowserTokenDeclaration[];
  mode: () => DevTokenMode;
  now?: () => number;
}): { handle(request: unknown): FrameTokenOutcome; events(): readonly DevTokenEvent[] } {
  const now = input.now ?? (() => Date.now());
  const events: DevTokenEvent[] = [];
  const record = (event: DevTokenEvent): void => {
    events.push(event);
    if (events.length > DEV_TOKEN_EVENTS) events.shift();
  };
  return {
    handle(raw) {
      const parsed = tokenRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return { status: "refused", code: "SCHEMA_INVALID", message: "a token request is { provider, scopes, ttlSeconds? }" };
      }
      const request = parsed.data;
      const declaration = input.declared.find((entry) => entry.provider === request.provider);
      const support: BrowserTokenSupport | undefined =
        declaration === undefined || input.mode() === "refuse"
          ? undefined
          : {
              provider: declaration.provider,
              scoped: true,
              maxTtlSeconds: BROWSER_TOKEN_LIMITS.maxTtlSeconds,
              scopes: declaration.scopes,
              revocation: "revocable",
            };
      const check = checkBrowserTokenRequest({ support, declared: input.declared, request });
      if (!check.ok) {
        record({ provider: request.provider, outcome: "refused", code: check.code });
        return { status: "refused", code: check.code, message: `${check.message} ${SIMULATED}` };
      }
      record({ provider: request.provider, outcome: "issued" });
      return {
        status: "ok",
        token: {
          provider: request.provider,
          // Random, and marked, so a value an author sees in a log is recognisably not a provider's.
          value: `dev-simulated-${randomBytes(18).toString("base64url")}`,
          scopes: check.scopes,
          expiresAt: new Date(now() + check.ttlSeconds * 1000).toISOString(),
        },
      };
    },
    events: () => events,
  };
}

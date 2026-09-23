import { type Instant } from "@clarkcant/contracts";
import {
  EXECUTION_POLICY_PREFERENCE_KEY,
  listRegisteredPreferences,
  readExecutionPolicyPreference,
  readRegisteredPreference,
  undoRegisteredPreference,
  writeRegisteredPreference,
} from "@clarkcant/core";
import { type Database, recentEvents } from "@clarkcant/storage";

import { projectPolicyPreference, undoPolicyPreference, writePolicyPreference } from "../autonomy-settings.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * The registered preferences, the activity log, and the legacy keys that name the one policy.
 *
 * The route owns its own HTTP: parsing a write, mapping a refusal to a status, and the shape of the
 * answer. Every dependency is a parameter, narrowed to the node fields these routes read, so nothing
 * here reaches for state it was not handed.
 *
 * `undefined` means "not one of mine", which is how the dispatch keeps the route order it had when
 * these branches lived in the gateway.
 */
export interface PreferenceRouteDeps {
  services: { runtime: { db: Database; identity: { ownerPrincipalId: string } } };
  request: GatewayRequest;
  segments: string[];
  at: () => string;
}

/**
 * The preference family. `undefined` means the request is not one of these routes.
 */
export function handlePreferenceRoutes(deps: PreferenceRouteDeps): GatewayResponse | undefined {
  const { request, segments, at } = deps;
  const { runtime } = deps.services;

  // `at` answers a plain string; a preference write is stamped with a branded instant, and the
  // gateway's own clock is the one every other write on this path already uses.
  const preferenceDeps = { db: runtime.db, now: () => at() as Instant };

  /*
   * The registered preferences, their current values, and when each change takes effect.
   *
   * A registry rather than a free-form store. A key nothing declares is refused by name, because a
   * stored value nothing reads is a setting that silently does nothing — and because answering only
   * for declared keys is what keeps credentials, which have their own store and their own routes,
   * out of this response by construction rather than by remembering to filter them.
   *
   * A preference the user has never set is answered with the default the product would use and
   * `isDefault: true`, so the surface renders a real current state instead of inventing one and
   * cannot present a default as a choice somebody made.
   */
  if (segments.length === 1 && segments[0] === "preferences" && request.method === "GET") {
    const stored = listRegisteredPreferences(preferenceDeps, runtime.identity.ownerPrincipalId);
    /*
     * The two keys a surface may still spell the policy's mode and rules in are answered as views of the one
     * policy, not as their own rows: a value nothing reads is a setting that does nothing, and the whole point
     * of the registry is that a key a surface writes is a key the node obeys.
     *
     * The policy comes from `readExecutionPolicyPreference` — the one reader, with the canonical row's own
     * markers — rather than from a second read of the preference key. A read of the key would answer with the
     * registry's default whenever no canonical row exists, which on an upgraded node whose legacy `autonomy` is
     * `deny` reported `execution.mode: "autonomous"` for a node that refuses every effect. Reading it can store
     * the canonical default the first time (that is the migration), which is exactly what makes what this route
     * reports the same value the node will obey.
     */
    const policy = readExecutionPolicyPreference(preferenceDeps, runtime.identity.ownerPrincipalId);
    return json(200, {
      preferences: stored.map((preference) =>
        preference.key === EXECUTION_POLICY_PREFERENCE_KEY
          ? policy
          : projectPolicyPreference(policy, preference),
      ),
    });
  }

  /*
   * The effects this node performed without an approval card.
   *
   * This is what makes autonomy checkable rather than merely trusted: an approval card is its own record, and
   * an effect that skipped the card would otherwise leave nothing a person could look at. Read from the same
   * event log the task lifecycle writes to.
   *
   * The document is passed through as the writer stored it, and the writer is `recordEffectExecution`, which
   * puts a description and an operation digest there — never a credential, and never the output of a command.
   */
  if (segments.length === 1 && segments[0] === "activity" && request.method === "GET") {
    const events = recentEvents(runtime.db, { stream: "activity", limit: 20 });
    return json(200, {
      effects: events.map((event) => {
        const document = (typeof event.document === "object" && event.document !== null
          ? event.document
          : {}) as Record<string, unknown>;
        return {
          at: event.occurredAt,
          kind: event.kind,
          mode: typeof document.mode === "string" ? document.mode : "unknown",
          category: typeof document.category === "string" ? document.category : "unknown",
          description: typeof document.description === "string" ? document.description : "",
          operationDigest: typeof document.operationDigest === "string" ? document.operationDigest : "",
          because: typeof document.because === "string" ? document.because : "",
        };
      }),
    });
  }

  if (segments.length === 2 && segments[0] === "preferences" && request.method === "PUT") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    // Presence, not truthiness: `false` and `""` are values a preference may legitimately hold, so
    // the only thing refused here is a body that names no value at all.
    if (!("value" in parsed.value)) {
      return fail(400, "INVALID_SCHEMA", "a preference write needs a value");
    }
    const requested = segments[1] ?? "";
    /*
     * The legacy policy keys first. A surface that still writes `execution.mode` or `execution.rules` is writing
     * about the one policy, and the answer is that policy's value projected back under the key it asked for —
     * otherwise the write would land in a row nothing reads and the surface would report a change that changes
     * nothing.
     */
    const compat = writePolicyPreference(preferenceDeps, {
      principalId: runtime.identity.ownerPrincipalId,
      key: requested,
      value: parsed.value.value,
    });
    if (compat !== undefined) {
      if (!compat.ok) {
        return fail(compat.code === "PREFERENCE_UNKNOWN" ? 404 : 400, compat.code, compat.message);
      }
      // The answer is the policy in force, projected under the key that was written — through the one reader, so
      // the value a surface is shown is the value the node will obey.
      const policy = readExecutionPolicyPreference(preferenceDeps, runtime.identity.ownerPrincipalId);
      const view = readRegisteredPreference(preferenceDeps, {
        principalId: runtime.identity.ownerPrincipalId,
        key: requested,
      });
      if (view !== undefined) {
        return json(200, { preference: projectPolicyPreference(policy, view) });
      }
    }
    const outcome = writeRegisteredPreference(preferenceDeps, {
      principalId: runtime.identity.ownerPrincipalId,
      key: requested,
      value: parsed.value.value,
    });
    if (!outcome.ok) {
      // A key this node does not have is not found; a value it does not accept is a bad request.
      // The message names the field and never echoes what arrived.
      return fail(
        outcome.code === "PREFERENCE_UNKNOWN" ? 404 : 400,
        outcome.code,
        outcome.message,
      );
    }
    return json(200, { preference: outcome.preference });
  }

  if (
    segments.length === 3 &&
    segments[0] === "preferences" &&
    segments[2] === "undo" &&
    request.method === "POST"
  ) {
    /*
     * The legacy policy keys first, for the same reason the write path asks first: a write through `execution.mode`
     * or `execution.rules` landed in the canonical policy, so undoing one has to reach the row it changed.
     */
    const outcome =
      undoPolicyPreference(preferenceDeps, {
        principalId: runtime.identity.ownerPrincipalId,
        key: segments[1] ?? "",
      }) ??
      undoRegisteredPreference(preferenceDeps, {
        principalId: runtime.identity.ownerPrincipalId,
        key: segments[1] ?? "",
      });
    if (!outcome.ok) return fail(404, outcome.code, outcome.message);
    // `undone: false` travels as a success, because a key nobody has written has nothing to undo:
    // reporting a change that did not happen would be worse than reporting that there was none.
    return json(200, outcome);
  }

  return undefined;
}

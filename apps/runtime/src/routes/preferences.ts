import { MAP_TILE_POLICY_PREFERENCE, accentPreferenceSchema, parseThemeRef, type Instant } from "@clarkcant/contracts";
import { CLARK_THEME, customizedTheme, themeDrawProblem } from "@clarkcant/design-tokens";
import {
  BROWSER_PRESS_LABEL_MAX,
  BROWSER_PRESS_PAGE_MAX,
  type BrowserPress,
  EXECUTION_POLICY_PREFERENCE_KEY,
  listRegisteredPreferences,
  readExecutionPolicyPreference,
  readRegisteredPreference,
  undoRegisteredPreference,
  writeRegisteredPreference,
} from "@clarkcant/core";
import { recentEvents } from "@clarkcant/storage";

import { writeMapTilePolicy } from "../application/map-tile-policy.ts";
import { readAppearanceCustomization, readThemeRegistry, resolveAppearance, resolveThemeRef, themeRegistryDeps, type ThemeServices } from "../application/themes.ts";
import { projectPolicyPreference, undoPolicyPreference, writePolicyPreference } from "../autonomy-settings.ts";
import { nodeWork } from "../work-supervisor.ts";
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
  /** The theme registry's fields too: a theme choice is checked against the themes this node can draw. */
  services: ThemeServices;
  request: GatewayRequest;
  segments: string[];
  at: () => string;
}

/**
 * A recorded press on a page, passed on only when it is the shape `recordEffectExecution` writes: the client words it
 * in the person's language, so anything else is left out and the fixed description stands in for it.
 */
function activityAction(value: unknown): BrowserPress | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { verb, label, page } = value as Record<string, unknown>;
  if (verb !== "click" || typeof label !== "string" || typeof page !== "string") return undefined;
  if (label.length > BROWSER_PRESS_LABEL_MAX || page === "" || page.length > BROWSER_PRESS_PAGE_MAX) return undefined;
  return { verb, label, page };
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
        const action = activityAction(document.action);
        return {
          at: event.occurredAt,
          kind: event.kind,
          mode: typeof document.mode === "string" ? document.mode : "unknown",
          category: typeof document.category === "string" ? document.category : "unknown",
          description: typeof document.description === "string" ? document.description : "",
          ...(action === undefined ? {} : { action }),
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
    /*
     * A theme is chosen only when this node can draw it. A reference no installed package provides, or one whose theme
     * fails validation, the contrast audit or the protected-state audit, would otherwise be stored and answered with success while the page went
     * on drawing Clark Default: a change that changes nothing. The refusal carries the same code and reason the
     * appearance would have given. A choice already stored is never re-checked here, so a package removed after its
     * theme was chosen still falls back visibly and comes back when the package does.
     */
    // A value that is not a reference at all is left to the key's own schema, which refuses it as malformed.
    const chosenTheme = requested === "experience.themeRef" && typeof parsed.value.value === "string" ? parsed.value.value : undefined;
    const accent = requested === "experience.accent" ? accentPreferenceSchema.safeParse(parsed.value.value) : undefined;
    if ((accent?.success === true && accent.data !== null) || (chosenTheme !== undefined && parseThemeRef(chosenTheme) !== undefined)) {
      const themeDeps = themeRegistryDeps(deps.services);
      const registry = readThemeRegistry(themeDeps);
      const current = resolveAppearance(themeDeps, registry, chosenTheme);
      const customization = readAppearanceCustomization(themeDeps);
      if (accent?.success === true) customization.accent = accent.data;
      const problem = themeDrawProblem(customizedTheme(current.theme ?? CLARK_THEME, customization));
      if (problem !== undefined) return fail(409, problem.code,
        `the accent would hide text or protected states, so the preference was kept: ${problem.message}`,
        problem.code === "THEME_LOW_CONTRAST" ? { contrast: problem.contrast } : { protected: problem.protected });
    }
    if (chosenTheme !== undefined && parseThemeRef(chosenTheme) !== undefined) {
      const resolved = resolveThemeRef(readThemeRegistry(themeRegistryDeps(deps.services)), chosenTheme);
      if (!resolved.ok) {
        const { code, message, contrast } = resolved.fallback;
        const hidden = resolved.fallback.protected;
        return fail(
          409,
          code,
          `that theme cannot be drawn here, so it was not chosen: ${message}`,
          contrast !== undefined ? { contrast } : hidden !== undefined ? { protected: hidden } : undefined,
        );
      }
    }
    // The map tile policy is written through the one path Clark's approved card uses too (`map-tile-policy.ts`).
    const outcome = requested === MAP_TILE_POLICY_PREFERENCE
      ? writeMapTilePolicy(preferenceDeps, { principalId: runtime.identity.ownerPrincipalId, value: parsed.value.value, source: "click" })
      : writeRegisteredPreference(preferenceDeps, {
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
    // A raised limit applies to what is already waiting, not only to the next request.
    if (requested === "execution.backgroundLimit") nodeWork().refill();
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

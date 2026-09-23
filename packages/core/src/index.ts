/**
 * @clarkcant/core
 *
 * The invariants no extension may replace: task and effect state, authority and
 * grant intersection, resource leases and fencing, capability readiness, install
 * generations, widget ownership and action bindings.
 *
 * These are pure decisions plus durable writes. Nothing here talks to a network,
 * a model, or an operating system, which is what makes the invariants testable
 * without any external account.
 */

export * from "./task-service.ts";
export * from "./control-sessions.ts";
export * from "./package-sources.ts";
export * from "./directory-index.ts";
export * from "./install-from-source.ts";
export * from "./install-from-entry.ts";
export * from "./package-files.ts";
export * from "./widget-document.ts";
export * from "./widget-package.ts";
export * from "./widget-frame.ts";
export * from "./frame-grant.ts";
export * from "./installed-packages.ts";
export * from "./installed-widgets.ts";
export * from "./coordination.ts";
export * from "./capability-registry.ts";
export * from "./install-lifecycle.ts";
export * from "./widget-service.ts";
export * from "./widget-lifecycle.ts";
export * from "./preferences.ts";
export * from "./preference-registry.ts";
export * from "./execution-policy.ts";
export * from "./execution-policy-migration.ts";
export * from "./onboarding.ts";
export * from "./limits.ts";
export * from "./consent.ts";
export * from "./continuation.ts";
export * from "./routing.ts";
export * from "./conductor.ts";
export * from "./app-intents.ts";

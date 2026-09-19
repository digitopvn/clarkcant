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
export * from "./coordination.ts";
export * from "./capability-registry.ts";
export * from "./install-lifecycle.ts";
export * from "./widget-service.ts";
export * from "./widget-lifecycle.ts";
export * from "./preferences.ts";
export * from "./onboarding.ts";
export * from "./limits.ts";
export * from "./consent.ts";
export * from "./continuation.ts";
export * from "./routing.ts";
export * from "./conductor.ts";
export * from "./app-intents.ts";

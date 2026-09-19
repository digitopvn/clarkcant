/**
 * @clarkcant/contracts
 *
 * The single source of truth for every boundary in the system. Everything here is
 * runtime-validated rather than TypeScript-only, because the values cross process,
 * node and release boundaries where a compile-time type is no longer evidence.
 *
 * These are this application's own contracts. They are deliberately not presented
 * as official Pi, MCP, or A2A wire schemas — see docs/research-and-decisions.md.
 */

export * from "./primitives.ts";
export * from "./redaction.ts";
export * from "./preferences.ts";
export * from "./protocol.ts";
export * from "./errors.ts";
export * from "./envelope.ts";
export * from "./grants.ts";
export * from "./tasks.ts";
export * from "./effects.ts";
export * from "./install.ts";
export * from "./widgets.ts";
export * from "./surface-composition.ts";
export * from "./period.ts";
export * from "./automation.ts";
export * from "./nodelink.ts";
export * from "./voice.ts";
export * from "./attachments.ts";
export * from "./surfaces.ts";

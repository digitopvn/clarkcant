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
export * from "./turn-origin.ts";
export * from "./redaction.ts";
export * from "./data-class.ts";
export * from "./project-instructions.ts";
export * from "./themes.ts";
export * from "./preferences.ts";
export * from "./protocol.ts";
export * from "./errors.ts";
export * from "./envelope.ts";
export * from "./grants.ts";
export * from "./host-path.ts";
export * from "./tasks.ts";
export * from "./effects.ts";
export * from "./install.ts";
export * from "./directory.ts";
export * from "./widgets.ts";
export * from "./widget-state.ts";
export * from "./widget-perform.ts";
export * from "./table-view.ts";
export * from "./composition-graph.ts";
export * from "./widget-semantic.ts";
export * from "./schema-patterns.ts";
export * from "./artifact-viewers.ts";
export * from "./widget-props.ts";
export * from "./composition-layout.ts";
export * from "./form-fields.ts";
export * from "./status-cards.ts";
export * from "./xy-charts.ts";
export * from "./calendar-view.ts";
export * from "./activity-timeline.ts";
export * from "./tree-view.ts";
export * from "./diagram-view.ts";
export * from "./diagram-layout.ts";
export * from "./diagram-mermaid.ts";
export * from "./board-view.ts";
export * from "./media-view.ts";
export * from "./map-view.ts";
export * from "./media-content.ts";
export * from "./text-rules.ts";
export * from "./surface-composition.ts";
export * from "./period.ts";
export * from "./automation.ts";
export * from "./nodelink.ts";
export * from "./voice.ts";
export * from "./attachments.ts";
export * from "./artifacts.ts";
export * from "./jobs.ts";
export * from "./resource-profiles.ts";
export * from "./service-egress.ts";
export * from "./service-connection.ts";
export * from "./service-artifacts.ts";
export * from "./browser-token.ts";
export * from "./declared-reach.ts";
export * from "./reach-change.ts";
export * from "./composer-references.ts";
export * from "./slash-commands.ts";
export * from "./release-notes.ts";
export * from "./feedback.ts";
export * from "./app-intents.ts";
export * from "./conversation-deletion.ts";
export * from "./surfaces.ts";
export * from "./timeline-window.ts";
export * from "./machine-surfaces.ts";
export * from "./sse.ts";
export * from "./execution.ts";
export * from "./interactions.ts";
export * from "./models.ts";

export * from "./suggestions.ts";
export * from "./inbox.ts";

export * from "./memory.ts";
export * from "./implementation-status.ts";
export * from "./signals.ts";
export * from "./ingress-mode.ts";
export * from "./channels.ts";
export * from "./delegation.ts";
export * from "./read-context.ts";
export * from "./runtime-fabric.ts";
export * from "./capability-discovery.ts";
export * from "./reach-expansion.ts";
export * from "./execution-envelope.ts";

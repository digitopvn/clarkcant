/**
 * The widget runtime, bundled for the frame.
 *
 * A widget runs in an opaque-origin frame, so the codec it speaks to the host has to reach it as a file a browser can
 * load. `@clarkcant/widget-sdk` is TypeScript resolved to source in this workspace, which a browser cannot run, so
 * the host's own build emits this entry — that is the only reason this file exists, and it is deliberately nothing
 * more than a re-export: a second implementation of the protocol living here is exactly what must not happen.
 */
export { createWidgetRuntime, readyMessage } from "@clarkcant/widget-sdk";
export type { BridgeRejection, MessageEndpoint, RuntimeStatus, WidgetRuntime } from "@clarkcant/widget-sdk";

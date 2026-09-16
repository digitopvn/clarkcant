/**
 * @clarkcant/example-note-widget
 *
 * Reference custom widget: a personal note with a draft store, revision-checked autosave
 * and no network or filesystem access. It exists to prove the isolated mini-app path end
 * to end, including the parts that are usually skipped — conflict preservation and state
 * migration.
 *
 * @implementation-status stub
 * TODO(P6): the widget bundle and its manifest. The package manifest, prop schema and
 * capability requests are declared below and match `docs/examples/note-pack.json`; the
 * executable UI and the isolated build that produces it are not written.
 *
 * Two properties the fixture exists to demonstrate:
 *   - it requests only `widget.state.read` and `widget.state.write`, so the sandbox
 *     policy grants it no origin, no microphone, no camera and no filesystem path;
 *   - a save is revision-checked, so a stale autosave loses and the draft survives
 *     rather than silently overwriting newer content.
 */

import type { WidgetDefinition } from "@clarkcant/contracts";

export const NOTE_DEFINITION: WidgetDefinition = {
  id: "example.notes.editor",
  version: "0.2.0",
  renderer: "isolated-app",
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: { title: { type: "string", maxLength: 120 } },
    required: ["title"],
  },
  eventSchemas: {
    "draft.changed": { type: "object" },
    "save.requested": { type: "object" },
  },
  stateSchema: { type: "object", properties: { body: { type: "string" }, revision: { type: "number" } } },
  stateVersion: 1,
  semanticDescription: "A personal note with a preserved draft",
  requestedCapabilities: ["widget.state.read@1", "widget.state.write@1"],
  sizing: { compact: true, expanded: true, minHeight: 160 },
  textFallback: "Personal note. The note text is shown as plain text when the editor cannot be mounted.",
  effectCategories: ["read"],
  datasetRefs: [],
};

/** Declared permissions: nothing. A note needs no network and no filesystem. */
export const PERMISSIONS = { networkOrigins: [], microphone: false, camera: false, filesystem: [] } as const;

/**
 * @implementation-status stub
 * TODO(P6): the bundle, the state machine and its migration test.
 */
export const NOTE_WIDGET_STATUS = "manifest-declared-bundle-not-implemented";

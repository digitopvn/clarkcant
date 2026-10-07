import { z } from "zod";

import { capabilityRefSchema } from "./grants.ts";
import type { PackageManifest } from "./install.ts";
import { networkOriginSchema } from "./network-origin.ts";
import { compareReach, reachChangeSchema, reachSnapshotOfManifest } from "./reach-change.ts";

/**
 * A live authoring session for a widget package on this machine: the package's folder is watched, each change that
 * reads as a valid package becomes an immutable dev generation, and the conversation shows the newest generation the
 * node activated in the same isolated frame a published widget runs in.
 *
 * Generations are immutable and named by the content digest of the files they were read from. A change that does not
 * read as a package becomes a failed build with diagnostics, and the last generation that did keeps running: the
 * session says so (`showingLastKnownGood`) rather than presenting old code as the current files.
 *
 * Each generation says what it reaches compared with the generation running before it (`DevReachDelta`). Nothing here
 * decides whether a generation may run: activation goes through the node's install path and its execution policy,
 * like any install. The delta is what that decision, and the person, are told about.
 */

/** The most diagnostics one failed build carries; the rest are counted. */
export const WIDGET_DEV_DIAGNOSTICS_MAX = 32;
/** The most added or removed items one delta list carries. */
export const DEV_DELTA_LIST_MAX = 32;

export const widgetDevDiagnosticSchema = z.strictObject({
  /** `error` stops the build; `warning` is reported beside a generation that still activates. */
  severity: z.enum(["error", "warning"]),
  /** Where the problem was found, relative to the package root, when the reader named a file. */
  path: z.string().min(1).max(400).optional(),
  /**
   * The node's own reason, as a code a client words in the person's language, when the node rather than the package's
   * reader found the problem (`WIDGET_DEV_DIAGNOSTIC_CODES`). Absent, `message` is the reader's own words.
   */
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,59}$/).optional(),
  message: z.string().min(1).max(1000),
});
export type WidgetDevDiagnostic = z.infer<typeof widgetDevDiagnosticSchema>;

/**
 * The diagnostics the node words itself.
 *
 * - `FACET_LANE_UNSUPPORTED`: the package declares a facet that runs outside the widget frame (a service, tools or
 *   native facet). A dev session runs only `isolated-ui` and `declarative` facets; such a package is installed the
 *   ordinary way instead.
 * - `FILES_UNREADABLE`: the folder's files could not be read, digested or copied for this build, for example because
 *   they changed while they were copied; the next save builds again.
 * - `FILES_TOO_LARGE`: the folder holds more files or bytes than a dev build takes; it stays refused until the person
 *   removes files (`node_modules` and `.git` at its top are not counted).
 * - `FILES_LINK_REFUSED`: a symbolic link in the folder points outside it; it stays refused until the person removes
 *   the link or copies its target into the folder.
 */
export const WIDGET_DEV_DIAGNOSTIC_CODES = ["FACET_LANE_UNSUPPORTED", "FILES_UNREADABLE", "FILES_TOO_LARGE", "FILES_LINK_REFUSED"] as const;

/** The facet lanes a dev session runs: the widget frame's own, and data the host reads without running it. */
export const WIDGET_DEV_ALLOWED_ISOLATIONS = ["isolated-ui", "declarative"] as const;

const listChange = <T extends z.ZodType>(item: T) =>
  z.strictObject({ added: z.array(item).max(DEV_DELTA_LIST_MAX), removed: z.array(item).max(DEV_DELTA_LIST_MAX) });

/**
 * What a generation reaches compared with the one before it.
 *
 * `reach` is the same comparison an update notice shows (origins, secrets, browser tokens, connections, resource
 * profile). The rest covers what a manifest asks for that the reach comparison does not: requested capabilities, the
 * origins the frame's own document may connect to, device and filesystem permissions, load-time scripts, and facets
 * that run outside the frame (a service or native facet is a different lane, never a UI-only change).
 *
 * `initial` is the first generation of a session: there is nothing running to compare with, and the install decides it
 * exactly as it decides any first install.
 */
export const devReachDeltaSchema = z.strictObject({
  verdict: z.enum(["initial", "unchanged", "narrower", "wider"]),
  reach: reachChangeSchema.optional(),
  capabilities: listChange(capabilityRefSchema),
  frameOrigins: listChange(networkOriginSchema),
  /** Permission flags turned on (`added`) or off (`removed`): `microphone`, `camera`, `filesystem:<access>:<path>`, `lifecycle:<script>`. */
  permissions: listChange(z.string().min(1).max(400)),
  /** Facets by `<kind>:<id>:<isolation>`, so a facet that moved to another lane is one removed and one added. */
  facets: listChange(z.string().min(1).max(260)),
});
export type DevReachDelta = z.infer<typeof devReachDeltaSchema>;

type DeltaManifest = Pick<PackageManifest, "facets" | "requestedCapabilities" | "permissions" | "resources">;

function permissionItems(permissions: PackageManifest["permissions"]): string[] {
  return [
    ...(permissions.microphone ? ["microphone"] : []),
    ...(permissions.camera ? ["camera"] : []),
    ...permissions.filesystem.map((entry) => `filesystem:${entry.access}:${entry.path}`),
    ...permissions.lifecycleScripts.map((script) => `lifecycle:${script}`),
  ];
}

function facetItems(facets: PackageManifest["facets"]): string[] {
  return facets.map((facet) => `${facet.kind}:${facet.id}:${facet.isolation}`);
}

function setDelta<T extends string>(before: readonly T[], after: readonly T[]): { added: T[]; removed: T[] } {
  const was = new Set(before);
  const now = new Set(after);
  return {
    added: [...now].filter((item) => !was.has(item)).sort().slice(0, DEV_DELTA_LIST_MAX),
    removed: [...was].filter((item) => !now.has(item)).sort().slice(0, DEV_DELTA_LIST_MAX),
  };
}

function setAdds(before: readonly string[], after: readonly string[]): boolean {
  const was = new Set(before);
  return after.some((item) => !was.has(item));
}

function setRemoves(before: readonly string[], after: readonly string[]): boolean {
  return setAdds(after, before);
}

/**
 * Compare what the next generation's manifest asks for with what the running one asked for.
 *
 * `wider` when anything was added, whatever else was removed: a mixed change is wider, as an update's is. The verdict is
 * worked out from every item, not only the listed ones.
 */
export function compareDevReach(previous: DeltaManifest | undefined, next: DeltaManifest): DevReachDelta {
  const empty = { added: [], removed: [] };
  if (previous === undefined) {
    return { verdict: "initial", capabilities: empty, frameOrigins: empty, permissions: empty, facets: empty };
  }
  const reach = compareReach(reachSnapshotOfManifest(previous), reachSnapshotOfManifest(next));
  const pairs: [readonly string[], readonly string[]][] = [
    [previous.requestedCapabilities, next.requestedCapabilities],
    [previous.permissions.networkOrigins, next.permissions.networkOrigins],
    [permissionItems(previous.permissions), permissionItems(next.permissions)],
    [facetItems(previous.facets), facetItems(next.facets)],
  ];
  const wider = reach.verdict === "wider" || pairs.some(([before, after]) => setAdds(before, after));
  const narrower = reach.verdict === "narrower" || pairs.some(([before, after]) => setRemoves(before, after));
  return {
    verdict: wider ? "wider" : narrower ? "narrower" : "unchanged",
    ...(reach.verdict === "unchanged" ? {} : { reach }),
    capabilities: setDelta(previous.requestedCapabilities, next.requestedCapabilities),
    frameOrigins: setDelta(previous.permissions.networkOrigins, next.permissions.networkOrigins),
    permissions: setDelta(permissionItems(previous.permissions), permissionItems(next.permissions)),
    facets: setDelta(facetItems(previous.facets), facetItems(next.facets)),
  };
}

/** What made a build run. */
export const widgetDevTriggerSchema = z.enum(["start", "change", "rebuild"]);
export type WidgetDevTrigger = z.infer<typeof widgetDevTriggerSchema>;

/** One immutable dev generation: the files it was read from, by digest, and where they came from. */
export const widgetDevGenerationSchema = z.strictObject({
  /** Counts the session's successful builds from 1. */
  generation: z.int().positive(),
  packageId: z.string().min(1).max(160),
  version: z.string().min(1).max(64),
  /** The content digest of the package's files, the same digest a snapshot of them is named by. */
  digest: z.string().min(1).max(120),
  builtAt: z.iso.datetime({ offset: false }),
  trigger: widgetDevTriggerSchema,
  /** The widget definitions the generation declares. */
  widgetIds: z.array(z.string().min(1).max(160)).max(64),
  /** Against the generation that was running when this one was built. */
  delta: devReachDeltaSchema,
  /** Problems that did not stop the build. */
  warnings: z.array(widgetDevDiagnosticSchema).max(WIDGET_DEV_DIAGNOSTICS_MAX),
});
export type WidgetDevGeneration = z.infer<typeof widgetDevGenerationSchema>;

/** The latest build, whether or not it produced a generation. */
export const widgetDevBuildSchema = z.strictObject({
  ok: z.boolean(),
  at: z.iso.datetime({ offset: false }),
  trigger: widgetDevTriggerSchema,
  /** The generation it produced, when it did. A build of files identical to the newest generation produces none. */
  generation: z.int().positive().optional(),
  diagnostics: z.array(widgetDevDiagnosticSchema).max(WIDGET_DEV_DIAGNOSTICS_MAX),
  /** Diagnostics beyond the ones listed. */
  diagnosticsMore: z.int().positive().optional(),
});
export type WidgetDevBuild = z.infer<typeof widgetDevBuildSchema>;

/**
 * Where activation of the newest generation stands.
 *
 * - `active`: the node runs it.
 * - `awaiting-approval`: the policy asked; the install question is in the inbox (`approvalId`). The previous generation,
 *   if any, keeps running until the person answers.
 * - `refused`: the install path refused it (policy, digest, reach mismatch); `message` says why. The previous
 *   generation keeps running.
 * - `none`: no generation exists yet (the first build failed).
 */
export const widgetDevActivationSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("active"), generation: z.int().positive(), generationId: z.string().min(1).max(200) }),
  z.strictObject({ state: z.literal("awaiting-approval"), generation: z.int().positive(), approvalId: z.string().min(1).max(200) }),
  z.strictObject({
    state: z.literal("refused"),
    generation: z.int().positive(),
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(1000),
  }),
  z.strictObject({ state: z.literal("none") }),
]);
export type WidgetDevActivation = z.infer<typeof widgetDevActivationSchema>;

/**
 * Why a session stopped watching its folder.
 *
 * - `requested`: somebody stopped it.
 * - `watch-failed`: the platform stopped reporting changes (the folder was removed or cannot be watched).
 * - `folder-gone`: the folder was deleted or renamed while it was watched, or was not there when the node started again.
 * - `capacity`: the node already watched as many folders as it does at once when it started again.
 * - `root-refused`: when the node started again, the folder was no longer one the session may watch (for example a
 *   session Clark started whose folder is outside the widget workspace and every folder the person chose, or a folder
 *   now inside the data folder).
 */
export const widgetDevStopReasonSchema = z.enum(["requested", "watch-failed", "folder-gone", "capacity", "root-refused"]);
export type WidgetDevStopReason = z.infer<typeof widgetDevStopReasonSchema>;

/** A session as the node reports it. */
export const widgetDevSessionViewSchema = z.strictObject({
  sessionId: z.string().min(1).max(200),
  /** `live` exactly while the node watches the folder; a watcher that failed reads as `stopped` with its reason. */
  status: z.enum(["live", "stopped"]),
  stopReason: widgetDevStopReasonSchema.optional(),
  /** The package folder on this node. */
  root: z.string().min(1).max(1000),
  packageId: z.string().min(1).max(160).optional(),
  version: z.string().min(1).max(64).optional(),
  startedAt: z.iso.datetime({ offset: false }),
  /** Newest successful build. */
  latest: widgetDevGenerationSchema.optional(),
  /** The generation the node runs for this session, when one is active. */
  running: widgetDevGenerationSchema.optional(),
  activation: widgetDevActivationSchema,
  lastBuild: widgetDevBuildSchema.optional(),
  /**
   * True when what the conversation shows is older than the files: the last build failed, or the newest generation is
   * not active (waiting for approval or refused) while an older one is.
   */
  showingLastKnownGood: z.boolean(),
  /** The widget the session placed in its conversation, when it placed one. */
  placed: z.strictObject({ conversationId: z.string().min(1).max(200), instanceId: z.string().min(1).max(200) }).optional(),
});
export type WidgetDevSessionView = z.infer<typeof widgetDevSessionViewSchema>;

/** `POST /widget-dev/sessions`. */
export const widgetDevSessionCreateSchema = z.strictObject({
  /** An absolute path to the package folder on this node. */
  root: z.string().min(1).max(1000),
  /** Place the session's widget in this conversation once a generation is active. */
  conversationId: z.string().min(1).max(200).optional(),
  /** Which of the package's widgets to place; the first one it declares when left out. */
  widgetId: z.string().min(1).max(160).optional(),
});
export type WidgetDevSessionCreate = z.infer<typeof widgetDevSessionCreateSchema>;

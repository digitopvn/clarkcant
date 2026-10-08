import { z } from "zod";

import { offeredActionNameSchema } from "./widgets.ts";

/**
 * Clark performing an action an isolated widget offers, as it crosses from the node to the page that shows the widget
 * and back.
 *
 * The node decides — gate, input schema, policy, ledger — and then asks the page streaming the current turn (or the
 * voice session) with a `widget-perform` event. The page hands the request to the mounted frame (`actions.perform@1`)
 * and reports what the frame said at `POST /app-intents/widget-perform/:performId`. Only the page's own report settles
 * a perform: the route is person-only, so a machine surface cannot tell Clark a widget did something it never did.
 *
 * The event is versioned (`v`), and a page says which version it can run before the node sends one: the stream request
 * carries `WIDGET_PERFORM_HEADER`, the voice socket's `auth` frame carries `widgetPerform`. A caller that did not say so
 * — a relay, the CLI, an older page — is never sent one, so the node knows at once that nobody can ask a frame, rather
 * than waiting for a report that cannot come and recording an outcome nobody knows.
 */

/** The `widget-perform` event version this build sends and runs. */
export const WIDGET_PERFORM_VERSION = 1;

/**
 * The stream request header a page sets, to the version it runs, when it can hand a perform to a mounted frame and
 * report back. Its absence means the caller cannot, and no perform is sent on that stream.
 */
export const WIDGET_PERFORM_HEADER = "x-clarkcant-widget-perform";

export const widgetPerformIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, { error: "must be a widget perform id" });

/** What the page is asked to hand to a frame. The input has already been checked by the node. */
export const widgetPerformRequestSchema = z.strictObject({
  v: z.literal(WIDGET_PERFORM_VERSION),
  performId: widgetPerformIdSchema,
  instanceId: z.string().min(1).max(128),
  actionBindingId: z.string().min(1).max(128),
  action: offeredActionNameSchema,
  input: z.record(z.string(), z.unknown()),
});
export type WidgetPerformRequest = z.infer<typeof widgetPerformRequestSchema>;

/**
 * The codes the page itself answers with, when it never reached a frame or a frame's host session refused before
 * asking. Only these are taken as the page's own (`by: "page"`); anything a widget says is the widget's.
 */
export const PAGE_PERFORM_REFUSAL_CODES = [
  "FRAME_NOT_MOUNTED",
  // The widget is open in its own desktop window, which Clark cannot ask yet; reattaching it lets Clark act on it.
  "FRAME_DETACHED",
  "FRAME_NOT_READY",
  "EXTENSION_NOT_OFFERED",
  "ACTION_NOT_OFFERED",
  "PERFORM_IN_PROGRESS",
  "PERFORM_BUSY",
  "PERFORM_UNREADABLE",
  "PERFORM_VERSION_UNSUPPORTED",
  "SURFACE_GONE",
] as const;
export type PagePerformRefusalCode = (typeof PAGE_PERFORM_REFUSAL_CODES)[number];

/**
 * What the page reports.
 *
 * `done` and `refused` are the frame's answers, or the page's own refusal when it had no frame to ask. `by` says whose
 * refusal it is: `page` (one of `PAGE_PERFORM_REFUSAL_CODES`, nothing was asked) or `widget` (the widget's deliberate
 * refusal; its code is the widget's own word). `no-answer` is a frame that was asked and did not answer in time, went
 * away, or failed while performing: it may have done it.
 */
export const widgetPerformReportSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("done"), output: z.string().max(4_000).optional() }),
  z.strictObject({
    status: z.literal("refused"),
    by: z.enum(["page", "widget"]),
    code: z.string().min(1).max(60),
    message: z.string().min(1).max(600),
  }),
  z.strictObject({ status: z.literal("no-answer"), message: z.string().min(1).max(600) }),
]);
export type WidgetPerformReport = z.infer<typeof widgetPerformReportSchema>;

/**
 * A `widget-perform` event as a page reads it: a request to run, one to refuse because it cannot be read, or nothing to
 * answer at all.
 *
 * A request this page cannot run is still answered when its id can be read — the node is waiting on that id — with a
 * page refusal, since nothing was handed to a frame: `PERFORM_VERSION_UNSUPPORTED` for another version,
 * `PERFORM_UNREADABLE` for one that does not parse. Only an event without a readable id is dropped, because there is no
 * id to answer.
 */
export type ReadWidgetPerform =
  | { kind: "request"; request: WidgetPerformRequest }
  | { kind: "unreadable"; performId: string; report: Extract<WidgetPerformReport, { status: "refused" }> }
  | { kind: "none" };

export function readWidgetPerformRequest(value: unknown): ReadWidgetPerform {
  const parsed = widgetPerformRequestSchema.safeParse(value);
  if (parsed.success) return { kind: "request", request: parsed.data };
  const record = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const performId = widgetPerformIdSchema.safeParse(record["performId"]);
  if (!performId.success) return { kind: "none" };
  const otherVersion = record["v"] !== WIDGET_PERFORM_VERSION;
  return {
    kind: "unreadable",
    performId: performId.data,
    report: otherVersion
      ? {
          status: "refused",
          by: "page",
          code: "PERFORM_VERSION_UNSUPPORTED",
          message: `this page runs widget-perform version ${String(WIDGET_PERFORM_VERSION)}, not the version it was sent; nothing was handed to the widget`,
        }
      : {
          status: "refused",
          by: "page",
          code: "PERFORM_UNREADABLE",
          message: "this page could not read the request, so nothing was handed to the widget",
        },
  };
}

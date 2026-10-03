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
 */

export const widgetPerformIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, { error: "must be a widget perform id" });

/** What the page is asked to hand to a frame. The input has already been checked by the node. */
export const widgetPerformRequestSchema = z.strictObject({
  performId: widgetPerformIdSchema,
  instanceId: z.string().min(1).max(128),
  actionBindingId: z.string().min(1).max(128),
  action: offeredActionNameSchema,
  input: z.record(z.string(), z.unknown()),
});
export type WidgetPerformRequest = z.infer<typeof widgetPerformRequestSchema>;

/**
 * What the page reports.
 *
 * `done` and `refused` are the frame's answers, or the page's own refusal when it had no frame to ask (`code` says
 * which, such as `FRAME_NOT_MOUNTED`). `no-answer` is a frame that was asked and did not answer in time or went away:
 * it may have done it.
 */
export const widgetPerformReportSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("done"), output: z.string().max(4_000).optional() }),
  z.strictObject({ status: z.literal("refused"), code: z.string().min(1).max(60), message: z.string().min(1).max(600) }),
  z.strictObject({ status: z.literal("no-answer"), message: z.string().min(1).max(600) }),
]);
export type WidgetPerformReport = z.infer<typeof widgetPerformReportSchema>;

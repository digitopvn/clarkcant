import { PAGE_PERFORM_REFUSAL_CODES, type WidgetPerformReport, type WidgetPerformRequest } from "@clarkcant/contracts";
import type { FramePerformOutcome, FrameSession } from "@clarkcant/widget-host/session";

/**
 * The frames mounted on this page, by instance, so an action Clark asked a widget to perform reaches the one frame that
 * runs that widget now.
 *
 * Module-level on purpose: a `widget-perform` event arrives on the conversation's stream (or the voice socket), far from
 * the component that owns the frame, and the only thing the two share is the instance id. A frame registers its session
 * when its document mounts and removes it when the document goes, so a perform for a widget nobody is showing finds
 * nothing and is refused — never held for a frame that might mount later.
 */
const mounted = new Map<string, FrameSession[]>();

/** Register a mounted frame's session. Returns the function that removes it, for the frame's cleanup. */
export function registerMountedFrame(instanceId: string, session: FrameSession): () => void {
  const list = mounted.get(instanceId) ?? [];
  list.push(session);
  mounted.set(instanceId, list);
  return () => {
    const current = mounted.get(instanceId);
    if (current === undefined) return;
    const left = current.filter((entry) => entry !== session);
    if (left.length === 0) mounted.delete(instanceId);
    else mounted.set(instanceId, left);
  };
}

/**
 * What the desktop host answered when this page handed it a perform for a detached instance: taken, so the detached
 * window reports what its frame said, or refused with nothing pushed to any window.
 */
export type DetachedPerformHandoff = { ok: true } | { ok: false; code?: string | undefined; refused?: string | undefined };

/** Hands one perform to the desktop host for the window an instance is open in. */
export type DetachedPerformForward = (request: WidgetPerformRequest) => Promise<DetachedPerformHandoff>;

/**
 * The instances this page has handed to a detached desktop window, each with how to reach that window: one entry per
 * surface that detached it, the newest last.
 *
 * A perform for one of these goes to the window, never to a copy of the widget left on this page: the window is where
 * the person sees it. An entry without a forward is a desktop app whose host cannot take a perform; that is answered as
 * detached, with what to do about it, rather than reported as a widget nobody shows.
 */
const detached = new Map<string, { forward: DetachedPerformForward | undefined }[]>();

/**
 * Mark an instance as open in its own window, with the host verb that hands a perform to it when the shell has one.
 * Returns the function that unmarks it, for the surface's cleanup.
 */
export function markFrameDetached(instanceId: string, forward?: DetachedPerformForward): () => void {
  const entry = { forward };
  detached.set(instanceId, [...(detached.get(instanceId) ?? []), entry]);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (detached.get(instanceId) ?? []).filter((candidate) => candidate !== entry);
    if (left.length === 0) detached.delete(instanceId);
    else detached.set(instanceId, left);
  };
}

const PAGE_CODES: readonly string[] = PAGE_PERFORM_REFUSAL_CODES;

/**
 * Hand a perform for a detached instance to the desktop host.
 *
 * `undefined` when the host took it: the detached window asks its frame and the host reports, so this page sends
 * nothing. Otherwise the page's own refusal — nothing reached a frame — with the host's code when it is one of the
 * page's, and `FRAME_NOT_MOUNTED` for anything else, such as a window that closed as the perform arrived.
 */
async function handToDetached(
  forward: DetachedPerformForward | undefined,
  request: WidgetPerformRequest,
): Promise<WidgetPerformReport | undefined> {
  if (forward === undefined) {
    return {
      status: "refused",
      by: "page",
      code: "FRAME_DETACHED",
      message: "the widget is open in its own window, and this desktop app cannot hand Clark's action there; reattach it to let Clark act on it; nothing was sent",
    };
  }
  let handoff: DetachedPerformHandoff;
  try {
    handoff = await forward(request);
  } catch (cause) {
    handoff = { ok: false, refused: cause instanceof Error ? cause.message : String(cause) };
  }
  if (handoff.ok) return undefined;
  const code = handoff.code !== undefined && PAGE_CODES.includes(handoff.code) ? handoff.code : "FRAME_NOT_MOUNTED";
  const reason = handoff.refused === undefined || handoff.refused === "" ? "the widget's window could not be asked" : handoff.refused;
  return { status: "refused", by: "page", code, message: `${reason}; nothing was sent`.slice(0, 600) };
}

function report(outcome: FramePerformOutcome): WidgetPerformReport {
  if (outcome.status === "done") return outcome.output === undefined ? { status: "done" } : { status: "done", output: outcome.output.slice(0, 4_000) };
  if (outcome.status === "refused") {
    return {
      status: "refused",
      // The frame's host session refusing before it asked is this page's refusal; only the widget's own is the widget's.
      by: outcome.by === "host" ? "page" : "widget",
      code: outcome.code.slice(0, 60),
      message: (outcome.message === "" ? outcome.code : outcome.message).slice(0, 600),
    };
  }
  return { status: "no-answer", message: (outcome.message === "" ? "the widget did not answer" : outcome.message).slice(0, 600) };
}

/**
 * Hand one perform to the frame showing its instance, and say what came of it in the shape the node takes.
 *
 * The newest mount is asked: when the same widget is shown twice (inline and pinned), the one opened last is the one the
 * person is looking at. A frame that cannot be asked is refused by its own session with nothing posted.
 */
export async function performInMountedFrame(
  request: Pick<WidgetPerformRequest, "instanceId" | "performId" | "action" | "input">,
): Promise<WidgetPerformReport> {
  const sessions = mounted.get(request.instanceId) ?? [];
  const session = sessions[sessions.length - 1];
  if (session === undefined) {
    return {
      status: "refused",
      by: "page",
      code: "FRAME_NOT_MOUNTED",
      message: "this widget is not open on this screen, so it could not be asked; nothing was sent",
    };
  }
  try {
    return report(await session.perform({ performId: request.performId, action: request.action, input: request.input }));
  } catch (cause) {
    return { status: "no-answer", message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 600) || "the widget did not answer" };
  }
}

/** A `widget-perform` event as a page received it: one to run, or one it could not read but can still answer. */
export type WidgetPerformEvent =
  | { type: "widget-perform"; request: WidgetPerformRequest }
  | { type: "widget-perform-unreadable"; performId: string; report: WidgetPerformReport };

/**
 * Answer one `widget-perform` event, always, once: the node is waiting on its id, and silence would leave it waiting
 * until it can only record "unknown" for something that never ran.
 *
 * A page whose session moved on (`stale`) does not hand it to a frame — the conversation it belongs to is no longer the
 * one shown — and says so (`SURFACE_GONE`). A request it could not read is answered with the refusal already decided.
 * A perform for an instance open in its own desktop window goes to that window through the host, which then reports
 * what its frame answered; this page reports only when the host could not take it.
 */
export async function answerWidgetPerform(
  event: WidgetPerformEvent,
  send: (performId: string, report: WidgetPerformReport) => Promise<void>,
  options: { stale?: boolean } = {},
): Promise<void> {
  if (event.type === "widget-perform-unreadable") {
    await send(event.performId, event.report);
    return;
  }
  if (options.stale === true) {
    await send(event.request.performId, {
      status: "refused",
      by: "page",
      code: "SURFACE_GONE",
      message: "the screen moved on to another conversation before the widget could be asked; nothing was sent",
    });
    return;
  }
  const windows = detached.get(event.request.instanceId);
  const newest = windows?.[windows.length - 1];
  if (newest !== undefined) {
    const refused = await handToDetached(newest.forward, event.request);
    if (refused !== undefined) await send(event.request.performId, refused);
    return;
  }
  await send(event.request.performId, await performInMountedFrame(event.request));
}

/** A perform the desktop host pushed to the detached window: what to ask its frame, under the node's id. */
export interface ForwardedPerform {
  performId: string;
  action: string;
  input: Record<string, unknown>;
}

function readForwardedPerform(value: unknown): ForwardedPerform | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const input = record["input"];
  if (typeof record["performId"] !== "string" || typeof record["action"] !== "string") return undefined;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  return { performId: record["performId"], action: record["action"], input: input as Record<string, unknown> };
}

/**
 * The detached window's side: answer every perform the host pushes, by asking the frame this window mounts for its
 * instance, and report what it said to the host under the perform's id. The host checked the request and refuses a
 * report for an id it did not push; the node checks it again.
 *
 * Returns the unsubscribe, for the window's cleanup. A perform that arrives before the frame mounts is refused as not
 * mounted, as it would be on the conversation's page.
 */
export function answerForwardedPerforms(input: {
  instanceId: string;
  onPerform(listener: (push: unknown) => void): () => void;
  reportPerform(answer: { performId: string; report: WidgetPerformReport }): Promise<unknown>;
}): () => void {
  return input.onPerform((push) => {
    const perform = readForwardedPerform(push);
    if (perform === undefined) return;
    void performInMountedFrame({ instanceId: input.instanceId, ...perform })
      .then((report) => input.reportPerform({ performId: perform.performId, report }))
      // A report the host could not take is one it answers no-answer for when its own wait ends.
      .catch(() => undefined);
  });
}

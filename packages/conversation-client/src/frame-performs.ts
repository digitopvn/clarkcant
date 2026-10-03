import type { WidgetPerformReport, WidgetPerformRequest } from "@clarkcant/contracts";
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

function report(outcome: FramePerformOutcome): WidgetPerformReport {
  if (outcome.status === "done") return outcome.output === undefined ? { status: "done" } : { status: "done", output: outcome.output.slice(0, 4_000) };
  if (outcome.status === "refused") {
    return { status: "refused", code: outcome.code.slice(0, 60), message: (outcome.message === "" ? outcome.code : outcome.message).slice(0, 600) };
  }
  return { status: "no-answer", message: (outcome.message === "" ? "the widget did not answer" : outcome.message).slice(0, 600) };
}

/**
 * Hand one perform to the frame showing its instance, and say what came of it in the shape the node takes.
 *
 * The newest mount is asked: when the same widget is shown twice (inline and pinned), the one opened last is the one the
 * person is looking at. A frame that cannot be asked is refused by its own session with nothing posted.
 */
export async function performInMountedFrame(request: WidgetPerformRequest): Promise<WidgetPerformReport> {
  const sessions = mounted.get(request.instanceId) ?? [];
  const session = sessions[sessions.length - 1];
  if (session === undefined) {
    return {
      status: "refused",
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

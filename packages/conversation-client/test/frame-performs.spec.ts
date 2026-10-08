import { describe, expect, it } from "vitest";

import { WIDGET_PERFORM_VERSION, readWidgetPerformRequest, type WidgetPerformReport, type WidgetPerformRequest } from "@clarkcant/contracts";
import type { FramePerformOutcome, FrameSession } from "@clarkcant/widget-host/session";

import {
  answerForwardedPerforms,
  answerWidgetPerform,
  type DetachedPerformHandoff,
  markFrameDetached,
  performInMountedFrame,
  registerMountedFrame,
} from "../src/frame-performs.ts";

/**
 * The page's side of an action Clark asked a widget to perform: finding the frame that shows the widget now, and always
 * answering the node, which is waiting on the perform's id.
 */

const request = (instanceId: string, performId = "perform_1"): WidgetPerformRequest => ({
  v: WIDGET_PERFORM_VERSION,
  performId,
  instanceId,
  actionBindingId: "act_1",
  action: "format",
  input: { format: "percent" },
});

/** A mounted frame's session that answers as told and records what it was asked. */
function frame(outcome: FramePerformOutcome): { session: FrameSession; asked: string[] } {
  const asked: string[] = [];
  const session = {
    perform: async (call: { performId: string }) => {
      asked.push(call.performId);
      return outcome;
    },
  } as unknown as FrameSession;
  return { session, asked };
}

describe("handing a perform to the mounted frame", () => {
  it("refuses as the page's own, with nothing sent, when no frame shows the widget", async () => {
    expect(await performInMountedFrame(request("wi_none"))).toMatchObject({ status: "refused", by: "page", code: "FRAME_NOT_MOUNTED" });
  });

  it("asks the frame opened last, and stops asking a frame once it is gone", async () => {
    const inline = frame({ status: "done", output: "inline" });
    const pinned = frame({ status: "done", output: "pinned" });
    const removeInline = registerMountedFrame("wi_sheet", inline.session);
    const removePinned = registerMountedFrame("wi_sheet", pinned.session);

    expect(await performInMountedFrame(request("wi_sheet"))).toEqual({ status: "done", output: "pinned" });
    expect(inline.asked).toHaveLength(0);

    removePinned();
    expect(await performInMountedFrame(request("wi_sheet"))).toEqual({ status: "done", output: "inline" });
    removeInline();
    expect(await performInMountedFrame(request("wi_sheet"))).toMatchObject({ code: "FRAME_NOT_MOUNTED" });
  });

  it("says whose refusal it is: the host session's is the page's, the widget's stays the widget's", async () => {
    const host = frame({ status: "refused", by: "host", code: "FRAME_NOT_READY", message: "not ready" });
    const remove = registerMountedFrame("wi_host", host.session);
    expect(await performInMountedFrame(request("wi_host"))).toEqual({ status: "refused", by: "page", code: "FRAME_NOT_READY", message: "not ready" });
    remove();

    const widget = frame({ status: "refused", by: "widget", code: "NOTHING_SELECTED", message: "select cells" });
    const removeWidget = registerMountedFrame("wi_widget", widget.session);
    expect(await performInMountedFrame(request("wi_widget"))).toEqual({ status: "refused", by: "widget", code: "NOTHING_SELECTED", message: "select cells" });
    removeWidget();
  });
});

describe("answering a widget-perform event", () => {
  it("answers a perform that reached a page whose session moved on, without asking the frame", async () => {
    const shown = frame({ status: "done" });
    const remove = registerMountedFrame("wi_stale", shown.session);
    const sent: [string, WidgetPerformReport][] = [];
    await answerWidgetPerform({ type: "widget-perform", request: request("wi_stale", "perform_stale") }, async (id, report) => {
      sent.push([id, report]);
    }, { stale: true });
    expect(sent).toEqual([["perform_stale", expect.objectContaining({ status: "refused", by: "page", code: "SURFACE_GONE" })]]);
    expect(shown.asked).toHaveLength(0);
    remove();
  });

  it("answers a request it could not read under its id, so the node is not left waiting", async () => {
    const read = readWidgetPerformRequest({ ...request("wi_any", "perform_v2"), v: 2 });
    expect(read).toMatchObject({ kind: "unreadable", performId: "perform_v2", report: { by: "page", code: "PERFORM_VERSION_UNSUPPORTED" } });
    if (read.kind !== "unreadable") throw new Error("unreachable");
    const sent: string[] = [];
    await answerWidgetPerform({ type: "widget-perform-unreadable", performId: read.performId, report: read.report }, async (id, report) => {
      sent.push(`${id} ${report.status}`);
    });
    expect(sent).toEqual(["perform_v2 refused"]);
  });
});

describe("reading a widget-perform event", () => {
  it("reads this version, refuses another version or a malformed request by id, and drops one with no id", () => {
    expect(readWidgetPerformRequest(request("wi_1"))).toEqual({ kind: "request", request: request("wi_1") });
    expect(readWidgetPerformRequest({ ...request("wi_1"), v: undefined })).toMatchObject({ kind: "unreadable", report: { code: "PERFORM_VERSION_UNSUPPORTED" } });
    expect(readWidgetPerformRequest({ ...request("wi_1"), action: "" })).toMatchObject({ kind: "unreadable", report: { code: "PERFORM_UNREADABLE" } });
    expect(readWidgetPerformRequest({ ...request("wi_1"), performId: "bad id" })).toEqual({ kind: "none" });
    expect(readWidgetPerformRequest("nonsense")).toEqual({ kind: "none" });
  });
});

describe("a perform for a widget open in its own desktop window", () => {
  /** Answer one event and collect what this page sent the node. */
  async function answer(event: WidgetPerformRequest, options: { stale?: boolean } = {}): Promise<[string, WidgetPerformReport][]> {
    const sent: [string, WidgetPerformReport][] = [];
    await answerWidgetPerform({ type: "widget-perform", request: event }, async (id, report) => {
      sent.push([id, report]);
    }, options);
    return sent;
  }

  it("is handed to the host for the window, not to a copy of the widget on this page, and this page sends nothing", async () => {
    const shown = frame({ status: "done", output: "inline" });
    const remove = registerMountedFrame("wi_window", shown.session);
    const forwarded: WidgetPerformRequest[] = [];
    const reattach = markFrameDetached("wi_window", async (request) => {
      forwarded.push(request);
      return { ok: true };
    });
    expect(await answer(request("wi_window", "perform_window"))).toEqual([]);
    expect(forwarded).toEqual([request("wi_window", "perform_window")]);
    expect(shown.asked).toHaveLength(0);

    // Back in the conversation, the frame here is asked again.
    reattach();
    expect(await answer(request("wi_window", "perform_back"))).toEqual([["perform_back", { status: "done", output: "inline" }]]);
    remove();
  });

  it("answers the host's refusal as the page's own, with nothing sent to any frame", async () => {
    const answers: DetachedPerformHandoff[] = [
      { ok: false, code: "PERFORM_BUSY", refused: "the widget's window is answering 4 performs already" },
      { ok: false, code: "WINDOW_GONE", refused: "no widget window" },
    ];
    const reattach = markFrameDetached("wi_busy", async () => answers.shift() ?? { ok: true });
    expect(await answer(request("wi_busy", "perform_busy"))).toEqual([
      ["perform_busy", { status: "refused", by: "page", code: "PERFORM_BUSY", message: expect.stringContaining("nothing was sent") }],
    ]);
    // A code that is not the page's own is not passed on as one.
    expect(await answer(request("wi_busy", "perform_gone"))).toEqual([
      ["perform_gone", expect.objectContaining({ status: "refused", by: "page", code: "FRAME_NOT_MOUNTED" })],
    ]);
    reattach();

    const failing = markFrameDetached("wi_throws", async () => {
      throw new Error("the bridge went away");
    });
    expect(await answer(request("wi_throws", "perform_throws"))).toEqual([
      ["perform_throws", expect.objectContaining({ code: "FRAME_NOT_MOUNTED", message: expect.stringContaining("the bridge went away") })],
    ]);
    failing();
  });

  it("says the widget is detached when this desktop app's host cannot take a perform", async () => {
    const reattach = markFrameDetached("wi_old_host");
    expect(await answer(request("wi_old_host", "perform_old"))).toEqual([
      ["perform_old", expect.objectContaining({ status: "refused", by: "page", code: "FRAME_DETACHED" })],
    ]);
    reattach();
  });

  it("is not handed on from a page whose session moved on", async () => {
    const forwarded: string[] = [];
    const reattach = markFrameDetached("wi_stale_window", async (request) => {
      forwarded.push(request.performId);
      return { ok: true };
    });
    expect(await answer(request("wi_stale_window", "perform_stale_window"), { stale: true })).toEqual([
      ["perform_stale_window", expect.objectContaining({ code: "SURFACE_GONE" })],
    ]);
    expect(forwarded).toEqual([]);
    reattach();
  });
});

describe("the detached window answering the host's performs", () => {
  function host() {
    let listener: ((push: unknown) => void) | undefined;
    const reports: { performId: string; report: WidgetPerformReport }[] = [];
    let settle: () => void = () => undefined;
    const reported = new Promise<void>((resolve) => {
      settle = resolve;
    });
    return {
      onPerform: (next: (push: unknown) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      reportPerform: async (answer: { performId: string; report: WidgetPerformReport }) => {
        reports.push(answer);
        settle();
        return { ok: true };
      },
      push: (value: unknown) => listener?.(value),
      listening: () => listener !== undefined,
      reports,
      reported,
    };
  }

  it("asks the frame this window mounts for the instance, and reports what it said under the perform's id", async () => {
    const shown = frame({ status: "done", output: "edited" });
    const remove = registerMountedFrame("wi_detached_window", shown.session);
    const bridge = host();
    const stop = answerForwardedPerforms({ instanceId: "wi_detached_window", onPerform: bridge.onPerform, reportPerform: bridge.reportPerform });
    bridge.push({ performId: "perform_pushed", action: "format", input: { format: "percent" } });
    await bridge.reported;
    expect(shown.asked).toEqual(["perform_pushed"]);
    expect(bridge.reports).toEqual([{ performId: "perform_pushed", report: { status: "done", output: "edited" } }]);

    // A push it cannot read is not answered; the host's own wait reports it.
    bridge.push({ performId: "perform_bad", action: "format", input: "nope" });
    bridge.push("nonsense");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.reports).toHaveLength(1);

    stop();
    expect(bridge.listening()).toBe(false);
    remove();
  });

  it("reports a perform that arrives before the frame mounts as not mounted", async () => {
    const bridge = host();
    const stop = answerForwardedPerforms({ instanceId: "wi_not_yet", onPerform: bridge.onPerform, reportPerform: bridge.reportPerform });
    bridge.push({ performId: "perform_early", action: "format", input: {} });
    await bridge.reported;
    expect(bridge.reports).toEqual([
      { performId: "perform_early", report: expect.objectContaining({ status: "refused", by: "page", code: "FRAME_NOT_MOUNTED" }) },
    ]);
    stop();
  });
});
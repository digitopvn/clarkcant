import { describe, expect, it } from "vitest";

import { WIDGET_PERFORM_VERSION, readWidgetPerformRequest, type WidgetPerformReport, type WidgetPerformRequest } from "@clarkcant/contracts";
import type { FramePerformOutcome, FrameSession } from "@clarkcant/widget-host/session";

import { answerWidgetPerform, markFrameDetached, performInMountedFrame, registerMountedFrame } from "../src/frame-performs.ts";

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
  it("says a widget open in its own window is detached, without asking any frame, until it is reattached", async () => {
    const shown = frame({ status: "done", output: "inline" });
    const remove = registerMountedFrame("wi_detached", shown.session);
    const reattach = markFrameDetached("wi_detached");
    expect(await performInMountedFrame(request("wi_detached"))).toMatchObject({
      status: "refused",
      by: "page",
      code: "FRAME_DETACHED",
      message: expect.stringContaining("reattach it to let Clark act on it"),
    });
    expect(shown.asked).toHaveLength(0);
    reattach();
    expect(await performInMountedFrame(request("wi_detached"))).toEqual({ status: "done", output: "inline" });
    remove();
  });
});

describe("answering a widget-perform event", () => {  it("answers a perform that reached a page whose session moved on, without asking the frame", async () => {
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

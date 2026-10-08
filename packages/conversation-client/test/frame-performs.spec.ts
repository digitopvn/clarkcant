import { describe, expect, it } from "vitest";

import {
  DETACHED_PERFORM_REPORT_MAX_BYTES,
  WIDGET_PERFORM_VERSION,
  readWidgetPerformRequest,
  widgetPerformReportSchema,
  type WidgetPerformReport,
  type WidgetPerformRequest,
} from "@clarkcant/contracts";
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
  function host(answer: (call: number) => unknown = () => ({ ok: true })) {
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
      reportPerform: async (report: { performId: string; report: WidgetPerformReport }) => {
        reports.push(report);
        settle();
        return answer(reports.length);
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

  const reportBytes = (answer: { performId: string; report: WidgetPerformReport }) => new TextEncoder().encode(JSON.stringify(answer)).length;
  const until = async (done: () => boolean) => {
    for (let attempt = 0; attempt < 50 && !done(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it("cuts a long non-ASCII answer on a character boundary so the whole report fits what the host takes", async () => {
    const answers = {
      vietnamese: "ộ".repeat(4_000),
      // 2,000 emoji alone encode to 8,000 bytes and fit; after Vietnamese text the cut lands among surrogate pairs.
      emoji: `${"ộ".repeat(1_500)}${"😀".repeat(1_250)}`,
      control: "\u0001".repeat(4_000),
      mixed: `a${"👍🏽ữ".repeat(1_000)}`.slice(0, 4_000),
    };
    for (const [name, output] of Object.entries(answers)) {
      expect(widgetPerformReportSchema.safeParse({ status: "done", output }).success).toBe(true);
      const instanceId = `wi_long_${name}`;
      const remove = registerMountedFrame(instanceId, frame({ status: "done", output }).session);
      const bridge = host();
      const stop = answerForwardedPerforms({ instanceId, onPerform: bridge.onPerform, reportPerform: bridge.reportPerform });
      bridge.push({ performId: "perform_long", action: "format", input: {} });
      await bridge.reported;
      stop();
      remove();
      const sent = bridge.reports[0];
      if (sent === undefined || sent.report.status !== "done") throw new Error(`${name}: no done report`);
      const kept = sent.report.output ?? "";
      expect(reportBytes(sent), name).toBeLessThanOrEqual(DETACHED_PERFORM_REPORT_MAX_BYTES);
      // As much as fits: one more character would not.
      expect(reportBytes(sent), name).toBeGreaterThan(DETACHED_PERFORM_REPORT_MAX_BYTES - 16);
      expect(output.startsWith(kept), name).toBe(true);
      // Never half a surrogate pair: the cut ends on a whole character, so it encodes back to exactly what was kept.
      expect(/[\uD800-\uDBFF]$/.test(kept), name).toBe(false);
      expect(new TextDecoder().decode(new TextEncoder().encode(kept)), name).toBe(kept);
      expect(widgetPerformReportSchema.safeParse(sent.report).success, name).toBe(true);
    }
  });

  it("leaves an answer that fits as the frame gave it", async () => {
    const output = "ộ".repeat(1_000);
    const remove = registerMountedFrame("wi_short", frame({ status: "done", output }).session);
    const bridge = host();
    const stop = answerForwardedPerforms({ instanceId: "wi_short", onPerform: bridge.onPerform, reportPerform: bridge.reportPerform });
    bridge.push({ performId: "perform_short", action: "format", input: {} });
    await bridge.reported;
    stop();
    remove();
    expect(bridge.reports).toEqual([{ performId: "perform_short", report: { status: "done", output } }]);
  });

  it("tells the host the answer could not be passed on when it refuses the report, rather than leaving it to time out", async () => {
    for (const refusal of [
      () => ({ ok: false, code: "RELAY_REFUSED", refused: "a perform report is limited to 8192 bytes" }),
      () => {
        throw new Error("the IPC call failed");
      },
    ]) {
      const remove = registerMountedFrame("wi_refused_report", frame({ status: "done", output: "edited" }).session);
      const bridge = host((call) => (call === 1 ? refusal() : { ok: true }));
      const stop = answerForwardedPerforms({ instanceId: "wi_refused_report", onPerform: bridge.onPerform, reportPerform: bridge.reportPerform });
      bridge.push({ performId: "perform_refused", action: "format", input: {} });
      await until(() => bridge.reports.length >= 2);
      stop();
      remove();
      expect(bridge.reports).toEqual([
        { performId: "perform_refused", report: { status: "done", output: "edited" } },
        { performId: "perform_refused", report: { status: "no-answer", message: expect.stringContaining("could not be passed on") } },
      ]);
    }
  });

  it("does not report again when the host is no longer waiting on the perform", async () => {
    const remove = registerMountedFrame("wi_late", frame({ status: "done" }).session);
    const bridge = host(() => ({ ok: false, code: "PERFORM_NOT_EXPECTED", refused: "the host is not waiting on a report for that perform" }));
    const stop = answerForwardedPerforms({ instanceId: "wi_late", onPerform: bridge.onPerform, reportPerform: bridge.reportPerform });
    bridge.push({ performId: "perform_late", action: "format", input: {} });
    await bridge.reported;
    await until(() => bridge.reports.length >= 2);
    stop();
    remove();
    expect(bridge.reports).toHaveLength(1);
  });
});

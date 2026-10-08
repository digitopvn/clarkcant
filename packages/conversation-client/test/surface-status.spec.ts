import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CONNECTION_PHASE, SURFACE_PHASE_MARK, SURFACE_PHASES, TASK_OVERVIEW_PHASE } from "@clarkcant/contracts";

import {
  ConnectionCardBlock,
  ControlSessionCardBlock,
  ReconnectCardBlock,
  TaskOverviewCardBlock,
  TaskProgressCardBlock,
  TaskSummaryCardBlock,
} from "../src/blocks.tsx";
import { LocaleProvider } from "../src/i18n/locale-context.tsx";
import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import type { LocaleChoice } from "../src/i18n/locale.ts";
import { CATALOG } from "../src/renderers.tsx";
import { CARDS_CSS } from "../src/styles/cards.ts";
import { LiveNote, PhaseBadge, nextLivePlacement, phaseOf } from "../src/surface-status.tsx";
import { findAll, textOf } from "./block-helpers.ts";

/**
 * The shared status contract, as the host cards draw it: one tone and mark per phase, words in the reader's language,
 * a live region that announces a change once and never what was already there, and no failure drawn as a success.
 */

const en = (key: MessageKey): string => MESSAGES_EN[key];

function inLocale(locale: LocaleChoice, element: ReactElement): string {
  const t = (key: MessageKey): string => (locale === "en" ? MESSAGES_EN : MESSAGES_VI)[key];
  return renderToStaticMarkup(
    createElement(LocaleProvider, { value: { locale, t, setLocale: () => {} }, children: element }),
  );
}

const SUMMARY = {
  type: "task-summary-card",
  owner: "host",
  cardId: "c1",
  taskId: "task_1",
  goal: "sửa lỗi đăng nhập",
  outcome: "succeeded",
  evidence: "verified",
  durationMs: 4_000,
  changes: [],
  summary: "Đã sửa.",
};

const PROGRESS = {
  type: "task-progress-card",
  owner: "host",
  cardId: "c2",
  taskId: "task_1",
  goal: "sửa lỗi",
  status: "working",
  steps: [],
  startedAt: "2026-10-08T09:00:00.000Z",
  updatedAt: "2026-10-08T09:00:00.000Z",
  cancellable: true,
};

describe("where a live note is placed", () => {
  it("places what a note mounted with outside every live region, so a reload announces nothing", () => {
    // A reload, a scroll back or another tab mounts the card with its outcome already there.
    for (const phase of ["error", "success", "cancelled", "pending", undefined] as const) {
      expect(nextLivePlacement(undefined, phase).politeness).toBe("off");
    }
  });

  it("announces a change of phase once: an error interrupts, anything else waits", () => {
    const mounted = nextLivePlacement(undefined, undefined);
    const pending = nextLivePlacement(mounted, "pending");
    expect(pending.politeness).toBe("polite");
    expect(nextLivePlacement(pending, "error").politeness).toBe("assertive");
    expect(nextLivePlacement(pending, "cancelled").politeness).toBe("polite");
  });

  it("keeps the same placement when a re-render repeats the phase, so nothing is read twice", () => {
    const pending = nextLivePlacement(nextLivePlacement(undefined, undefined), "pending");
    expect(nextLivePlacement(pending, "pending")).toBe(pending);
  });

  it("renders both regions empty at mount and keeps the restored note outside them", () => {
    const html = renderToStaticMarkup(createElement(LiveNote, { phase: "error", children: "Không dừng được." }));
    expect(html).toContain('data-surface-live="off"');
    expect(html).toContain('<div role="status" aria-live="polite" aria-atomic="true"></div>');
    expect(html).toContain('<div role="alert" aria-live="assertive" aria-atomic="true"></div>');
    expect(html).toContain("Không dừng được.");
  });
});

describe("a phase badge", () => {
  it("draws a phase with its tone and its words, and leaves the badge's text exactly its words", () => {
    const html = renderToStaticMarkup(createElement(PhaseBadge, { phase: "partial", children: "chưa xác minh" }));
    expect(html).toBe('<span class="cc-badge" data-tone="warn" data-surface-phase="partial">chưa xác minh</span>');
  });

  it("gives every phase a mark in the stylesheet, with an empty alternative so it is not read aloud", () => {
    for (const phase of SURFACE_PHASES) {
      const rule = `.cc-badge[data-surface-phase="${phase}"]::before { content: "${SURFACE_PHASE_MARK[phase]} "; content: "${SURFACE_PHASE_MARK[phase]} " / ""; }`;
      expect(CARDS_CSS).toContain(rule);
    }
  });

  it("draws a state this build does not know plain, without a guessed tone or mark", () => {
    expect(phaseOf(CONNECTION_PHASE, "quantum_entangled")).toBeUndefined();
    // Inherited names are not states either.
    expect(phaseOf(TASK_OVERVIEW_PHASE, "toString")).toBeUndefined();
    const html = renderToStaticMarkup(createElement(PhaseBadge, { phase: undefined, children: "quantum_entangled" }));
    expect(html).toContain('data-surface-phase="unknown"');
    expect(html).toContain('data-tone=""');

  });
});

describe("a task summary never shows a failure as a success", () => {
  it("draws a run that says it succeeded against contradicting evidence as an error, and says why", () => {
    const card = TaskSummaryCardBlock({ block: { ...SUMMARY, evidence: "contradicted" }, t: en, locale: "en" });
    const html = renderToStaticMarkup(card as ReactElement);
    expect((card?.props as Record<string, unknown>)["data-surface-phase"]).toBe("error");
    expect(html).toContain('data-tone="danger" data-surface-phase="error"');
    expect(html).not.toContain('data-tone="ok" data-surface-phase');
    expect(html).toContain(MESSAGES_EN["blocks.taskSummary.contradicted"]);
  });

  it("draws a success without verified evidence as partial, in Vietnamese by default", () => {
    const card = TaskSummaryCardBlock({ block: { ...SUMMARY, evidence: "not-verified" } });
    expect((card?.props as Record<string, unknown>)["data-surface-phase"]).toBe("partial");
    expect(textOf(card)).toContain(MESSAGES_VI["blocks.taskSummary.unverified"]);
  });

  it("draws a verified success as a success, with no warning line", () => {
    const card = TaskSummaryCardBlock({ block: SUMMARY });
    expect((card?.props as Record<string, unknown>)["data-surface-phase"]).toBe("success");
    expect(findAll(card, "data-task-summary-warning")).toHaveLength(0);
  });

  it("leaves out a duration the node did not report instead of showing zero", () => {
    const { durationMs: _omitted, ...withoutDuration } = SUMMARY;
    const missing = renderToStaticMarkup(TaskSummaryCardBlock({ block: withoutDuration, t: en, locale: "en" }) as ReactElement);
    const reported = renderToStaticMarkup(TaskSummaryCardBlock({ block: SUMMARY, t: en, locale: "en" }) as ReactElement);
    expect(missing).not.toMatch(/\b0\s*(?:ms|s)\b/u);
    expect(reported).toMatch(/\b4\s*s/u);
  });
});

describe("a task overview", () => {
  it("says there are no tasks yet instead of saying none is running", () => {
    const vi = TaskOverviewCardBlock({ block: { type: "task-overview-card", owner: "host", cardId: "c3", tasks: [] } });
    const english = TaskOverviewCardBlock({ block: { type: "task-overview-card", owner: "host", cardId: "c3", tasks: [] }, t: en });
    expect(textOf(vi)).toContain(MESSAGES_VI["blocks.taskOverview.empty"]);
    expect(textOf(english)).toContain(MESSAGES_EN["blocks.taskOverview.empty"]);
    expect(findAll(vi, "data-unfinished-count")).toHaveLength(0);
  });
});

describe("a connection card", () => {
  const CONNECTION = { type: "connection-card", owner: "host", provider: "GitHub", status: "failed" };

  it("says the status in the reader's language, and draws a failed connection as an error", () => {
    const vi = inLocale("vi", createElement(ConnectionCardBlock, { block: CONNECTION }));
    const english = inLocale("en", createElement(ConnectionCardBlock, { block: CONNECTION }));
    expect(vi).toContain(MESSAGES_VI["blocks.connection.status.failed"]);
    expect(english).toContain(MESSAGES_EN["blocks.connection.status.failed"]);
    expect(english).toContain('data-tone="danger" data-surface-phase="error"');
  });

  it("names the next step for a connection that needs signing in again", () => {
    const html = inLocale("en", createElement(ConnectionCardBlock, { block: { ...CONNECTION, status: "needs_reauth" } }));
    expect(html).toContain('data-connection-next="sign-in"');
    expect(html).toContain(MESSAGES_EN["blocks.connection.next.signIn"]);
    expect(html).toContain('data-surface-phase="needs-action"');
  });

  it("draws a revoked or denied connection as unavailable, not as stopped, and names reconnecting as the next step", () => {
    for (const status of ["revoked", "denied"]) {
      const english = inLocale("en", createElement(ConnectionCardBlock, { block: { ...CONNECTION, status } }));
      const vi = inLocale("vi", createElement(ConnectionCardBlock, { block: { ...CONNECTION, status } }));
      expect(english).toContain('data-tone="warn" data-surface-phase="unavailable"');
      expect(english).toContain('data-connection-next="reconnect"');
      expect(english).toContain(MESSAGES_EN["blocks.connection.next.reconnect"]);
      expect(vi).toContain(MESSAGES_VI["blocks.connection.next.reconnect"]);
      expect(english).not.toContain('data-connection-next="sign-in"');
    }
  });

  it("names no next step where the card has none to offer", () => {
    const html = inLocale("en", createElement(ConnectionCardBlock, { block: { ...CONNECTION, status: "connected" } }));
    expect(html).not.toContain("data-connection-next");
  });

  it("shows a status a newer node sent as it was sent, without claiming how it went", () => {
    const html = inLocale("en", createElement(ConnectionCardBlock, { block: { ...CONNECTION, status: "quantum_entangled" } }));
    expect(html).toContain("quantum_entangled");
    expect(html).toContain('data-surface-phase="unknown"');
  });
});

describe("a reconnect card", () => {
  it("says the status in the reader's language", () => {
    const block = {
      type: "reconnect-card",
      owner: "host",
      nodeId: "node_abc",
      nodeLabel: "dev",
      status: "failed",
      attempt: 9,
      lastSeenAt: "2026-10-08T09:00:00.000Z",
    };
    expect(textOf(ReconnectCardBlock({ block, t: en }))).toContain(MESSAGES_EN["blocks.reconnect.status.failed"]);
    expect(textOf(ReconnectCardBlock({ block }))).toContain(MESSAGES_VI["blocks.reconnect.status.failed"]);
  });
});

describe("what a press answered is said in a live region", () => {
  it("puts a refused stop and a confirmed stop in live notes, and nothing yet before a press", () => {
    const idle = TaskProgressCardBlock({ block: PROGRESS, actions: { onTaskStop: () => {} } });
    const failed = TaskProgressCardBlock({
      block: PROGRESS,
      actions: { onTaskStop: () => {}, taskStop: { task_1: { status: "failed", message: "Không gửi được." } } },
    });
    const [pending] = findAll(idle, "data-task-stop-pending");
    expect(pending?.props.phase).toBeUndefined();
    const [error] = findAll(failed, "data-task-stop-error");
    expect(error?.props.phase).toBe("error");
  });

  it("puts a session's refused takeover in a live note and keeps a stop that was already there quiet at mount", () => {
    const session = {
      type: "browser-session-card",
      owner: "host",
      cardId: "c4",
      sessionId: "cs_1",
      label: "đang mở form",
      driver: "agent",
      status: "stopped",
      leaseEpoch: 0,
      updatedAt: "2026-10-08T09:00:00.000Z",
    };
    const stopped = renderToStaticMarkup(ControlSessionCardBlock({ block: session }) as ReactElement);
    // On the card, outside both regions: a reload shows the stop and does not announce it.
    expect(stopped).toMatch(/data-surface-live="off"[^]*data-control-notice="stopped"/u);
    expect(stopped).not.toMatch(/role="status"[^>]*>[^<]*<p[^>]*data-control-notice/u);
  });
});

describe("a metric the host could not compute", () => {
  it("is shown as a dash for the eye and said as unknown, never as zero", () => {
    const Metrics = CATALOG["canvas.metrics@1"]!;
    const html = inLocale(
      "en",
      createElement(Metrics, {
        definitionId: "canvas.metrics@1",
        props: { title: "Usage" },
        dataset: { rows: [{ id: "tokens", label: "Tokens" }], freshness: "live", updatedAt: "2026-10-08T09:00:00.000Z" },
      }),
    );
    expect(html).toContain('data-metric-unknown="true"');
    expect(html).toContain('<span aria-hidden="true">—</span>');
    expect(html).toContain(`<span class="cc-sr-only">${MESSAGES_EN["widgets.metrics.unknown"]}</span>`);
    expect(html).not.toMatch(/cc-metric-value">0/u);
  });
});
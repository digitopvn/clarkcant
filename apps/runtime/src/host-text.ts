import { type AppIntentLocale, nowInstant } from "@clarkcant/contracts";
import type { Database } from "@clarkcant/storage";

import { preferredAppIntentLocale } from "./app-intents.ts";

/**
 * The words this node writes into a conversation itself, in the person's interface language.
 *
 * Host-written means composed by the node from its own records: a receipt, a report on background work, the labels of
 * a composed surface. The client cannot translate any of it, because it arrives as content rather than as catalog keys,
 * so the language is chosen here, when it is written, from the same `experience.language` preference the intent
 * read-backs use. Vietnamese is the default for a caller that names no language, as it is for `describeAppIntent`.
 *
 * What the model is told (prompts, notes for a turn, tool results) is not here: that is the model's input, not text a
 * person reads.
 */
export interface HostText {
  /** The labels and sentences of a composed surface over this node's own records. */
  miniApp: {
    metrics: Record<"completed" | "pending" | "failed" | "created", { label: string; hint: string }>;
    outcomes: { completed: string; failed: string; cancelled: string };
    definitions: { completedAt: string; pending: string };
    /** The text of the regions a template fixes, by slot. */
    fixed: { metricsTitle: string; imageTitle: string; ctaLabel: string; ctaDescription: string };
    slotTitle: { trend: string; table: string; other: string };
    describeMetrics: (summary: string) => string;
    describeTrend: (total: number) => string;
    describeCalendar: (events: number) => string;
    describeImage: (alt: string) => string;
    templateTitle: { overview: string; focused: string; agenda: string };
    templateSummary: (title: string, completed: number, pending: number) => string;
    agendaSummary: (events: number) => string;
    layoutTitle: string;
    bindings: { periodChange: string; dateSelect: string; viewSave: string; stateEvent: string };
  };
  /** Background requests: what the conversation and the inbox are told as one runs, ends or is refused. */
  background: {
    noModel: string;
    untitled: string;
    dequeued: (title: string) => string;
    doneNotice: (title: string) => string;
    stoppedNotice: (title: string) => string;
    failedNotice: (title: string) => string;
    stoppedReply: (title: string) => string;
    failedReply: (reason: string) => string;
    failed: (reason: string) => string;
    deadline: (limit: string) => string;
    closing: string;
    queueFull: (running: number, queued: number) => string;
    alsoRunning: (refusal: string, running: string) => string;
    retrying: (title: string) => string;
    retryMissing: string;
    retryNotRetryable: string;
    retryAlreadyDone: string;
    retryConversationGone: string;
    rebootRerun: (title: string, queued: boolean) => string;
    rebootLost: (title: string, queued: boolean) => string;
  };
  /** A duration as the conversation says it: seconds under a minute, so a short limit never reads "0 minutes". */
  duration: (ms: number) => string;
  /** Receipts for decisions and for tasks. */
  tasks: {
    refusedTilePolicy: string;
    refusedCapability: string;
    refusedCommand: string;
    /** `markers` is the project's markers already joined, or empty. */
    projectSessionOpened: (project: string, relPath: string, kind: string, markers: string) => string;
    stopped: (taskId: string) => string;
    stopRequested: (taskId: string) => string;
    approvalExpired: string;
    approvalDenied: string;
    approvalRerunning: string;
    approvalNotRerun: string;
    settled: (outcome: "succeeded" | "failed" | "cancelled" | "uncertain", taskId: string, message: string) => string;
    waitingApproval: (taskId: string, message: string) => string;
    worktreeKept: (taskId: string, places: readonly { path: string; branch: string }[]) => string;
    worktreeKeptNoticeTitle: string;
    worktreeKeptNoticeBody: (taskId: string) => string;
    capabilityReady: (capabilityRef: string, taskId: string, executionNodeId: string) => string;
    effectRecorded: (taskId: string, quoted: string, landed: boolean, remaining: number, runGoing: boolean) => string;
    commandInterrupted: (title: string, reaped: boolean) => string;
    taskInterrupted: (goal: string) => string;
  };
  /** Automations: what the conversation and the inbox are told when one fires, waits or is refused. */
  automation: {
    anySignal: string;
    timer: string;
    signal: (topic: string, what: string, where: string | undefined) => string;
    refused: (summary: string, because: string, refusal: string) => string;
    refusedTitle: string;
    notStartedTitle: string;
    notStarted: (summary: string | undefined, because: string, reason: string) => string;
    remind: (summary: string, message: string) => string;
    parked: (summary: string, because: string, reason: string, taskId: string) => string;
    parkedTitle: string;
    started: (summary: string, because: string, taskId: string, executionNodeId: string) => string;
    deadSignalTitle: string;
    deadSignal: (topic: string, error: string) => string;
  };
}

const VI: HostText = {
  miniApp: {
    metrics: {
      completed: { label: "Hoàn thành", hint: "state = succeeded, tính theo updated_at trong kỳ" },
      pending: { label: "Đang mở", hint: "mọi trạng thái chưa kết thúc" },
      failed: { label: "Thất bại", hint: "state = failed trong kỳ" },
      created: { label: "Tạo mới", hint: "created_at trong kỳ" },
    },
    outcomes: { completed: "Hoàn thành", failed: "Thất bại", cancelled: "Đã huỷ" },
    definitions: {
      completedAt: "updated_at của task ở trạng thái succeeded (không có cột completed_at)",
      pending: "state không thuộc {succeeded, failed, cancelled}",
    },
    fixed: {
      metricsTitle: "Chỉ số",
      imageTitle: "Hình ảnh đã nhập",
      ctaLabel: "Lưu bản xem",
      ctaDescription: "Lưu khoảng thời gian đang xem và ghim lại.",
    },
    slotTitle: { trend: "Xu hướng theo ngày", table: "Bảng số liệu", other: "Dữ liệu" },
    describeMetrics: (summary) => `Chỉ số: ${summary}.`,
    describeTrend: (total) => `Xu hướng theo ngày, tổng ${total} task hoàn thành trong kỳ.`,
    describeCalendar: (events) => `Lịch có ${events} sự kiện trong kỳ.`,
    describeImage: (alt) => `Hình ảnh đã nhập: ${alt}`,
    templateTitle: { overview: "Tổng quan", focused: "Xu hướng", agenda: "Lịch" },
    templateSummary: (title, completed, pending) => `${title}: ${completed} task hoàn thành, ${pending} đang mở trong kỳ.`,
    agendaSummary: (events) => `Lịch tháng này có ${events} sự kiện đã nhập.`,
    layoutTitle: "Bảng điều khiển",
    bindings: {
      periodChange: "Đổi khoảng thời gian",
      dateSelect: "Chọn ngày",
      viewSave: "Lưu bản xem",
      stateEvent: "Cập nhật trạng thái bề mặt",
    },
  },
  background: {
    noModel: "node này không có model để chạy việc nền",
    untitled: "Việc nền",
    dequeued: (title) => `Đã bỏ việc nền “${title}” khỏi hàng chờ trước khi nó bắt đầu; không có gì được chạy.`,
    doneNotice: (title) => `Việc nền đã xong: ${title}`,
    stoppedNotice: (title) => `Việc nền đã dừng: ${title}`,
    failedNotice: (title) => `Việc nền không xong: ${title}`,
    stoppedReply: (title) => `Đã dừng việc nền “${title}” theo yêu cầu. Kết quả dở dang không được giữ lại.`,
    failedReply: (reason) => `Việc nền không xong: ${reason}. Bạn có thể yêu cầu lại, hoặc chia nhỏ việc này.`,
    failed: (reason) => `Việc nền không xong: ${reason}`,
    deadline: (limit) => `việc nền chạy quá ${limit} nên đã bị dừng`,
    closing: "Node đang tắt nên việc này chưa được bắt đầu. Nhắn lại sau khi node chạy lại.",
    queueFull: (running, queued) =>
      `Node đang bận: ${String(running)} việc nền đang chạy và ${String(queued)} việc đang chờ, là mức tối đa. Việc này chưa được bắt đầu; hãy dừng bớt một việc hoặc thử lại sau.`,
    alsoRunning: (refusal, running) => `${refusal} Đang chạy: ${running}.`,
    retrying: (title) => `Đang chạy lại việc nền “${title}”; kết quả sẽ báo ở đây.`,
    retryMissing: "Không còn bản ghi của việc này trên node, nên không chạy lại được.",
    retryNotRetryable: "Chỉ chạy lại được việc nền đã dừng hoặc không xong; việc này đã xong, còn đang chạy, hoặc không phải việc nền.",
    retryAlreadyDone: "Việc này đã được chạy lại rồi.",
    retryConversationGone: "Hội thoại của việc này đã bị xoá, nên không chạy lại được.",
    rebootRerun: (title, queued) =>
      `Node vừa khởi động lại khi việc nền “${title}” ${queued ? "đang chờ đến lượt" : "đang chạy"}. Việc này chỉ đọc, không thay đổi gì bên ngoài, nên tui đang chạy lại nó một lần; kết quả sẽ báo ở đây.`,
    rebootLost: (title, queued) =>
      `Node đã khởi động lại khi việc nền “${title}” ${queued ? "đang chờ đến lượt" : "đang chạy"}, nên việc đó chưa xong và chưa có kết quả. Nhắn lại nếu bạn vẫn cần, tui sẽ chạy lại.`,
  },
  duration: (ms) => (ms < 60_000 ? `${String(Math.max(1, Math.round(ms / 1_000)))} giây` : `${String(Math.round(ms / 60_000))} phút`),
  tasks: {
    refusedTilePolicy: "Đã từ chối đổi chính sách ô bản đồ. Không có gì thay đổi.",
    refusedCapability: "Đã từ chối gọi capability đó. Không có gì được chạy.",
    refusedCommand: "Đã từ chối chạy lệnh đó. Không có gì được chạy.",
    projectSessionOpened: (project, relPath, kind, markers) =>
      `Đã mở phiên làm việc trong ${project} (${relPath}). ` +
      `Thư mục đã chọn: ${project} (${kind}${markers === "" ? "" : `, dấu hiệu: ${markers}`}). ` +
      "Nếu không phải, nói \"không phải, dùng dự án X\".",
    stopped: (taskId) => `Đã dừng task ${taskId}. Không có việc nào đang chạy nên không còn gì đang chờ.`,
    stopRequested: (taskId) =>
      `Đã ghi nhận yêu cầu dừng task ${taskId}. Việc đang chạy vẫn có thể đang hoàn tất, nên task chưa được coi là đã dừng cho tới khi nơi chạy xác nhận.`,
    approvalExpired: "Yêu cầu duyệt đã hết hạn trước khi được quyết định, nên việc này đã dừng và không chạy gì. Bạn có thể yêu cầu lại.",
    approvalDenied: "Đã từ chối. Việc này đã dừng và không chạy gì.",
    approvalRerunning: "Đã duyệt. Việc này đang được chạy lại với quyền vừa cấp.",
    approvalNotRerun:
      "Đã duyệt, nhưng node chưa nhận chạy lại việc này (đang tắt, hàng đợi đã đầy, hoặc việc chưa được gán nơi chạy), nên chưa có gì được chạy. Bạn có thể yêu cầu lại.",
    settled: (outcome, taskId, message) => {
      const label = { succeeded: "Xong", failed: "Không xong", cancelled: "Đã hủy", uncertain: "Chưa rõ kết quả" }[outcome];
      return `${label} (task ${taskId}): ${message}`;
    },
    waitingApproval: (taskId, message) => `Đang chờ bạn duyệt (task ${taskId}): ${message}`,
    worktreeKept: (taskId, places) =>
      `Task ${taskId} để lại thay đổi chưa commit, nên chúng được giữ nguyên ở ${places.map((place) => `${place.path} (nhánh ${place.branch})`).join(", ")}.`,
    worktreeKeptNoticeTitle: "Worktree còn thay đổi chưa commit",
    worktreeKeptNoticeBody: (taskId) =>
      `Task ${taskId} đã kết thúc nhưng để lại thay đổi chưa commit. Clark giữ nguyên, không xoá gì; vị trí có trong cuộc trò chuyện.`,
    capabilityReady: (capabilityRef, taskId, executionNodeId) =>
      `${capabilityRef} đã dùng được, nên task ${taskId} đang chờ nó giờ chạy tiếp trên ${executionNodeId}.`,
    effectRecorded: (taskId, quoted, landed, remaining, runGoing) => {
      const next =
        remaining > 0
          ? `Còn ${String(remaining)} thao tác khác của việc này chưa rõ kết quả.`
          : runGoing
            ? "Việc vẫn đang chạy; sẽ báo kết quả khi nó xong."
            : "Việc vẫn giữ ở trạng thái hiện tại.";
      return `Đã ghi nhận (task ${taskId}): ${quoted} ${landed ? "đã có hiệu lực" : "chưa có hiệu lực"}. ${next}`;
    },
    commandInterrupted: (title, reaped) =>
      `Lệnh “${title}” đang chạy thì node khởi động lại${reaped ? "; tiến trình còn sót của nó đã được dừng" : ""}. Kết quả của lệnh chưa được kiểm chứng — hãy kiểm tra trạng thái trước khi chạy lại, vì lệnh có thể đã làm một phần việc.`,
    taskInterrupted: (goal) =>
      `Task “${goal}” đang chạy thì node khởi động lại, nên kết quả của nó chưa rõ. Tui đã ghi task là “chưa rõ kết quả” và sẽ không tự chạy lại; hãy kiểm tra hoặc yêu cầu đối chiếu trước khi chạy tiếp.`,
  },
  automation: {
    anySignal: "một tín hiệu",
    timer: "đến giờ đã hẹn",
    signal: (topic, what, where) => `${topic}${what}${where === undefined ? "" : ` ở ${where}`}`,
    refused: (summary, because, refusal) => `Việc tự động "${summary}" không chạy cho ${because}: ${refusal}.`,
    refusedTitle: "Việc tự động bị từ chối",
    notStartedTitle: "Việc tự động không bắt đầu được",
    notStarted: (summary, because, reason) =>
      summary === undefined
        ? `Lần chạy cho ${because} không bắt đầu được: ${reason}. Lần này sẽ không chạy lại.`
        : `"${summary}" không bắt đầu được cho ${because}: ${reason}. Lần này sẽ không chạy lại; bản thân việc tự động vẫn được giữ nguyên.`,
    remind: (summary, message) => `Nhắc bạn — ${summary}: ${message}`,
    parked: (summary, because, reason, taskId) =>
      `Việc tự động "${summary}" đã khớp ${because}, nhưng đang chờ: ${reason}. Task ${taskId} sẽ tiếp tục khi có thứ chạy được nó.`,
    parkedTitle: "Việc tự động đang chờ",
    started: (summary, because, taskId, executionNodeId) =>
      `Việc tự động "${summary}" bắt đầu vì ${because}: task ${taskId} đang chạy trên ${executionNodeId}.`,
    deadSignalTitle: "Một tín hiệu không xử lý được",
    deadSignal: (topic, error) => `${topic}: ${error}. Đã thử lại nhiều lần; tín hiệu được giữ lại nhưng không chạy gì.`,
  },
};

const EN: HostText = {
  miniApp: {
    metrics: {
      completed: { label: "Completed", hint: "state = succeeded, counted by updated_at in the period" },
      pending: { label: "Open", hint: "every state that has not ended" },
      failed: { label: "Failed", hint: "state = failed in the period" },
      created: { label: "Created", hint: "created_at in the period" },
    },
    outcomes: { completed: "Completed", failed: "Failed", cancelled: "Cancelled" },
    definitions: {
      completedAt: "updated_at of a task in the succeeded state (there is no completed_at column)",
      pending: "state not in {succeeded, failed, cancelled}",
    },
    fixed: {
      metricsTitle: "Metrics",
      imageTitle: "Imported picture",
      ctaLabel: "Save this view",
      ctaDescription: "Save the period on screen and pin it.",
    },
    slotTitle: { trend: "Daily trend", table: "Figures", other: "Data" },
    describeMetrics: (summary) => `Metrics: ${summary}.`,
    describeTrend: (total) => `Daily trend, ${total} tasks completed in the period.`,
    describeCalendar: (events) => `The calendar has ${events} ${events === 1 ? "event" : "events"} in the period.`,
    describeImage: (alt) => `Imported picture: ${alt}`,
    templateTitle: { overview: "Overview", focused: "Trend", agenda: "Calendar" },
    templateSummary: (title, completed, pending) => `${title}: ${completed} tasks completed, ${pending} open in the period.`,
    agendaSummary: (events) => `This month's calendar has ${events} imported ${events === 1 ? "event" : "events"}.`,
    layoutTitle: "Dashboard",
    bindings: {
      periodChange: "Change the period",
      dateSelect: "Pick a day",
      viewSave: "Save this view",
      stateEvent: "Update the surface's state",
    },
  },
  background: {
    noModel: "this node has no model to run background work",
    untitled: "Background work",
    dequeued: (title) => `Took the background request “${title}” off the queue before it started; nothing ran.`,
    doneNotice: (title) => `Background work done: ${title}`,
    stoppedNotice: (title) => `Background work stopped: ${title}`,
    failedNotice: (title) => `Background work did not finish: ${title}`,
    stoppedReply: (title) => `Stopped the background request “${title}” as asked. The partial result was not kept.`,
    failedReply: (reason) => `The background request did not finish: ${reason}. You can ask again, or split it into smaller pieces.`,
    failed: (reason) => `The background request did not finish: ${reason}`,
    deadline: (limit) => `it ran for more than ${limit}, so it was stopped`,
    closing: "The node is shutting down, so this was not started. Send it again once the node is back.",
    queueFull: (running, queued) =>
      `The node is busy: ${String(running)} background ${running === 1 ? "request is" : "requests are"} running and ${String(queued)} waiting, which is the limit. This one was not started; stop one of them or try again later.`,
    alsoRunning: (refusal, running) => `${refusal} Running: ${running}.`,
    retrying: (title) => `Running the background request “${title}” again; the result will be reported here.`,
    retryMissing: "This node no longer has a record of that work, so it cannot run it again.",
    retryNotRetryable:
      "Only background work that was stopped or did not finish can run again; this one finished, is still running, or is not background work.",
    retryAlreadyDone: "This has already been run again.",
    retryConversationGone: "The conversation this work belonged to was deleted, so it cannot run again.",
    rebootRerun: (title, queued) =>
      `The node restarted while the background request “${title}” was ${queued ? "waiting its turn" : "running"}. It only reads and changes nothing outside, so I'm running it once more; the result will be reported here.`,
    rebootLost: (title, queued) =>
      `The node restarted while the background request “${title}” was ${queued ? "waiting its turn" : "running"}, so it did not finish and has no result. Send it again if you still need it and I'll run it.`,
  },
  duration: (ms) => {
    if (ms < 60_000) {
      const seconds = Math.max(1, Math.round(ms / 1_000));
      return `${String(seconds)} ${seconds === 1 ? "second" : "seconds"}`;
    }
    const minutes = Math.round(ms / 60_000);
    return `${String(minutes)} ${minutes === 1 ? "minute" : "minutes"}`;
  },
  tasks: {
    refusedTilePolicy: "Refused the map tile policy change. Nothing changed.",
    refusedCapability: "Refused to call that capability. Nothing ran.",
    refusedCommand: "Refused to run that command. Nothing ran.",
    projectSessionOpened: (project, relPath, kind, markers) =>
      `Opened a work session in ${project} (${relPath}). ` +
      `Folder chosen: ${project} (${kind}${markers === "" ? "" : `, markers: ${markers}`}). ` +
      "If that's the wrong one, say \"not that one, use project X\".",
    stopped: (taskId) => `Stopped task ${taskId}. Nothing was running, so nothing is left waiting.`,
    stopRequested: (taskId) =>
      `Noted the request to stop task ${taskId}. The running work may still be finishing, so the task is not counted as stopped until where it runs confirms it.`,
    approvalExpired: "The approval request expired before anyone decided, so this stopped and nothing ran. You can ask again.",
    approvalDenied: "Denied. This stopped and nothing ran.",
    approvalRerunning: "Approved. This is running again with the permission just granted.",
    approvalNotRerun:
      "Approved, but the node did not take this up again (it is shutting down, the queue is full, or the work has nowhere to run yet), so nothing ran. You can ask again.",
    settled: (outcome, taskId, message) => {
      const label = { succeeded: "Done", failed: "Did not finish", cancelled: "Cancelled", uncertain: "Outcome unknown" }[outcome];
      return `${label} (task ${taskId}): ${message}`;
    },
    waitingApproval: (taskId, message) => `Waiting for your approval (task ${taskId}): ${message}`,
    worktreeKept: (taskId, places) =>
      `Task ${taskId} left uncommitted changes, so they were kept at ${places.map((place) => `${place.path} (branch ${place.branch})`).join(", ")}.`,
    worktreeKeptNoticeTitle: "A worktree still has uncommitted changes",
    worktreeKeptNoticeBody: (taskId) =>
      `Task ${taskId} ended but left uncommitted changes. Clark kept them and deleted nothing; where they are is in the conversation.`,
    capabilityReady: (capabilityRef, taskId, executionNodeId) =>
      `${capabilityRef} is available now, so task ${taskId}, which was waiting for it, carries on on ${executionNodeId}.`,
    effectRecorded: (taskId, quoted, landed, remaining, runGoing) => {
      const next =
        remaining > 0
          ? `${String(remaining)} other ${remaining === 1 ? "action" : "actions"} of this work still ${remaining === 1 ? "has" : "have"} an unknown outcome.`
          : runGoing
            ? "The work is still running; its result will be reported when it finishes."
            : "The work stays as it is.";
      return `Noted (task ${taskId}): ${quoted} ${landed ? "took effect" : "did not take effect"}. ${next}`;
    },
    commandInterrupted: (title, reaped) =>
      `The node restarted while the command “${title}” was running${reaped ? "; its leftover process was stopped" : ""}. Its result is not verified — check the state before running it again, because it may have done part of the work.`,
    taskInterrupted: (goal) =>
      `The node restarted while task “${goal}” was running, so its outcome is unknown. I marked it “outcome unknown” and won't run it again on my own; check, or ask for a reconciliation, before carrying on.`,
  },
  automation: {
    anySignal: "a signal",
    timer: "the scheduled time",
    signal: (topic, what, where) => `${topic}${what}${where === undefined ? "" : ` in ${where}`}`,
    refused: (summary, because, refusal) => `The automation "${summary}" did not run for ${because}: ${refusal}.`,
    refusedTitle: "An automation was refused",
    notStartedTitle: "An automation could not start",
    notStarted: (summary, because, reason) =>
      summary === undefined
        ? `The run for ${because} could not start: ${reason}. It will not be retried.`
        : `"${summary}" could not start for ${because}: ${reason}. This run will not be retried; the automation itself is kept as it is.`,
    remind: (summary, message) => `Reminder — ${summary}: ${message}`,
    parked: (summary, because, reason, taskId) =>
      `The automation "${summary}" matched ${because}, but is waiting: ${reason}. Task ${taskId} carries on once something can run it.`,
    parkedTitle: "An automation is waiting",
    started: (summary, because, taskId, executionNodeId) =>
      `The automation "${summary}" started because of ${because}: task ${taskId} is running on ${executionNodeId}.`,
    deadSignalTitle: "A signal could not be handled",
    deadSignal: (topic, error) => `${topic}: ${error}. Tried several times; the signal is kept, but nothing ran.`,
  },
};

/** The host's words in one language; Vietnamese when none is named. */
export function hostText(locale: AppIntentLocale = "vi"): HostText {
  return locale === "en" ? EN : VI;
}

/**
 * The host's words in the node owner's interface language, read now.
 *
 * For the reports that are not part of anyone's turn — background work, a stopped task, an automation, a restart — the
 * person reading them is the node's owner, and their `experience.language` is read when the line is written, so a
 * report that lands after they switched language reads in the new one.
 */
export function ownerHostText(runtime: { db: Database; identity: { ownerPrincipalId: string } }): HostText {
  return hostText(preferredAppIntentLocale({ db: runtime.db, now: nowInstant }, runtime.identity.ownerPrincipalId));
}

import type { AppIntentLocale, DataClass } from "@clarkcant/contracts";
import { type PolicyRefusal, type SuccessGateReason, type TaskSettleReason, quotedEffectIntent } from "@clarkcant/core";

import { hostText } from "./host-text.ts";
import { dataClassTaskRefusal } from "./send-boundary.ts";

/**
 * Why a dispatched task was refused or ended without an accepted result, when this node's dispatcher decided it.
 *
 * The dispatcher's sentence for a task is written from this in English (`dispatchRefusalMessage`): that is what the task's
 * evidence records and what a peer that handed the task over is sent, both unchanged. The owner of this node is told
 * the same thing in their own language (`taskSettledText`). Text from elsewhere — an error, a lease's own message — is
 * carried as `detail` and quoted, never blended into the sentence.
 */
export type DispatchRefusal =
  | { code: "stopped-before-start" }
  | { code: "capability-busy"; capabilityRef: string; heldUntil?: string; detail?: string }
  | { code: "browser-not-asked" }
  | { code: "browser-no-sites" }
  | { code: "browser-sites-mismatch" }
  | { code: "unscoped-background" }
  | { code: "root-not-owned"; path: string }
  | { code: "data-class"; dataClass: DataClass; model: string; checked: "model" | "every-candidate"; unread: boolean }
  | { code: "no-model" }
  | { code: "model-not-chosen"; detail: string }
  | { code: "model-no-tools"; model: string }
  /** `reason` is the policy's own English sentence, kept for the message a peer is sent. */
  | { code: "policy-denied"; refusal: PolicyRefusal; reason: string }
  | { code: "no-worktree-place" }
  | { code: "worktree-failed"; detail: string }
  | { code: "no-browser" }
  | { code: "browser-policy-unknown" }
  | { code: "wall-clock"; maxMs: number }
  | { code: "stopped-during-run" }
  | { code: "token-budget"; maxTokens: number; used: number }
  | { code: "worker-failed"; detail: string }
  | { code: "shutting-down" }
  | { code: "queue-full"; running: number; waiting: number };

/** Every reason a settled task's host-written message stands for: the conductor's, or this node's dispatcher's. */
export type TaskSettledReason = TaskSettleReason | DispatchRefusal;

/** Text from elsewhere, set apart as a quotation. */
function quoted(text: string): string {
  return `“${text}”`;
}

/**
 * The dispatcher's sentence for a refusal, in English: what the task records and what a peer is sent. Kept word for
 * word as it was before the owner was told it in their own language, so stored records and peers see no change.
 */
export function dispatchRefusalMessage(reason: DispatchRefusal): string {
  const never = "the worker was never started";
  switch (reason.code) {
    case "stopped-before-start":
      return "stopped before a worker was started for it";
    case "capability-busy":
      return `capability ${reason.capabilityRef} is busy on this node (${reason.heldUntil === undefined ? (reason.detail ?? "busy") : `held by another run until ${reason.heldUntil}`}); the task was not run and can be retried`;
    case "browser-not-asked":
      return `refused: a browser task acts only for a person who asked for it in the conversation, and this one was not started that way; ${never}`;
    case "browser-no-sites":
      return `refused: the task carries no checked list of sites, so there is no site it could be allowed onto; ${never}`;
    case "browser-sites-mismatch":
      return `refused: the sites the task was checked for are not the sites its goal names; ${never}`;
    case "unscoped-background":
      return (
        "refused: work nobody asked for in this conversation has to name the folder or repository it may touch, " +
        "and this task named none, so the worker was never started"
      );
    case "root-not-owned":
      return `refused: ${reason.path} is not a root this node owns, so the worker was never started`;
    case "data-class":
      return dataClassTaskRefusal(reason);
    case "no-model":
      return `refused: this node has no model configured to do the work; ${never} and nothing was done`;
    case "model-not-chosen":
      return `refused: the model for it could not be chosen (${reason.detail}); ${never} and nothing was done`;
    case "model-no-tools":
      return `refused: the model this task would run on (${reason.model}) cannot call tools, so it could not use the browser; choose one that can in Settings → AI & Routing; ${never} and nothing was done`;
    case "policy-denied":
      return `refused: ${reason.reason}`;
    case "no-worktree-place":
      return `refused: this node keeps no place for task worktrees, so a repository cannot be worked on; ${never}`;
    case "worktree-failed":
      return `refused: ${reason.detail}; ${never}`;
    case "no-browser":
      return `refused: this node gives no task a browser; ${never}`;
    case "browser-policy-unknown":
      return `refused: the execution policy was never asked about this task, because this node does not know the browser capability; ${never}`;
    case "wall-clock":
      return `the wall-clock budget of ${String(reason.maxMs)} ms was exhausted before the worker finished; nothing it did was verified; raise the task's budget or re-run it`;
    case "stopped-during-run":
      return "stopped on request before the worker finished; nothing it did was verified";
    case "token-budget":
      return `the token budget of ${String(reason.maxTokens)} was exceeded (the worker used ${String(reason.used)}); the run already happened but is not accepted, and can be retried with a higher budget`;
    case "worker-failed":
      return `the worker could not run: ${reason.detail}`;
    case "shutting-down":
      return "this node is shutting down; the task was not run and can be retried once the node is back";
    case "queue-full":
      return `this node already has ${String(reason.running)} task workers running and ${String(reason.waiting)} waiting, which is its limit; the task was not run and can be retried once one finishes`;
  }
}

/** The same refusal, in Vietnamese. Quoted text stays as it was written. */
function dispatchRefusalVi(reason: DispatchRefusal): string {
  const never = "worker chưa hề được khởi động";
  const settings = "Cài đặt → AI & Định tuyến";
  switch (reason.code) {
    case "stopped-before-start":
      return "đã dừng trước khi có worker nào được khởi động cho việc này";
    case "capability-busy":
      return `capability ${reason.capabilityRef} đang bận trên node này (${reason.heldUntil === undefined ? (reason.detail === undefined ? "đang được dùng" : quoted(reason.detail)) : `một lần chạy khác giữ nó tới ${reason.heldUntil}`}); việc chưa được chạy và có thể thử lại`;
    case "browser-not-asked":
      return `đã từ chối: việc dùng trình duyệt chỉ chạy cho người đã yêu cầu nó trong cuộc trò chuyện, mà việc này không được bắt đầu như vậy; ${never}`;
    case "browser-no-sites":
      return `đã từ chối: việc này không mang danh sách trang web đã kiểm tra, nên không có trang nào nó được phép vào; ${never}`;
    case "browser-sites-mismatch":
      return `đã từ chối: các trang web việc này được kiểm tra không phải các trang mục tiêu của nó nêu ra; ${never}`;
    case "unscoped-background":
      return `đã từ chối: việc không ai yêu cầu trong cuộc trò chuyện này phải nêu thư mục hoặc repository nó được động vào, mà việc này không nêu cái nào, nên ${never}`;
    case "root-not-owned":
      return `đã từ chối: ${reason.path} không phải thư mục gốc mà node này quản lý, nên ${never}`;
    case "data-class": {
      const what = reason.unread
        ? reason.checked === "model"
          ? `không đọc được ${reason.model} được phép nhận những dữ liệu nào`
          : "không đọc được các model mà node này có thể dùng cho worker được phép nhận những dữ liệu nào"
        : reason.checked === "model"
          ? `${reason.model} không được nhận dữ liệu ${reason.dataClass}`
          : `${reason.model} không được nhận dữ liệu ${reason.dataClass}, và không model nào node này có thể dùng cho worker được nhận`;
      const next = reason.unread
        ? `hãy chạy lại việc; nếu vẫn lặp lại, kiểm tra hồ sơ của model trong ${settings}`
        : `hãy chọn một model được nhận dữ liệu ${reason.dataClass} (chẳng hạn một model chạy trên máy này), hoặc cho phép ${reason.dataClass} với model đó trong ${settings}, rồi chạy lại việc`;
      return `đã từ chối: việc này mang dữ liệu ${reason.dataClass}, và ${what}; không có gì được gửi tới model và ${never}; ${next}`;
    }
    case "no-model":
      return `đã từ chối: node này chưa cấu hình model nào để làm việc này; ${never} và chưa có gì được làm`;
    case "model-not-chosen":
      return `đã từ chối: không chọn được model cho việc này (${quoted(reason.detail)}); ${never} và chưa có gì được làm`;
    case "model-no-tools":
      return `đã từ chối: model việc này sẽ chạy (${reason.model}) không gọi được công cụ, nên không dùng được trình duyệt; hãy chọn một model gọi được công cụ trong ${settings}; ${never} và chưa có gì được làm`;
    case "policy-denied":
      return `đã từ chối: ${policyRefusalVi(reason.refusal)}`;
    case "no-worktree-place":
      return `đã từ chối: node này không có chỗ cho worktree của việc, nên không thể làm việc trên một repository; ${never}`;
    case "worktree-failed":
      return `đã từ chối: không chuẩn bị được worktree cho việc này (${quoted(reason.detail)}); ${never}`;
    case "no-browser":
      return `đã từ chối: node này không cấp trình duyệt cho việc nào; ${never}`;
    case "browser-policy-unknown":
      return `đã từ chối: chính sách thực thi chưa được hỏi về việc này, vì node này không biết capability trình duyệt; ${never}`;
    case "wall-clock":
      return `đã hết thời gian cho phép (${hostText("vi").duration(reason.maxMs)}) trước khi worker xong; chưa có gì nó làm được xác minh; hãy tăng giới hạn của việc hoặc chạy lại`;
    case "stopped-during-run":
      return "đã dừng theo yêu cầu trước khi worker xong; chưa có gì nó làm được xác minh";
    case "token-budget":
      return `đã vượt giới hạn ${String(reason.maxTokens)} token (worker đã dùng ${String(reason.used)}); lần chạy đã diễn ra nhưng kết quả không được nhận, và có thể chạy lại với giới hạn cao hơn`;
    case "worker-failed":
      return `worker không chạy được: ${quoted(reason.detail)}`;
    case "shutting-down":
      return "node này đang tắt; việc chưa được chạy và có thể thử lại khi node chạy lại";
    case "queue-full":
      return `node này đã có ${String(reason.running)} worker đang chạy và ${String(reason.waiting)} việc đang chờ, là mức tối đa; việc chưa được chạy và có thể thử lại khi có một việc xong`;
  }
}

function policyRefusalVi(refusal: PolicyRefusal): string {
  switch (refusal.code) {
    case "prohibited":
      return "node này chặn mọi thao tác có tác động, nên không loại nào được miễn";
    case "rule":
      return `một quy tắc trên máy này chặn ${hostText("vi").approvals.categoryEffect(refusal.category)}`;
    case "unknown-mode":
      return `chế độ thực thi ${quoted(refusal.mode)} không phải chế độ mà bản này biết`;
  }
}

/** Why the success gate refused, in the owner's language. */
function gateText(gate: SuccessGateReason, locale: AppIntentLocale): string {
  if (locale === "en") {
    switch (gate.kind) {
      case "no-evidence":
        return "no evidence recorded; a finished run is not by itself a successful outcome";
      case "nothing-verified":
        return "evidence was recorded but nothing was verified; the result must be reported as not-verified rather than as success";
      case "contradicted":
        return `evidence contradicts the expected outcome: ${quoted(gate.summary)}`;
      case "effect-unsettled":
        return `effect ${gate.effectId} is still ${gate.state}; reconcile it before reporting success`;
    }
  }
  switch (gate.kind) {
    case "no-evidence":
      return "chưa có bằng chứng nào được ghi lại; một lần chạy kết thúc không tự nó là một kết quả thành công";
    case "nothing-verified":
      return "đã có bằng chứng nhưng chưa có gì được xác minh, nên kết quả được báo là chưa xác minh chứ không phải thành công";
    case "contradicted":
      return `bằng chứng trái với kết quả mong đợi: ${quoted(gate.summary)}`;
    case "effect-unsettled":
      return `thao tác ${gate.effectId} vẫn đang ở trạng thái ${gate.state}; cần đối chiếu nó trước khi báo thành công`;
  }
}

/** A conductor reason, in the owner's language. What the run reported is quoted as it was written. */
function settleReasonText(reason: TaskSettleReason, locale: AppIntentLocale): string {
  const en = locale === "en";
  switch (reason.code) {
    case "task-missing":
      return en ? "the task no longer exists" : "việc này không còn tồn tại";
    case "already-ended":
      return en ? "the task had already ended before its run reported" : "việc đã kết thúc trước khi lần chạy của nó báo lại";
    case "no-evidence":
      return en
        ? "the run produced no evidence, so it is reported as failed rather than as success"
        : "lần chạy không tạo ra bằng chứng nào, nên được báo là không xong chứ không phải thành công";
    case "stopped-unreported":
      return en ? "stopped on request; the run reported nothing" : "đã dừng theo yêu cầu; lần chạy không báo lại gì";
    case "finished-after-stop": {
      if (en) {
        const done = reason.runSummary === undefined ? "an effect it started is unsettled" : `it reported ${quoted(reason.runSummary)}`;
        return `the run finished after it was asked to stop (${done}); what it did is not confirmed`;
      }
      const done = reason.runSummary === undefined ? "một thao tác nó bắt đầu vẫn chưa ngã ngũ" : `nó báo ${quoted(reason.runSummary)}`;
      return `lần chạy đã kết thúc sau khi được yêu cầu dừng (${done}); những gì nó làm chưa được xác nhận`;
    }
    case "effect-unsettled":
      return en
        ? `effect ${reason.effectId} is still ${reason.state}; the outcome is undetermined and must be reconciled`
        : `thao tác ${reason.effectId} vẫn đang ở trạng thái ${reason.state}; kết quả chưa xác định và cần được đối chiếu`;
    case "not-accepted": {
      const gate = gateText(reason.gate, locale);
      if (reason.runSummary === undefined) return gate;
      return en ? `the run reported ${quoted(reason.runSummary)} — ${gate}` : `lần chạy báo ${quoted(reason.runSummary)} — ${gate}`;
    }
    case "reconciled":
      return reconciledText(reason, locale);
  }
}

function reconciledText(reason: Extract<TaskSettleReason, { code: "reconciled" }>, locale: AppIntentLocale): string {
  const name = (intent: string): string => quotedEffectIntent({ intent }, locale);
  const landed = reason.landed.map(name).join(", ");
  if (locale === "en") {
    if (reason.stopped) {
      return reason.didNotLand !== undefined
        ? `you confirmed ${name(reason.didNotLand)} did not take effect; the work stays stopped as you asked`
        : `you confirmed ${landed} took effect before it stopped; the work stays stopped as you asked`;
    }
    if (reason.didNotLand !== undefined) return `you confirmed ${name(reason.didNotLand)} did not take effect`;
    return reason.unverified
      ? `you confirmed ${landed} took effect, but the run never verified the result of the work, so it cannot be reported as done`
      : `you confirmed ${landed} took effect`;
  }
  if (reason.stopped) {
    return reason.didNotLand !== undefined
      ? `bạn xác nhận ${name(reason.didNotLand)} chưa có hiệu lực; việc vẫn dừng theo yêu cầu của bạn`
      : `bạn xác nhận ${landed} đã có hiệu lực trước khi dừng; việc vẫn dừng theo yêu cầu của bạn`;
  }
  if (reason.didNotLand !== undefined) return `bạn xác nhận ${name(reason.didNotLand)} chưa có hiệu lực`;
  return reason.unverified
    ? `bạn xác nhận ${landed} đã có hiệu lực, nhưng lần chạy chưa xác minh được kết quả của việc nên chưa thể báo là xong`
    : `bạn xác nhận ${landed} đã có hiệu lực`;
}

function isDispatchRefusal(reason: TaskSettledReason): reason is DispatchRefusal {
  return !SETTLE_REASON_CODES.has(reason.code);
}

const SETTLE_REASON_CODES: ReadonlySet<string> = new Set<TaskSettleReason["code"]>([
  "task-missing",
  "already-ended",
  "no-evidence",
  "stopped-unreported",
  "finished-after-stop",
  "effect-unsettled",
  "not-accepted",
  "reconciled",
]);

/**
 * What a settled task's host-written message says, in the owner's language. Vietnamese when no language is named.
 *
 * Without a reason the message is the run's own words (or a peer's), shown as written; with one, the message is the
 * host's and is worded again here, so a title in the owner's language never sits over a body in another.
 */
export function taskSettledText(input: { message: string; reason?: TaskSettledReason }, locale: AppIntentLocale = "vi"): string {
  const { reason } = input;
  if (reason === undefined) return input.message;
  if (isDispatchRefusal(reason)) return locale === "en" ? dispatchRefusalMessage(reason) : dispatchRefusalVi(reason);
  return settleReasonText(reason, locale);
}

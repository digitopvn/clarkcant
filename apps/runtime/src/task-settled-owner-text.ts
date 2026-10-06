import type { AppIntentLocale } from "@clarkcant/contracts";
import { type PolicyRefusal, type SuccessGateReason, type TaskSettleReason, quotedEffectIntent } from "@clarkcant/core";

import { hostText } from "./host-text.ts";
import { durationWords } from "./run-command.ts";
import type { DispatchRefusal } from "./task-settled-text.ts";

/**
 * How a settled task's host-written reason is worded for this node's owner, in English or Vietnamese.
 *
 * Not the sentence a peer is sent or a task records (`dispatchRefusalMessage`, and the conductor's own message): this is
 * for a person reading their conversation or inbox. Text the node did not write — an error, a lease's message, what a
 * run reported, an effect's intent — is quoted as written; internal codes and raw state names are left out.
 */

/** Text from elsewhere, set apart as a quotation. */
function quoted(text: string): string {
  return `“${text}”`;
}

const SETTINGS = { en: "Settings → AI & Routing", vi: "Cài đặt → AI & Định tuyến" } as const;

/** A dispatcher's refusal, in the owner's language. */
export function dispatchRefusalOwnerText(reason: DispatchRefusal, locale: AppIntentLocale): string {
  return locale === "en" ? dispatchRefusalEn(reason) : dispatchRefusalVi(reason);
}

function dispatchRefusalEn(reason: DispatchRefusal): string {
  const never = "the worker was never started";
  switch (reason.code) {
    case "stopped-before-start":
      return "stopped before a worker was started for it";
    case "capability-busy":
      return `capability ${reason.capabilityRef} is busy on this node (${reason.heldUntil === undefined ? (reason.detail === undefined ? "in use" : quoted(reason.detail)) : `held by another run until ${reason.heldUntil}`}); the task was not run and can be retried`;
    case "browser-not-asked":
      return `refused: a browser task acts only for a person who asked for it in the conversation, and this one was not started that way; ${never}`;
    case "browser-no-sites":
      return `refused: the task carries no checked list of sites, so there is no site it could be allowed onto; ${never}`;
    case "browser-sites-mismatch":
      return `refused: the sites the task was checked for are not the sites its goal names; ${never}`;
    case "unscoped-background":
      return (
        "refused: work nobody asked for in this conversation has to name the folder or repository it may touch, " +
        `and this task named none, so ${never}`
      );
    case "root-not-owned":
      return `refused: ${reason.path} is not a root this node owns, so ${never}`;
    case "data-class": {
      const what = reason.unread
        ? reason.checked === "model"
          ? `what ${reason.model} may receive could not be read`
          : "what the models this node could start its worker on may receive could not be read"
        : reason.checked === "model"
          ? `${reason.model} may not receive ${reason.dataClass} data`
          : `${reason.model} may not receive ${reason.dataClass} data, nor may any model this node could start its worker on`;
      const next = reason.unread
        ? `run the task again; if this keeps happening, check the model's profile in ${SETTINGS.en}`
        : `choose a model that may receive ${reason.dataClass} data (such as one that runs on this machine), or allow ${reason.dataClass} for that model in ${SETTINGS.en}, and run the task again`;
      return `refused: the task carries ${reason.dataClass} data, and ${what}; nothing was sent to a model and ${never}; ${next}`;
    }
    case "no-model":
      return `refused: this node has no model configured to do the work; ${never} and nothing was done`;
    case "model-not-chosen":
      return `refused: the model for it could not be chosen (${quoted(reason.detail)}); ${never} and nothing was done`;
    case "model-no-tools":
      return `refused: the model this task would run on (${reason.model}) cannot call tools, so it could not use the browser; choose one that can in ${SETTINGS.en}; ${never} and nothing was done`;
    case "policy-denied":
      return `refused: ${policyRefusalText(reason.refusal, "en")}`;
    case "no-worktree-place":
      return `refused: this node keeps no place for task worktrees, so a repository cannot be worked on; ${never}`;
    case "worktree-failed":
      return `refused: the task's worktree could not be prepared (${quoted(reason.detail)}); ${never}`;
    case "no-browser":
      return `refused: this node gives no task a browser; ${never}`;
    case "browser-policy-unknown":
      return `refused: the execution policy was never asked about this task, because this node does not know the browser capability; ${never}`;
    case "wall-clock":
      return `the time budget of ${durationWords(reason.maxMs, "en")} ran out before the worker finished; nothing it did was verified; raise the task's budget or run it again`;
    case "stopped-during-run":
      return "stopped on request before the worker finished; nothing it did was verified";
    case "token-budget":
      return `the token budget of ${String(reason.maxTokens)} was exceeded (the worker used ${String(reason.used)}); the run already happened but is not accepted, and can be retried with a higher budget`;
    case "worker-failed":
      return `the worker could not run: ${quoted(reason.detail)}`;
    case "shutting-down":
      return "this node is shutting down; the task was not run and can be retried once the node is back";
    case "queue-full":
      return `this node already has ${String(reason.running)} task workers running and ${String(reason.waiting)} waiting, which is its limit; the task was not run and can be retried once one finishes`;
  }
}

function dispatchRefusalVi(reason: DispatchRefusal): string {
  const never = "worker chưa hề được khởi động";
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
      return `đã từ chối: các trang web đã kiểm tra cho việc này không khớp với các trang mà mục tiêu của nó nêu; ${never}`;
    case "unscoped-background":
      return `đã từ chối: việc không ai yêu cầu trong cuộc trò chuyện này phải nêu thư mục hoặc repository nó được động vào, mà việc này không nêu cái nào, nên ${never}`;
    case "root-not-owned":
      return `đã từ chối: ${reason.path} không phải thư mục gốc mà node này quản lý, nên ${never}`;
    case "data-class": {
      const what = reason.unread
        ? reason.checked === "model"
          ? `không đọc được thông tin model ${reason.model} được phép nhận loại dữ liệu nào`
          : "không đọc được thông tin các model mà node này có thể dùng cho worker được phép nhận loại dữ liệu nào"
        : reason.checked === "model"
          ? `${reason.model} không được nhận dữ liệu ${reason.dataClass}`
          : `${reason.model} không được nhận dữ liệu ${reason.dataClass}, và không model nào node này có thể dùng cho worker được nhận`;
      const next = reason.unread
        ? `hãy chạy lại việc; nếu vẫn lặp lại, kiểm tra hồ sơ của model trong ${SETTINGS.vi}`
        : `hãy chọn một model được nhận dữ liệu ${reason.dataClass} (chẳng hạn một model chạy trên máy này), hoặc cho phép ${reason.dataClass} với model đó trong ${SETTINGS.vi}, rồi chạy lại việc`;
      return `đã từ chối: việc này mang dữ liệu ${reason.dataClass}, và ${what}; không có gì được gửi tới model và ${never}; ${next}`;
    }
    case "no-model":
      return `đã từ chối: node này chưa cấu hình model nào để làm việc này; ${never} và chưa có gì được làm`;
    case "model-not-chosen":
      return `đã từ chối: không chọn được model cho việc này (${quoted(reason.detail)}); ${never} và chưa có gì được làm`;
    case "model-no-tools":
      return `đã từ chối: model việc này sẽ chạy (${reason.model}) không gọi được công cụ, nên không dùng được trình duyệt; hãy chọn một model gọi được công cụ trong ${SETTINGS.vi}; ${never} và chưa có gì được làm`;
    case "policy-denied":
      return `đã từ chối: ${policyRefusalText(reason.refusal, "vi")}`;
    case "no-worktree-place":
      return `đã từ chối: node này không có chỗ cho worktree của việc, nên không thể làm việc trên một repository; ${never}`;
    case "worktree-failed":
      return `đã từ chối: không chuẩn bị được worktree cho việc này (${quoted(reason.detail)}); ${never}`;
    case "no-browser":
      return `đã từ chối: node này không cấp trình duyệt cho việc nào; ${never}`;
    case "browser-policy-unknown":
      return `đã từ chối: chính sách thực thi chưa được hỏi về việc này, vì node này không biết capability trình duyệt; ${never}`;
    case "wall-clock":
      return `đã hết thời gian cho phép (${durationWords(reason.maxMs, "vi")}) trước khi worker xong; chưa có gì nó làm được xác minh; hãy tăng giới hạn của việc hoặc chạy lại`;
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

/** Why the execution policy refused, worded from its code rather than read out of its English sentence. */
function policyRefusalText(refusal: PolicyRefusal, locale: AppIntentLocale): string {
  const en = locale === "en";
  switch (refusal.code) {
    case "prohibited":
      return en
        ? "this node refuses every effect, so no category is exempt"
        : "node này chặn mọi thao tác có tác động, nên không loại nào được miễn";
    case "rule": {
      const action = hostText(locale).approvals.effectCategory[refusal.category];
      return en
        ? `a rule on this machine does not allow anything that would ${action}`
        : `một quy tắc trên máy này không cho phép bất cứ việc nào ${action}`;
    }
    case "unknown-mode":
      return en
        ? `the execution mode ${quoted(refusal.mode)} is not one this build knows`
        : `chế độ thực thi ${quoted(refusal.mode)} không phải chế độ mà bản này biết`;
  }
}

/** Where an effect stands, in words rather than its state name. */
function effectStanding(effectId: string, state: string, locale: AppIntentLocale): string {
  if (locale === "en") {
    switch (state) {
      case "prepared":
        return `action ${effectId} is still being prepared`;
      case "submitted":
        return `action ${effectId} was sent but is not confirmed yet`;
      case "unknown":
        return `action ${effectId} has an unknown outcome`;
      default:
        return `action ${effectId} is still in the state ${quoted(state)}`;
    }
  }
  switch (state) {
    case "prepared":
      return `thao tác ${effectId} vẫn đang được chuẩn bị`;
    case "submitted":
      return `thao tác ${effectId} đã được gửi đi nhưng chưa được xác nhận`;
    case "unknown":
      return `thao tác ${effectId} vẫn chưa rõ kết quả`;
    default:
      return `thao tác ${effectId} vẫn ở trạng thái ${quoted(state)}`;
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
        return `${effectStanding(gate.effectId, gate.state, "en")}; it has to be reconciled before success is reported`;
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
      return `${effectStanding(gate.effectId, gate.state, "vi")}; cần đối chiếu nó trước khi báo thành công`;
  }
}

/** A conductor reason, in the owner's language. What the run reported is quoted as it was written. */
export function settleReasonOwnerText(reason: TaskSettleReason, locale: AppIntentLocale): string {
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
        ? `${effectStanding(reason.effectId, reason.state, "en")}; the outcome is undetermined and must be reconciled`
        : `${effectStanding(reason.effectId, reason.state, "vi")}; kết quả chưa xác định và cần được đối chiếu`;
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

import { inertQuotedLine } from "./action-context.ts";

/**
 * What voice says after a widget action the person asked for out loud, in the person's language.
 *
 * Built from the refusal's code and details, never from the node's English sentence: that sentence is for logs and
 * agents. Three outcomes are said differently because they claim different things:
 *
 *   - `uncertain` — a call was sent and no answer the node can trust came back. It may have taken effect, so this never
 *     says it failed; it says whether it took effect is unknown, that it was not run again, and what happens next —
 *     naming the inbox only when the node recorded the question there.
 *   - `partial` — a workflow ran some steps before one did not. Those steps stay done, so this never says nothing
 *     happened either.
 *   - anything else — nothing ran, and a known code is said as a sentence; an unknown one as a generic one.
 */

export type SpeechLocale = "vi" | "en";

/** A refused action as `invokeWidgetAction` answers it. */
export interface SpokenRefusal {
  code: string;
  detail?: Record<string, unknown>;
}

interface StepLike {
  stepId: string;
  kind: string;
  status: string;
}

const REFUSALS: Record<string, { vi: string; en: string }> = {
  TURN_IN_PROGRESS: { vi: "Clark đang trả lời; chờ xong rồi thử lại nhé.", en: "Clark is still replying; try again when it finishes." },
  REVISION_MISMATCH: { vi: "Nút này vừa thay đổi; bạn thử lại nhé.", en: "This button just changed; try again." },
  BINDING_STALE: {
    vi: "Gói phía sau nút này đã được cập nhật; bạn nhờ Clark hiện lại nhé.",
    en: "The package behind this button was updated; ask Clark to show it again.",
  },
  RATE_LIMITED: { vi: "Nút này vừa được bấm quá nhiều lần; chờ một chút rồi thử lại.", en: "This button was pressed too often; wait a moment and try again." },
  INVALID_INPUT: {
    vi: "Những gì bạn nói không khớp với những gì nút này nhận.",
    en: "What you said does not match what this button takes.",
  },
  POLICY_REFUSED: { vi: "Chính sách của bạn không cho phép việc này.", en: "Your policy does not allow this." },
  SERVICE_NOT_RUNNING: { vi: "Dịch vụ phía sau nút này không chạy.", en: "The service behind this button is not running." },
  CAPABILITY_NOT_READY: { vi: "Dịch vụ phía sau nút này chưa sẵn sàng.", en: "The service behind this button is not ready yet." },
  CAPABILITY_MISSING: { vi: "Dịch vụ phía sau nút này không còn trên máy này.", en: "The service behind this button is no longer on this machine." },
  LEDGER_UNAVAILABLE: {
    vi: "Máy này không ghi lại được việc sắp làm, nên không gửi gì đi.",
    en: "This machine could not write down what it was about to do, so it sent nothing.",
  },
  BACKGROUND_UNAVAILABLE: { vi: "Máy này chưa chạy được việc ở nền.", en: "This machine cannot run work in the background yet." },
  TOKEN_BUDGET_EXCEEDED: { vi: "Yêu cầu của nút này quá dài để gửi cho Clark.", en: "This button's request is too long to send to Clark." },
  INVOCATION_IN_PROGRESS: { vi: "Việc này vẫn đang chạy.", en: "This is still running." },
  CONTEXT_REF_UNKNOWN: {
    vi: "Nút này cần một nội dung không còn trong cuộc trò chuyện.",
    en: "This button needs something that is no longer in the conversation.",
  },
  CONTEXT_REF_FORBIDDEN: { vi: "Nút này muốn đọc một nội dung nó không được phép đọc.", en: "This button asked to read something it may not read." },
};

function quoted(ids: readonly string[]): string {
  return ids.map((id) => `“${id}”`).join(", ");
}

/** The sentence voice says for a refused widget action. */
export function spokenActionRefusal(label: string, refusal: SpokenRefusal, locale: SpeechLocale): string {
  const detail = refusal.detail ?? {};
  const workflow = detail.workflow as { steps?: StepLike[]; stoppedAt?: string } | undefined;
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  const kept = steps.filter((step) => step.status === "done" && step.kind === "invoke").map((step) => step.stepId);
  const keptSentence =
    kept.length === 0 ? "" : locale === "vi" ? ` ${quoted(kept)} đã chạy và vẫn giữ nguyên.` : ` ${quoted(kept)} ran and stay done.`;

  if (detail.outcome === "uncertain" || refusal.code === "ACTION_INTERRUPTED") {
    const next =
      detail.recorded === true
        ? locale === "vi"
          ? "Hộp thư sẽ hỏi bạn nó đã có hiệu lực chưa."
          : "Your inbox asks whether it did."
        : locale === "vi"
          ? "Trước khi thử lại, bạn cho tôi biết nó đã có hiệu lực chưa nhé."
          : "Tell me whether it did before trying again.";
    return locale === "vi"
      ? `“${label}” đã được gửi đi nhưng chưa rõ đã thực hiện hay chưa. Tôi không chạy lại.${keptSentence} ${next}`
      : `“${label}” was sent, but whether it took effect is unknown. I did not run it again.${keptSentence} ${next}`;
  }
  if (detail.outcome === "partial") {
    const at = workflow?.stoppedAt === undefined ? "" : ` ${quoted([workflow.stoppedAt])}`;
    return locale === "vi"
      ? `“${label}” chỉ làm được một phần: nó dừng ở bước${at}.${keptSentence} Các bước sau không chạy.`
      : `“${label}” was done only in part: it stopped at step${at}.${keptSentence} The steps after it did not run.`;
  }
  if (detail.readOnly === true) {
    return locale === "vi"
      ? `“${label}” chưa xong, nhưng nó chỉ đọc nên không có gì bị thay đổi; bạn thử lại được.`
      : `“${label}” did not finish, but it only reads, so nothing changed; you can try again.`;
  }
  const known = REFUSALS[refusal.code];
  const why = known === undefined ? "" : ` ${known[locale]}`;
  return locale === "vi"
    ? `Chưa làm được “${label}”.${why} Không có gì bị thay đổi.`
    : `“${label}” could not be done.${why} Nothing was changed.`;
}

/**
 * The sentence voice says for an action that started in the background, started a package job, or waits on an approval
 * card. A job has only started: its widget follows the progress and the conversation says when it ended.
 */
export function spokenActionWaiting(
  label: string,
  waiting: "background" | "job" | "approval" | "approval-waiting",
  locale: SpeechLocale,
  // The voice session now listens for the person's answer to the card, so the sentence says which words decide it.
  answerAloud = false,
): string {
  const invite = !answerAloud
    ? ""
    : locale === "vi"
      ? " Bạn nói “đồng ý” để duyệt hoặc “không” để từ chối."
      : " Say “yes” to approve or “no” to refuse.";
  if (waiting === "approval-waiting") {
    return locale === "vi"
      ? `“${label}” vẫn đang chờ bạn duyệt trên thẻ đã có trong cuộc trò chuyện. Chưa có gì được gửi.${invite}`
      : `“${label}” is still waiting for your approval on the card already in the conversation. Nothing was sent.${invite}`;
  }
  if (waiting === "job") {
    return locale === "vi"
      ? `Đã bắt đầu “${label}”. Widget hiện tiến độ, và cuộc trò chuyện sẽ báo khi xong.`
      : `“${label}” has started. Its widget shows the progress, and the conversation says when it is done.`;
  }
  if (waiting === "background") {
    return locale === "vi"
      ? `Tôi đang làm “${label}” ở nền. Kết quả sẽ có trong cuộc trò chuyện khi xong.`
      : `I am doing “${label}” in the background. The result will appear in the conversation when it is done.`;
  }
  return locale === "vi"
    ? `“${label}” cần bạn duyệt trước. Tôi đã đặt thẻ duyệt trong cuộc trò chuyện.${invite}`
    : `“${label}” needs your approval first. I placed the approval card in the conversation.${invite}`;
}

/**
 * What voice says after a spoken decision on an approval card when the operation reported nothing more specific: a
 * refusal, or a grant whose outcome the node did not describe. It never claims the operation is running or done.
 */
export function spokenApprovalDecided(decision: "granted" | "denied", locale: SpeechLocale): string {
  if (decision === "denied") return locale === "vi" ? "Đã từ chối. Không có gì được chạy." : "Refused. Nothing was run.";
  return locale === "vi" ? "Đã duyệt." : "Approved.";
}

/** What voice says when a spoken widget action failed before it could answer: nothing is claimed about the widget. */
export function spokenActionFailed(label: string, locale: SpeechLocale): string {
  return locale === "vi"
    ? `Tôi không xử lý được “${label}” vì một lỗi trên máy này. Bạn kiểm tra cuộc trò chuyện trước khi thử lại nhé.`
    : `I could not handle “${label}” because of an error on this machine. Check the conversation before trying again.`;
}

/** The longest part of what a widget or its service answered that voice reads out. */
export const SPOKEN_OUTPUT_MAX_CHARS = 400;

/**
 * The sentence voice says for an action that was done, in the person's language. What the widget or its service
 * answered is read out as theirs, attributed and on one line, never as Clark's own words: the typed path labels the
 * same output as the widget's data, and a widget must not be able to put a sentence in Clark's mouth.
 */
export function spokenActionDone(label: string, output: string | undefined, locale: SpeechLocale): string {
  const done = locale === "vi" ? `Đã ${label}.` : `Done: ${label}.`;
  return `${done}${spokenWidgetWords(output, locale)}`;
}

/**
 * What a widget answered, as voice reads it after Clark's own sentence: attributed, on one line, inside a quote it
 * cannot close, and no longer than voice reads out. Empty when it answered nothing.
 */
export function spokenWidgetWords(output: string | undefined, locale: SpeechLocale): string {
  const said = output === undefined ? "" : inertQuotedLine(output).replace(/\s+/gu, " ").trim().slice(0, SPOKEN_OUTPUT_MAX_CHARS);
  if (said === "") return "";
  return locale === "vi" ? ` Widget báo: “${said}”` : ` The widget says: “${said}”`;
}

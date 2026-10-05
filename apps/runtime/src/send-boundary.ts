import {
  type DataClass,
  type SendBoundaryCheck,
  ContractViolation,
  MODEL_DATA_CLASS_UNAVAILABLE,
  checkSendBoundary,
  contractError,
} from "@clarkcant/contracts";

/**
 * The send boundary as the runtime applies it: a model's data-class ceiling is a limit on what is sent to it, not a
 * routing preference.
 *
 * Every path that hands text to a provider asks `enforceSendBoundary` immediately before it does — a conversation's turn,
 * a sentence steered into one, a tool result fed back to the model, a background run and a dispatched task's worker —
 * and each asks it about the model that is actually about to receive the text, after whatever routing, fallback, rebuild
 * or handoff chose that model. A refusal is said once on stderr by path, class and model, never by what the text said:
 * the text is the thing being protected.
 *
 * Narrowing the context a model is offered (the recap, retrieved bundles, project instructions) still runs first. It
 * is what keeps most requests under the ceiling; this is what holds when it is not enough.
 */

/** Which kind of send was checked, for the stderr line an operator reads. */
export type SendPath = "turn" | "steer" | "tool-result" | "background" | "task" | "worker-route";

/** A model as `provider/id`, which is how every record names one. */
export function modelName(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/** The check, said on stderr when it refuses: the path, the class and the model, never the text. */
export function enforceSendBoundary(input: {
  path: SendPath;
  model: { provider: string; id: string };
  allowed: readonly DataClass[];
  texts?: Iterable<string | undefined>;
  classes?: Iterable<DataClass>;
}): SendBoundaryCheck {
  const check = checkSendBoundary(input);
  if (!check.ok) {
    process.stderr.write(
      `${JSON.stringify({
        event: "model-send-blocked",
        code: check.code,
        path: input.path,
        dataClass: check.dataClass,
        model: modelName(input.model),
      })}\n`,
    );
  }
  return check;
}

/**
 * The typed not-sent outcome: `MODEL_DATA_CLASS_UNAVAILABLE`, with the class and the model as detail and the sentence
 * the person reads as the contract's message. `sent: false` is stated rather than implied, because a failure a person
 * reads after a send could have reached a provider is a different kind of failure.
 */
export class DataClassUnavailable extends ContractViolation {
  /** The class no eligible model could be sent. */
  readonly dataClass: DataClass;
  /** The model the request was not sent to, as `provider/id`. */
  readonly model: string;

  constructor(input: { dataClass: DataClass; model: string; message: string }) {
    super(
      contractError(MODEL_DATA_CLASS_UNAVAILABLE, "policy", input.message, {
        dataClass: input.dataClass,
        model: input.model,
        sent: false,
      }),
    );
    this.dataClass = input.dataClass;
    this.model = input.model;
    // The sentence alone, without the code in front: every surface that shows a failed turn's message — a card, speech,
    // a background reply — reads it to a person. The code stays on `contract`.
    this.message = input.message;
  }
}

export function dataClassUnavailable(input: { dataClass: DataClass; model: string; message: string }): DataClassUnavailable {
  return new DataClassUnavailable(input);
}

/** Whether a failure is the not-sent outcome above. */
export function isDataClassUnavailable(cause: unknown): cause is DataClassUnavailable {
  return cause instanceof DataClassUnavailable;
}

/**
 * What a person reads when a request is not sent: which class stopped it, that nothing went to the model, that their
 * message and their choice of model are kept, and what they can change. `subject` is what carried the class.
 */
export function dataClassUnavailableText(
  language: "vi" | "en",
  input: {
    dataClass: DataClass;
    model: string;
    subject: "message" | "background";
    /** The model's ceiling could not be read, so it was taken as `public` alone: said as that, not as a ceiling. */
    unread?: boolean;
  },
): string {
  const { dataClass, model } = input;
  if (language === "vi") {
    const saved = input.subject === "message" ? "Tin nhắn của bạn đã được lưu và model bạn chọn vẫn giữ nguyên. " : "";
    if (input.unread === true) {
      return (
        `Không đọc được ${model} được nhận những mức dữ liệu nào, nên không có gì được gửi tới model. ${saved}` +
        "Hãy thử lại; nếu lỗi này lặp lại, hãy kiểm tra profile của model trong Cài đặt → AI & Định tuyến."
      );
    }
    const what = input.subject === "message" ? "Tin nhắn này" : "Việc nền này";
    return (
      `${what} có dữ liệu mức ${dataClass}, mà ${model} không được nhận dữ liệu mức đó, nên không có gì được gửi tới model. ` +
      saved +
      `Để tiếp tục, hãy chọn một model được nhận dữ liệu mức ${dataClass} (ví dụ một model chạy trên máy này), ` +
      `cho phép mức ${dataClass} cho model đó trong Cài đặt → AI & Định tuyến, hoặc gửi lại mà không có phần đó.`
    );
  }
  const saved = input.subject === "message" ? "Your message is saved and your choice of model is unchanged. " : "";
  if (input.unread === true) {
    return (
      `What ${model} may receive could not be read, so nothing was sent to the model. ${saved}` +
      "Retry; if this keeps happening, check the model's profile in Settings → AI & Routing."
    );
  }
  const what = input.subject === "message" ? "This message" : "This background request";
  return (
    `${what} carries ${dataClass} data, and ${model} may not receive ${dataClass} data, so nothing was sent to the model. ` +
    saved +
    `To continue, choose a model that may receive ${dataClass} data (such as one that runs on this machine), ` +
    `allow ${dataClass} for that model in Settings → AI & Routing, or send it again without that part.`
  );
}

/**
 * A dispatched task's refusal when its worker could not be sent the task, worded like the dispatcher's other refusals:
 * the code, the class, the model, that nothing was sent and no worker started, and what the person can change.
 */
export function dataClassTaskRefusal(input: { dataClass: DataClass; model: string }): string {
  const { dataClass, model } = input;
  return (
    `refused: ${MODEL_DATA_CLASS_UNAVAILABLE}: the task carries ${dataClass} data, and ${model} may not receive ` +
    `${dataClass} data, nor may any model this node could start its worker on; nothing was sent to a model and the ` +
    `worker was never started; choose a model that may receive ${dataClass} data (such as one that runs on this machine), ` +
    `or allow ${dataClass} for that model in Settings → AI & Routing, and run the task again`
  );
}

/**
 * What a model reads in place of a tool result it may not receive. The call ran, and the person's transcript keeps its
 * result; only the model is not sent it, and it is told so, so it can say so rather than guess.
 */
export function withheldToolResult(input: { dataClass: DataClass; model: string }): string {
  return (
    `[The result of this call carries ${input.dataClass} data, which ${input.model} may not receive, so it was withheld ` +
    "from you. The call itself ran. Tell the person the result was withheld for its data class and continue without it.]"
  );
}

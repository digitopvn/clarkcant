import type { AppIntentLocale } from "@clarkcant/contracts";

/**
 * The words the conductor writes into a conversation itself, in the person's interface language.
 *
 * Everything here is host-written: a card or a sentence the node composes from its own state, never the model's reply.
 * The client cannot translate these — they arrive as content, not as catalog keys — so the node picks the language when
 * it writes them, from the same `AppIntentLocale` the intent read-backs use. Vietnamese stays the default for a caller
 * that names no language, as `describeAppIntent` does.
 *
 * Field labels on the model note are also what the client reads to draw that note as one line (`SystemCardBlock`), so a
 * label changed here has to be changed there too.
 */
export interface ConductorText {
  /** A turn that has no model to answer with and no capability to run. */
  noModel: { text: string; title: string; detail: string };
  /** The sentence a dispatched task is announced with. */
  runningOn: (executionNodeId: string) => string;
  /** The host card every scripted sample carries. */
  sample: { title: string; detail: (recipeId: string) => string; sourceLabel: string };
  /** The card a model turn that threw becomes. */
  modelFailed: { title: string; kindLabel: string };
  /** The note that records which model answered a turn, or that it was stopped. */
  reply: {
    stoppedTitle: string;
    fallbackTitle: string;
    answeredTitle: string;
    stoppedDetail: string;
    fallbackDetail: (from: string, reason: string, answeredBy: string) => string;
    answeredDetail: string;
    endedLabel: string;
    endedValue: string;
    chosenModelLabel: string;
    elapsedLabel: string;
  };
  /** The reported turn numbers, as field labels and values. */
  metrics: {
    contextLabel: string;
    tokensLabel: string;
    tokens: (input: string, output: string) => string;
    cache: (rate: number | undefined, read: string, written: string) => string;
    speedLabel: string;
    costLabel: string;
    cwdLabel: string;
  };
  /** Said in place of a block a model turn was not allowed to produce. */
  rejectedBlock: (reason: string) => string;
}

const VI: ConductorText = {
  noModel: {
    text: "Tui chưa trả lời được: máy này chưa có model nào để tui dùng.",
    title: "Chưa có model để trả lời",
    detail:
      "Tin nhắn của bạn vẫn còn đây và việc này đang chờ. Thêm một model trong Cài đặt → AI & Định tuyến rồi gửi lại; tui sẽ không tự làm bằng một công cụ tui không có.",
  },
  runningOn: (executionNodeId) => `Đang chạy trên ${executionNodeId}.`,
  sample: {
    title: "Dữ liệu mẫu / demo tương tác",
    detail: (recipeId) =>
      `Chạy recipe "${recipeId}" trên dữ liệu mẫu. Đây không phải dữ liệu thật của bạn và không có model nào được gọi.`,
    sourceLabel: "Nguồn dữ liệu",
  },
  modelFailed: { title: "Không gọi được model", kindLabel: "Loại lỗi" },
  reply: {
    stoppedTitle: "Đã dừng theo yêu cầu",
    fallbackTitle: "Trả lời bằng model dự phòng",
    answeredTitle: "Trả lời bằng model",
    stoppedDetail:
      "Bạn đã dừng lượt trả lời này. Phần ở trên là những gì model đã viết trước khi dừng; sau đó không có thêm chữ hay công cụ nào chạy.",
    fallbackDetail: (from, reason, answeredBy) =>
      `${from} không trả lời được (${reason}), nên ${answeredBy} đã trả lời thay. ` +
      "Lựa chọn của bạn trong Cài đặt vẫn giữ nguyên; Clark sẽ thử lại model đó sau ít phút.",
    answeredDetail:
      "Câu trả lời này do model sinh ra. Không capability nào trên máy này được dùng, và không dữ liệu thật nào của bạn được đọc.",
    endedLabel: "Kết thúc",
    endedValue: "dừng theo yêu cầu",
    chosenModelLabel: "Model đã chọn",
    elapsedLabel: "Thời gian",
  },
  metrics: {
    contextLabel: "Ngữ cảnh",
    tokensLabel: "Token",
    tokens: (input, output) => `${input} vào · ${output} ra`,
    cache: (rate, read, written) => `${rate === undefined ? "chưa đo được" : `${rate}% đọc lại`} · ${read} đọc · ${written} ghi`,
    speedLabel: "Tốc độ",
    costLabel: "Chi phí",
    cwdLabel: "Thư mục làm việc",
  },
  rejectedBlock: (reason) => `Một khối nội dung đã bị từ chối: ${reason}`,
};

const EN: ConductorText = {
  noModel: {
    text: "I can't answer yet: this machine has no model for me to use.",
    title: "No model to answer with",
    detail:
      "Your message is still here and this task is waiting. Add a model in Settings → AI & Routing, then send it again; I won't do it with a tool I don't have.",
  },
  runningOn: (executionNodeId) => `Running on ${executionNodeId}.`,
  sample: {
    title: "Sample data / interactive demo",
    detail: (recipeId) =>
      `Ran recipe "${recipeId}" on sample data. This is not your real data, and no model was called.`,
    sourceLabel: "Data source",
  },
  modelFailed: { title: "Could not reach the model", kindLabel: "Error type" },
  reply: {
    stoppedTitle: "Stopped on request",
    fallbackTitle: "Answered by a fallback model",
    answeredTitle: "Answered by a model",
    stoppedDetail:
      "You stopped this reply. What is above is what the model wrote before it stopped; no more text or tools ran after that.",
    fallbackDetail: (from, reason, answeredBy) =>
      `${from} could not answer (${reason}), so ${answeredBy} answered instead. ` +
      "Your choice in Settings is unchanged; Clark will try that model again in a few minutes.",
    answeredDetail:
      "This answer was generated by a model. No capability on this machine was used, and none of your real data was read.",
    endedLabel: "Ended",
    endedValue: "stopped on request",
    chosenModelLabel: "Chosen model",
    elapsedLabel: "Time",
  },
  metrics: {
    contextLabel: "Context",
    tokensLabel: "Tokens",
    tokens: (input, output) => `${input} in · ${output} out`,
    cache: (rate, read, written) => `${rate === undefined ? "not measured yet" : `${rate}% reused`} · ${read} read · ${written} written`,
    speedLabel: "Speed",
    costLabel: "Cost",
    cwdLabel: "Working folder",
  },
  rejectedBlock: (reason) => `A content block was refused: ${reason}`,
};

/** The conductor's words in one language; Vietnamese when none is named. */
export function conductorText(locale: AppIntentLocale = "vi"): ConductorText {
  return locale === "en" ? EN : VI;
}

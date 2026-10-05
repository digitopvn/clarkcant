import type { AppIntentLocale } from "@clarkcant/contracts";

/**
 * The words the quick-play samples show, in the person's interface language.
 *
 * A sample is drawn by the node, so its title (which is also the chart's accessible name), unit and sentence are the
 * node's words and are written in the language the person reads, never translated by the client. Vietnamese is the
 * default, as it is for every host-written text.
 */
export interface SampleText {
  chartTitle: string;
  /** The chart's unit: what one point counts. */
  chartUnit: string;
  lineChart: string;
  barChart: string;
  defaultChart: string;
  noteTitle: string;
  note: string;
  tableTitle: string;
  table: string;
}

const VI: SampleText = {
  chartTitle: "Số lần chạy theo tuần — dữ liệu mẫu",
  chartUnit: "lần",
  lineChart: "Biểu đồ đường trên **dữ liệu mẫu**. Nói \"ghim lại\" nếu bạn muốn giữ nó trong khung chat.",
  barChart: "Biểu đồ cột trên **dữ liệu mẫu**.",
  defaultChart:
    "Đây là thứ tui có thể làm ngay mà không cần bạn kết nối gì cả: một biểu đồ trên **dữ liệu mẫu**. Muốn làm việc thật thì mình cần cài thêm capability — cứ nói việc bạn muốn làm.",
  noteTitle: "Ghi chú của tui",
  note: "Đây là một ghi chú chạy hoàn toàn trên máy bạn. Không có mạng, không có model. Bạn có thể ghim nó lại bằng cách nói \"ghim cái này\".",
  tableTitle: "Bảng dữ liệu mẫu",
  table:
    "Bảng dưới đây là **dữ liệu mẫu**, không phải số liệu thật của bạn. Bấm vào một dòng để chọn, hoặc nói cho tui biết bạn muốn xem gì.",
};

const EN: SampleText = {
  chartTitle: "Runs per week — sample data",
  chartUnit: "runs",
  lineChart: "A line chart on **sample data**. Say \"pin this\" if you want to keep it in the chat.",
  barChart: "A bar chart on **sample data**.",
  defaultChart:
    "Here is something I can do right away without you connecting anything: a chart on **sample data**. For real work I need a capability installed — just tell me what you want to get done.",
  noteTitle: "My note",
  note: "This note runs entirely on your machine. No network, no model. You can pin it by saying \"pin this\".",
  tableTitle: "Sample data table",
  table:
    "The table below is **sample data**, not your real figures. Click a row to select it, or tell me what you want to see.",
};

/** The samples' words in one language; Vietnamese when none is named. */
export function sampleText(locale: AppIntentLocale = "vi"): SampleText {
  return locale === "en" ? EN : VI;
}

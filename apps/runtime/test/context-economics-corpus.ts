/**
 * Labelled conversations for the context-economics measurement.
 *
 * Each turn names the tools a correct answer needs. The labels are a person's judgement, written before the planner
 * was run on them, and include turns whose words point nowhere ("có gì mới không?" needs the inbox) so the measurement
 * shows what progressive disclosure misses rather than only what it saves. `fresh` marks a turn answered by a new
 * session — after an idle eviction, a failure or a restart.
 */

export interface EconomicsTurn {
  text: string;
  needs: readonly string[];
  fresh?: boolean;
}

export interface EconomicsConversation {
  id: string;
  turns: readonly EconomicsTurn[];
}

export const ECONOMICS_CORPUS: readonly EconomicsConversation[] = [
  {
    id: "dev-loop-vi",
    turns: [
      { text: "Tìm giúp mình dự án clarkcant trên máy", needs: ["find_project"] },
      { text: "Chạy pnpm test trong đó", needs: ["run_command"] },
      { text: "Lỗi ở file nào vậy?", needs: ["search_files"] },
      { text: "Sửa xong rồi, chạy lại test đi", needs: ["run_command"] },
      { text: "Ổn rồi, cảm ơn", needs: [] },
      { text: "Commit với message fix flaky test", needs: ["run_command"] },
    ],
  },
  {
    id: "dev-loop-en",
    turns: [
      { text: "Find the web project folder", needs: ["find_project"] },
      { text: "Run the build", needs: ["run_command"] },
      { text: "Open a terminal there and tail the logs", needs: ["terminal_open", "terminal_run"] },
      { text: "What does it say now?", needs: ["terminal_read"] },
      { text: "Stop it", needs: ["terminal_run"] },
    ],
  },
  {
    id: "settings-vi",
    turns: [
      { text: "Chuyển sang chế độ tối", needs: ["control_app"] },
      { text: "Mở cài đặt giao diện", needs: ["control_app"] },
      { text: "Đổi theme khác đẹp hơn", needs: ["control_app"] },
      { text: "Được rồi", needs: [] },
    ],
  },
  {
    id: "inbox-implicit",
    turns: [
      { text: "Chào buổi sáng", needs: [] },
      { text: "Có gì mới không?", needs: ["read_inbox"] },
      { text: "Duyệt cái đầu tiên", needs: ["act_on_notice"] },
      { text: "Còn việc nào đang chạy không?", needs: ["list_work"] },
    ],
  },
  {
    id: "automation-vi",
    turns: [
      { text: "Mỗi sáng 8 giờ nhắc mình xem email", needs: ["create_automation"] },
      { text: "Liệt kê các tự động hóa đang có", needs: ["list_automations"] },
      { text: "Đổi giờ cái đó thành 9 giờ", needs: ["update_automation"] },
      { text: "Cho máy văn phòng gửi việc sang đây", needs: ["allow_peer_tasks", "list_peers"] },
    ],
  },
  {
    id: "packages-en",
    turns: [
      { text: "Install the weather widget package", needs: ["manage_package"] },
      { text: "Show me the forecast for Saigon", needs: ["invoke_capability"] },
      { text: "Put it on a map", needs: ["show_view"] },
      { text: "Update all packages", needs: ["manage_package"] },
    ],
  },
  {
    id: "long-chat-mixed",
    turns: [
      { text: "Hôm qua mình bàn gì về cơ sở dữ liệu?", needs: ["search_history"] },
      { text: "Nhớ là mình thích trả lời ngắn", needs: ["remember"] },
      { text: "Tóm tắt lại giúp", needs: [] },
      { text: "Mở trang web docs và đọc phần cài đặt", needs: ["start_browser_task"], fresh: true },
      { text: "Dừng việc đó lại", needs: ["stop_work"] },
      { text: "Chạy lại lệnh build hôm qua", needs: ["run_command", "search_history"] },
    ],
  },
  {
    id: "chit-chat",
    turns: [
      { text: "Xin chào", needs: [] },
      { text: "Bạn là ai?", needs: [] },
      { text: "Kể chuyện cười đi", needs: [] },
      { text: "Haha hay đấy", needs: [] },
      { text: "Thôi chào nhé", needs: [] },
    ],
  },
];

/**
 * Long conversations whose answer depends on a decision made early, beyond the recap's window.
 *
 * `decisionIndex` is the message that holds the decision; `question` is the message a fresh session must answer.
 */
export interface RecapCase {
  id: string;
  messages: readonly { role: "user" | "assistant"; text: string }[];
  decisionIndex: number;
  question: string;
}

function filler(count: number, topic: string): { role: "user" | "assistant"; text: string }[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `${topic} — bước ${String(index + 1)}: ghi chú chi tiết về việc đang làm, không liên quan tới quyết định trước đó.`,
  }));
}

export const RECAP_CASES: readonly RecapCase[] = [
  {
    id: "database-decision",
    messages: [
      { role: "user", text: "Mình nên dùng cơ sở dữ liệu nào cho dự án Clark?" },
      { role: "assistant", text: "Đề xuất chốt SQLite cho cơ sở dữ liệu cục bộ vì một người dùng một máy." },
      { role: "user", text: "Ok chốt SQLite." },
      ...filler(50, "Thiết kế giao diện"),
    ],
    decisionIndex: 1,
    question: "Nhắc lại cơ sở dữ liệu mình đã chốt cho dự án là gì?",
  },
  {
    id: "deploy-target",
    messages: [
      { role: "user", text: "Where should the staging deploy go?" },
      { role: "assistant", text: "We agreed staging deploys go to the Hetzner box, never to production." },
      ...filler(30, "Viết tài liệu"),
    ],
    decisionIndex: 1,
    question: "Which box do staging deploys go to again?",
  },
  {
    id: "recent-only",
    messages: [...filler(20, "Sửa lỗi đăng nhập"), { role: "user", text: "Lỗi đăng nhập đã sửa xong chưa?" }],
    decisionIndex: 19,
    question: "Tiếp tục sửa lỗi đăng nhập",
  },
];

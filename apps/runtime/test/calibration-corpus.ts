/**
 * The calibration corpus, as data.
 *
 * Kept out of the spec file so the labels are a reviewed artifact rather than a fixture buried in a
 * test: the numbers this produces decide whether a node turns the selector on for search, and a
 * decision made from labels nobody can read is not a decision anybody can check.
 *
 * Every case names what a human would choose. `expected: undefined` means the correct answer is
 * "nothing", which a selector must also be able to say.
 */

export interface SearchCalibrationCase {
  query: string;
  /** The message a human would choose, or undefined when nothing is right. */
  expected: string | undefined;
  /** Whether the words in the query appear in the target. False means only meaning connects them. */
  lexical: boolean;
}

/** Thirty-four labelled search queries: twenty Vietnamese, fourteen English. */
export const SEARCH_CALIBRATION: readonly SearchCalibrationCase[] = [
  { query: "lỗi đăng nhập", expected: "msg_login", lexical: true },
  { query: "token hết hạn", expected: "msg_login", lexical: true },
  { query: "biểu đồ doanh thu", expected: "msg_chart", lexical: true },
  { query: "migration thêm cột", expected: "msg_migration", lexical: true },
  { query: "cuộc họp với khách hàng", expected: "msg_meeting", lexical: true },
  { query: "nhập ảnh", expected: "msg_image", lexical: true },
  { query: "truy vấn chậm", expected: "msg_slow", lexical: true },
  { query: "xoay khoá api", expected: "msg_security", lexical: true },
  { query: "deploy lên staging", expected: "msg_deploy", lexical: true },
  { query: "kiểm thử giao diện", expected: "msg_ui_test", lexical: true },
  { query: "sửa lỗi không đăng nhập được", expected: "msg_login", lexical: false },
  { query: "di trú cơ sở dữ liệu", expected: "msg_migration", lexical: false },
  { query: "bảo mật và khoá bí mật", expected: "msg_security", lexical: false },
  { query: "lịch họp với đối tác", expected: "msg_meeting", lexical: false },
  { query: "dọn dẹp chỉ mục", expected: "msg_slow", lexical: false },
  { query: "ảnh chụp sơ đồ hệ thống", expected: "msg_image", lexical: false },
  { query: "đưa bản dựng lên máy chủ thử", expected: "msg_deploy", lexical: false },
  { query: "thử tự động trên trình duyệt", expected: "msg_ui_test", lexical: false },
  { query: "hoá đơn điện tử", expected: undefined, lexical: true },
  { query: "kế hoạch nghỉ phép", expected: undefined, lexical: true },
  { query: "login bug", expected: "msg_login_en", lexical: true },
  { query: "expired token", expected: "msg_login_en", lexical: true },
  { query: "revenue chart axis", expected: "msg_chart_en", lexical: true },
  { query: "database migration", expected: "msg_migration_en", lexical: true },
  { query: "customer meeting", expected: "msg_meeting_en", lexical: true },
  { query: "slow query index", expected: "msg_slow_en", lexical: true },
  { query: "rate limit", expected: "msg_security_en", lexical: true },
  { query: "accessibility audit", expected: undefined, lexical: true },
  { query: "kubernetes ingress", expected: undefined, lexical: true },
  { query: "webhook thanh toán", expected: undefined, lexical: true },
  { query: "the login problem we hit", expected: "msg_login_en", lexical: false },
  { query: "database schema change", expected: "msg_migration_en", lexical: false },
  { query: "why is the dashboard slow", expected: "msg_slow_en", lexical: false },
  { query: "who did we meet", expected: "msg_meeting_en", lexical: false },
];

export interface SearchCalibrationSeed {
  id: string;
  text: string;
  at: string;
}

/** The history the corpus is scored against. Nine Vietnamese messages, five English. */
export const SEARCH_CALIBRATION_SEEDS: readonly SearchCalibrationSeed[] = [
  { id: "msg_login", text: "Sửa lỗi đăng nhập: token hết hạn không được làm mới", at: "2026-09-16T02:00:00.000Z" },
  { id: "msg_chart", text: "Biểu đồ doanh thu theo tuần bị thiếu nhãn trục", at: "2026-09-15T02:00:00.000Z" },
  { id: "msg_migration", text: "Chạy migration thêm cột owner_principal_id vào datasets", at: "2026-09-14T02:00:00.000Z" },
  { id: "msg_meeting", text: "Cuộc họp với khách hàng về lịch tuần sau", at: "2026-09-13T02:00:00.000Z" },
  { id: "msg_image", text: "Nhập ảnh sơ đồ kiến trúc vào máy này", at: "2026-09-12T02:00:00.000Z" },
  { id: "msg_slow", text: "Tối ưu truy vấn chậm trên bảng events", at: "2026-09-11T02:00:00.000Z" },
  { id: "msg_security", text: "Bảo mật: xoay khoá api và kiểm tra secret trong lịch sử", at: "2026-09-10T02:00:00.000Z" },
  { id: "msg_deploy", text: "deploy lên staging bằng tag v0.2.0", at: "2026-09-09T02:00:00.000Z" },
  { id: "msg_ui_test", text: "kiểm thử giao diện bằng Playwright trên Chromium", at: "2026-09-08T02:00:00.000Z" },
  { id: "msg_login_en", text: "login bug: expired token refresh was not retried", at: "2026-09-07T02:00:00.000Z" },
  { id: "msg_chart_en", text: "revenue chart is missing its axis label", at: "2026-09-06T02:00:00.000Z" },
  { id: "msg_migration_en", text: "database migration adds a column to datasets", at: "2026-09-05T02:00:00.000Z" },
  { id: "msg_meeting_en", text: "customer meeting to schedule next week", at: "2026-09-04T02:00:00.000Z" },
  { id: "msg_slow_en", text: "slow query on the events table needs an index", at: "2026-09-03T02:00:00.000Z" },
  { id: "msg_security_en", text: "rate limit the public endpoint and rotate the api key", at: "2026-09-02T02:00:00.000Z" },
];

export interface RoutingCalibrationCase {
  /** What the user said. */
  intent: string;
  /** Which running thing a human would say it is about, or undefined for "nothing that is running". */
  expectedId: string | undefined;
}

/**
 * Sixteen routing situations: several running things, described the way a user would refer to them.
 *
 * The ids match the labels of the candidates the routing harness builds, so the labels are the thing
 * a human would recognise: a workspace name, an open voice session, a running task.
 */
export const ROUTING_CALIBRATION: readonly RoutingCalibrationCase[] = [
  { intent: "tiếp tục việc ở dự án agentkit", expectedId: "runtime:lease:lease_agentkit" },
  { intent: "dự án agentkit-docs đang chạy cái gì", expectedId: "runtime:lease:lease_docs" },
  { intent: "dừng phiên thoại đi", expectedId: "runtime:voice:voice_1" },
  { intent: "việc đang chạy dở xong chưa", expectedId: "runtime:task:task_running" },
  { intent: "máy này đang thế nào", expectedId: "runtime:node:node_local" },
  { intent: "thời tiết hôm nay thế nào", expectedId: undefined },
  { intent: "which workspace is busy right now", expectedId: "runtime:lease:lease_agentkit" },
  { intent: "is anything still running", expectedId: "runtime:task:task_running" },
  { intent: "close the microphone", expectedId: "runtime:voice:voice_1" },
  { intent: "what is mounted right now", expectedId: "runtime:surface:winst_open" },
  { intent: "write me a poem about rain", expectedId: undefined },
  { intent: "cái đang chạy trên dự án tài liệu là gì", expectedId: "runtime:lease:lease_docs" },
  { intent: "there is a surface open somewhere, which one", expectedId: "runtime:surface:winst_open" },
  { intent: "how is this machine doing", expectedId: "runtime:node:node_local" },
  { intent: "kể chuyện cười đi", expectedId: undefined },
  { intent: "the docs workspace again please", expectedId: "runtime:lease:lease_docs" },
];

/**
 * The candidates the routing corpus is scored against.
 *
 * Five running things, which is what makes it a decision rather than a confirmation.
 */
export const ROUTING_CALIBRATION_CANDIDATES: readonly { id: string; label: string; kind: string }[] = [
  { id: "runtime:lease:lease_agentkit", label: "đang giữ workspace agentkit", kind: "lease" },
  { id: "runtime:lease:lease_docs", label: "đang giữ workspace agentkit-docs", kind: "lease" },
  { id: "runtime:voice:voice_1", label: "phiên thoại đang mở (listening)", kind: "voice-session" },
  { id: "runtime:task:task_running", label: "việc đang chạy: kiểm tra toàn bộ e2e", kind: "task" },
  { id: "runtime:surface:winst_open", label: "bề mặt đang mở (pin)", kind: "live-owner" },
  { id: "runtime:node:node_local", label: "máy này (local runtime)", kind: "node" },
];

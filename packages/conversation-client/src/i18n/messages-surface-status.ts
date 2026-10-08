/**
 * Words for the states host cards share through the surface status contract: the connection and reconnection states a
 * card used to show as their wire value, and the lines that say what a finished task's evidence means for its outcome.
 *
 * Kept in its own file, like the other split catalogs, so it can change without touching the timeline catalog other
 * work is editing at the same time.
 */

export const MESSAGES_SURFACE_STATUS_VI = {
  "blocks.connection.status.unconfigured": "chưa thiết lập",
  "blocks.connection.status.proposal": "đề xuất",
  "blocks.connection.status.awaiting_user_consent": "chờ bạn đồng ý",
  "blocks.connection.status.authorizing": "đang uỷ quyền",
  "blocks.connection.status.verifying_account_and_scopes": "đang kiểm tra tài khoản",
  "blocks.connection.status.probing_capability": "đang thử kết nối",
  "blocks.connection.status.connected": "đã kết nối",
  "blocks.connection.status.needs_reauth": "cần đăng nhập lại",
  "blocks.connection.status.degraded": "chạy không đầy đủ",
  "blocks.connection.status.revoked": "đã thu hồi",
  "blocks.connection.status.denied": "bị từ chối",
  "blocks.connection.status.partial": "được cấp một phần",
  "blocks.connection.status.expired": "đã hết hạn",
  "blocks.connection.status.failed": "thất bại",
  "blocks.connection.next.signIn": "Đăng nhập lại với nhà cung cấp để dùng tiếp kết nối này.",
  "blocks.connection.next.reconnect": "Kết nối này không còn quyền truy cập. Kết nối lại trong Cài đặt để dùng tiếp.",
  "blocks.connection.lastProbe.pass": "Lần kiểm tra gần nhất ({time}): đạt.",
  "blocks.connection.lastProbe.fail": "Lần kiểm tra gần nhất ({time}): không đạt.",
  "blocks.connection.lastProbe.not-run": "Chưa chạy lần kiểm tra nào ({time}).",
  "blocks.reconnect.status.disconnected": "mất kết nối",
  "blocks.reconnect.status.reconnecting": "đang kết nối lại",
  "blocks.reconnect.status.failed": "không kết nối lại được",
  "blocks.taskSummary.contradicted": "Bằng chứng mâu thuẫn với kết quả được báo. Đừng coi việc này là đã thành công.",
  "blocks.taskSummary.unverified": "Lần chạy đã kết thúc, nhưng chưa có bằng chứng xác nhận kết quả.",
  "blocks.taskOverview.empty": "Chưa có việc nào trong cuộc trò chuyện này.",
  "widgets.metrics.unknown": "chưa rõ",
} as const;

export type SurfaceStatusMessageKey = keyof typeof MESSAGES_SURFACE_STATUS_VI;

export const MESSAGES_SURFACE_STATUS_EN = {
  "blocks.connection.status.unconfigured": "not set up",
  "blocks.connection.status.proposal": "proposed",
  "blocks.connection.status.awaiting_user_consent": "waiting for your consent",
  "blocks.connection.status.authorizing": "authorizing",
  "blocks.connection.status.verifying_account_and_scopes": "checking the account",
  "blocks.connection.status.probing_capability": "testing the connection",
  "blocks.connection.status.connected": "connected",
  "blocks.connection.status.needs_reauth": "needs sign-in again",
  "blocks.connection.status.degraded": "degraded",
  "blocks.connection.status.revoked": "revoked",
  "blocks.connection.status.denied": "denied",
  "blocks.connection.status.partial": "partly granted",
  "blocks.connection.status.expired": "expired",
  "blocks.connection.status.failed": "failed",
  "blocks.connection.next.signIn": "Sign in to the provider again to keep using this connection.",
  "blocks.connection.next.reconnect": "This connection no longer has access. Reconnect it in Settings to keep using it.",
  "blocks.connection.lastProbe.pass": "Last check ({time}): passed.",
  "blocks.connection.lastProbe.fail": "Last check ({time}): failed.",
  "blocks.connection.lastProbe.not-run": "No check has run yet ({time}).",
  "blocks.reconnect.status.disconnected": "disconnected",
  "blocks.reconnect.status.reconnecting": "reconnecting",
  "blocks.reconnect.status.failed": "could not reconnect",
  "blocks.taskSummary.contradicted": "The evidence contradicts the reported result. Do not treat this as a success.",
  "blocks.taskSummary.unverified": "The run ended, but no evidence confirms the result yet.",
  "blocks.taskOverview.empty": "No tasks in this conversation yet.",
  "widgets.metrics.unknown": "unknown",
} as const satisfies Record<SurfaceStatusMessageKey, string>;

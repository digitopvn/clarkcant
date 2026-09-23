/**
 * The unified Credentials section: one place listing every stored secret/provider key with its
 * name, purpose, connection status, Replace and Remove actions. DESIGN.md section 11.6 -- no
 * top-level tab, lives inside the AI and Routing tab, and the other tabs that used to embed a key
 * form now point here.
 *
 * Split from `messages.ts` for the same reason as the other `messages-*` files: parallel edits do
 * not collide. Spread into `MESSAGES_VI` / `MESSAGES_EN` there. Key prefix is `settings.credentials.`.
 */

export const MESSAGES_CREDENTIALS_VI = {
  "settings.credentials.heading": "Thông tin xác thực",
  "settings.credentials.intro": "Mọi khoá node đang giữ: tên, mục đích và trạng thái kết nối. Giá trị đã lưu không bao giờ hiện lại.",
  "settings.credentials.readFailed": "Không đọc được trạng thái thông tin xác thực.",
  "settings.credentials.status.connected": "Đã kết nối",
  "settings.credentials.status.notConnected": "Chưa kết nối",
  "settings.credentials.field.label": "Giá trị mới",
  "settings.credentials.field.placeholder": "Dán khoá vào đây",
  "settings.credentials.replace": "Thay thế",
  "settings.credentials.remove": "Gỡ bỏ",
  "settings.credentials.status.saved": "Đã lưu — node đang dùng khoá mới.",
  "settings.credentials.status.saveFailed": "Không lưu được khoá mới. Khoá cũ (nếu có) vẫn được giữ nguyên. Thử dán lại và lưu lần nữa.",
  "settings.credentials.status.sentNoName": "Đã gửi, nhưng node không ghi nhận tên khoá này. Không có gì bị mất; thử lại.",
  "settings.credentials.status.removed": "Đã gỡ — node không còn giữ khoá này.",
  "settings.credentials.status.removeFailed": "Không gỡ được khoá. Khoá hiện tại (nếu có) vẫn được giữ nguyên; thử lại hoặc tải lại trang.",
  "settings.credentials.linkFromAi": "Quản lý khoá TypeSafe trong mục Thông tin xác thực bên dưới.",
  "settings.credentials.linkFromDevices": "Quản lý khoá Gemini trong mục Thông tin xác thực ở tab AI & Định tuyến.",
  "settings.credentials.typesafe.label": "Khoá TypeSafe (Jev)",
  "settings.credentials.typesafe.purpose": "Dùng cho Jev khi nó phải quyết định cách xử lý một việc.",
  "settings.credentials.gemini.label": "Khoá Gemini",
  "settings.credentials.gemini.purpose": "Dùng cho Gemini Live khi bạn nói. Lần mở voice kế tiếp sẽ dùng khoá này.",
} as const;

export const MESSAGES_CREDENTIALS_EN = {
  "settings.credentials.heading": "Credentials",
  "settings.credentials.intro":
    "Every key this node holds: name, purpose and connection status. A stored value is never shown again.",
  "settings.credentials.readFailed": "Could not read credential status.",
  "settings.credentials.status.connected": "Connected",
  "settings.credentials.status.notConnected": "Not connected",
  "settings.credentials.field.label": "New value",
  "settings.credentials.field.placeholder": "Paste the key here",
  "settings.credentials.replace": "Replace",
  "settings.credentials.remove": "Remove",
  "settings.credentials.status.saved": "Saved - the node is using the new key.",
  "settings.credentials.status.saveFailed":
    "Could not save the new key. The previous one, if any, was kept. Paste it again and save once more.",
  "settings.credentials.status.sentNoName": "Sent, but the node did not acknowledge this key name. Nothing was lost; try again.",
  "settings.credentials.status.removed": "Removed - the node no longer holds this key.",
  "settings.credentials.status.removeFailed":
    "Could not remove the key. The current one, if any, was kept; try again or reload the page.",
  "settings.credentials.linkFromAi": "Manage the TypeSafe key in the Credentials section below.",
  "settings.credentials.linkFromDevices": "Manage the Gemini key in the Credentials section on the AI & Routing tab.",
  "settings.credentials.typesafe.label": "TypeSafe key (Jev)",
  "settings.credentials.typesafe.purpose": "Used by Jev when it has to decide how to handle something.",
  "settings.credentials.gemini.label": "Gemini key",
  "settings.credentials.gemini.purpose": "Used for Gemini Live when you speak. The next time voice opens, it will use this key.",
} as const;

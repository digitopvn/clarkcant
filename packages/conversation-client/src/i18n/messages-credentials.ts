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
  "settings.credentials.heading": "Thong tin xac thuc",
  "settings.credentials.intro": "Moi khoa node dang giu: ten, muc dich va trang thai ket noi. Gia tri da luu khong bao gio hien lai.",
  "settings.credentials.readFailed": "Khong doc duoc trang thai thong tin xac thuc.",
  "settings.credentials.status.connected": "Da ket noi",
  "settings.credentials.status.notConnected": "Chua ket noi",
  "settings.credentials.field.label": "Gia tri moi",
  "settings.credentials.field.placeholder": "Dan khoa vao day",
  "settings.credentials.replace": "Thay the",
  "settings.credentials.remove": "Go bo",
  "settings.credentials.status.saved": "Da luu - node dang dung khoa moi.",
  "settings.credentials.status.saveFailed":
    "Khong luu duoc khoa moi. Khoa cu (neu co) van duoc giu nguyen. Thu dan lai va luu lan nua.",
  "settings.credentials.status.sentNoName": "Da gui, nhung node khong ghi nhan ten khoa nay. Khong co gi bi mat; thu lai.",
  "settings.credentials.status.removed": "Da go - node khong con giu khoa nay.",
  "settings.credentials.status.removeFailed":
    "Khong go duoc khoa. Khoa hien tai (neu co) van duoc giu nguyen; thu lai hoac tai lai trang.",
  "settings.credentials.linkFromAi": "Quan ly khoa TypeSafe trong muc Thong tin xac thuc ben duoi.",
  "settings.credentials.linkFromDevices": "Quan ly khoa Gemini trong muc Thong tin xac thuc o tab AI and Dinh tuyen.",
  "settings.credentials.typesafe.label": "Khoa TypeSafe (Jev)",
  "settings.credentials.typesafe.purpose": "Dung cho Jev khi no phai quyet dinh cach xu ly mot viec.",
  "settings.credentials.gemini.label": "Khoa Gemini",
  "settings.credentials.gemini.purpose": "Dung cho Gemini Live khi ban noi. Lan mo voice ke tiep se dung khoa nay.",
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
  "settings.credentials.linkFromDevices": "Manage the Gemini key in the Credentials section on the AI and Routing tab.",
  "settings.credentials.typesafe.label": "TypeSafe key (Jev)",
  "settings.credentials.typesafe.purpose": "Used by Jev when it has to decide how to handle something.",
  "settings.credentials.gemini.label": "Gemini key",
  "settings.credentials.gemini.purpose": "Used for Gemini Live when you speak. The next time voice opens, it will use this key.",
} as const;

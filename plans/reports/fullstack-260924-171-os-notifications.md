# Báo cáo — Thông báo hệ điều hành cho hộp thư (#171)

- Plan: `plans/260924-0840-171-inbox-followups/phase-03-os-notifications.md`
- Worktree: `/home/user/fu-171`, nhánh `fu-171`
- Trạng thái: hoàn thành phần code + unit test + `pnpm verify` xanh; e2e chưa tự chạy (xem "Chưa kiểm chứng").

## Tóm tắt việc đã làm

1. **Preference đã đăng ký** `inbox.notifications` (`packages/contracts/src/preferences.ts`): 4 nhóm bật/tắt
   (`waitingApprovals`, `backgroundResults`, `updates`, `otherDevices`), `os`/`web` bật riêng, giờ yên lặng
   (`enabled`/`start`/`end` dạng `HH:MM` local). Scope `node`, `applies: immediate`, mặc định tất cả nhóm bật, OS
   bật, web tắt (vì bật web chính là hành động xin quyền). Route `GET/PUT /preferences/:key` đã tổng quát nên
   không cần sửa `apps/runtime`.

2. **Hàm quyết định thuần** `packages/conversation-client/src/inbox/inbox-notify-decide.ts`:
   `decideInboxNotifications` nhận preference, danh sách notice/waiting, id đã biết, id đã nhắc gần hết hạn,
   thời điểm và cờ "cửa sổ không có focus" — trả về danh sách cần báo, tập id đã thấy (để theo dõi liên tục kể cả
   khi nhóm đang tắt, tránh dội thông báo dồn khi bật lại) và tập id đã nhắc gần hết hạn (đã dọn theo waiting item
   còn tồn tại). Có `groupForNotice`, `isWithinQuietHours` (khung giờ cắt qua nửa đêm), `minutesOfDay`. Tiêu đề/nội
   dung luôn qua `redactSecrets` và cắt theo `NOTICE_TITLE_MAX`/`NOTICE_BODY_MAX`; nội dung waiting item dùng
   `description`/`prompt`, không bao giờ dùng trường `command` thô. 17 test đơn vị trong
   `packages/conversation-client/test/inbox-notify-decide.spec.ts`, gồm: tắt nhóm thì không báo (nhưng vẫn theo
   dõi id), tắt cả hai kênh thì không báo, giờ yên lặng, đã biết thì không báo lại, nhắc gần hết hạn đúng một lần,
   dọn id khi item không còn, redact secret trong body.

3. **Hook phân phối** `packages/conversation-client/src/inbox/use-inbox-notifications.ts`: poll
   `client.preferences()` + `client.inbox()` mỗi 5s (cùng nhịp dấu hộp thư), lần đầu chỉ gieo baseline (không báo
   những gì có sẵn từ trước). Trên Electron gọi `desktopBridge().notify()` (chỉ khi `preference.os`); trên trình
   duyệt tạo `new Notification()` (chỉ khi `preference.web` và `Notification.permission === "granted"` tại thời
   điểm gửi). Click thông báo trên desktop nghe qua `onNotificationClicked`, trên web gán `onclick` — cả hai gọi
   `onOpenInbox` (đúng path `inbox.open` mà header mark đang dùng). Wired vào `Conversation.tsx` ngay sau khi tính
   `windowMode`.

4. **Desktop, host-owned**: `apps/desktop/src/main.mjs` — `desktop:notify` giờ gọi Electron `Notification` thật
   (chỉ tiêu đề/nội dung renderer đã bound và redact), click thì restore + focus cửa sổ (như
   `desktop:focusWindow`) rồi phát `desktop:notificationClicked` tới mọi renderer. Thêm `Notification` vào import,
   thêm `onNotificationClicked` vào `EXPECTED_BRIDGE_METHODS`. `apps/desktop/src/preload.cjs` thêm
   `onNotificationClicked(callback)` (subscription có tên, không phải `invoke` chung). `IPC_CHANNELS` trong
   `security.mjs` không cần sửa vì kênh mới chỉ push một chiều, không phải `invoke`.
   `packages/conversation-client/src/desktop-compact.ts` thêm `notify?`/`onNotificationClicked?` vào interface
   `DesktopBridge` phía client.

5. **Settings → Control** (`packages/conversation-client/src/settings/ControlSettings.tsx`, thêm
   `InboxNotificationSettings`): toggle theo 4 nhóm, toggle OS (disable kèm lý do khi không phải desktop chrome),
   toggle web (bấm bật mới gọi `Notification.requestPermission()`; chỉ ghi `web: true` khi trình duyệt trả
   `"granted"`, còn lại giữ tắt và hiện đúng lý do — không hỗ trợ hay bị từ chối), giờ yên lặng (toggle + hai
   `<input type="time">`, ghi ngay khi blur). Mọi ghi đều gộp toàn bộ object (schema `z.strictObject`) rồi
   `prefs.write` — không có nút Save, khớp `usePreferences` (không optimistic). Chuỗi VI+EN mới trong
   `packages/conversation-client/src/i18n/messages-settings.ts` (khoá `settings.control.notifications.*`).

6. **E2E** `apps/web/e2e/inbox-notifications.spec.ts` (mới, chưa tự chạy — xem mục dưới): stub
   `window.Notification` qua `page.addInitScript` (ghi lại mọi thông báo vào `window.__ccNotifications`, cấp
   quyền "granted" khi gọi `requestPermission`), ép `document.hasFocus() === false` để mô phỏng "cửa sổ không có
   focus". Bật web notifications và tắt nhóm `waitingApprovals` trong Settings → Control, rồi tạo một approval mới
   (nhóm đang tắt) và một notice kết quả việc nền (nhóm vẫn bật, theo đúng cách `apps/web/e2e/inbox.spec.ts` đã
   tạo notice). Assert: thông báo của nhóm bật xuất hiện; không thông báo nào mang tiêu đề "Lệnh cần bạn duyệt"
   hay chứa `"node -e"` (dòng lệnh thật của approval).

7. **DESIGN.md §6.7**: chuyển gạch đầu dòng "thông báo hệ điều hành..." từ "Chưa ship" sang "Đã ship", viết lại
   đúng những gì đã làm (host-owned, redact, click mở qua `inbox.open`, web chỉ sau khi người dùng bật và trình
   duyệt cấp quyền, tuỳ chọn theo nhóm + giờ yên lặng, nhắc gần hết hạn đúng một lần). Không đụng
   `docs/manifest.json` vì DESIGN.md không nằm trong danh sách theo dõi.

## Quyết định đáng chú ý

- **Theo dõi id "đã thấy" độc lập với việc có báo hay không.** Nếu chỉ theo dõi khi thực sự báo, bật lại một nhóm
  đã tắt sẽ dội hết mọi thứ tích luỹ trong lúc tắt. Hàm thuần luôn cập nhật `seenIds` cho mọi notice/waiting đọc
  được, chỉ riêng danh sách `candidates` mới bị lọc theo nhóm/giờ yên lặng/kênh/tiêu điểm cửa sổ.
- **Giờ yên lặng chặn hẳn, không xếp hàng phát lại sau đó.** Một việc chờ rơi vào cửa sổ gần hết hạn trong giờ yên
  lặng có thể mất luôn lượt nhắc nếu hết hạn trước khi giờ yên lặng kết thúc — chấp nhận theo KISS/YAGNI vì
  repo chưa có scheduler nào cho việc này; không âm thầm "đền bù" bằng logic mới.
- **`otherDevices` có toggle trước khi có producer** (giống ghi chú trong DESIGN.md/#170): trường `originNodeId`
  đã có trên `Notice`, và một preference bị từ chối ghi hôm nay sẽ là một bước lùi tệ hơn khi #170 làm xong.
- **Không sửa `apps/desktop/src/index.ts`**: `DESKTOP_BRIDGE_METHODS`/`DesktopBridge` ở đó đã là bản chép tay lạc
  hậu so với preload thật từ trước (thiếu `getSession`, `setCompactMode`, v.v., và tên `showNotification` không
  khớp `notify`) — comment của chính file nói rõ `security.mjs` mới là bản enforcing. Thêm một phương thức vào một
  danh sách đã lạc hậu không sửa được độ lệch đó và nằm ngoài phạm vi #171; để nguyên, không tạo thêm một chỗ nữa
  phải nhớ đồng bộ tay.
- **Không sửa `packages/contracts/src/inbox.ts`, `inbox-model.ts`, `inbox-panel.tsx`, `inbox-mark.tsx`**: theo yêu
  cầu giảm tối đa đụng vào các file hộp thư client đang có thay đổi song song (#172); tái dùng nguyên
  `waitingKey`, các khoá i18n tiêu đề có sẵn (`inbox.command.title`, `inbox.capability.title`,
  `inbox.question.title`) và trường `description`/`title`/`body` vốn đã là text an toàn để hiển thị.

## Kiểm chứng đã chạy

- `pnpm exec vitest run packages/conversation-client/test/inbox-notify-decide.spec.ts
  packages/conversation-client/test/inbox-model.spec.ts` — xanh (24 test).
- `pnpm run typecheck` — xanh (`tsconfig.json` + `tsconfig.web.json`, không có `any` rò rỉ, không lỗi
  `exactOptionalPropertyTypes`).
- `pnpm run lint` — xanh.
- `pnpm run test` (toàn bộ vitest, 230 file) — xanh, 2771 test qua (7 skip có điều kiện sẵn, không liên quan đến
  #171).
- `node tools/check-invariants.mjs` — xanh cả 12 check, trước và sau khi sửa DESIGN.md.
- `pnpm verify` (invariants + typecheck + lint + test gộp) — xanh trên cây hiện tại.

## Chưa kiểm chứng (cần controller)

- **`apps/web/e2e/inbox-notifications.spec.ts` chưa được tự chạy**, theo đúng yêu cầu của nhiệm vụ (không tự chạy
  Playwright). Cần chạy qua `pnpm test:e2e` sau khi giải phóng cổng 8876/4273. Nên chạy cùng lúc với
  `apps/web/e2e/inbox.spec.ts` và `apps/web/e2e/autonomy.spec.ts` vì cả ba cùng dùng node e2e dùng chung và cùng
  thao tác trên `#cc-tabpanel-control`.
- **Smoke test Electron thật** (`electron . --smoke-test`) không chạy được trong môi trường sandbox này (không có
  GUI/display). `EXPECTED_BRIDGE_METHODS` trong `main.mjs` đã thêm `onNotificationClicked` khớp với
  `preload.cjs`, và test tĩnh `apps/desktop/test/security.spec.ts` (kiểm `IPC_CHANNELS`) vẫn xanh, nhưng hành vi
  Notification thật trên OS (click, focus cửa sổ) chưa được xác nhận bằng cách chạy shell thật.
- Route hợp nhất với phase 2 (#172, đang chạy song song ở worktree khác — chạm `packages/contracts/src/inbox.ts`)
  và phase 4 (#169) chưa diễn ra; phase 5 sẽ hợp nhất và chạy e2e một lần theo plan.

## File đã sửa/thêm

Sửa: `DESIGN.md`, `apps/desktop/src/main.mjs`, `apps/desktop/src/preload.cjs`,
`packages/contracts/src/preferences.ts`, `packages/conversation-client/src/Conversation.tsx`,
`packages/conversation-client/src/desktop-compact.ts`,
`packages/conversation-client/src/i18n/messages-settings.ts`,
`packages/conversation-client/src/settings/ControlSettings.tsx`.

Thêm: `apps/web/e2e/inbox-notifications.spec.ts`,
`packages/conversation-client/src/inbox/inbox-notify-decide.ts`,
`packages/conversation-client/src/inbox/use-inbox-notifications.ts`,
`packages/conversation-client/test/inbox-notify-decide.spec.ts`.

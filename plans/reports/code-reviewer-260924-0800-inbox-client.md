# Review phía client: hộp thư (PR #175)

Phạm vi: `packages/conversation-client/src/inbox/*`, `api.ts`, `ConversationHeader.tsx`, `Conversation.tsx`,
`use-app-intent-surfaces.ts`, `app-intents.ts`, `styles/base.ts`, `i18n/messages-inbox.ts`, `i18n/messages.ts`,
`apps/web/src/App.tsx`, `packages/core/src/app-intents.ts` (các cụm `inbox.open`), cùng
`packages/conversation-client/test/inbox-model.spec.ts` và `apps/web/e2e/inbox.spec.ts`. Diff so với `origin/main`.
Chỉ đọc; không sửa gì.

## Đã chạy

- `pnpm typecheck`: đạt (cả `tsconfig.json` lẫn `tsconfig.web.json`).
- `pnpm exec vitest run` trên `inbox-model.spec.ts`, `app-intents-agent-control.spec.ts`,
  `packages/core/test/app-intents.spec.ts`: 36/36 đạt.
- `eslint` trên các file client bị đổi: sạch.
- `pnpm invariants`: đạt 12/12, trong đó có `tsx-files-are-typechecked`. Hai file `.tsx` mới đều nằm trong
  `packages/conversation-client/src`, và `tsconfig.web.json` include thư mục này, nên không có `.tsx` mồ côi.
- Không chạy e2e, vì cổng 8876/4273 đang dành cho một lượt chạy khác.

## Kết luận

Có **1 lỗi blocking** (focus không trở về khi đóng hộp thư trong luồng phổ biến nhất) và **7 lỗi should-fix**.
Luồng quyết định dùng đúng route của thẻ, i18n đủ cả vi và en, dialog có nhãn, "chưa đọc" được nói bằng chữ, và
voice/text đi chung intent `inbox.open`.

---

## Blocking

### B1. Đóng hộp thư sau khi dấu header đã biến mất thì focus rơi về `<body>`

- File: `packages/conversation-client/src/Modal.tsx:98,111`; `inbox/inbox-mark.tsx:57` (`return null`);
  `inbox/inbox-panel.tsx:91-100` (đánh dấu đã đọc rồi gọi `changed.current()`); `apps/web/src/App.tsx:328-331`.
- Kịch bản lỗi (đường phổ biến nhất):
  1. Hộp thư chỉ có 1 thông báo mới, không có việc chờ. Dấu hiện "1 thông báo mới".
  2. User Tab tới dấu rồi nhấn Enter. `Modal` lưu `opener = <button.cc-inbox-mark>`.
  3. Panel đọc xong, `markInboxRead` rồi `onChanged`, nên `inboxTick` tăng, dấu đọc lại được `{0,0}` và
     `InboxMark` trả `null`. Nút mở đã bị gỡ khỏi DOM.
  4. User nhấn Escape. Cleanup của `Modal` gọi `opener.current.focus()` trên một phần tử đã tách khỏi DOM, lời gọi
     không làm gì. Dialog unmount cùng phần tử đang giữ focus, nên `document.activeElement === body`.
  Lỗi y hệt xảy ra khi duyệt/từ chối việc chờ cuối cùng rồi đóng, và khi bấm "Mở hội thoại" (Conversation remount
  qua `key`, nên cả header cũ bị gỡ). E2E chỉ kiểm focus trả về khi vẫn còn một approval đang chờ (test "a typed
  command…"), tức đúng trường hợp dấu không biến mất, nên không bắt được lỗi này.
- Vì sao blocking: định nghĩa hoàn thành UI trong AGENTS.md ghi "focus returns after modal/live/detached surfaces
  close", và DESIGN §6.7 khẳng định "Escape đóng và trả focus".
- Cách sửa: trong `Modal`, khi `!(opener.current instanceof HTMLElement) || !opener.current.isConnected` thì focus một
  đích dự phòng. Cách gọn nhất là thêm prop tuỳ chọn `returnFocus?: RefObject<HTMLElement | null>`; `InboxPanel`
  truyền composer hoặc nút bánh răng. Với "Mở hội thoại", focus composer sau khi remount, ví dụ `App` truyền một cờ
  "vừa chuyển hội thoại" để `Conversation` focus `composerInput` lúc mount. Thêm e2e cho case này: chỉ tạo một thông
  báo, mở bằng bàn phím, Escape, rồi assert `activeElement` không phải `body`.

---

## Should-fix

### S1. Double-click "Từ chối" báo thất bại sai sau khi đã từ chối thành công

- File: `inbox/inbox-panel.tsx:106-111` (`settle` gọi `setBusy(undefined)` *trước* khi `read()` trả về),
  `:116-126`, `:251-262`.
- Kịch bản: node chạy local, route từ chối trả về khoảng 20 ms. Cú click thứ hai của một double-click đến sau khoảng
  150 ms. Lúc này `busy` đã về `undefined` nhưng danh sách vẫn là bản cũ (chưa có kết quả `GET /inbox`), nên nút
  "Từ chối" của chính item đó đang enabled. Request thứ hai nhận 409 `APPROVAL_ALREADY_DECIDED`, và `settle` ghi đè
  dòng "Đã từ chối" bằng "Chưa ghi được quyết định: APPROVAL_ALREADY_DECIDED: … Không có gì chạy; việc này vẫn chờ
  bạn". Server không chạy gì hai lần, nhưng UI nói sai. AGENTS.md yêu cầu "double-click effects must deduplicate".
  Capability approval không dính lỗi này, vì server trả `alreadyDecided` với status 200.
- Cách sửa:
  - giữ item bị khoá cho tới khi `read()` xong, ví dụ `setBusy(undefined)` trong `.then` của `read()`, hoặc giữ một
    `Set` các key đã quyết định;
  - thêm chốt đồng bộ bằng `useRef`, dạng `if (inFlight.current) return`, ở đầu `decideCommand`, `decideCapability`
    và `dismiss`, như `ExtensionsSettings.decide` đang làm với `if (busy !== undefined) return`;
  - coi `GatewayError.code === "APPROVAL_ALREADY_DECIDED"` là "đã được quyết định ở nơi khác", không phải thất bại.

### S2. Câu lỗi `inbox.decideFailed` khẳng định những điều client không biết, và có lúc sai

- File: `i18n/messages-inbox.ts:35-36,82-83`; `inbox/inbox-panel.tsx:125,139`. Phía server:
  `apps/runtime/src/routes/conversations.ts:1291-1327`.
- Kịch bản:
  - `decideApprovalForNode` ghi quyết định `granted` trước (`decideApproval(coordination, …)`), *sau đó* mới có thể
    trả `APPROVAL_PAYLOAD_MISSING` hoặc lỗi của `runApprovedCommand`. Khi đó approval đã được ghi là granted và không
    còn chờ, nhưng panel nói "Chưa ghi được quyết định… việc này vẫn chờ bạn, ở đây và trong hội thoại của nó". Ngay
    sau đó `read()` cho thấy item đã biến mất, nên trên màn hình có hai điều trái ngược nhau.
  - `APPROVAL_EXPIRED`: panel mở lâu, nhãn "còn 14 phút" được tính theo `readAt` cũ, user bấm duyệt thì nhận câu
    "vẫn chờ bạn", nhưng việc đó đã hết hạn.
  - `{reason}` là `GatewayError.message` có dạng `CODE: message`, nên mã nội bộ lọt ra UI mặc định.
- Cách sửa: rẽ nhánh theo `GatewayError.code`, với các câu riêng cho "đã hết hạn", "đã được quyết định", "đã ghi
  quyết định nhưng lệnh không chạy được (xem hội thoại)". Với lỗi không rõ, chỉ nói điều chắc chắn, rồi để lần đọc lại
  quyết định có nói "vẫn chờ" hay không: kiểm tra item còn trong `inbox.waiting` sau `read()` rồi mới chọn câu.

### S3. Bấm "Từ chối" thì nút "Duyệt và chạy" đổi thành "Đang chạy…"

- File: `inbox/inbox-panel.tsx:254`.
- Kịch bản: `decideCommand(item, "denied")` đặt `busy = waitingKey(item)`, nên `deciding` là `true` và nút duyệt hiện
  `inbox.command.running`. Trong lúc từ chối, UI nói một lệnh đang chạy, trái với quy tắc "never invent progress".
- Cách sửa: lưu cả quyết định vào busy, ví dụ `busy = { key, decision }`, và chỉ hiện "Đang chạy…" khi
  `decision === "granted"`. Có thể thêm nhãn trung tính "Đang từ chối…" cho nút từ chối.

### S4. Modal lồng nhau: mở thư viện widget bằng giọng nói khi hộp thư đang mở

- File: `use-app-intent-surfaces.ts:88-90,130-134` (`openWidgetLibrary` không đóng hộp thư). So sánh với `:103-114`,
  nơi `openSettings` và `openInbox` có đóng lẫn nhau.
- Kịch bản: phiên thoại đang mở, user nói "mở hộp thư", rồi nói "mở thư viện widget". Luồng voice
  `app-intent → runIntent → host.openWidgetLibrary` mở `WidgetLibrarySurface`, cũng là một `role="dialog"
  aria-modal="true"`, đè lên `Modal` của hộp thư. Hai listener `keydown` ở mức document cùng chạy, nên một lần Escape
  đóng cả hai. Hai vòng bẫy Tab tranh nhau. Chính `WidgetLibrarySurface.tsx:42-45` đã ghi đúng rủi ro này cho Settings.
- Cách sửa: thêm `setInboxOpen(false)` vào cả `openWidgetLibrary` trong `intentHost` lẫn callback `openWidgetLibrary`
  của hook. Nên có unit test cho `intentHost`: mở inbox rồi mở widgets thì `inboxOpen === false`.

### S5. Áp timeline của hội thoại cũ lên màn hình mới, do so `conversationId` từ closure

- File: `inbox/inbox-panel.tsx:122` (`if (item.conversationId === conversationId) onTimeline(result.timeline)`).
- Kịch bản: user duyệt một lệnh chạy lâu (ví dụ 30 giây) của hội thoại đang mở; nút hiện "Đang chạy…". User nhấn
  Escape rồi bấm logo (`nav.home`, tức `restartSession`: `conversationId = undefined`, `timeline = undefined`).
  Khi request trả về, closure vẫn giữ id cũ nên phép so sánh đúng, và `applyTimeline` vẽ transcript cũ lên màn hình
  bắt đầu, trong khi `conversationId` là `undefined`. Tin nhắn kế tiếp tạo hội thoại mới dưới một transcript không
  thuộc về nó. `use-turn-send.ts` chặn đúng loại lỗi này bằng `sessionGeneration`; hộp thư thì không. Đường thẻ
  (`use-block-actions.ts:55-56`) có cùng mẫu từ trước PR này, nhưng hộp thư làm lỗi dễ gặp hơn vì panel tồn tại độc
  lập với thẻ.
- Cách sửa: giữ `conversationId` hiện tại trong một `useRef` cập nhật mỗi render, và chỉ gọi `onTimeline` khi
  `result.timeline.conversationId === currentIdRef.current`. `Timeline` đã có trường `conversationId`.

### S6. "Bỏ" một thông báo làm mất focus và không nói gì

- File: `inbox/inbox-panel.tsx:144-156`.
- Kịch bản: user dùng bàn phím, Tab tới "Bỏ" rồi nhấn Enter. Request thành công, `read()` trả danh sách mới không còn
  `<li>` đó, nút đang giữ focus bị gỡ, và `activeElement` về `body`. Screen reader không nghe gì, vì nhánh thành công
  không đặt `status`. Nếu đó là thông báo cuối, bẫy Tab của `Modal` (chỉ bắt khi `activeElement` là phần tử đầu hoặc
  cuối) không còn giữ focus trong dialog.
- Cách sửa: sau `read()`, focus nút "Bỏ" của thông báo kế tiếp, hoặc heading "Thông báo" (thêm `tabIndex={-1}`),
  hoặc đặt một status ngắn "Đã bỏ thông báo." rồi focus `statusLine` như luồng quyết định. Thêm bước assert focus vào
  e2e "background work…".

### S7. "Mở hội thoại" âm thầm bỏ bản nháp, file đính kèm, phiên thoại và lượt đang stream

- File: `apps/web/src/App.tsx:328-331` (`setConversationKey`), `inbox/inbox-panel.tsx:169`.
- Kịch bản: user đang gõ dở một đoạn trong composer, hoặc đã đính kèm file, hoặc đang trong phiên thoại (vừa nói "mở
  hộp thư"), hoặc lượt trả lời đang stream. User bấm "Mở hội thoại" cho một hội thoại khác, và `Conversation` remount:
  - `draft` (state trong `Conversation`) và `chips` mất;
  - `VoiceOverlay` unmount rồi `endSession()`, nên micro tắt mà không báo;
  - `streamMessage` của lượt đang chạy vẫn mở, nhưng không còn ai vẽ nó.
  AGENTS.md: bề mặt phụ phải "preserve conversation state", và phiên thoại không được "silently stop". Comment ở
  `App.tsx:139-145` gọi đây là "the same thing a reload does", nhưng reload là hành động user chủ động chọn, còn nút
  này thì không nói gì về cái giá phải trả.
- Cách sửa, chọn một trong hai:
  - (a) Khi `busy`, `voiceOpen`, draft khác rỗng hoặc có chip, thì disable "Mở hội thoại" và ghi lý do hiển thị được
    (ví dụ "Đang có lượt chạy / bản nháp chưa gửi").
  - (b) Giữ draft theo từng hội thoại, ví dụ trong `sessionStorage` với key `cc_draft:<id>`, và báo một notice khi
    phiên thoại bị kết thúc vì chuyển hội thoại.
  Phương án (a) nhỏ hơn và trung thực.

---

## Nit

- **N1. Lỗi đọc lại mâu thuẫn với dòng trạng thái.** `messages-inbox.ts:18,65`: sau một quyết định thành công, nếu
  `read()` lỗi thì `role="alert"` nói "Không có gì bị thay đổi", ngay dưới dòng "Đã duyệt". Nên tách câu cho lần đọc
  đầu và lần đọc lại. Ngoài ra, thay "đóng rồi mở lại để thử lại" bằng một nút "Thử lại" thật.
- **N2. Danh sách bị cắt 50 mà không báo.** `apps/runtime/src/inbox.ts:181` (`limit = 50`): khi có hơn 50 thông báo
  chưa đọc, panel chỉ hiện và chỉ đánh dấu 50, nên dấu vẫn ghi "N thông báo mới" mà panel không có "còn N nữa". Nên
  hiện `unread` còn lại, hoặc ghi rõ "hiện 50 mới nhất".
- **N3. Chấm "chưa đọc" dùng màu cảnh báo.** `inbox-panel.tsx` (khối `cc-inbox-unread`) đặt
  `<span className="cc-dot" data-state="waiting">`, tức màu warning, trái với comment của stylesheet ("a result nobody
  has read is not an alarm"). Nên dùng một `data-state` trung tính.
- **N4. Tooltip giờ không theo locale của app.** `inbox-panel.tsx:351`: `toLocaleString()` không truyền locale, nên
  tooltip dùng locale của trình duyệt. `readAt` ở trên thì có truyền. Nên dùng cùng locale.
- **N5. Tiêu đề chứa chi tiết nội bộ.** `inbox-panel.tsx:272,276`: tiêu đề capability đưa `item.ref` và `packageId`
  thô, còn version đứng một mình không có nhãn. AGENTS.md dặn không đưa capability ref vào UI mặc định. Nên để
  `description` làm dòng chính và đẩy `ref`/version vào `<details>`.
- **N6. Race khi mở lại nhanh.** `inbox-panel.tsx:85-100`: cờ `cancelled` chỉ chặn bước đánh dấu đã đọc, không chặn
  `setLoad` bên trong `read()`. Mở, đóng rồi mở lại nhanh thì lần đọc cũ có thể về sau và ghi đè lần mới. Dữ liệu vẫn
  có `readAt` đúng của nó, nên chỉ là nit. Có thể gắn một bộ đếm thế hệ.
- **N7. Lỗi schema bị dump nguyên văn.** `reasonOf` (`inbox-panel.tsx`): khi `inboxResponseSchema.parse` ném
  `ZodError`, JSON của zod được in vào câu lỗi. Nên rút về một câu ngắn và log chi tiết ở console.
- **N8. Một Escape đóng hai lớp (lỗi có từ trước).** `DesktopSurfaces.tsx:326-335`: Escape ở `window` đóng expanded
  view cùng lúc với modal. Nay hộp thư mở được bằng giọng nói ngay trên expanded view, nên một Escape đóng hai lớp.
  Không do PR này tạo ra; nên ghi follow-up.
- **N9. `conversationId` từ peer.** `onOpenConversation` và `decideApproval` ghép thẳng `conversationId` vào path mà
  không `encodeURIComponent` (`api.ts` `timeline()`, `decideApproval()`). Hiện id do chính node sinh nên an toàn. Khi
  bật thông báo từ peer (§6.7, "chưa ship"), cần kiểm dạng id hoặc encode trước.

## Đã kiểm, không có lỗi

- Polling của dấu: `clearInterval` và cờ `cancelled` khi unmount hoặc khi `refreshKey` đổi. Lỗi đọc thì ẩn dấu thay
  vì giữ số cũ, đúng tinh thần "không trình bày dữ liệu cũ như live".
- Quyết định cho hội thoại đang mở và cho hội thoại khác: cùng route `POST /conversations/:id/approvals/:id/decide`
  với digest. Chỉ hội thoại đang mở mới `applyTimeline`. Phần còn lại xem S5.
- `openSettings` và `openInbox` đóng lẫn nhau; `showConversation` và "đóng hộp thư" (`nav.conversation`) đóng cả hộp
  thư.
- Voice và text: `inbox.open` đi qua `runAppIntent` cho click, lệnh gõ, voice và `control_app` (đã có trong
  `CONTROL_APP_KINDS`). Host không có hộp thư thì từ chối kèm câu `shell.intent.notInbox` có cả vi và en. Cụm
  whole-sentence không nuốt "open my gmail inbox" hay "mở thông báo lỗi ra xem" (đã có test).
- i18n: `MESSAGES_INBOX_EN … satisfies Record<MessageInboxKey, string>` bảo đảm đủ khoá. Hai khoá
  `settings.extensions.approvals.*` dùng lại đều đã có sẵn.
- Accessibility: dialog có `aria-labelledby` và `aria-describedby`, section có `aria-labelledby` trỏ tới heading.
  Nút dấu có `aria-label` chứa nội dung nhìn thấy. Nút "Bỏ" có tên riêng theo tiêu đề thông báo. Trạng thái dùng
  `role="status"`, lỗi tải dùng `role="alert"`. "Chưa đọc" có chữ, kèm chữ đậm.
- Motion: `.cc-inbox-mark` chỉ transition `transform` bằng token (`--cc-motion-micro`, `--cc-motion-bounce`), giống
  mẫu sẵn có ở `panels.ts:231` và `voice.ts:263`. Không có `transition: all`. Reduced motion đi qua quy tắc toàn cục
  ở `panels.ts:353`.
- Không có control giả: "Mở hội thoại" không được vẽ khi host không đổi được hội thoại. Câu hỏi chỉ có "Mở hội thoại".

## Test còn thiếu

- E2E: focus sau Escape khi dấu đã biến mất (B1); focus sau "Bỏ" (S6); double-click "Từ chối" chỉ tạo một request
  và không hiện dòng lỗi (S1); voice hoặc lệnh `widgets.open` khi hộp thư mở (S4).
- Unit: logic chọn câu lỗi theo `GatewayError.code` (S2), sau khi đưa logic đó vào `inbox-model.ts`.

## Theo dõi kế hoạch

Phase 2 (`plans/260924-0648-inbox-notifications/phase-02-surface.md`) có các mục 1-8 đã có mặt trong code. Mục
kiểm chứng "Escape trả focus về dấu" mới chỉ đúng khi dấu còn hiện (xem B1). Mục 4 có nhắc "sắp xếp" trong
`inbox-model.ts`, nhưng việc sắp xếp thực tế do server làm (`ORDER BY created_at DESC`). Không sai, nhưng plan nên
ghi đúng như vậy.

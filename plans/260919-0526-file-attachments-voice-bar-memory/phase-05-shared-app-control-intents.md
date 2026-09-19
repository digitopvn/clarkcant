---
phase: 5
title: "Registry app-intent dùng chung cho chat, click và voice"
status: done
priority: P1
effort: "7h"
dependencies: []
---

# Phase 5: Registry app-intent dùng chung cho chat, click và voice

## Context Links

- Issue #17 §3 "Voice mode điều khiển mọi thứ trong app"
- `docs/system-architecture.md` §11 — "Voice có semantic view của instance đang focus và đi qua cùng path"
- `apps/runtime/src/voice-session.ts` — socket `/voice`; `interpretDecision()` (dòng ~158) quyết định
  lời xác nhận; doc-comment đầu file liệt kê wire format
- `apps/runtime/src/gateway.ts` — định tuyến `segments[i]`; `appendEvent` ký tại
  `packages/storage/src/repositories.ts:171`
- `packages/core/src/preferences.ts` — `setPreference`/`undoPreference`; **chưa có** `deletePreference`
- `packages/storage/src/migrate.ts:604-625` — `conditional_documents` có `etag/revision/body/draft`,
  **không** phải key-value → không dùng cho token xác nhận
- `docs/conformance-traceability.md:85` — T66 là **widget** action state, không phải panel Settings

## Goal

Một registry intent duy nhất cho việc điều khiển app; chat đã gõ, click, và voice đi vào cùng registry,
cùng hàm quyết định, cùng bản ghi audit, và cùng hàm thực thi ở client. Lệnh **dạng lệnh app** mà không
khớp intent thì nói chưa hiểu và không hành động; câu hỏi bình thường vẫn tới agent. Thoát app chỉ xảy
ra sau một lần xác nhận do **node** quyết định.

## Danh sách intent

Issue ghi "cả 8 nhóm lệnh" nhưng liệt kê **9** việc. Plan định nghĩa 9 intent và nói rõ chỗ lệch; test
phủ đủ 9, tức không thiếu mục nào của issue.

| Intent | Nghĩa | Tham số | Cần xác nhận |
|---|---|---|---|
| `voice.end` | kết thúc phiên thoại | — | không |
| `window.expand` | mở rộng cửa sổ | — | không |
| `window.minimise` | thu nhỏ xuống taskbar | — | không |
| `window.minimal` | thu nhỏ về thanh voice | — | không |
| `settings.open` | mở Settings (không nêu tab → tab đang dùng, mặc định `general`) | `tab?` | không |
| `settings.tab` | đổi tab Settings đang mở (**bắt buộc** có `tab`) | `tab` | không |
| `nav.home` | về màn hình bắt đầu | — | không |
| `composer.attach` | mở hộp thoại chọn tệp | — | không |
| `app.quit` | thoát app | — | **luôn hỏi** |

## Hai luật quyết định, viết một lần

1. **Câu dạng lệnh app** (mở đầu bằng một động từ điều khiển: mở/đóng/thu nhỏ/mở rộng/kết thúc/thoát/
   về/tắt/đổi) mà **không** khớp intent nào → trả lời "chưa hiểu" và **không** hành động, **không**
   chuyển tiếp cho agent. Đây là điều issue yêu cầu: không đoán bừa.
2. **Mọi câu khác** (kể cả câu có nhắc tới "cài đặt" nhưng không phải mệnh lệnh) → **không** bị registry
   chặn; nó là một lượt agent bình thường.

Luật này được viết ở một chỗ (`isAppCommandShaped`) và có test cho cả hai phía.

## Xác nhận thoát app (quyết định đã chốt)

- `POST /app-intents` **không bao giờ** trả một intent thực thi được cho `app.quit`. Nó trả
  `{ kind: "needs-confirmation", intent, readBack, confirmationToken }`.
- Token: `randomUUID`, lưu ở `preferences` key `app.intent.pending.<token>`, `scope: "node"`,
  value `{ kind, at }`, hết hạn sau 2 phút. Cần thêm `deletePreference` vào
  `packages/core/src/preferences.ts`.
- `POST /app-intents/confirm { confirmationToken, decision: "granted" | "denied" }` → chỉ khi
  `decision === "granted"` mới trả `{ kind: "intent", intent }`; token bị xoá sau lần dùng đầu (dùng lại
  → 409 `CONFIRMATION_ALREADY_USED`). Sai/hết hạn → 410 `CONFIRMATION_EXPIRED`.
- **Đường voice không nhận intent thực thi từ node.** Frame gửi client là decision
  (`needs-confirmation`); client đọc lại câu `readBack` và **không** gọi bridge. Lời xác nhận tiếp theo
  được node xử lý: nếu không có approval nào đang chờ (`interpretDecision` trong `voice-session.ts`
  đứng trước), node gọi confirm rồi mới phát frame `{ type: "app-intent", decision: { kind: "intent", … } }`.
- Client **chỉ** thực thi khi nhận `kind: "intent"`. `runAppIntent` không có tham số xác nhận và không
  tự hỏi; quyền quyết định nằm ở node.

## Files to Create / Modify

- Create: `packages/contracts/src/app-intents.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/core/src/preferences.ts` (thêm `deletePreference`)
- Create: `packages/core/src/app-intents.ts` (`matchAppIntent`, `isAppCommandShaped`, `resolveAppIntent`, `recordAppIntentEvent`)
- Create: `packages/core/test/app-intents.spec.ts`
- Create: `apps/runtime/src/app-intents.ts` (registry runtime + token + audit)
- Create: `apps/runtime/test/app-intents.spec.ts`
- Modify: `apps/runtime/src/gateway.ts` (`POST /app-intents`, `POST /app-intents/confirm`; nối chat)
- Modify: `apps/runtime/src/voice-session.ts` (frame `app-intent`, xác nhận do node xử lý)
- Create: `packages/conversation-client/src/app-intents.ts` (`runAppIntent`, `AppIntentHost`)
- Modify: `packages/conversation-client/src/Conversation.tsx` (nút Settings/restart đi qua `runAppIntent`)
- Modify: `packages/conversation-client/src/voice-session.ts` (nhận frame `app-intent`)
- Create: `apps/web/e2e/voice-control.spec.ts`
- Modify: `docs/conformance-traceability.md` (thêm T73; **không** đụng T66)

## Tests Before (viết trước, phải đỏ)

1. `packages/core/test/app-intents.spec.ts`:
   - `"matches every documented phrase to exactly one intent"` — 9 nhóm × 3 câu tiếng Việt + 1 câu tiếng Anh.
   - `"an app-shaped command that matches nothing says so and does nothing"` — bắt buộc có `refused`.
   - `"a work request that merely mentions settings is not an app intent"` — ví dụ
     "xem cài đặt của máy chủ này giúp tôi" → không phải intent, `isAppCommandShaped` trả `false`.
   - `"quitting the app always asks first"` — `app.quit` → `needs-confirmation`; 8 intent còn lại → `intent`.
   - `"a settings intent carries its tab, and a tab change without one is refused"`.
   - `"every intent has one Vietnamese read-back sentence"`.
   - `"a long command phrase wins over a short one"` — "thu nhỏ tối thiểu" thắng "thu nhỏ".
2. `apps/runtime/test/app-intents.spec.ts`:
   - `"the same intent from chat, click and voice produces the same audit kind"` — ba nguồn, ba event
     `app.intent` cùng kind, chỉ khác `source`.
   - `"a body without a source is refused"` — 400 `INVALID_SCHEMA`.
   - `"a quit intent is not executable until the confirmation route returns it"` — `POST /app-intents`
     trả `needs-confirmation` và **không** trả intent; `POST /app-intents/confirm` mới trả intent.
   - `"a confirmation token is single use"` — lần hai → 409 `CONFIRMATION_ALREADY_USED`.
   - `"an expired confirmation token is refused"` — 410 `CONFIRMATION_EXPIRED`.
   - `"the confirm route refuses a token minted for another principal"`.
   - `"a typed app command becomes an app.intent event with source chat"`.
   - `"a typed app-shaped command that matches nothing is answered without an agent turn"`.
   - `"a pending approval outranks a pending app-intent confirmation"`.
3. `apps/web/e2e/voice-control.spec.ts`:
   - **`"a spoken command and the same click open settings in the same state"`** — đây là test mang tên
     **T73** (panel Settings), không phải T66.
   - `"every command group is answered by the voice fixture"` — 9 nhóm, mỗi nhóm assert đúng hiệu ứng
     quan sát được (hoặc lời từ chối trung thực khi không có bridge).
   - `"a spoken quit does not close anything until the confirmation is spoken"` — sau câu lệnh, cửa sổ
     vẫn mở và **không** bridge call nào xảy ra; sau câu "đồng ý" mới có.
   - `"an app-shaped command that matches nothing leaves the app unchanged"` — state panel và URL trước/sau giống nhau.

## Tasks & Steps

### Task 5.1 — Contract app-intent

- **Goal**: một hình dạng dữ liệu cho intent, dùng chung ba nguồn, có chỗ cho token xác nhận.
- **Target files and symbols**: `packages/contracts/src/app-intents.ts` —
  `APP_INTENT_KINDS` (9 kind ở bảng trên), `settingsTabSchema = z.enum(["general","models","tools","devices","memory"])`,
  `appIntentSchema` (strictObject, `settings.tab` thiếu `tab` → refuse qua `.refine`),
  `appIntentSourceSchema = z.enum(["chat","click","voice"])`,
  `appIntentDecisionSchema` = union:
  `{ kind: "intent"; intent; requiresConfirmation: false; readBack }` |
  `{ kind: "needs-confirmation"; intent; readBack; confirmationToken }` |
  `{ kind: "refused"; say }`,
  `describeAppIntent(intent): string`.
- **Steps**:
  1. `describeAppIntent` trả câu tiếng Việt đọc lại được; `app.quit` →
     `"Tôi hiểu là bạn muốn thoát ứng dụng. Bạn xác nhận chứ?"`.
  2. Token nằm trong **schema**, nên cả ba nguồn đều nhận được nó (đây là chỗ bản trước thiếu).
  3. Export từ `index.ts`.
- **Success criteria**: `pnpm exec tsc -p tsconfig.json` xanh.
- **Verify**: `pnpm exec tsc -p tsconfig.json` exits 0.

### Task 5.2 — Bộ khớp câu nói và luật "dạng lệnh app"

- **Goal**: khớp tất định, không gọi model, và phân biệt được lệnh với câu hỏi.
- **Target files and symbols**: `packages/core/src/app-intents.ts` — `APP_COMMAND_VERBS`,
  `isAppCommandShaped(text): boolean`, `matchAppIntent(text): AppIntent | undefined`,
  `resolveAppIntent({ text?, intent? }): AppIntentDecision`.
- **Steps**:
  1. Bảng `PHRASES` với cả dạng có dấu và không dấu (theo đúng khuôn `interpretDecision` trong
     `voice-session.ts`).
  2. Chuẩn hoá rồi khớp **cụm dài nhất trước**; ghi comment nêu lý do ("thu nhỏ tối thiểu" thắng "thu nhỏ").
  3. `isAppCommandShaped`: `true` khi câu **bắt đầu** bằng một động từ trong `APP_COMMAND_VERBS` và có
     ≤ 8 từ (một mệnh lệnh ngắn). Câu dài có nhắc "cài đặt" ở giữa → `false`.
  4. `resolveAppIntent`: có `intent` → decision theo bảng; có `text` khớp → decision; `text` dạng lệnh
     mà không khớp → `{ kind: "refused", say }`; còn lại → `{ kind: "none" }` (để caller cho câu đó tới agent).
- **Success criteria**: 7 test của file core xanh.
- **Verify**: `pnpm exec vitest run packages/core/test/app-intents.spec.ts` exits 0.

### Task 5.3 — `deletePreference` và token xác nhận

- **Goal**: token xác nhận có chỗ lưu, hết hạn, và dùng một lần.
- **Target files and symbols**: `packages/core/src/preferences.ts` — `deletePreference(deps, { principalId, key, scope }): boolean`;
  `apps/runtime/src/app-intents.ts` — `mintConfirmation`, `consumeConfirmation`.
- **Steps**:
  1. `deletePreference` xoá thẳng dòng; trả `true` khi có xoá. Thêm test vào `packages/core/test/onboarding.spec.ts`.
  2. `consumeConfirmation({ db, principalId, token, now })` trả
     `{ ok: true; intent } | { ok: false; code: "CONFIRMATION_EXPIRED" | "CONFIRMATION_ALREADY_USED" | "CONFIRMATION_NOT_FOUND"; }`
     và **xoá token trong cùng transaction** khi thành công.
  3. Bind token với `{ kind, principalId, at }`; token của principal khác → `CONFIRMATION_NOT_FOUND`
     (không phân biệt với token không tồn tại).
- **Success criteria**: 4 test token xanh.
- **Verify**: `pnpm exec vitest run apps/runtime/test/app-intents.spec.ts packages/core/test/onboarding.spec.ts` exits 0.

### Task 5.4 — Audit dùng chung và hai route

- **Goal**: ba nguồn ghi cùng một loại event, nên không có đường thực thi thứ hai.
- **Target files and symbols**: `packages/core/src/app-intents.ts` (`recordAppIntentEvent`),
  `apps/runtime/src/gateway.ts` (hai route + nhánh nối chat trong route tin nhắn).
- **Steps**:
  1. `recordAppIntentEvent` dùng đúng `AppendEventInput`
     (`packages/storage/src/repositories.ts:171`): `{ eventId, kind: "app.intent", stream: "app.intent",
     nodeId, conversationId, document: { kind, tab, source, confirmed }, occurredAt }`.
  2. `POST /app-intents` body `{ text?, kind?, tab?, conversationId, source }`. Thiếu/không hợp lệ
     `source` → 400 `INVALID_SCHEMA`. Decision `refused`/`none` → trả `200 { decision }` và **không** ghi
     event (không hành động thì không có gì để audit).
  3. `POST /app-intents/confirm` như mô tả ở §Xác nhận thoát app; ghi event với `confirmed: true`.
  4. **Nối chat**: trong route tin nhắn, gọi `resolveAppIntent({ text })` **trước** khi tạo lượt; nếu
     `intent` → ghi event `source: "chat"` rồi trả decision như một message của host (không tạo lượt
     model); nếu `refused` → trả lời "chưa hiểu" như một message của host; nếu `none` → đi tiếp đường cũ.
  5. `settings.open` không có `tab` → mở tab đang dùng (mặc định `general`); ghi rõ trong comment để
     không ai phải đoán.
- **Success criteria**: 8 test runtime xanh.
- **Verify**: `pnpm exec vitest run apps/runtime/test/app-intents.spec.ts` exits 0.

### Task 5.5 — Voice đi qua cùng registry, xác nhận ở node

- **Goal**: câu nói khớp app-intent được xử lý như lệnh app, và thoát app không thể xảy ra bằng một câu.
- **Target files and symbols**: `apps/runtime/src/voice-session.ts` (hàm `answer`, danh sách frame).
- **Steps**:
  1. Trong `answer`, gọi `resolveAppIntent({ text })`. `intent` → phát frame
     `{ type: "app-intent", decision }` và trả `reply = readBack`; **không** tạo lượt agent.
  2. `needs-confirmation` → phát frame với decision đó (**không** có intent thực thi) và nhớ token đang
     chờ trong state của phiên; `reply = readBack`.
  3. Câu tiếp theo khi có token đang chờ: nếu không có approval nào đang chờ, dùng `interpretDecision`;
     `granted` → `consumeConfirmation` → phát frame `{ type: "app-intent", decision: { kind: "intent", … } }`;
     `denied` → xoá token, `reply` nói đã bỏ qua.
  4. `refused` → `reply` là câu "chưa hiểu"; `none` → để câu đó thành lượt agent như trước.
  5. Cập nhật doc-comment wire format đầu file: thêm `app-intent` vào danh sách node → client.
- **Success criteria**: journey 2, 3, 4 xanh.
- **Verify**: `pnpm test:e2e -- apps/web/e2e/voice-control.spec.ts` exits 0.

### Task 5.6 — Một hàm thực thi ở client cho cả ba nguồn

- **Goal**: click, chat và voice chạm cùng một action state; và T73 có bằng chứng.
- **Target files and symbols**: `packages/conversation-client/src/app-intents.ts` —
  `runAppIntent(decision, host: AppIntentHost)`, với
  `AppIntentHost = { openSettings(tab?): void; goHome(): void; openFilePicker(): void; endVoice(): void;
  minimiseWindow(): Promise<Outcome>; setMinimal(compact: boolean): Promise<Outcome>; quit(): Promise<Outcome> }`.
- **Steps**:
  1. Một `switch (intent.kind)` duy nhất; **không** có nhánh riêng cho voice. Hàm **không** nhận tham số
     xác nhận: nó chỉ chạy khi `decision.kind === "intent"`.
  2. `Conversation.tsx`: nút Settings và nút restart gọi `runAppIntent` qua cùng hàm (click cũng đi qua route).
  3. `voice-session.ts` (client): frame `app-intent` → **cùng** `runAppIntent`.
  4. Trình duyệt không có bridge: `window.*` và `app.quit` trả `{ ok: false, reason: "not-desktop" }` và
     UI nói rõ; không im lặng.
- **Success criteria**: journey 1 xanh; nhóm lệnh cửa sổ trong journey 2 trả lời trung thực.
- **Verify**: `pnpm test:e2e -- apps/web/e2e/voice-control.spec.ts` exits 0.

### Task 5.7 — T73 cho panel Settings (không đụng T66)

- **Goal**: ghi lại bằng chứng parity của đường "mở Settings" mà không mượn T-id của widget.
- **Target files and symbols**: `docs/conformance-traceability.md`.
- **Steps**:
  1. Thêm dòng `T73` vào bảng Acceptance tests:
     `"A spoken app command and the same click reach the same settings state"`, kèm tên test ở journey 1.
  2. **Không** sửa dòng T66 — T66 thuộc Phase 6.
  3. Chạy `pnpm run invariants` (invariant yêu cầu T01–T72 hiện diện và cho phép thêm T-id mới).
- **Success criteria**: `pnpm run invariants` xanh; T66 vẫn `NOT-IMPLEMENTED` sau phase này.
- **Verify**: `pnpm run invariants` exits 0 và `grep -n "^| T66" docs/conformance-traceability.md` in ra `NOT-IMPLEMENTED`.

## Refactor

Gom mọi `switch (intent.kind)` phía runtime vào `apps/runtime/src/app-intents.ts` để `gateway.ts` và
`voice-session.ts` chỉ gọi một hàm. Chạy lại **cùng** test.

## Tests After

`"a second confirmation for the same quit intent is refused"` và
`"a settings.open with no tab opens the default tab"`.

## Regression gate

```bash
pnpm verify && pnpm test:e2e
```

## Failure Protocol

Nếu bất kỳ bước Verify nào không đạt đúng điều kiện đã ghi, DỪNG phase này.
Không tự sửa kiểu đoán, không retry mù, không suy luận vòng qua thất bại.
Gọi subagent `kongming` để xin chỉ dẫn bước kế tiếp và truyền:
- phase và task id,
- những gì đã làm (các bước đã chạy),
- đúng lệnh đã chạy và toàn bộ output,
- điều kiện pass mà nó không đạt.
Áp dụng chỉ dẫn của kongming rồi chạy lại bước Verify.
Nếu không gọi được `kongming` trong môi trường này, DỪNG và báo lại đúng bằng chứng thất bại cho
người dùng. Không bao giờ tiếp tục bằng cách tự suy luận.

## Risk Assessment

- **Rủi ro**: registry khớp nhầm câu hỏi bình thường thành lệnh app. **Giảm thiểu**: luật
  `isAppCommandShaped` (mở đầu bằng động từ + ≤ 8 từ) có test hai phía, gồm một ca câu hỏi có nhắc "cài đặt".
- **Rủi ro**: nối chat vào registry làm mất lượt agent cho câu hỏi thật. **Giảm thiểu**: chỉ `intent` và
  `refused` chặn agent; `none` đi tiếp đường cũ; test riêng cho ca "câu hỏi có nhắc settings".
- **Rủi ro**: token xác nhận trở thành đường vòng để thoát app. **Giảm thiểu**: intent thực thi **chỉ**
  đến từ route confirm; frame voice không bao giờ mang intent thực thi; test replay và test "không bridge
  call nào trước lời xác nhận".

## Security Considerations

- Thoát app cần hai bước và token dùng một lần, bind principal; không có cửa sổ nào để một câu nói thoát app.
- Intent không cấp quyền mới: mở panel, đổi kích thước cửa sổ, mở hộp thoại file, hoặc thoát.
- Registry chỉ đọc câu người dùng nói/gõ hoặc click; không nhận intent từ nội dung do model sinh ra.
- Audit ghi `source`, `kind`, `confirmed`; không ghi nội dung câu nói.

## Ghi chú triển khai — những chỗ lệch so với phase này

Phase này đã làm xong **phần code** (task 5.1–5.6), còn **bằng chứng** (task 5.7 T73 + journey e2e) chưa
xong; lý do ở mục cuối. Các điểm lệch:

1. **Bỏ `transaction` trong `consumeConfirmation`.** `setPreference` mở transaction riêng và storage engine
   từ chối transaction lồng nhau. Hàm này chạy một mạch đồng bộ, không có `await`, trên node một tiến trình,
   nên không có gì ghi xen giữa lúc đọc và lúc ghi. Đây là lý do, không phải sự nhầm lẫn — và nó nằm trong
   doc-comment của hàm.
2. **Token đã dùng thì được đánh dấu, không xoá.** Plan ghi "xoá token trong cùng transaction khi thành
   công". Xoá như vậy làm lần dùng lại không phân biệt được với một token chưa từng tồn tại, mà hai ca đó
   cần hai câu trả lời khác nhau (409 so với 404) — chính test của plan đòi điều đó.
3. **`SETTINGS_TABS` không có `memory`.** Plan đặt `settingsTabSchema` với 5 tab để chuẩn bị cho Stage C.
   `SettingsPanel` chỉ có 4 tab; typecheck bắt được. Liệt kê một tab chưa tồn tại sẽ khiến câu "mở tab
   Memory" được hiểu, được đọc lại, rồi không mở gì cả. Câu từ chối tab nay suy ra từ `SETTINGS_TABS`.
   Phase 11 thêm tab và thêm vào danh sách cùng lúc.
4. **Voice không còn bắt buộc phải có `answer`.** Guard cũ chặn mọi câu nói khi node không dựng model
   turn, tức kênh điều khiển app bị buộc vào model. Nay chỉ nhánh agent mới cần `answer`.
5. **Luật nhận dạng câu lệnh chặt hơn plan.** Plan ghi "bắt đầu bằng một động từ điều khiển và ≤ 8 từ".
   Một động từ tiếng Việt thường cũng là từ thường, và bỏ dấu làm chúng trùng nhau (`thu` và `thủ`), nên
   luật đó từ chối cả câu "Thủ đô là Paris." — một test cũ bắt được. Nay: **cụm mở đầu hai từ** lấy từ
   chính bảng PHRASES, **hoặc** động từ điều khiển *đọc theo dấu* cộng với một danh từ thuộc về app.
   Hai nửa đều cần: chỉ động từ thì từ chối "mở tài liệu giúp tôi"; chỉ danh từ thì bắt mọi câu hỏi nhắc
   tới Settings.
6. **Nhánh chat phải nằm ở route streaming.** Composer gửi vào `/messages/stream` chứ không phải
   `/messages`. Ban đầu chỉ nối route thường, nên phần server xanh trong test của nó mà trên trình duyệt
   không làm gì. Hai route nay dùng chung một hàm quyết định.
7. **Test "approval đứng trước app-intent" viết lại.** Hai câu hỏi đó không thể cùng chờ: mỗi nhánh đều
   chặn câu tiếp theo. Test nay chốt đúng điều xảy ra được — một câu lệnh nói trong lúc approval đang chờ
   được đọc như câu trả lời chưa rõ, và registry không hề được hỏi.

## Bằng chứng còn thiếu và lý do

Task 5.7 (dòng T73) và journey e2e chưa làm được vì `FixtureLiveAdapter` trả về **một câu cố định**
(`USER_WORDS` trong `apps/runtime/src/voice-fixture.ts`), nên suite trình duyệt không thể "nói" một câu
lệnh app. Đường voice đã được chứng minh ở seam socket trong vitest (`voice-gateway.spec.ts`, 6 test mới,
gồm cả ca "approval đứng trước" và ca "lời xác nhận do node xử lý"). Journey e2e cần một trong hai:

- **(đề xuất)** một route chỉ tồn tại khi fixture được nạp (`CC_VOICE_FIXTURE=1`) để đặt câu kịch bản cho
  phiên kế tiếp — rẻ, một webServer, và tự nói rằng nó là fixture;
- hoặc một Playwright project thứ hai với webServer riêng chạy node bằng `CC_VOICE_FIXTURE_WORDS=...` —
  nhiều cấu hình hơn và thêm một lần boot node mỗi lần chạy suite.

Dòng T73 **phải** thêm sau khi journey có test thật, theo invariant của repo: ledger không được nêu tên
một test chưa tồn tại.

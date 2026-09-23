# App intents widgets.open / widgets.show

Trạng thái: **hoàn tất** (triển khai + kiểm chứng local).

## Ngữ cảnh và sở hữu

Đã có một control channel duy nhất: `packages/contracts/src/app-intents.ts` (9 kind, `APP_INTENT_KINDS`, `appIntentSchema`, `describeAppIntent`, `appIntentDecisionSchema`), matcher xác định trong `packages/core/src/app-intents.ts` (`CONTROL_VERBS`, `APP_NOUNS`, `APP_COMMAND_MAX_WORDS`, `isAppCommandShaped`, bảng phrase không dấu), executor trong trang ở `packages/conversation-client/src/app-intents.ts` (`runAppIntent`, `AppIntentHost`, `needsDesktop`), route node ở `apps/runtime/src/app-intents.ts` và `apps/runtime/src/gateway.ts`, và test `packages/conversation-client/test/app-intents.spec.ts`.

Sở hữu file phase này: `packages/contracts/src/app-intents.ts`, `packages/core/src/app-intents.ts`, `packages/conversation-client/src/app-intents.ts`, `packages/conversation-client/src/Conversation.tsx` (chỉ host method), `apps/runtime/src/main.ts` (chỉ `appIntentDepsFor`), test `packages/core/test/app-intents.spec.ts`, `packages/contracts/test`, `packages/conversation-client/test/app-intents.spec.ts`.

## Quyết định thiết kế

- Thêm hai kind `widgets.open` và `widgets.show`. `widgets.open` mở library ở `browse`. `widgets.show` mang thêm `definitionId?` và `family?`.
- **Không** để `@clarkcant/core` phụ thuộc catalog (sẽ tạo vòng `core → widget-catalog → data-canvas → core`, vì `packs/data-canvas/src/sample.ts` import `@clarkcant/core`). Matcher nhận bảng target qua tham số dependency, với **chữ ký tường minh** (finding #4; hiện tại `packages/core/src/app-intents.ts:299` là `matchAppIntent(text: string)` và `:337` là `resolveAppIntent({ text?, intent?, mintConfirmationToken })`, tức chưa có chỗ nhận thêm tham số):

  ```ts
  export interface WidgetTarget {
    phrase: string;
    definitionId?: string;
    family?: string;
  }
  export function matchAppIntent(text: string, options?: { widgetTargets?: readonly WidgetTarget[] }): AppIntentMatch | undefined;
  export function resolveAppIntent(input: { text?: string; intent?: AppIntent; mintConfirmationToken: () => ConfirmationToken; widgetTargets?: readonly WidgetTarget[] }): AppIntentDecision;
  ```

  `apps/runtime/src/main.ts` (`appIntentDepsFor`) dựng `widgetTargets` từ `@clarkcant/widget-catalog`. Nhờ vậy chỉ có **một** nguồn alias, `core` vẫn catalog-free, và matcher vẫn deterministic, không gọi model.
- `definitionId` validate bằng pattern `^[a-z][a-z0-9.-]*@\d+$` trong contracts (không cần contracts biết danh sách id); `family` validate bằng `^[a-z][a-z0-9-]*$`. Refine: hai trường này chỉ được xuất hiện khi `kind === "widgets.show"`.
- Cả hai kind đều **không** cần confirmation và **không** cần desktop: mở thư viện là hành vi xem, không có effect.
- **Ghi rõ quyết định về tiếng Việt:** `"xem"` cố ý **không** nằm trong `CONTROL_VERBS` (nó là work verb), nên `"cho tôi xem widget biểu đồ"` vẫn đi vào agent như một yêu cầu công việc - và kết quả đúng của sản phẩm là widget hiện trong hội thoại. Các câu dạng mệnh lệnh điều khiển app vẫn hoạt động: `"mở thư viện widget"`, `"hiện widget lịch"`, `"open widget library"`, `"show the calendar widget"`. Giữ nguyên luật cũ thay vì nới nó; ghi điều này vào docs và test cả hai hướng.

## Ma trận test (TDD)

1. `packages/contracts/test` (bổ sung): `appIntentSchema` chấp nhận `widgets.open`; chấp nhận `widgets.show` kèm/không kèm target; **từ chối** target trên `widgets.open`; từ chối `definitionId` sai pattern; `describeAppIntent` trả câu đọc lại cho cả hai kind (và `never`-guard vẫn biên dịch).
2. `packages/core/test/app-intents.spec.ts` (bổ sung):
   - `"mở thư viện widget"`, `"open widget library"`, `"show widget gallery"` ⇒ `widgets.open`.
   - `"hiện widget lịch"` / `"show the calendar widget"` kèm `widgetTargets` chứa phrase `lịch`/`calendar` ⇒ `widgets.show` với `definitionId: "canvas.calendar@1"`.
   - `"hiện widget media"` ⇒ `widgets.show` với `family: "media"` khi bảng target có family đó.
   - `"cho tôi xem widget biểu đồ"` ⇒ `{ kind: "none" }` (là work request, **không** bị refuse, **không** bị nuốt) - bảo vệ hồi quy của luật control-channel.
   - Câu dài quá `APP_COMMAND_MAX_WORDS` mở đầu bằng control verb ⇒ `none`.
   - Không có `widgetTargets` ⇒ `"hiện widget lịch"` vẫn trả `widgets.show` không target (mở library ở browse), không ném lỗi.
3. `packages/conversation-client/test/app-intents.spec.ts` (bổ sung): `runAppIntent` với `widgets.open` gọi `host.openWidgetLibrary("browse")`; `widgets.show` gọi kèm target; host thiếu method ⇒ không ném, trả `ran: false` với câu nói rõ (browser path nếu cần).
4. Voice parity: test khẳng định transcript đi qua **cùng** matcher `packages/core` (không có bảng phrase riêng trong `voice-session.ts`/`wake-word.ts`); kiểm tra bằng grep-cấu-trúc trong test invariant hoặc test hành vi dùng cùng input cho chat và voice.

Lệnh chạy:

```bash
pnpm exec vitest run packages/contracts/test packages/core/test packages/conversation-client/test/app-intents.spec.ts
```

## Thực hiện

1. `packages/contracts/src/app-intents.ts`: thêm 2 kind vào `APP_INTENT_KINDS`; thêm `definitionId`/`family` vào `appIntentSchema` với refine; cập nhật `describeAppIntent` (`"Tôi mở thư viện widget nhé."`, `"Tôi mở widget <tên> nhé."`); giữ `CONFIRMATION_REQUIRED_KINDS` nguyên.
2. `packages/core/src/app-intents.ts`: thêm `"thu vien widget"`, `"widget library"`, `"widget gallery"`, `"thu vien"` vào `APP_NOUNS`; thêm phrase cho `widgets.open`; thêm nhánh `widgets.show` resolve target dài nhất khớp trong `widgetTargets`; giữ nguyên luật `isAppCommandShaped`.
3. `packages/conversation-client/src/app-intents.ts`: `AppIntentHost.openWidgetLibrary(mode: "browse" | "develop", target?: { definitionId?: string; family?: string }): void`; thêm case vào `switch`; `widgets.*` không thuộc `needsDesktop`.
4. `Conversation.tsx`: hiện thực `openWidgetLibrary` trên host object (set state surface + mode + target).
5. `apps/runtime/src/main.ts` `appIntentDepsFor`: truyền `widgetTargets` dựng từ `@clarkcant/widget-catalog` (alias + displayName + family).
6. Kiểm tra đường voice: nếu voice đang gọi matcher qua route khác thì hợp nhất về route `app-intents` hiện có thay vì thêm nhánh mới.

## Kiểm chứng

- Test ở trên exit 0.
- `pnpm exec vitest run packages/core/test packages/contracts/test packages/conversation-client/test` exit 0.
- `pnpm run typecheck` exit 0 (đặc biệt các `never`-guard sau khi thêm kind).
- E2E phase 6: parity giữa typed command và click mở ra **cùng** `data-widget-library-mode` và cùng `selectedId`.

## Rủi ro và rollback

- `appIntentSchema` là `strictObject`: mọi caller gửi thêm field sẽ fail; kiểm tra `apps/runtime/src/app-intents.ts` và `gateway.ts` sau khi mở rộng.
- `never`-guard trong `describeAppIntent` và `runAppIntent` sẽ báo lỗi biên dịch nếu thiếu nhánh - đây là tín hiệu tốt, không được `as any` để né.
- Alias tiếng Việt trùng nhau (ví dụ `"bảng"` vừa là table vừa là từ chung) phải resolve theo phrase dài nhất; test case trùng để chốt hành vi.
- Rollback: revert contracts/core/client/runtime trong cùng commit; không có migration.

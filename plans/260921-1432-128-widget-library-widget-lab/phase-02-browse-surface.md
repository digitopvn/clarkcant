# Widget Library browse surface

Trạng thái: **hoàn tất** (triển khai + kiểm chứng local).

## Ngữ cảnh và sở hữu

`packages/conversation-client/src/Conversation.tsx` (2353 dòng) đã render `SettingsPanel` như một surface phủ lên trên timeline `open={...}` mà **không** unmount hội thoại; `MiniAppSurface` và `DetachedWidgetSurface` đi theo cùng nguyên tắc. `packages/conversation-client/src/Modal.tsx` cung cấp `Modal` với `aria-modal`, `Escape` và trả focus, nhưng library là utility surface toàn màn hình nên cần lớp riêng cùng hợp đồng focus.

Sở hữu file phase này: `packages/conversation-client/src/widget-library/**` (mới), `packages/conversation-client/src/Conversation.tsx` (chỉ phần mount surface + state), `packages/conversation-client/src/settings/SettingsPanel.tsx`, `packages/conversation-client/src/settings/ExtensionsSettings.tsx`, `packages/conversation-client/src/styles.ts`.

## Quyết định thiết kế

- Trạng thái surface tách thành `widget-library-state.ts` (thuần, test được trong Node, không DOM): `{ open, mode: "browse" | "develop", query, family, selectedId }` cùng reducer `applyLibraryAction`. Component chỉ đọc reducer này, nên phần logic filter/search/back là unit test được.
- Preview **không** tự tạo instance hay gọi host. `WidgetPreview` chỉ gọi `resolveRenderer(definitionId)` và truyền `props`/`dataset`/`state` từ fixture. `onAction` mặc định là `undefined`; khi fixture ở `mode: "read-only"` thì không truyền handler nào cả.
- Renderer không resolve được ⇒ hiển thị khối lỗi có `data-widget-preview-missing="<id>"` nói rõ definition nào thiếu renderer. Đây là hành vi cố ý: catalog phải fail nhìn thấy được, không che bằng ảnh hay mock.
- Mở/đóng chỉ đổi state của surface; không đụng `pins`, `blocks`, `instances`, `composer`, `voice`.

## Ma trận test (TDD)

Test mới `packages/conversation-client/test/widget-library.spec.ts` và `widget-library-reducer.spec.ts`:

1. Mở ở `mode: "browse"`; `escape`/`back` đóng và state `open === false`.
2. Search: `"lịch"` lọc còn `canvas.calendar@1`; `"bieu do"` khớp chart; query rác ⇒ danh sách rỗng kèm trạng thái rỗng (không phải lỗi).
3. Filter family `media` chỉ còn entry media; `all` trả hết.
4. Chọn một entry ⇒ `selectedId` set; back về catalog xoá `selectedId` nhưng giữ `query`/`family`.
5. Bất biến lifecycle: gọi reducer mở rồi đóng trả lại **đúng** state ban đầu (so sánh sâu), chứng minh không có field nào của hội thoại bị chạm.
6. Chọn một definition không có renderer (dựng bằng mock catalog) ⇒ state đánh dấu `missingRenderer`, không ném lỗi.

Browser E2E thêm vào `apps/web/e2e/widget-library.spec.ts` (chạy thật trong phase 6): mở từ Settings → Extensions, gallery hiện; tắt đi; text hội thoại vẫn còn; `data-widget-preview` có mặt cho table/chart/calendar/note/gallery.

## Thực hiện

1. `src/widget-library/widget-library-state.ts`: types + reducer + `visibleEntries(entries, state)` (dùng `searchCatalog` của `@clarkcant/widget-catalog`).
2. `src/widget-library/WidgetPreview.tsx`: resolve renderer qua `resolveRenderer(definitionId)`, chuyển `fixture.dataset` sang `RendererDataset` (`rows`, `freshness`, `updatedAt`), truyền `props`/`state` từ fixture, bọc trong khung có nhãn tên widget, khối lỗi khi thiếu renderer, và truyền `imageUrl` resolver local-only cho fixture media.
3. `src/widget-library/WidgetGallery.tsx`: lưới card (preview + tên + family + mô tả + provenance + status), điều hướng bằng bàn phím (roving tabindex hoặc button thật), `aria-label` cho từng card. **Card media/embed (`canvas.youtube@1`, `canvas.video@1`, `canvas.image@1`, `canvas.carousel@1`, `canvas.gallery@1`) không mount renderer thật trong grid** (finding #3): chúng hiển thị text alternative + affordance “xem khi mở”, và chỉ mount renderer thật ở detail view. Lý do: renderer production tạo `<iframe>` tới YouTube (`renderers.tsx:840`) và `<video>` (`:875`); mount đồng loạt trong grid sẽ phát sinh request bên thứ ba và tải media ngay khi chỉ muốn xem danh mục.
4. `src/widget-library/WidgetLibrarySurface.tsx`: header có nút đóng và ô search, dải family, thân gallery, `role="dialog"` + `aria-modal="true"` + `aria-labelledby`; `Escape` đóng; lưu và trả focus về phần tử đã mở nó; `data-widget-library` / `data-widget-library-mode` cho E2E.
5. Motion: dùng `panel`/`popover` helper từ `@clarkcant/design-tokens` cho enter/exit; tôn trọng `prefers-reduced-motion`.
6. `Conversation.tsx`: thêm state `widgetLibrary` và render `<WidgetLibrarySurface>` cạnh `SettingsPanel`; truyền callback mở library qua `SettingsPanel`.
7. `SettingsPanel.tsx` + `ExtensionsSettings.tsx`: thêm mục "Widget Library / Browse the interfaces Clark can use in conversation" với nút `Browse`.
8. `styles.ts`: class cho grid, card, thanh family, layout 320 px một cột và 3 cột ở desktop rộng.

## Kiểm chứng

- `pnpm exec vitest run packages/conversation-client/test` exit 0.
- `pnpm run typecheck` và `pnpm run lint` exit 0.
- Thủ công/Playwright: hội thoại có text, mở library, đóng, text còn nguyên; focus trở về nút `Browse`.
- `pnpm test:e2e -- apps/web/e2e/widget-library.spec.ts` exit 0 (phần gallery + conversation-mounted).

## Rủi ro và rollback

- Rủi ro lớn nhất là vô tình remount subtree hội thoại: giữ surface là **sibling** có điều kiện, không bọc `Conversation` trong nhánh `open ? ... : ...`.
- Nhiều widget preview cùng lúc có thể nặng; giới hạn số preview mount đồng thời và chỉ render chúng khi ở viewport hiện tại, không dùng ảnh giả.
- `Escape` phải đóng surface gần nhất và không đóng luôn Settings bên dưới; kiểm tra thứ tự listener.
- Rollback: xoá thư mục `widget-library/` và revert phần mount; các surface khác không bị ảnh hưởng.

# Widget Lab developer mode

Trạng thái: **hoàn tất** (triển khai + kiểm chứng local).

## Ngữ cảnh và sở hữu

`SettingsPanel` đã có tab `developer` với `DeveloperSettings.tsx` (108 dòng) - hiện chỉ báo cáo node id, pi settings, token specimens và không có control đổi hành vi. `packages/widget-cli/src/dev-shell.ts` đã có sẵn từ vựng preview (`DEV_VIEWPORTS`, `VIEWPORT_WIDTHS`, `DevTheme`, `reducedMotion`) và reducer thuần - phase này dùng lại ngữ nghĩa đó nhưng **không** copy code; module chung đã được tạo ở phase 1 (`@clarkcant/widget-catalog/preview`).

Sở hữu file phase này: `packages/conversation-client/src/widget-library/WidgetInspector.tsx`, `WidgetPropsForm.tsx`, `WidgetFixtureControls.tsx`, `WidgetDetail.tsx`; `packages/conversation-client/src/settings/SettingsPanel.tsx`, `DeveloperSettings.tsx`; test `packages/conversation-client/test/widget-lab.spec.ts`.

## Quyết định thiết kế

- Cùng một `WidgetLibrarySurface`, khác `mode`: `develop` mở thẳng inspector và diagnostics, `browse` giữ metadata implementation ở dạng thu gọn.
- Props form sinh từ `propsSchema` (subset: `string` với `maxLength`, `number`, `boolean`, `enum` của string) và **validate lại** props đã sửa bằng validator thuần import từ `@clarkcant/widget-catalog` (`validateProps`, một bản duy nhất, re-export qua `packages/widget-host/src/index.ts` cho `packages/widget-cli/src/conformance.ts`). **Cấm** `conversation-client` import root `@clarkcant/widget-host`, vì root đọc `node:crypto` (`packages/widget-host/src/index.ts:10`) và sẽ kéo Node API vào bundle browser (finding #1). Raw JSON chỉ là chế độ nâng cao, không phải đường mặc định.
- **Resolver ảnh local-only** (finding #6): Lab truyền `imageUrl` map `imageRef` → ảnh inline `data:` URL lấy từ fixture, không host/gateway/token (`RendererProps.imageUrl` ở `packages/conversation-client/src/renderers.tsx:63`). Không có resolver thì image/carousel/gallery/video luôn rơi vào text alternative (`:708`, `:752`, `:790`, `:837`) - Lab phải nói rõ đang ở trạng thái nào, không được ngụ ý đang hiện ảnh thật.
- Layout desktop 3 vùng: Catalog | Live Preview | Inspector. Dưới 900 px chuyển thành điều hướng tiến (Catalog → Detail → Inspector) với back rõ ràng, không nén 3 cột.
- Mọi control đều thật: viewport đổi bề rộng khung preview thật, theme đổi class theme thật, reduced-motion bật chế độ thật, fixture đổi props thật. Không có control nào chỉ đổi nhãn.

## Nội dung inspector

| Panel | Dữ liệu | Nguồn |
| --- | --- | --- |
| Props | form theo `propsSchema` + JSON nâng cao | `definition.propsSchema` |
| State | giá trị hiện tại, `stateSchema`, `stateVersion`, revision | `definition` + fixture `state` |
| Events | danh sách `eventSchemas` | `definition.eventSchemas` |
| Actions | tên, kind, có chạy được không, `effectCategories`, có cần approval | `definition` + `actionBindingSchema` |
| Semantic | `semanticDescription` + semantic view hiện tại | `definition` + `SemanticView` |
| Sizing | `compact`, `expanded`, `minHeight`, bề rộng viewport hiện tại | `definition.sizing` |
| Capabilities | `requestedCapabilities` (không lộ secret) | `definition.requestedCapabilities` |
| Fallback | `semanticDescription`, `textFallback` + preview trạng thái fallback | `definition` |

## Ma trận test (TDD)

`packages/conversation-client/test/widget-lab.spec.ts`:

1. `mode: "develop"` mở inspector mặc định; `mode: "browse"` thì không.
2. Đổi fixture ⇒ props của preview đổi theo fixture mới.
3. Đổi viewport ⇒ bề rộng khung preview đổi đúng theo `PREVIEW_WIDTHS`; giá trị lạ bị bỏ qua.
4. Đổi theme `light`/`dark`/`system` ⇒ thuộc tính theme của surface đổi.
5. Bật reduced-motion ⇒ surface đặt cờ reduced-motion, và không có animation vô hạn.
6. Props form: sửa một trường `string`, một `number`, một `boolean` ⇒ props preview cập nhật; nhập vi phạm `maxLength`/`required` ⇒ hiện lỗi validate và **không** áp dụng props sai.
7. Action panel: action thuộc `effectCategories` khác `read` được đánh dấu là không chạy được trong lab.
8. Narrow: state điều hướng chuyển sang tiến, back đưa về catalog.
9. Không có control nào render khi backend tương ứng không tồn tại (kiểm tra bằng cách assert control vắng mặt khi capability/action rỗng).

## Thực hiện

1. `WidgetFixtureControls.tsx`: selectors fixture/viewport/theme/reduced-motion, đọc nhãn từ `@clarkcant/widget-catalog/preview`.
2. `WidgetPropsForm.tsx`: sinh input từ `propsSchema`, validate trước khi commit.
3. `WidgetInspector.tsx`: các panel ở bảng trên, collapse/expand, mỗi panel có `data-inspector-panel="<name>"` cho E2E.
4. `WidgetDetail.tsx`: ghép preview + controls + inspector; layout responsive.
5. `SettingsPanel.tsx` + `DeveloperSettings.tsx`: thêm mục "Widget Lab / Preview fixtures, props, state, events, semantic output, sizing, accessibility" với nút `Open Lab` mở `mode: "develop"`.
6. Cập nhật `src/widget-library/WidgetLibrarySurface.tsx` để nhận `mode` và render detail layout.

## Kiểm chứng

- `pnpm exec vitest run packages/conversation-client/test` exit 0.
- `pnpm run typecheck` exit 0.
- Playwright (phase 6): mở Lab từ Settings → Developer; đổi viewport/fixture/reduced-motion/theme cho `canvas.table@1` và `canvas.line@1`; assert bề rộng khung và thuộc tính thật đổi theo.
- Kiểm tra thủ công 320 px: điều hướng tiến hoạt động, không có cột bị nén.

## Rủi ro và rollback

- Sinh form từ JSON Schema dễ phình thành một form engine; chỉ hỗ trợ subset đã nêu và hiển thị JSON nâng cao cho phần còn lại, không cố bao phủ mọi keyword.
- Props sửa tay có thể làm renderer ném lỗi; preview phải bọc error boundary cục bộ để một widget hỏng không làm sập surface, và lỗi đó phải hiện rõ.
- Rollback: bỏ các component Lab và hai mục Settings; browse mode vẫn nguyên vì dùng chung surface với `mode` mặc định.

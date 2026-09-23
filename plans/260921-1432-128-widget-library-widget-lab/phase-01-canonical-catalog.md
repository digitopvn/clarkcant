# Catalog chuẩn và fixture xác định

Trạng thái: **hoàn tất** (triển khai + kiểm chứng local).

## Ngữ cảnh và sở hữu

Trước phase này metadata catalog nằm rải rác: descriptor trong `packs/data-canvas/src/index.ts`, map renderer trong `packages/conversation-client/src/renderers.tsx` (`CATALOG`, `resolveRenderer`), map family trong `FAMILY_BY_DEFINITION`, recipe mẫu trong `packs/data-canvas/src/sample.ts`, và `canvas.note@1` chỉ được khai báo trong `sample.ts`.

Sở hữu file: `packages/widget-catalog/**` (mới), `packs/data-canvas/src/index.ts`, `packs/data-canvas/src/sample.ts`, `packages/contracts/src/widgets.ts`, `packages/conversation-client/test/catalog-coverage.spec.ts`, `vitest.config.ts`, `tsconfig.json`, `tsconfig.web.json`, `packages/conversation-client/package.json`.

## Quyết định thiết kế (đã chốt sau red-team)

- `packages/widget-catalog/` là **lớp discovery duy nhất**: thuần dữ liệu, không React, không `node:`. Nó import `WIDGETS`/`FAMILY_BY_DEFINITION` từ `@clarkcant/data-canvas`.
- `FAMILY_BY_DEFINITION` **ở lại** pack; không tạo map family thứ hai.
- **`canvas.note@1` KHÔNG vào `WIDGETS`** (R6). `WIDGETS` là vocab view mà runtime biến thành thứ model được phép gọi (`apps/runtime/src/services.ts`), nên thêm một widget vào đó là thay đổi bề mặt model, không phải refactor metadata. `widget-catalog` import `NOTE_DEFINITION` từ `@clarkcant/data-canvas/sample` ⇒ vẫn **một nguồn định nghĩa duy nhất**, và family của note do metadata của `widget-catalog` cung cấp (`META["canvas.note@1"].family`), không thêm vào `FAMILY_BY_DEFINITION` (sẽ làm stale-family test fail).
- Fixture schema nằm ở `@clarkcant/contracts` (`widgetFixtureSchema`) để browser client và `widget-cli` (Node) dùng chung hợp đồng.
- **Validator props thuần ở `packages/widget-catalog/src/validate-props.ts`** (R1 của bản in-context, giữ nguyên hiệu lực): root của `@clarkcant/widget-host` đọc `node:crypto` (`packages/widget-host/src/index.ts:10`) nên browser **không được** import root đó. Việc `widget-host` re-export validator từ `widget-catalog` là bước của phase 3, khi có consumer thật.
- **`canvas.overview@1` là container**, không thuộc `libraryEntries()` và không bị yêu cầu fixture.
- **Cắt `coverage.ts`** (R7): issue chỉ nói developer mode *có thể* hiển thị coverage, và repo đã có cơ chế coverage riêng. Cắt để tránh cơ chế thứ hai không ai dùng.
- **`exports` có `"./preview"`** (R3) vì Lab (browser) và `widget-cli` (Node) đều import subpath này. Đăng ký bằng alias **exact-match regex** trong `vitest.config.ts` (mẫu đã dùng cho `data-canvas` và `widget-host/session`), **không** dùng alias prefix — alias prefix sẽ rewrite `@clarkcant/widget-catalog/preview` thành đường dẫn không tồn tại.

## Hợp đồng dữ liệu

```ts
export interface WidgetCatalogEntry {
  definition: WidgetDefinition;
  family: string;
  displayName: string;
  description: string;
  tags: readonly string[];
  aliases: readonly string[];
  source: "builtin" | "installed" | "local";
  status: "stable" | "experimental";
  fixtures: readonly WidgetFixture[];
}
```

`WidgetFixture` và `FixtureDataset` sống ở `@clarkcant/contracts`. `dataset.source` chỉ nhận `"sample" | "cached"`: đó là hai giá trị freshness mà một fixture **được phép khai báo trung thực** — fixture không bao giờ là `live`, và `unknown` là trạng thái không có dữ liệu chứ không phải một fixture (R13).

**Luật bind (finding #2 của bản in-context, giữ nguyên):** khi `fixture.dataset` có mặt, `fixture.props.datasetRef` **phải** bằng `fixture.dataset.datasetId`; `WidgetPreview` chuyển `FixtureDataset` → `RendererDataset` (`rows`, `freshness`, `updatedAt`) trước khi truyền cho renderer, vì renderer nhận rows qua prop `dataset` (`packages/conversation-client/src/renderers.tsx:52`) chứ không đọc `datasetRef`. Ghi chú từ red-team (R9): bind là **kiểm tra nhất quán**; điều thật sự chịu lực là fixture `normal` phải có `dataset.rows` không rỗng để renderer không rơi vào `data-widget-unavailable` — điều này được assert ở E2E phase 6.

## Ma trận test (TDD)

| File | Nội dung |
| --- | --- |
| `test/registry.spec.ts` | phủ mọi definition (+ note), metadata tường minh cho từng id, displayName/description không rỗng, khớp family map, `source`/`status` hợp lệ, container ngoài `libraryEntries()`, `catalogEntry()` trả `undefined` cho id lạ, `catalogFamilies()` bỏ `layout` |
| `test/fixtures.spec.ts` | mọi entry library-visible có ≥1 fixture; fixture có `id`/`label`/`props`; props hợp lệ theo `propsSchema`; dataset-backed bind đúng; **test âm** cho fixture lệch bind; mỗi widget có fixture `*normal`; `imageRef` resolve được qua `FIXTURE_PICTURES` |
| `test/search.spec.ts` | khớp tên có dấu/không dấu (`lịch`/`lich`, `bieu do`), id, family, tag; rỗng ⇒ toàn bộ; rác ⇒ rỗng; `đ` được fold; container không xuất hiện trong kết quả của library view |
| `test/preview.spec.ts` | reducer thuần: fixture/viewport/theme/reduced-motion; giá trị lạ bị bỏ qua; `PREVIEW_WIDTHS["320"] === 320` |
| `packages/conversation-client/test/catalog-coverage.spec.ts` | bất biến cũ giữ nguyên (family/renderer/semantic/stale-family) |

Không có `coverage.spec.ts` (đã cắt theo R7). Không có `browser-safety.spec.ts` (R20): gate graph `browser-entries-avoid-node-builtins` trong `tools/check-invariants.mjs` đã phủ đúng việc này và đang PASS với 96 module — thêm một bản scan source-level nữa là bản thay thế yếu hơn, không phải bổ sung.

Lệnh:

```bash
pnpm exec vitest run packages/widget-catalog/test packs/data-canvas packages/conversation-client/test/catalog-coverage.spec.ts
pnpm run typecheck
pnpm run invariants
```

## Thực hiện (đã xong)

1. `packages/widget-catalog/package.json` — `exports` gồm `"."` và `"./preview"`, dependency `workspace:*` (`@clarkcant/contracts`, `@clarkcant/data-canvas`), đủ `clarkcant.phase`/`status`/`blueprint`.
2. `packages/contracts/src/widgets.ts` — `fixtureDatasetSchema`, `widgetFixtureSchema`, type tương ứng.
3. `src/registry.ts` — `WidgetCatalogEntry`, `META` (displayName/tags/aliases/status/family-override), `CATALOG_DEFINITIONS` = `[...WIDGETS, NOTE_DEFINITION]`, `CATALOG_ENTRIES`, `catalogMetaIds()`, `catalogEntry()`, `libraryEntries()`, `catalogFamilies()`, `CONTAINER_DEFINITION_IDS`.
4. `src/fixtures.ts` — fixture xác định cho từng definition + `FIXTURE_PICTURES` (ảnh inline `data:` URL, không host/gateway/token).
5. `src/search.ts` — chuẩn hoá bỏ dấu (fold cả `đ`), chấm điểm id > alias > displayName > family > tag > description.
6. `src/preview.ts` — `PREVIEW_VIEWPORTS`/`PREVIEW_WIDTHS`/`PREVIEW_THEMES` + reducer `applyPreviewAction`.
7. `src/validate-props.ts` — implementation thuần của `validateProps`.
8. `src/index.ts` — barrel export.
9. Đăng ký: `vitest.config.ts` (alias exact-match cho bare name **và** `/preview`), `tsconfig.json`, `tsconfig.web.json`, `packages/conversation-client/package.json`.
10. `packs/data-canvas` giữ nguyên `WIDGETS`/`FAMILY_BY_DEFINITION`; `sample.ts` giữ `NOTE_DEFINITION` (kèm comment vì sao nó không nằm trong `WIDGETS`).

## Kiểm chứng (đã chạy)

- `pnpm exec vitest run packages/widget-catalog/test packs/data-canvas packages/conversation-client/test/catalog-coverage.spec.ts` → **5 file, 40 test PASS, 0 fail**.
- `pnpm run typecheck` → exit 0 (cả `tsconfig.json` và `tsconfig.web.json`).
- `pnpm run invariants` → **8/8 PASS**, gồm `pinned-dependency-specifiers` (96 specifier) và `browser-entries-avoid-node-builtins` (96 module).

## Rủi ro và rollback

- Thêm dependency edge `widget-catalog → data-canvas/sample` là chủ ý và đã được `browser-entries-avoid-node-builtins` kiểm chứng: `sample.ts` chỉ import **type** từ `@clarkcant/core` nên bị xoá khi transform.
- `canvas.note@1` là entry duy nhất có family từ metadata của catalog chứ không từ `FAMILY_BY_DEFINITION`; test registry assert cả hai chiều để không ai "sửa" bằng cách thêm nó vào `WIDGETS`.
- Rollback: xoá `packages/widget-catalog/` và revert các file đã liệt kê; không migration, không dữ liệu người dùng.

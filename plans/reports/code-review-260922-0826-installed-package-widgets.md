# Code review — widget do package đã cài khai báo (#132)

- **Ngày:** 2026-09-22
- **Branch:** `feat/installed-package-widgets`, 6 commit, rebase sạch trên `origin/main` (`026d061`)
- **Issue:** digitopvn/clarkcant#132 — expose package widget definitions so installed packages can be catalog entries
- **Trạng thái:** sẵn sàng ship; không có finding Critical hoặc Important

## Phạm vi

Widget mà một package đã cài khai báo trở thành card thật trong Widget Library, vẽ bằng chính renderer
production. Sáu commit theo scope:

| Commit | Nội dung |
|---|---|
| `ab179fd` | `feat(core)`: đọc definition + fixture của package đã cài (`installedWidgets`) |
| `bc519a0` | `feat(core)`: fixture của package mang được dataset |
| `00a277c` | `fix(runtime)`: tìm lại package cài từ đĩa, báo danh tính của chính nó |
| `03af801` | `feat(conversation-client)`: card id namespace cho widget của package |
| `18e57c5` | `test(web)`: journey E2E cho đường installed |
| `9dfc20d` | `docs(widget-development)`: đường installed và file dataset |

## Bằng chứng kiểm chứng

- `pnpm verify:full` exit **0**: invariants **9/9**, typecheck, eslint, **2233 unit test passed / 7 skipped**
  (184 file), browser suite **127 passed / 1 skipped / 0 failed** (5.5 phút). Không có dòng `×` hay `FAIL Test`
  nào trong log.
- `apps/web/e2e/widget-library.spec.ts`: **9/9** journey, gồm journey mới *an installed package's widget becomes
  a card, rendered by the catalog*.
- Focused: 402 test conversation-client + widget-catalog, 10 test `installed-widgets`, 7 test route.

## Quyết định thiết kế

**Card id được namespace.** `CATALOG` trong `renderers.tsx` có 14 definition id vẽ được; catalog registry liệt kê
15 id và chứa trọn 14 id đó — nên **mọi** id vẽ được đã thuộc catalog, và luật "catalog thắng khi trùng" loại
package trong mọi trường hợp chứ không phải cá biệt. `WidgetCatalogEntry` vì vậy có `cardId`: bằng
`definition.id` với entry của catalog, bằng `<packageId>/<definitionId>` với widget của package. Việc vẽ vẫn
resolve từ `definition.id`, nên vẫn đúng một renderer cho mỗi id; luật catalog-thắng được **bỏ** vì không còn
trùng để thắng, và card của catalog vẫn hiện bên cạnh.

**Dataset là file riêng.** Renderer đọc dataset từ *fixture*, không từ props (`WidgetPreview.tsx`), nên
`fixtures/<name>.dataset.json` đi kèm `fixtures/<name>.json` và node đọc cặp đó thành một `WidgetFixture`.
Validate bằng đúng `fixtureDatasetSchema` mà catalog dùng; file sai schema bị **nêu tên** trong `problems` và
không được gắn vào gì cả.

**Danh tính báo về là danh tính package khai báo.** Một lần cài từ đĩa ghi `packageId` là chính đường dẫn
(`resolvePackageSource`, `packages/core/src/package-sources.ts:121-127`). Báo đường dẫn đó sẽ đặt một đường dẫn
filesystem vào chỗ của một cái tên, nên route dùng packageId/version từ directory entry.

**Cổng renderer nằm ở client.** `canRender` = `resolveRenderer` resolvable. Node chỉ trả data, không trả
renderer; một ý kiến thứ hai ở node sẽ lệch khỏi ý kiến duy nhất đang có.

## Ba bug thật, chỉ E2E bắt được

1. **Lookup luôn thất bại cho package cài từ đĩa.** Nguồn local ghi `packageId = source.path`,
   `version = "0.0.0-local"`, nên tìm theo `(packageId, version)` **luôn** trả `NOT_IN_DIRECTORY`. Sửa bằng
   fallback hẹp (`source.kind === "local" && source.path === packageId`) + 1 test khẳng định.
2. **Route install bắt buộc `localDigest`** (`LOCAL_DIGEST_REQUIRED`) và **không có nơi nào trong repo tính nó**;
   với nguồn local digest là *định danh*, không phải để đối chiếu.
3. **Một lần recon trước đó của tôi sai** khi nói 12/14 renderer id đã là catalog entry và dataset là blocker.
   Số đúng là 14/14 id vẽ được đều thuộc catalog. Ghi lại vì quyết định thiết kế dựa vào nó.

## Finding còn lại (Minor, đã chấp nhận)

- **M1 — card id có thể mơ hồ về mặt lý thuyết.** `widgetDefinitionSchema.id` không có pattern, nên packageId
  `a` + definitionId `b/c` và packageId `a/b` + definitionId `c` cho cùng một cardId. Không reachable từ dữ liệu
  hợp lệ hiện tại (facet id phải khớp manifest, manifest id do directory kiểm), nhưng nếu sau này có pattern thì
  nên chặn `/` trong một trong hai thành phần.
- **M2 — hai tên cho một package.** `listInstalledPackages` (provenance) vẫn hiện đường dẫn làm packageId
  (`…/chart-widget@0.0.0-local`) trong khi thư viện hiện danh tính khai báo (`com.example.chart-widget`). Đây là
  hệ quả của đường *install*, không phải đường đọc, nên chưa sửa trong #132; nên thành follow-up.
- **M3 — widget `isolated-app` không thành card.** Một package scaffold bằng `clark widget init` khai báo
  `renderer: "isolated-app"`, không có renderer trong bản build này, nên bị cổng loại và **nêu tên** trong mục
  "phần chưa xem được". Đúng như thiết kế và đã có note, nhưng là điều author cần đọc trước.

## Việc chưa làm

- `docs/conformance-traceability.md` **không** được nâng trạng thái T-id/V-id nào: thay đổi này không thêm test
  conformance được đặt tên trong bảng đó.
- Chưa có test nào chạy `installedWidgets` trên một package có hai widget cùng lúc với dataset khác nhau; hiện
  phủ một widget + hai fixture (`default` có dataset, `empty` không).

## Rủi ro đã biết

Không có rủi ro bảo mật mới: route mới giống route `/packages/.../files` (token guard), chỉ trả data đã đọc từ
package local nằm trong directory index, và không trả đường dẫn. Không nới lane trust nào, không thêm đường
thực thi nào, không cho package đóng góp code renderer.

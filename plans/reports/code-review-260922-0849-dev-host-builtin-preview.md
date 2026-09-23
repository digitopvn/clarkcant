# Code review — dev host xem được widget của catalog (#133)

- **Ngày:** 2026-09-22
- **Branch:** `feat/widget-dev-builtin`, 6 commit, dựa trên `origin/main` (`5d8ddb5`)
- **Issue:** digitopvn/clarkcant#133 — let the dev host preview catalog renderers (phương án A: làm thật)
- **Trạng thái:** sẵn sàng ship; không có finding Critical hoặc Important

## Phạm vi

`clark widget dev --builtin <definitionId>` chạy **cùng** shell và **cùng** frame policy như chế độ package, nhưng
vẽ một widget của catalog bằng **chính** `resolveRenderer` của production. Sáu commit:

| Commit | Nội dung |
|---|---|
| `d623946` | Entry `catalog-runtime.tsx`; `vite`/`react`/`react-dom` trong `widget-cli`; entry thứ ba vào invariant browser |
| `dace3a2` | Dev host dựng shell + frame + module graph qua vite middleware; cờ `--builtin` |
| `cc8019d` | Docs §16 `dev`, §23.5, manifest hash |
| `61dc5ca` | Sửa `declare global` (namespace) và import thừa |
| `6ff2b6d` | Một discriminator duy nhất cho host builtin; nhánh vite trả 503 thay vì treo request |
| `4a7edd7` | Docs: chế độ builtin không tự reload |

13 file, +454/−26.

## Bằng chứng kiểm chứng

- `pnpm verify:full` exit **0**: invariants **9/9**, typecheck, eslint, **2244 unit test passed / 7 skipped**
  (185 file), browser suite **127 passed / 1 skipped / 0 failed** (4.3 phút).
- `packages/widget-cli/test`: **70 passed**, gồm 11 test mới — 5 test thuần cho `catalog-target.ts` và 6 test
  HTTP cho dev host.
- **Bằng browser thật** (điều #133 tồn tại để làm, và thứ mà test HTTP không chứng minh được): chạy
  `clark widget dev --builtin canvas.line@1`, mở bằng Chrome — frame sandbox vẽ **biểu đồ đường với dữ liệu thật**
  (W36–W40: 128/141/137/164/158, tiêu đề "Số lần chạy theo tuần", kèm text alternative), cùng bộ điều khiển
  fixture/viewport/theme/reduced-motion. Console chỉ có một 404 là `/favicon.ico`, thứ chế độ package cũng không
  phục vụ.
- **Đúng id mà tiêu chí chấp nhận nêu tên:** `--builtin canvas.table@1` nêu đúng entry, đưa ra 3 fixture của nó,
  frame mang `{"definitionId":"canvas.table@1","fixtureId":"table.normal"}`, module phục vụ `200 text/javascript`.

## Quyết định thiết kế

**Vite phục vụ module từ source workspace, không có bước build.** `catalog-runtime.tsx` được Vite transform trực
tiếp, nên frame tải đúng thứ hội thoại dùng, không có artifact nào phải commit và không có bước build nào để
quên. Đây là lý do chọn middleware mode thay vì prebuild vào `dist/`.

**Shell, state machine và frame policy dùng chung.** Chỉ nguồn dữ liệu khác: `packageSource` vs `catalogSource`
trả về cùng một `ShellSource`. Không có shell thứ hai, nên không có chỗ thứ hai để sandbox bị nới.

**Logic thuần nằm trong `.ts`, chỉ mount nằm trong `.tsx`.** `catalogTarget` và `catalogFrameHtml` ở
`catalog-target.ts` nên test được không cần browser **và** được typecheck bởi config Node. Đây không chỉ là gu:
`.tsx` trong `packages/*/src` không được typecheck ở đâu cả, nên tách ra làm phần quyết định vẫn được kiểm.

**Id lạ bị từ chối lúc khởi động, kèm tên.** `catalogSource` resolve qua chính catalog thay vì tin tham số, nên
`--builtin canvas.nope@1` fail ngay ở CLI chứ không phải trong browser.

## Ba lỗi thật mà cổng kiểm chứng bắt được

1. **`pnpm verify` thất bại ở eslint:** `declare global` trong `catalog-runtime.tsx` là một namespace, và
   workspace chạy TypeScript bằng **strip types** nên không thực thi được. Sửa bằng cast; luật này tồn tại đúng
   vì lý do đó.
2. **`catalogEntry` import thừa** trong `dev-host.ts` sau khi tôi chuyển sang `catalogTarget`.
3. **Tự soát diff tìm thêm ba điểm**, đều đã sửa: điều kiện **chết**
   (`source.root === undefined || vite !== undefined` — `vite` chỉ tồn tại khi `source.root === undefined`, nên vế
   thứ hai không bao giờ đúng một mình); hai tên cho cùng một giá trị (`root`/`packageRoot`); và một nhánh trả về
   **không có response** khi vite vắng, tức request treo — nay trả 503 kèm lý do.

Ngoài ra một lượt `verify:full` đã bị **vứt bỏ và chạy lại** vì tôi sửa file giữa chừng; một lượt mà input đổi
giữa đường không phải bằng chứng.

## Finding còn lại (Minor, đã chấp nhận)

- **M1 — không tự reload.** Chế độ package theo dõi thư mục và báo qua `/dev/events`; frame của catalog chưa nối
  vào cơ chế đó, nên phải refresh thủ công. Đã ghi rõ trong `docs/widget-development.md` §23.5 như một khác biệt
  đã biết, không phải hành vi ngầm.
- **M2 — dev host không có browser E2E.** Đây là giới hạn **có từ trước**: `dev-host.spec.ts` tự nói rằng in-page
  script là phần chỉ browser chạy được. Tôi giữ nguyên ranh giới đó thay vì nới nó trong PR này, và bù bằng một
  lượt kiểm bằng Chrome thật (ghi ở trên).
- **M3 — `dir` của CLI suy ra bằng "đối số đầu không bắt đầu bằng `--`".** Nên `clark widget dev --port 4000` đặt
  `dir = "4000"`. Đây là lỗi **có sẵn**, không phải do PR này, và `--builtin` không bị ảnh hưởng vì chế độ builtin
  không đọc `dir`. Nên thành follow-up riêng thay vì sửa lén trong PR này.

## Việc chưa làm

- `docs/conformance-traceability.md` **không** được nâng trạng thái T-id/V-id nào: thay đổi này không thêm
  conformance test được đặt tên trong bảng đó.
- `vite`/`@vitejs/plugin-react`/`react`/`react-dom` trở thành dependency **runtime** của `widget-cli`. Đó là hệ quả
  thật của việc chọn middleware mode và đáng biết khi đọc `package.json`: CLI này không còn là CLI nhẹ.

## Rủi ro đã biết

Không nới lane trust nào. Frame vẫn `sandbox="allow-scripts"` (không `allow-same-origin`), cùng policy với chế độ
package; code chạy trong frame là renderer **của chính repo**, không phải code của package. Route mới không đọc
file ngoài `CLI_ROOT` của Vite, và nhánh phục vụ file package vẫn giữ nguyên kiểm tra "trong root".

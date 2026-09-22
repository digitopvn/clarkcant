# Code review — danh tính của một package local (#142)

- **Ngày:** 2026-09-22
- **Branch:** `fix-local-package-identity`, 1 commit (`b130479`), rebase trên `origin/main` (`2c11b53`)
- **Issue:** digitopvn/clarkcant#142
- **Trạng thái:** sẵn sàng ship; không có finding Critical hoặc Important

## Phạm vi

Với một nguồn **local**, `resolvePackageSource` trả về chính **đường dẫn** làm `packageId` và `0.0.0-local` làm
`version`, vì một nguồn không có danh tính đã publish thì không có gì khác để gọi tên. Nhưng một đường dẫn local
**thường có** tên: directory index liệt kê nó. Nên một package có hai tên — listing nói
`com.example.chart-widget`, còn row đã cài nói `apps/web/e2e/fixtures/chart-widget` — và cùng một người được hiện
cả hai. Hệ quả kèm theo: route `/packages/widgets` của #132 phải có một fallback tìm entry theo `source.path` chỉ
để tìm lại được package đã cài.

## Thay đổi

- Nhánh local của `resolvePackageSource` tìm entry trong `input.directory` có
  `source.kind === "local" && source.path === source.path`, và lấy `packageId`/`version` từ đó.
- Một đường dẫn **không** được liệt kê vẫn cài được như trước và giữ đường dẫn làm tên: nó không có tên nào tốt
  hơn, và hành vi đó đang chạy hôm nay nên không được làm hỏng.
- `digest` vẫn là `input.localDigest` (hash của chính byte trên đĩa do caller tính), **không** phải `entry.digest`
  đã publish. Hai thứ mô tả hai chuyện khác nhau, và đây là một lần cài local.
- Không gate theo host cho nguồn local (giữ nguyên hành vi cũ): một listing dựng cho máy khác vẫn gọi đúng tên
  những byte đang nằm trên máy này, và danh tính không phải là quyền.
- Fallback theo `source.path` trong route `/packages/widgets` **ở lại**, và docs nay nói rõ vì sao: các row
  `package_generations` đã ghi đường dẫn từ trước vẫn còn trong DB, nên xoá fallback sẽ khiến chúng báo
  `NOT_IN_DIRECTORY` vĩnh viễn.
- `docs/widget-development.md` §23.8 viết lại đoạn danh tính; `docs/manifest.json` cập nhật bytes + sha256
  (28254, `97d7f12d…`).

## Bằng chứng kiểm chứng

Chạy trên cây **đã rebase** trên `origin/main`:

- `pnpm verify:full` exit **0**: invariants **9/9**, typecheck, eslint, **2288 unit passed / 7 skipped**
  (186 file), browser suite **127 passed / 1 skipped / 0 failed**.
- 5 test mới, trong đó ba test đáng kể:
  - `package-sources.spec.ts` — lấy tên từ listing; giữ đường dẫn khi không được liệt kê; khớp entry **theo đường
    dẫn** chứ không lấy entry local đầu tiên (fixture có hai entry local để ca này có nghĩa).
  - `install-from-source.spec.ts` — **đúng tiêu chí chấp nhận**: cài từ nguồn local rồi khẳng định
    `listInstalledPackages` báo `com.example.calendar@1.2.0`, tức **cùng một tên** với listing, và digest vẫn là
    hash của byte trên đĩa.

## Một sai lầm tôi đã tự bắt được, và cách bắt

Tôi định bỏ qua việc chạy lại `verify:full` sau rebase, với lập luận rằng #143 chạm tập file **rời** với #142 nên
cây rebase = cây `main` đã xanh + thay đổi đã được kiểm. Tôi viết lập luận đó ra, rồi **kiểm nó bằng lệnh**
(`git diff --name-only` cho hai tập rồi giao lại) thay vì tin vào trí nhớ — và lập luận **sai**:
`packages/core/test/install-from-source.spec.ts` nằm trong **cả hai** tập.

Lý do sâu hơn: `286b1d9..2c11b53` trên `main` **không** chỉ chứa commit của tôi, mà còn `e0871ae` (PR hợp nhất
kiến trúc #125, chạm `capability-host`, `contracts/install.ts`, `core/install-from-source.ts`,
`install-lifecycle.ts`, `runtime/gateway.ts`, `pnpm-lock.yaml`). Nếu tôi tin trí nhớ, tôi đã ship một cây **chưa
hề được kiểm chứng** và gọi nó là đã kiểm.

Sau khi rebase tôi đã chạy lại `verify:full` trên cây thật (số liệu ở trên), và kiểm thêm rằng fix còn nguyên và
vẫn đi đúng đường: `install-from-source.ts:146-147` và `:230` dựng danh tính từ `resolved.resolved.packageId`, nên
giá trị mới chảy thẳng vào row đã cài; và `e0871ae` **không** chạm `packages/core/src/package-sources.ts`, nên
không có hai nguồn sự thật cho nhánh local.

## Finding còn lại (Minor, đã chấp nhận)

- **M1 — dữ liệu cũ không được migrate.** Các row đã ghi đường dẫn làm `package_id` vẫn hiện đường dẫn cho tới khi
  package đó được cài lại. Sửa nó cần một migration ghi lại danh tính, mà migration chỉ nên làm khi có nhu cầu
  thật; fallback của route đã đủ để chúng tiếp tục hoạt động.
- **M2 — ghép theo đường dẫn là so chuỗi.** `/tmp/pkg` và `/tmp/pkg/` là hai chuỗi khác nhau. Cả hai phía đều đi
  qua cùng một giá trị `source.path` đọc từ directory index, nên ca lệch chỉ xảy ra nếu ai đó tự viết tay đường
  dẫn có dấu `/` cuối; khi đó hành vi là "không tìm thấy tên", tức rơi về hành vi cũ, không phải sai âm thầm.

## Việc chưa làm

- Không xoá fallback của route (lý do ở trên).
- Không đổi `version` cho nguồn local **không** được liệt kê (`0.0.0-local` vẫn là câu trả lời đúng: không có
  danh tính nào để nói).
- `docs/conformance-traceability.md` không được nâng trạng thái T-id/V-id nào: thay đổi này không thêm conformance
  test được đặt tên trong bảng đó.

---
title: Issue #169 — kiểm tra cập nhật cho gói/widget và Pi SDK
date: 2026-09-24
worktree: /home/user/fu-169
branch: fu-169
---

# Báo cáo triển khai — #169 kiểm tra cập nhật

## Kết quả

Producer thông báo `category: "update"` cho gói/widget đã cài (so với directory index) và cho Pi SDK (so với npm
registry) đã có, chạy như một job định kỳ, unref, khởi động từ `bootstrap/runtime-bootstrap.ts` và dừng khi node
đóng. `pnpm verify` xanh trên toàn cây (229 test file, 2768 test, đã bao gồm invariants + typecheck + lint + test).

## File đã sửa/thêm

- `apps/runtime/src/update-checks.ts` (mới) — logic kiểm tra: `checkForUpdates` (hàm thuần, nhận `fetch`/clock tiêm
  vào), `runUpdateCheckOnce` (nối với `listInstalledPackages`, `readDirectoryIndex`, `sdkVersion()`),
  `startUpdateCheckTimer` (timer `unref()`, chạy một lượt ngay sau start rồi lặp mỗi 6 giờ, không chồng lượt),
  `isNewerVersion` (so semver, release thắng prerelease cùng bộ ba số).
- `apps/runtime/src/notices.ts` — thêm `packageUpdateNotice` và `piUpdateNotice` (theo mẫu `workerSettledNotice` có
  sẵn), cùng bảng nhãn risk lane tiếng Việt khớp với
  `packages/conversation-client/src/package-provenance.ts`/`messages-timeline.ts` (`trusted-native` = "extension Pi
  gốc — chạy cùng tiến trình", `isolated-ui` = "widget cách ly", v.v. — không lẫn hai cách gọi, đúng AGENTS.md).
- `apps/runtime/src/bootstrap/runtime-bootstrap.ts` — khởi động `startUpdateCheckTimer` (bỏ qua trên node fixture,
  cùng lý do task dispatcher bỏ qua: không gọi registry thật hay đọc gói thật trong bộ test trình duyệt); `wireRuntime`
  giờ trả về `RuntimeHandles { stopUpdateChecks }`.
- `apps/runtime/src/main.ts` — nhận `RuntimeHandles` từ `wireRuntime`, gọi `stopUpdateChecks()` trong `shutdown`
  cùng chỗ đóng voice/terminal gateway.
- `apps/runtime/test/update-checks.spec.ts` (mới, 14 test) — dedup theo version, dedup không chặn version mới hơn
  nữa, offline (fetch reject, timeout, status khác 2xx) không ghi thông báo lỗi và không chặn nhánh gói/widget trong
  cùng lượt, nhãn lane khác nhau rõ ràng giữa `trusted-native` và `isolated-ui`, wiring của `runUpdateCheckOnce`, và
  `startUpdateCheckTimer` chạy một lượt rồi dừng sạch khi `stop()`.
- `docs/system-architecture.md` §7.5.1 — mô tả job, cơ chế dedup, và khoảng trống đã biết (git). `docs/manifest.json`
  đã cập nhật bytes+sha256 qua `node tools/check-invariants.mjs --fix-manifest`.
- `DESIGN.md` §6.7 — chuyển "thông báo cập nhật cho Pi, gói mở rộng và widget" từ "Chưa ship" sang "Đã ship", nói rõ
  chưa có nút "Cập nhật" vì chưa có route cài/rollback nối tới.
- `plans/260924-0840-171-inbox-followups/phase-04-update-checks.md` — đánh dấu hoàn thành, ghi khoảng trống đã biết.

## Thiết kế

- **Không viết resolver thứ hai**: gói/widget dùng lại `listInstalledPackages` và `readDirectoryIndex` từ
  `packages/core` nguyên vẹn; Pi SDK dùng lại `sdkVersion()` đã có sẵn trong `packages/pi-adapter` (đọc
  `package.json` thật của gói đã cài, không phải chuỗi pin trong `pi-adapter/package.json`) — hai giá trị này lệch
  nhau chỉ khi lockfile lệch với dependency đã khai báo, và exact-pin của repo giữ chúng khớp nhau trong điều kiện
  bình thường.
- **`checkForUpdates`** là hàm thuần được yêu cầu: nhận `installedPackages`, `directory`, `piInstalledVersion`,
  `fetchImpl`, `now` — không đọc file, không đọc env, không gọi `sdkVersion()` trực tiếp. `runUpdateCheckOnce` là
  lớp nối IO thật; `startUpdateCheckTimer` là lớp lặp định kỳ.
- **Dedup** dựa hoàn toàn vào `recordNotification`'s `(principalId, dedupKey)` unique đã có sẵn trong storage —
  không thêm bảng hay cờ "đã kiểm tra" nào khác. Khoá `update:<npm|git|local>:<packageId>@<newVersion>` cho gói/
  widget, `update:pi:<tên gói>@<newVersion>` cho Pi SDK, đúng mẫu issue nêu (`update:npm:foo@1.3.0`).
- **Offline không phải lỗi**: mọi nhánh thất bại của `fetchLatestNpmVersion` (reject, timeout qua
  `AbortSignal.timeout`, status khác 2xx, body thiếu `version`) gộp về `{ ok: false }` rồi `piOffline: true` — không
  bao giờ ném ra ngoài, không bao giờ ghi thông báo `severity: "error"`.
- **Rate limit**: chu kỳ interval (mặc định 6 giờ, `unref()`) tự nó là giới hạn tần suất; thêm cờ `inFlight` để một
  lượt kiểm tra chậm/treo không bao giờ chồng lượt kế tiếp.
- **Risk lane**: nhãn tiếng Việt copy nguyên văn từ `messages-timeline.ts` phía client, để không có hai cách gọi tên
  cho cùng bốn lane ở hai nơi khác nhau trong repo.
- **Không có nút "Cập nhật"**: theo đúng plan/issue, hộp thư UI không bị đụng tới trong phase này (đổi
  `packages/conversation-client/src/inbox/*` thuộc thay đổi khác đang chạy song song); nội dung thông báo chỉ nói
  "có bản mới" bằng chữ.

## Khoảng trống đã biết (đặt tên, không giấu)

- **Gói nguồn `git`**: không có cách nào biết một commit mới hơn tồn tại ngoài việc clone và xem — không có npm
  range hay tag di động để so. Module này chỉ so trên `version` field mà directory entry khai báo (giống hệt cách
  `npm` được so), nên một publisher bump `version` khi đẩy commit mới vẫn được bắt; một publisher đẩy commit mới mà
  không bump `version` thì không. Đã ghi rõ trong code comment và `docs/system-architecture.md` §7.5.1, không giả
  vờ làm được điều ngoài khả năng.
- **`sdkVersion()` không async-import khi test**: hàm này (đã có sẵn trong `packages/pi-adapter`) tự đọc
  `node_modules` thật khi được gọi trực tiếp; test dùng tham số tiêm `piInstalledVersion` để không phụ thuộc vào
  layout node_modules thật, đúng yêu cầu "testable function with injected fetch/clock".

## Kiểm chứng

- `pnpm exec vitest run apps/runtime/test/update-checks.spec.ts` — 14/14 pass.
- `pnpm exec vitest run apps/runtime/test/inbox.spec.ts` — 22/22 pass (không hồi quy `notices.ts`).
- `pnpm exec tsc -p tsconfig.json --noEmit` — sạch (phải sửa hai chỗ vi phạm `exactOptionalPropertyTypes` khi truyền
  `registryUrl`/`fetchImpl`/`timeoutMs` optional).
- `node tools/check-invariants.mjs` — 12/12 pass sau khi chạy `--fix-manifest` cho
  `docs/system-architecture.md`.
- `ak plan validate plans/260924-0840-171-inbox-followups` — OK.
- `pnpm verify` (invariants + typecheck + lint + test) — xanh, 229 test file / 2768 test pass, 0 fail.
- Không chạy `pnpm test:e2e`/playwright theo đúng ràng buộc (cổng dùng chung với việc song song khác).

## Status

DONE
Summary: Producer thông báo cập nhật cho gói/widget (so directory index) và Pi SDK (so npm registry, offline im
lặng) đã hoạt động qua job định kỳ unref, dedup theo version, risk lane đúng nhãn, không thêm nút giả trong hộp
thư; `pnpm verify` xanh.
Concerns/Blockers: gói nguồn git chỉ phát hiện bump qua `version` field khai báo, không phát hiện commit mới không
bump version — giới hạn thật của bài toán, đã ghi lại chứ không che giấu; không có blocker khác.

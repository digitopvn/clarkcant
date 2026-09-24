# Phase 4 — Kiểm tra cập nhật (#169)

Status: done

## Việc làm

1. [x] So phiên bản gói/widget đã cài với directory index hiện có (dùng lại resolver trong `packages/core`, không
   viết resolver thứ hai). `apps/runtime/src/update-checks.ts` dùng `listInstalledPackages` và `readDirectoryIndex`
   trực tiếp.
2. [x] Pi SDK: so version pin trong `packages/pi-adapter` với registry khi có mạng; offline thì im lặng. Dùng
   `sdkVersion()` sẵn có trong `packages/pi-adapter` (không đọc lại `package.json` lần hai) và `fetch` có
   `AbortSignal.timeout`; lỗi/timeout/status khác 2xx đều gộp về `piOffline: true`, không ném lỗi.
3. [x] Job định kỳ có giới hạn tần suất; lỗi mạng không tạo thông báo. `startUpdateCheckTimer` chạy một lượt ngay
   sau khi start rồi lặp mỗi `DEFAULT_UPDATE_CHECK_INTERVAL_MS` (6 giờ), timer `unref()`, không bao giờ chạy hai
   lượt chồng nhau (cờ `inFlight`), khởi động từ `bootstrap/runtime-bootstrap.ts` và dừng ở `main.ts`'s `shutdown`.
4. [x] Thông báo `category: "update"`, khoá `update:<source>:<id>@<version>`, nói source, version hiện tại → mới, và
   risk lane (native Pi extension khác isolated widget). Thêm `packageUpdateNotice`/`piUpdateNotice` vào
   `apps/runtime/src/notices.ts`, cùng bảng nhãn lane tiếng Việt khớp với
   `packages/conversation-client/src/package-provenance.ts`.
5. [x] Không có nút "Cập nhật" trừ khi route cập nhật thật đã có — chưa đụng tới hộp thư UI vì chưa có route, đúng
   như kế hoạch (thay đổi `packages/conversation-client/src/inbox/*` cho #171/#172 chạy song song, không thuộc
   phase này).

## Kiểm chứng

Test dedup, offline, risk lane: `apps/runtime/test/update-checks.spec.ts` (14 test) — dedup theo version, không dedup
khi có version mới hơn nữa, offline không ghi thông báo và không chặn nhánh gói/widget, nhãn lane khác nhau giữa
`trusted-native` và `isolated-ui`. `pnpm verify` xanh trên cây đã đổi.

### Khoảng trống đã biết

Một gói nguồn `git` chỉ so trên `version` field directory entry khai báo; không có cách phát hiện một commit mới hơn
mà publisher không tự bump version mà không tự clone lên xem — module không giả vờ làm được điều đó (đã ghi trong
`docs/system-architecture.md` §7.5.1).

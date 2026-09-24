# Phase 4 — Kiểm tra cập nhật (#169)

## Việc làm

1. So phiên bản gói/widget đã cài với directory index hiện có (dùng lại resolver trong `packages/core`, không viết
   resolver thứ hai).
2. Pi SDK: so version pin trong `packages/pi-adapter` với registry khi có mạng; offline thì im lặng.
3. Job định kỳ có giới hạn tần suất; lỗi mạng không tạo thông báo.
4. Thông báo `category: "update"`, khoá `update:<source>:<id>@<version>`, nói source, version hiện tại → mới, và risk
   lane (native Pi extension khác isolated widget).
5. Không có nút "Cập nhật" trừ khi route cập nhật thật đã có.

## Kiểm chứng

Test dedup, offline, risk lane.

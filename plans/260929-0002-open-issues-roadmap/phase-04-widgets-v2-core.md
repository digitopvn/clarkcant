---
phase: 4
title: "#198 lõi: manifest hợp nhất, service facet, catalog P0"
status: done
issues: [198]
---

# Phase 04 — #198 lõi

## Bối cảnh

`widget-package.ts` vẫn có `manifestSchema` chỉ cho widget (`kind: z.literal("widget")`,
`isolation: "isolated-ui"`), tách khỏi `PackageManifest` đa facet. #198 là hard blocker của #201, nuôi #200, #209
và #210, và trùng scope với #200 ở M3 và M5.

## Yêu cầu

- Tạo plan con `plans/{date}-198-widgets-v2/` và tạo sub-issue cho: (a) hợp nhất manifest cùng migration hoặc
  tương thích cho package đã cài, (b) runtime service facet, (c) catalog P0 (Table contract, Action widget
  generic, layout primitives, input/search/form/list, composition state graph).
- Trước khi làm, comment lên #198 và #200 phân định quyền sở hữu: #198 sở hữu manifest, service facet và
  composition graph; M3 và M5 của #200 tham chiếu #198. Đồng bộ composition graph với hợp đồng #195.
- Giữ nguyên các trust lane (host-owned, trusted built-in, declarative, isolated executable). Widget không tin
  cậy không nhận secret, IPC hay quyền tự duyệt.
- Package đã cài theo manifest cũ vẫn phải chạy. Có test cho đường chuyển đổi.
- Đọc trước: `docs/widget-development.md`, `docs/widgets-and-extensions.md`, `docs/open-interfaces.md`, `DESIGN.md`.

## Kiểm chứng

`pnpm verify`. E2E widget-frame và widget-lab. `pnpm invariants`. Cập nhật docs widget trong repo (EN và VI) và
trên `clarkcant-web`.

## Rủi ro và rollback

Thay đổi hợp đồng public: version hoá manifest. Migration là bất biến: backup dữ liệu trước khi áp dụng.
Rollback: revert PR; migration bù trừ nếu cần (không sửa migration cũ).

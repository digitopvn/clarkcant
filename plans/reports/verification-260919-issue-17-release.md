# Release validation — issue #17

Năm tính năng của issue #17, làm qua ba stage. Stage A (#19) đã ở `main`; Stage B và Stage C vào `main` bằng
PR #26, squash thành `96cf96d`.

## Số thật, đo trên cây đã merge

| Cổng | Lệnh | Kết quả |
| --- | --- | --- |
| Invariant | `pnpm run invariants` | 7/7 PASS |
| Typecheck + lint + unit test | `pnpm verify` | **1344 passed \| 7 skipped (1351)** |

## CI phủ những gì

`.github/workflows/ci.yml` chạy `pnpm run invariants`, `typecheck`, `lint`, `pnpm run test`, probe Pi SDK và secret
scan. **Nó không chạy `pnpm test:e2e`**, nên CI xanh không nói gì về browser suite; cổng browser là cổng chạy tại
máy. Trên PR #26: `verify` xanh ở cả node 22.19 và node 24 (1m44s, 1m41s), `secret scan` xanh, `GitGuardian` đỏ vì
một fixture hình-dạng-khoá nằm trong commit cũ (đã gỡ ở HEAD, `no-committed-secrets` của repo vẫn xanh).

## Cổng còn mở

- Smoke desktop: cần display, tức một job `xvfb-run` hoặc một lần người vận hành chạy. Các check đã viết đọc
  `getBounds()`, `getMinimumSize()`, `isAlwaysOnTop()` từ cửa sổ thật.
- Kích thước `MINIMAL_BAR` chưa được nghiệm thu trên display thật.
- Extractor PDF/ảnh, route xoá conversation, nguồn `memory` trong gợi ý, scoped session token: mỗi cái có tên và
  điều kiện còn thiếu trong `docs/widgets-and-extensions.md` §4.1.

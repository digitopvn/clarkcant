# Release validation — issue #17

Năm tính năng của issue #17, làm qua ba stage. Stage A (#19) đã ở `main`; Stage B và Stage C vào `main` bằng
PR #26, squash thành `96cf96d`.

## Số thật, đo trên cây đã merge

| Cổng | Lệnh | Kết quả |
| --- | --- | --- |
| Invariant | `pnpm run invariants` | 7/7 PASS |
| Typecheck + lint + unit test | `pnpm verify` | **1344 passed \| 7 skipped (1351)** |
| Browser suite | `pnpm test:e2e` | **68 passed, 4 failed** — và bốn lỗi đó đúng bằng bốn lỗi đã đo ở commit gốc (bảng dưới). Không lỗi nào khác. |
| Smoke desktop | `pnpm --filter @clarkcant/app-desktop run smoke` | **chưa từng chạy trong phiên này** — cần display |

## Từng lỗi đỏ, và phán quyết của nó

| Test đỏ | Vì sao | Phán quyết |
| --- | --- | --- |
| `appearance.spec.ts:277` "the model in use is what the fields show before anybody types" | Fixture của e2e node không báo provider nào (`CC_MODEL_FIXTURE=1`), nên tab Models không có ô tìm kiếm | **Đỏ sẵn ở commit gốc `7f3127f`** — đo bằng worktree đối chứng ở Stage A, không phải do issue #17 |
| `j1.spec.ts` "a selected passage can be sent to a background session" | Node trả về đường background session chưa nối | **Đỏ sẵn ở `7f3127f`** (Stage A) |
| `onboarding.spec.ts` "shows the name, the tagline and one way in, and does not come back" | Journey first-run | **Đỏ sẵn ở `7f3127f`** (Stage A) |
| `onboarding.spec.ts` "walks the steps it still needs, in order, and never echoes the key" | Journey first-run | **Đỏ sẵn ở `7f3127f`** (Stage A) |

Đây là phép đo, không phải suy đoán: bốn test này đã chạy trên một worktree riêng ở commit gốc trong Stage A và cho
đúng bốn kết quả đỏ đó.

Năm lỗi nữa do bộ đầy đủ tìm ra là **của chính công việc này**, tất cả cùng một loại — một test viết cứng một hành
vi mà tính năng mới thay đổi có chủ đích. Cả năm đã sửa tại nguyên nhân: số tab lấy từ `SETTINGS_TABS`, và bốn suite
ghim `/suggestions` về rỗng vì chúng kiểm bốn chip viết sẵn chứ không kiểm danh sách động.

## Hai journey bị chặn, và điều kiện còn thiếu

Cả hai **đã ra khỏi suite** kèm lý do viết ngay trong file spec, không bị skip âm thầm, và ledger ghi đúng trạng thái.

- **T66** (voice và click chạm cùng một widget action state) — `NOT-IMPLEMENTED`. Phần cài đặt xong: một hàm
  `invokeWidgetAction` dùng chung cho cả click và câu nói, resolver 10 test, khung `focus` chỉ mang instance id.
  Journey browser không chạy được. Điều kiện còn thiếu: fixture thoại đưa câu đã script tới đúng phiên.
- **T73** journey thứ hai (tab được gọi tên) — `PARTIAL`, với journey thứ nhất xanh. Đo được: node giải đúng câu
  `"đổi sang tab công cụ"` thành `settings.tab` với `tab: "extensions"` và schema của client chấp nhận quyết định đó
  (kiểm trực tiếp, không đọc code). Trang hiện ra panel ở tab mặc định và **không** có `data-intent-notice` — dấu hiệu
  của một câu **khác** đã được nghe: `settings.open` không kèm tab cho đúng trạng thái đó và báo thành công, nên không
  có gì báo lỗi. Cùng nguyên nhân fixture như T66.

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

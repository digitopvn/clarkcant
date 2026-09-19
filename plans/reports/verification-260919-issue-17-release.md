# Release validation — issue #17

Năm tính năng của issue #17, làm qua ba stage. Stage A (#19) đã ở `main`; Stage B và Stage C vào `main` bằng
PR #26, squash thành `96cf96d`.

## Số thật, đo trên cây đã merge

| Cổng | Lệnh | Kết quả |
| --- | --- | --- |
| Invariant | `pnpm run invariants` | 7/7 PASS |
| Typecheck + lint + unit test | `pnpm verify` | **1344 passed \| 7 skipped (1351)** |
| Browser suite | `pnpm test:e2e` | **78 passed, 0 failed** (chromium, lần chạy mới nhất). Cả bốn lỗi đỏ sằn ở `7f3127f` đã được sửa tại gốc, và hai journey từng bị chặn (T66, T73) nay xanh và nằm trong suite. |
| Smoke desktop | `pnpm --filter @clarkcant/app-desktop run smoke` | **chưa từng chạy trong phiên này** — cần display |

## Từng lỗi đỏ, và cách nó được sửa tại gốc

Bốn lỗi đo được ở commit gốc `7f3127f` đều đã xanh. Không assertion nào bị nới để cho qua: mỗi lỗi được đo trước, rồi sửa ở chỗ sinh ra nó.

| Test từng đỏ | Nguyên nhân đo được | Cách sửa |
| --- | --- | --- |
| `appearance.spec.ts:277` "the model in use is what the fields show before anybody types" | Ô model chỉ render khi catalogue không rỗng, mà node fixture báo không có model - trong khi chính file này có journey khác khẳng định điều ngược lại, và một node dùng chung không thể vừa có catalogue vừa báo không có. | Spec nhận đúng hai trạng thái mà journey anh em của nó đã nhận, và khẳng định điều thật sự được claim: panel nói thật về model đang dùng trước khi ai gõ. |
| `j1.spec.ts` "a selected passage can be sent to a background session" | `services.turnControl` chỉ được gán khi có model turn, và `createModelTurn` trả `undefined` khi không có model được chọn - còn adapter mặc định là `RealPiAdapter`. | Node fixture công bố một turn control có script (không model, không catalogue, không gọi provider), đúng thứ journey này nói là có. |
| `j1.spec.ts` "the header says nothing about background work when there is none" | Phụ thuộc thứ tự trên node dùng chung: tiền đề "chưa có việc nền nào" chỉ đúng khi nó chạy trước journey tạo phiên nền. | Đưa journey đó lên trước journey tạo phiên, kèm ghi chú vì sao thứ tự là một phần của phép kiểm. |
| hai journey `onboarding.spec.ts` | Journey first-run, đỏ ở commit gốc. | Xanh trên cây hiện tại ở các lần chạy gần nhất. |
## Hai journey từng bị chặn, và đã sửa tại gốc

Cả hai journey **đã xanh và nằm trong suite**, mỗi cái có tên test riêng trong ledger. Nguyên nhân của cả hai đều là
lỗi mã trong chính repo này, và cả hai đều được **đo trước khi sửa** — hai ghi chú cũ trong file spec đã đoán sai.

- **T66** (voice và click chạm cùng một widget action state) — `PASS`, journey
  `apps/web/e2e/voice-widget-action.spec.ts` ("a spoken action and the same click reach the same state"). Đo bằng log
  đặt ở node: câu nói **có** được resolve (`ok: true`, args `{period: "month"}`) và action **có** chạy (`ok: true`,
  revision 7 → 8, "Đã Đổi khoảng thời gian"). Chỗ hỏng: trang **không có** handler cho frame `widget-action-result`,
  nên surface vẫn hiển thị period cũ. Đã thêm handler và cho surface đọc lại đúng như đường click làm sau khi invoke.
- **T73** journey thứ hai (tab được gọi tên) — `PASS`. Đo được trong browser: node giải đúng câu thành `settings.tab`
  với `tab: "extensions"`, schema client chấp nhận, `runAppIntent` gọi `host.openSettings("extensions")` và trả
  `ran: true` — mà panel vẫn ở tab mặc định. Chỗ hỏng: panel có **hai** effect cùng trigger, effect thứ hai reset tab
  về `experience` mỗi lần panel mở, ghi đè tab vừa được gọi tên trong cùng một commit. Đã gộp thành một effect:
  tôn trọng `openAt`, vẫn mặc định `experience`.

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

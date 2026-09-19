# Release validation — issue #17

Năm tính năng của issue #17, làm qua ba stage. Stage A (#19), Stage B và Stage C (#26) đã ở `main`; PR #34 đưa
phần ghi chú về đúng sự thật, và PR #38 sửa nốt hai claim còn lại cùng cổng browser. Tài liệu này ghi **số thật đo
trên cây đã merge `main`**, không phải số của lần chạy cũ.

## Số thật, đo trên cây hiện tại của `main` (`c4e7576`)

| Cổng | Lệnh | Kết quả |
| --- | --- | --- |
| Invariant | `pnpm run invariants` | 7/7 PASS |
| Typecheck + lint + unit test | `pnpm verify` | **1427 passed, 7 skipped (1434)** |
| Browser suite | `pnpm test:e2e` | **83 passed, 0 failed** |
| Smoke desktop | `pnpm --filter @clarkcant/app-desktop run smoke` | **exit 0**, mọi check `true`, `"failed": []` (Electron 44.3.0, Chrome 152) |
| Đồng bộ với `main` | `git rev-list HEAD..origin/main` | 0 (merge `7d9caea`, PR #38 squash thành `9e90535`; sau đó `main` nhận PR #39 và bản sửa tài liệu này) |

## Hai journey từng bị chặn, và đã sửa tại gốc

Cả hai **đã xanh và nằm trong suite**, mỗi cái có tên test riêng trong ledger. Nguyên nhân của cả hai đều là lỗi mã
trong chính repo này, và cả hai đều được **đo trước khi sửa** — hai ghi chú cũ trong file spec đã đoán sai.

- **T66** (voice và click chạm cùng một widget action state) — `PASS`, journey
  `apps/web/e2e/voice-widget-action.spec.ts` ("a spoken action and the same click reach the same state"). Đo bằng log
  đặt ở node: câu nói **có** được resolve (`ok: true`, args `{period: "month"}`) và action **có** chạy (`ok: true`,
  revision 7 → 8, "Đã Đổi khoảng thời gian"). Chỗ hỏng: trang **không có** handler cho frame `widget-action-result`,
  nên surface vẫn hiển thị period cũ. Đã thêm handler và cho surface đọc lại đúng như đường click làm sau khi invoke.
- **T73** journey thứ hai (tab được gọi tên) — `PASS`. Đo được trong browser: node giải đúng câu thành `settings.tab`
  với `tab: "extensions"`, schema client chấp nhận, `runAppIntent` gọi `host.openSettings("extensions")` và trả
  `ran: true` — mà panel vẫn ở tab mặc định. Chỗ hỏng: panel có **hai** effect cùng trigger, effect thứ hai reset tab
  về `experience` mỗi lần panel mở, ghi đè tab vừa được gọi tên trong cùng một commit. Đã gộp thành một effect: tôn
  trọng `openAt`, vẫn mặc định `experience`.

## Bốn lỗi đỏ ở commit gốc, và cách từng cái được sửa tại gốc

Bốn lỗi đo được ở commit gốc `7f3127f` (chạy đối chứng trên worktree riêng ở Stage A) nay đều xanh. Không assertion
nào bị nới để cho qua: mỗi lỗi được đo trước, rồi sửa ở chỗ sinh ra nó.

| Test từng đỏ | Nguyên nhân đo được | Cách sửa |
| --- | --- | --- |
| `appearance.spec.ts:277` "the model in use is what the fields show before anybody types" | Ô model chỉ render khi catalogue không rỗng, mà node fixture báo không có model — trong khi chính file này có journey khác khẳng định điều ngược lại, và một node dùng chung không thể vừa có catalogue vừa báo không có. | Spec nhận đúng hai trạng thái mà journey anh em của nó đã nhận, và vẫn khẳng định điều thật sự được claim: panel nói thật về model đang dùng trước khi ai gõ. |
| `j1.spec.ts` "a selected passage can be sent to a background session" | `services.turnControl` chỉ được gán khi có model turn, và `createModelTurn` trả `undefined` khi không có model được chọn — còn adapter mặc định là `RealPiAdapter`, nên đặt provider trong môi trường sẽ khiến mọi lượt gọi provider thật. | Node fixture công bố một turn control có script (không model, không catalogue, không gọi provider) — đúng thứ journey này nói là fixture node có. |
| `j1.spec.ts` "the header says nothing about background work when there is none" | Phụ thuộc thứ tự trên node dùng chung: tiền đề "chưa có việc nền nào" chỉ đúng khi nó chạy trước journey tạo phiên nền. | Đưa journey đó lên trước journey tạo phiên, kèm ghi chú vì sao thứ tự là một phần của phép kiểm. |
| hai journey `onboarding.spec.ts` | Journey first-run, đỏ ở commit gốc. | Xanh trên cây hiện tại ở các lần chạy gần nhất. |

## CI phủ những gì

`.github/workflows/ci.yml` chạy `pnpm run invariants`, `typecheck`, `lint`, `pnpm run test`, probe Pi SDK, secret
scan, **browser suite** (job `e2e`) và **desktop smoke dưới `xvfb`** (job `desktop smoke (xvfb)`). Hai cổng cuối
trước đây chỉ chạy tay, và PR #44 đã đưa chúng vào CI: cả hai xanh ở cả hai lần chạy (e2e 3m39s và 3m43s,
desktop smoke 31s và 32s). Lần đầu chúng chạy, chúng đã tìm ra hai lỗi thật và cả hai được sửa ở gốc: Electron
không khởi động được vì sandbox SUID không cấu hình được trên runner, và một journey bàn phím lấy focus khi panel còn
đang hiện nên `focus()` bị bỏ. Trên PR #38: `verify` xanh ở cả node 22.19 và node 24, `secret scan` xanh.
`GitGuardian` đỏ vì một fixture hình-dạng-khoá nằm trong commit cũ (đã gỡ ở HEAD; `no-committed-secrets` của
repo vẫn xanh) — nó là check tư vấn, không phải cổng của repo.

## Cổng còn mở

Smoke desktop **đã chạy và xanh** trên máy này (exit 0, `"failed": []`), nên nó không còn nằm ở đây: các check đọc
`getBounds()`, `getMinimumSize()` và `isAlwaysOnTop()` từ cửa sổ thật và đều `true`. Điều còn lại là nợ kỹ thuật:

- Các check cần provider thật (`[calibration]`, `[jev-live]`) vẫn BLOCKED nếu thiếu `CLARKCANT_JEV_LIVE=1` và key;
  quyết định "ghi nhớ" của chính model vì thế chưa được chứng minh.
- Extractor PDF/ảnh, route xoá conversation, nguồn `memory` trong gợi ý, scoped session token: mỗi cái có tên và
  điều kiện còn thiếu trong `docs/widgets-and-extensions.md` §4.1.
- `nodeReachable` là `false` trong smoke: cổng này kiểm tra shell và cửa sổ, không cần node đang chạy.

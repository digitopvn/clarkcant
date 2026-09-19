# Release validation — issue #17

Năm tính năng của issue #17, làm qua ba stage. Stage A (#19), Stage B và Stage C (#26) đã ở `main`; PR #34 đưa
phần ghi chú về đúng sự thật, và PR #38 sửa nốt hai claim còn lại cùng cổng browser. Tài liệu này ghi **số thật đo
trên cây đã merge `main`**, không phải số của lần chạy cũ.

## Số thật, đo trên cây hiện tại của `main` (`0ce8722`)

| Cổng | Lệnh | Kết quả |
| --- | --- | --- |
| Invariant | `pnpm run invariants` | 7/7 PASS |
| Typecheck + lint + unit test | `pnpm verify` | **1573 passed, 7 skipped (1580)** |
| Browser suite | `pnpm test:e2e` | **83 passed, 0 failed** |
| CI trên `main` | `.github/workflows/ci.yml`, chạy mỗi lần push | **cả năm job xanh** ở run 35464062373 (`0ce8722`) và 35464369354 (`71d3e05`): `verify` (node 22.19 và 24), `secret scan`, `e2e (browser suite)`, `desktop smoke (xvfb)`. Hai cổng cuối chỉ chạy tay trước PR #44. |
| Smoke desktop | `pnpm --filter @clarkcant/app-desktop run smoke` | **exit 0**, mọi check `true`, `"failed": []` (Electron 44.3.0, Chrome 152) |
| Đồng bộ với `main` | `git rev-list HEAD..origin/main` | 0 (merge `1368cb5`, sau khi nhận `main`; PR #38 squash thành `9e90535`, PR #44 đưa hai cổng vào CI) |

Nhánh công việc được **merge vào `main` bằng merge commit**, sau khi cây của nó được đưa về đúng cây
của `main`. Trước đó mọi PR đều được squash, nên nội dung đã ở `main` nhưng **lịch sử của nhánh thì chưa**:
`git merge-base --is-ancestor <nhánh> main` trả về sai. Merge này làm điều đó thành đúng, và nó không đổi một byte
nội dung nào ngoài ghi chú này.

## Tiêu chí của chính issue, không chỉ của plan

Issue #17 §1 ghi điều kiện hoàn thành là: đính 2 tệp (1 text, 1 ảnh) → gửi → agent trả lời dùng nội dung tệp → reload vẫn thấy
attachment. Journey `apps/web/e2e/attachments.spec.ts` — "the agent answers using the content of an attached file" —
làm đúng chuỗi đó: hai tệp được đính, câu trả lời chứa nội dung của tệp văn bản, và cả hai tệp còn trong timeline sau khi
reload. Model ở đó là fixture của node, nên điều được chứng minh là đường ống — tệp tới node, node đọc được nội dung,
câu trả lời mang nó — chứ không phải phán đoán của model. Nội dung ảnh/PDF thì **chưa** tới model: chúng được nêu bằng
id, và điều kiện còn thiếu ghi ở `docs/widgets-and-extensions.md` §4.1.

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

## Hai lỗi nữa, do chính CI tìm ra

Hai cổng mới được đưa vào CI đã tìm ra hai lỗi thật mà máy này không thấy, và cả hai đều được sửa ở gốc:

- **`e2e` bất định trên `appearance.spec.ts:122`** (journey bàn phím của tab Settings). Nguyên nhân:
  `Modal` gộp phần chuyển focus vào dialog vào **cùng một effect** với listener bàn phím, nên effect chạy lại mỗi khi
  identity của `onClose` đổi - tức là mỗi lần surface render lại. Mỗi lần chạy lại, nó trả focus về opener rồi
  chuyển focus vào control đầu tiên của dialog, lấy mất chỗ đang đứng của người dùng bàn phím. Sự cố chỉ hiện
  khi dữ liệu của panel về đúng lúc, nên nó đỏ trên CI và xanh trên máy này với cùng một cây. Đã tách
  listener ra effect riêng và để việc chuyển focus chỉ phụ thuộc `open`.
- **`docs-manifest-integrity` trên `main`**: entry của `docs/widget-development.md` ghi 16284 byte, còn tệp trong git là
  15655 byte - digest được tính từ một bản Windows có CRLF, nên mọi checkout mới đều trượt invariant. Đã tính lại
  từ byte được lưu trong git.

Cả hai đều được đo trước khi sửa, và CI của `main` ở `0ce8722` xanh cả năm job.

## CI phủ những gì

`.github/workflows/ci.yml` chạy `pnpm run invariants`, `typecheck`, `lint`, `pnpm run test`, probe Pi SDK, secret
scan, **browser suite** (job `e2e`) và **desktop smoke dưới `xvfb`** (job `desktop smoke (xvfb)`). Hai cổng cuối
trước đây chỉ chạy tay, và PR #44 đã đưa chúng vào CI: cả hai xanh ở cả hai lần chạy (e2e 3m39s và 3m43s,
desktop smoke 31s và 32s). Lần đầu chúng chạy, chúng đã tìm ra hai lỗi thật và cả hai được sửa ở gốc: Electron
không khởi động được vì sandbox SUID không cấu hình được trên runner, và một journey bàn phím lấy focus khi panel còn
đang hiện nên `focus()` bị bỏ. Trên PR #38: `verify` xanh ở cả node 22.19 và node 24, `secret scan` xanh.
`GitGuardian` đỏ vì một fixture hình-dạng-khoá nằm trong commit cũ (đã gỡ ở HEAD; `no-committed-secrets` của
repo vẫn xanh) — nó là check tư vấn, không phải cổng của repo.

## Nợ kỹ thuật còn lại (không phải tiêu chí của plan)

Không tiêu chí nào còn đỏ. Cả hai cổng từng chỉ chạy tay nay chạy trong CI mỗi lần push (`e2e`, `desktop smoke (xvfb)`), nên
evidence của cửa sổ không còn phụ thuộc vào một máy cụ thể.

- Các check cần provider thật (`[calibration]`, `[jev-live]`) vẫn BLOCKED nếu thiếu `CLARKCANT_JEV_LIVE=1` và key;
  quyết định "ghi nhớ" của chính model vì thế chưa được chứng minh.
- Extractor PDF/ảnh, route xoá conversation, nguồn `memory` trong gợi ý, scoped session token: mỗi cái có tên và
  điều kiện còn thiếu trong `docs/widgets-and-extensions.md` §4.1.
- `nodeReachable` là `false` trong smoke: cổng này kiểm tra shell và cửa sổ, không cần node đang chạy.

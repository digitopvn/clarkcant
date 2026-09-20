# Release validation — issue #17

Năm tính năng của issue #17, làm qua ba stage. Stage A (#19), Stage B và Stage C (#26) đã ở `main`; PR #34 đưa
phần ghi chú về đúng sự thật, và PR #38 sửa nốt hai claim còn lại cùng cổng browser. Tài liệu này ghi **số thật đo
trên cây đã merge `main`**, không phải số của lần chạy cũ.

## Số thật, đo trên cây hiện tại (`bafd59d` = `main`, cộng PR #72)

| Cổng | Lệnh | Kết quả |
| --- | --- | --- |
| Invariant | `pnpm run invariants` | 7/7 PASS |
| Typecheck + lint + unit test | `pnpm verify` | **1639 passed, 7 skipped (1646)** |
| Browser suite | `pnpm test:e2e` | **103 passed, 1 skipped, 0 failed** (run 35488474171, job `e2e (browser suite)`) |
| CI trên nhánh này | `.github/workflows/ci.yml`, chạy mỗi lần push | **cả năm job xanh** ở run 35488474171 và 35488477132 (`c96e519`): `verify` (node 22.19 và 24), `secret scan`, `e2e (browser suite)`, `desktop smoke (xvfb)` |
| Smoke desktop | `pnpm --filter @clarkcant/app-desktop run smoke` | **exit 0**, mọi check `true`, `"failed": []` (Electron 44.3.0, Chrome 152); job `desktop smoke (xvfb)` xanh trên CI |
| Đồng bộ với `main` | `git rev-list HEAD..origin/main` | 0: nhánh này cắt từ head của `main` (`b6b3883`), và nhánh công việc trước đó đã được merge vào `main` bằng merge commit (`git merge-base --is-ancestor` trả về đúng) |

Nhánh công việc được **merge vào `main` bằng merge commit**, sau khi cây của nó được đưa về đúng cây
của `main`. Trước đó mọi PR đều được squash, nên nội dung đã ở `main` nhưng **lịch sử của nhánh thì chưa**:
`git merge-base --is-ancestor <nhánh> main` trả về sai. Merge này làm điều đó thành đúng, và nó không đổi một byte
nội dung nào ngoài ghi chú này.

## Từng mục của issue, và test chứng minh nó

| Mục của issue #17 | Test |
| --- | --- |
| 1. Đính kèm tệp | `apps/web/e2e/attachments.spec.ts` — "the agent answers using the content of an attached file" và "the agent answers using the content of an attached pdf" (hai tệp, câu trả lời dùng nội dung tệp văn bản, reload vẫn thấy cả hai), cộng chín journey còn lại của tệp; từ chối path/URL/mime/ngưỡng/quota ở `apps/runtime/test/attachment-routes.spec.ts` |
| 2. Cửa sổ desktop tối giản | smoke của `apps/desktop` (bounds, sàn 20×50, always-on-top đọc từ cửa sổ thật; chạy trong CI dưới `xvfb`) và `apps/web/e2e/voice-bar.spec.ts` (phiên sống qua cả hai chiều) |
| 3. Voice điều khiển app | `apps/web/e2e/voice-control.spec.ts` — 8 journey: mở Settings, đổi tab được gọi tên, thoát app (hỏi trước), lệnh lạ bị từ chối, kết thúc phiên, về home, đính kèm (mở file picker), và lệnh cửa sổ bị từ chối trong browser; cộng `packages/core/test/app-intents.spec.ts` cho từng nhóm lệnh |
| 4. Gợi ý từ việc gần đây | `apps/web/e2e/suggestions.spec.ts` — gồm "with two sessions behind it, the offer is the one touched last" (seed **hai** phiên, và gợi ý trỏ đúng phiên được chạm sau cùng) — và `apps/runtime/test/suggestions.spec.ts` |
| 5. Tab Memory | `apps/web/e2e/memory.spec.ts` (rỗng, có dữ liệu kèm nguồn, xoá), `apps/runtime/test/memory.spec.ts` |

Cả ba loại nội dung của issue nay đều tới được agent. Văn bản và PDF đi vào prompt của lượt; ảnh được
`read_attachment` giao nguyên block ảnh cho SDK (`toSdkTool` phát `{ type: "image", data, mimeType }`), nên model
nhận chính bức ảnh. Dòng này từng ghi ảnh "chưa tới model": nguyên nhân là adapter gộp mọi kết quả tool thành
một block văn bản, và điều đó đã được sửa tại gốc.

## Tiêu chí của chính issue, không chỉ của plan

Issue #17 §1 ghi điều kiện hoàn thành là: đính 2 tệp (1 text, 1 ảnh) → gửi → agent trả lời dùng nội dung tệp → reload vẫn thấy
attachment. Journey `apps/web/e2e/attachments.spec.ts` — "the agent answers using the content of an attached file" —
làm đúng chuỗi đó: hai tệp được đính, câu trả lời chứa nội dung của tệp văn bản, và cả hai tệp còn trong timeline sau khi
reload. Model ở đó là fixture của node, nên điều được chứng minh là đường ống — tệp tới node, node đọc được nội dung,
câu trả lời mang nó — chứ không phải phán đoán của model. Nội dung tệp tới agent theo ba đường: văn bản và PDF vào
prompt của lượt, ảnh qua `read_attachment` dưới dạng block ảnh mà SDK mang nguyên vẹn tới model. Điều còn phụ thuộc
provider là phán đoán của model trên nội dung đó, và các check cần provider thật vẫn là opt-in.

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
- ~~Extractor PDF/ảnh~~ — **đã đóng**: PDF được trích văn bản (`apps/runtime/src/pdf-text.ts`, PR #64) và ảnh
  được giao nguyên block ảnh cho SDK (PR #66: `read_attachment` trả chính bức ảnh, `toSdkTool` phát
  `{ type: "image", data, mimeType }`). Nguyên nhân gốc nằm ở adapter, chỗ gộp mọi kết quả tool thành một block
  text.
- Route xoá conversation và scoped session token cho voice: mỗi cái có tên và điều kiện còn thiếu trong
  `docs/widgets-and-extensions.md` §4.1. Nguồn `memory` trong gợi ý thì **đã đóng**: `buildSuggestions` nay phát nó từ
  chính bảng mà tab Memory đọc (`listMemoryRecords`), nên contract không còn khai một nguồn không bao giờ xuất hiện.
- `nodeReachable` là `false` trong smoke: cổng này kiểm tra shell và cửa sổ, không cần node đang chạy.

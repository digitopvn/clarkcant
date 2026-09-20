# Hoà giải `main` và ship refactor autonomy (P1–P8)

Nhánh này là refactor "autonomous by default" (preflight của host giữ quyền, Jev chỉ thu hẹp, một Interaction Manager cho mọi surface, Secret Broker với JIT injection, Model Registry có hotkey, emergency stop, audit trail) — đã verify xanh trước khi hợp nhất, và sau đó được **hoà giải với `main`** để có thể ship.

## Vì sao phải hoà giải

Nhánh sau `main` **151 commit** (base `e1c67d4`, `main` nay là `46f1ecd`). Lần hợp nhất đầu tiên vô tình dựng trên một `main` cũ (`ecf1fba`), nên cây thiếu **20 commit** cuối của main — trong đó có `packages/core/src/frame-grant.ts`, `widget-document.ts`, `widget-frame.ts`, `install-from-entry.ts`, `package-files.ts`, `WidgetFrame.tsx` và các e2e widget-frame. Phát hiện này dẫn tới việc hợp nhất nốt `main` hiện tại; lần thứ hai chỉ xung đột 2 tệp (`docs/manifest.json`, `playwright.config.ts`) cộng một dòng import ở `main.ts`.

## Nội dung

**Migration.** main lấy `18` cho bảng `memory-records` của nó, nên hai migration của nhánh này được đánh số lại: `secrets` = 19, `audit_log` = 20 (đã kiểm 20 version liền mạch, không trùng). Migration đã áp dụng không bị sửa.

**Hai mô hình policy cùng điều khiển hiệu ứng.** main có `ExecutionMode`/`ExecutionRule` + `decideExecution`, nhánh này có `ExecutionPolicy` (`auto|guarded|confirm|deny`) + preflight + guardrail. Quyết định: `ExecutionPolicy` quyết định cho **lệnh**, và mô hình của main **vẫn sống** cho hành động widget và cài đặt (`packages/core/src/widget-service.ts`, hai chỗ trong `gateway.ts`) nên control của nó được giữ lại chứ không xoá. Tab Control vì thế có cả hai, và nói rõ cái nào áp cho việc gì. Hợp nhất hai mô hình thành một là việc tiếp theo, không phải việc của PR này.

**Thẻ câu hỏi.** Cả hai phía cùng thêm `question-card` với hai hình dạng. Hình dạng của nhánh này thắng (`prompt`, `questionType`, `allowOther`, `voicePrompt`, `status`), vì nó là xương sống của Interaction Manager: một đường trả lời cho click, gõ và nói, và `answerFromUtterance` khớp lời nói với nhãn mà thẻ đã đưa. Call site của main được chuyển theo (`prompt` thay `question`).

**Thẻ câu hỏi trở lại thuần.** Nó từng giữ lựa chọn và cờ "đã gửi" của riêng nó, nên spec không thể gọi nó như mọi block khác (hook không chạy ngoài renderer). Bản nháp trả lời chuyển lên surface giữ, và node cho biết câu hỏi nào đang chờ: thẻ lại là hàm thuần của thứ nó được cho.

**Voice trả lời được câu hỏi đang chờ.** Thẻ do click hỏi cũng phải trả lời được bằng lời nói. Phiên voice nay hỏi node "hội thoại còn chờ gì" thay vì chỉ nhớ lượt nó tự hỏi. (Thẻ của main đóng theo *vị trí* — bất kỳ tin nhắn nào sau nó cũng làm nó hết trả lời được, kể cả câu không trả lời nó.)

**Settings.** main tách settings thành mỗi tab một tệp; phần Autonomy của nhánh này được đưa vào tab Control của main (dùng `SegmentedControl`/`ToggleSwitch` sẵn có), bảng model pool vào tab AI & Routing, và `SettingsPanel.tsx` cũ bị xoá.

**Hai lỗi thật lộ ra khi hợp nhất**, sửa ở gốc:
- `verifyBackup` mở bản sao **ngoài** khối `try`, nên một bản sao hỏng ném lỗi ra khỏi đúng hàm tồn tại để báo điều đó.
- `openDatabase` để rò rỉ handle khi một câu lệnh thiết lập lỗi (khoá tệp trên Windows).

## Kiểm chứng (trên cây merge, sau tất cả thay đổi)

| Cổng | Kết quả |
|---|---|
| `pnpm exec tsc -p tsconfig.json --noEmit` | 0 lỗi |
| `pnpm run invariants` | 7/7 |
| `pnpm test` (unit) | 1864 pass / 7 skip (147 tệp) |
| `pnpm test:e2e` (Playwright) | **115 pass / 0 failed** (1 skip) |

Một lần chạy unit có 1 lỗi ở `packages/pi-adapter/test/sdk-compatibility.spec.ts`; tệp đó xanh khi chạy riêng (6/6) và suite đầy đủ xanh lại ở lần kế tiếp — flake, không phải hồi quy.

## Điều đã cân nhắc và khai báo

- **`.github/workflows/ci.yml` không bị sửa** dù lens báo 39 dòng quá 80 ký tự. Bằng chứng: `git diff origin/main HEAD -- .github/workflows/ci.yml` **trống** (tệp y hệt main, đến từ main trong merge nên PR này không thay đổi nó); `pnpm exec eslint .github/workflows/ci.yml` chỉ trả *"File ignored because no matching configuration was supplied"*; repo có **0** tệp cấu hình yamllint/markdownlint; `pnpm verify` không có bước lint YAML. Quy tắc 80 ký tự là mặc định của pi-lens. 39 dòng đó gồm 10 biểu thức `if:` của Actions và 2 lệnh shell, và repo không có bộ parse YAML để chứng minh bản sửa tương đương — nên sửa chúng ở đây là rủi ro cho CI của main mà không có cổng nào yêu cầu. Nếu muốn thoả quy tắc này, nó nên là một `chore(ci)` riêng.
- **`execution.mode`/`execution.rules`**: control của main được giữ vì đường widget/install vẫn đọc chúng, nhưng với **lệnh** thì `ExecutionPolicy` mới là lớp quyết định. Hai bề mặt policy là một cái nhiều hơn sản phẩm muốn; đã ghi trong mã và ở đây.
- **Không có commit nào của main bị bỏ**: `git merge-base --is-ancestor origin/main HEAD` đúng, `git log HEAD..origin/main` rỗng, và các tệp frame/widget của main có mặt trong cây.

## Câu hỏi chưa giải quyết

- Hợp nhất hai mô hình policy thành một (lệnh + widget + cài đặt) — hiện là hai lớp đọc hai nguồn khác nhau.
- 39 dòng YAML của `.github/workflows/ci.yml` (xem ở trên): sửa trong PR này hay để một `chore(ci)` riêng kèm YAML linter.

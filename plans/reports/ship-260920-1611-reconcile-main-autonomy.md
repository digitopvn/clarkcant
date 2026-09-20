# Hoà giải `main` và ship refactor autonomy (P1–P8)

Nhánh này là refactor "autonomous by default" (preflight của host giữ quyền, Jev chỉ thu hẹp, một Interaction Manager cho mọi surface, Secret Broker với JIT injection, Model Registry có hotkey, emergency stop, audit trail) — đã verify xanh trước khi hợp nhất, và sau đó được **hoà giải với `main`** để có thể ship.

## Vì sao phải hoà giải

Base là `e1c67d4`; `main` nay là `4a92ec0` (#101–#106). Lần hợp nhất đầu tiên vô tình dựng trên một `main` cũ (`ecf1fba`), nên cây thiếu **20 commit** cuối của main — trong đó có `packages/core/src/frame-grant.ts`, `widget-document.ts`, `widget-frame.ts`, `install-from-entry.ts`, `package-files.ts`, `WidgetFrame.tsx` và các e2e widget-frame. Việc đó dẫn tới năm lần hợp nhất nốt `main`, mỗi lần một commit merge riêng: pairing/delegation (#95–#97), một node được gán model (#99), worker của runtime + voice kết thúc lượt khi im lặng (#101–#103), lease của voice (#105), và việc node nạp project-work pack (#106). Bốn lần sau chỉ xung đột tổng cộng hai tệp (`docs/manifest.json`, `playwright.config.ts`) và hai dòng import ở `main.ts`; phần việc còn lại là hợp nhất nội dung.

## Nội dung

**Migration.** main lấy `18` cho bảng `memory-records` của nó, nên hai migration của nhánh này được đánh số lại: `secrets` = 19, `audit_log` = 20; migration pairing của main sau đó nhận `21` (đã kiểm dãy 22 version tăng dần, không trùng). Migration đã áp dụng không bị sửa.

**Hai mô hình policy cùng điều khiển hiệu ứng.** main có `ExecutionMode`/`ExecutionRule` + `decideExecution`, nhánh này có `ExecutionPolicy` (`auto|guarded|confirm|deny`) + preflight + guardrail. Quyết định: `ExecutionPolicy` quyết định cho **lệnh**, và mô hình của main **vẫn sống** cho hành động widget và cài đặt (`packages/core/src/widget-service.ts`, hai chỗ trong `gateway.ts`) nên control của nó được giữ lại chứ không xoá. Tab Control vì thế có cả hai, và nói rõ cái nào áp cho việc gì.

**Thẻ câu hỏi.** Cả hai phía cùng thêm `question-card` với hai hình dạng. Hình dạng của nhánh này thắng (`prompt`, `questionType`, `allowOther`, `voicePrompt`, `status`), vì nó là xương sống của Interaction Manager: một đường trả lời cho click, gõ và nói, và `answerFromUtterance` khớp lời nói với nhãn mà thẻ đã đưa. Call site của main được chuyển theo (`prompt` thay `question`).

**Thẻ câu hỏi trở lại thuần.** Nó từng giữ lựa chọn và cờ "đã gửi" của riêng nó, nên spec không thể gọi nó như mọi block khác (hook không chạy ngoài renderer). Bản nháp trả lời chuyển lên surface giữ, và node cho biết câu hỏi nào đang chờ: thẻ lại là hàm thuần của thứ nó được cho.

**Voice trả lời được câu hỏi đang chờ.** Thẻ do click hỏi cũng phải trả lời được bằng lời nói. Phiên voice nay hỏi node "hội thoại còn chờ gì" thay vì chỉ nhớ lượt nó tự hỏi. (Thẻ của main đóng theo *vị trí* — bất kỳ tin nhắn nào sau nó cũng làm nó hết trả lời được, kể cả câu không trả lời nó.)

**Settings.** main tách settings thành mỗi tab một tệp; phần Autonomy của nhánh này được đưa vào tab Control của main (dùng `SegmentedControl`/`ToggleSwitch` sẵn có), bảng model pool vào tab AI & Routing, và `SettingsPanel.tsx` cũ bị xoá.

**Hai lỗi thật lộ ra khi hợp nhất**, sửa ở gốc:
- `verifyBackup` mở bản sao **ngoài** khối `try`, nên một bản sao hỏng ném lỗi ra khỏi đúng hàm tồn tại để báo điều đó.
- `openDatabase` để rò rỉ handle khi một câu lệnh thiết lập lỗi (khoá tệp trên Windows).

**Hai test không portable**, sửa ở gốc: hai test từ chối lệnh ghi thư mục theo kiểu Windows (`D:/…`, `C:\Windows`). Trên Linux thư mục đó không tồn tại, nên preflight trả `UNKNOWN_DIRECTORY` thay vì trả lời về quyền sở hữu mà test đang nói tới — suite xanh ở máy người viết và đỏ trên CI. Nay dùng thư mục tạo trong thư mục tạm của hệ thống, tuyệt đối và nằm ngoài root trên mọi nền tảng.

## Viết lại lịch sử nhánh (một lần, có công bố)

GitGuardian báo `1 secret` và chỉ đúng một vấn đề có thật: năm fixture dùng để chứng minh "giá trị này không bao giờ xuất hiện" được viết với hình dạng của token thật (`ghp_live_…`, `ghp_value_…`, `sk-live-…`, `sk-e2e-…`). Bản sửa đổi tên chúng thành `fixture-value-…` nằm ở commit sau, còn GitGuardian quét **lịch sử** của PR, nên các commit sớm vẫn giữ chuỗi cũ. Vì vậy lịch sử nhánh đã được viết lại đúng một lần bằng `git filter-branch --tree-filter` chạy `perl` thay thế trên **mọi tệp được theo dõi**, rồi `git push --force-with-lease`.

Bằng chứng việc viết lại không đổi nội dung:
- Cây của commit cuối **không đổi**: `f86795ab84556d0e7a359a3f4402d2dd44f35013` trước và sau khi viết lại.
- `git grep` trên **từng** commit trong nhánh: `0` commit còn bất kỳ chuỗi nào trong năm chuỗi cũ.
- Chỉ mất **một** commit (chính commit đổi tên, trở thành rỗng) nên 35 thành 34; SHA của mọi commit trong nhánh đã thay đổi, còn `main` thì không bị chạm.
- Bản cũ vẫn còn nguyên ở nhánh `backup/pr100-history-260920` (`550018c`) để so sánh hoặc khôi phục.

Sau khi viết lại, GitGuardian **vẫn** `failure`, nhưng không còn là một lần quét mới tìm ra bí mật: check-run của nó trên head hiện tại bắt đầu và kết thúc **trong cùng một giây**, không có chú thích (annotation) nào chỉ vào tệp hay dòng, và `rerequest` không được hỗ trợ (HTTP 404). Hai bộ quét độc lập trên toàn bộ commit của PR — quét blob của mọi commit, và quét diff của từng commit kể cả diff của commit merge, theo tám họ mẫu (Google, OpenAI/Anthropic, GitHub, GitLab, Slack, AWS, PEM, JWT) — **không tìm thấy mẫu khoá nào**. Đây là trạng thái sự cố đã ghi ở phía GitGuardian cho kho, nên nó chỉ được gỡ bằng cách dismiss/mark "test fixture" trên dashboard GitGuardian (hoặc bởi một maintainer có quyền ở đó); không có lệnh `gh` nào làm được việc đó.

## Kiểm chứng (trên cây đã hợp nhất, sau tất cả thay đổi)

| Cổng | Kết quả |
|---|---|
| `pnpm verify` (invariants + typecheck **cả hai** tsconfig + lint + unit) | pass |
| `pnpm run invariants` | **8/8** |
| `pnpm test` (unit) | **1915 pass / 7 skip** (155 tệp) |
| `pnpm test:e2e` (Playwright) | **115 pass / 0 failed** (1 skip) |
| CI `verify` (Node 22.19 và 24), `e2e`, `desktop smoke`, `secret scan` | pass |

Một lần chạy unit có 1 lỗi ở `packages/pi-adapter/test/sdk-compatibility.spec.ts`; tệp đó xanh khi chạy riêng (6/6) và suite đầy đủ xanh lại ở lần kế tiếp — flake, không phải hồi quy. Một lần chạy e2e dừng ở 41 test rồi exit 1 (listener cũ chưa chết hẳn); lần chạy đầy đủ ngay sau đó xanh **115/115**, và mọi lần chạy đầy đủ khác trong chặng này cũng xanh.

## Điều đã cân nhắc và khai báo

- **`.github/workflows/ci.yml` được ngắt dòng trong PR này** (một commit `chore(ci)` riêng), sau khi bị pi-lens báo 39 dòng quá 80 ký tự. Việc ngắt dòng là **toàn bộ** thay đổi: comment được xuống dòng lại, các điều kiện dài và một lệnh shell dài trở thành scalar `>-`, và một comment phiên bản ở cuối dòng được chuyển lên trên action mà nó nói tới. Bằng chứng không đổi giá trị: một bộ chuẩn hoá (nối dòng nối bằng `\`, bỏ comment cả dòng và cuối dòng, gộp scalar `>-` về dòng khoá, chuẩn hoá khoảng trắng) so **119 dòng giá trị** của hai bản và **không tìm thấy dòng nào khác**; sau khi sửa còn **0** dòng quá 80 ký tự. Cách kiểm này không thay thế một YAML parser (repo không cài `yaml`/`js-yaml`), nên nếu cổng phạm vi của CI (`if: steps.scope.outcome != 'success' || steps.scope.outputs.full != 'false'`) đọc ra chuỗi khác thì chính các check của PR này sẽ đỏ trước khi merge — và commit đó thu hồi được bằng một commit.
- **Hai bề mặt policy là một cái nhiều hơn sản phẩm muốn**: control của main được giữ vì đường widget/install vẫn đọc `execution.mode`/`execution.rules`, nhưng với **lệnh** thì `ExecutionPolicy` mới là lớp quyết định. Đã ghi trong mã và ở đây.
- **Không có commit nào của main bị bỏ**: `git merge-base --is-ancestor origin/main HEAD` đúng và `git log HEAD..origin/main` rỗng ở thời điểm merge cuối.

## Câu hỏi chưa giải quyết

- **GitGuardian** cần một người có quyền trên dashboard dismiss sự cố (nó trỏ vào lịch sử đã bị viết lại, không còn chuỗi nào trong kho). Nếu repo đặt check này là bắt buộc thì việc merge phải chờ thao tác đó.
- Hợp nhất hai mô hình policy thành một (lệnh + widget + cài đặt).

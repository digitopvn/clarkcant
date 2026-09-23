---
title: "Red-team — plan architecture consolidation #125"
status: done
---

# Red-team — Architecture consolidation (issue #125)

Bốn persona phản biện plan. Mỗi finding phải có resolution hoặc bị loại kèm lý do.

## 1. Assumptions

| # | Giả định bị chất vấn | Kết luận | Resolution |
| --- | --- | --- | --- |
| A1 | "Hai policy stack có thể fold vào nhau mà không đổi hành vi." | Đúng về mặt type, **không** đúng mặc định: `autonomy.executionPolicy = "deny"` không có mode tương đương trong `autonomous/guarded/ask`. | Ép Task 1.3 phải có bảng map tường minh, `deny` ⇒ rule deny toàn cục + mode `ask`, và test khẳng định không bao giờ thành `autonomous`. |
| A2 | "Legacy `execution.mode` và `autonomy` luôn đồng ý với nhau." | Sai — ControlSettings render cả hai, nên chúng có thể lệch. | Thêm quy tắc precedence: chọn hành vi hiệu dụng **chặt hơn**; test cho case lệch nhau. |
| A3 | "Pi SDK cho phép tắt hẳn filesystem built-in." | Có seam: `builtinTools?: readonly string[]` (real.ts:130, dùng ở ~403) + `customTools` + `agent.state.tools` (~464–479). | Task 2.3 nêu đúng seam; nếu SDK không cho tắt, fallback là wrap qua customTools cùng tên — ghi rõ trong task. |
| A4 | "`fs.realpath` là đủ để chống symlink escape." | Chưa đủ nếu chỉ canonicalize root mà không canonicalize target, hoặc nếu root identity đổi giữa lúc duyệt và lúc đọc. | Task 2.1 bắt buộc canonicalize cả hai phía và xử lý root identity. |
| A5 | "Dependency closure resolve trước build là tự nhiên." | Không — code hiện resolve ở build time và comment tự nhận "Not built: dependency locking". | Task 3.1 đặt resolve như bước riêng trước mọi bước thực thi, fail closed. |

## 2. Failure

| # | Kiểu thất bại | Resolution |
| --- | --- | --- |
| F1 | Migration chạy hai lần ghi đè cấu hình user đã sửa sau đó. | Migration idempotent + chỉ ghi khi giá trị khác; test chạy hai lần cho cùng kết quả. |
| F2 | Parity test xanh giả do chỉ test một surface. | Task 1.5 bắt buộc matrix có cả command và widget/install, và báo số case đã chạy. |
| F3 | Phase 4 tách file làm đổi response shape mà test không bắt. | Task 4.1 ghim baseline **trước** khi tách; test giữ nguyên assertion, không sửa test theo cấu trúc mới. |
| F4 | Invariant mới ở Phase 5 pass ngay cả khi reference gãy. | Task 5.3 bắt buộc demo reference sai ⇒ exit non-zero, ghi cả hai output vào `evidence.md`. |
| F5 | `gh pr merge --auto` được giả định là dùng được. | Đã kiểm tra: `allow_auto_merge = false`. Merge tường minh sau khi check terminal xanh. |
| F6 | E2E fail vì server sót từ lần chạy trước, đọc nhầm thành regression. | Giải phóng port 8876 và 4273 trước mỗi lần `pnpm test:e2e`, ghi vào verification. |

## 3. Scope

| # | Rủi ro scope | Resolution |
| --- | --- | --- |
| S1 | 6 phase bị gộp thành một PR khổng lồ. | Goal contract khoá "một PR mỗi phase, nhánh riêng từ `main`", phase sau chỉ bắt đầu khi phase trước merge. |
| S2 | Phase 6 lấn sang #93 và duplicate browser/widget frame work. | Task 6.3 yêu cầu kiểm tra vùng chạm và coordinate thay vì duplicate. |
| S3 | Phase 6 "đóng" #2 bằng loopback fixture. | Task 6.2 ghi rõ #2 vẫn mở; Task 6.3 verify state của #2–#5 là OPEN bằng `gh issue view`. |
| S4 | Phase 4 bị dùng để redesign `contracts`/`core`/`storage`. | Plan ngoài phạm vi nêu rõ; Phase 4 chỉ đổi composition layer. |
| S5 | Phase 5 promote PARTIAL lên PASS vì "đã có seam". | Task 5.4: chỉ update khi test được nêu tồn tại; không promote vì seam. |
| S6 | YAGNI: thêm widget/route mới trong lúc tách. | Ngoài phạm vi; Phase 4 là behavior-preserving refactor. |

## 4. Security

| # | Rủi ro | Resolution |
| --- | --- | --- |
| SEC1 | Confinement dựa vào cwd hoặc system prompt. | Cấm tường minh trong Task 2.1/2.3; cwd không được coi là ranh giới. |
| SEC2 | Expose `fs` primitive thô cho Pi tool/extension qua fix. | Cấm trong Task 2.2: chỉ bốn tool có bound, không export Node fs. |
| SEC3 | Jev/guardrail bị dùng để nới quyền. | Resolver chỉ cho guardrail deny/clarify/constrain; mọi nới rộng trả refuse (Task 1.2). |
| SEC4 | Hard boundary (OS/OAuth/browser/vendor) bị mode ghi đè. | Giữ thứ tự quyết định hiện có; parity test có case hard boundary trong mọi mode. |
| SEC5 | Migration ghi đè setting chặt hơn của user ⇒ nới lỏng quyền âm thầm. | Precedence chặt hơn + test riêng cho case `deny`. |
| SEC6 | Lockfile được trình bày như bằng chứng native code an toàn. | Task 3.4 ghi rõ lock chỉ là reproducibility, không phải trust. |
| SEC7 | Secret lọt vào plan/PR/log khi viết evidence. | Không ghi secret/absolute path riêng tư vào plan hay PR; dùng env boundary. |

## Kết luận

Không còn blocker chưa xử lý. Các finding đã được chuyển thành ràng buộc cụ thể trong phase file tương ứng. Hai điều kiện môi trường đã kiểm tra thật và phản ánh vào plan: `main` không branch-protect nhưng `allow_auto_merge = false`, và port e2e cố định 8876/4273.

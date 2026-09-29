---
phase: 4
title: "Hành trình code trọn vẹn (fixture)"
status: done
issues: [197]
---

# Phase 04 — Hành trình code trọn vẹn

## Thiết kế

Chứng minh toàn bộ hành trình bằng các thành phần thật, chỉ ranh giới bên ngoài là giả lập:

1. Repo git local có một bare remote.
2. Shim `gh` trên PATH của lệnh qua broker. Shim ghi lại `pr create --draft` và trả về URL giả.
3. Delivery `issues.labeled` có chữ ký gửi tới `/signals/github`.
4. Intent match, và task được tạo với origin `persistent`.
5. Task chạy trong worktree node quản lý.
6. Worker (fake adapter có script) sửa file, rồi chạy test, `git commit`, `git push` và `gh pr create --draft` qua
   `run_command`.
7. Evidence được ghi lại, và hội thoại báo kết quả bằng lời thường.

Secret: token được Secret Broker tiêm vào đúng lệnh `gh` và `git push`. Test khẳng định giá trị token không xuất hiện
trong transcript, audit hay brief.

Hành trình với GitHub thật cần webhook công khai hoặc polling trên một repo thật cùng token. Việc đó được tách thành
sub-issue `blocked,external-gate`, ghi rõ cần gì.

## Kiểm chứng

- Runtime integration test cho toàn bộ chuỗi trên.
- Cây làm việc của người dùng không đổi.
- Stop giữa chừng thì dừng lệnh, và task được báo là đã dừng.
- E2E: hội thoại hiện câu báo kết quả có liên kết PR.

## Kết quả

- Test hành trình `apps/runtime/test/coding-journey.spec.ts` chạy trên node thật, với worker process thật do fake adapter điều khiển bằng script. Fake adapter có thêm biến thể `callTools`, cho phép một lượt gọi nhiều tool theo thứ tự.
  - Delivery `issues.labeled` có chữ ký → task → sửa file trong worktree → `node --test` → commit → push lên bare remote (với `github_token` qua broker) → `gh pr create --draft` qua shim.
  - Hội thoại báo `Xong` kèm địa chỉ PR do `gh` in ra.
  - Clone của người dùng không đổi.
  - Token không nằm trong bảng hay file nào ngoài credential store.
  - Nhánh được giữ, worktree được gỡ.
  - Hai ca phụ: test hỏng thì task báo "Không xong", không push gì, và worktree được giữ lại và báo; Stop dừng lệnh đang chạy.
- Secret nhập qua card nhận policy theo consumer: `command:*` → `process-env`, còn lại → `tool-only`. Card nhận nhiều consumer, ngăn cách bằng dấu phẩy.
- Output của lệnh được tiêm secret sẽ che value (`[redacted]`).
- `create_automation` xin `github_token` (consumer `command:gh,command:git`) khi task automation chưa có token.
- Worker nhận khối "What started this task" chỉ gồm dữ kiện có cấu trúc của signal.
- Task chốt kết quả theo bằng chứng đầu tiên không được xác minh (`settlingEvidence`). Lỗi gate kèm theo tóm tắt worker.
- Dọn worktree khi khởi động (`worktree-sweep.ts`): theo yêu cầu bổ sung trong #243.
- Giao diện: URL trong câu trả lời plain text thành link (`linkedText`). E2E `automation.spec.ts` chứng minh trên trình duyệt thật.
  - Node fixture không chạy worker, nên trình duyệt không đi qua chính task đó. Chuỗi task được chứng minh bằng integration test.
- Hành trình với GitHub thật (push và PR thật) được gộp vào external gate #250.
- Còn biết: task có hai repository sẽ dùng chung đường dẫn worktree `<taskId>`. Repository thứ hai không tạo được worktree, và task bị từ chối trước khi worker chạy. Vấn đề được theo dõi ở #251.
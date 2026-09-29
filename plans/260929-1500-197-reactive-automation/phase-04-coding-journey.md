---
phase: 4
title: "Hành trình code trọn vẹn (fixture)"
status: pending
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

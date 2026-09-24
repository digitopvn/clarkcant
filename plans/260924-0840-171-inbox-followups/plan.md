---
title: Hộp thư — phần backend còn thiếu và lỗi có từ trước
status: in-progress
created: 2026-09-24
branch: claude/sleepy-mccarthy-ys493l
issues: [169, 170, 171, 172, 173, 174]
---

# Hộp thư — phần backend còn thiếu và lỗi có từ trước

## Kết quả mong muốn

Hộp thư đã ship ở PR #175 nhận thêm những gì backend chưa sẵn sàng lúc đó, và hai lỗi có từ trước được sửa:

- Lỗi có từ trước: từ chối một lệnh để lại bản ghi mà thẻ đọc được (#173); câu "mở hộp …" không còn bị
  intent chọn tệp nuốt (#174, đã vào #175).
- Approval của task được điều phối có route quyết định và hiện trong hộp thư (#172).
- Producer thông báo mới: approval/câu hỏi hết hạn mà chưa ai trả lời, effect `unknown` cần đối soát, kết nối
  OAuth hết hạn/bị thu hồi (#172).
- Thông báo hệ điều hành, tuỳ chọn theo nhóm và giờ yên lặng (#171).
- Kiểm tra cập nhật cho gói đã cài/widget theo directory index, và Pi SDK khi có mạng (#169).

## Ràng buộc

- Giữ nguyên các ràng buộc của plan hộp thư (`plans/260924-0648-inbox-notifications/plan.md`): việc chờ luôn
  suy ra lúc đọc; hộp thư không có route quyết định riêng; không vẽ nút khi route thật chưa có.
- Mỗi producer dùng `tryRecordNodeNotice` với `dedupKey` ổn định; ghi thông báo không làm hỏng việc gốc.
- Thông báo OS là host-owned, chỉ có tiêu đề đã redact, không có payload lệnh hay secret. Quyền thông báo
  của trình duyệt/OS là ranh giới consent cứng.
- Tuỳ chọn là preference lưu ngay, không có nút Save.
- Lỗi mạng khi kiểm tra cập nhật không tạo thông báo lỗi.

## Không làm

- #170 (việc chờ và thông báo từ node khác): phụ thuộc NodeLink pairing (#5) chưa có. Giữ issue mở.
- Nhắc việc / automation đến hạn và yêu cầu ghép cặp node: chưa có scheduler và pairing. Ghi lại trong #172.
- Nút "Cập nhật" nếu chưa có route cập nhật đi qua lifecycle cài/rollback thật.

## Phases

1. [Lỗi có từ trước: #173, #174](phase-01-preexisting-bugs.md)
2. [Approval của task điều phối và producer mới (#172)](phase-02-task-approvals-producers.md)
3. [Thông báo OS, tuỳ chọn theo nhóm, giờ yên lặng (#171)](phase-03-os-notifications.md)
4. [Kiểm tra cập nhật (#169)](phase-04-update-checks.md)
5. [Hợp nhất, kiểm chứng, PR](phase-05-integrate-verify.md)

Phase 2, 3, 4 chạy song song trong worktree riêng; phase 5 hợp nhất tuần tự và chạy e2e một lần (cổng e2e
cố định nên không chạy song song được).

## Tiêu chí chấp nhận

- #173: từ chối để lại bản ghi `decide_approval`, thẻ hiện "đã từ chối" và không còn nút (unit + e2e).
- #172: route quyết định giữ ràng buộc digest; mỗi producer có test ghi đúng một thông báo, gọi lặp không tạo
  dòng mới, thông báo trỏ về hội thoại/đối tượng liên quan.
- #171: e2e tắt một nhóm thì không có thông báo OS cho nhóm đó; thông báo không chứa secret.
- #169: test cho dedup, offline và risk lane.
- `pnpm verify` và `pnpm test:e2e` xanh trên cây đã hợp nhất.

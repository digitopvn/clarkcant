---
title: Hoàn tất rà soát tối ưu test và CI
date: 2026-09-20
summary: "Đối chiếu gate sau đồng bộ main, sửa quét lịch sử và chuẩn bị xác minh trước PR."
---

# Hoàn tất rà soát tối ưu test và CI

## Diễn biến

Đợt rà soát tối ưu test tiếp tục sau khi đồng bộ nhánh main. Workflow mới đã có browser E2E và desktop smoke, nên nhận định cũ rằng CI thiếu hành trình trình duyệt không còn đúng. Tài liệu được sửa theo workflow thực tế; không tạo job trùng và không bỏ gate hiện hữu.

Quét credential trước đây chỉ đọc cây hiện tại dù tải toàn bộ lịch sử. Script `tools/scan-secret-history.mjs` bổ sung kiểm tra các blob còn truy cập được, gồm tài liệu, tệp đã xóa và lịch sử merge; đầu ra không chứa giá trị bí mật. Bộ phân loại tài liệu tiếp tục chạy đầy đủ khi diff có code, không rõ phạm vi hoặc gặp lỗi.

## Bằng chứng và giới hạn

Controller báo đã chạy bốn test tập trung của scanner và quét 1.911 blob lịch sử, không có đối tượng bị đánh dấu. Đây là bằng chứng theo các mẫu nhận diện hiện có, không phải cam kết phát hiện mọi credential. Phần sửa test liên quan ID, tên effect, provider opt-in và timer Pi đang được thực hiện song song; nhật ký chưa xác nhận chúng đã hoàn tất.

## Việc còn lại

Chạy kiểm tra tổng hợp trên phiên bản cuối, đối chiếu các gate và giải quyết lỗi thực tế nếu có. Sau đó tạo PR vào main và merge theo yêu cầu đã được giao khi đủ điều kiện. Tại thời điểm ghi nhật ký chưa có kết luận CI cuối cùng, PR hoàn tất hay merge thành công.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.

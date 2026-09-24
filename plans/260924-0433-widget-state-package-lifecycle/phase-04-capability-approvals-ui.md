# UI duyệt capability đang chờ, grant ∩ preflight

Trạng thái: chờ.

## Yêu cầu

1. `GET /packages/approvals`: approval install-capability đang chờ (`task_id IS NULL`, digest dạng `${digest}:${ref}`, chưa hết hạn), kèm package/version khi tìm được generation.
2. Settings hiển thị từng approval với Cho phép / Từ chối, gọi `POST /packages/approvals/:id/decision` với đúng digest đã hiển thị; kết quả inline. Đây là chrome của host — không bao giờ nằm trong frame.
3. Live route chạy `invocationPreflight` trên từng capability đã cấp; chỉ broker capability đã cấp và sẵn sàng; trả `unavailableCapabilities` kèm lý do.

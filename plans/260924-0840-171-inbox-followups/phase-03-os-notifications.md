# Phase 3 — Thông báo OS, tuỳ chọn theo nhóm, giờ yên lặng (#171)

## Việc làm

1. Preference đã đăng ký cho thông báo hộp thư: bật/tắt theo nhóm (việc chờ duyệt, kết quả việc nền, cập nhật,
   thiết bị khác), bật thông báo OS, giờ yên lặng (bắt đầu/kết thúc theo giờ địa phương).
2. Quyết định gửi thông báo là hàm thuần trong `.ts` (nhóm, giờ yên lặng, đã báo chưa, nhắc một lần khi việc chờ
   còn ≤ 1 phút), có unit test.
3. Desktop: `desktop:notify` trong `apps/desktop/src/main.mjs` gọi Electron `Notification` thật, chỉ tiêu đề đã
   redact; click thì focus cửa sổ và mở hộp thư qua intent `inbox.open`.
4. Web: Web Notification API, chỉ sau khi người dùng bật trong Settings và trình duyệt cấp quyền.
5. Settings → Control: toggle theo nhóm và giờ yên lặng, lưu ngay.

## Kiểm chứng

Unit cho hàm quyết định; e2e: tắt một nhóm thì không có thông báo cho nhóm đó (Notification được thay bằng bản ghi
lại trong trang). Thông báo không chứa secret.

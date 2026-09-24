# Audit UI/UX ClarkCant: web app và desktop app — 2026-09-24

Phạm vi: bề mặt hội thoại, composer, Settings (7 tab) và widget library. Bản desktop nạp chính bản build web, nên các sửa trong `packages/conversation-client` và `apps/web` áp dụng cho cả hai.

Cách kiểm tra:
- Chạy một node runtime cô lập, dùng fixture cho voice, model và session.
- Chụp ảnh ở ba khung hình: 375, 768 và 1440 px.
- Đo tràn ngang và kích thước target bằng script, chụp theme tối và sáng, thêm một lượt với `hasTouch` (pointer: coarse).

## Brief (route: giữ nguyên hệ hiện có)

```text
Register:  Product
Scene:     một người trò chuyện với Clark trên desktop hoặc cửa sổ hẹp, thường ban đêm, cần tập trung
Direction: tối, điềm tĩnh, lấy Orb làm tâm, vì DESIGN.md coi Orb là danh tính và hội thoại là bề mặt chính
Color:     Restrained; dùng token sẵn có --cc-window, --cc-text, --cc-accent
Type:      một họ chữ, token body-md 14 / body-sm 13 / label 12
Signature: Orb động (không thay đổi)
Dials:     variance 3, motion 2, density 6
```

## Phát hiện và cách xử lý

| # | Vấn đề (trước) | Mức | Xử lý |
|---|---|---|---|
| 1 | Tab Settings ở 375 px bị dồn thành cột, mỗi dòng một chữ | Cao | Dải tab nằm một dòng và cuộn ngang (`flex: none`, `nowrap`), mép phải mờ dần để báo còn tab. Tab đang chọn tự cuộn vào khung nhìn |
| 2 | Tên tab bị gãy thành hai dòng trên desktop | Trung bình | Modal rộng 640 px, cỡ chữ tab dùng body-sm |
| 3 | Hàng setting bị chật trên mobile, control tràn ra ngoài mép | Cao | Ở ≤560 px, nhãn và mô tả nằm trên, control nằm dưới |
| 4 | Bảng model pool, guard classes và giá trị `dd` của thiết bị bị tràn | Trung bình | Bảng nằm trong vùng cuộn riêng, các giá trị dài được phép xuống dòng (`overflow-wrap: anywhere`) |
| 5 | Segment đang chọn dùng vòng focus làm dấu chọn, nên "đang chọn" và "đang focus" trông giống nhau | Cao | Segmented control thành một rãnh; segment đang chọn được tô nền accent 18%. Focus giữ outline riêng |
| 6 | Theme và kiểu Orb dùng pill viền rời, không giống các segmented khác | Thấp | Dùng chung `.cc-segmented` với `role="group"` và `aria-label` |
| 7 | Nút trong form bị căn giữa | Thấp | Căn trái trong tab panel |
| 8 | Thẻ "chưa có model" không có padding, nút nằm lệch | Trung bình | Thêm `.cc-setup-card`: dạng hàng trên desktop, dạng cột trên mobile |
| 9 | Dòng model hiển thị liền thành "model: fast⌘] để đổi" và luôn ghi ⌘, kể cả trên Windows/Linux | Trung bình | Tách thành hai phần; phím tắt theo nền tảng (`⌘]` hoặc `Ctrl+]`) và chuỗi được i18n |
| 10 | Console báo CSP chặn font `data:` | Trung bình | Vite không inline `.woff/.woff2` nữa, font tải từ `'self'` |
| 11 | Target 28 px trên màn hình cảm ứng | Cao | Dưới `pointer: coarse`, nút icon là 44×44 và tab, segment, chip cao tối thiểu 44 px |
| 12 | Chip gợi ý lặp tiền tố "Tiếp tục việc: Tiếp tục việc: …" | Cao | Runtime bỏ tiền tố trước khi đưa ra gợi ý và gộp các goal trùng nhau (có test) |
| 13 | Textarea Instructions ở tab Control hẹp, dùng style mặc định của trình duyệt | Thấp | Textarea chiếm hết bề rộng hàng, style giống các trường văn bản khác |
| 14 | Tiếng Việt ghi "tab AI & Routing" trong khi tab thật tên "AI & Định tuyến" | Thấp | Sửa chuỗi cho khớp |

## Kết quả đo sau khi sửa

- Không có trang nào cuộn ngang ở 375, 768 và 1440 px (`scrollWidth` bằng `width` trên cả 33 màn hình).
- Các phần tử còn vượt khung đều nằm trong vùng đã cắt hoặc vùng cuộn có chủ đích: canvas trang trí của Orb, dải tab cuộn ngang và bảng model pool.
- Với pointer coarse: nút icon 44×44; tab, segment và chip cao 44 px.
- Console không còn lỗi CSP font.

## Rubric (0–3)

| Tiêu chí | Điểm | Ghi chú |
|---|---|---|
| Phân cấp thông tin | 3 | Hàng setting xếp chồng rõ ràng trên mobile |
| Nhịp và khoảng cách | 2 | Dùng token spacing, nhưng mật độ tab AI & Routing vẫn cao |
| Trạng thái control | 3 | Selected, focus và disabled tách bạch |
| Responsive | 3 | Không tràn ở cả ba khung hình |
| Truy cập (touch, focus) | 3 | Target 44 px trên màn hình cảm ứng; focus không chỉ dựa vào màu accent |
| Trung thực nội dung | 3 | Phím tắt đúng nền tảng, không có control giả |

## Chưa xác minh

- Bản Electron chưa được chạy trực tiếp; chỉ kiểm tra bản build web mà Electron nạp.
- Chưa kiểm tra bằng thiết bị cảm ứng thật; chỉ giả lập bằng Chromium với `hasTouch`.

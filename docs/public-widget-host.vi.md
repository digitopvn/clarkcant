# Host widget cho tài liệu công khai

[English](public-widget-host.md) · Tiếng Việt

Export mã nguồn `@clarkcant/conversation-client/public-widget` cho phép tài liệu
công khai dùng catalog và renderer widget có sẵn mà không kết nối Clark runtime.
Website dùng entry này tại một commit sản phẩm cố định, không sao chép renderer.
Xem [xuất bản trên website](https://clarkcant.cc/vi/docs/blog.html) và
[issue website #88](https://github.com/digitopvn/clarkcant-web/issues/88).

`mountPublicWidget(element, input)` gắn widget vào shadow root và trả về hàm dọn
dẹp. Input gồm `definitionId`, `version` chính xác, `props`, `semantic`, cùng
`state`, `rows` tĩnh và `locale` (`en` hoặc `vi`) tùy chọn. Host kiểm tra catalog
và props trước khi render; theo `data-theme` của trang, màu hệ thống và tùy chọn
giảm chuyển động. Chỉ mount một lần trên mỗi element; gọi hàm dọn dẹp trước khi
xóa element.

Đây là lớp widget tích hợp được tin cậy. Host chỉ cấp trạng thái hiển thị cục bộ
và dữ liệu đã lưu, không cấp `onAction`, kết nối runtime, công cụ, quyền phê duyệt
hay thông tin xác thực. Điều khiển cần quyền runtime không hoạt động. Renderer
lỗi hiển thị mô tả ngữ nghĩa. Tài liệu bao quanh cũng phải hiển thị mô tả và dữ
liệu bên ngoài JavaScript để hỗ trợ khả năng truy cập và bộ thu thập nội dung.

Ảnh chấp nhận HTTPS không chứa thông tin xác thực, hoặc route `/media/<uuid>`
của website. Host nhúng chịu trách nhiệm phân quyền và chính sách nội dung của
endpoint media. Shadow DOM cách ly CSS, không cách ly mã thực thi bên thứ ba.
Entry này chưa bật cài từ marketplace; widget thực thi không tin cậy vẫn cần
lớp extension cách ly.

`publicWidgetCatalog()` và `validatePublicWidget()` xuất catalog và kiểm tra
schema. Chủ tài liệu chịu trách nhiệm nâng phiên bản; phiên bản không có sẽ
hiển thị văn bản thay vì đoán cách render.

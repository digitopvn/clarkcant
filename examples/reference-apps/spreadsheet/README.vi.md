# Ứng dụng tham chiếu: bảng tính

[English](README.md) | Tiếng Việt

Một gói ClarkCant có một facet giao diện cách ly và không có service. Gói cho thấy cách một widget làm việc với tệp, giữ
một tài liệu lớn trong giới hạn, tự mô tả cho Clark và áp dụng một thay đổi do Clark chọn.

- **Tệp.** Nhập tệp CSV hoặc TSV qua `api.artifacts.pick`; widget đọc theo từng đoạn 256 KiB và không bao giờ thấy đường
  dẫn. Xuất ghi một tệp mới qua `create`, `write`, `finalize` và `export`. XLSX không được hỗ trợ: trong mã nguồn không
  có bộ phân tích đã được thẩm định, và kiểu này không nằm trong danh sách broker tệp của host chấp nhận.
- **Giới hạn.** Tải tối đa 25.000 ô, 64 cột và 5.000 hàng, và một tệp được đọc không quá 8 MiB. Việc đọc dừng ở giới hạn
  và một thông báo cho biết đã hiện bao nhiêu và khi xuất chỉ ghi phần đó. Hàng và cột được vẽ ảo, nên một bảng lớn chỉ
  giữ vài trăm ô trong trang.
- **Trạng thái.** Trạng thái widget giữ tham chiếu tới tệp nguồn, các sửa đổi từ đó, định dạng và ô hiện tại (host cho
  phép 16 KiB). Khi sửa đổi vượt quá mức đó, widget ghi toàn bộ bảng vào một tệp riêng và bắt đầu lại từ tệp ấy. Bản
  thân bảng không bao giờ được chép vào trạng thái.
- **Công thức.** Số học (`+ - * / ^`, dấu trừ một ngôi, ngoặc), tham chiếu (`B2`, `$B$2`), vùng và `SUM`, `AVERAGE`,
  `MIN`, `MAX`, `COUNT`. Một bộ phân tích dựng cây và widget duyệt cây đó; không văn bản nào được chạy như mã. Lỗi là giá
  trị: `#DIV/0!`, `#VALUE!`, `#REF!`, `#NAME?`, `#PARSE!`, `#NUM!`, `#CIRC!` (tham chiếu vòng, được nêu tên trong thông
  báo) và `#LIMIT!`.
- **Chèn công thức vào CSV.** Khi xuất, widget ghi giá trị đã tính, không bao giờ ghi công thức. Một giá trị văn bản bắt
  đầu bằng `=`, `+`, `-`, `@`, tab hoặc ký tự xuống dòng CR được ghi kèm dấu `'` ở đầu, đúng quy tắc của chức năng xuất
  bảng của host; khi nhập, dấu `'` ở đầu được hiểu là "đây là văn bản", nên một tệp đã xuất nhập lại vẫn ra cùng giá
  trị. Định dạng không được ghi vào CSV.
- **Clark đọc được gì.** Tài liệu ngữ nghĩa mang vùng chọn dạng A1, một đoạn trích tối đa 12 hàng × 8 cột, công thức và
  giá trị của ô hiện tại, và kích thước bảng, trong giới hạn ngữ nghĩa của host.
- **Định dạng qua Clark.** Host gắn một hành động `agent` vào instance và truyền id của nó qua prop `formatBinding`. Lần
  bấm không gửi gì; host đọc vùng chọn từ tài liệu ngữ nghĩa của widget và yêu cầu Clark trả lời đúng một dòng,
  `format: percent|number|plain <vùng>`. Widget chỉ áp dụng câu trả lời khi nó đúng là dòng đó cho vùng đã chọn lúc bấm,
  và nói rõ khi không phải. Một yêu cầu gõ trong ô soạn tin tới được Clark qua tài liệu ngữ nghĩa nhưng không thay đổi
  được frame; khoảng trống này được theo dõi ở [#382](https://github.com/digitopvn/clarkcant/issues/382).

Bàn phím: phím mũi tên để di chuyển, Shift+mũi tên mở rộng vùng chọn, Home/End và Ctrl+Home/End để nhảy, Page Up/Down
để lật trang, Enter hoặc F2 để sửa, gõ phím để bắt đầu sửa, Escape để huỷ, Tab sang phải, Delete xoá vùng chọn.

Chạy `clark widget test examples/reference-apps/spreadsheet` và `clark widget pack examples/reference-apps/spreadsheet`.
Unit test nằm trong `test/`, và hành trình trình duyệt là `apps/web/e2e/spreadsheet.spec.ts`.

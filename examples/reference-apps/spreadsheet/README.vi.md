# Ứng dụng tham chiếu: bảng tính

[English](README.md) | Tiếng Việt

Một gói ClarkCant có một facet giao diện cách ly và không có service. Gói cho thấy cách một widget làm việc với tệp, giữ
một tài liệu lớn trong giới hạn, tự mô tả cho Clark và áp dụng một thay đổi do Clark chọn.

- **Tệp.** Nhập tệp CSV hoặc TSV qua `api.artifacts.pick`; widget đọc theo từng đoạn 256 KiB và không bao giờ thấy đường
  dẫn. Xuất ghi một tệp mới qua `create`, `write`, `finalize` và `export`. XLSX không được hỗ trợ: trong mã nguồn không
  có bộ phân tích đã được thẩm định, và kiểu này không nằm trong danh sách broker tệp của host chấp nhận.
- **Giới hạn.** Tải tối đa 25.000 ô, 64 cột và 5.000 hàng, và một tệp được đọc không quá 8 MiB. Việc đọc dừng ở giới hạn
  và một thông báo cho biết đã hiện bao nhiêu và khi xuất chỉ ghi phần đó. Giới hạn ô áp lên hình chữ nhật mà các hàng
  tạo thành (số hàng nhân với hàng rộng nhất), như với một lần sửa, nên tệp có hàng dài ngắn không đều bị cắt ở chỗ hình
  chữ nhật hết vừa. Lần đọc dừng ở 8 MiB bỏ dòng đang đọc dở và báo tệp bị cắt, và dòng trống ở cuối tệp không được tính. Hàng và cột được
  vẽ ảo, nên một bảng lớn chỉ giữ vài trăm ô trong trang.
- **Trạng thái.** Trạng thái widget giữ tham chiếu tới tệp nguồn, các sửa đổi từ đó và định dạng (host cho phép
  16 KiB). Ô hiện tại và vùng chọn là `ephemeralStateKeys`: trạng thái hiển thị mà host không bao giờ ghi xuống node.
  Ngay sau khi nhập, bảng được ghi vào tệp riêng của widget, vì quyền đọc một tệp được chọn chỉ kéo dài 24 giờ; nếu lần
  ghi ấy thất bại, dòng trạng thái nói rõ và lần sửa tiếp theo sẽ thử lại. Khi sửa đổi vượt 10 KiB, widget cũng ghi toàn
  bộ bảng vào một tệp riêng như vậy và bắt đầu lại từ tệp ấy. Mỗi lúc chỉ chạy một checkpoint như vậy; sửa đổi làm trong
  lúc nó đang được ghi vẫn được giữ và lưu sau nó. Khi một checkpoint đã được ghi nhận, widget yêu cầu host huỷ tệp mà
  nó thay thế; nếu host từ chối huỷ, tệp ấy vẫn còn. Bản thân bảng không bao giờ được chép vào trạng thái.
- **Tải bảng.** Cho tới khi bảng được đọc lại từ nguồn lúc gắn vào, lưới không nhận sửa đổi và các nút phải chờ. Nếu
  không đọc được nguồn, dòng trạng thái nói rõ, lưới không nhận sửa đổi, và không có gì được lưu đè lên bảng đã lưu.
- **Công thức.** Số học (`+ - * / ^`, dấu trừ một ngôi, ngoặc), tham chiếu (`B2`, `$B$2`), vùng và `SUM`, `AVERAGE`,
  `MIN`, `MAX`, `COUNT`. Một bộ phân tích dựng cây và widget duyệt cây đó; không văn bản nào được chạy như mã. Lỗi là giá
  trị: `#DIV/0!`, `#VALUE!`, `#REF!`, `#NAME?`, `#PARSE!`, `#NUM!`, `#CIRC!` (tham chiếu vòng, được nêu tên trong thông
  báo) và `#LIMIT!`, chỉ đánh dấu công thức với quá xa và các công thức đọc nó.
- **Chèn công thức vào CSV.** Khi xuất, widget ghi giá trị đã tính, không bao giờ ghi công thức. Một giá trị văn bản bắt
  đầu bằng `=`, `+`, `-`, `@`, tab hoặc ký tự xuống dòng CR được ghi kèm dấu `'` ở đầu, đúng quy tắc của chức năng xuất
  bảng của host. Văn bản mà bảng này sẽ đọc lại thành thứ khác (`007`, `1e3`, hoặc văn bản bắt đầu bằng `'`) cũng vậy.
  Khi nhập, dấu `'` ở đầu được hiểu là "đây là văn bản", nên một tệp đã xuất nhập lại vẫn ra cùng giá trị. Định dạng
  không được ghi vào CSV.
- **Clark đọc được gì.** Tài liệu ngữ nghĩa mang vùng chọn dạng A1, một đoạn trích tối đa 12 hàng × 8 cột, công thức và
  giá trị của ô hiện tại, và kích thước bảng, trong giới hạn ngữ nghĩa của host.
- **Định dạng qua Clark.** Host gắn một hành động `agent` vào instance và truyền id của nó qua prop `formatBinding`. Lần
  bấm không gửi gì; host đọc vùng chọn từ tài liệu ngữ nghĩa của widget và yêu cầu Clark trả lời đúng một dòng,
  và widget nhận `format: percent|number|plain <vùng>`. Widget chỉ áp dụng cho vùng đã chọn lúc bấm, vùng này bị khoá
  tới khi có câu trả lời; nếu không, nó nói rõ. Bảng giữ tối đa 32 định dạng, và dòng trạng thái nêu tên định dạng phải
  bỏ. "Hoàn tác định dạng", hoặc Ctrl+Z trong lưới, lấy lại thay đổi của Clark. Trước khi chạy lần bấm,
  host gửi tài liệu ngữ nghĩa đang chờ của widget và chờ đến khi node đã giữ nó, nên một lần bấm ngay sau khi đổi vùng
  chọn vẫn tới Clark với đúng vùng đó. Một yêu cầu gõ trong ô soạn tin tới được Clark qua tài liệu ngữ nghĩa nhưng không thay đổi
  được frame; khoảng trống này được theo dõi ở [#382](https://github.com/digitopvn/clarkcant/issues/382).

Bàn phím: lưới là một điểm dừng Tab, và Tab, Shift+Tab rời lưới. Phím mũi tên để di chuyển, Shift+mũi tên mở rộng vùng
chọn, Home/End và Ctrl+Home/End để nhảy, Page Up/Down để lật trang, Enter hoặc F2 để sửa, gõ phím để bắt đầu sửa,
Escape huỷ lần sửa hoặc thu vùng chọn, Delete xoá vùng chọn, Ctrl+Z hoàn tác định dạng gần nhất. Khi đang sửa, Tab xác
nhận và sang phải.

Con trỏ và cảm ứng: bấm, Shift+bấm hoặc kéo chuột. Trên màn hình cảm ứng, chạm vào một ô; "Chọn vùng" làm các lần chạm
sau mở rộng vùng chọn. Các nút cao ít nhất 40 px.

Chạy `clark widget test examples/reference-apps/spreadsheet` và `clark widget pack examples/reference-apps/spreadsheet`.
Unit test nằm trong `test/`, và hành trình trình duyệt là `apps/web/e2e/spreadsheet.spec.ts`.

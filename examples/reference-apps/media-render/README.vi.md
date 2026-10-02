# Trình dựng âm thanh (ứng dụng mẫu)

Một widget và một dịch vụ dựng lại tệp WAV người dùng chọn, với mức âm lượng mới và phần cắt ở đầu, cuối. Việc dựng
chạy thành một job mà widget theo dõi được và dừng được. Widget không biết tệp nằm ở đâu, và dịch vụ không nhận đường
dẫn hay handle nào: nó đọc tệp từ host theo từng đoạn, chỉ trong lời gọi được giao tệp đó. Dịch vụ không khai báo
egress, và lời gọi giữ tệp được quyết định là `read` cũng không dùng được egress. Đây là gói mà
`clark widget init --template media-tool` sao chép.

Tiếng Anh: [README.md](README.md).

- **Một facet giao diện và một facet dịch vụ.** Dịch vụ có một capability duy nhất, `…media-render.render@1`, khai báo
  `execution: { kind: "job" }` và `inputArtifacts: { version: 1, fields: ["source"] }`. Gói xin hồ sơ tài nguyên
  `background-compute` theo tên, không bao giờ xin con số.
- **Chọn tệp:** `artifacts.pick({ accept: ["audio/wav"] })` mở hộp chọn của chính host. Widget nhận một `ArtifactRef`
  và giữ nó trong trạng thái widget.
- **Dựng:** widget nhấn binding `invoke` của chính nó, có tên trong props là `renderBinding`, với mã artifact của tệp
  và các thông số. Trước khi gửi lời gọi, host kiểm tra ba điều: widget đang nhấn có quyền trên tệp, tệp đã được niêm
  phong, và tệp nằm trong giới hạn đầu vào của hồ sơ host đã cấp (25 MiB với `background-compute`). Tệp vượt giới hạn
  bị từ chối với `ARTIFACT_INPUT_TOO_LARGE`, và không byte nào của nó tới dịch vụ.
- **Đọc theo đoạn:** chỉ trong lời gọi đó, dịch vụ xin dữ liệu bằng `clarkcant/artifacts.read`, mỗi lần một đoạn tối
  đa 256 KiB. Host cấp quyền lại cho từng lần đọc. Host từ chối mọi mã mà lời gọi không nêu trong một trường đã khai
  báo.
- **Giới hạn từ hồ sơ:** host đưa các giới hạn trong `initialize`, dưới khoá `clarkcant/artifacts`. Chỉ dịch vụ đọc
  được độ dài của tệp, nên dịch vụ từ chối tệp dài hơn `maxMediaSeconds` của hồ sơ trước khi dựng bất cứ phần nào.
  Manifest chỉ nêu tên trường, không bao giờ nêu kích thước, nên không tự nâng được giới hạn nào.
- **Tiến độ:** lấy từ chính `notifications/progress` của dịch vụ qua MCP, tính bằng số byte đã dựng.
- **Dừng:** lệnh huỷ job tới dịch vụ qua cơ chế huỷ của MCP. Dịch vụ ngừng đọc và không trả lời. Host chỉ giữ tệp kết
  quả khi job hoàn tất, nên một lần dựng bị dừng không để lại tệp dở dang nào được trình bày như tệp đã xong.
- **Mở lại:** JobRef nằm trong trạng thái widget, nên frame tải lại vẫn theo dõi đúng lần dựng đó.
- **Xem trước:** tệp đã dựng là một `ArtifactRef` đã chốt. Widget đọc tệp và vẽ dạng sóng trên canvas, rồi hiện thời
  lượng, định dạng và mã băm sha256 do host tính. Chính sách của frame không cho nguồn media, nên không có trình phát
  âm thanh.
- **Đính kèm và lưu:** `artifacts.attachToConversation` đưa tệp đã dựng vào ô soạn tin. `artifacts.export` mở hộp lưu,
  hoặc tải xuống trên web.
- **Hồ sơ không khả dụng:** khi host không cấp được hồ sơ (một quy tắc chính sách từ chối, hoặc container engine quá
  nhỏ), dịch vụ không được chạy ở mức đó hay ở bất kỳ mức nhỏ hơn nào. Nút Dựng bị tắt, và lý do của host hiện ở chỗ
  đó.

Hiện chỉ fixture model có kịch bản của repo mới đặt widget kèm `renderBinding`. Chưa có đường nào trong sản phẩm đặt
một widget của gói đã cài kèm binding ([digitopvn/clarkcant#382](https://github.com/digitopvn/clarkcant/issues/382)),
nên trong bản cài thật nút Dựng bị tắt và lý do được hiện ra.

## Các tệp

- `clarkcant.json`: manifest (phiên bản schema 2).
- `service/server.mjs`: dịch vụ MCP qua stdio. Dịch vụ không có phụ thuộc và chạy chỉ-đọc trong container.
- `service/wav.mjs`: phép biến đổi (WAV PCM 16 bit, đơn kênh hoặc hai kênh, âm lượng và cắt) dưới dạng hàm thuần, và
  đoạn âm thanh mẫu cố định mà các bài kiểm thử và hành trình trình duyệt chọn.
- `widgets/main/widget.json`: props (`title`, `renderBinding`), schema trạng thái, kích thước và văn bản thay thế.
- `widgets/main/render-core.js`: các quy tắc của widget (trạng thái, ý nghĩa của một snapshot job, dạng sóng) dưới
  dạng hàm thuần.
- `widgets/main/main.js`: mã của frame. Phím Escape dừng lần dựng đang chạy.
- `fixtures/`: bốn bộ props mà bộ kiểm tra tuân thủ yêu cầu, và một job mô phỏng cho `clark widget dev`.

## Kiểm tra

```sh
node packages/widget-cli/src/cli.ts widget test examples/reference-apps/media-render
node packages/widget-cli/src/cli.ts widget pack examples/reference-apps/media-render
corepack pnpm exec vitest run examples/reference-apps/media-render apps/runtime/test/service-artifact-input.spec.ts
```

Các hành trình trình duyệt nằm trong `apps/web/e2e/media-render.spec.ts`. Chúng gồm dựng một tệp lớn hơn một đoạn,
có tiến độ và bản xem trước; dừng giữa chừng; mở lại; hồ sơ không khả dụng; chỉ dùng bàn phím; giao diện sáng và tối;
390 px; giảm chuyển động. Các hành trình này cần một container engine chạy được container Linux.

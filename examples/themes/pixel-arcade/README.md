# Pixel Arcade

A data-only ClarkCant reference theme: square frames, beveled controls, hard shadows, stepped motion, bounded scanlines and a Plasma Orb default. The host compiles every style; this package contains no CSS or JavaScript.

From the ClarkCant checkout:

```sh
node packages/widget-cli/src/cli.ts theme dev examples/themes/pixel-arcade
node packages/widget-cli/src/cli.ts theme test examples/themes/pixel-arcade
node packages/widget-cli/src/cli.ts theme pack examples/themes/pixel-arcade
```

The preview is local and uses production components. Static conformance reports browser checks as unverified; use the dev host to check keyboard, widths and reduced motion. Register/install this directory through the existing package lifecycle, then select **Pixel Arcade** under Settings → Experience. Theme reference: `package:org.clarkcant.pixel-arcade#pixel-arcade`. An explicit personal Orb choice overrides Plasma; platform or personal reduced motion always wins.

Font policy: `mono` display profile, `typewriter` code profile and readable `system` body profile. These are host-owned system fallback stacks, not a bundled bitmap font. No font files or external font requests are included. Actual typefaces vary by platform. The original theme data is Apache-2.0; see [LICENSE](LICENSE) and the source URL in [clarkcant.json](clarkcant.json).

## Tiếng Việt

Theme tham chiếu chỉ chứa dữ liệu: khung vuông, nút vát cạnh, bóng cứng, chuyển động theo bước, đường quét có giới hạn và Orb Plasma mặc định. Host biên dịch toàn bộ kiểu; gói không chứa CSS hay JavaScript.

Chạy các lệnh ở trên từ checkout ClarkCant. Bản xem trước chạy tại máy và dùng component sản phẩm. Kiểm tra tĩnh ghi các kiểm tra browser là chưa được xác minh; dùng dev host để kiểm tra bàn phím, chiều rộng và giảm chuyển động. Đăng ký/cài thư mục qua vòng đời package hiện có, rồi chọn **Pixel Arcade** trong Cài đặt → Trải nghiệm. Lựa chọn Orb riêng thắng Plasma; giảm chuyển động của hệ điều hành hoặc người dùng luôn thắng.

Chính sách phông chữ: profile `mono` cho tiêu đề, `typewriter` cho mã và `system` dễ đọc cho nội dung. Đây là các stack fallback hệ thống do host sở hữu, không phải phông bitmap đóng gói. Không có tệp phông hay yêu cầu tải phông bên ngoài. Phông thực tế khác nhau theo nền tảng. Dữ liệu theme nguyên gốc dùng Apache-2.0; xem LICENSE và URL nguồn trong manifest.

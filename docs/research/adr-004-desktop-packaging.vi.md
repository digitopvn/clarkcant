# ADR-004 — Đóng gói desktop cho bản phát hành có ký số (đề xuất)

> [English](adr-004-desktop-packaging.md) · Tiếng Việt

**Trạng thái: đề xuất, chưa quyết định.** Ghi chú này khoanh phạm vi cho spike đóng gói ở #508 bước 1. Chưa có gì ở
đây được xây dựng. Số liệu đo của spike sẽ quyết định; ghi chú này nói cần đo gì, và ta sẽ chọn gì nếu kết quả đúng như
kỳ vọng. Phần Linux và Omarchy phối hợp với #193.

## Bối cảnh

- Ứng dụng desktop (`apps/desktop`) là một vỏ Electron mỏng, chưa được đóng gói. `main.mjs` đặt icon lúc chạy “vì
  chưa có gì đóng gói ứng dụng này”.
- Runtime là một tiến trình Node riêng. Nó chạy TypeScript trực tiếp nhờ cơ chế type stripping của Node
  ([cài đặt](../installation.vi.md)). Runtime sở hữu việc chạy nền, nên đóng cửa sổ không được làm nó dừng.
- Hiện nay cách cập nhật duy nhất là `git pull` rồi chạy setup. Chưa có tag, bản phát hành hay bộ tự cập nhật nào
  ([phát hành](../releases.vi.md)).
- #508 yêu cầu bản phát hành có các tính chất sau:
  - các bản payload theo phiên bản, đặt cạnh nhau và bất biến: Clark đang chạy không bao giờ ghi đè cây đang sống của
    nó;
  - mặc định cài theo người dùng, không cài cho cả máy hay cần quyền admin;
  - artifact có ký số;
  - kích hoạt tại một ranh giới an toàn, không bao giờ bằng cách giết việc đang có ích.

Mọi định dạng đóng gói dưới đây phải mang hai thứ: vỏ Electron, và runtime cùng một Node chạy được nó.

## Windows: MSIX + App Installer, hay Squirrel.Windows

**MSIX cùng App Installer** (ưu tiên, nếu giữ được mọi khả năng của Clark):

- Điểm mạnh:
  - hệ điều hành quản lý cài đặt, cập nhật và gỡ bỏ;
  - cài theo người dùng;
  - cập nhật vi sai;
  - thiết lập cập nhật nằm trong tệp `.appinstaller` (kiểm tra khi mở, kiểm tra nền, hỏi người dùng);
  - danh tính gói có ký số mà chính sách IT (AppLocker, Intune) hiểu được.
- Rủi ro mà spike phải đo:
  1. **Vòng đời runtime chạy nền.** Runtime có tiếp tục chạy sau khi đóng cửa sổ và khi đăng nhập không? Bản cập nhật
     của App Installer xử lý gói đang chạy thế nào: hoãn lại, hay buộc tắt? Buộc tắt việc đang chạy sẽ phá bất biến
     về kích hoạt.
  2. **Ảo hoá hệ thống tệp và registry.** Việc ghi vào `AppData` có thể bị chuyển hướng vào kho riêng của gói. Thư mục
     dữ liệu của Clark, cấu hình của Pi, và các tệp dùng chung với WSL, Docker hay Podman phải nằm ở chỗ công cụ khác
     thấy được.
  3. **Tiến trình con.** Shell, `git`, Docker, Podman và các browser driver mà Clark khởi chạy sẽ thừa hưởng danh tính
     và quy tắc container của gói. Từng thứ vẫn phải chạy được.
  4. **Điểm vào dòng lệnh.** Một app execution alias cho `clark`.
  5. **Ký số.** `Publisher` trong manifest phải khớp chính xác với subject của chứng chỉ SSL.com.

**Squirrel.Windows** (phương án dự phòng):

- Điểm mạnh:
  - cài theo người dùng dưới `%LocalAppData%`;
  - các thư mục `app-<version>` đặt cạnh nhau, khớp với bất biến đặt cạnh nhau;
  - `autoUpdater` có sẵn của Electron trên Windows;
  - không có container, nên không có bất ngờ về ảo hoá.
- Cái giá:
  - trải nghiệm bộ cài cũ hơn;
  - bản cập nhật được bộ cập nhật áp dụng ở lần khởi động sau;
  - Clark phải tự lo nhiều hơn phần logic cập nhật và rollback;
  - hỗ trợ arm64 phải được xác nhận trong spike.

**Đề xuất:** chạy năm phép kiểm tra MSIX ở trên trên x64 và arm64. Chọn MSIX nếu không phép nào hỏng hẳn. Chọn
Squirrel cài theo người dùng nếu có phép hỏng hẳn. Cài cho cả máy hay cần quyền admin không phải mặc định trong cả hai
trường hợp.

## macOS: app bundle, Developer ID, notarization

- Phát hành bundle `Clark.app`:
  - trong `.dmg` cho lần cài đầu;
  - trong `.zip` cho các bản cập nhật, là định dạng mà `autoUpdater` của Electron (dựa trên Squirrel.Mac) dùng.
- Ký số:
  - ký bằng Developer ID với hardened runtime;
  - ký mã lồng bên trong, kể cả binary Node mà runtime dùng;
  - notarize bằng `notarytool`, rồi staple ([ký phát hành](../release-signing.vi.md)).
- Runtime chạy dưới dạng LaunchAgent theo người dùng, nên đóng cửa sổ không làm dừng việc. Spike phải xác nhận cách
  một bản cập nhật bundle thay payload trong khi LaunchAgent vẫn trỏ vào phiên bản cũ. Bản cập nhật phải được stage
  đặt cạnh bản cũ, và việc kích hoạt chỉ chuyển thế hệ tại ranh giới an toàn.

**Đề xuất:** một `.dmg` và một `.zip`, có ký số và đã notarize. Bản cập nhật do UpdateService (#508 bước 3) áp dụng
bằng các primitive gốc của nền tảng, không bao giờ qua một đường mã chỉ dành cho Electron.

## Linux và Omarchy

Electron không có bộ cập nhật dựng sẵn cho Linux, nên việc cập nhật đi theo cách Clark được cài. Đây là các ứng viên;
#193 quyết định cái nào phát hành trước:

- **Gói pacman** trong một kho do Clark sở hữu, có ký GPG. Cách này khớp với `SigLevel = Required DatabaseOptional`
  của Omarchy. Runtime là một dịch vụ `systemd --user`, và pacman sở hữu việc cập nhật.
- **AUR `clarkcant-bin`**: một công thức build trỏ tới các tệp phát hành bất biến, có checksum.
- **Kho gói của Omarchy**: nếu Clark được nhận vào đó, áp dụng quy trình ký và nâng hạng riêng của kho.
- **AppImage hoặc bản portable** cho các bản phân phối khác: artifact bất biến, `SHA256SUMS` và chữ ký GPG tách rời.
  Bản cập nhật do UpdateService stage.

**Đề xuất:** phát hành AppImage trước (portable, không cần kho) cùng một gói pacman có ký số. Thêm công thức AUR khi
các tệp phát hành đã ổn định. Để #193 quyết định về kho Omarchy và bố cục `systemd --user`.

## Công cụ build

Các ứng viên là Electron Forge (có maker cho MSIX, Squirrel, DMG, ZIP và các định dạng khác) và electron-builder.
Spike nên chọn công cụ:

- tạo được mọi target ở trên từ một cấu hình;
- ký qua các lệnh trong [ký phát hành](../release-signing.vi.md) thay vì tự xử lý thông tin xác thực;
- qua được chính sách chuỗi cung ứng của repository (pin chính xác, tuổi phát hành).

## Câu hỏi mở

1. Node của runtime nên được phát hành thế nào: một Node runtime được pin, đóng kèm cạnh Electron, hay Node của
   Electron qua `ELECTRON_RUN_AS_NODE`? Electron đang dùng có hỗ trợ type stripping mà runtime dựa vào không?
2. Với MSIX, runtime có sống lâu hơn cửa sổ và qua được bản cập nhật mà không bị buộc đóng không?
3. Mỗi định dạng dùng thư mục dữ liệu nào, và một bản cài đóng gói có chuyển dữ liệu của bản cài từ mã nguồn sẵn có
   không?
4. Những target arm64 nào thuộc phạm vi bản phát hành có ký số đầu tiên: Windows arm64, Linux arm64?
5. Có một tệp metadata phát hành có ký số cho mỗi kênh không, và khoá nào ký nó: GPG, hay một khoá riêng?
6. Định dạng nào cung cấp danh tính thông báo trên Omarchy mà #340 cần?

## Quyết định

Chưa có. Spike ghi số liệu đo vào đây và chuyển ghi chú này từ **đề xuất** sang **chấp nhận** cùng các định dạng được
chọn. Cho tới lúc đó, tài liệu mô tả các định dạng này là dự kiến, không phải đã phát hành.

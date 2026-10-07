# Ký phát hành: thiết lập cho maintainer

> [English](release-signing.md) · Tiếng Việt

Những gì maintainer chuẩn bị để các bản phát hành ClarkCant được ký số trên Windows, macOS và Linux. **CI hiện chưa có
bước ký nào.** `.github/workflows/release.yml` chỉ lập kế hoạch và xác minh ([phát hành](releases.vi.md)). Hướng dẫn
này ghi lại những gì các bước ký sẽ cần, để thông tin xác thực được đăng ký và thử trước khi các bước đó được thêm vào.

Mọi giá trị dưới đây là placeholder, viết dạng `<NHƯ_THẾ_NÀY>`. Không bao giờ dán thông tin xác thực thật vào issue,
pull request, commit, log hay chat. Chỉ lưu thông tin xác thực dưới dạng secret của environment trên GitHub.

## GitHub: variable, secret, environment

| Loại | Chứa gì | Hiện trong log? | Ví dụ |
|---|---|---|---|
| Variable (`vars.*`) | định danh không nhạy cảm | có | Apple team ID, key ID và issuer ID của App Store Connect, fingerprint khoá GPG, chế độ ký `sandbox`/`product` |
| Secret (`secrets.*`) | mọi thứ trao quyền ký | bị che, không bao giờ in ra | mật khẩu và TOTP secret của SSL.com, tệp `.p12` và mật khẩu của nó, API key `.p8`, khoá riêng GPG và passphrase |

Đặt secret dùng để ký trong **environment**, không đặt ở cấp repository:

- `release-test`: thông tin xác thực TEST và sandbox. Có thể chạy trên `dev` và khi chạy tay.
- `release-prod`: thông tin xác thực production. Nhánh được deploy giới hạn ở `main` và `dev`, và mỗi lần chạy phải
  được một reviewer bắt buộc phê duyệt.

Một secret chỉ tới đúng bước ký, qua `env:`. Công cụ ký đọc nó từ biến môi trường; không bao giờ đặt nó trên dòng lệnh
mà log có thể in lại. Các bước build và test không bao giờ thấy secret dùng để ký.

## TEST trước PROD

Mỗi bộ ký được nối hai lần. Chạy trọn đường TEST và kiểm tra phần xác minh bên dưới trước khi ai đó đăng ký thông tin
xác thực production vào `release-prod`:

- SSL.com: sandbox của eSigner (`-mode sandbox`). Chữ ký của nó không được người dùng cuối tin cậy. Mục đích là chứng
  minh pipeline chạy đúng.
- Apple: ký bằng chứng chỉ Developer ID, và gửi một bản build từ nhánh thử nghiệm đi notarize.
- Linux: ký bằng một khoá GPG dùng xong bỏ, và chỉ xác minh với khoá đó.

## Windows: Authenticode với SSL.com eSigner

Điều kiện:

1. Một chứng chỉ ký mã SSL.com (OV hoặc EV) cấp cho tên nhà phát hành mà Clark dùng, đã đăng ký vào eSigner.
2. Đã thiết lập tự động hoá eSigner cho tài khoản ký, để lấy TOTP secret. Thiếu nó, việc ký sẽ hết thời gian chờ mã.
3. Nếu tài khoản có nhiều chứng chỉ: credential ID của chứng chỉ cần dùng.

| Tên | Loại | Giá trị |
|---|---|---|
| `SSL_COM_MODE` | variable | `sandbox` trong `release-test`, `product` trong `release-prod` |
| `SSL_COM_USERNAME` | secret | `<SSL_COM_USERNAME>` |
| `SSL_COM_PASSWORD` | secret | `<SSL_COM_PASSWORD>` |
| `SSL_COM_TOTP_SECRET` | secret | `<SSL_COM_TOTP_SECRET>` |
| `SSL_COM_CREDENTIAL_ID` | secret, tuỳ chọn | `<SSL_COM_CREDENTIAL_ID>` |

Đường ưu tiên là eSigner CKA (Cloud Key Adapter) cùng `signtool` của Microsoft, trên `windows-latest`, trong một job:

```powershell
# cài eSigner CKA cho người dùng hiện tại, chế độ im lặng, vào $env:CKA_DIR
& "$env:CKA_DIR\eSignerCKATool.exe" config -mode "$env:SSL_COM_MODE" -user "$env:SSL_COM_USERNAME" `
  -pass "$env:SSL_COM_PASSWORD" -totp "$env:SSL_COM_TOTP_SECRET" -key "$env:RUNNER_TEMP\master.key" -r
& "$env:CKA_DIR\eSignerCKATool.exe" unload
& "$env:CKA_DIR\eSignerCKATool.exe" load
# đọc thumbprint của chứng chỉ vừa nạp từ Cert:\CurrentUser\My, rồi:
signtool sign /fd sha256 /tr http://ts.ssl.com /td sha256 /sha1 <THUMBPRINT> <FILE>
```

- Chạy `config`, `unload` rồi `load` đúng thứ tự đó, trong cùng một job.
- Ký mọi tệp thực thi Clark phát hành, rồi tới bộ cài hoặc gói.
- Dùng SHA-256 và dấu thời gian RFC 3161 (`/tr` cùng `/td sha256`). Dấu thời gian giữ chữ ký còn hiệu lực sau khi
  chứng chỉ hết hạn.
- Khi thất bại, chỉ tải log của CKA lên làm artifact sau khi đã xoá mọi thứ trông giống thông tin xác thực.

## macOS: Developer ID và notarization

Điều kiện:

1. Thành viên Apple Developer Program.
2. Chứng chỉ **Developer ID Application**, xuất kèm khoá riêng thành tệp `.p12`.
3. Một **App Store Connect API key** (`.p8`) có quyền notarization. Đây là đường ưu tiên. Mật khẩu riêng cho ứng dụng
   của Apple ID chỉ là phương án dự phòng.

| Tên | Loại | Giá trị |
|---|---|---|
| `APPLE_TEAM_ID` | variable | `<APPLE_TEAM_ID>` |
| `APPLE_API_KEY_ID` | variable | `<APPLE_API_KEY_ID>` |
| `APPLE_API_ISSUER_ID` | variable | `<APPLE_API_ISSUER_ID>` |
| `APPLE_DEVELOPER_ID_P12_BASE64` | secret | base64 của `<developer-id.p12>` |
| `APPLE_DEVELOPER_ID_P12_PASSWORD` | secret | `<P12_PASSWORD>` |
| `APPLE_API_KEY_P8_BASE64` | secret | base64 của `<AuthKey_XXXX.p8>` |

Trong job:

1. Nhập `.p12` vào một **keychain tạm**. Tạo nó trong thư mục tạm của job, mở khoá, và xoá nó khi job kết thúc, kể cả
   khi thất bại.
2. Ký ứng dụng và toàn bộ mã lồng bên trong với hardened runtime, chỉ kèm những entitlement Clark cần.
3. Notarize: `xcrun notarytool submit <APP.zip> --key <AuthKey.p8> --key-id <APPLE_API_KEY_ID> --issuer <APPLE_API_ISSUER_ID> --wait`.
4. Gắn ticket: `xcrun stapler staple <Clark.app>`.

## Linux và Omarchy: GPG và tính toàn vẹn

Điều kiện:

1. Một khoá GPG phát hành riêng của ClarkCant, không dùng vào việc gì khác. Giữ khoá chính offline và ký bằng một
   subkey ký.
2. Khoá công khai và fingerprint được công bố ở nơi người dùng và người đóng gói kiểm tra được.

| Tên | Loại | Giá trị |
|---|---|---|
| `RELEASE_GPG_FINGERPRINT` | variable | `<FINGERPRINT>` |
| `RELEASE_GPG_PRIVATE_KEY` | secret | subkey ký dạng ASCII-armour, `<…>` |
| `RELEASE_GPG_PASSPHRASE` | secret | `<PASSPHRASE>` |

Cách ký từng loại gói tuỳ vào nơi phát hành:

- **Kho pacman do Clark sở hữu:** ký từng `.pkg.tar.zst` bằng chữ ký nhị phân tách rời
  (`gpg --detach-sign --no-armor`, cho ra `.sig`). Ký cơ sở dữ liệu của kho bằng `repo-add --sign`. Chính sách pacman
  của Omarchy yêu cầu chữ ký gói.
- **AUR `clarkcant-bin`:** PKGBUILD ghim các tệp phát hành bất biến với `sha256sums` chính xác, và liệt kê khoá phát
  hành trong `validpgpkeys`. AUR phân phối công thức build, không phải binary của Clark.
- **Kho gói của Omarchy:** nếu Clark được nhận vào đó, làm theo quy trình ký và nâng hạng của kho đó thay vì thêm một
  bộ cập nhật thứ hai.
- **AppImage và bản portable:** phát hành tệp bất biến, một tệp `SHA256SUMS` và chữ ký tách rời của tệp đó.

Đường nào phát hành trước được quyết định cùng #193.

## Danh sách xác minh

Chạy trên các artifact được tạo ra, trong CI và một lần bằng tay trên máy sạch:

- [ ] Windows: `signtool verify /pa /all /v <FILE>` đạt cho bộ cài và mọi tệp thực thi được phát hành. Chữ ký ghi đúng
      nhà phát hành và có dấu thời gian RFC 3161.
- [ ] macOS: `codesign --verify --deep --strict --verbose=2 <Clark.app>` đạt.
- [ ] macOS: `xcrun stapler validate <Clark.app>` đạt.
- [ ] macOS: `spctl --assess --type execute --verbose <Clark.app>` báo `source=Notarized Developer ID`.
- [ ] Linux: `gpg --verify <file>.sig <file>` đạt với fingerprint đã công bố.
- [ ] Linux: `pacman-key --verify` đạt cho từng gói.
- [ ] Linux: `sha256sum -c SHA256SUMS` khớp.
- [ ] SHA-256 của từng artifact khớp với metadata phát hành.
- [ ] Không tệp đã phát hành nào bị thay thế.
- [ ] Đường TEST đã đạt trước khi đăng ký thông tin xác thực PROD.
- [ ] Không log, artifact hay phần tóm tắt nào chứa thông tin xác thực.

## Thiếu thông tin xác thực thì chặn gì

Thiếu thông tin xác thực **chỉ chặn việc phát hành có ký số**: ma trận build và ký, và việc xác minh chữ ký production.
Nó không chặn:

- hợp đồng phát hành;
- workflow lập kế hoạch và cổng chất lượng;
- ghi chú phát hành;
- changelog;
- các spike đóng gói;
- việc hiện thực dịch vụ cập nhật.

| Thiếu | Chặn |
|---|---|
| Đăng ký SSL.com eSigner và TOTP secret | artifact Windows có ký số |
| Chứng chỉ Apple Developer ID và API key | artifact macOS có ký số và đã notarize |
| Khoá GPG phát hành; lựa chọn giữa kho pacman, AUR hay kho Omarchy (#193) | artifact Linux có ký số và metadata của kho |
| Máy Windows, macOS và Omarchy thật | smoke trên nền tảng đã cài (#508, bước 8) |

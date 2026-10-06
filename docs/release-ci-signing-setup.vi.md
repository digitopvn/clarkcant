# Chuẩn bị signing cho Release CI — hướng dẫn maintainer

> [English](release-ci-signing-setup.md) (mặc định) · Tiếng Việt
>
> Trạng thái: hướng dẫn chuẩn bị cho issue #508. File này chỉ chứa tên biến và placeholder. **Tuyệt đối không commit credential thật, private key, TOTP seed, password hay recovery code.**

Tài liệu này liệt kê những thứ maintainer cần chuẩn bị để ClarkCant có thể phát hành bản stable đã ký từ **main** và beta prerelease đã ký từ **dev**.

Workflow mục tiêu cố tình giữ đơn giản:

    push/merge vào main -> SemVer stable
    push/merge vào dev  -> SemVer beta prerelease
                          -> build từng platform
                          -> sign/notarize
                          -> verify
                          -> publish GitHub Release bất biến

Phần implementation thuộc #508; đây là checklist provisioning cho human.

## Nguyên tắc bảo mật

- Giá trị nhạy cảm phải nằm trong GitHub Actions encrypted secrets, không nằm trong repository variables, YAML, issue, shell history hay file commit.
- Ưu tiên credential riêng cho automation.
- Ưu tiên GITHUB_TOKEN theo scope workflow cho tag/release, chỉ dùng token riêng nếu implementation chứng minh thật sự cần.
- Test mọi đường signing ở sandbox/test trước production.
- Phải verify chữ ký sau signing; lệnh trả exit code 0 chưa đủ bằng chứng.
- Không bao giờ đưa signing secret vào code PR từ fork không tin cậy.
- Public identity như certificate subject, fingerprint, Team ID, bundle ID có thể là non-secret variable để CI kiểm tra đúng signer.
- Cơ chế rotate/revoke không được phụ thuộc vào sửa application code.

## Chuẩn bị GitHub

Khi #508 sẵn sàng:

- tạo branch **dev** từ **main** và protect;
- giữ các verification gate bình thường trên cả main và dev;
- tạo GitHub Environment cho production signing, gợi ý tên **release-signing**;
- giới hạn production secrets cho đúng release workflow/branch.

Non-secret variables đề xuất:

| Variable | Mục đích |
| --- | --- |
| CLARK_RELEASE_STABLE_BRANCH = main | nguồn stable |
| CLARK_RELEASE_BETA_BRANCH = dev | nguồn beta |
| WINDOWS_SIGNING_EXPECTED_SUBJECT | kiểm tra Authenticode publisher |
| MACOS_TEAM_ID | Apple signing/notarization identity |
| MACOS_BUNDLE_ID | packaged app identity |
| LINUX_RELEASE_GPG_FINGERPRINT | kiểm tra release signing key |
| SSL_COM_ESIGNER_ENVIRONMENT = TEST hoặc PROD | môi trường eSigner; TEST trước |

Đừng tạo PAT chỉ vì ví dụ của release tool yêu cầu GitHub token. Thử GITHUB_TOKEN với quyền contents: write trước.

## Windows — SSL.com eSigner / Authenticode

### Chuẩn bị một lần

Cần certificate code-signing SSL.com hỗ trợ eSigner:

1. tài khoản SSL.com active;
2. organization/identity validation hoàn tất;
3. certificate đã enroll vào eSigner;
4. eSigner Authenticator đã cấu hình và có automation TOTP secret;
5. test pipeline với môi trường **TEST** của SSL.com trước;
6. chỉ bật **PROD** sau khi sign + verify end-to-end thành công.

#508 hiện ưu tiên **eSigner CKA + signtool.exe** vì CKA expose cloud key qua Windows CNG/KSP và hợp tự nhiên với Authenticode. CodeSignTool là fallback nếu evidence implementation cho thấy tốt hơn.

### GitHub encrypted secrets

| Secret | Bắt buộc | Ghi chú |
| --- | --- | --- |
| SSL_COM_ESIGNER_USERNAME | có | ưu tiên automation/service account |
| SSL_COM_ESIGNER_PASSWORD | có | mật khẩu eSigner |
| SSL_COM_ESIGNER_TOTP_SECRET | có | automation TOTP seed |
| SSL_COM_ESIGNER_CREDENTIAL_ID | tùy | chủ yếu cho CodeSignTool khi việc chọn cert mơ hồ |

Không lưu CKA master.key sinh ra hay certificate-store export thành long-lived secret nếu integration cuối không thật sự yêu cầu.

Ghi lại ngoài secrets:

- certificate subject/publisher name;
- serial number;
- SHA-256 thumbprint nếu phù hợp để pin;
- ngày hết hạn/gia hạn;
- maintainer chịu trách nhiệm;
- RFC3161 timestamp endpoint được chọn.

CI phải verify artifact cuối bằng công cụ Windows như **Get-AuthenticodeSignature** và **signtool verify /pa /v**, đồng thời kiểm tra đúng publisher và timestamp.

## macOS — Developer ID + notarization

Chuẩn bị:

1. Apple Developer Program active;
2. Developer ID Application certificate + private key;
3. Developer ID Installer nếu sau này ship PKG;
4. Apple Team ID;
5. **Team App Store Connect API key** dùng được với notarytool;
6. API key ID, issuer ID và private P8;
7. bundle identifier cuối.

Dùng Team API key cho notarization. Apple ghi rõ Individual App Store Connect API key không dùng được với notaryTool.

Encrypted secrets đề xuất:

| Secret | Bắt buộc |
| --- | --- |
| APPLE_DEVELOPER_ID_P12_BASE64 | có |
| APPLE_DEVELOPER_ID_P12_PASSWORD | có |
| APPLE_NOTARY_API_KEY_ID | có |
| APPLE_NOTARY_API_ISSUER_ID | có |
| APPLE_NOTARY_API_PRIVATE_KEY_P8_BASE64 | có |
| APPLE_DEVELOPER_ID_INSTALLER_P12_BASE64 | chỉ khi ship PKG |
| APPLE_DEVELOPER_ID_INSTALLER_P12_PASSWORD | chỉ khi ship PKG |

MACOS_TEAM_ID và MACOS_BUNDLE_ID là non-secret variables.

CI keychain phải ephemeral. Entitlements/hardened-runtime/package config phải version trong Git, không phải secrets.

Verification tối thiểu gồm codesign verify, Gatekeeper assessment, notarization acceptance và stapler validate. Bất kỳ bước nào fail thì pipeline fail closed.

## Linux / Omarchy / Arch

Linux không có một cơ chế code-signing duy nhất tương đương Authenticode hay Apple Developer ID; trust phụ thuộc distribution path.

Với ClarkCant, giả định **Linux không cần sign** là sai.

Omarchy dựa trên Arch/pacman. Cấu hình pacman hiện tại yêu cầu chữ ký trusted cho repository package với **SigLevel = Required DatabaseOptional**, và Omarchy package repository cũng build + sign package.

Nếu Clark tự sở hữu pacman binary repository:

1. tạo OpenPGP release-signing key hierarchy riêng;
2. giữ primary key offline;
3. CI chỉ nhận signing subkey giới hạn;
4. publish public fingerprint qua authenticated Clark channel;
5. sign từng .pkg.tar.zst và publish detached .sig;
6. sign repository metadata theo thiết kế được chọn trong #193;
7. document rotation.

Nếu Clark được đưa vào official Omarchy package repository, dùng **pipeline build/sign/promote của họ**, không đưa private signing key của Clark vào downstream repo nếu trust model không yêu cầu.

Với AUR clarkcant-bin: AUR phân phối PKGBUILD recipe; recipe phải dùng immutable Clark release asset + checksum chính xác. AUR không thay thế release-integrity model của Clark.

Conditional Linux secrets nếu Clark tự sign:

| Secret | Ghi chú |
| --- | --- |
| LINUX_RELEASE_GPG_PRIVATE_KEY_BASE64 | chỉ CI signing subkey, không phải offline primary |
| LINUX_RELEASE_GPG_PASSPHRASE | passphrase cho subkey |

Non-secret: LINUX_RELEASE_GPG_FINGERPRINT, nơi publish public key, ngày expire/rotate.

Portable/AppImage nên publish immutable artifact, SHA256SUMS và detached signature trên release/checksum metadata. UpdateService verify trước activation.

## Cross-platform release metadata

Ngoài OS-native signatures, #508 đề xuất ký release metadata chung.

Thiết kế đầu tiên đơn giản:

- reuse Clark OpenPGP release-signing subkey;
- sign release.json và/hoặc SHA256SUMS;
- pin expected public fingerprint trong trusted updater path;
- rotate bằng signed trust transition rõ ràng.

Không dùng riêng Windows/Apple certificate làm trust root cross-platform.

## Chuẩn bị version/channel

Trước khi bật auto publish:

1. chốt canonical public Clark version đầu tiên;
2. mọi packaged target derive version từ cùng một nguồn;
3. tạo/protect dev;
4. chốt Conventional Commit release rules trong #508;
5. dev tạo prerelease kiểu x.y.z-beta.N;
6. không có release-worthy commit thì không tạo release;
7. không tái sử dụng version/tag đã publish.

## Dry run signing đầu tiên

Trước khi cho push tự publish:

**Windows**
- dùng eSigner TEST;
- build + sign một artifact đại diện;
- verify publisher identity;
- không lưu production credential material.

**macOS**
- sign bằng Developer ID;
- notarize bằng Team API key;
- staple + validate;
- test Gatekeeper trên máy sạch.

**Linux/Omarchy**
- dùng test signing subkey/repo hoặc signing fixture cô lập;
- verify package signature;
- thử cài trên target disposable có bật signature checking.

**Aggregate**
- generate release manifest/checksum như production;
- sign;
- tải artifact sang verification job/máy khác;
- verify lại từ đầu.

Chỉ sau khi tất cả pass mới cấp production signing secrets cho workflow main/dev.

## Những gì maintainer cần cung cấp sau

Cung cấp qua secure channel đã thống nhất, **không đưa vào GitHub issue hay public chat**.

### SSL.com

- eSigner automation username;
- password;
- TOTP secret;
- Credential ID nếu integration đã chọn cần;
- xác nhận enrollment/validation hoàn tất;
- expected publisher subject;
- quyết định TEST hay PROD.

### Apple

- Developer ID Application P12 + password;
- Team ID;
- Team App Store Connect API key ID;
- issuer ID;
- private P8;
- bundle ID;
- Developer ID Installer P12/password nếu ship PKG.

### Linux

Tùy distribution:

- CI release-signing subkey + passphrase;
- full fingerprint;
- vị trí publish public key;
- hoặc xác nhận Omarchy/downstream repo sẽ tự build/sign từ immutable Clark release source và Clark không cần giữ pacman signing key.

## Rotation / compromise

Nếu credential bị mất hoặc nghi compromise:

1. pause release;
2. revoke/disable vendor credential hoặc subkey;
3. rotate GitHub secret tương ứng;
4. ghi lại signer/release range bị ảnh hưởng;
5. tạo credential mới ngoài repo;
6. cập nhật expected public identity/fingerprint và updater trust transition;
7. chạy lại sandbox/sign/verify trước production.

Không giải quyết signing outage bằng cách tạm publish stable artifact unsigned.

## Nguồn chính thức

- SSL.com eSigner CI/CD: https://www.ssl.com/how-to/integrating-esigner-with-ci-cd-pipelines-a-complete-setup-and-configuration-guide/
- Apple App Store Connect API keys: https://developer.apple.com/documentation/AppStoreConnectAPI/creating-api-keys-for-app-store-connect-api
- Apple notarytool authentication: https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool
- Arch package signing: https://wiki.archlinux.org/title/Pacman/Package_signing
- Omarchy package repository: https://github.com/omacom/omarchy-pkgs
- semantic-release configuration: https://semantic-release.gitbook.io/semantic-release/usage/configuration

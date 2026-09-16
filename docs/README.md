# Agent — Conversation Platform Blueprint v2

**Ngày:** 16/09/2026 · **Trạng thái:** thiết kế để triển khai, chưa có implementation/benchmark được xác nhận.

## Quyết định sản phẩm

**Conversation là giao diện duy nhất người dùng cần học.** Desktop và web là các client của một runtime cài độc lập trên máy cá nhân hoặc VPS. Các runtime đã được ghép nối có thể giao việc, trao đổi dữ liệu được cấp quyền và trả kết quả vào cùng hội thoại. Widgets là vùng tương tác trong hội thoại, có thể pin; extensions giúp mở rộng khả năng qua chính hội thoại.

Tên “Agent” chỉ là tên làm việc, không khóa thương hiệu/domain/npm scope.

## Đọc theo thứ tự

1. [Scope lock](scope-lock.md): mục tiêu, IN/OUT và các quyết định thay v1.
2. [System architecture](system-architecture.md): stack, process, domain, contracts, security và dữ liệu.
3. [Distributed runtime](distributed-runtime.md): cài VPS, pairing, remote delegation, disconnect/recovery.
4. [Widgets & extensions](widgets-and-extensions.md): rich catalog, agent-defined actions, custom mini-apps, pin và lifecycle.
5. [Integration & onboarding](integration-onboarding.md): research/install/auth/reload, Google Calendar, quick play và setup theo nhu cầu.
6. [Browser & Computer Use](browser-computer-use.md): core/pack boundary, driver, node targeting và takeover.
7. [Implementation plan](implementation-plan.md): dependencies, work packages, gates, acceptance scenarios.
8. [Research & decisions](research-and-decisions.md): kết quả kiểm chứng upstream, lựa chọn/rejected alternatives, nguồn.
9. [Changelog](CHANGELOG.md): những ràng buộc cũ đã bị thay thế.

Các JSON trong [examples](examples/) chỉ minh họa **contract riêng của app**, không phải wire protocol chính thức của Pi/MCP/A2A, cũng không phải cấu hình chạy được trước khi app được implement.

## Ưu tiên tài liệu

Yêu cầu người dùng mới nhất → scope-lock → system-architecture → tài liệu chuyên đề → implementation-plan. Bộ v2 **thay thế**, không cộng chồng lên scope v1. Ảnh UI cũ là tham khảo thị giác; không khóa topology, navigation hoặc lời hứa bảo mật.

## Scope phát hành

- Desktop client đầu: macOS Apple Silicon; shared web client cho node server.
- Runtime headless: Linux VPS; OCI image trước, gói Node runtime đi kèm + service installer sau trong cùng release gate.
- Các node cùng owner ghép nối, trao đổi task/message/artifact/status; không cần đồng bộ DB đa chủ.
- Rich widgets dựng sẵn + custom sandboxed mini-app/MCP Apps; pin trong không gian hội thoại.
- Install/setup/auth/reload qua chat với consent và rollback có giới hạn rõ.
- Browser Use và Computer Use là capability quan trọng, driver đóng gói extension; quyền và vòng đời nằm trong core.
- Voice dùng chung task/action model; mobile native và marketplace thương mại chưa nằm trong release này.

## Bốn câu không được quảng cáo sai

“Cài package xong” không đồng nghĩa “integration dùng được”. “Local-first” không đồng nghĩa “dữ liệu không rời máy”. “Đóng UI” không đồng nghĩa “dừng việc trên VPS”. “Có chữ ký/iframe/container” không đồng nghĩa “an toàn tuyệt đối”.

Các nguồn [R01–R30](research-and-decisions.md#nguồn-chính-thức) xác nhận primitive upstream. Kiến trúc, giới hạn, protocol và milestone cụ thể là quyết định thiết kế của bộ tài liệu, không phải tính năng đã có sẵn trong Pi.

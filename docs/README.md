# Agent — Conversation Platform Blueprint v2

**Ngày:** 16/09/2026 · **Trạng thái:** blueprint thiết kế. Repo này đã có bootstrap implementation: hành vi thật do code trong `apps/` và `packages/` sở hữu, trạng thái verify nằm ở [conformance-traceability.md](conformance-traceability.md) và `README.md` ở gốc repo.

## Quyết định sản phẩm

**Conversation là giao diện duy nhất người dùng cần học.** Desktop và web là các client của một runtime cài độc lập trên máy cá nhân hoặc VPS. Các runtime đã được ghép nối có thể giao việc, trao đổi dữ liệu được cấp quyền và trả kết quả vào cùng hội thoại. Widgets là vùng tương tác trong hội thoại, có thể pin; extensions giúp mở rộng khả năng qua chính hội thoại.

Tên “Agent” chỉ là tên làm việc, không khóa thương hiệu/domain/npm scope.

## Đọc theo thứ tự

Trước khi sửa UI/UX, đọc [DESIGN.md](../DESIGN.md) để giữ đúng định hướng tương tác. Quy trình làm việc cho agent nằm trong [AGENTS.md](../AGENTS.md); bằng chứng và giới hạn triển khai nằm trong [conformance-traceability.md](conformance-traceability.md).

1. [Scope lock](scope-lock.md): mục tiêu, IN/OUT và các quyết định thay v1.
2. [System architecture](system-architecture.md): stack, process, domain, contracts, security và dữ liệu.
3. [Distributed runtime](distributed-runtime.md): cài VPS, pairing, remote delegation, disconnect/recovery.
4. [Widgets & extensions](widgets-and-extensions.md): rich catalog, agent-defined actions, custom mini-apps, pin và lifecycle.
5. [Widget developer standard](widget-development.md): authoring contract, SDK UX, conformance, package/publish flow và directory metadata.
6. [Integration & onboarding](integration-onboarding.md): research/install/auth/reload, Google Calendar, quick play và setup theo nhu cầu.
7. [Browser & Computer Use](browser-computer-use.md): core/pack boundary, driver, node targeting và takeover.
8. [Implementation plan](implementation-plan.md): dependencies, work packages, gates, acceptance scenarios.
9. [Research & decisions](research-and-decisions.md): kết quả kiểm chứng upstream, lựa chọn/rejected alternatives, nguồn.
10. [Jev selector](mini-app/jev-configuration.md): vận hành và privacy của lớp quyết định — cấu hình, phần gửi ra ngoài, telemetry, fallback.
11. [ADR-001 — Gemini Live cho voice](research/adr-001-gemini-live-provider.md) và [P0.1 compatibility lock](research/compatibility-lock.md): quyết định thay thế blueprint, và lifecycle Pi SDK đã đo thật.
12. [Changelog](CHANGELOG.md): những ràng buộc cũ đã bị thay thế.

Các JSON trong [examples](examples/) chỉ minh họa **contract riêng của app**, không phải wire protocol chính thức của Pi/MCP/A2A, cũng không phải cấu hình chạy được trước khi app được implement.

## Ưu tiên tài liệu

Yêu cầu người dùng mới nhất → scope-lock → system-architecture → tài liệu chuyên đề → implementation-plan. Bộ v2 **thay thế**, không cộng chồng lên scope v1. Ảnh UI cũ là tham khảo thị giác; không khóa topology, navigation hoặc lời hứa bảo mật.

[DESIGN.md](../DESIGN.md) sở hữu định hướng UI/UX; [system-architecture.png](system-architecture.png) là sơ đồ kiến trúc hiện hành khi khác với phần mô tả. Đây là các nguồn thiết kế, không phải bằng chứng tính năng đã phát hành. Đặc biệt, Autonomous là policy mục tiêu; đường thực thi command hiện tại vẫn dùng approval, xem [model-turn.ts](../apps/runtime/src/model-turn.ts) và [gateway.ts](../apps/runtime/src/gateway.ts).

## Scope phát hành

- Desktop client đầu: macOS Apple Silicon; shared web client cho node server.
- Runtime headless: Linux VPS; OCI image trước, gói Node runtime đi kèm + service installer sau trong cùng release gate.
- Các node cùng owner ghép nối, trao đổi task/message/artifact/status; không cần đồng bộ DB đa chủ.
- Rich widgets dựng sẵn + custom sandboxed mini-app/MCP Apps; pin trong không gian hội thoại.
- Install/setup/auth/reload qua chat với consent và rollback có giới hạn rõ.
- Browser Use và Computer Use là capability quan trọng, driver đóng gói extension; quyền và vòng đời nằm trong core.
- Voice dùng chung task/action model; mobile native và marketplace thương mại chưa nằm trong release này.

## Kiểm tra CI theo phạm vi thay đổi

Workflow [CI](../.github/workflows/ci.yml) giữ các gate verify, secret scan, browser E2E và desktop smoke. [Bộ phân loại](../tools/ci-test-scope.mjs) chỉ rút gọn các bước của job verify khi toàn bộ diff thuộc danh sách văn xuôi được phép hoặc `docs/manifest.json`; invariants vẫn chạy. Những gate còn lại không bị bộ phân loại này bỏ qua. Diff có code, đường dẫn chưa biết, thiếu base hoặc lỗi phân loại vẫn chạy đầy đủ.

Các thay đổi có code vẫn chạy toàn bộ Vitest trên cả hai phiên bản Node; không chọn test theo package vì nhiều ràng buộc an toàn đi xuyên package. Lệnh kiểm tra hành trình và yêu cầu hoàn tất thay đổi UI nằm trong [AGENTS.md](../AGENTS.md); CI đã có browser E2E và desktop smoke, nhưng fixture không chứng minh provider thật hoạt động. Kết quả BLOCKED phải được đọc cùng điều kiện còn thiếu.

Các suite live chỉ chạy khi bật opt-in. Khi đã bật mà thiếu credential/model hoặc không nhận được bằng chứng từ provider, smoke/calibration thất bại với lý do `BLOCKED`, không chuyển sang PASS nhờ fallback. [Live smoke](../apps/runtime/test/jev-live.spec.ts) và [calibration](../apps/runtime/test/jev-calibration-live.spec.ts) sở hữu điều kiện thực thi; một HTTP lỗi chung không chứng minh từ chối đúng model.

Chạy `node tools/scan-secret-history.mjs` để kiểm tra lịch sử Git đã tải đầy đủ; [script quét](../tools/scan-secret-history.mjs) sở hữu các mẫu nhận diện và giới hạn đầu ra. Phạm vi gồm các phiên bản tệp còn truy cập được trong lịch sử, kể cả tài liệu và tệp đã xóa; đây là kiểm tra theo mẫu, không chứng minh mọi loại bí mật đều được phát hiện. Clone nông hoặc kho Git không đọc được làm kiểm tra thất bại. Kết quả chỉ nêu mã đối tượng và loại mẫu, không in giá trị bí mật.

## Bốn câu không được quảng cáo sai

“Cài package xong” không đồng nghĩa “integration dùng được”. “Local-first” không đồng nghĩa “dữ liệu không rời máy”. “Đóng UI” không đồng nghĩa “dừng việc trên VPS”. “Có chữ ký/iframe/container” không đồng nghĩa “an toàn tuyệt đối”.

Các nguồn [R01–R30](research-and-decisions.md#nguồn-chính-thức) xác nhận primitive upstream. Kiến trúc, giới hạn, protocol và milestone cụ thể là quyết định thiết kế của bộ tài liệu, không phải tính năng đã có sẵn trong Pi.

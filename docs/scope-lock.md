# Scope Lock v2 — Conversation-first, runtime-anywhere

**Ngày:** 16/09/2026 · **Release mục tiêu:** v0.2 foundation beta. “v2” là phiên bản blueprint, không phải phiên bản phần mềm đã phát hành.

## 1. North star

Người dùng giao việc, tùy biến app, kết nối dịch vụ, cài extensions và tạo/pin mini-apps bằng hội thoại. Họ không cần học session, MCP config, process, node topology hay trang settings nhiều cấp. Chat, voice và widget là ba cách tương tác với cùng hệ thống, không phải ba sản phẩm.

Tối giản là **giảm công sức ra quyết định**, không phải buộc mọi thao tác thành câu chữ. Một nút play, form đăng nhập bảo mật, chọn ngày, nút dừng và pin là hợp lệ; sidebar session, file tree bắt buộc và dashboard quản trị thường trực thì không.

## 2. Product boundary

App gồm **Agent Runtime + Conversation Client + Capability Packs + optional Connectivity Adapter**. Electron chỉ là vỏ desktop. Cài lên VPS không cài Electron, không chạy virtual desktop chỉ để có khung chat.

Mỗi cài đặt runtime là một **node tự chủ**, có state, credentials và phạm vi tài nguyên riêng. Desktop có thể dùng node local, attach một node server, hoặc dùng node home để điều phối các node đã pair. Vai trò home là theo conversation; không có máy “master” cố định cho toàn mạng.

Đối tượng đầu: một owner có một hoặc nhiều máy/VPS. Kiến trúc có owner/principal/scopes nhưng chưa là SaaS đa tenant đối nghịch hay công cụ chia sẻ nội bộ doanh nghiệp hoàn chỉnh.

## 3. Quyết định đã khóa

| Vấn đề | Chốt v2 |
|---|---|
| Stack | TypeScript xuyên client/runtime; Node LTS + Pi SDK; React; Electron chỉ cho desktop |
| VPS | OCI image non-root, volume bền vững; native headless package/service là đường thứ hai; web chat dùng cùng UI |
| Persistence | SQLite + outbox/inbox trên từng node; không sync SQLite bằng shared volume hoặc multi-master |
| Peer communication | Native versioned command/event/delegation protocol, TLS và app-level pairing; A2A là adapter interoperability về sau |
| Connectivity | HTTPS endpoint reachable hoặc adapter mạng riêng Tailscale; không tự xây NAT traversal/crypto từ đầu |
| Rich UI | Catalog khai báo nhanh + sandboxed mini-app runtime; MCP Apps được đưa vào scope |
| Widget actions | Agent định nghĩa action từ capability đã discover, agent intent, workflow hoặc local view action; core validate/quyền hóa |
| Pin | Pin instance/state vào vùng nhỏ trong conversation; không mở dashboard riêng hoặc một agent mới |
| Extensions | Research → proposal → consent → staged install → test → activate/reload → resume; user-authored packages được hỗ trợ |
| Browser Use | First-party pack dựa trên Playwright; API/DOM-first, screenshot khi cần; binary tải theo nhu cầu |
| Computer Use | Optional first-party driver packs: macOS desktop + Linux virtual desktop; core giữ lease, permissions, cancellation |
| Auth | Guided flow trong chat, nhưng OAuth/OS consent có thể mở system browser/settings rồi quay lại |
| Onboarding | Hai đường: quick play bằng sample rõ nhãn, hoặc setup theo nhu cầu; không questionnaire dài |
| Voice | GPT-Live adapter đầu tiên theo tài khoản kiểm chứng; cùng command gateway; không restart voice khi reload Pi |
| Personalization | Preferences/skills/recipes/widgets/extensions; scope/source/undo; không hidden memory |

## 4. IN — đầy đủ trong v0.2 foundation beta

| ID | Feature | Acceptance boundary |
|---|---|---|
| V01 | Conversation client | Một timeline/composer; text/voice/actions; shared React UI desktop/web; không cần session picker |
| V02 | Portable runtime | macOS helper và Linux headless; server chạy không cần GUI/global Pi; version/health reporting |
| V03 | Persistent task/session runtime | Conductor responsive, worker budgets; task≠session; resume/steer/cancel/evidence |
| V04 | Trusted node linking | Pair/revoke/inspect bằng chat; local + hai VPS test topology; scoped capability discovery |
| V05 | Remote collaboration | Delegate/subtask/status/artifacts/input requests; stable IDs, retry dedup, reconnect; không blind failover write |
| V06 | Workspace registry | Node-qualified paths/resources, aliases, roots; một writer/resource; explicit file transfer |
| V07 | Capability platform | API/MCP/Pi/native/UI facets; lazy discovery; install plan, exact versions, dependency lifecycle |
| V08 | Conversational install | Research nguồn → consent → sandboxed staging hoặc explicit trusted-host path → healthcheck → activate → resume |
| V09 | Credential/auth setup | Secure input, browser OAuth, scopes, connection test, revoke/reauth; secrets không vào chat transcript |
| V10 | Reference integration | Google Calendar: connect, chọn calendar, đọc agenda, tạo/sửa event có preview/consent; refresh/reconnect |
| V11 | Rich built-ins | Catalog phong phú ở widgets-and-extensions; interactive actions, nguồn/freshness và accessibility |
| V12 | Custom widgets | Chat-authored catalog compositions; user/third-party executable UI trong isolated mini-app host; MCP Apps bridge |
| V13 | Pins | Persistent logical instance, compact/expanded mode; không duplicate player/call; pin không grant background privileges |
| V14 | Browser Use | Managed profile, DOM tools + screenshot, browser preview/takeover, capability & outcome checks |
| V15 | Computer Use | One macOS driver và one Linux virtual-desktop profile; app/window scope where enforceable; explicit foreground consent |
| V16 | Onboarding/personalization | Quick play, needs-based setup, skip/resume, minimal useful install plan; preference undo |
| V17 | Live voice | Natural interruption/correction; same surface/action/task state; text fallback; media focus coordination |
| V18 | Operations/security | Upgrade/drain, backups, rollback of package activation, telemetry redaction, resource budgets, failure injection |

“Reference integration” không cấm cài connector khác. Nó xác định integration mà chính sản phẩm phải chứng minh chạy end-to-end để release; các dịch vụ khác chạy qua extension protocol theo compatibility và quyền thực tế.

## 5. OUT — vẫn chủ động chưa làm

Native mobile client, Windows desktop release, cộng tác đa người realtime/CRDT, multi-master timeline, tự failover side effects sang node khác khi partition, đồng bộ mọi session/secrets giữa các máy, public unauthenticated agent endpoint, custom internet-wide peer discovery, marketplace/payment/review social network, tự patch core app, swarm sinh vô hạn.

Không cam kết sản phẩm đã có đầy đủ Spotify/Telegram/Zoom/Notion integrations ở ngày đầu. SDK và host phải biểu đạt được các use case đó; examples và conformance tests chứng minh khả năng. Chính sách vendor, OAuth approval, SDK/browser support và quyền tài khoản vẫn là gate riêng.

Không yêu cầu viết lại browser engine, media conferencing server hay native automation engine. Reuse driver/SDK đã kiểm chứng qua adapter. Không coi một webpage có thể iframe tùy ý là “third-party integration”.

## 6. Core tối thiểu nhưng không yếu

Core: identity/policy/consent; commands/events; task/effects; capabilities/install supervisor; integration/auth vault; surface/state/pin/action host; node transport; resource leases/cancel; retention/budget. Đây là hạ tầng dùng chung để extension không tự làm một hệ thứ hai.

Pack: domain tools, API adapter, MCP server config, Pi skills/extensions, widgets, browser/computer drivers, onboarding recipes. Driver có thể không cài, nhưng contract và quyền tương ứng đã có trong core.

## 7. Golden journeys

**J1 — tò mò:** mở app → chọn thử ngay → tương tác chart/map/note mẫu → pin → hiểu cách chat; không cần API key cho scripted sample. Muốn chat AI thật thì setup provider trong cùng flow; không ngụy trang demo thành inference thật.

**J2 — lịch cá nhân:** “Xem lịch tuần này” → app chọn integration phù hợp → xin consent → auth ở browser tin cậy → probe → calendar thật → pin → nói “dời lịch này” → preview mutation → xác nhận → verify.

**J3 — cài thứ đang thiếu:** task nhận ra cần một capability → app research → đề xuất một lựa chọn có nguồn/phiên bản/quyền → user đồng ý → stage/test → activate đúng node → reload đúng worker khi cần → tiếp tục đúng task revision.

**J4 — nhiều máy:** desktop nhờ VPS A build, VPS B kiểm tra một môi trường khác theo quyền → results/artifacts về cùng chat; desktop đóng thì remote jobs không chết. Mất mạng không biến thành fake progress hoặc duplicate run.

**J5 — custom mini-app:** “Tạo widget ghi chú checklist và ghim lại” → composition hoặc isolated bundle → preview/test/approve → pin; restart vẫn giữ draft, không tự grant filesystem/network.

**J6 — browser/computer:** API thiếu thao tác → app đề xuất managed browser; nếu cần desktop app thì chọn đúng device, hỏi foreground/capture/input → preview/takeover → dừng bằng host control; không bấm consent bằng computer tool.

## 8. Definition of done

V01–V18 có trace tới milestone/test. J1–J6 chạy trên clean environments, có ít nhất một provider/connector thật và bằng chứng hai VPS phối hợp. Toàn bộ UI có thể vận hành qua chat cùng các system/native consent bắt buộc. Không dùng prototype video thay cho fault/recovery tests.

Các feature chưa đạt API/account/signing/driver gate phải ghi blocked, không đổi tên thành “supported” để kịp release. Scope mở rộng là có chủ đích; thứ tự implementation theo dependencies, không ép tất cả vào một PR.

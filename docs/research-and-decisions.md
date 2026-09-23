# Research & Architecture Decisions

**Kiểm chứng:** 16/09/2026, tài liệu upstream chính thức. **Chưa thực hiện:** chạy codebase, cài các packages vào sản phẩm, live OAuth/voice/desktop-driver benchmarks hoặc certify vendor integrations. URL `latest`/branch `main` có thể thay đổi; P0 phải pin exact versions/commits đã chạy thử.

## 1. Kết quả nghiên cứu ảnh hưởng trực tiếp tới scope

| Finding từ upstream | Tác động thiết kế |
|---|---|
| Pi hỗ trợ SDK embedding, resources và extensibility; code extensions có quyền process [R01–R04] | Giữ Pi adapter; không đưa untrusted native extensions vào privileged core |
| Pi có resource reload qua command context và dynamic tool registration [R03] | Reload chọn đúng facet/worker; không restart cả app cho mọi integration |
| Chord có facets/services/state nhưng không định nghĩa toàn bộ app transport [R05] | Candidate composition runtime, không shortcut cho federation/security |
| MCP Apps có isolated UI + host messaging [R06–R08] | Thêm lane chuẩn cho third-party mini-apps, không chỉ fixed catalog |
| MCP auth tùy capability/metadata; registry identity không phải code audit [R09,R30] | Discover và validate thật; install/readiness có consent và probes |
| A2A hướng task/message/artifact interoperability [R10] | Dùng adapter external-agent về sau; native NodeLink giữ app semantics |
| Playwright MCP dựa structured accessibility, không là security boundary [R11] | Browser driver DOM-first, isolation/policy do host |
| Browser Use là một stack có SDK/CLI/hosted lựa chọn [R12] | Optional implementation, không buộc mọi runtime thêm một planner/backend |
| Computer-use examples cần môi trường desktop/browser và controls [R13–R16] | Native macOS và Linux virtual desktop là hai target khác nhau |
| Google installed-app OAuth dùng system browser, client registration và supported redirects [R18] | Conversation dẫn dắt auth nhưng không nhúng consent tùy ý |
| Google native và web auth có khác biệt về scopes/flow [R18–R20] | Request least scopes; reauth đúng client type, không giả incremental universal |
| Vendor player/call/message/editor có account/platform/SDK giới hạn [R22–R25] | Rich SDK ≠ mọi vendor app hoạt động ngay trên mọi client |
| Electron privileged renderer/IPC cần hardening; node:vm không là security [R26–R27] | Custom UI chạy isolated origin; tool code isolation ở OS/service boundary |
| Existing private-network connectivity đã xử lý direct/relay paths [R28] | Optional adapter, không tự xây custom internet relay ở release đầu |
| Voice tách frontend và delegated backend [R29] | Voice không sở hữu task state; Pi reload không hủy media session. Provider hiện là Gemini Live, không phải GPT-Live: [ADR-001](research/adr-001-gemini-live-provider.md) |

## 2. ADR v2

### ADR 2026-09-17 — native deps tùy chọn cho semantic search, và quyết định giữ FTS-only

`node:sqlite` không cần build step, nên storage không có compiled dependency nào phải audit. Semantic
retrieval thì cần hai thứ native: `sqlite-vec` (extension loadable, prebuilt theo platform) và ONNX
runtime cho embedding model. Quyết định: khai báo **`optionalDependencies`**, và biến "thiếu" thành
một trạng thái có lý do thay vì lỗi cài đặt.

- `pnpm install` và `pnpm verify` phải pass khi không có cả hai. Search khi đó là FTS5 thuần, và node
  in ra lý do (`sqlite-vec is not installed`, `the local embedding runtime is not installed`).
- Bảng vector (`history_vec`) **không** tạo trong migration: `vec0` chỉ tạo được trên connection đã load
  extension, và migration chạy trên mọi máy. Migration chỉ tạo `history_embeddings_meta` (SQL thuần);
  bảng vector được tạo lazy khi extension có mặt. Nếu để trong migration, một database tạo trên máy
  thiếu extension sẽ vĩnh viễn không có bảng vector.
- Model đổi → **reindex**, không trộn vector khác model: index ghi `model`/`dims`/`digest` trên từng
  vector và từ chối khi model hiện tại khác.
- `onnxruntime-node` được thêm vào `allowBuilds` (postinstall tải platform runtime). Đây là ngoại lệ có
  chủ đích cho supply-chain policy, không phải nới policy chung.

**Đo trên corpus Phase 8 (34 query, 15 history row, E5-small quantized, sqlite-vec v0.1.9):** FTS thuần
đúng top-1 31/34; hybrid cũng 31/34 khi ceiling cosine = 0.1, và giảm còn 25/34 khi ceiling ≥ 0.2 vì
KNN luôn trả về hàng xóm gần nhất kể cả khi câu hỏi không có kết quả đúng. Subset "semantic-only" (12
query không trùng từ vựng) không cải thiện: 9/12 ở cả hai đường. **Kết luận: hybrid không cải thiện trên
corpus này, nên `CLARKCANT_SEARCH_SEMANTIC` mặc định tắt**; code hybrid vẫn nằm sau flag để đo lại khi
có corpus lớn hơn hoặc model tốt hơn.

### ADR 2026-09-19 — autonomous execution mặc định, và authority nằm ở host chứ không ở thẻ duyệt

Ở trạng thái trước quyết định này, `run_command` dùng thẻ duyệt làm security boundary chính: `guardCommand()` trong `apps/runtime/src/run-command.ts` đã bỏ giới hạn thư mục và tự nói ra lý do ("node không giới hạn thư mục nữa, nên thẻ duyệt này là chỗ bạn quyết định"). Xoá approval rồi giao quyền quyết định cho Jev là biến Jev thành security boundary duy nhất — một model làm việc đó là kiến trúc bị bác.

Quyết định: mặc định chuyển sang autonomous, và authority vẫn ở host.

- **Host preflight là invariant cứng.** Schema, capability tồn tại, resource tồn tại, budget (timeout, output cap, số target) và ranh giới secret chạy trước mọi quyết định của model; không model nào ghi đè được. **Containment theo resource ownership** thuộc tầng này: effect phải nằm trong resource mà conversation/node sở hữu, ra ngoài bị từ chối ở preflight.
- **Jev chỉ được thu hẹp.** Nó trả `allow`/`deny`/`constrain`/`clarify` trên một operation mà preflight đã xác định là technically valid; nó không cấp quyền, không mở rộng scope, không đọc secret value.
- **`ExecutionPolicy` thay boolean approval:** `auto | guarded | confirm | deny`, mặc định `guarded` — không hỏi user, Jev được block/constrain. `confirm` tái tạo đúng hành vi approval cũ như một policy mode, nên approval infrastructure không bị xoá ở phase đầu; đổi default trước, giữ đường cũ cho regression, rồi mới hạ nó xuống optional.
- **Fail-open khi Jev vắng** là mặc định và đổi được trong settings. Fail-open bỏ lớp judgment, không bao giờ bỏ preflight hay containment.
- **`clarify` không phải xin phép.** Câu hỏi làm rõ giữa nhiều khả năng đều hợp lệ đi qua Interaction Manager (§7.5 system-architecture); “bạn có cho phép không?” không phải clarify.

Đánh đổi: autonomous mặc định giảm ma sát nhưng tăng blast radius khi model sai. Bù lại bằng containment, budget, secret isolation, emergency stop và audit trail — không bằng hộp thoại xác nhận.


|---|---|---|
| B01 | Portable Node runtime + shared web UI + optional Electron | Bỏ desktop-only coupling; thêm package/platform matrix |
| B02 | One home/conversation, autonomous execution peers | Không multi-master/offline failover tự động; rõ authority |
| B03 | Native NodeLink cho cùng app; MCP/MCP Apps interoperability | Không ép A2A thành protocol chứa mọi UI/state |
| B04 | HTTPS/private-network reachability, app pairing/grants | Không xây NAT/crypto/relay riêng ngay; operator cần endpoint/network phù hợp |
| B05 | Core quyền/state/lifecycle; domain/OS features là packs | Core không chứa tất cả integrations nhưng giữ trust invariants |
| B06 | Agent-defined actions: view/invoke/agent/workflow | Bỏ fixed business-button limitation của v1; giữ server authorization |
| B07 | Rich catalog + isolated custom apps/MCP Apps | Thêm SDK/sandbox/conformance cost để mở ecosystem thực sự |
| B08 | Pinned instances độc lập task/session | State migrations/media ownership/refresh policies là first-class |
| B09 | Research/install/test/activate/reload/resume qua chat | Thêm supply-chain/executable-code boundary, không “npm install là xong” |
| B10 | Browser Playwright + optional driver alternatives | Giữ Pi planner; không bắt cloud/Python/another agent loop |
| B11 | macOS native + Linux virtual desktop drivers | Computer Use nằm scope, platform permissions là release gate |
| B12 | Auth broker và reference Calendar connector | Không claim mọi SaaS connect tự động khi thiếu app registration/auth |
| B13 | Guided onboarding hoặc clearly labeled quick play | Không bắt key để xem sample; AI thật vẫn cần provider hợp lệ |
| B14 | Version-pinned optional Chord spike | Không reimplement toolkit nếu fit; cũng không khóa framework chưa thử |
| B15 | Native mobile/marketplace/cross-owner federation về sau | Foundation release vẫn lớn nhưng không xây mọi business layer |
| B16 | Autonomous execution mặc định; approval hạ thành policy mode `confirm` | Bỏ thẻ duyệt làm security boundary, nên phải có containment + budget + stop/audit thay thế |
| B17 | Host preflight giữ authority; Jev chỉ được thu hẹp | Không để model quyết định quyền; Jev vắng thì mất judgment chứ không mất kiểm soát |

## 3. Những điều còn phải đo/kiểm chứng trước code lock

Phiên bản Pi SDK/resource loader chính xác; pack compatibility trên macOS/Linux x64/arm64; Chord failure/reload semantics; provider account/model access; Electron isolation/media/DRM support; Google OAuth app registration/verification; native driver signing/TCC; rootless sandbox support theo host; actual remote reconnect/failure behavior.

Đây là **implementation gates**, không phủ nhận scope. Thất bại cần sửa adapter, thay dependency hoặc ADR rõ; không lặng lẽ xóa feature mà vẫn báo hoàn tất.

## 4. Nguồn chính thức

Mỗi Rxx xác nhận thông tin upstream tương ứng, không xác nhận các API tự đặt của blueprint đã tồn tại. Nhiều Rxx có hai trang cùng bộ tài liệu để dễ kiểm tra chi tiết.

### R01 — Pi repository / permission philosophy

https://github.com/earendil-works/pi

SDK/resource extension model và cảnh báo process-level trust. Không xem Pi là một permission sandbox có sẵn.

### R02 — Pi SDK

https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sdk.md

Custom application embedding, session/resources/tools. Pin API contract bằng integration tests trước triển khai.

### R03 — Pi extensions

https://pi.dev/docs/latest/extensions

Command-context `ctx.reload()`, lifecycle, registerTool và active tools. Dynamic registration và resource reload là hai việc khác nhau.

### R04 — Pi packages

https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/packages.md

Package/resource discovery, source formats và trust implications. App install supervisor thêm kiểm soát riêng.

### R05 — Chord

https://raw.githubusercontent.com/earendil-works/pi/main/packages/chord/README.md

Facet/service/state/reload toolkit; app supplies transport envelope. Bundler/loader không thay package installation hoặc OS isolation.

### R06 — MCP Apps overview

https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html

https://apps.extensions.modelcontextprotocol.io/api/

Tool-linked UI resources và interactive host bridge. App-defined pins/state ownership là extension product behavior, không claim MCP Apps cung cấp sẵn.

### R07 — MCP Apps permissions / CSP

https://apps.extensions.modelcontextprotocol.io/api/interfaces/app.McpUiResourcePermissions.html

https://apps.extensions.modelcontextprotocol.io/api/interfaces/app.McpUiResourceCsp.html

Requested browser capabilities/CSP constraints, host phải implement và có thể từ chối unsupported permissions.

### R08 — MCP Apps authorization

https://apps.extensions.modelcontextprotocol.io/api/documents/authorization.html

Auth/data resource audience và host responsibility.

### R09 — MCP authorization specification

https://modelcontextprotocol.io/specification/latest/basic/authorization

Latest được kiểm tra ngày trên; client/server phải negotiate supported discovery/registration flow, không assume auto-DCR ở mọi server.

### R10 — A2A specification

https://a2a-protocol.org/latest/specification/

Agent task/message/artifact interoperability. Chưa dùng làm primary NodeLink trong baseline này.

### R11 — Playwright MCP

https://github.com/microsoft/playwright-mcp

https://playwright.dev/mcp/introduction

Structured accessibility/tools; security boundary disclaimer. Direct Playwright adapter là quyết định của app, không tính năng Pi mặc định.

### R12 — Browser Use

https://github.com/browser-use/browser-use

https://docs.browser-use.com/open-source/introduction

https://docs.browser-use.com/open-source/quickstart

Project browser automation và available integration routes. Xác minh selected backend/dependencies thay vì suy từ tên capability.

### R13 — OpenAI computer use

https://developers.openai.com/api/docs/guides/tools-computer-use

https://github.com/openai/openai-cua-sample-app

Isolated environments, untrusted screen content và tool integration. Không giả native computer-tool protocol tự tương thích Pi.

### R14 — Anthropic computer use / reference desktop

https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool

https://github.com/anthropics/anthropic-quickstarts/blob/main/computer-use-demo/README.md

Computer actions và reference desktop environment. Virtual desktop có deployment/lifecycle riêng.

### R15 — Peekaboo

https://github.com/openclaw/peekaboo

https://peekaboo.sh/

macOS screenshots/UI automation candidate. Version/signing/permissions/host behavior cần spike, không guaranteed drop-in.

### R16 — Apple Accessibility consent

https://support.apple.com/guide/mac-help/allow-accessibility-apps-to-access-your-mac-mh43185/mac

User-controlled permission workflow; app không tự bật quyền thay user.

### R17 — Docker rootless

https://docs.docker.com/engine/security/rootless/

Rootless daemon/containers có prerequisites; non-root image không tự đồng nghĩa toàn bộ engine rootless. Không coi container là universal VM security guarantee.

### R18 — Google OAuth native apps

https://developers.google.com/identity/protocols/oauth2/native-app

System-browser flow, PKCE, supported redirects, client prerequisites, scope/embedded-browser limitations.

### R19 — Google OAuth web server

https://developers.google.com/identity/protocols/oauth2/web-server

Server-side callback/token custody và client registration. Headless-server deployment không reuse laptop loopback một cách ngầm định.

### R20 — Google Calendar authorization

https://developers.google.com/workspace/calendar/api/auth

Calendar-specific scopes và authorization requirements.

### R21 — Google Calendar sync / push

https://developers.google.com/workspace/calendar/api/guides/sync

https://developers.google.com/workspace/calendar/api/guides/push

Incremental sync, watch/channel/receiver requirements; snapshot pin khác live subscription.

### R22 — Notion authorization

https://developers.notion.com/guides/get-started/authorization

Integration/page access và authorization; không là permission đọc/sửa mọi workspace tự động.

### R23 — Spotify Web Playback SDK

https://developer.spotify.com/documentation/web-playback-sdk

https://developer.spotify.com/documentation/web-playback-sdk/tutorials/getting-started

Playback SDK/browser/account requirements; iframe media policy và restrictions của commercial use phải được đánh giá riêng.

### R24 — Telegram bot / user application distinction

https://core.telegram.org/bots/faq

https://core.telegram.org/api/obtaining_api_id

Bot capabilities khác user-client APIs/auth. Bot token không là user's entire inbox access.

### R25 — Zoom Meeting SDK web

https://developers.zoom.us/docs/meeting-sdk/web/

https://developers.zoom.us/docs/meeting-sdk/web/component-view/

Embedded human meeting UI; supported view/platform và khác biệt với AI notetaker/realtime-media integrations.

### R26 — Electron security

https://www.electronjs.org/docs/latest/tutorial/security

Isolation/sandbox/CSP/IPC boundary cho desktop shell và remote content.

### R27 — Node VM

https://nodejs.org/api/vm.html

`node:vm` không phải security mechanism cho untrusted code.

### R28 — Tailscale connections

https://tailscale.com/docs/reference/connection-types

https://tailscale.com/docs/features/peer-relay

Direct và relay connectivity. Application-level grants vẫn cần dù dùng private network.

### R29 — GPT-Live

https://developers.openai.com/api/docs/guides/live

https://developers.openai.com/api/docs/guides/live-delegation

Voice frontend, delegated backend và app responsibilities cho context/cancellation. Account/model/version access cần test thật.

Nguyên tắc tách frontend/backend ở trên vẫn giữ, nhưng **lựa chọn provider đã bị thay**: voice chạy trên Gemini Live với proxy phía node ([ADR-001](research/adr-001-gemini-live-provider.md), 2026-09-17).

### R30 — MCP Registry

https://modelcontextprotocol.io/registry/about

Discovery metadata và namespace trust; không một bảng registry thay thế source/code/security review của app.

## 5. Cách cập nhật bộ nghiên cứu

P0 lưu version/commit/model IDs đã test, ngày truy cập, selected dependencies/license và compatibility cases vào repo thật. Khi upstream đổi API, update adapter và recorded contracts. Không copy `latest`/`main` vào dependency runtime như một bản khóa production.

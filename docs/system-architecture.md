# System Architecture v2 — Conversation Platform

**Ngày:** 16/09/2026 · **Trạng thái:** thiết kế để implement, chưa là hệ thống đã triển khai.
**Phạm vi:** [scope-lock.md](scope-lock.md). Tất cả API/types có tên `agent.*`, NodeLink và CapabilityPack bên dưới là contract đề xuất của app, không phải API chính thức của Pi/MCP.

## 1. Thay đổi kiến trúc cốt lõi

Không còn thiết kế “desktop app có một helper, sau này đưa helper lên server”. Sản phẩm là **portable runtime với nhiều conversation clients** ngay từ đầu. Desktop là một distribution gồm runtime + Electron shell; server là cùng runtime không Electron, có web client tùy chọn. Chạy hai node không bắt buộc một cloud account của nhà phát triển app.

Core không cố biến toàn bộ mạng thành một máy tính có filesystem và database chung. Mỗi node có danh tính, quyền, credentials và tài nguyên riêng. Sự liền mạch nằm ở giao tiếp, delegation và presentation; không nằm ở việc giấu mọi sự khác biệt hay tự copy secrets.

## 2. Sơ đồ tổng quan

```mermaid
flowchart TB
  USER[Người dùng]
  subgraph CLIENTS[Conversation clients]
    DESK[Desktop shell - Electron]
    WEB[Web chat - React]
    PIN[Inline widgets and optional pins]
    MINI[Isolated mini-app host]
    DESK --- PIN
    WEB --- PIN
    PIN --- MINI
  end
  USER --> DESK
  USER --> WEB
  subgraph HOME[Home node of this conversation]
    GATE[Authenticated Command Gateway]
    CON[Conductor - Pi adapter]
    CORE[Task / Policy / Capabilities / Surfaces]
    AUTH[Auth broker / Credential vault]
    LIFE[Install and lifecycle supervisor]
    STORE[(SQLite / Outbox / Artifacts)]
    LOCAL[Local worker pool]
    GATE --> CORE
    CORE <--> CON
    CORE <--> STORE
    CORE <--> AUTH
    CORE <--> LIFE
    CORE --> LOCAL
  end
  DESK <-->|Local socket or HTTPS| GATE
  WEB <-->|HTTPS + WSS| GATE
  subgraph PEER[Paired execution node - VPS or desktop]
    NG[NodeLink gateway and policy]
    WORK[Pi workers / Tool services]
    BROWSER[Browser driver]
    COMPUTER[Optional desktop driver]
    DATA[(Node-local DB / Files / Credentials)]
    NG --> WORK
    WORK --> BROWSER
    WORK --> COMPUTER
    NG <--> DATA
  end
  CORE <-->|Scoped delegation / events / artifacts| NG
  PROVIDERS[LLM / Voice / Authorized services]
  CON <--> PROVIDERS
  WORK <--> PROVIDERS
  AUTH <--> PROVIDERS
  CLIENTS <-->|Authorized voice or call media| PROVIDERS
```

Media arrows không có nghĩa mọi widget được tự kết nối mọi provider. Network/media grants, SDK tokens, user gesture và quyền thiết bị đều được kiểm tra. Sơ đồ là biên chức năng; không triển khai mỗi box thành microservice.

## 3. Stack đã chọn

| Lớp | Quyết định | Căn cứ / ranh giới |
|---|---|---|
| UI chung | React + TypeScript + Vite | Cùng conversation components cho desktop và web; không phụ thuộc Node trong renderer |
| Desktop | Electron main/preload mỏng | OS dialogs, notifications, Keychain, local driver consent; không chứa scheduler |
| Runtime | Node.js LTS, TypeScript | Phù hợp Pi SDK và tool ecosystem; pin versions ở compatibility gate |
| Agent | Pi SDK qua duy nhất `pi-adapter` | Không fork agent loop; app quản lý tasks và resources riêng [R01–R04] |
| API | HTTP framework nhỏ hỗ trợ schemas + WebSocket | JSON over HTTPS, typed contracts; Fastify là implementation mặc định đề xuất |
| Local transport | Authenticated Unix socket | Không public listener mặc định trên desktop; có bridge vào cùng command handlers |
| Persistence | SQLite WAL per node + durable outbox/inbox | Mỗi DB một runtime writer; không remote/shared filesystem cho live SQLite |
| Blobs | Local content store với metadata/digest | Transfer có scope, hạn mức, retention; object storage adapter về sau |
| Contracts | Runtime schema validation + generated types | JSON Schema/Zod adapter; version negotiation, không chỉ TypeScript |
| Built-in widgets | Trusted React catalog, lazy chunks | Chart/table/form/map/calendar/editor… từ descriptors có schema |
| Mini-apps | Isolated origins/iframes, MCP Apps host adapter | UI tùy biến không ở privileged renderer; host-mediated actions [R06–R08] |
| Execution | Child processes + OS isolation khi cần | Process riêng không phải sandbox; untrusted tool services chạy container/VM phù hợp |
| Linux delivery | Non-root OCI image + optional native bundle/service | Runtime không yêu cầu display; browser/virtual desktop tách images |
| Voice | GPT-Live adapter đầu tiên, WebRTC + trusted backend | Gate real account/event/interrupt; không lấy provider voice state làm app DB [R29] |
| Connectivity | Reachable HTTPS hoặc private-network adapter | Tailscale là một lựa chọn đã có NAT traversal; không bắt buộc để dùng local [R28] |

Không đổi toàn bộ runtime sang Go/Rust chỉ vì có VPS: yêu cầu portability được giải quyết bằng headless boundary, packaging và OS adapters. Native helper chỉ dùng khi thực sự cần OS APIs, không là lần viết lại Pi thứ hai.

### 3.1 Pi Chord: thử nghiệm, không khóa dependency mù quáng

Chord trong ecosystem Pi có plugin facets, service/state/lifecycle primitives hữu ích để thử cho PackHost. Nhưng nó không thay thế NodeLink, auth, effect ledger hoặc protocol replay của app. Tài liệu hiện tại không quy định application wire envelope; không coi phần planned symmetric RPC là đã có. P0 thử Chord phía sau interface `FacetHost`; giữ implementation độc lập tối thiểu nếu compatibility chưa đạt. `node:vm` không phải sandbox bảo mật [R05, R27].

## 4. Ba mặt hoạt động

**Control plane:** commands, task revisions, approvals, capability discovery, install state, pin metadata. Durable, nhỏ, authenticated.

**Execution plane:** Pi worker, tool service, browser profile, OS driver, builds và API effects. Nằm ở node được chọn, có lease, cancel và budgets.

**Media/data plane:** audio live, video call, desktop frames, file blobs lớn. Dùng transport thích hợp, không đổ raw media vào SQLite/event replay hoặc conductor context. State có media session references, không phải từng frame.

Một remote task không có nghĩa audio phải đi vòng qua tất cả VPS. Client có thể thiết lập transport tới provider sau khi auth broker của node liên quan cấp credential tạm đúng loại.

## 5. Các entity và quyền sở hữu

| Entity | Ý nghĩa | Authority |
|---|---|---|
| Owner / Principal | Người dùng, client, node peer hoặc extension identity | Auth/policy của node nhận request |
| Node | Một runtime installation, có key identity và capability inventory | Chính node đó |
| Conversation | Timeline người dùng tương tác | Một home node tại một thời điểm |
| Task | Mục tiêu người dùng, revision, outcomes | Node tạo task; child task ở execution node có lineage |
| Run | Attempt cụ thể trên task revision | Execution node |
| Pi session | Agent context và session history | Một worker owner; không đồng thời ở nhiều nodes |
| Resource | Workspace, file, browser profile, desktop, integration account | Node nắm resource |
| Delegation | Phạm vi công việc và capabilities được ủy quyền | Sender grant + receiver policy, dùng phép giao |
| Surface snapshot | Response UI ở một thời điểm | Home conversation store |
| Widget instance | Mini-app có persistent state, actions, connections | Một instance owner node; user/account scoped |
| Pin | Tham chiếu instance và preference hiển thị | Home conversation/client preference |
| Connection | Authorized external account, scopes, health | Node giữ credentials và adapter |
| Capability install | Package/artifact versions, facets, granted resources | Node cài package |
| Effect | Tác động đã chuẩn bị/gửi/xác nhận hoặc chưa rõ | Execution node thực hiện effect |
| Artifact | Blob/dataset/evidence metadata | Node tạo; bản copy có lineage/digest |

Task, session, widget và connection có vòng đời khác nhau. Task hoàn thành không làm Spotify player hay note bị xóa. Session reload không là lệnh chạy lại action trên widget.

## 6. Process và distribution model

### Desktop distribution

- Electron renderer chạy sandboxed, `nodeIntegration: false`, `contextIsolation: true`, CSP và IPC sender validation. Main chỉ expose typed methods, không generic shell/IPC [R26].
- Runtime helper là chương trình riêng, attach/reconnect được. Đóng window giữ runtime nếu người dùng chọn keep-running; quit runtime khác với đóng UI.
- macOS integration helper thực hiện OS permissions, capture/input driver, credential store. Driver giữ identity/signature ổn định qua release để kiểm thử TCC.
- User có thể dùng desktop như thin client tới server mà không mở local code execution.

### Server distribution

- OCI image core chỉ chứa runtime/web static assets/required dependencies. Browser engine và virtual desktop là optional images/profiles.
- Chạy non-root; writable volume riêng; health/readiness; restart policy. Không mount Docker socket vào worker/tool container.
- Native Linux tarball với runtime bundled + service unit là đường khác cho operator không dùng Docker. Service account tối thiểu, explicit project roots và separate data directory.
- Không mở raw Pi RPC, CDP, VNC hay dev server ra Internet. Public exposure chỉ gateway đã có TLS/auth/rate limits.
- Web UI HTTPS là bắt buộc cho browser features yêu cầu secure context. Local loopback development khác production deployment.

Examples deploy trong implementation plan là templates cần substitute release artifact thực; không bịa registry image hoặc domain đã tồn tại.

## 7. Core services và PackHost

```text
Command Gateway
  -> Authenticate principal + validate schema/version
  -> Resolve conversation/task/widget/resource
  -> Deterministic handler OR conductor intent resolution
  -> Current-policy evaluation + required consent
  -> Durable transaction/outbox
  -> Local executor OR scoped NodeLink delegation
  -> Verify outcome / reconcile unknown effects
  -> Persist event + update conversation/widget/voice summary
```

Core giữ những bất biến mà extension không được thay: identity, permission, secret custody, task/effect state, resource locks, package generation activation, surface action ownership, install consent, budgets và emergency stop.

Pack đóng góp tools, instructions, presenters, custom widgets, drivers, auth/setup descriptors và onboarding recipes. Một pack không được tạo scheduler, global conversation store hoặc hidden root account riêng.

### 7.1 Capability registry

Mỗi capability có stable ID, package/version, execution node, input/output schema, resource kinds, compatibility, auth readiness, invocation route, cancellation, effect category và UI affordances. `installed`, `loaded`, `authenticated`, `authorized`, `healthy` là các trạng thái riêng.

Conductor mặc định chỉ thấy capability summary và search tool; khi chọn một capability mới nạp schema/skill liên quan. Không dump toàn bộ MCP tools vào mọi lượt model. Dynamic tool activation của Pi có thể được dùng qua adapter khi phù hợp [R03].

Conductor không được có tool tự accept consent, đọc secret values hoặc patch core policy. Tool discovery metadata và mô tả MCP do bên ngoài cung cấp vẫn là untrusted input.

## 8. Task/session routing

Routing: explicit reference → aliases/project registry → recent tasks/instance focus → state/resource verification → answer/status/resume/new task/clarify/delegate.

Node placement xét resource locality, allowed operations, connected credentials, OS/driver capability, active leases và user preference. Không chỉ chọn node có CPU rảnh. “Sửa ứng dụng trên máy này” không được gửi repo lên VPS chỉ vì network đang nhanh.

Worker context gồm bounded task brief, approved skills, selected project context và resource references. Conductor context gồm relevant history, user preferences, task summaries và semantic widget state. Không upload all transcripts, DOM, datasets hoặc screenshots theo thói quen.

Pi sessions thuộc app-managed resource tree. Nếu cần successor session sau install/model/context change, giữ task identity và handoff có evidence; không resume lại dòng tool cũ như một command mới. Một JSONL file không chứng minh worker đang sống.

## 9. Task/effect lifecycle

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> resolving
  resolving --> waiting_input
  waiting_input --> resolving
  resolving --> waiting_capability
  waiting_capability --> queued: install and auth verified
  resolving --> waiting_approval
  waiting_approval --> queued: consent valid
  resolving --> dispatched
  dispatched --> running: executor accepts
  dispatched --> uncertain: acknowledgement missing
  running --> verifying
  verifying --> succeeded: evidence sufficient
  verifying --> failed
  running --> pause_requested
  pause_requested --> paused: safe boundary
  paused --> queued
  running --> cancel_requested
  cancel_requested --> cancelled: stop confirmed
  running --> uncertain: connection or effect outcome unknown
  cancel_requested --> uncertain
  uncertain --> reconciling
  reconciling --> paused
  reconciling --> succeeded
  reconciling --> failed
  reconciling --> cancelled
```

Sơ đồ mô tả main paths; implementation phải có reducer/transition table đầy đủ: mọi nonterminal nhận cancel, resolving failures không treo vô hạn, terminal chỉ tạo run mới rõ lineage. `waiting_capability` giữ continuation, không chiếm worker liên tục hoặc tự lặp install prompts.

Worker idle, LLM kết thúc lượt hoặc socket đóng không là success. Outcome có evidence: exit status, file/diff version, API receipt/read-after-write, observed browser state; nếu không có số tests thì không bịa số tests.

Effect ledger per executor: `prepared → submitted → confirmed | failed | unknown`. External side effect không atomic cùng DB. Duplicate commands dùng durable idempotency keys; external API không hỗ trợ dedup thì timeout phải reconcile, không hứa exactly-once.

### Leases

Một writer/worktree hoặc approved folder; Git operations tác động shared refs cần repo-common lock. Browser profile và foreground desktop có input lease riêng; voice và video có media-focus coordination. Lease/epoch fencing chặn brokered actions cũ; không chặn ngược một shell script đã được cấp OS quyền rộng. Không quảng cáo distributed lease là sandbox.

## 10. Storage

Mỗi node: SQLite WAL với migrations; app events/outbox/inbox; native Pi session history tách logical authority; blob store có quotas. Không cố commit atomically cùng Pi JSONL; run markers và reconciliation nối hai phần.

Nhóm bảng: principals/nodes/grants; conversations/messages; tasks/runs/delegations; commands/events/outbox/inbox; resources/leases; effects/approvals; packages/install_plans/generations; connections/auth_transactions; widget_instances/snapshots/pins/action_bindings; datasets/artifacts; preferences/onboarding_checkpoints/usage.

Secrets lưu trong vault abstraction: macOS Keychain hoặc server secret store/encrypted-at-rest storage với key nằm ngoài DB backup. File permissions không thay encryption; container env cũng không là giải pháp tránh mọi leak. Bootstrap/recovery key và backup procedure phải có test; không tự sinh key rồi lưu cùng plaintext DB và gọi là bảo mật đầy đủ.

Raw audio/video không lưu mặc định. Screenshots có retention ngắn, chứa dữ liệu nhạy cảm; cấp quyền capture không đồng nghĩa được lưu vĩnh viễn hoặc gửi cho mọi model. Dữ liệu người dùng xóa khỏi app không tự xóa khỏi third-party provider đã nhận.

## 11. Unified UI/action path

Message blocks: text, surface snapshot, widget-instance reference, artifact. Built-ins và custom apps dùng một action host. Agent chọn props, định nghĩa actions theo discovered capabilities hoặc agent intents; implementation không giới hạn mỗi nút vào một handler business cố định do app viết sẵn.

Action definitions được compile thành server-owned bindings, xác nhận schema/quyền/node/account/revisions. Widget không tự gọi tùy ý tool chỉ bằng tên; host reauthorizes invocation. Voice có semantic view của instance đang focus và đi qua cùng path.

Chi tiết pin/live vs snapshot, custom app sandbox và action schema ở [widgets-and-extensions.md](widgets-and-extensions.md).

## 12. Voice/media

GPT-Live là adapter đầu, không phải dependency trong core state model. Client mic/playback ↔ provider; runtime giữ durable intent và trusted control path. Transcript fragments/delegation cần correlate/dedup; correction đổi task revision; barge-in chỉ nhường audio, không tự hủy job [R29].

Một call widget, music widget và assistant voice không được tranh microphone/speaker ngầm. `MediaFocusService` thể hiện ai đang dùng mic/camera, duck/pause chỉ theo rule được user chấp thuận. Audio trong Zoom call không tự được gửi vào voice model để “tiện phân tích”. Mute/end có local host control, không phụ thuộc remote node hoặc model.

Kết thúc voice không dừng pinned read subscriptions hay jobs. Reload Pi không restart WebRTC. Worker/node mất mạng thì UI cho tiếp tục text/local actions nhưng không giả remote tool đang chạy được.

## 13. Security baseline

1. Remote endpoints authenticated; app grants giới hạn dù transport private. Principal identity đến từ transport, không do model tự điền.
2. Model/website/package README/MCP descriptions/screenshots đều không được cấp quyền, đổi OAuth endpoint hoặc tự approve.
3. Arbitrary native Pi extensions có quyền process. Untrusted executable không load vào privileged daemon/conductor; dùng isolated service/worker hoặc báo rõ trusted-host risk [R01–R04].
4. Custom widget code không chạy trong privileged app origin. Sandbox, strict bridge, CSP, resource budgets, permission prompts do host.
5. Host-owned consent/credential surfaces không do extension dựng tự do. UI có origin/account/node badge không nằm trong iframe kiểm soát của vendor.
6. Long-lived secrets không gửi renderer/model. SDK frontend đôi khi cần short-lived/scoped token: chỉ cấp qua riêng trusted auth bridge cho đúng isolated origin, không vào widget JSON/history.
7. Browser/computer control không tự thực hiện OS consent, OAuth authorization, CAPTCHA hoặc 2FA. Human takeover là state có thật.
8. Install approvals gồm package digest, dependency plan, target node, grants. Security scan/chữ ký xác thực không chứng minh code an toàn.
9. HTTP fetch/auth discovery giới hạn redirects/private destinations/credential forwarding; user URL không là quyền truy cập internal network.
10. Emergency stop trên máy đang bị điều khiển ưu tiên hơn remote commands. Revocation chặn thao tác tương lai; không hứa rollback effect đã xảy ra.

## 14. Monorepo đề xuất

```text
apps/
  desktop/                 # Electron main/preload + client bootstrap
  web/                     # Same conversation UI without Electron
  runtime/                 # Headless node, composition root, lifecycle
  worker/                  # App-managed Pi run host
packages/
  contracts/               # Versions, commands, events, capabilities, UI
  conversation-client/     # Timeline, composer, pins, accessible system UI
  core/                    # Task/effect/policy/install state machines
  storage/                 # Node-local DB/outbox/inbox/migrations
  pi-adapter/              # Only package importing Pi SDK internals
  node-link/               # Authenticated peer protocol, replay, grants
  capability-host/         # Discovery, FacetHost, generations
  integration-sdk/         # Auth, connector, setup descriptors
  widget-sdk/              # Props/actions/state/semantic contracts
  widget-host/             # Built-ins and isolated mini-app bridge
  mcp-adapters/            # Tools/auth and MCP Apps host support
  host-adapters/           # macOS/Linux/web OS and vault capabilities
  execution-supervisor/    # Process/container/virtual desktop adapters
  voice-adapters/          # GPT-Live first, provider-neutral internal events
packs/
  project-work/
  data-canvas/
  browser-playwright/
  computer-macos/
  computer-linux-desktop/
  google-calendar/
examples/
  note-widget/
  media-widget-contract/
  mcp-app-fixture/
```

Các thư mục không buộc thành hàng chục services. Bắt đầu core modules trong một runtime process; tools/native extensions/isolated widgets ở process và origin phù hợp. Đừng tạo abstraction ngoài contracts đã cần cho những journey trong scope.

## 15. Invariants bắt buộc cho implementation

- Một conversation có một home authority; một run có một execution owner.
- Cùng command retry không tạo logical task thứ hai; unknown external effect không tự replay.
- Pack update/reload không thay quyền, tự đổi action target hoặc làm mất continuation.
- Pin không bật task/camera/music/subscription khi chưa được cho phép.
- Credential binding phải thể hiện node + account; không tự replicate refresh tokens.
- Mọi supported claim có version/platform/account evidence; blocked không thành pass.
- UI không bắt người dùng học distributed topology để hỏi trạng thái, nhưng luôn chỉ ra target khi hành động quan trọng.

Chi tiết triển khai: [distributed-runtime.md](distributed-runtime.md), [integration-onboarding.md](integration-onboarding.md), [browser-computer-use.md](browser-computer-use.md), [implementation-plan.md](implementation-plan.md).

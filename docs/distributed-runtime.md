# Distributed Runtime & Deployment

**Baseline:** blueprint v2, 16/09/2026. NodeLink là protocol đề xuất cho các installation của app. Không tuyên bố Pi hoặc A2A đã cung cấp mọi semantics này.

## 1. Mô hình cộng tác: nodes tự chủ, conversation thống nhất

Chọn **federation có kiểm soát**, không distributed shared-memory và không swarm tự trò chuyện vô hạn. Mỗi node chạy độc lập. Một conversation có home node giữ ordered user timeline; node khác được giao task có scope và trả events/artifacts.

Ví dụ:

```text
Desktop conversation client
    -> Home runtime trên VPS A
         -> Desktop node: đọc file đã được cho phép
         -> VPS A: tổng hợp dữ liệu và giữ timeline
         -> VPS B: build/test trong workspace tại B
```

Hoặc desktop local là home, VPS A/B là executors. Không cần user chọn topology mỗi prompt; onboarding/explicit request đặt home, router chọn executor theo permissions/locality. User vẫn có thể hỏi “đang chạy ở máy nào?” hoặc “đừng gửi source ra khỏi laptop”.

Scope đầu: same owner, nhiều machines. Không có implicit trust transitive: A pair B và B pair C không tự cho A quyền C. Không tự forward raw user prompts/secrets tới toàn mạng để hỏi ai nhận việc.

## 2. Giao thức nào dùng cho việc gì?

| Protocol | Vai trò trong app | Không thay thế |
|---|---|---|
| App command/event API | Client ↔ runtime, state/surface/actions | OAuth vendor hay OS isolation |
| Native NodeLink | Node ↔ node delegation, grants, correlated events, artifacts | Shared filesystem/multi-master database |
| MCP | Gọi tools/resources từ service có sẵn | Quản lý toàn bộ conversation/runtime |
| MCP Apps | UI resource + host bridge cho tool apps [R06–R08] | Pin lifecycle và data ownership riêng của app |
| A2A | Adapter tới agent ngoài ecosystem, roadmap [R10] | App-specific UI/state replay/permissions/installation |
| Tailscale/private network | Một lựa chọn reachability và encrypted network [R28] | App identity/grants hoặc approval của user |

Không tự implement đầy đủ tất cả chuẩn ở milestone đầu. MCP/MCP Apps nằm trong baseline; external A2A adapter giữ extension seam nhưng chưa bắt buộc certified release.

## 3. Deployment profiles

### 3.1 Local desktop

App bundle chứa runtime và UI. Socket local private + authenticated handshake. Không public port, không account cloud bắt buộc. Node pairing chỉ bật khi người dùng yêu cầu kết nối máy.

### 3.2 Headless server

OCI core image non-root, data volume persistent, loopback/private bind default. TLS ingress và application auth phải được kiểm tra trước remote use. Người dùng mở web chat hoặc attach bằng desktop client; server không cần monitor/GPU/browser engine cho text/runtime.

Native alternative: signed/checksummed release bundle, unprivileged service account, systemd unit với hardening được test. Config/secrets không nhét vào world-readable flags hoặc shell history. Không bắt user cài Node/Pi globals; launcher sử dụng runtime bundled.

### 3.3 Browser worker

Browser driver/binary thêm khi cần; version engine ghép với Playwright đã pin. Managed profiles nằm ở encrypted/restricted volume phù hợp; không share profile directory giữa hai browser processes. CDP chỉ private và authenticated qua broker, không expose raw port.

### 3.4 Virtual desktop worker

Optional Linux image có desktop/display server và input/screenshot adapter. Không phải một flag “headless=false” trên server không display. Preview/human takeover qua authenticated short-lived transport. Default không mount host home, host display hoặc Docker socket; restrict egress/CPU/memory/PIDs. Container không được coi tương đương VM trước host-kernel adversary.

## 4. Bootstrap và pairing

Cài binary/image là một bước bootstrap ngoài model khi chưa có app. Mục tiêu: installer hoặc command mẫu ngắn do release thực cung cấp, sau đó toàn bộ setup qua chat. Không yêu cầu user học terminal vận hành hằng ngày.

Pairing flow:

1. Node đích tạo device identity và một invite single-use, expiry ngắn; chưa mở quyền tài nguyên.
2. Người dùng đưa endpoint/invite vào chat hoặc scan QR trên một client trusted. Secrets của invite không được lưu nguyên văn vào transcript dài hạn.
3. Client hiển thị host fingerprint/node name và network reachability. TLS/mTLS hoặc signed app handshake xác minh key; endpoint DNS không đủ để tin node.
4. Owner xác nhận cặp nodes và grants ban đầu: ví dụ chỉ `projects.read`, `build.run` trên workspace cụ thể, không host filesystem/root shell.
5. Receiver policy kiểm tra own limits; lưu trust relationship + bounded delegation permissions.
6. Probe, capability negotiation và status card thật. “Paired” khác “có thể chạy Browser Use” hoặc “đã có credentials”.

Invite/QR không phải OAuth access token lâu dài. Replay invite bị reject; key rotation cần authenticated transition; lost device/revoke làm mất quyền từ lần gọi tiếp theo và ngừng nhận delegation mới. Already submitted effects có thể cần reconciliation.

**Trạng thái đã ship (2026-09-20).** Pairing đã chạy thật giữa hai node sống: hai node, hai cổng, hai database, HTTP thật giữa chúng. Device key là Ed25519 sinh tại chỗ, lưu trong `identity.json` với quyền chỉ chủ sở hữu đọc được; fingerprint là sha256 của public key in thành từng nhóm bốn ký tự để một người đọc được thành tiếng. Invite là single-use và hết hạn sau 10 phút; claim ghi peer ở trạng thái **pending**, và pending bị từ chối envelope chứ không được xếp hàng đợi. Chỉ khi một người xác nhận ở **cả hai** phía thì kênh mới mở.

Token mà mỗi node trình cho peer được **suy ra** bằng `HMAC(localToken, peerNodeId)`. Nghĩa là không có credential nào đi qua dây trong lúc pairing (hai bên chỉ trao nhau sha256), và chỉ có sha256 nằm trong database — nên một bản sao database không replay được ở peer. Transport là HTTP tới gateway của chính peer đó (`/peers/messages`), có outbox bền (ghi ý định trước khi gửi) và dedup theo message id ở phía nhận.

**Chưa có.** `NodeLinkTransport` trong `packages/node-link` vẫn là stub cho một transport dạng socket: chưa có TLS/mTLS, chưa có WebSocket, chưa có keepalive hay reconnect cursor. Bước 3 nói TLS/mTLS hoặc signed app handshake để xác minh key — hiện tại việc xác minh key là **so fingerprint**, và kênh là HTTP, nên một node chỉ reachable qua plain HTTP mới pair được hôm nay. Bước 4 (grants ban đầu) và bước 6 (probe, capability negotiation, status card) vẫn thuộc P4. Đường delegation thì đã nối: owner viết một grant (`POST /grants`), grant đó đi sang peer bằng envelope `pair.confirm`, và từ đó một envelope `delegate` nêu đúng grant ấy được nhận còn nêu một delegation lạ bị từ chối bằng `DELEGATION_UNKNOWN`. Chính sách nhận của bên nhận là **phép giao** của các grant còn sống từ sender đó — theo đúng luật của contract rằng grant chỉ bị thu hẹp chứ không được mở rộng bằng cách giữ thêm grant khác; một grant không đặt `maxArtifactBytes` thì cho **không** byte nào. Artifact hiện mới được **xét**, chưa truyền byte. Gap sequence được báo bằng `SEQUENCE_GAP` và cursor của peer chỉ tiến liền mạch, nên message đến muộn vẫn xử lý được thay vì bị coi là regression.

Nếu cả hai node không reachable, app giải thích cần private-network adapter hoặc một reachable gateway. Chọn Tailscale adapter hoặc TLS endpoint của operator; **không hứa kết nối xuyên mọi firewall khi không có hạ tầng hỗ trợ**. Không build bespoke relay/NAT traversal trong foundation beta. Public client/browser qua Tailscale vẫn cần network access và HTTPS cấu hình phù hợp.

## 5. Trust và delegation grants

Một grant tối thiểu có owner, senderNodeId, receiverNodeId, permitted capability IDs, resource refs, expiry, budget, allowed data classes và delegation depth. Receiver dùng phép giao với policy local; sender không nâng quyền receiver bằng prompt.

Principal của invocation gồm verified peer identity và delegated origin user; không tin trường identity tự khai trong JSON. Pack không được tự mint grant hoặc dùng credentials của một connection ngoài scope.

Delegation chuyển task brief/context cần thiết. Không copy toàn bộ Pi session nếu chỉ cần một build command. Artifact transfer là request riêng có source/destination, MIME/size/digest, classification và user grant. Workspace remote phải đã tồn tại hoặc được clone/create bằng task rõ ràng.

## 6. NodeLink envelope đề xuất

```typescript
// Internal app schema proposal, validate with discriminated unions in code.
interface PeerEnvelope {
  protocol: 'agent.nodelink';
  version: 1;
  messageId: string;
  correlationId: string;
  senderNodeId: string;
  recipientNodeId: string;
  kind: 'delegate' | 'accepted' | 'status' | 'input.request'
      | 'input.response' | 'cancel.request' | 'result' | 'artifact.offer';
  delegationId: string;
  taskId: string;
  expectedTaskRevision?: number;
  runId?: string;
  executionEpoch?: number;
  sourceSequence?: number;
  payload: unknown; // Mandatory per-kind runtime validation, never passed through.
}
```

Headers/signatures/auth channel bind actual sender. `senderNodeId` alone không là identity proof. Resource reference là `(nodeId, opaqueResourceId, resourceVersion)`; không remote `file://` hay local absolute path do model tự ghép.

Transport mặc định HTTPS request/response cho commands và WSS cho events. Keepalive/backpressure/rate/size limits, reconnect with cursor. Không dùng một connection mở vô hạn làm nguồn truth; data durable ở DB.

## 7. Delivery semantics

**At-least-once delivery + durable dedup**, không tuyên bố exactly-once external effects. Sender ghi intent/outbox trước send. Receiver transaction ghi inbox dedup và accepted task, rồi mới ack. Worker start đi từ receiver outbox.

Nếu sender mất ack, resend cùng command/delegation ID. Receiver trả accepted/outcome đã biết, không tạo run mới. Event sourceSequence tăng đơn điệu theo node/stream; home dedup và project chúng vào timeline của mình. Không có một “global order” được tạo bằng đồng hồ wall clock giữa các máy.

Mỗi peer event giữ provenance gốc; home summary không được làm mất trạng thái unknown/waiting_approval. Worker token deltas có thể coalesce/transient; approvals/effects/result commits durable.

## 8. Failure matrix

| Tình huống | Hành vi đúng |
|---|---|
| Desktop client đóng, home ở VPS | Home/jobs tiếp tục; reconnect replay |
| Home desktop ngủ, worker ở VPS | Worker tiếp tục trong grant/budget đã cấp; không giả home đang online; cần input thì chờ |
| Peer mất mạng trước accepted | Sender pending, retry cùng ID; không tạo job ở node khác |
| Mất mạng sau external effect | Receiver reconcile; home hiển thị unknown, không repeat effect |
| Home restart | Load snapshot/outbox/inbox, reconcile peers trước new risky dispatch |
| Executor restart | Recover task/effect ledger; process cũ/status cần verify, không chỉ nhìn JSONL |
| Two nodes cùng remote Git repo | Local worktree locks không đủ; push dựa expected remote ref / conflict handling, không force tự động |
| Key revoke khi task đang chạy | Chặn new commands/delegations; cancel/reconcile theo scope đã cấp, báo rõ effects đã ra ngoài |
| Package version mismatch | Negotiate capability version hoặc unavailable; không đổi schema âm thầm |
| No supported auth/OS driver | Task waiting setup hoặc chuyển phương án sau consent; không giả ready |

**Không automatic home failover trong v0.2.** Chuyển home là explicit export/migration/drain gate tương lai. Không để hai nodes cùng append authoritative timeline do network partition. “Mượt” không có nghĩa giấu mất sự cố.

## 9. Cross-node approvals và input

Executor phát `input.request`/`approval.request` đã ràng buộc exact operation, account/node/resource/digest và expiry. Home render **host-owned** card; user decision được authenticated và trả đúng request. Executor revalidates request còn hiện hành trước thực thi.

Pairing consent không đồng nghĩa approve tất cả deployments/chuyển tiền/gửi tin. Widget có thể đề xuất invocation, nhưng không tự phát grant mới. Secrets cần ở node nào thì secure auth channel kết thúc ở vault node đó; home model chỉ nhận connectionRef/status.

## 10. Budgets và tránh agent chatter

Default executor pool 2 workers mỗi node, config theo máy; conductor slot riêng. Global conversation budget, per-task depth/hops cap (đề xuất depth 2, nodes đã approve), timeout và token limits. Numeric defaults là targets cần đo, không benchmark.

Không cho subagent tự broadcast cả mạng tìm việc. Worker yêu cầu capability qua scheduler; scheduler chọn người thực thi. Progress polling deterministic, không tạo LLM ping-pong. Cross-node plans có bounded subtasks và tiêu chí complete rõ.

## 11. Ops, backup, upgrade

- Quotas separate sessions/artifacts/browser profiles/images; disk full cần stop safe không corrupt success state.
- DB consistent backup + content manifest; key backup có chính sách riêng. Không live copy WAL files bằng script tùy tiện rồi gọi là backup hợp lệ.
- Upgrade drain affected runs, verify protocol compatibility, snapshot DB, migrate transactionally khi phù hợp, boot healthcheck. Rollback package activation khác rollback irreversible DB migration; migration failure cần restore tested path.
- Peer reconnect theo negotiated version window; incompatible node giữ read/status nếu supported, không tiếp nhận new effects.
- Logs có trace task/run/peer/connection/widget nhưng redact secret/token/content mặc định.
- Server uninstall không xóa project/remote account dữ liệu; token revoke và runtime-data removal là các lựa chọn riêng.

## 12. Release proof bắt buộc

Clean macOS + hai Linux VPS/namespaces độc lập chạy J4. Thử một real network topology với TLS/private networking; local mock không đủ chứng minh NAT/reachability. Đo reconnect, duplicate delivery, revoked grants, unknown effects, dependency/version mismatch và node restart.

Nguồn cho protocol/tool separation và connectivity: [R06–R10, R28](research-and-decisions.md). Những semantics ownership/delivery/policy ở đây là lựa chọn thiết kế của app.

# Widgets, Mini-apps, Pins & Extension SDK v2

**Ngày:** 16/09/2026. Đây là contract đề xuất của app, không phải upstream Pi/MCP wire schema.

## 1. Định nghĩa lại widget

Widget là một implementation UI nhận **props + data bindings + agent-defined actions**. Agent không cần viết một webapp cho mỗi response, và app developer không phải hardcode business logic cho từng nút mà agent có thể nghĩ ra.

Có hai con đường đồng thời:

1. **Catalog widgets:** components đã cài, render nhanh từ JSON có schema. Agent chọn component, truyền params, nối actions. Có thể ghép thành mini-app bằng layout/state primitives.
2. **Custom mini-apps:** user hoặc third party viết UI thực sự, đóng thành package được approve. Chạy trong isolated host, có SDK để nhận props/context, lưu state, gửi events, gọi approved capabilities. MCP Apps là integration protocol được hỗ trợ cho nhánh này [R06–R08].

Một widget có thể chỉ là chart tĩnh. Cũng có thể là note editor, player, conversation view hoặc video call. Độ phong phú của SDK không có nghĩa mọi vendor integration đã được đóng gói sẵn.

## 2. Mental model

```text
Capability / tool / user prompt
          ↓
Agent selects widget + props + actions
          ↓
Host validates, resolves references, binds grants and versions
          ↓
Render trusted catalog OR isolated mini-app
          ↓
User clicks / types / speaks
          ↓
View update OR capability invocation OR new agent intent/workflow
          ↓
Verified state/result → update widget and conversation
```

“Agent xác định action” là thật: agent được chọn tool và arguments trong phạm vi capabilities hiện có, hoặc tạo một ý định cho lượt agent mới. Core chỉ kiểm tra và thực thi theo quyền, không thu hẹp thành danh sách business buttons cố định.

## 3. Widget definition và instance

### 3.1 Definition đăng ký bởi package

```typescript
interface WidgetDefinition {
  id: string;                 // Namespaced, e.g. example.notes.editor
  version: string;
  renderer: 'catalog' | 'isolated-app' | 'mcp-app';
  propsSchema: object;        // Runtime JSON Schema
  eventSchemas: Record<string, object>;
  stateSchema?: object;
  stateVersion?: number;
  semanticDescription: string;
  requestedCapabilities: string[];
  sizing: { compact: boolean; expanded: boolean; minHeight?: number };
  textFallback: string;
  entryArtifact?: string;     // Installed, integrity-checked bundle; not arbitrary URL
}
```

Definition được discover như một capability, với preview/examples/prop docs. Không nhét toàn bộ widget catalog vào model context. Unknown component/version có fallback; không fetch JavaScript từ URL model tự cung cấp.

### 3.2 Instance và snapshot

```typescript
interface WidgetInstance {
  instanceId: string;
  definitionRef: { id: string; version: string; packageDigest: string };
  ownerNodeId: string;
  ownerPrincipalId: string;
  revision: number;
  props: unknown;
  stateRef?: string;
  dataRefs: string[];
  connectionRefs: string[];
  actionBindingIds: string[];
  lifecycle: 'ready' | 'active' | 'suspended' | 'needs_auth' | 'offline' | 'error';
}
interface WidgetSnapshot {
  snapshotId: string;
  instanceId?: string;
  messageId: string;
  capturedRevision: number;
  capturedAt: string;
  textAlternative: string;
  presentationRef: string;
}
interface Pin {
  pinId: string;
  conversationId: string;
  instanceId: string;
  displayMode: 'compact' | 'expanded';
  position: number;
}
```

Schemas phải validate các trường `unknown` theo definition; không pass-through tới DOM. History giữ snapshots có ngày cập nhật. Pin giữ instance hiện hành; lịch sử không bị viết lại thành dữ liệu hiện tại mà không dấu hiệu rõ.

## 4. Rich built-in catalog

Core chỉ sở hữu renderer/registry/action/state primitives. Các implementation nặng có thể shipped/lazy-loaded như first-party UI packs; user vẫn thấy một app thống nhất.

| Nhóm | Components và interaction chính | Gate thực tế |
|---|---|---|
| Layout | Stack, Row, Grid, Card, Tabs, Divider, collapsible group | Responsive, bounded layout, không tự tạo global navigation |
| Text / status | Rich text, Markdown, code, badge, metric, progress | Sanitization, evidence/state nguồn thật |
| Choice | Chips, select, multiselect, command choice | Stable IDs, keyboard, no hidden expanded permissions |
| Form | Text, number, date/time, slider, checkbox, file request | Client+server validation, no raw secrets in ordinary form |
| Lists | Result list, checklist, tree subset, contacts | Filter/select, not session sidebar by default |
| Tables | Sort/filter/page/select, totals, CSV export | Dataset/view coherence, formula injection protection |
| Charts | Line/bar/area/donut/scatter, series toggles | Units/source/missing values, no arbitrary JS callback |
| Diagram / graph | Flow/sequence/node-edge, zoom/fit | Bounded parser/layout, sanitize output |
| Map | Pins, clusters, GeoJSON, feature selection | Attribution, provider policy, geolocation only consent |
| Calendar | Agenda/month/week, date selection, event preview | Timezone/date-only/recurrence display correctness |
| Timeline / board | Activity timeline, simple kanban cards | Updates are actions, not optimistic external success |
| Files / artifacts | Image, download, code diff, document preview | MIME/ownership/content validation, no arbitrary file:// |
| Notes / editor | Plain/rich text, checklist, autosave status | Draft/version/conflict preservation, no silent overwrite |
| Media | Audio/video player, playlist, now-playing controls | One active playback owner, browser policy/licensing gates |
| Conversation | Thread/messages, composer, delivery status | Sender/account scope, clear draft/send distinction |
| Call surface | Join/leave, participant state, mic/camera controls | Real SDK + host permissions, no silent recording |
| Browser / computer | Screenshot/live preview, target, takeover, stop | Session lease, authenticated media, never privileged app browser |
| Operational cards | Connection status, install plan, device/task state | Host-owned trust indicators, typed underlying state |

“Một rich editor” không có nghĩa sao chép toàn bộ Notion. “Conversation widget” không có nghĩa mọi service có cùng quyền inbox. Domain behavior đến từ adapter/extension đang có.

Host-only approval/credential/device consent cards không nằm trong ordinary third-party catalog. Model có thể request host mở một flow nhưng không tự định nghĩa trạng thái “đã được cấp quyền”.

### 4.1 Trạng thái triển khai (2026-09-17)

Ghi rõ phần nào của §4 đã có trong repo và phần nào còn là thiết kế, để không đọc bảng trên như một bản kiểm kê tính năng đã xong.

**Đã có, kèm test:**

- Định nghĩa catalog + family trong `packs/data-canvas`: `canvas.line/bar/donut/table`, `canvas.metrics`, `canvas.filter`, `canvas.calendar`, `canvas.image`, `canvas.cta`, và container `canvas.overview@1`.
- Leaf renderer trong `packages/conversation-client` (donut thật, month grid, KPI tile, image, CTA) cùng text alternative cho mọi vùng.
- Vùng **ảnh** của sketch nay thật sự tới được người dùng: `publishMiniAppData` trả ảnh mới nhất đã nhập, template `overview` có slot `image` (fixed, optional theo dữ liệu), và text alternative của vùng mang **alt text người dùng nhập**. Ảnh đi qua `blob:` URL vì token không thể nằm trong `<img src>`, nên CSP của `apps/web/index.html` phải cho `img-src ... blob:` — thiếu điều đó thì mọi ảnh đã nhập render thành "Chưa tải được hình ảnh" dù node trả bytes đúng.
- **Declarative composition** (trust tier thứ hai trong bảng trên) là tier đang được dùng cho mini-app: spec có version, mỗi section pin `definitionRef.digest`, không có payload thực thi, action chỉ là tham chiếu tới binding do server compile.
- Snapshot là **bundle bất biến** trong bảng riêng (`presentation_bundles`), không phải `catalog:id` trỏ tới dữ liệu hiện tại; xoá nguồn dữ liệu → tombstone, không đọc lại live.
- Pin = cùng một logical instance, một live owner có lease (`widget_live_owners.lease_expires_at`), vị trí còn lại read-only.
- **Read-only chỉ chặn action, không chặn view state**: snapshot lịch sử và surface do tab khác sở hữu vẫn đổi được ngày đang chọn / kỳ đang xem (đó là trình bày), nhưng không có `onAction` nên không có đường nào tới server; nút CTA hiện trạng thái disabled kèm lý do thay vì giả vờ bấm được.
- Snapshot trỏ đúng message chứa nó: `messageId` được cấp **một lần** rồi dùng cho cả lời gọi composer và message được ghi, nên không có snapshot mồ côi (test `apps/web/e2e/mini-app.spec.ts` phủ đường lịch sử này).
- Action M1 chỉ gồm `period.change`, `date.select`, `view.save` (`view` kind). `invoke`/`agent`/`workflow` bị từ chối ở `invokeMiniAppAction` và phải đi đường approval.
- Composer tất định `CC_MODEL_FIXTURE=1` chỉ tồn tại để browser suite chạy được đường composed-surface mà không gọi provider; node in cảnh báo lúc khởi động và câu trả lời tự nói nó là fixture.

- **Đính kèm tệp đi tới được agent**: composer tải lên, bytes nằm trong blob store dùng chung (`dataDir/blobs`, content-addressed, `mode: 0o600`), quota tính theo principal, và loại tệp do **magic bytes** quyết định chứ không do đuôi tên. Prompt chỉ mang `att_…` opaque và **không bao giờ** có path; agent đọc nội dung qua tool của host `read_attachment(attachmentId)`, tool này không nhận tham số path nên không có đường nào mở tệp khác. Tin nhắn đã lưu là nguồn duy nhất — timeline và prompt là hai cách đọc cùng một dòng (`apps/web/e2e/attachments.spec.ts`; phần prompt được chứng minh ở ranh giới adapter bằng `FakePiAdapter.promptsFor()`).
- **Memory** (`memory_records`, migration 18) **không** phải một index tìm kiếm thứ hai. Xoá một memory xoá **đường inject** vào lượt sau — brief được đọc lại mỗi lượt chứ không cache trong tiến trình — còn tin nhắn gốc của người dùng vẫn nằm trong lịch sử hội thoại và vẫn nhìn thấy được. Vì vậy đây không phải hidden memory: mọi thứ được nhớ đều đọc được và xoá được ở tab Memory (`apps/web/e2e/memory.spec.ts`).
- **Cửa sổ desktop** vào tới client thật: `electron . --renderer-url <url> --data-dir <dir>`, CSP suy ra từ origin, và một bridge có tên `getSession()` trả `{ baseUrl, token }` đọc từ `identity.json`. Token **không** đi vào argv hay URL, nơi nó sẽ nằm trong danh sách tiến trình và trong lịch sử trình duyệt.
- `?cc-compact=1` là **đường test-only** để browser suite chạm được thanh voice tối giản, không phải một tính năng. Đường thật vào trạng thái đó là cửa sổ thu nhỏ.

**Chưa có (deferred, không được claim là đã xong):**

- `isolated-app` và `mcp-app`: sandbox policy/registry có code và test, nhưng **renderer runtime cho app cách ly chưa được chứng minh**. Không có app runtime trong repo.
- Google Calendar connector, custom iframe mini-app, và CTA dạng “agent làm việc X” đều ngoài M1.
- Bảng family coverage trong §4 vẫn là đích đến của release gate: repo hiện có test cho các family mà composed surface cần (`metrics`, `filter`, `trend`, `calendar`, `media`, `cta`, `tables`, `layout`), không phải cho toàn bộ danh sách.

- **Chưa có extractor cho PDF và ảnh**: `read_attachment` chỉ đọc được tệp văn bản và nêu tệp nhị phân bằng id. Điều kiện còn thiếu: một extractor, và một adapter nhận được nội dung ảnh trong prompt — hiện `prompt(sessionId, text)` chỉ nhận văn bản.
- **Chưa có route xoá conversation**: retention hiện là `releaseConversationAttachments`. Bốn bảng tham chiếu `conversations` mà không có `ON DELETE CASCADE`, và `PRAGMA foreign_keys = ON`, nên xoá một conversation cần một migration xử lý các tham chiếu trước.
- **Smoke của Electron không chạy trong CI**: Electron cần display và CI không có. Điều kiện còn thiếu: một job `xvfb-run`, hoặc chấp nhận evidence của cửa sổ do người vận hành chạy và ghi rõ như vậy.

## 5. Agent-defined actions

### 5.1 Bốn loại action

```typescript
type ActionProposal =
  | { kind: 'view'; operation: string; args: object }
  | { kind: 'invoke'; capabilityRef: string; args: object; bindings?: FieldBinding[] }
  | { kind: 'agent'; intent: string; contextRefs: string[]; inputSchema?: object }
  | { kind: 'workflow'; steps: WorkflowStep[]; inputSchema?: object };
```

- **view:** client-local transient gesture hoặc canonical view state. Filter/zoom/playhead UI không gọi model mỗi lần.
- **invoke:** agent chọn một discovered tool/API/MCP capability, target node/account, arguments và cho phép user cung cấp fields đã bind. Không cần app viết riêng “PlaySpotifyButton”.
- **agent:** click trở thành một ý định mới với context đã xác định, ví dụ “tìm khung giờ khác cho event này”. Intent có thể do model viết; host trình bày đúng label và không coi text đó là permission.
- **workflow:** một chuỗi bounded steps từ các capabilities đã biết, có condition/transform enum được kiểm soát. Không arbitrary JS, shell interpolation hoặc vòng lặp vô hạn.

View operations có registry, nhưng domain action không bị giới hạn vào registry business handlers cố định của core. Capability registry từ installed extensions là nơi mở rộng. Muốn capability chưa có phải đi qua install/connect flow, không coi tên tool do model bịa là executable.

### 5.2 Ví dụ Calendar

```json
{
  "widget": "agent.calendar.agenda@1",
  "props": { "title": "Tuần này", "eventsRef": "dataset_events_demo", "timezone": "Asia/Ho_Chi_Minh" },
  "actions": {
    "refresh": {
      "kind": "invoke",
      "capabilityRef": "google.calendar.events.list@1",
      "args": { "connectionRef": "conn_demo", "calendarRef": "cal_demo", "rangeRef": "range_this_week" }
    },
    "findAnotherTime": {
      "kind": "agent",
      "intent": "Đề xuất thời gian khác cho sự kiện được chọn; chưa cập nhật lịch.",
      "contextRefs": ["selectedEvent", "conn_demo"]
    }
  }
}
```

Đây là dữ liệu minh họa, không integration đã connected. Host resolve refs, verify ownership, bind real account/node, whitelist user-controlled fields và xác minh requested scopes. Một label “Xem lịch” không được giấu action xóa event: host phân loại effect từ capability, hiện operation thật khi xin quyền.

### 5.3 Binding và execute

Host cấp action ID với instance/definition/package generation, input schema, allowed data refs, fixed connection/resource constraints, policy requirement và action spec digest. Action ID không là bearer authorization token.

Client gửi `instanceId + actionId + expectedRevision + input + commandId`. Backend authenticate, dedup, validate inputs/schema/refs, check current generation/connection/grants, rồi commit intent. Giới hạn token/rate/deadline trước gọi conductor từ agent-intent action.

Versioning phân biệt presentation-only revision, data revision và action-binding revision; không vô hiệu hóa mọi nút chỉ vì tooltip đổi. Nhưng target/account/tool generation/meaning thay đổi phải tạo binding mới, approval cũ không theo sang.

Task có thể đã complete nhưng instance action vẫn hợp lệ, vì invocation mới tạo operation/task mới. Một task approval cũ không biến thành vĩnh viễn cho pinned widget.

## 6. Pin UX và state ownership

**Pin là một gesture giữ mini-app trong conversation, không phải mở thêm sản phẩm dashboard.** User có thể nói “ghim cái lịch này”, bấm pin, “thu nhỏ player”, “bỏ ghim”.

Default không có pin. Khi có, vùng compact nằm sát chat/composer hoặc header, không session/sidebar. Chỉ một expanded surface mặc định; các pin khác là compact chips/cards; overflow không chiếm toàn màn hình. Tất cả operations vẫn gọi được bằng chat. Không auto-pin theo ý agent khi user chưa yêu cầu.

Pin points tới cùng logical instance. Timeline có thể hiện snapshot của nó và nút focus. **Một player/call không được mount hai live effect owners** khi vừa inline vừa pinned. Renderer chuyển vị trí/ownership; bản khác chỉ preview read-only. Pin reordering không restart audio.

### 6.1 Vòng đời

- Unpin bỏ presentation preference, không xóa note hoặc tự hủy remote job.
- Close mini-app khác với unpin; active call cần rõ “rời cuộc gọi”.
- Restart khôi phục snapshot/draft/pin order. Không tự play media, join call hoặc bật mic.
- Subscription đọc được resume chỉ khi user đã cấp standing refresh grant, đúng visibility/budget. Nếu không có, hiện “cập nhật khi mở”.
- Pin không tự tạo periodic LLM task. Refresh dữ liệu dùng adapter deterministic, có TTL/backoff và last-updated.
- Offline giữ cached read view, field drafts; mutations không tự gửi khi mạng trở lại trừ policy queue được user hiểu/chấp thuận. Sensitive mutation cần revalidation trước send.
- Widget/server/package unavailable vẫn hiển thị text/snapshot; không “biến mất khỏi lịch sử”.

### 6.2 Drafts và xung đột

Note editor, form và messaging composer có draft store tách external committed state. Autosave remote chỉ sau grant có nội dung; hiện saving/saved/conflict. API supports ETag/version thì dùng; không có thì fetch-compare hoặc cảnh báo merge best effort, không giả conflict-free editing.

Thay schema không tự gửi draft sang fields khác. State migrations có version/test/backup, failing upgrade giữ snapshot và recovery choices. Không multi-user CRDT trong release đầu.

## 7. Custom widget development

User có ba lựa chọn, tất cả discover được từ chat:

1. Ghép existing components và action descriptors; không cần build code.
2. Nhờ agent tạo package UI từ template SDK trong isolated build workspace; preview, test, approve capabilities, cài vào user scope.
3. Cài vendor package hoặc MCP App đã tồn tại; exact source/version và quyền như extension khác.

Không cho agent tự hot-evaluate generated JSX trong app renderer. Tự viết widget không bị cấm; nó đi qua build/install boundary giống third party. Không cần developer mode toàn quyền chỉ để có note widget không network.

### SDK chức năng

```text
props.read / props.subscribe
state.get / state.update(expectedRevision)
events.emit(typedEvent)
actions.invoke(boundActionId, validatedInput)
capabilities.request(requestedCapability)  # opens host consent, not grants itself
host.focus / host.resize(request) / host.requestPin
host.openExternal(approvedUrl)
semantic.publish(summary, selectedIds, availableActions)
lifecycle.onMount / onSuspend / onResume / onDispose
```

`requestPin` là proposal trừ khi originated trực tiếp từ user gesture đã rõ. SDK không có `readAllSecrets`, `shell`, `queryCoreDb`, `disableCSP`, `approve`, `installAnything` hoặc `registerSidebar`.

### Trust tiers

| Type | Execution | Quyền mặc định |
|---|---|---|
| Built-in catalog | Trusted client code | Render props; actions qua host |
| Declarative composition | No executable payload | Existing components + bound actions |
| User/third-party UI | Isolated origin/iframe | No Node/fs/host cookies; explicit network/media/actions |
| Tool/API/MCP service | Separate executor/service | Granted resources; OS isolation khi code không tin cậy |
| Native Pi extension | Full Pi process code | Trusted mode hoặc sandbox entire worker; never privileged core by default |

## 8. Mini-app isolation

MCP Apps cung cấp host/UI communication primitives, nhưng app vẫn phải triển khai sandbox/CSP/origin checks và consent đúng [R06–R08]. SDK use không tự làm tất cả code an toàn.

Default custom iframe `allow-scripts`, không top navigation/download/popups/camera/mic/geolocation. Opaque-origin messaging cần exact source-window + negotiated MessagePort/nonce validation, không chỉ `origin == null`. SDK cần storage/origin có thể chạy trên separate per-app origin với approved sandbox policy; **không cùng origin với main chat**.

CSP define connect/resource/frame domains theo package manifest đã consent. Network egress từ renderer và backend khác nhau, đều cần budget/policy. No remote script updates bypass pinned bundle; vendor SDK remote URL chỉ cho approved version/origin theo declared policy và platform constraints.

Host-owned frame chrome hiển thị app/source/account, permission controls và close/stop ngoài quyền iframe. Embedded UI có thể vẽ hình giả approval, nhưng không mint record; user phải phân biệt host consent bằng chrome/placement nhất quán.

Unsafe HTML/SVG/Markdown sanitize; Mermaid strict wrapper và worker timeout; no script callbacks from agent props. Dataset/attachments qua opaque refs, no arbitrary paths, executable URLs, SQL hay CSS property injection.

## 9. Frontend credentials: ngoại lệ phải thiết kế đúng

“Không gửi secrets tới renderer” cần phân biệt loại credential. API secret, refresh token, node private key không đi vào renderer/model. Một số playback/call SDK cần **short-lived scoped access/session token ở browser**. Khi vậy, auth broker chỉ cấp token phù hợp cho isolated widget origin/session đã consent, TTL ngắn nếu provider hỗ trợ, không đưa vào props, persisted state, logs hoặc conductor context.

Không giả token nào cũng scope/expire được theo ý app: adapter ghi chính xác provider hỗ trợ gì. Nếu token quyền quá rộng và SDK đòi browser thì nêu risk/thiết kế fallback. Uninstall/revoke ngừng refresh và thu hồi khi API hỗ trợ; không hứa đã thu hồi mọi access token ngay khi vendor không có cơ chế đó.

## 10. Use cases bên thứ ba — khả năng và giới hạn

| Ví dụ | Widget/adapter hợp lý | Không được hứa mặc định |
|---|---|---|
| Spotify | Player/playlist qua approved SDK hoặc device-control API | Embedded playback cần account/SDK/DRM/policy phù hợp; Premium và commercial streaming restrictions phải kiểm tra [R23] |
| Telegram | Conversation view + composer; Bot API connector hoặc user-client adapter riêng | Bot token không mở toàn bộ inbox cá nhân; user client auth/API ID là flow khác [R24] |
| Zoom | Meeting SDK call surface, explicit mic/camera, join/leave | Mobile support tùy view; human Meeting SDK không tự thành AI meeting bot/recorder [R25] |
| Notion | Note/block editor trên API và authorized pages | Không phải toàn bộ Notion webapp nhúng; capabilities/page access/sync conflict là gate [R22] |
| Google Calendar | Agenda/week + event editor qua reference connector | Render calendar không chứng minh OAuth scopes đủ để sửa lịch [R20–R21] |

Release chứng minh custom editor và một conformance media fixture, không claim đã được mọi vendor certify. Fixture sample label rõ; genuine vendor playback/call phải test trên exact Electron/browser/platform versions.

## 11. Extension packages nhiều facets

```json
{
  "id": "example.calendar-pack",
  "version": "0.2.0",
  "hostApi": ">=1 <2",
  "facets": {
    "tools": { "entry": "dist/connector.js", "isolation": "service" },
    "ui": [{ "id": "example.calendar.week", "entry": "dist/widget/index.html" }],
    "skills": ["skills/calendar.md"],
    "setup": "setup/calendar.json"
  },
  "requestedCapabilities": ["connection.calendar.read", "widget.state.write"],
  "platforms": ["linux-x64", "linux-arm64", "darwin-arm64"]
}
```

Manifest là proposal metadata của package; không tự cấp các capabilities kê khai. Install record bổ sung resolved versions/digests, transitive dependencies, target node, auth/data recipients và approved grants. Fields có schema strict, no arbitrary lifecycle script auto-run.

Pi-compatible facets có thể đóng extension/skills/prompts/themes theo manifest upstream, nhưng app lifecycle riêng không được gọi là Pi official API [R02–R04]. Facets độc lập giúp update UI không restart Pi; update skill có thể reload resources; connector tool service có thể restart riêng. Chord là P0 candidate cho composition implementation, không security/federation shortcut [R05].

## 12. Resource limits và accessibility

Initial targets (phải đo): ordinary catalog spec ≤256 KiB; lazy mount heavy widgets; per-app CPU/memory/frame budgets; bounded logs/network/API rate; datasets lớn pagination/downsampling có nhãn. Không auto-limit rich widget thành vô dụng, nhưng một chart không được freeze composer.

Offscreen widgets suspend rendering/subscriptions theo loại; active user-authorized player/call có exception và clear indicator. Stalled widget có timeout/error boundary/text fallback, không crash chat. Text alternatives, keyboard controls, reduced motion, contrast, focus restore và không focus-steal là release gates.

State chia rõ client view, durable instance state và external service truth. Giá trị optimistic chỉ là pending; không hiện “đã gửi tin” trước provider ack/verification.

## 13. Conformance tests

Catalog/iframe đều phải pass: malformed props reject; unknown action reject; forged grants fail; stale account/version binding fail; voice/click same outcome; double click dedup; reopen no effect; pin no duplicate media; unpin preserve note; reinstall preserves compatible state; auth revoked disables protected actions; custom widget cannot read host storage/secret; microphone off actually ends capture.

MCP App test dùng reference fixture và exact negotiated spec. Features SDK không hỗ trợ hoặc browser permissions không cho thì fallback rõ, không silently pretend mounted means functional.

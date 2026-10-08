# Widgets, Mini-apps, Pins & Extension SDK v2

> [English](widgets-and-extensions.md) (mặc định) · Tiếng Việt

**Ngày:** 01/10/2026. Đây là contract đề xuất của app, không phải upstream Pi/MCP wire schema.

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

- Định nghĩa catalog + family trong `packs/data-canvas`: `canvas.line/bar/donut/table`, `canvas.metrics`, `canvas.filter`, `canvas.calendar`, `canvas.image`, `canvas.cta` (giữ để lịch sử vẫn hiển thị), nút hành động chung `canvas.action@1`, các widget nhập liệu `canvas.choice@1`, `canvas.input@1`, `canvas.search@1`, `canvas.form@1` và `canvas.list@1` ([Widget development §8.2](widget-development.vi.md#82-biểu-mẫu-danh-sách-ô-tìm-kiếm-và-trường-nhập)), các thẻ chỉ-đọc `canvas.status@1`, `canvas.progress@1` và `canvas.details@1` ([Widget development §8.4](widget-development.vi.md#84-thẻ-trạng-thái-tiến-độ-và-chi-tiết)), và container `canvas.overview@1`.
- Leaf renderer trong `packages/conversation-client` (donut thật, month grid, KPI tile, image, CTA) cùng text alternative cho mọi vùng.
- Các thẻ hiển thị một phần công việc: `canvas.code@1` (khối mã có số dòng và nút sao chép), `canvas.diff@1` (bản diff dạng unified, tiêu đề hunk và số đếm được tính từ chính các dòng) và `canvas.file@1` (một tệp được nêu tên và mô tả, không có liên kết, nút mở hay nút tải về). Chúng chỉ hiển thị dạng chữ những gì model viết, và không tải gì. Node từ chối props không khớp trước khi có instance, và chúng không phải lá của layout ([Widget development §8.5](widget-development.vi.md#85-mã-diff-và-tệp)).
- Các khung nhìn tương tác do host dựng và có giới hạn gồm `canvas.timeline@1`, `canvas.tree@1`, `canvas.diagram@1` và `canvas.board@1`. Chúng chỉ giữ state khung nhìn đã khai báo; di chuyển thẻ khi bảng Kanban không gắn action chỉ đổi thứ tự cục bộ, còn di chuyển dữ liệu ngoài phải có binding `invoke` do host compile và giữ trạng thái chờ cho tới khi biết kết quả ([Widget development §8.10](widget-development.vi.md#810-bảng-kanban)).
- `canvas.map@1` vẽ điểm, đường và vùng có giới hạn trên nền bản đồ ngoại tuyến Natural Earth (phạm vi công cộng), đi kèm client. Props không mang URL nào. Ô bản đồ raster chỉ có khi node có tile policy `maps.tilePolicy`, mặc định tắt. Con người đặt nó trong Cài đặt → Tiện ích → Ô bản đồ. Clark đặt hoặc xóa nó qua `set_map_tiles`, và execution policy quyết định việc đó như mọi tác động khác: nó chạy kèm bản ghi hoạt động và Hoàn tác, hoặc trở thành thẻ duyệt do host sở hữu. Khi bản đồ chỉ dùng nền ngoại tuyến, bản đồ nói rõ lý do. Policy nêu đúng một nhà cung cấp, và trang lấy ô qua proxy `/map-tiles/:z/:x/:y` của node. Khóa của nhà cung cấp là secret `maps:tiles` riêng của host. Nó chỉ được nhập trong Cài đặt và gắn với origin mà nó được nhập cho. Node chỉ gửi nó tới origin đó, và nó không bao giờ tới trang ([Widget development §8.13](widget-development.vi.md#813-bản-đồ)).
- Vùng **ảnh** của sketch nay thật sự tới được người dùng: `publishMiniAppData` trả ảnh mới nhất đã nhập, template `overview` có slot `image` (fixed, optional theo dữ liệu), và text alternative của vùng mang **alt text người dùng nhập**. Layout ghép cũng đặt được gallery hoặc carousel gồm những ảnh người dùng đã nhập (mới nhất trước, tối đa theo sức chứa của widget); node điền ảnh và alt text của chúng, và ảnh được chọn ở đó có thể nối vào state của bề mặt qua `media.select` ([phát triển widget §8.11](widget-development.vi.md#811-widget-media-và-trạng-thái-semantic)). Ảnh đi qua `blob:` URL vì token không thể nằm trong `<img src>`, nên CSP của `apps/web/index.html` phải cho `img-src ... blob:` — thiếu điều đó thì mọi ảnh đã nhập render thành "Chưa tải được hình ảnh" dù node trả bytes đúng. Video cục bộ cũng tới theo cùng cách, nên cả trang web lẫn cửa sổ desktop cho phép `media-src 'self' blob:` và không có origin media từ xa nào ([#374](https://github.com/digitopvn/clarkcant/issues/374)). Node chưa nhập được video (`/images` chỉ nhận ảnh), nên video cục bộ chỉ phát được từ một tham chiếu mà host đã phục vụ sẵn.
- `canvas.audio@1` phát một tệp âm thanh và `canvas.document@1` xem trước phần chữ của một tệp PDF hoặc tệp văn bản, mỗi widget lấy từ một nguồn mà node kiểm tra ([phát triển widget §8.14](widget-development.vi.md#814-trình-phát-âm-thanh-và-xem-trước-tài-liệu)). Âm thanh đến từ một tệp trong cuộc hội thoại hoặc từ một URL `https` có origin được người vận hành liệt kê trong `CC_MEDIA_ORIGINS` (mặc định không có). Node fetch tệp theo chính sách nội dung media, chính sách này từ chối kèm quy tắc bị vi phạm ([§14.5](widget-development.vi.md#145-chính-sách-nội-dung-media)), lưu tệp thành artifact, và trang phát tệp từ node với điều khiển gốc, không bao giờ tự phát. Bản xem trước tài liệu là chữ được chia trang có giới hạn, kèm dòng báo khi bị cắt; không gì trong tệp được chạy. Cả hai không phải leaf của layout, và page policy không đổi.
- **Declarative composition** (trust tier thứ hai trong bảng trên) là tier đang được dùng cho mini-app: spec có version, mỗi section pin `definitionRef.digest`, không có payload thực thi, action chỉ là tham chiếu tới binding do server compile.
- Snapshot là **bundle bất biến** trong bảng riêng (`presentation_bundles`), không phải `catalog:id` trỏ tới dữ liệu hiện tại; xoá nguồn dữ liệu → tombstone, không đọc lại live.
- Pin = cùng một logical instance, một live owner có lease (`widget_live_owners.lease_expires_at`), vị trí còn lại read-only.
- **Read-only chỉ chặn action, không chặn view state**: snapshot lịch sử và surface do tab khác sở hữu vẫn đổi được ngày đang chọn / kỳ đang xem (đó là trình bày), nhưng không có `onAction` nên không có đường nào tới server; nút CTA hiện trạng thái disabled kèm lý do thay vì giả vờ bấm được.
- Snapshot trỏ đúng message chứa nó: `messageId` được cấp **một lần** rồi dùng cho cả lời gọi composer và message được ghi, nên không có snapshot mồ côi (test `apps/web/e2e/mini-app.spec.ts` phủ đường lịch sử này).
- Action của mini-app gồm `period.change`, `date.select` và `view.save` (`view` kind), đi qua `invokeMiniAppAction`. Mọi action có binding khác được host điều phối theo chính binding, không bao giờ theo lời widget: binding `invoke` đi tới `invokeCapability` và chỉ chạy khi nó trỏ tới một capability do package service cung cấp trên node này ([Widget development §4](widget-development.vi.md#4-package-manifest)); binding `agent` mở một lượt với tin nhắn đúng bằng nhãn của nút, kèm ngữ cảnh mà `contextRefs` chỉ ra do host đọc; binding `workflow` chạy các bước đóng của nó theo thứ tự, mỗi bước `invoke` đi qua `invokeCapability` với quyết định policy riêng ([Widget development §8.1](widget-development.vi.md#81-nút-hành-động-chung-canvasaction1)).
- Composer tất định `CC_MODEL_FIXTURE=1` chỉ tồn tại để browser suite chạy được đường composed-surface mà không gọi provider; node in cảnh báo lúc khởi động và câu trả lời tự nói nó là fixture.
- **Frame cách ly của widget sống lâu hơn grant trong URL của nó** (#233). URL của frame mang một grant trong path, có hiệu lực năm phút (`FRAME_GRANT_LIFETIME_MS` trong [frame-grant.ts](../packages/core/src/frame-grant.ts)), nên một URL bị sao chép sẽ ngừng hoạt động; còn frame hiển thị nó có thể mở lâu hơn nhiều. `GET …/widgets/{instanceId}/live` cho biết URL còn dùng được bao lâu qua `frame.urlExpiresInMs`, và client tính khoảng đó từ lúc nó gửi yêu cầu đọc, nên hạn của client không bao giờ muộn hơn hạn của node. Frame nào phải tải lại tài liệu sau hạn đó — được mount lại từ một câu trả lời đã giữ, hoặc bị trình duyệt tải lại — sẽ đọc lại instance đúng một lần để lấy URL mới thay vì hiện lời từ chối của node, và widget nhận lại state đã commit. Nếu lần đọc đó cũng thất bại, frame nói rõ điều gì thất bại, rằng những gì widget đã lưu vẫn được giữ trên node, và đưa ra nút **Thử lại**; nó không tự thử lại. Frame không nhận thêm gì mới: URL mới vẫn là cùng loại grant cho cùng tài liệu.
  - `CC_FRAME_GRANT_FIXTURE=1` cho phép browser suite rút ngắn thời hạn của các grant được tạo tiếp theo qua `POST /frame-grant-fixture/lifetime` (sau bearer token), để việc hết hạn chỉ mất vài giây. Nó chỉ có thể rút ngắn, node khởi động không có nó trả 404 cho route đó, và node in một dòng lúc khởi động khi nó được nạp.
  - Tests: [frame-grant-lifetime.spec.ts](../apps/runtime/test/frame-grant-lifetime.spec.ts), [frame-grant-renewal.spec.ts](../packages/conversation-client/test/frame-grant-renewal.spec.ts), và browser journey [widget-frame-grant.spec.ts](../apps/web/e2e/widget-frame-grant.spec.ts).
- **Cây bố cục** cho model sắp xếp một bề mặt ghép mà không cần template mới (#224). `show_view` với `canvas.overview@1` và `props.layout` nhận một cây gồm các nút `stack`, `row`, `grid` (1–4 cột), `card`, `tabs`, `split` (đúng hai), `collapsible` và `divider`, có lá là `{ kind: "widget", widget: "<id trong catalog>", props?, label? }`. Không có `props.layout` thì các template `overview`, `focused` và `agenda` vẫn chạy như công thức sẵn.
  - Node biên dịch cây ([compose-layout.ts](../apps/runtime/src/compose-layout.ts)): mỗi lá phải là widget lá có trong catalog của node này (không phải container, không phải `canvas.action@1` hay `canvas.form@1` — hai widget này được đặt bằng `show_view` riêng, và `canvas.choice@1` hay `canvas.input@1` chỉ được đặt khi có quy tắc `on` ghi vào state của bề mặt, vì nếu không giá trị của nó chẳng đi đâu cả), props được kiểm theo đầy đủ JSON Schema của định nghĩa, dữ liệu do host gắn (`datasetRef` model gửi sẽ bị ghi đè), và digest của định nghĩa được ghim. Cây được lưu chỉ gọi section theo id, nên không mang id widget, props hay mã.
  - Giới hạn nằm trong [composition-layout.ts](../packages/contracts/src/composition-layout.ts): tối đa 5 tầng, 40 nút, 12 con mỗi container, 8 tab và 12 widget. Cây vượt giới hạn, có trường mà nút không có, hoặc có widget catalog không giữ sẽ bị từ chối kèm lý do, và không có gì được ghi.
  - Spec có cây là `schemaVersion` 2 và được lưu trong presentation bundle bất biến, nên khi tải lại cuộc hội thoại, lịch sử vẽ đúng cây đó. Mọi nút đều có bản thay thế bằng chữ, dựng từ nhãn và các section của nó.
  - Client vẽ cây trong [mini-app-surface.tsx](../packages/conversation-client/src/mini-app-surface.tsx): grid không bao giờ vẽ nhiều cột hơn cây yêu cầu, cũng không vẽ cột hẹp hơn 220px; split xếp chồng khi bề mặt hẹp; tabs theo mẫu tab WAI-ARIA (phím mũi tên, Home và End); collapsible là `<details>` gốc.
  - Test: [composition-layout.spec.ts](../packages/contracts/test/composition-layout.spec.ts), [compose-layout.spec.ts](../apps/runtime/test/compose-layout.spec.ts), và hành trình trình duyệt [layout-tree.spec.ts](../apps/web/e2e/layout-tree.spec.ts), có chạy cả ở 375px.
  - Lá `canvas.search@1` lọc mọi bảng trong cùng bề mặt, ngay trên trang: "Card(Search, Table)" là một card chứa lá search phía trên lá table (#225). Lá `canvas.list@1` hiện các mục nhưng không có nút cho từng mục, vì lá không gắn hành động nào.
- **Đồ thị state** nối các widget của một bề mặt ghép (#226). `props.state` khai báo tối đa 16 khoá có kiểu; quy tắc `on` của một lá biến một sự kiện mà định nghĩa của nó phát ra (`query.change`, `choice.change`, `input.change`, `selection.change`, `row.select`, `date.select`) thành các bước đóng ghi vào các khoá đó, còn `feed` của lá đọc một khoá làm câu tìm cho bảng hay danh sách, hoặc làm bộ lọc khớp chính xác trên một cột của bảng, một trường của danh sách hay chuỗi của biểu đồ. Lá không bao giờ gọi tên lá khác ([widget development §8.3](widget-development.vi.md#83-nối-các-widget-trên-cùng-một-bề-mặt)).
  - Các quy tắc là dữ liệu trong [composition-graph.ts](../packages/contracts/src/composition-graph.ts), được node kiểm trước khi lưu bất cứ thứ gì. Khoá chưa khai báo, sự kiện mà định nghĩa không phát ra, feed mà định nghĩa không đọc, hay bước ghi sai kiểu đều bị từ chối kèm lý do.
  - Mỗi lá được nối có một view binding `state.event`. Trang áp dụng sự kiện ngay rồi gửi đi; node áp lại đúng các quy tắc đó lên giá trị nó đã lưu trong `widget_state` và giữ kết quả, nên bề mặt sống hiện đúng các giá trị đó sau khi tải lại. Bản sao trong hội thoại giữ giá trị ban đầu đã ghi lại và vẫn khám phá được trên trang mà không gửi gì đi.
  - `GET …/widgets/{instanceId}/live` trả các giá trị dưới dạng `semanticState` cho agent đọc, có giới hạn và có kiểu. Bề mặt không khai báo state thì không lưu đồ thị và không gắn gì: ô tìm kiếm của nó lọc bảng ngay trên trang, như trước.
  - Kiểm thử: [composition-graph.spec.ts](../packages/contracts/test/composition-graph.spec.ts), [composition-graph.spec.ts](../apps/runtime/test/composition-graph.spec.ts), [surface-graph.spec.ts](../packages/conversation-client/test/surface-graph.spec.ts), và journey trình duyệt [composition-graph.spec.ts](../apps/web/e2e/composition-graph.spec.ts).
- **Lượt kế tiếp biết người dùng đã đổi gì trên màn hình** (#195). Một lần chọn, tìm hay lưu trên widget không bắt đầu lượt nào và không ghi tin nhắn nào; node đánh dấu widget đã được chạm vào trong `widget_semantic_state` (migration 27). Khi lượt kế tiếp bắt đầu, node dựng lại tài liệu có giới hạn, đã che secret của từng widget được chạm vào ([widget-semantic.ts](../packages/contracts/src/widget-semantic.ts)), chỉ tăng revision khi tài liệu đổi, rồi nối một ghi chú ngắn vào sau mọi thứ khác trong prompt: toàn bộ tài liệu cho session chưa thấy nó, phần thay đổi cho session đã thấy, và không gì cả khi không có gì đổi. Tối đa ba widget trong khoảng 2.400 ký tự; tool chỉ-đọc `inspect_ui` đọc phần còn lại, chỉ trong cuộc trò chuyện này. Voice đọc widget đang focus từ cùng tài liệu đó. Một frame đề xuất summary, lựa chọn và giá trị của chính nó qua `POST …/widgets/{instanceId}/semantic`, được kiểm bằng schema chặt; frame không được nêu action ([phát triển widget §9](widget-development.vi.md#9-semantic-contract-cho-voice-và-lượt-kế-tiếp)).
  - Kiểm thử: [widget-semantic.spec.ts](../packages/contracts/test/widget-semantic.spec.ts), [widget-semantic.spec.ts](../packages/storage/test/widget-semantic.spec.ts), [widget-semantic.spec.ts](../apps/runtime/test/widget-semantic.spec.ts), và journey trình duyệt [widget-semantic.spec.ts](../apps/web/e2e/widget-semantic.spec.ts).
- **Thẻ trạng thái, tiến độ và chi tiết** (#280, thuộc #198). `canvas.status@1` hiện một trạng thái với sắc thái nói bằng chữ, `canvas.progress@1` hiện một giá trị trên mức tối đa bằng một thanh tiến độ thật hoặc một danh sách bước có đánh dấu bước đang làm, và `canvas.details@1` hiện các thông tin có nhãn. Model đặt chúng bằng `show_view` hoặc làm lá bố cục ở vùng `status`. Node từ chối props không hợp lệ, như giá trị vượt mức tối đa, tiến độ không có cả giá trị lẫn bước, mốc `asOf` thiếu độ lệch múi giờ, hay chữ có dấu xuống dòng, ký tự điều khiển hướng chữ hoặc ký tự vô hình. Text alternative là chính lời của thẻ. Voice và `inspect_ui` đọc thẻ theo điều đã nêu khi hiện, với freshness `unknown`. Không thẻ nào có badge độ mới hay nút điều khiển; thẻ tiến độ, và thẻ trạng thái không có `asOf`, ghi "Theo Clark lúc" thời điểm tin nhắn được lưu ([phát triển widget §8.4](widget-development.vi.md#84-thẻ-trạng-thái-tiến-độ-và-chi-tiết)).
  - Kiểm thử: [status-cards.spec.ts](../packages/contracts/test/status-cards.spec.ts), [status-cards.spec.ts](../apps/runtime/test/status-cards.spec.ts), [status-cards.spec.ts](../packages/conversation-client/test/status-cards.spec.ts), và journey trình duyệt [status-cards.spec.ts](../apps/web/e2e/status-cards.spec.ts).
- **Biểu đồ vùng và biểu đồ phân tán** (#282, thuộc #198). `canvas.area@1` vẽ một hay nhiều chuỗi dọc trục x, tô xuống tới 0 hoặc xếp chồng, và `canvas.scatter@1` vẽ một điểm cho mỗi hàng và mỗi chuỗi tại x và y của nó, có thể được gọi tên bằng một trường. Các trường được gọi tên trong props, không bao giờ bị đoán. Model đặt chúng bằng `show_view`; chúng không phải lá bố cục. Node đọc dataset được gọi tên với tư cách người đặt biểu đồ và từ chối, kèm lý do và trước khi có instance, một trường mà các hàng không có, một giá trị không phải số, và một dataset không thuộc về họ. Biểu đồ vẽ 500 hàng đầu tiên và nói khi còn nhiều hơn. Mỗi chuỗi có sắc màu, kiểu nét và hình dạng điểm riêng, chú giải ẩn và hiện chúng, mọi điểm tới được bằng bàn phím, và bên dưới biểu đồ có bảng các hàng. Chuỗi bị ẩn và điểm được chọn là một `chart.view` mà node kiểm tra theo các hàng nó đang giữ và lưu trong trạng thái widget, nên khi tải lại, voice và `inspect_ui` đều thấy cùng một khung nhìn ([phát triển widget §8.6](widget-development.vi.md#86-biểu-đồ-vùng-và-biểu-đồ-phân-tán)).
- **Các kiểu xem lịch** (#283, thuộc #198). `canvas.calendar@1` có kiểu tháng, tuần và lịch trình, và model đặt nó bằng `show_view` sau khi node kiểm tra tháng, múi giờ và dataset. Mỗi sự kiện nằm trên mọi ngày nó phủ theo múi giờ của lịch: sự kiện qua đêm nằm trên cả hai ngày, còn sự kiện cả ngày nằm trên đúng các ngày của nó, với `endDate` là ngày sau ngày cuối cùng. Hôm nay và vạch "bây giờ" theo múi giờ của lịch. Kiểu xem, ngày được chọn và sự kiện được chọn là một `calendar.view` mà node kiểm tra theo các hàng nó đang giữ và lưu trong trạng thái widget phiên bản 2; lịch được lưu trước đó mở ra ở kiểu tháng. Thêm, dời hay xoá sự kiện vẫn là capability được bind của nơi sở hữu sự kiện ([phát triển widget §8.7](widget-development.vi.md#87-các-kiểu-xem-lịch)).
  - Kiểm thử: [xy-charts.spec.ts](../packages/contracts/test/xy-charts.spec.ts), [xy-charts.spec.ts](../apps/runtime/test/xy-charts.spec.ts), [chart-layout.spec.ts](../packages/conversation-client/test/chart-layout.spec.ts), [xy-chart-schemas.spec.ts](../packages/widget-catalog/test/xy-chart-schemas.spec.ts), và journey trình duyệt [xy-charts.spec.ts](../apps/web/e2e/xy-charts.spec.ts).
- **Dòng thời gian hoạt động** (#326, thuộc #198). `canvas.timeline@1` hiện các mục có ngày giờ do model nêu, sắp theo thời gian và nhóm theo ngày: tối đa 200 mục, mỗi mục có id, một thời điểm kèm độ lệch hoặc một ngày cho mục cả ngày, tiêu đề, cùng mô tả, người thực hiện và sắc thái tuỳ chọn. Model đặt nó bằng `show_view` hoặc làm lá bố cục `timeline`. Node từ chối, kèm lý do và trước khi có instance, thời điểm không có độ lệch hoặc không có thật, id dùng hai lần, sắc thái không có, quá nhiều mục hoặc quá nhiều chữ, ký tự ẩn, và múi giờ node không biết; props không mang HTML, liên kết hay callback. Khi props không nêu múi giờ, node ghi múi giờ của chính nó vào props, nên node và trang đặt mỗi mục vào cùng một ngày. Mục được chọn là một `timeline.select` mà node kiểm tra theo các mục và lưu trong trạng thái widget, và `timeline.select` có thể cấp dữ liệu cho một surface được ghép. Voice và `inspect_ui` đọc số mục, các ngày được phủ, số mục theo sắc thái và mục được chọn. Nó không đọc nguồn dữ liệu trực tiếp nào và không bao giờ nói mình đang cập nhật trực tiếp ([phát triển widget §8.8](widget-development.vi.md#88-dòng-thời-gian-hoạt-động)).
  - Kiểm thử: [activity-timeline.spec.ts](../packages/contracts/test/activity-timeline.spec.ts), [activity-timeline.spec.ts](../apps/runtime/test/activity-timeline.spec.ts), [activity-timeline.spec.ts](../packages/conversation-client/test/activity-timeline.spec.ts), [timeline-schemas.spec.ts](../packages/widget-catalog/test/timeline-schemas.spec.ts), và journey trình duyệt [activity-timeline.spec.ts](../apps/web/e2e/activity-timeline.spec.ts).
- **Cây phân cấp** (#327, thuộc #198). `canvas.tree@1` là outline chỉ có chữ do host dựng, giới hạn 200 node và 12 cấp, đồng thời kiểm tra ID, nhãn, chữ phụ, icon và tham chiếu nhánh mở. `tree.select` và `tree.toggle` được kiểm tra rồi lưu thành state widget; ID trong state cũ không còn hợp lệ sẽ bị bỏ qua. Renderer thể hiện cấu trúc WAI-ARIA và điều hướng bàn phím; tài liệu semantic và phần dự phòng dạng outline thụt lề đều có giới hạn. Widget không đọc service hay sửa dữ liệu nguồn ([phát triển widget §8.9](widget-development.vi.md#89-cây-phân-cấp)).
  - Kiểm thử: [tree-view.spec.ts](../packages/contracts/test/tree-view.spec.ts), [tree-view.spec.ts](../apps/runtime/test/tree-view.spec.ts), [tree-view.spec.ts](../packages/conversation-client/test/tree-view.spec.ts), [tree-schemas.spec.ts](../packages/widget-catalog/test/tree-schemas.spec.ts), và journey trình duyệt [tree-view.spec.ts](../apps/web/e2e/tree-view.spec.ts) cho hội thoại, khôi phục pin, bàn phím, theme thích ứng và bản xem trước trong Widget Library.
- **Sơ đồ và đồ thị** (#325, thuộc #198). `canvas.diagram@1` vẽ một đồ thị node và cạnh có giới hạn (tối đa 60 node và 120 cạnh) dưới dạng SVG do host dựng, chỉ gồm text node: không HTML, `foreignObject`, liên kết, ảnh hay handler, và không có script nào chạy để vẽ nó. Một bố cục phân lớp hoặc dạng cây tất định, dùng chung cho node và mọi client, đặt sơ đồ từ trên xuống hoặc từ trái sang phải. Model có thể đưa một lưu đồ Mermaid thay cho mô hình; node phân tích một tập con được tài liệu hóa ngay trên host, chỉ lưu mô hình thu được và từ chối `click`, `style`, `classDef`, `%%{init}%%`, nhãn HTML cùng mọi cấu trúc cấu hình renderer của Mermaid, vốn không bao giờ được tải. `diagram.select` được kiểm tra rồi lưu thành state widget. Mỗi node là một nút đi tới được bằng bàn phím, có tên nói rõ hình, nhóm và các node kề; phím đi theo các cạnh, còn tài liệu semantic và phần thay thế dạng danh sách kề đều có giới hạn ([phát triển widget §8.12](widget-development.vi.md#812-sơ-đồ-và-đồ-thị)).
  - Kiểm thử: [diagram-view.spec.ts](../packages/contracts/test/diagram-view.spec.ts), [diagram-mermaid.spec.ts](../packages/contracts/test/diagram-mermaid.spec.ts), [diagram-layout.spec.ts](../packages/contracts/test/diagram-layout.spec.ts), [diagram-view.spec.ts](../apps/runtime/test/diagram-view.spec.ts), [diagram-view.spec.ts](../packages/conversation-client/test/diagram-view.spec.ts), [diagram-schemas.spec.ts](../packages/widget-catalog/test/diagram-schemas.spec.ts), và journey trình duyệt [diagram-view.spec.ts](../apps/web/e2e/diagram-view.spec.ts) cho hội thoại, bàn phím, lựa chọn được giữ, an toàn DOM, đầu vào Mermaid, các lần từ chối, theme thích ứng và bản xem trước trong Widget Library.
- **Trạng thái semantic của media** (#329, thuộc #198). `canvas.image@1` mô tả alt text và kích thước đã biết; gallery và carousel lưu mục đang chọn (`selectedIndex`, đếm từ 0) và báo mục đó là `selectedNumber` (đếm từ 1) cùng alt text và số mục; video cục bộ giữ status, position và duration có giới hạn, và một "playing" mà player không còn ghi mới được đọc là đang dừng; YouTube chỉ dùng id đã kiểm tra cùng title. Gallery/carousel dùng binding `media.view` của host; một lần ghi bị từ chối được vẽ lại và giải thích ngay bên cạnh widget, còn các lần ghi playback được gộp; player cũng ghi khi trang bị ẩn hoặc bị rời đi (lần ghi khi rời trang được gửi ngay, với `keepalive`), nhưng các lần ghi này chỉ là best-effort, và thứ giữ cho trạng thái playback được báo cáo trung thực là cửa sổ 8 giây của node (`MEDIA_PLAYING_FRESH_MS`), sau đó một "playing" cũ được đọc là đang dừng. Các lần ghi playback của trình phát video và âm thanh đi bằng biến thể chỉ-ghi-state của lời gọi action (`variant: "view-state"`, [#380](https://github.com/digitopvn/clarkcant/issues/380)): cùng một cổng kiểm tra, state có giới hạn được lưu và trả về, không dựng lại timeline, không đánh dấu snapshot lịch sử nào là đã cũ, và chỉ một dòng `action_invocations` cho mỗi binding dù media phát bao lâu. Gallery hay carousel đặt trong layout ghép hiển thị những ảnh người dùng đã nhập có mặt lúc layout được ghép (ảnh nhập sau đó chỉ xuất hiện trong một layout được ghép mới), và `media.select` (`{ selectedIndex }`) của nó có thể đưa vào một khoá state đã khai báo, nơi một lá media khác, `semanticState` của bề mặt và `inspect_ui` đọc được. Khoá đó giữ chỉ số được lưu, đếm từ 0; chỉ semantic summary riêng của widget mới đếm từ 1 (`selectedNumber`). Những giá trị này đi vào cùng semantic document mà voice, ghi chú lượt kế tiếp và `inspect_ui` dùng ([phát triển widget §8.11](widget-development.vi.md#811-widget-media-và-trạng-thái-semantic)). Khôi phục video sẽ mở lại đúng vị trí đã lưu và không bao giờ tự phát. Ghim giữ một chip gọn trên kệ; view state còn nguyên sau khi ghim và tải lại, và không có player được ghim chạy riêng. Node chưa nhập được video, nên video cục bộ chỉ phát được từ một tham chiếu mà host đã phục vụ sẵn.
  - Kiểm thử: [media-view.spec.ts](../packages/contracts/test/media-view.spec.ts), [playback-coalescer.spec.ts](../packages/conversation-client/test/playback-coalescer.spec.ts), [view-state-writes.spec.ts](../apps/runtime/test/view-state-writes.spec.ts), [state-only-writes.spec.ts](../packages/conversation-client/test/state-only-writes.spec.ts), [media-renderers.spec.ts](../packages/conversation-client/test/media-renderers.spec.ts), [widget-semantic.spec.ts](../apps/runtime/test/widget-semantic.spec.ts), và các journey Chromium trong [widget.spec.ts](../apps/web/e2e/widget.spec.ts): lựa chọn gallery qua `inspect_ui`, lựa chọn carousel qua ghi chú lượt kế tiếp, một lựa chọn bị từ chối ở cả hai, cả hai theme ở 390 px, state của carousel sau khi ghim rồi tải lại, và một video cục bộ được phát (đếm số lần ghi so với nhịp đồng hồ), bị từ chối một lần, pause, đọc lại qua `inspect_ui` rồi khôi phục ở trạng thái dừng sau khi ghim và tải lại. Journey video tự cung cấp bytes của clip cho đúng một tham chiếu đó. Media trong layout ghép: [compose-layout.spec.ts](../apps/runtime/test/compose-layout.spec.ts), [composition-graph.spec.ts](../apps/runtime/test/composition-graph.spec.ts) và journey trong [composition-graph.spec.ts](../apps/web/e2e/composition-graph.spec.ts) (chọn ảnh bằng bàn phím trong gallery ghép, carousel bên cạnh đi theo, đọc qua bề mặt live và `inspect_ui`, giữ nguyên sau khi tải lại, cả hai theme ở 390 px).
- **Ứng dụng mẫu A: trình soạn thảo văn bản mở và lưu một tệp thật** (#317, thuộc #200; mục 1 của định nghĩa hoàn thành). [`examples/reference-apps/text-editor`](../examples/reference-apps/text-editor) là một widget cách ly do ClarkCant cung cấp, có một facet UI, không có service và không xin quyền nào. Nó mở một tệp văn bản người dùng chọn qua `artifacts@1`, giữ bản nháp chưa lưu trong widget state (bản nháp quá lớn so với state được gắn cờ, không bao giờ bị cắt), và đưa ra *Giữ bản của tôi* hoặc *Dùng bản kia* khi một chỗ xem khác cũng đã đổi nó; một chỗ xem chưa mở tài liệu nào luôn nhận state của chỗ xem kia và không ghi gì cho đến khi một tệp được mở. Nó lưu một bản sao đã finalize qua chức năng xuất của host: trên máy tính thì ghi đè tệp gốc, trên web thì tải xuống; nó cũng có thể đính kèm một bản sao vào cuộc trò chuyện. Semantic document của nó mang tên tệp, số dòng, cờ chưa lưu, khoảng đang chọn và một đoạn trích văn bản đang chọn dài tối đa 200 đơn vị UTF-16. Nút `agent` riêng của nó, một binding có `contextRefs: ["selection", "widget"]`, nhờ Clark viết lại một đoạn chọn mà host chuyển đi nguyên vẹn (một dòng, không có ký tự ẩn hay khoảng trắng đặc biệt, không có gì host che vì có thể là thông tin riêng, tối đa 200 đơn vị); vì binding này đọc ngữ cảnh, host gửi semantic publish mới nhất của trình soạn thảo và chờ, tối đa 8 giây, đến khi node đã giữ nó rồi mới chạy lần bấm, còn nếu không được thì từ chối lần bấm kèm lý do nhắc thử lại, và câu trả lời, chỉ được nhận khi là đúng một khối có rào đã đóng, chỉ thay đổi văn bản khi người dùng chấp nhận và khoảng đã chọn vẫn còn đúng đoạn Clark đã đọc. Công cụ agent `place_widget` gắn nút đó khi Clark đặt trình soạn thảo kèm nút; nếu không có binding, nút bị tắt và hiện lý do. Trình soạn thảo cũng cho Clark thực hiện `replaceSelection` qua `actions.perform@1`, nên một yêu cầu gõ trong ô soạn tin có thể thay đoạn đang chọn qua `perform_widget_action`, và bị từ chối khi đoạn chọn không còn đúng đoạn Clark đã đọc. `clark widget init --template pure-ui` sao chép nó. Hướng dẫn chi tiết: [phát triển widget §24.1](widget-development.vi.md#241-trình-soạn-thảo-văn-bản).
  - Kiểm thử: [editor-core.spec.ts](../examples/reference-apps/text-editor/test/editor-core.spec.ts), [package.spec.ts](../examples/reference-apps/text-editor/test/package.spec.ts), [pure-ui-template.spec.ts](../packages/widget-cli/test/pure-ui-template.spec.ts), và hành trình trên trình duyệt [text-editor.spec.ts](../apps/web/e2e/text-editor.spec.ts): mở, sửa, tải lại, lưu và mở lại trên web; gõ tiếp trong lúc một lượt ghi bản nháp bị giữ lại, không có xung đột và không mất gì; ghi đè tệp gốc rồi mở lại, chỉ phần của trang, với một preload máy tính được mô phỏng (các hàm hỗ trợ của shell được kiểm thử đơn vị trong [file-bridge.spec.ts](../apps/desktop/test/file-bridge.spec.ts); IPC handler và hộp xác nhận của shell chưa được chạy tới); nhờ Clark qua model kịch bản, áp dụng câu trả lời rồi hoàn tác; chỉ dùng bàn phím; 390 px với cả hai giao diện khi bật giảm chuyển động; không có vị trí trên đĩa hay file handle nào trong lưu lượng bridge, được ghi ở cả hai chiều. [semantic-settle.spec.ts](../packages/conversation-client/test/semantic-settle.spec.ts) kiểm thử việc gửi publish đang chờ trước một lần bấm.
- **Ứng dụng tham chiếu: bảng tính** ([#318](https://github.com/digitopvn/clarkcant/issues/318), thuộc [#200](https://github.com/digitopvn/clarkcant/issues/200)). `examples/reference-apps/spreadsheet` là một package giao diện cách ly không có service: nhập và xuất CSV, TSV qua `artifacts@1` (TSV nay là một kiểu văn bản được chấp nhận), tải trong giới hạn kèm thông báo khi bị cắt, hàng và cột vẽ ảo, ô sửa được, chọn bằng bàn phím, cảm ứng và chuột với lưới là một điểm dừng Tab, một tập công thức đóng không chạy văn bản như mã và nêu tên tham chiếu vòng, vô hiệu hoá chèn công thức khi xuất CSV, một tài liệu ngữ nghĩa có giới hạn, và định dạng phần trăm do Clark áp dụng qua một binding `agent` mà widget kiểm câu trả lời với vùng đang chọn, vùng chọn bị khoá trong lúc Clark trả lời và định dạng hoàn tác được. XLSX không được hỗ trợ. Bảng tính cũng cho Clark thực hiện `format` qua `actions.perform@1`, nên một yêu cầu gõ trong ô soạn tin định dạng vùng đang chọn qua `perform_widget_action`, và `place_widget` gắn hành động đó cùng nút định dạng trong một bản cài thật ([phát triển widget §24.2](widget-development.vi.md#242-bảng-tính)). Khi nói thành lời lúc bảng tính đang mở, một yêu cầu không nói nhãn nào của nó, như “định dạng chỗ này thành phần trăm”, được chuyển cho lượt giọng nói của Clark cùng các hành động bảng tính cho phép làm dữ liệu, và được thực hiện qua cùng công cụ, chính sách và thẻ của host ([#444](https://github.com/digitopvn/clarkcant/issues/444)).
  - Kiểm thử: [unit test](../examples/reference-apps/spreadsheet/test/) của package, `clark widget test`, và các hành trình Chromium trong [spreadsheet.spec.ts](../apps/web/e2e/spreadsheet.spec.ts): nhập, sửa, xuất và nhập lại ra cùng giá trị, một vùng chọn được model fixture định dạng, một tệp vượt giới hạn được xoá trong một lượt, không đường dẫn nào trong lưu lượng bridge hay frame, và dùng bàn phím, cảm ứng và chuột ở cả hai giao diện tại 390 px. Unit test gồm cả checkpoint và tải lại với một host giả.
- **Ứng dụng tham chiếu: trình tạo ảnh** ([#319](https://github.com/digitopvn/clarkcant/issues/319), thuộc [#200](https://github.com/digitopvn/clarkcant/issues/200)). `examples/reference-apps/image-generator` có một facet giao diện cách ly và một facet service với capability `image.generate@1` chạy dưới dạng job: ô nhập mô tả, tiến độ của job đúng như service báo, nút Dừng, và thư viện các artifact kết quả mà người dùng có thể đính kèm hoặc xuất. Service gọi tới một origin nhà cung cấp đã khai báo qua egress của node, nơi node thêm key người dùng đã lưu; service, container của nó và widget không bao giờ giữ key. Việc bắt đầu một ảnh được khai báo là `external-write`, nên service có thể gửi nó bằng POST với prompt nằm trong body. Khi host mở `jobs.list@1`, widget liệt kê các job của chính nó, nên tải lại trang vẫn theo dõi đúng job đó (trên host cũ hơn, nó hiển thị các job được khởi chạy trong lúc nó đang mở và nói rõ điều đó); giọng nói bấm cùng nút ấy, và `invoke_capability` của Clark khởi động job qua widget trong cuộc trò chuyện để widget đó theo dõi. `clark widget init --template ai-generator | ui-with-service` sao chép ứng dụng này, với một origin nhà cung cấp giữ chỗ cần được thay. Nhà cung cấp là bản giả trong kiểm thử; nhà cung cấp thật là [#321](https://github.com/digitopvn/clarkcant/issues/321). `place_widget` đặt widget trong một bản cài thật với nút được gắn vào `image.generate@1` của chính package, bị tắt kèm lý do của node cho tới khi khoá được lưu ([#445](https://github.com/digitopvn/clarkcant/issues/445); [phát triển widget §24.3](widget-development.vi.md#243-trình-tạo-ảnh)).
  - Kiểm thử: [unit test](../examples/reference-apps/image-generator/test/) của package (service với nhà cung cấp giả qua job host: hoàn tất, tiến độ, thất bại, key bị từ chối, huỷ, key không xuất hiện ở đâu cả), [reference-templates.spec.ts](../packages/widget-cli/test/reference-templates.spec.ts), `clark widget test` và `pack`, và các hành trình Chromium trong [image-generator.spec.ts](../apps/web/e2e/image-generator.spec.ts): từ chối khi chưa có key, tiến độ qua một lần tải lại, thư viện ảnh, Dừng, nhà cung cấp báo lỗi, đính kèm và xuất, Clark, giọng nói, bàn phím, hai theme, 390 px và giảm chuyển động, với key được tìm trong trang, bridge, tệp và bảng của node và container của service.
- **Ứng dụng tham chiếu: trình dựng âm thanh** ([#320](https://github.com/digitopvn/clarkcant/issues/320), thuộc [#200](https://github.com/digitopvn/clarkcant/issues/200)). `examples/reference-apps/media-render` gồm một facet giao diện và một service chạy với `background-compute`: widget chọn tệp WAV theo tham chiếu, binding `render` của nó bắt đầu một job, và service đọc tệp từ node theo từng đoạn 256 KiB qua `clarkcant/artifacts.read` (capability nêu các trường chứa mã artifact trong `inputArtifacts`). Node từ chối tệp vượt giới hạn đầu vào của profile đã cấp trước khi gửi bất cứ gì; service từ chối đoạn dài hơn độ dài media của profile. Tiến độ là của service, huỷ không để lại tệp kết quả, frame tải lại theo dõi đúng job đó, và tệp đã dựng được xem trước dưới dạng sóng, đính kèm và lưu qua host. Khi profile bị từ chối, service không khởi động và widget hiện lý do. `clark widget init --template media-tool` bắt đầu từ package này. Clark đặt widget kèm nút Dựng qua `place_widget`, gắn với capability dựng của chính package (#445).
  - Kiểm thử: [unit test](../examples/reference-apps/media-render/test/) của package, [service-artifact-input.spec.ts](../apps/runtime/test/service-artifact-input.spec.ts), [media-tool-template.spec.ts](../packages/widget-cli/test/media-tool-template.spec.ts), `clark widget test`, và các hành trình Chromium trong [media-render.spec.ts](../apps/web/e2e/media-render.spec.ts). Hướng dẫn: [phát triển widget §24.4](widget-development.vi.md#244-trình-dựng-âm-thanh).

- **Đính kèm tệp đi tới được agent**: composer tải lên, bytes nằm trong blob store dùng chung (`dataDir/blobs`, content-addressed, `mode: 0o600`), quota tính theo principal, và loại tệp do **magic bytes** quyết định chứ không do đuôi tên. Prompt chỉ mang `att_…` opaque và **không bao giờ** có path; agent đọc nội dung qua tool của host `read_attachment(attachmentId)`, tool này không nhận tham số path nên không có đường nào mở tệp khác. Tin nhắn đã lưu là nguồn duy nhất — timeline và prompt là hai cách đọc cùng một dòng (`apps/web/e2e/attachments.spec.ts`; phần prompt được chứng minh ở ranh giới adapter bằng `FakePiAdapter.promptsFor()`).
- **Memory** (`memory_records`, migration 18) **không** phải một index tìm kiếm thứ hai. Xoá một memory xoá **đường inject** vào lượt sau — brief được đọc lại mỗi lượt chứ không cache trong tiến trình — còn tin nhắn gốc của người dùng vẫn nằm trong lịch sử hội thoại và vẫn nhìn thấy được. Vì vậy đây không phải hidden memory: mọi thứ được nhớ đều đọc được và xoá được ở tab Memory (`apps/web/e2e/memory.spec.ts`).
- **Cửa sổ desktop** vào tới client thật: `electron . -- --renderer-url <url> --data-dir <dir>`, CSP suy ra từ origin (chỉ cho phép đóng khung node và origin của app, để widget isolated tải được, và chỉ để nguyên policy riêng của tài liệu widget được đóng khung khi node phục vụ nó dưới `/frame/` kèm một policy không rỗng; mọi tài liệu được đóng khung khác cũng nhận thêm policy của cửa sổ), và một bridge có tên `getSession()` trả `{ baseUrl, token }` đọc từ `identity.json`. Token **không** đi vào argv hay URL, nơi nó sẽ nằm trong danh sách tiến trình và trong lịch sử trình duyệt.
- `?cc-compact=1` là **đường test-only** để browser suite chạm được thanh voice tối giản, không phải một tính năng. Đường thật vào trạng thái đó là cửa sổ thu nhỏ.
- **Widget Library và Widget Lab**: catalog widget dựng sẵn nay duyệt được từ Settings → Extensions (library) và Settings → Developer (Lab). Preview gọi chính `resolveRenderer` mà hội thoại dùng, nên nó là renderer đang chạy chứ không phải ảnh chụp, và definition thiếu renderer thì hiện lý do thay vì im lặng. Surface nằm **bên cạnh** hội thoại: mở nó không unmount composer. Package đã cài được liệt kê như **provenance** trên danh sách riêng (version, source tier, digest, trust lane) chứ không thành card trong catalog, vì không route nào expose widget definition của một package. Chi tiết ở [widget-development.md](./widget-development.vi.md) §23.
- **`canvas.table@1` làm đủ hợp đồng của nó** (vẫn là `@1` với state version 1, vì các prop mới đều không bắt buộc). Cột có thể khai báo nhãn, kiểu (`text`, `number`, `date`, `datetime`, `boolean`), định dạng (số chữ số thập phân, đơn vị, phần trăm) và căn lề. Bảng cũng nhận `pageSize` (5–200, mặc định 25), `rowIdField`, `selection` (`none`, `single` hoặc `multi`), `totals` (`sum`, `avg`, `min`, `max`, `count`) và `searchable`.
  - Một bộ hàm thuần trong `packages/contracts/src/table-view.ts` (`tableView`, `tableSemanticState`, `toCsv`) sắp xếp, tìm, lọc, chia trang và tính tổng các dòng. Trang web và node dùng chung bộ hàm này, nên file xuất ra chứa đúng những dòng người dùng đang xem.
  - Renderer có tiêu đề cột sắp xếp được bằng chuột và bằng Enter/Space, có `aria-sort`; ô tìm kiếm có nhãn; phân trang có nhãn ("Trang 2/7 · 153 dòng"); checkbox cho chọn nhiều dòng; dòng tổng; và định dạng số, ngày theo ngôn ngữ. Mỗi lần nó chỉ vẽ tối đa một trang dòng. Cột checkbox và cột đầu tiên được ghim ở mép đầu, phần còn lại cuộn ngang, và một vệt bóng đánh dấu phía còn cột. Chọn nhiều dòng giữ tối đa 64 dòng: khi chạm mức này, các checkbox còn lại bị vô hiệu và dòng trạng thái giải thích lý do. Dòng đã chọn mà bị tìm kiếm che đi vẫn được đếm, và nút **Bỏ chọn** xoá lựa chọn mà không cần tìm lại dòng đó.
  - `row.select` chỉ mang `{ rowIds }`. Khi dữ liệu không có `rowIdField` (và không có `id`), bảng dùng chỉ số trong dataset, và chỉ số này thay đổi khi dataset thay đổi. `tableSemanticState` báo điều đó bằng `stableIds: false`, nhưng hàm này chưa được nối vào semantic view của node (xem bên dưới).
  - **Xuất CSV** đi qua `POST /conversations/{id}/widgets/{instanceId}/export`, có xác thực và chỉ dành cho người dùng (person-only). Node đọc dòng từ chính `props.datasetRef` của instance; request chỉ mang khung nhìn (sắp xếp, tìm kiếm, bộ lọc, cột), không bao giờ mang dòng hay dataset id. Dòng được chọn dựa trên mọi cột mà bảng hiển thị, giống hệt trên màn hình. `columns` chỉ giới hạn file chứa những cột nào trong số đó. Khi node từ chối vì một lý do sẽ lặp lại, chẳng hạn dataset không còn, nút bị vô hiệu kèm lý do thay vì mời người dùng thử lại. Ô nào mà bảng tính sẽ chạy như công thức (`=`, `+`, `-`, `@`, tab, CR) đều được thêm tiền tố `'`. Snapshot chỉ đọc, và bảng nằm trong một bản xem ghép, hiện nút xuất bị tắt kèm lý do.
  - Test: `packages/contracts/test/table-view.spec.ts`, `packages/conversation-client/test/table-model.spec.ts`, `apps/runtime/test/table-export-route.spec.ts`, và hành trình trình duyệt `apps/web/e2e/table-contract.spec.ts`.
  - **Chưa có:** sắp xếp, trang, từ khoá tìm và lựa chọn do client giữ (theo từng instance, trong vòng đời của trang) và **chưa được lưu trên node**. Những gì bề mặt cần giữ, chẳng hạn các dòng người dùng đã chọn, được giữ bằng cách nối `row.select` vào đồ thị state của bề mặt (ở trên). Semantic view của bảng phía node chưa dùng `tableSemanticState`.

**Chưa có (deferred, không được claim là đã xong):**

- `isolated-app` và `mcp-app`: sandbox policy/registry có code và test, nhưng **renderer runtime cho app cách ly chưa được chứng minh**. Không có app runtime trong repo.
- Google Calendar connector và custom iframe mini-app nằm ngoài M1. Phê duyệt một bước của workflow chỉ chạy riêng bước đó chứ không tiếp tục workflow.
- Bảng family coverage trong §4 vẫn là đích đến của release gate: repo hiện có test cho các family mà composed surface cần (`metrics`, `filter`, `trend`, `calendar`, `media`, `cta`, `tables`, `layout`), không phải cho toàn bộ danh sách.

- **Nội dung tệp tới agent**: tệp văn bản đi vào prompt của lượt (`attachmentBrief` chèn nội dung, `read_attachment` đọc lại theo id), **PDF được trích văn bản** bằng `apps/runtime/src/pdf-text.ts` (không thêm dependency), và hai journey chứng minh câu trả lời **dùng** nội dung đó — một cho tệp văn bản, một cho PDF ([attachments](../apps/web/e2e/attachments.spec.ts)). **Ảnh được giao như một ảnh**: `read_attachment` trả `{ type: "image", data, mimeType }` và `toSdkTool` chuyển nguyên block đó cho SDK, nên model nhận chính bức ảnh thay vì một câu mô tả nó. Hai test giữ điều đó: một ở seam adapter (`packages/pi-adapter/test/pi-adapter.spec.ts`, "hands the image to the SDK as an image block, not as a sentence about one") và một ở tool (`apps/runtime/test/read-attachment-tool.spec.ts`, "hands a picture over as a picture rather than describing it").
- **Lưu giữ hội thoại**: nói “xoá hội thoại này”, hoặc dùng `POST /conversations/{id}/delete` trên bề mặt của người dùng. Policy thực thi quyết định chạy, hỏi hay từ chối. Tệp đính kèm, tệp widget và các row của hội thoại được xoá trong cùng một transaction, vẫn bật foreign key. Tệp vật lý chỉ được xoá sau commit; byte dùng chung được giữ, tệp đang khoá được xếp hàng dọn lại. Công việc chưa kết thúc chặn việc xoá. Không giữ bản sao để Hoàn tác; bộ nhớ đã lưu, tài nguyên độc lập, nhật ký phiên và lịch sử kiểm toán vẫn còn. Xem [giao diện mở](open-interfaces.vi.md#xoá-hội-thoại).

Cả hai cổng này chạy trong CI: job `e2e` chạy browser suite, và job `desktop smoke (xvfb)` chạy
`electron . --smoke-test` dưới `xvfb-run` (thêm ở PR #44). Evidence của cửa sổ vì thế không còn phụ thuộc vào một
lần người vận hành chạy. Lần chạy đầu của hai job đó tìm ra hai lỗi thật và cả hai đã được sửa ở gốc: Electron
không khởi động được vì sandbox SUID không cấu hình được trên runner, và một journey bàn phím lấy focus khi
panel còn đang hiện nên `focus()` bị bỏ.

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

**Những gì node chạy hôm nay** (#314): mỗi binding mang các giới hạn được kẹp vào trần khi biên dịch (deadlineMs, maxTokens, maxCallsPerMinute); ngữ cảnh của binding agent do host đọc, được đo theo ngân sách token trước mọi lần gọi model, và chỉ được đưa cho model như một phần dữ liệu riêng đã được làm trơ, không bao giờ như chỉ dẫn; cuộc gọi không phải đọc được ghi vào sổ effect trước khi gửi, và cuộc gọi đã gửi mà không có câu trả lời đáng tin thì được báo là chưa chắc chắn, trở thành effect chưa rõ (chỉ có câu hỏi trong hộp thư khi sổ đã ghi được nó, kể cả khi node chết giữa cuộc gọi) và không bao giờ được thử lại; và mỗi invocation id giữ một kết quả kể cả qua khởi động lại. Workflow chỉ gọi capability của một package, dừng ở bước đầu tiên không hoàn tất, nêu tên bước đó, và không tuyên bố rollback cho các bước trước nó. Chi tiết, giới hạn và dạng phản hồi nằm ở [Widget development §8.1](widget-development.vi.md#81-nút-hành-động-chung-canvasaction1).

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
actions.invoke(boundActionId, validatedInput)  # resolve với output của service
actions.availability / actions.subscribe(handler)  # action nào có service phía sau chạy được, và vì sao không
actions.offer(name, handler)  # thực hiện một hành động được cho phép khi Clark yêu cầu (actions.perform@1)
capabilities.request(requestedCapability)  # opens host consent, not grants itself
host.focus / host.resize(request) / host.requestPin
host.openExternal(approvedUrl)
semantic.publish(summary, selectedIds, values?)  # chỉ là đề xuất; action lấy từ binding của instance
artifacts.pick / read / create / write / finalize  # tệp theo tham chiếu (artifacts@1), kiểm tra lại mỗi lần dùng
artifacts.export / attachToConversation  # Lưu thành… của host và ô soạn tin; người dùng quyết định
artifacts.discard  # bỏ một tệp do chính instance này tạo
jobs.get / subscribe / cancel / list  # job của package theo JobRef (jobs@1), kiểm tra lại mỗi lần dùng
lifecycle.onMount / onSuspend / onResume / onDispose
```

`requestPin` là proposal trừ khi originated trực tiếp từ user gesture đã rõ. SDK không có `readAllSecrets`, `shell`, `queryCoreDb`, `disableCSP`, `approve`, `installAnything` hoặc `registerSidebar`.

Widget nhận diện mạo công khai đã kiểm tra qua `appearance.current()` / `appearance.subscribe(handler)`
(`appearance@1`, bridge v2). Built-in và Mini App khai báo dùng cùng token semantic; iframe cách ly nhận thay đổi mà
không mount lại hay ghi semantic. Composition tách cửa sổ nhận đúng snapshot đã phân giải của host qua relay chỉ đọc,
không nhận thông tin xác thực hay truy vấn theme. Định nghĩa mặc định thích ứng và có thể khai báo
`appearanceMode: "fixed"`, được ghi rõ trong Lab/chi tiết và kết quả marketplace khi directory cung cấp khai báo.
Nội dung lịch sử, props, state, nguồn gốc và văn bản dự phòng giữ nguyên; giảm chuyển động luôn được ưu tiên ở cả hai
chế độ. Xem [API tác giả và quy tắc tương thích](widget-development.vi.md#diện-mạo-appearance1).

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

Unsafe HTML/SVG/Markdown sanitize; Mermaid là một tập con flowchart được phân tích trên host thành mô hình `canvas.diagram@1`, không bao giờ được Mermaid dựng, và mọi thứ cấu hình renderer của nó đều bị từ chối; no script callbacks from agent props. Dataset/attachments qua opaque refs, no arbitrary paths, executable URLs, SQL hay CSS property injection.

Tệp cũng theo đúng quy tắc đó (`artifacts@1`, [widget-development.vi.md §10.1](widget-development.vi.md#101-tệp-theo-tham-chiếu-artifacts1)). Một widget cách ly giữ một `ArtifactRef`, không bao giờ giữ đường dẫn. Ref là con trỏ, không phải quyền: node kiểm tra lại mỗi lần đọc, ghi, lưu ra và đính kèm, đối chiếu với chủ sở hữu, grant của instance (có hạn và thu hồi được) và trạng thái của artifact. Chọn tệp và lưu bản sao là giao diện của host, nằm ngoài frame. Trên desktop, chúng dùng hộp thoại gốc của hệ điều hành; trên web, chúng dùng ô chọn tệp và một lượt tải xuống. Ghi đè tệp gốc chỉ có trên desktop. Các byte đi qua các bước dò kiểu, danh sách cho phép, giới hạn kích thước và hạn mức của luồng đính kèm, và mỗi đoạn tối đa 256 KiB. Một instance giữ tối đa 128 MiB trong 1 GiB của người dùng, các yêu cầu tệp của một frame bị giới hạn tốc độ, và widget chỉ bỏ được tệp do chính nó tạo. Tham chiếu ngữ cảnh `artifact:` của một nút agent được đọc theo cùng quyết định như widget được bấm và tới model dưới dạng tên, kiểu và kích thước của tệp, cùng một đoạn trích ngắn được đánh dấu là dữ liệu nếu là văn bản. Một widget có thể tự vẽ nút "chọn tệp" trong frame, nhưng vẫn không nhận được gì cho tới khi người dùng trả lời lời nhắc của host.

Công việc chạy lâu của package cũng theo quy tắc đó (`jobs@1`, [widget-development.vi.md §10.2](widget-development.vi.md#102-job-chạy-lâu-jobs1)). Một capability khai báo `execution: { kind: "job", version: 1 }` trả lời một lần bấm bằng một JobRef và chạy tối đa 30 phút dưới job host của node. JobRef là con trỏ, không phải quyền: mỗi lần đọc và huỷ đều được kiểm tra lại theo principal, instance, binding của nó, package generation mà binding đó được cấp quyền, và capability; mọi trường hợp khác bị từ chối như thể job không tồn tại. Tiến độ chỉ là những gì service báo qua MCP, tệp kết quả là `ArtifactRef`, việc dừng nó từ danh sách công việc, Dừng khẩn cấp và việc tắt node huỷ job kèm lời cảnh báo "may already have completed its effect" (nút Dừng của hội thoại để nó chạy tiếp, giống các công việc nền khác), khởi động lại đánh dấu job thất bại thay vì chạy lại, và câu hỏi của policy được trả lời trên thẻ phê duyệt của host trước khi job bắt đầu, không bao giờ bởi widget.

## 9. Frontend credentials: ngoại lệ phải thiết kế đúng

“Không gửi secrets tới renderer” cần phân biệt loại credential. API secret, refresh token, node private key không đi vào renderer/model. Một số playback/call SDK cần **short-lived scoped access/session token ở browser**. Khi vậy, auth broker chỉ cấp token phù hợp cho isolated widget origin/session đã consent, TTL ngắn nếu provider hỗ trợ, không đưa vào props, persisted state, logs hoặc conductor context.

Không giả token nào cũng scope/expire được theo ý app: adapter ghi chính xác provider hỗ trợ gì. Nếu token quyền quá rộng và SDK đòi browser thì nêu risk/thiết kế fallback. Uninstall/revoke ngừng refresh và thu hồi khi API hỗ trợ; không hứa đã thu hồi mọi access token ngay khi vendor không có cơ chế đó.

**Node chạy gì hôm nay.** Service không bao giờ giữ key của nhà cung cấp: container của nó không có mạng, và nó nhờ node gửi request tới một origin mà package đã khai báo (`clarkcant/egress.fetch` qua kết nối MCP). Node gắn key mà người dùng đã lưu cho package đó, không đi theo redirect, và ghi audit request chỉ bằng tên secret. Node chỉ trả lời khi đang có một lần gọi tới service, chỉ cho `GET` và `HEAD` trừ khi một lần gọi đang chạy được quyết định là ghi ra bên ngoài hoặc rủi ro hơn, không trả lời gì khi một lần gọi giữ tệp của người dùng đang chạy trừ khi lần gọi đó được quyết định là ghi ra bên ngoài hoặc rủi ro hơn, giới hạn tốc độ cho từng service, từ chối origin loopback và mạng riêng trừ khi node được khởi động với `CC_EGRESS_ALLOW_PRIVATE_NETWORK=1`, và thay key bằng `[redacted]` trong kết quả trả về, ở các dạng mã hóa thường gặp, như một lớp bảo vệ ở mức cố gắng tối đa. Câu hỏi cài đặt, thẻ thư mục và chi tiết package liệt kê các origin, tên key và nhà cung cấp token trình duyệt mà package khai báo; artifact khai báo phạm vi khác với mục trong thư mục sẽ bị từ chối. Khi key chưa được lưu, các capability của package được báo là chưa đăng nhập. Frame chỉ nhận token trình duyệt qua `tokens@1`, chỉ cho nhà cung cấp và scope mà package đã khai báo, và chỉ khi node có adapter cấp được token có phạm vi, ngắn hạn cho chúng; request bị từ chối chứ không bao giờ bị thu hẹp. Token gắn với một lần mount của frame, được thu hồi khi frame bị gỡ nếu nhà cung cấp hỗ trợ, không bao giờ được node lưu, và bị từ chối, như một lớp bảo vệ ở mức cố gắng tối đa, nếu widget chuyển nó nguyên dạng vào state, semantic publish, action, artifact hay liên kết bên ngoài. ClarkCant chưa kèm adapter cho nhà cung cấp nào, nên node không có adapter sẽ trả lời `TOKEN_PROVIDER_UNAVAILABLE`. Chi tiết và mã lỗi: [widget development §14.2 và §14.3](widget-development.vi.md#142-service-gọi-tới-nhà-cung-cấp).

**Tài khoản mà service làm việc trên đó.** Một package có thể khai báo một `connection` tài khoản (OAuth authorization code với PKCE, client id công khai, các scope kèm mục đích, các endpoint được dùng tài khoản đó, và một probe), và mỗi capability nêu các scope nó cần. Người dùng kết nối từ Settings trong trình duyệt hệ thống; node giữ token trong bảng riêng của nó, tự thêm access token vào các request egress của service chỉ tới các endpoint đó, làm mới token, và thu hồi khi người dùng bấm Revoke hoặc gỡ package. Widget chỉ thấy trạng thái và, khi một capability chưa sẵn sàng, lý do: chưa kết nối, đã hết hạn, đã bị thu hồi, hoặc scope nào tài khoản chưa cấp. Binding của widget, Clark và giọng nói vẫn đi tới cùng một capability qua cùng policy và audit trail. Ứng dụng kết nối mẫu và fake connector của nó, một fixture kiểm thử, chứng minh điều này trong repository; nhà cung cấp thật sẽ đến sau #333. Chi tiết: [widget development §14.6](widget-development.vi.md#146-kết-nối-tài-khoản).

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
  "schemaVersion": 2,
  "id": "example.calendar-pack",
  "version": "0.2.0",
  "displayName": "Calendar pack",
  "description": "A week view with a calendar connector behind it.",
  "hostApi": { "min": 1, "max": 1 },
  "facets": [
    {
      "kind": "tools",
      "id": "example.calendar-pack.connector",
      "entry": "dist/connector.mjs",
      "isolation": "service",
      "protocol": "mcp-stdio",
      "capabilities": [
        {
          "tool": "list_events",
          "ref": "example.calendar-pack.events.list@1",
          "summary": "List events in a date range",
          "effectCategory": "read"
        }
      ]
    },
    {
      "kind": "ui",
      "id": "example.calendar-pack.week@1",
      "entry": "dist/widget/index.html",
      "definition": "dist/widget/widget.json",
      "isolation": "isolated-ui"
    },
    { "kind": "skills", "id": "example.calendar-pack.skills", "entry": "skills/", "isolation": "declarative" },
    { "kind": "setup", "id": "example.calendar-pack.setup", "entry": "setup/calendar.json", "isolation": "declarative" }
  ],
  "requestedCapabilities": ["widget.state.write@1"],
  "permissions": { "networkOrigins": [], "filesystem": [], "microphone": false, "camera": false, "lifecycleScripts": [] },
  "platforms": ["linux-x64", "linux-arm64", "darwin-arm64"]
}
```
Dạng của manifest là `packageManifestSchema` (`packages/contracts/src/install.ts`). [Widget development §4](widget-development.vi.md#4-package-manifest) liệt kê lane mà mỗi loại facet chạy trong đó và các quy tắc reader áp dụng. Capability của service facet được khai báo ngay trong manifest, nhờ vậy màn hình đồng ý hiển thị được chúng trước khi bất kỳ đoạn code nào chạy. Việc cài package chính là sự đồng ý với các capability đó, và mỗi lời gọi vẫn do execution policy quyết định. Node chạy service facet của mỗi generation đang active trong một container Docker hoặc Podman, đăng ký các capability đã khai báo với readiness mà nó quan sát được, và gọi chúng qua một đường host duy nhất dùng chung cho widget, agent và voice. Node không có engine thì không chạy service. Không có fallback chỉ chạy process. [Widget development §4](widget-development.vi.md#4-package-manifest) là nơi mô tả ranh giới và những gì chưa xây.

Một facet `instructions` (khai báo, `"schemaVersion": 3`, tối đa một facet mỗi package) mang các quy tắc hướng dẫn có điều kiện theo hợp đồng hướng dẫn của dự án. Việc cài package không áp dụng quy tắc nào: người dùng bật hướng dẫn của một package theo từng dự án, bên trong một root đã được cấp, và Clark chỉ có thể đề nghị việc đó qua `manage_package`, do execution policy quyết định. Quy tắc riêng của dự án được ưu tiên trước, các đoạn hướng dẫn của package dùng chung một phần ngân sách có giới hạn của mỗi lượt, và mỗi đoạn được bao như dữ liệu, bị giữ lại khi vượt quá các lớp dữ liệu của model, được gắn nhãn và ghi audit kèm id và phiên bản của package. Gỡ package sẽ tắt hướng dẫn của nó ở mọi nơi ([open interfaces: package instructions](open-interfaces.vi.md#package-instructions)).

Manifest là proposal metadata của package; tự nó không cấp các host capability mà package yêu cầu. Install record bổ sung resolved versions/digests, transitive dependencies, target node, auth/data recipients và approved grants. Fields có schema strict, no arbitrary lifecycle script auto-run.

Pi-compatible facets có thể đóng extension/skills/prompts/themes theo manifest upstream, nhưng app lifecycle riêng không được gọi là Pi official API [R02–R04]. Facets độc lập giúp update UI không restart Pi; update skill có thể reload resources; connector tool service có thể restart riêng. Chord là P0 candidate cho composition implementation, không security/federation shortcut [R05].

## 12. Resource limits và accessibility

Initial targets (phải đo): ordinary catalog spec ≤256 KiB; lazy mount heavy widgets; per-app CPU/memory/frame budgets; bounded logs/network/API rate; datasets lớn pagination/downsampling có nhãn. Không auto-limit rich widget thành vô dụng, nhưng một chart không được freeze composer.

Offscreen widgets suspend rendering/subscriptions theo loại; active user-authorized player/call có exception và clear indicator. Stalled widget có timeout/error boundary/text fallback, không crash chat. Text alternatives, keyboard controls, reduced motion, contrast, focus restore và không focus-steal là release gates.

State chia rõ client view, durable instance state và external service truth. Giá trị optimistic chỉ là pending; không hiện “đã gửi tin” trước provider ack/verification.

**Node chạy gì hôm nay.** Package nêu tên một resource profile (`interactive-light`, `interactive-heavy`, `media-workstation` hoặc `background-compute`), không bao giờ nêu con số. Node sở hữu bảng giá trị, áp nó vào bộ nhớ, CPU, số tiến trình và `/tmp` của container service, hạn chót của mỗi lần gọi và mỗi job, và số job chạy đồng thời của job host, và giữ mọi profile không có mạng. `interactive-light` là mặc định và khớp từng giá trị với giới hạn mà service đã chạy trước khi có profile. Profile bị execution policy từ chối, hoặc lớn hơn mức container engine chứa được, khiến package ở trạng thái degraded kèm lý do trong chi tiết package; nó không bao giờ bị thay bằng profile nhỏ hơn, và không bao giờ cấp GPU. Chỉ frame được cấp `media-workstation` mới có nút gạt trong chrome của host để giữ frame được mount khi ra khỏi màn hình, nút này tắt sẵn cho mỗi lần mount mới. Podman rootless không được ủy quyền controller cgroup không áp giới hạn bộ nhớ và CPU; node nói rõ điều đó thay vì tuyên bố đã áp. Profile cũng giới hạn tệp mà widget giao cho service (từ 8 MiB tới 25 MiB) và độ dài media mà service được báo là nhận; manifest nêu các trường tham số chứa tệp (`inputArtifacts`), không bao giờ nêu kích thước, và service đọc các tệp đó từ node theo từng đoạn, trong hạn mức đọc của mỗi lời gọi, không có đường dẫn; chỉ lần nhấn trong cuộc trò chuyện đang giữ tệp mới giao được tệp, và trong lúc lời gọi giữ tệp đang chạy, egress của service bị từ chối trừ khi lời gọi đó được quyết định là ghi ra bên ngoài hoặc rủi ro hơn ([§14.4](widget-development.vi.md#144-tệp-mà-service-đọc)). Bảng và thứ tự quyết định: [widget development §14.1](widget-development.vi.md#141-resource-profile).

**Bản cập nhật hiện gì trước khi được áp dụng.** Listing nêu profile mà một phiên bản yêu cầu trong `resources` (không có nghĩa là `interactive-light`, và `clark widget publish` chỉ ghi trường này cho profile khác hoặc khi xin GPU) bên cạnh `declaredReach`, và cả hai đều ràng buộc: artifact yêu cầu hoặc khai báo khác đi bị từ chối với `DECLARED_REACH_MISMATCH`. Thông báo cập nhật package, và câu hỏi cài đặt mà bản cập nhật tạo ra khi chế độ thực thi hỏi trước, liệt kê những gì bản mới thêm hoặc bỏ so với phạm vi tiếp cận của bản đang cài: origin, key, các origin mà mỗi key được gửi tới, scope token trình duyệt, scope và endpoint tài khoản, yêu cầu GPU, và từng giới hạn của profile có đổi, kèm cả hai giá trị. Các profile không được xếp hạng; bất kỳ mục được thêm hay giới hạn được nâng nào cũng khiến thay đổi là `wider`, nên chuyển một key sang origin khác là `wider`. Khi không so sánh được hai bản, thông báo nói rõ điều đó thay vì không hiện gì. Nó giúp quyết định chứ không quyết định gì: execution policy quyết định bản cập nhật như mọi lần cài. Chi tiết: [widget development §14.2](widget-development.vi.md#142-service-gọi-tới-nhà-cung-cấp).

## 13. Conformance tests

Catalog/iframe đều phải pass: malformed props reject; unknown action reject; forged grants fail; stale account/version binding fail; voice/click same outcome; double click dedup; reopen no effect; pin no duplicate media; unpin preserve note; reinstall preserves compatible state; auth revoked disables protected actions; custom widget cannot read host storage/secret; microphone off actually ends capture.

MCP App test dùng reference fixture và exact negotiated spec. Features SDK không hỗ trợ hoặc browser permissions không cho thì fallback rõ, không silently pretend mounted means functional.

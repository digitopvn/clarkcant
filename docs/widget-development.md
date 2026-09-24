# ClarkCant Widget Developer Standard

> Trạng thái: canonical authoring target cho widget ecosystem.
> Cập nhật: 2026-09-19.
> Áp dụng cho built-in catalog, declarative compositions, isolated widgets và MCP Apps.

## 1. Mục tiêu

Một người mới phải có thể đi từ ý tưởng tới widget chạy local bằng một template, test được mọi trạng thái quan trọng, rồi publish lên directory mà không cần hiểu runtime internals của ClarkCant.

Developer mental model chỉ gồm:

1. **Definition** — widget này là gì, props/state/events/capabilities nào.
2. **View** — UI hiển thị thế nào.
3. **Actions** — local state hay effect qua host.
4. **Semantic view** — Clark/voice hiểu widget đang có gì và làm được gì.
5. **Package** — cách preview, test, version và publish.

Host chịu trách nhiệm identity, secrets, action authorization, live ownership, sandbox, pin/detach, lifecycle và provenance.

---

## 2. Trust lanes

### Built-in catalog

Trusted code ship cùng client. Dùng khi component là primitive chung của sản phẩm.

### Declarative composition

Không executable payload. Ghép built-ins bằng spec. Đây là lựa chọn mặc định khi UI có thể biểu đạt bằng catalog hiện có.

### Isolated widget

Executable third-party/user UI. Chạy trong isolated origin/frame, chỉ giao tiếp qua Widget SDK.

### MCP App

Dùng adapter MCP Apps khi package đã tồn tại trong ecosystem đó; vẫn phải tuân host isolation, lifecycle và action semantics của ClarkCant.

Không chuyển một isolated widget thành native Pi extension chỉ để lấy quyền dễ hơn.

---

## 3. Package layout

Target convention:

    my-widget/
      package.json
      clarkcant.json
      README.md
      LICENSE
      widgets/
        main/
          index.html
          widget.json
      fixtures/
        default.json
        empty.json
        error.json
        compact.json
      previews/
        cover.webp
        demo.mp4
      test/
        widget.spec.ts

Một package có thể có nhiều facets:

- widgets;
- compositions;
- tools/services;
- skills;
- recipes;
- themes.

UI facet phải update/activate độc lập khỏi Pi worker khi không có facet Pi thay đổi.

---

## 4. Package manifest

Target root manifest:

    {
      "schemaVersion": 1,
      "id": "com.example.calendar",
      "version": "1.2.0",
      "displayName": "Calendar Plus",
      "description": "A compact agenda and week view.",
      "hostApi": { "min": 1, "max": 1 },
      "facets": [
        {
          "kind": "widget",
          "id": "com.example.calendar.week@1",
          "entry": "widgets/main/index.html",
          "definition": "widgets/main/widget.json",
          "isolation": "isolated-ui"
        }
      ],
      "requestedCapabilities": [],
      "permissions": {
        "networkOrigins": [],
        "filesystem": [],
        "microphone": false,
        "camera": false,
        "lifecycleScripts": []
      },
      "platforms": ["darwin-arm64", "linux-x64", "win32-x64"],
      "publisher": {
        "id": "example",
        "sourceUrl": "https://github.com/example/calendar-plus",
        "license": "MIT"
      }
    }

Manifest là request metadata, không tự cấp quyền.

Version, source artifact và digest mà host cài phải immutable trong một generation.

---

## 5. Widget definition

Mỗi widget definition phải khai báo:

- stable id + semantic version;
- renderer lane;
- props JSON Schema;
- event schemas;
- state schema + stateVersion nếu có durable state;
- `ephemeralStateKeys` — các key chỉ là view state (filter, zoom, lựa chọn): host bỏ chúng trước khi ghi xuống
  node. Key không khai báo là state bền; quên khai báo thì không mất dữ liệu;
- `stateMigrations` — các bước khai báo `{from, to, ops}` (op: `rename`, `default`, `remove`, `map`) từ mỗi
  `stateVersion` cũ lên bản kế tiếp, do host chạy;
- semanticDescription;
- requested capabilities;
- compact/expanded support và minimum height;
- text fallback;
- effect categories;
- dataset refs;
- entry artifact cho executable UI.

Không dùng props như một kênh truyền code, callback, HTML tùy ý, secret hoặc arbitrary URL.

---

## 6. Sizing contract

Mỗi widget phải test ít nhất:

- narrow: 320 px;
- conversation: khoảng 720–840 px;
- compact pin;
- expanded;
- detached host window nếu support.

Không assume viewport height.

Không bắt parent page scroll ngang. Horizontal scrolling chỉ được dùng bên trong vùng dữ liệu mà reflow sẽ làm mất ý nghĩa, ví dụ table/diff.

Widget resize gửi **request** qua host, không tự resize Electron window.

---

## 7. Required UI states

Mọi widget phải có explicit fixtures cho:

- loading;
- empty;
- live;
- cached;
- offline;
- partial/unavailable;
- error;
- read-only snapshot;
- action pending;
- action refused/failed;
- compact;
- expanded.

Không dùng blank frame làm loading hoặc error.

Không giữ stale rows dưới nhãn live khi refresh fail.

---

## 8. Actions

Phân biệt cứng:

### Local view action

Không external side effect:

- select;
- filter;
- sort;
- zoom;
- expand;
- tab;
- playhead.

Đi qua local state/state.update.

### Effect action

Có thể thay đổi host/external state:

- capability invoke;
- agent intent;
- workflow;
- install/connect;
- write.

Đi qua host action binding. Widget không gọi tool bằng tên tự bịa.

Mọi effect invocation cần:

- actionBindingId;
- expected revision;
- validated input;
- unique invocationId;
- pending/settled UI;
- double-click dedup.

Label phải mô tả operation thật. Không dùng “Continue” cho destructive effect.

---

## 9. Semantic contract cho voice

Widget phải publish semantic view khi state actionable thay đổi:

- summary;
- selected IDs;
- available actions;
- concise text representation.

Voice và click phải gọi cùng action binding/state path.

Không publish raw DOM, hidden text, full dataset hoặc secret chỉ để voice “hiểu màn hình”.

Example:

    semantic.publish({
      summary: "Calendar for September 2026; September 20 selected.",
      selectedIds: ["2026-09-20"],
      availableActions: [
        { actionBindingId: "act_create_event", label: "Create event" }
      ]
    })

---

## 10. Widget SDK surface

Author-facing target:

    props.read()
    props.subscribe()

    state.get()
    state.update(expectedRevision, patch)

    events.emit(name, payload)

    actions.invoke(bindingId, input, invocationId)

    capabilities.request(ref, justification)

    host.focus()
    host.resize({ height })
    host.requestPin()
    host.requestDetach()
    host.openExternal(approvedUrl)

    semantic.publish(summary, selectedIds, availableActions)

    lifecycle.onMount()
    lifecycle.onSuspend()
    lifecycle.onResume()
    lifecycle.onDispose()

Không expose:

- readAllSecrets;
- shell;
- generic IPC;
- queryCoreDb;
- disableCSP;
- approve;
- grant;
- installAnything;
- registerSidebar;
- arbitrary host window access.

---

## 11. Pin / detach lifecycle

Pin và detach trỏ tới **cùng logical instance**.

Một instance chỉ có một live effect owner.

Các surface còn lại:

- historical inline snapshot; hoặc
- read-only preview.

Detach không reset state/subscription/media.

Close detached window chỉ chuyển presentation ownership; không xóa instance.

Audio/call/player không được duplicate playback khi chuyển surface.

---

## 12. Motion

Widget dùng host design tokens thay vì tự tạo motion language xung đột.

Rules:

- press feedback dưới 100 ms;
- transition targeted properties, không transition: all;
- mild bounce chỉ ở settle/end-state;
- prefers-reduced-motion phải có static equivalent;
- no infinite decorative animation offscreen;
- hover không phải cách duy nhất để thấy action;
- widget không được làm Orb/global chrome đổi hiệu ứng nếu user chưa cấp theme/personalization scope.

Executable widget không được inject global CSS.

---

## 13. Accessibility

Release gate:

- semantic HTML;
- keyboard-only path;
- visible focus;
- 40–44 px target cho primary touch actions;
- state không chỉ bằng màu;
- text alternative cho rich visual;
- aria-live bounded, không stream token spam;
- focus restore khi close sub-surface;
- chart/table selection usable không cần pointer;
- reduced motion;
- contrast theo host tokens.

---

## 14. Data & network

Dataset lớn đi qua opaque refs.

Không đưa:

- file:// path;
- DB query;
- bearer token;
- host cookie;
- long-lived secret

vào props/state/history.

Executable widget chỉ connect tới origins trong installed manifest/CSP.

Nếu auth SDK cần browser token, host broker cấp token ngắn hạn/scoped nếu provider thực sự hỗ trợ; token không persist trong widget state.

---

## 15. State & migration

State có:

- stateVersion;
- optimistic revision;
- deterministic migration.

State bền của widget cách ly nằm trong SQLite của node, không nằm trong frame. Widget ghi bằng
`state.update(expectedStateRevision, patch)`; host bỏ `ephemeralStateKeys`, kiểm `stateSchema` và kích thước,
kiểm revision lạc quan, và chỉ báo thành công khi node đã commit. Xung đột trả `STALE` và widget giữ bản nháp.
Revision của state khác revision của instance; không dùng lẫn.

Upgrade không được silently drop draft.

Migration là khai báo và do host chạy: khi mở một instance có `stateVersion` cũ hơn definition, host chạy các
bước `stateMigrations` trong một transaction rồi kiểm kết quả theo `stateSchema`. Code của widget không bao giờ
chạm vào state chưa qua kiểm tra. Không có migrate xuống: state mới hơn definition (sau khi quay về bản trước)
mở ở chế độ chỉ đọc kèm lý do.

Nếu migration fail:

- giữ snapshot;
- disable mutation;
- đưa recovery choice.

Uninstall presentation facet không tự xóa domain data của user. Gỡ package chỉ thôi kích hoạt generation đang
chạy: instance chuyển offline với text fallback, state và snapshot được giữ. **Khôi phục** kích hoạt lại đúng
generation vừa gỡ; **Quay về** kích hoạt generation bị thay gần nhất. Cả ba đi qua cùng một action từ
Settings, chat và voice.

---

## 16. Developer CLI target

    clark widget init
    clark widget dev
    clark widget test
    clark widget pack
    clark widget publish

### init

Templates:

- blank;
- dashboard;
- form;
- editor;
- media;
- MCP App adapter.

### dev

Local isolated host có:

- hot reload;
- fixtures;
- viewport switcher;
- dark/light/system;
- reduced-motion;
- online/offline;
- read-only/live;
- semantic inspector;
- action log;
- capability simulator;
- accessibility checks.

`clark widget dev [dir] [--port N] [--builtin <id>]`: không có `[dir]` thì lấy thư mục hiện tại, và
`--builtin <id>` xem một widget của catalog trong **cùng** host đó thay vì một package trên đĩa — chi tiết ở 23.5.

### test

Chạy conformance suite.

### pack

Validate manifest, build immutable artifact, generate digest + metadata.

### publish

Publish package source/artifact rồi submit directory metadata. Directory không phải nơi duy nhất package có thể chạy: local/git source vẫn là first-class development path.

Trước khi ghi entry, publish so các definition với lần chuẩn bị trước (`dist/published-definitions.json`) và
từ chối version vi phạm quy tắc ở §20.

---

## 17. Conformance suite

Widget không publish-ready nếu thiếu các test sau:

### Schema

- malformed props reject;
- additional props reject khi schema cấm;
- state version valid;
- unknown event/action reject.

### Security

- forged nonce/source reject;
- secret unavailable;
- generic host API unavailable;
- undeclared network blocked;
- untrusted host-owned card impossible.

### Lifecycle

- mount;
- suspend/resume;
- dispose cleanup;
- reopen;
- update;
- state migration.

### Interaction

- keyboard;
- touch-size;
- double-click dedup;
- stale revision refused;
- voice/click parity;
- pin/unpin;
- detach/attach nếu supported.

### Rendering

- narrow;
- compact;
- expanded;
- loading;
- empty;
- error;
- cached;
- read-only;
- reduced motion;
- text fallback.

---

## 18. Directory metadata

Directory entry cần:

- package id;
- current version;
- display name;
- one-line description;
- author/publisher;
- source repo;
- license;
- preview image/video;
- widget/facet types;
- supported platforms;

Giá trị `platforms` lấy từ **một** vocabulary dùng chung cho cả package lẫn host: `darwin-arm64`, `darwin-x64`,
`linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`, `web`. Tên theo dạng `<node platform>-<arch>`, nên Windows
là `win32-*` chứ không phải `windows-*`. Host tự khai bằng `platformForHost(process.platform, process.arch)`; host
nào vocabulary không mô tả được thì hàm trả `undefined`, và lời từ chối nêu tên platform của **cả hai** bên — thay
vì đoán `web` rồi đưa một package native cho thứ không chạy được.
- host API compatibility;
- requested permissions summary;
- risk tier;
- package size;
- release date;
- changelog link.

Các tín hiệu như downloads/reviews có thể thêm sau; không dùng popularity thay security/trust facts.

Pi package catalog là tham khảo tốt về discovery: package có manifest resources và preview image/video, được chia sẻ qua npm/git và index trong catalog. ClarkCant nên giữ ergonomics đó nhưng executable widget mặc định isolated thay vì full-process trust.

---

## 19. Publish flow

Developer:

    clark widget test
      ↓
    clark widget pack
      ↓
    artifact + digest
      ↓
    publish npm/git/release
      ↓
    clark widget publish
      ↓
    directory validation
      ↓
    searchable

Directory validation không claim “safe”. Nó xác minh:

- manifest;
- schema;
- artifact digest;
- preview metadata;
- conformance report;
- source/license;
- declared permissions;
- compatibility.

---

## 20. Versioning

Definition breaking change → new definition major/id version.

Package patch/minor không được thay semantic meaning của action binding đã persisted.

Action target/account/tool generation change → binding mới.

Snapshot cũ phải tiếp tục render fallback/text ngay cả khi current package đã đổi.

`clark widget publish` áp các quy tắc sau, so với definition của lần chuẩn bị trước, và từ chối kèm tên từng vi
phạm:

- `stateSchema` đổi ⇒ `stateVersion` phải tăng và có bước migration từ mọi `stateVersion` đã phát hành trở lên.
  So sánh theo nội dung, thứ tự key không tính;
- `stateVersion` không bao giờ giảm;
- bước migration đã phát hành là lịch sử: không sửa, không xoá, chỉ thêm — một node có thể đã migrate bằng nó;
- đổi `ephemeralStateKeys`, đổi `effectCategories` hoặc xin thêm `requestedCapabilities` ⇒ tăng major của
  definition (hoặc id mới). Bỏ bớt capability thì không cần;
- một definition biến mất khỏi package ⇒ tăng major của package, vì instance đang tồn tại gọi tên nó.

---

## 21. Review checklist

Trước merge/publish:

1. Widget có thật sự cần executable code hay composition đủ?
2. Có loading/empty/error/read-only fixture?
3. Keyboard dùng được?
4. Reduced motion dùng được?
5. Text fallback hữu ích?
6. Semantic view đủ cho voice mà không dump dữ liệu?
7. Local/effect action có tách rõ?
8. Action có dedup/revision guard?
9. Pin/detach có giữ một live owner?
10. Secrets/path không lọt props/state/log?
11. Network origins có bounded?
12. State migration có test?
13. 320 px không vỡ?
14. Uninstall/update không làm mất user data?
15. Package detail nói thật risk/trust lane?

Nếu câu 1 cho thấy composition đủ thì ưu tiên composition.

---

## 22. Source of truth

- Contract runtime: packages/contracts/src/widgets.ts.
- Bridge/author API: packages/widget-sdk.
- Host registry/isolation: packages/widget-host.
- Built-in descriptors: packs/data-canvas và các pack catalog sau này.
- Built-in React renderers: packages/conversation-client.
- Product UX: DESIGN.md.
- Standard này định nghĩa developer experience/release gate mục tiêu; implementation status phải được ghi trung thực trong code/conformance.

---

## 19. Trạng thái triển khai

Mục này nói rõ phần nào của tài liệu đã có code, để không ai đọc §16–§17 như thể mọi thứ đã chạy.

**Đã có và có test:**

- `clark widget init` — scaffold `blank`, `form`, `dashboard` theo layout ở §3, và package do nó tạo phải
  qua chính bộ conformance của nó (một template fail lần chạy đầu là template dạy sai).
- `clark widget test` — bộ conformance ở §17. Các check chạy được bằng Node thì chạy thật: schema, bridge
  security (nonce giả, sai source window, message không có trong codec), lifecycle, dedup, stale revision,
  pin, state migration, text fallback, effect action. Các check cần frame đã render (keyboard, touch size,
  narrow/compact/expanded, reduced motion, voice/click parity) được báo `requires-dev-host` — **không** được
  báo pass chỉ vì có fixture.
- `clark widget pack` — validate manifest, tính digest trên danh tính + nội dung, và từ chối pack lại một
  version đã pack với digest khác (một version đổi byte là một package khác mang cùng số).
- `clark widget dev` — dev host ở §16: hot reload qua SSE, fixtures, viewport switcher (320px là lựa chọn
  thật), dark/light/system, reduced motion, offline, read-only, semantic inspector, action log, capability
  simulator, và accessibility audit. Frame dùng đúng sandbox của host (`allow-scripts`, không
  `allow-same-origin`), và server từ chối mọi path nằm ngoài package.
- State bền của widget cách ly, migration khai báo do host chạy, và `ephemeralStateKeys` (§15).
- Gỡ / khôi phục / quay về package từ Settings và qua `manage_package` trong hội thoại; dữ liệu được giữ.
- Câu hỏi capability đang chờ được trả lời trong Settings (do host sở hữu; model không duyệt được). Frame chỉ
  nhận capability đã cấp **và** sẵn sàng; phần còn lại được nói ra kèm lý do.

**Chưa có:**

- `clark widget publish` — **đã có, ở mức "prepare"**, và áp quy tắc version ở §20: nó validate, pack, rồi ghi `dist/directory-entry.json`
  với đủ field mà §18 yêu cầu và digest của artifact đã pack (đọc từ `dist/artifact.json`, không tính lại —
  hai lần tính cùng một thứ là cách một listing nói tới artifact không ai tạo được). Nó **không** nộp thay
  người dùng: nộp cần account directory, và một lệnh trông như đã nộp rồi là control có action không tồn tại.
  Đường local/git/npm vẫn là first-class nên không cần account để chạy widget của mình.
- **Directory search** — đã có ở mức đọc một index: `CC_DIRECTORY_INDEX` trỏ tới một file JSON các entry theo
  §18, và `search_directory` trả về card `marketplace-results` hiển thị **source, version, digest và risk lane**,
  kèm tên directory mà kết quả đến từ đó. Chưa cấu hình index là một *trạng thái* được nói ra, khác với "không
  tìm thấy gì". Card **không có nút install**: cài đặt đi qua đúng install path nơi digest được kiểm và consent
  được ghi; một nút ở đây sẽ là entry point thứ hai để cài, và là chỗ duy nhất một listing có thể biến thành
  authorization. Không có registry từ xa — search chỉ đọc thứ tồn tại trên máy hoặc ở URL người dùng chỉ định.
- Script trong trang của dev host: nó thu thập fact và chuyển action, còn mọi quyết định nằm ở hàm đã test —
  nhưng bản thân script cần browser để chạy, và điều đó được nói ra thay vì ngụ ý rằng cả dev host đã được phủ.
- Detach/attach: cửa sổ host tách rời của desktop **đã có thật** (`apps/desktop/src/main.mjs` mở nó qua
  `detachedWindowOptions`, `apps/web/src/App.tsx` phục vụ `?detached=1`), và được
  `apps/desktop/test/detached-window.spec.ts` cùng `apps/web/e2e/detach.spec.ts` phủ — **không phải** bởi
  check `detach` của bộ conformance: harness chỉ chạy trên dev host trong trình duyệt, mà dev host không có
  cửa sổ tách rời nào để điều khiển. Nửa sở hữu (`detached` trên live-owner claim) đã có.
- Runtime cho MCP Apps: đường isolated-app đã có; MCP Apps chưa được chứng minh trên cùng đường đó.

---

## 23. Widget Library và Widget Lab

Mục này mô tả hai surface đã có code: thư viện để **xem** catalog, và Lab để **phát triển** widget. Cả hai
dùng chung một surface, khác nhau ở chế độ.

### 23.1 Một catalog chuẩn

`packages/widget-catalog` là lớp discovery duy nhất: `CATALOG_DEFINITIONS` = `WIDGETS` của `packs/data-canvas`
cộng `NOTE`. Note **không** nằm trong `WIDGETS` vì danh sách đó là từ vựng view mà model được phép gọi
(`apps/runtime/src/services.ts`), nên thêm vào đó là thay đổi bề mặt model chứ không phải refactor metadata.
Note được export từ barrel của pack, **không** từ `sample.ts`: `sample.ts` import `@clarkcant/core`, và đi qua
nó sẽ kéo `packages/storage` (`node:sqlite`, `node:crypto`) vào bundle browser — đúng thứ invariant
`browser-entries-avoid-node-builtins` bắt được.

Metadata hiển thị (tên, mô tả, family, tag) nằm trong `widget-catalog`, và test khẳng định không entry nào rơi
về id thô, cũng không entry metadata nào trỏ tới definition không tồn tại.

### 23.2 Hợp đồng fixture

`widgetFixtureSchema` trong `packages/contracts/src/widgets.ts` là hợp đồng dùng chung: `strictObject` với
`{id, label, props, state?, dataset?, mode?}`. Strict nghĩa là một fixture mang thêm khoá lạ — ví dụ một effect
binding — sẽ fail thay vì được render như thể vô hại. Đó là cách "fixture là data, không phải code" trở thành
điều kiểm được.

Hai artifact khác nhau, không phải hai bản sao của một thứ:

- **fixture của catalog** — `WidgetFixture`, có `dataset` và `mode`, do `widget-catalog` cung cấp;
- **`fixtures/*.json` của một package** — props trần; `readPackage` đọc chúng và `conformance.ts` kiểm bằng
  props schema của chính widget đó.

Một fixture của package có thể mang thêm dữ liệu: file `fixtures/<name>.dataset.json` đi kèm
`fixtures/<name>.json`. Node đọc cặp này thành **một** `WidgetFixture` — props từ file thứ nhất, `dataset` từ
file thứ hai — và validate dataset bằng đúng `fixtureDatasetSchema` mà catalog dùng. Dataset sai schema thì bị
nêu tên trong `problems` và **không** được gắn vào fixture, chứ không được render như thể hợp lệ.

Vì sao cần file riêng thay vì nhét dataset vào props: renderer đọc dataset từ **fixture**, không từ props
(`WidgetPreview.tsx`), nên một widget có dữ liệu sẽ mãi vẽ đường "chưa có dữ liệu" nếu dataset chỉ nằm trong
props.

### 23.3 Xem trước bằng renderer thật

Preview gọi `resolveRenderer` trong `packages/conversation-client/src/renderers.tsx` — cùng renderer mà hội
thoại dùng. Không có renderer thứ hai, không ảnh chụp, không mock: một preview bằng ảnh sẽ không nói được gì
về widget đang chạy. Definition không có renderer thì hiện `data-widget-preview-missing` kèm lý do, chứ không
im lặng.

Widget media (`canvas.youtube@1`, `video`, `image`, `carousel`, `gallery`) chỉ mount ở detail view; ở lưới
chúng chỉ có text alternative. Nhờ vậy duyệt catalog không gọi bên thứ ba.

### 23.4 Widget Lab

Lab là **cùng surface** ở `mode="develop"`, mở từ Settings → Developer. Nó thêm:

- props form dựng từ props schema, nên control phản ánh đúng schema chứ không phải danh sách viết tay;
- inspector 8 panel, đúng theo `inspectorPanels` trong `widget-lab.ts`: props, state, events, actions,
  semantic, sizing, capabilities, fallback. Tên trong tài liệu là **id** của panel, không phải nhãn hiển thị
  (`Props`, `State`, …), để người đọc đối chiếu được với code;
- fixture, viewport, theme và reduced motion áp trong **phạm vi preview** (`data-cc-theme`,
  `data-cc-reduced-motion` trên frame), nên xem widget ở dark mode không đổi tuỳ chọn của người dùng;
- màn hẹp thì pane tiến (preview ↔ inspector) thay vì hai cột.

### 23.5 Hội tụ với dev host

`clark widget dev` và Lab dùng chung **ngữ nghĩa preview**: từ vựng theme (`PREVIEW_THEMES`) và ba luật chuyển
`fixture`/`theme`/`reduced-motion` (dev shell uỷ quyền cho `applyPreviewAction`). Test
`packages/widget-cli/test/dev-shell-convergence.spec.ts` so sánh trực tiếp hai cài đặt, nên lệch nhau sẽ fail ở
đó chứ không phải chờ ai đó mở hai cửa sổ rồi so bằng mắt.

Khác có chủ ý: dev host dùng bộ viewport riêng (tới 1024px) vì nó xem một package độc lập, còn Lab xem ở bề
rộng hội thoại.

`clark widget dev --builtin <definitionId>` chạy **cùng** shell đó cho một widget của catalog: cùng khung sandbox,
cùng state machine, cùng bộ điều khiển. Khác duy nhất là nguồn — không đọc package nào trên đĩa, và frame được
Vite phục vụ từ `packages/widget-cli/src/catalog-runtime.tsx`, entry mount `WidgetPreview`, tức **chính**
`resolveRenderer` mà hội thoại và thư viện dùng. Nhờ vậy preview không thể lệch khỏi thứ người dùng sẽ thấy, và
không có bước build nào để quên cũng như không có artifact nào phải commit. Id mà catalog không có thì bị từ chối
**ngay lúc khởi động và kèm tên**, chứ không phải trong browser. Frame được sinh theo từng request nên nó mang
đúng fixture mà shell đang hiện: đổi control fixture là đổi thứ được vẽ, không chỉ đổi thứ shell nói.

Một khác biệt đã biết: chế độ này **không** tự reload khi source đổi. Chế độ package theo dõi thư mục package và
báo qua `/dev/events`; frame của catalog chưa nối vào cơ chế đó, nên phải **refresh thủ công**.

Vì entry đó là code browser do một CLI Node phát đi, nó nằm trong danh sách entry của invariant
`browser-entries-avoid-node-builtins` (115 module, 3 entry), và `tsconfig.web.json` phủ
`packages/widget-cli/src/**/*.tsx`. Dòng config đó là bắt buộc: config Node chỉ include `**/*.ts` và không đặt
`jsx`, nên nếu thiếu nó thì file **âm thầm** không được typecheck ở đâu cả.

### 23.6 Provenance của package đã cài

Thư viện liệt kê package đã cài như **provenance**, trên danh sách riêng: `packageId@version`, source tier,
digest (rút gọn, bản đầy đủ ở `title`) và trust lane; wording của lane nằm một chỗ trong
`packages/conversation-client/src/package-provenance.ts` để extension Pi gốc và widget cách ly không bao giờ
đọc giống nhau. Ba trạng thái được tách: đang đọc, không đọc được (có nút thử lại), và chưa cài gì. Widget mà
package khai báo là card thật, ở mục 23.8.

### 23.7 Đường vào

Nút trong Settings, câu lệnh gõ và voice đều đi qua **một** app-intent path: `widgets.open` (mở thư viện) và
`widgets.show` (hiện một widget, có target). Matcher chỉ nhận target khi câu có dạng mệnh lệnh, và một câu nhắc
widget không resolve được target sẽ mở thư viện thay vì đoán — đây là hành động chỉ xem, không bao giờ đoán
một effect.

### 23.8 Widget do package khai báo

Một package có thể khai báo widget, và widget đó trở thành card thật trong thư viện. Đường đọc:

1. client gọi `GET /packages/widgets` **khi mở** thư viện, không phải khi mount — thư viện không ai mở thì
   không hỏi node câu nào;
2. node tìm package trong directory index (`CC_DIRECTORY_INDEX`) rồi đọc định nghĩa từ đĩa
   (`installedWidgets` trong `packages/core/src/installed-widgets.ts`);
3. card chỉ được tạo nếu **client** có renderer cho definition id đó (`resolveRenderer`). Cổng nằm ở client vì
   renderer nằm ở client; một ý kiến thứ hai ở node sẽ lệch khỏi ý kiến này.

**Card id được namespace.** Mọi definition id mà renderer hiện có vẽ được đều đã là entry của catalog, nên một
package dùng chính definition id làm danh tính card sẽ không bao giờ hiện được: entry của catalog thắng id đó
mọi lần. Vì vậy card id là `<packageId>/<definitionId>` — một sự thật về nguồn gốc, không phải một cái tên đẹp
hơn. Việc vẽ vẫn resolve từ `definition.id`, nên vẫn đúng **một** renderer cho mỗi id, và card của catalog cho
cùng definition vẫn hiện bên cạnh (nhãn `Built-in` so với `Local development package`).

**Giới hạn, và nó được nói ra.** Chỉ package **local** và **có trong directory index** mới đọc được: generation
trong DB không mang đường dẫn, và artifact của nguồn git/npm không nằm trên máy này. Nguồn khác nhận
`NOT_LOCAL`/`NOT_IN_DIRECTORY` và được **nêu tên** trong mục "Gói đã cài: phần chưa xem được" — một danh sách
ngắn hơn sẽ nói "package này không khai báo widget nào" trong khi sự thật là node không đọc được nó.

Danh tính của một package local là **danh tính của directory entry**, không phải đường dẫn. Một lần cài từ đĩa
từng ghi `packageId` là chính đường dẫn đó, mà đường dẫn là nơi byte nằm chứ không phải tên của package — nên
cùng một package có hai tên: listing nói `com.example.chart-widget` còn row đã cài nói
`apps/web/e2e/fixtures/chart-widget`. Nhánh local của `resolvePackageSource` nay lấy tên từ entry khớp **theo
đường dẫn** trong directory index. Một đường dẫn **không** được liệt kê vẫn cài được như trước và giữ đường dẫn
làm tên, vì nó không có tên nào tốt hơn. `digest` vẫn là hash của chính byte trên đĩa do caller tính, **không**
phải digest đã publish: hai thứ đó mô tả hai chuyện khác nhau.

Các row `package_generations` **đã** ghi đường dẫn từ trước vẫn còn trong DB, nên route `/packages/widgets` vẫn
giữ fallback tìm entry theo `source.path`. Nếu xoá nó, những row cũ đó sẽ báo `NOT_IN_DIRECTORY` vĩnh viễn.

**Nguồn git/npm giờ được fetch thật, không chỉ tin digest listing.** `packages/core/src/package-fetch.ts` là
nơi làm việc đó: `fetchGitArtifact` clone nông đúng một commit đã pin (`git fetch --depth 1 -- <url> <sha40>`,
refuse ref không phải commit id đầy đủ) vào một thư mục cache node sở hữu; `fetchNpmArtifact` đọc packument,
tải tarball đúng version, kiểm `dist.integrity`/`dist.shasum` với chính byte tải về, rồi giải nén. Digest ghi
vào plan là `digestOfDirectory` tính trên byte đã fetch — không phải digest publisher tự khai — và một mismatch
bị refuse (`DIGEST_MISMATCH`) trước khi plan được đề xuất. `installPackage`
(`apps/runtime/src/application/package-install.ts`) gọi fetch này rồi đổi `source` của entry thành `local` trỏ
vào thư mục cache, nên phần còn lại của install (plan, consent, generation) là **đúng một** đường đi — không có
installer thứ hai cho package từ xa.

Directory index bị coi là **untrusted input**: `url`, `ref`, `name`, `version` trong một entry git/npm có thể
đến từ bất kỳ nguồn nào phục vụ index đó, nên `fetchGitArtifact` chặn từng lớp trước khi spawn `git`. Một url bắt
đầu bằng `-` bị refuse ngay (chống argument injection kiểu `--upload-pack=...`); scheme phải là `https://`, hoặc
một bare path/`file://` khi caller bật `allowLocalPaths` tường minh (chỉ test, hoặc một flow "cài từ path local"
sau này — install route production không bật cờ này trừ khi biến môi trường `CC_ALLOW_LOCAL_GIT_SOURCES=1` được
set, việc chỉ test harness làm). Mọi lệnh `git` chạy với `--` trước url/ref, `-c protocol.allow=never` cộng allow
tường minh cho đúng scheme đang dùng, `core.hooksPath=/dev/null`, LFS smudge tắt, và timeout (chuyển từ
`spawnSync` sang `spawn` bất đồng bộ để một remote treo không còn chặn cả event loop của node).

Cache được đánh địa chỉ theo nội dung: đường dẫn cache của một nguồn git là hàm thuần của `url`+`ref`
(`cachedGitPath`), của npm là hàm thuần của `name`+`version` (`cachedNpmPath`) — không cần một bảng ánh xạ nào
được lưu riêng. Điều này giải quyết hai việc cùng lúc: fetch lại đúng `url`+`ref` là cache hit (không refetch,
không bao giờ `rmSync` một artifact có thể đang sống), và bất kỳ nơi nào khác giữ cùng entry — route serve file,
`findIsolatedFrame` — tính lại đúng path đó để phục vụ package git/npm đã fetch giống hệt package local
(`resolveLocalSource`).

`digestOfDirectory` dùng `lstatSync`, không phải `statSync`: một symlink hay hard link trong artifact bị refuse
theo tên (`ARTIFACT_SYMLINK_ESCAPE`) chứ không bị theo dõi (follow) hay bỏ qua âm thầm, và hàm không bao giờ throw
`ELOOP` ra ngoài — vì `lstatSync` không follow thành phần cuối của path nên một symlink tự trỏ vào chính nó không
gây loop khi duyệt. `.git` chỉ bị loại ở cấp gốc của artifact, không phải mọi nơi trong cây, nên một package hợp
lệ có thư mục `.git` lồng bên trong (một checkout vendor hoá) vẫn được hash đầy đủ.

`fetchNpmArtifact` không còn shell ra `tar`: nó tự đọc format ustar (gzip + tar) và kiểm typeflag của từng entry
trước khi ghi byte nào xuống đĩa — chỉ file thường và thư mục được chấp nhận; symlink, hard link, thiết bị, hay
một tên entry chứa `..`/đường dẫn tuyệt đối đều bị refuse theo tên (`NPM_TARBALL_UNSAFE_ENTRY`). Tarball có cap
kích thước (`content-length` bị từ chối trước khi tải nếu vượt cap, byte thực tải về cũng được kiểm lại),
`gunzipSync` có `maxOutputLength` để chặn gzip bomb, và mọi fetch (packument lẫn tarball) đều có timeout qua
`AbortSignal.timeout`.

**`grantedCapabilities` giờ được suy ra, không còn luôn rỗng — và được suy ra từ manifest đã fetch, không phải
từ request body.** `deriveGrantedCapabilities` (`packages/core/src/install-consent.ts`) hỏi execution policy y
hệt policy đang gác mọi effect khác trên node, theo từng capability, ở category rủi ro mà lane mạnh nhất của
package quy định (`declarative`/`isolated-ui` → `local-write`, `service`/`trusted-native` → `destructive`). Cái
được xem là "đã request" là `manifest.requestedCapabilities` đọc từ chính artifact vừa fetch-và-verify-digest
(`readPackage(resolvedEntry.source.path)`), **không phải** field `requestedCapabilityRefs` trong HTTP request
body — một client gửi request có thể viết bất kỳ gì vào body của chính nó, nên tin nó làm authority sẽ biến một
body giả mạo thành chính tập capability được cấp. Risk tier dùng để quyết định cũng được tính từ facet
isolations của entry (`riskLaneFor(entry.isolations)`), hoà cùng `entry.riskTier` mà directory tự khai — theo
nguyên tắc claim chỉ có thể **nâng** tier tính được lên, không bao giờ hạ nó xuống.

Không có dialog riêng: một capability mà policy sẽ hỏi thì đi qua đúng approval path hiện có (`requestApproval`,
với category rủi ro đúng như quyết định của `deriveGrantedCapabilities`) và được trả về trong response cài đặt
dưới `pendingCapabilities` (kèm `approvalId` để action tiếp); một capability policy refuse thì trả về trong
`deniedCapabilities`. Không capability nào trong hai nhóm này tự động thành granted. Granted set được ghi vào
`PackageGeneration.grantedCapabilities`, và widget frame chỉ được broker đúng **giao của requested và granted**
(`brokeredCapabilities`, `widget-frame.ts`) — không còn gửi thẳng `requestedCapabilities` của manifest cho frame
như trước.

Một generation được kích hoạt trước khi `grantedCapabilities` tồn tại trên schema không có key này trong
document lưu trữ. Migration 22 (`packages/storage/src/migrate.ts`, `backfill_generation_granted_capabilities`)
backfill mỗi row như vậy bằng `requestedCapabilityRefs` của chính install plan nó đã resolve qua — cách trung
thực nhất để trả lời "generation này thực sự được consent cho gì" dưới semantics cũ, thay vì chạy lại policy hôm
nay lên một install của ngày hôm qua. Một generation không còn plan khớp (đã bị superseded và dọn, hoặc chưa
từng có) được backfill về `[]` thay vì đoán — một grant rỗng phục vụ thiếu còn hơn cấp thừa.

**Một package chỉ *liệt kê* trong directory, chưa từng được cài, không có file nào để serve.**
`GET /packages/:packageId/:version/files/*` (`apps/runtime/src/routes/packages.ts`) đòi một generation đang
active trên chính node này, khớp cả `version` lẫn `digest` với entry directory đang serve, trước khi đọc bất kỳ
byte nào — không còn coi "có trong directory index" là đủ để serve như trước. Một entry được liệt kê nhưng chưa
từng qua `POST /packages/install` (hoặc đã cài rồi bị superseded bởi một digest khác) trả `409 NOT_INSTALLED`
thay vì phục vụ byte từ một nguồn node chưa từng xác minh xong install cho nó. Đây là quyết định sản phẩm được
giữ nguyên chứ không phải một khiếm khuyết cần sửa: một package "biết tên" nhưng chưa cài không nên trông giống
một package sẵn sàng dùng. Không có flow dev thực nào phụ thuộc hành vi cũ ("liệt kê là đủ") — `widget-cli dev`
dùng dev host riêng của nó, không đi qua route này. Một dev DB cũ thấy generation của mình biến mất khỏi route
này sau khi nâng cấp nên chạy lại `POST /packages/install` cho package đó, hoặc `node
tools/check-invariants.mjs --fix-manifest` nếu chỉ cần đồng bộ lại `docs/manifest.json` sau khi sửa file này.

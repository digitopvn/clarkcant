# ClarkCant Widget Developer Standard

> [English](widget-development.md) (mặc định) · Tiếng Việt

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

Mỗi package có một manifest gốc duy nhất là `clarkcant.json`, dùng chung cho mọi facet của package. Hợp đồng là
`packageManifestSchema` trong `packages/contracts/src/install.ts`, và `clark widget init` sinh ra đúng dạng này:

    {
      "schemaVersion": 2,
      "id": "com.example.calendar",
      "version": "1.2.0",
      "displayName": "Calendar Plus",
      "description": "A compact agenda and week view.",
      "hostApi": { "min": 1, "max": 1 },
      "facets": [
        {
          "kind": "ui",
          "id": "com.example.calendar.week@1",
          "entry": "widgets/main/index.html",
          "definition": "widgets/main/widget.json",
          "isolation": "isolated-ui"
        },
        {
          "kind": "tools",
          "id": "com.example.calendar.service",
          "entry": "service/server.mjs",
          "isolation": "service",
          "protocol": "mcp-stdio",
          "capabilities": [
            {
              "tool": "list_events",
              "ref": "com.example.calendar.events.list@1",
              "summary": "List the events in a date range",
              "effectCategory": "read"
            }
          ]
        }
      ],
      "requestedCapabilities": [],
      "permissions": {
        "networkOrigins": [],
        "filesystem": [{ "path": "cache", "access": "write" }],
        "microphone": false,
        "camera": false,
        "lifecycleScripts": []
      },
      "platforms": ["darwin-arm64", "linux-x64", "win32-x64"],
      "publisher": {
        "id": "example",
        "sourceUrl": "https://github.com/example/calendar-plus",
        "license": "MIT"
      },
      "dependencies": []
    }


Mỗi loại facet chỉ chạy trong đúng một lane, và schema từ chối mọi cách ghép khác:

| `kind` | `isolation` | Ý nghĩa |
|---|---|---|
| `ui` | `isolated-ui` | Widget vẽ trong frame riêng. `id` phải trùng với id nằm trong `definition`. |
| `tools` | `service` | Một service mà node chạy trong container, nói MCP qua stdio và khai báo mọi capability nó cung cấp. |
| `skills`, `prompts`, `themes`, `setup` | `declarative` | Dữ liệu mà host đọc, không bao giờ chạy. |
| `driver`, `voice` | `service` hoặc `trusted-native` | Có trong bộ từ vựng để listing hiển thị được lane. Hiện chưa host nào chạy loại này từ package. |

Reader cũng từ chối manifest khi:

- hai facet trùng `id`, hoặc một `id` không phải là một tên đơn (chữ cái, chữ số, `.`, `_`, `@`, `-`, bắt đầu và kết
  thúc bằng chữ cái hoặc chữ số), vì nó còn đặt tên cho thư mục dữ liệu và container của service;
- package có facet `tools` mà `id` không phải tên reverse-DNS gồm ít nhất hai đoạn chữ thường, như `com.example.notes`,
  hoặc nằm dưới namespace mà capability của chính node dùng (`canvas`, `clarkcant`, `dev`, `mcp`, `project`);
- `entry` hoặc `definition` của facet nằm ngoài package (`..`, đường dẫn tuyệt đối, ký tự ổ đĩa) hoặc là URL;
- `ref` của một capability trong facet `tools` không nằm dưới package id (`<package id>.<name>@<major>`), hoặc một
  tool hay capability bị khai báo hai lần.

Facet `tools` khai báo capability ngay trong manifest, nhờ vậy màn hình đồng ý hiển thị được chúng trước khi bất kỳ
đoạn code nào của package chạy. Việc cài package chính là sự đồng ý với những gì package khai báo; mỗi lời gọi vẫn do
execution policy quyết định.

**Node đọc theme facet như thế nào.** `entry` của một facet `themes` là một tài liệu theme dạng JSON nằm trong gói, ví
dụ `{ "kind": "themes", "id": "dusk", "entry": "themes/dusk.json", "isolation": "declarative" }`. Tài liệu là một bản
vá đè lên Clark Default: `appearanceApi` (`{ "min": 1, "max": 1 }`), một `id` trùng với `id` của facet, một
`displayName`, `description` tuỳ chọn, `colors.dark` / `colors.light` tuỳ chọn (giá trị hex sáu chữ số cho các token màu
được đặt tên trong `packages/contracts/src/themes.ts`), và `radius` tuỳ chọn (rem từ 0 đến 2 cho `badge`, `button`,
`card`, `response`, `modal`). Ngoài ra không có gì khác: không CSS, không selector, không font. Node đọc nó từ các byte đã cài qua cùng cơ chế giới hạn như tệp của
widget, từ chối tài liệu lớn hơn 64 KiB, và kiểm tra nó (`packages/core/src/installed-themes.ts`); theme không qua được
kiểm tra sẽ được liệt kê kèm lý do, và các theme khác của gói vẫn được nạp. Theme hợp lệ còn phải qua bài kiểm tra tương
phản mà Clark Default phải qua, ở cả hai chế độ màu (`requiredPairs` trong `packages/design-tokens/src/contrast.ts`);
theme không đạt sẽ được liệt kê kèm các cặp màu không đạt và không chọn được, nên hãy kiểm tra cả hai chế độ màu trước
khi phát hành. Theme được chọn bằng
`package:<package id>#<theme id>`, và một gói chỉ có theme là một lần làm mới UI, không bao giờ khởi động lại Pi. Theme đã
cài xuất hiện ở Cài đặt → Trải nghiệm → Chủ đề.
**Node chạy service facet như thế nào.** Node chạy một container cho mỗi facet `tools` của mọi package generation
đang active, và dừng nó khi generation không còn active (`apps/runtime/src/service-host.ts`). Service là code bên thứ
ba, còn một process riêng không phải sandbox, nên container mới là ranh giới. `serviceRunArgs` trong
`apps/runtime/src/service-container.ts` định nghĩa ranh giới đó: không có mạng, root filesystem chỉ đọc, bỏ mọi Linux
capability, không cho leo thang đặc quyền, user không phải root, package được mount chỉ đọc tại `/pkg`, một thư mục
riêng ghi được tại `/data`, và chỉ những biến môi trường mà hàm này nêu tên, không bao giờ là biến môi trường của node.
Host nói MCP qua stdio của container, nên không mở cổng nào. Engine là Docker chạy Linux container, hoặc Podman. Với
Docker rootless, mà node nhận ra qua những gì `docker info` báo, service chạy với id 0 của container: Docker rootless
ánh xạ id đó, và chỉ id đó, về đúng tài khoản chạy daemon, nên thư mục riêng vẫn thuộc về chính người dùng. Id này
không có đặc quyền nào, vì mọi capability đều bị bỏ và leo thang đặc quyền bị từ chối. Node không có engine nào thì
không chạy service. Không có fallback chỉ chạy process. Các capability vẫn được đăng ký, ở
trạng thái chưa load, kèm lý do "needs Docker or Podman to run; this node has neither running".

Những gì registry báo là những gì host đã quan sát được, không phải điều manifest mong đợi:

- tool mà service liệt kê nhưng manifest không khai báo thì không bao giờ được đăng ký;
- tool đã khai báo mà service không liệt kê thì vẫn ở trạng thái chưa load, và lý do nói rõ điều đó;
- tool đã khai báo có input schema chứa `pattern` hoặc `patternProperties` có thể khiến việc kiểm tra tốn thời gian không
  giới hạn thì vẫn ở trạng thái chưa load, schema không được lưu, và lý do nêu tên pattern, vị trí của nó và cách viết
  thay thế (`packages/contracts/src/schema-patterns.ts`). Các pattern bị từ chối gồm: một phép lặp mà phần thân khớp được
  theo nhiều cách, như `(a+)+`; một lựa chọn lặp lại giữa các phương án bắt đầu bằng cùng một ký tự, như `(a|ab)+`; hai
  phép lặp không giới hạn liền nhau khớp cùng ký tự, như `\d+\d+`; backreference; quantifier bên trong lookahead hoặc
  lookbehind; và pattern dài hơn 512 ký tự. Một giá trị hoặc key mà schema sẽ kiểm tra bằng pattern thì dài tối đa 1.000
  ký tự;
- service bị dừng thì được khởi động lại với backoff, và bị để dừng hẳn nếu cứ crash mãi, lý do nói rõ trường hợp nào;
- ref mà node hoặc package khác đã đăng ký thì được giữ nguyên và package này không phục vụ nó, log của node ghi rõ điều
  đó; khi package kia không còn hoạt động trên node, lần đối soát kế tiếp sẽ trao ref cho package này mà không cần khởi
  động lại service của nó;
- node không tìm thấy engine sẽ hỏi lại sau một phút, nên bật Docker sau đó không cần khởi động lại node.

Lý do đó là thứ người dùng đọc được bên cạnh một action bị vô hiệu hoá. Binding `invoke` của widget, tool
`invoke_capability` của agent và lệnh nói đều đi tới một đường host duy nhất, `invokeCapability`
(`apps/runtime/src/application/capability-invoke.ts`). Registry quyết định capability có chạy được không. Input schema
mà service liệt kê cho tool đó quyết định input có được chấp nhận không. Execution policy quyết định có được phép chạy không, và
khi policy cần hỏi thì một approval card do host sở hữu xuất hiện trong cuộc trò chuyện. Các lời từ chối là các mã
`CapabilityInvokeRefusal` trong file đó.

Chưa xây: credential broker cho service, cô lập bằng VM, và gọi service trên node khác. Model gọi được service của
package ngay trong cuộc trò chuyện bằng cách đặt nút hành động chung với action `invoke` (§8.1). Journey trình duyệt
[`service-facet.spec.ts`](../apps/web/e2e/service-facet.spec.ts) vẫn tạo widget riêng của package kèm binding `invoke`
qua một fixture model.

`publisher` là tuỳ chọn trong manifest. `clark widget publish` thì bắt buộc phải có, vì một directory entry phải
cho biết package đến từ ai. `dependencies` mặc định là `[]`.

**Phiên bản 1.** Trước phiên bản 2, `clark widget init` sinh ra manifest chỉ dành cho widget, với
`"schemaVersion": 1`. Manifest này dùng facet `"kind": "widget"`, còn `filesystem` là danh sách đường dẫn.
ClarkCant vẫn đọc định dạng này, nhưng chỉ trong bộ nhớ:

- facet `widget` trở thành facet `ui`;
- mỗi đường dẫn filesystem trở thành `{ "path": …, "access": "read" }`.

File không bao giờ bị ghi lại, vì consent gắn với digest của các byte trong package. Reader cũng không sửa gì. Nếu một
giá trị của phiên bản 1 không hợp lệ trong manifest chuẩn (version không theo semver, hoặc platform không tồn tại),
reader sẽ báo lỗi.
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

Node kiểm tra props theo props schema trên main thread của nó, nên `pattern` và `patternProperties` trong schema phải
tuân theo cùng các quy tắc như input schema của service (§4, `packages/contracts/src/schema-patterns.ts`). Definition có
props schema chứa pattern có thể khiến việc kiểm tra tốn thời gian không giới hạn thì không được load:

- `clark widget test` báo lỗi ở bước "the package can be read" và nêu tên pattern, vị trí của nó và cách viết thay thế;
- Widget Library hiển thị cùng lý do đó dưới dạng ghi chú của package, các widget khác của package vẫn được load;
- props được kiểm tra theo schema như vậy ở bất kỳ đâu, trong node hay trong Widget Lab, đều bị từ chối kèm text fallback.

Một chuỗi mà props schema kiểm tra bằng pattern thì dài tối đa 1.000 ký tự.

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

## 8. Hành động, nhập liệu và thẻ chỉ đọc

Mục này nói về việc một widget làm (§8.1), điều người dùng đưa cho Clark qua một widget (§8.2), cách các widget trên
cùng một bề mặt tác động lên nhau (§8.3), và các thẻ chỉ đọc không làm gì cả: thẻ trạng thái, tiến độ và chi tiết
(§8.4), cùng mã, diff và tệp (§8.5). Ba phần đầu dựa trên một phân biệt cứng:

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

### 8.1 Nút hành động chung (`canvas.action@1`)

Một nút cho mọi loại effect. Model đặt nút bằng `show_view`. Props nói nút hiển thị gì (`label`, `description` tuỳ
chọn, `emphasis` `primary|secondary`, và `icon` trong một tập cố định), còn `props.action` nói nút làm gì. Host biên
dịch `action` thành action binding trước khi lưu bất cứ thứ gì và bỏ nó khỏi props, nên renderer chỉ biết nhãn, không
biết gì về hành động. Nếu host từ chối đề xuất, model đọc lý do ngay trong lượt đó và không nút nào bị để lại.

| `action.kind` | Bấm nút thì làm gì | Biên dịch từ |
| --- | --- | --- |
| `view` (`view.save`) | Ghim nút này vào cuộc trò chuyện. | Effect category `local-write`. |
| `agent` | Mở một lượt trong cùng cuộc trò chuyện với tin nhắn đúng bằng nhãn; `intent` được gửi kèm cho model. Câu trả lời là kết quả của lần bấm. | Bản thân việc mở lượt không thay đổi gì; lượt đó làm gì tiếp thì tự đi qua policy. |
| `invoke` | Gọi một capability của package service qua `invokeCapability`, cùng đường với tool `invoke_capability` của agent và giọng nói. | Effect category của chính capability và thế hệ package đang phục vụ nó; tham số được kiểm theo input schema. |
| `workflow` | Chưa làm gì: node này chưa chạy được quy trình, nên nút hiện ở trạng thái tắt kèm lý do. | Category nặng nhất trong các bước. |

Binding digest bao gồm đề xuất, thế hệ package, effect category và nhãn. Khi package được cập nhật, binding trở nên cũ
(`BINDING_STALE`) thay vì bị trỏ sang đích khác. Lần bấm có cần phê duyệt hay không là quyết định của execution policy
tại thời điểm bấm, không phải một cờ đóng băng lúc biên dịch.

Mọi bề mặt đọc trạng thái sẵn sàng từ một hàm duy nhất (`bindingAvailability` trong
`apps/runtime/src/application/action-bindings.ts`), và timeline mang trạng thái đó bên cạnh instance. Service đã dừng,
capability không phải service, binding cũ hay workflow đều là nút bị tắt kèm lý do bằng lời, không phải nút trông như
bấm được rồi thất bại. Lần bấm vẫn được kiểm lại khi tới node. Khi bấm, nút hiện trạng thái đang chạy, rồi kết quả trong
một dòng `role="status"`. Kết quả là output của service, câu trả lời của agent, "đã ghim", "đang chờ bạn phê duyệt"
hoặc lý do bị từ chối. Bấm lần hai khi lần đầu còn đang chạy thì không gửi gì. Bấm nút agent khi Clark còn đang trả lời
thì bị từ chối với `TURN_IN_PROGRESS` thay vì ngắt ngang.

`canvas.cta@1` được giữ để lịch sử vẫn hiển thị. Model không đặt nó được nữa, vì nó không có hành động nào phía sau.

Kiểm thử: `apps/runtime/test/action-widget.spec.ts`, `packages/conversation-client/test/action-button.spec.ts`, và
journey trình duyệt `apps/web/e2e/action-widget.spec.ts`, chạy từng loại với một notes service thật trong container.

### 8.2 Biểu mẫu, danh sách, ô tìm kiếm và trường nhập

Năm định nghĩa cho phép người dùng đưa thông tin cho Clark, thay vì chỉ đọc. Một mô hình trường duy nhất, trong
[form-fields.ts](../packages/contracts/src/form-fields.ts), mô tả trường và kiểm giá trị của nó. Cả trang lẫn node đều
dùng mô hình này, nên trang báo đúng lỗi mà node sẽ từ chối.

| Định nghĩa | Là gì | Model đặt nó thế nào |
| --- | --- | --- |
| `canvas.form@1` | Các trường cùng một nút gửi, gắn với một hành động. | `show_view` với `props.fields` (1–20), `props.submitLabel` và `props.action` là hành động `agent` hoặc `invoke`. |
| `canvas.list@1` | Các mục có id ổn định, có thể chọn một hoặc nhiều mục, chia trang (5–50 mục mỗi trang) và có câu hiển thị khi trống. | `show_view` với `props.items` (tối đa 200). `props.itemActionLabel` đi cùng `props.action` sẽ cho mỗi mục một nút chạy hành động đó. Nó cũng có thể là lá của bố cục, khi đó không có nút cho từng mục. |
| `canvas.search@1` | Một ô tìm kiếm. | Chỉ làm lá của bố cục. Khi không khai báo state, nó lọc mọi bảng trong cùng bề mặt, ngay trên trang. Khi có state, nó ghi một khoá qua quy tắc `on` (§8.3). |
| `canvas.choice@1` | Một lựa chọn: `chips`, `select`, `multiselect`, `radio`, `checkbox` hoặc `toggle`. | Một trường của biểu mẫu, hoặc một lá của bố cục có quy tắc `on` ghi vào state của bề mặt (§8.3). Không bao giờ đứng một mình khi giá trị của nó chẳng đi đâu cả. |
| `canvas.input@1` | Một ô nhập: `text`, `number`, `date`, `date-range`, `time` hoặc `slider`. | Như lựa chọn. |

Node bảo đảm:

- **Không có trường bí mật.** Trường nào có tên hoặc nhãn hỏi mật khẩu, token, khoá, mã PIN hay thứ tương tự đều bị từ
  chối trước khi lưu bất cứ thứ gì. Model đọc lý do ngay trong lượt đó. Thông tin đăng nhập đi qua luồng kết nối của
  host.
- **Binding biết nó nhận gì.** Binding của biểu mẫu ghi lại tên các trường và một JSON Schema dựng từ các trường đó.
  Binding của danh sách ghi lại id các mục. Mỗi lần gửi đều được node kiểm lại. Thiếu giá trị bắt buộc, giá trị nằm ngoài
  lựa chọn hoặc ngoài khoảng, trường lạ, hay mục không có trong danh sách đều được trả `400 INVALID_INPUT` kèm lý do, và
  không có gì chạy.
- **Cùng đường với nút.** `submit` của biểu mẫu gửi các giá trị làm input của hành động. Nút của một mục gửi
  `{ itemId }`, hoặc tên tham số mà binding `invoke` chỉ định. Cả hai đi qua `POST …/widgets/{instanceId}/actions` với
  đúng các bước kiểm revision, digest và invocation id như §8.1. Biểu mẫu `agent` mở một lượt với tin nhắn là nhãn nút
  gửi, rồi từng trường theo dạng `nhãn: giá trị`. Biểu mẫu `invoke` truyền mỗi trường làm tham số cùng tên cho
  capability.
- **View state ở lại trên trang.** Bản nháp của biểu mẫu, lựa chọn và trang của danh sách, và câu tìm kiếm đều là view
  state. Không cái nào được gửi đi cho tới khi người dùng gửi hoặc bấm. Lần gửi bị từ chối vẫn giữ nguyên bản nháp.

Trang làm gì:

- Mỗi trường có nhãn thật, phần hướng dẫn và lỗi được nối qua `aria-describedby`, và có `aria-invalid` khi sai. Lỗi
  hiện khi người dùng rời trường, hoặc khi họ thử gửi. Lần gửi còn lỗi thì không gửi gì, nói cần sửa bao nhiêu ô, và
  chuyển focus tới ô đầu tiên.
- Thanh trượt chưa ai kéo thì chưa có giá trị và hiện "Chưa chọn", thay vì gửi vị trí mà con trượt đang nằm.
- Chip có dấu ✓ ngoài màu sắc. Công tắc bật/tắt là `role="switch"`. Mọi trường cao ít nhất 44 px, và nút lớn lên 44 px
  trên màn hình cảm ứng.
- Nút của từng mục chỉ bấm được khi host nói binding chạy được. Nếu không, danh sách nói nó chỉ để xem, thay vì vẽ những
  nút bấm không làm gì. Danh sách có trạng thái đang tải, trống và lỗi.
- Ô tìm kiếm chốt câu tìm 250 ms sau khi ngừng gõ, hoặc ngay khi nhấn Enter. Escape hoặc nút xoá làm trống ô. Câu tìm
  không khớp gì thì bảng hiện trạng thái "không có dòng nào khớp" của chính nó.

Kiểm thử: [form-fields.spec.ts](../packages/contracts/test/form-fields.spec.ts),
[input-primitives.spec.ts](../apps/runtime/test/input-primitives.spec.ts) cho node,
[input-primitives.spec.ts](../packages/conversation-client/test/input-primitives.spec.ts) cho trang, và journey trình
duyệt [input-primitives.spec.ts](../apps/web/e2e/input-primitives.spec.ts), chạy ở 1440 px và ở 375 px có cảm ứng.

### 8.3 Nối các widget trên cùng một bề mặt

Cây bố cục ([widget và extension §4.1](widgets-and-extensions.vi.md#41-trạng-thái-triển-khai-2026-09-17)) đặt các
widget. Đồ thị state nói chúng tác động
lên nhau thế nào: một lựa chọn quyết định biểu đồ vẽ chuỗi nào, một ô tìm kiếm lọc một bảng, các dòng được chọn của một
bảng được đếm thành một con số. Đồ thị là dữ liệu do host sở hữu và kiểm tra, gồm ba phần đóng, trong
[composition-graph.ts](../packages/contracts/src/composition-graph.ts):

- **State**: `props.state` trên `canvas.overview@1`, tối đa 16 khoá, mỗi khoá là `{ "type": "string" | "number" |
  "boolean" | "string-list", "initial": … }`.
- **On**: danh sách `on` của một lá. Mỗi mục nêu một sự kiện mà định nghĩa của lá phát ra, và các bước ghi state:
  `set`, `toggle`, `copy`, `append`, `remove`, `select-field`, `map-field`, `take` và `count`.
- **Feed**: danh sách `feed` của một lá. `{ "op": "query", "key" }` cho bảng hoặc danh sách, `{ "op": "filter-equals",
  "field", "key" }` cho một cột của bảng, `title`, `subtitle` hay `meta` của danh sách, hoặc `series` của biểu đồ.

| Định nghĩa | Sự kiện phát ra | Mang theo |
| --- | --- | --- |
| `canvas.search@1` | `query.change` | `query` |
| `canvas.choice@1` | `choice.change` | `value` |
| `canvas.input@1` | `input.change` | `value` |
| `canvas.list@1` | `selection.change` | `selected` |
| `canvas.table@1` | `row.select` | `rowIds` |
| `canvas.calendar@1` | `date.select` | `date` |

```json
{
  "state": { "metric": { "type": "string", "initial": "completed" } },
  "layout": { "kind": "stack", "children": [
    { "kind": "widget", "widget": "canvas.choice@1",
      "props": { "label": "Chỉ số", "kind": "radio", "options": [
        { "value": "completed", "label": "Việc xong" }, { "value": "created", "label": "Việc tạo" }] },
      "on": [{ "event": "choice.change", "steps": [{ "op": "select-field", "key": "metric", "field": "value" }] }] },
    { "kind": "widget", "widget": "canvas.line@1",
      "feed": [{ "op": "filter-equals", "field": "series", "key": "metric" }] }
  ] }
}
```

Host bảo đảm:

- **Lá không bao giờ gọi tên lá khác.** Nó chỉ nói nó ghi khoá nào và đọc khoá nào, nên hai widget chỉ nối với nhau qua
  một giá trị host giữ và kiểm được.
- **Kiểm trước khi lưu bất cứ thứ gì.** Khoá chưa khai báo, phép toán lạ, sự kiện mà định nghĩa không phát ra, input mà
  lá không đọc, và bước ghi một kiểu mà khoá không chứa được đều bị từ chối kèm lý do, ngay trong lượt đó. Không có
  callback, không có code.
- **Node giữ những gì quy tắc nói.** Mỗi lá có quy tắc `on` được một view binding riêng, operation `state.event`. Trang
  áp dụng sự kiện ngay để người dùng thấy, rồi gửi `{ "event", "payload" }` qua `POST …/widgets/{instanceId}/actions`
  theo revision của bề mặt. Node áp lại đúng các quy tắc đó lên giá trị nó đã lưu và giữ kết quả; trang không thể ghi
  thẳng một giá trị. Sự kiện mà quy tắc không cho phép được trả `400 INVALID_INPUT`, và không có gì của nó được giữ lại.
- **Bản sống và lịch sử khác nhau có chủ đích.** Bề mặt sống đọc lại giá trị của nó sau khi tải lại trang. Bản sao trong
  hội thoại vẽ đồ thị như lúc được ghi lại, với giá trị ban đầu, và vẫn khám phá được ngay trên trang mà không gửi gì đi.
- **Agent đọc giá trị, không đọc trang.** Lần đọc bản sống trả về `semanticState`: các giá trị hiện tại, có giới hạn và
  có kiểu, kèm một dòng tóm tắt. Đó là dữ liệu về view, không bao giờ là chỉ dẫn.
- **Ô tìm kiếm không có đồ thị vẫn như trước.** Nó lọc mọi bảng trong bề mặt ngay trên trang, và không có gì được lưu hay
  gửi đi vì nó.
- Biểu đồ nhận chuỗi từ một lựa chọn sẽ nói nó đang hiển thị chuỗi nào, gọi bằng tên lựa chọn mà người dùng đã chọn.
  Chuỗi mà dữ liệu không có cũng được nêu tên, và biểu đồ giữ chuỗi của chính nó.

Kiểm thử: [composition-graph.spec.ts](../packages/contracts/test/composition-graph.spec.ts) cho các quy tắc,
[composition-graph.spec.ts](../apps/runtime/test/composition-graph.spec.ts) cho trình biên dịch và node,
[surface-graph.spec.ts](../packages/conversation-client/test/surface-graph.spec.ts) cho trang, và journey trình duyệt
[composition-graph.spec.ts](../apps/web/e2e/composition-graph.spec.ts), cũng chạy ở 375 px.

### 8.4 Thẻ trạng thái, tiến độ và chi tiết

Ba định nghĩa chỉ-đọc cho thấy điều model biết về một việc: một trạng thái, việc đó đã tới đâu, hoặc vài thông tin có
nhãn. Đây là hàng "Text / status" của [widgets and extensions §4](widgets-and-extensions.vi.md#4-rich-built-in-catalog)
cho nội dung do model nêu. Chúng không phải thẻ tác vụ, kết nối hay cài đặt của host, vốn vẫn do host sở hữu. Một bộ
hàm duy nhất, trong [status-cards.ts](../packages/contracts/src/status-cards.ts), kiểm props và viết câu chữ. Cả node
lẫn trang đều dùng bộ hàm này, nên trang không bao giờ vẽ một thẻ mà node sẽ từ chối.

| Định nghĩa | Là gì | Props |
| --- | --- | --- |
| `canvas.status@1` | Một trạng thái kèm sắc thái. | `label` (1–120), `tone` (`neutral`, `info`, `success`, `warning`, `danger`), tuỳ chọn `title` (tối đa 200), `detail` (tối đa 500) và `asOf`. |
| `canvas.progress@1` | Tiến độ của một việc: một giá trị trên một mức tối đa, hoặc một danh sách bước. | Hoặc `value` (từ 0 trở lên) cùng `max` (lớn hơn 0) và `unit` tuỳ chọn (tối đa 20), hoặc `steps` (1–12), mỗi bước `{ label (1–120), status, detail? (tối đa 200) }` với status `done`, `current`, `pending`, `failed` hoặc `skipped`. Tuỳ chọn `title` và `label` (mỗi cái tối đa 200) và `asOf`. |
| `canvas.details@1` | Các thông tin có nhãn. | `items` (1–24), mỗi mục `{ label (1–80), value (1–300) }`, không nhãn nào lặp lại. Tuỳ chọn `title` (tối đa 200) và `asOf`. |

Mọi prop chữ đều nằm trên một dòng. Node này tính độ dài theo đơn vị mã UTF-16, nên một ký tự nằm ngoài Mặt phẳng Đa
ngữ Cơ bản, như phần lớn emoji, được tính là hai. `maxLength` của JSON Schema tính theo điểm mã, nên node là bên chặt
hơn: một nhãn gồm 120 emoji vừa với schema theo cách một trình kiểm chuẩn đọc, nhưng node này từ chối nó.

Model đặt từng thẻ bằng `show_view`, hoặc làm lá của một cây bố cục
([widget và extension §4.1](widgets-and-extensions.vi.md#41-trạng-thái-triển-khai-2026-09-17)), nơi cả ba nằm ở vùng
`status`.

Node bảo đảm:

- **Không có gì quay tròn khi chẳng có gì phía sau.** Thẻ tiến độ cần một giá trị và một mức tối đa, hoặc các bước.
  Thẻ không có cái nào, có cả hai, có giá trị vượt mức tối đa, có đơn vị đi kèm các bước, hoặc có hơn một bước đang làm
  đều bị từ chối kèm lý do ngay trong lượt đó, và không instance nào được lưu.
- **Thứ được vẽ là thứ được đọc.** Một prop chữ không được chứa dấu xuống dòng, ký tự điều khiển, ký tự điều khiển
  hướng chữ (U+202A–U+202E, U+2066–U+2069, U+200E, U+200F, U+061C), ký tự vô hình (U+200B, U+FEFF, U+00AD, U+180E,
  U+2060–U+2064, U+FFF9–U+FFFB), ký tự tag (U+E0000–U+E007F) hay ký tự lấp chỗ Hangul (U+115F, U+1160, U+3164,
  U+FFA0). Mỗi ký tự như vậy làm điều mà trình đọc màn hình, bản ghi hội thoại hay lượt sau đọc được khác với điều trang
  vẽ ra. Lời từ chối nêu tên ký tự, ví dụ
  `property "label": contains U+202E, a control that changes text direction …; remove it`. ZWJ, ZWNJ và các bộ chọn biến
  thể vẫn được dùng, vì chữ viết và emoji cần chúng. JSON Schema của định nghĩa mang cùng quy tắc dưới dạng `pattern`,
  nên model đọc được nó trước khi thử. Pattern được viết theo cách node này biên dịch nó, không có cờ `u`, khi đó một ký
  tự tag là một cặp đơn vị UTF-16; trình kiểm nào thêm cờ `u` sẽ để ký tự tag lọt qua pattern, và phần kiểm riêng của
  node vẫn từ chối chúng. Pattern quyết định mọi dòng trong thời gian tuyến tính theo độ dài của dòng. Chữ được cắt
  khoảng trắng hai đầu và chuẩn hoá NFC trước khi kiểm một nhãn có rỗng hay bị lặp.
- **Mốc "tính đến" không bao giờ mơ hồ.** `asOf` là một ngày (`2026-09-30`) hoặc một thời điểm có `Z` hay độ lệch múi
  giờ (`2026-09-30T07:30:00+07:00`). Giờ địa phương không có độ lệch, hoặc ngày không tồn tại, đều bị từ chối.
- **Text alternative là chính lời của thẻ.** Nó được dựng từ props, ví dụ
  `Build: Flaky (warning). 2 retries (as of 2026-09-30)` hoặc `Photos: 42 of 120 photos (35%)`, và caption không thay
  thế được nó. Một section của bố cục chứa thẻ cũng dùng đúng những lời đó.
- **Câu chữ có giới hạn.** Một snapshot mà hội thoại không đọc lại được sẽ khiến cả hội thoại không mở được, nên node
  kiểm mọi snapshot trước khi lưu. Câu chữ của một thẻ giữ trọn từng thông tin hay từng bước trong 4000 ký tự, và kết
  thúc bằng `…and N more facts` (hoặc steps) khi có phần không vừa. Một section của bố cục giữ tối đa 2000, và câu chữ
  của cả bố cục kết thúc bằng `… (shortened)` khi vượt 4000. Lời riêng của mọi widget khác, như các tiêu đề của một danh
  sách, cũng được rút gọn như vậy. Chỉ caption do model viết mà dài hơn 4000 ký tự mới bị từ chối, vì chỉ model mới nói
  gọn lại được. Instance, action binding và snapshot của nó được ghi trong cùng một transaction, nên một lần từ chối
  không để lại thứ nào.
- **Một snapshot không đọc được không làm đóng hội thoại.** Một snapshot được lưu từ trước khi có các bước kiểm này có
  thể là thứ node không đọc lại được. Hội thoại vẫn mở: khối đó nói rằng nó không đọc được và phần còn lại của hội thoại
  vẫn được giữ, các khối khác vẫn được vẽ như thường, và node ghi log snapshot nào bị lỗi.
- **Con số không bao giờ nói quá.** Phần trăm được làm tròn, và hiện 99% chứ không phải 100% khi giá trị vẫn còn dưới
  mức tối đa.
- **Voice và `inspect_ui` đọc điều đã được nêu, không phải số đo trực tiếp.** Tài liệu ngữ nghĩa (§9) được dựng từ
  props. Summary của nó ghi "as stated when shown", và freshness là `unknown` chứ không phải `live`. Thẻ không có action
  và không có state.

Trang làm gì:

- Sắc thái là một chữ trong badge, đặt cạnh một ký hiệu, nên màu sắc không bao giờ là tín hiệu duy nhất. Mỗi bước hiện
  trạng thái bằng chữ, và bước đang làm mang `aria-current="step"`.
- Giá trị trên mức tối đa là một `role="progressbar"` có `aria-valuemin`, `aria-valuemax`, `aria-valuenow` và
  `aria-valuetext` khớp với con số trên màn hình.
- `asOf` là một ngày thì hiện đúng ngày đó. Một thời điểm thì hiện theo múi giờ và ngôn ngữ của người đọc, sau chữ
  "Tính đến".
- Thẻ trông như một số đo sẽ nói nó hiện lời của ai. Thẻ tiến độ luôn kết thúc bằng "Theo Clark lúc 09:30", và thẻ
  trạng thái cũng vậy khi không có `asOf`. Thời điểm là lúc tin nhắn được lưu, theo ngôn ngữ của người đọc, kèm ngày khi
  không phải hôm nay. Model được dặn không dùng thẻ trạng thái hay thẻ tiến độ cho tác vụ và lượt chạy của chính node,
  vốn đã có thẻ trực tiếp. Trong Widget Library, một fixture ghi "Mẫu" ở chỗ đó, vì không ai nêu nó.
- Thẻ không có badge độ mới, vì thứ nó hiện là điều model đã viết. Nó không có nút điều khiển nào và không tự thêm
  chuyển động.
- Phần chi tiết xếp thành hai cột thẳng hàng, cột nhãn chiếm tối đa 40% thẻ. Khi chính thẻ hẹp hơn 360 px, trên điện
  thoại hay khi là một ô của lưới, mỗi giá trị xuống dưới nhãn của nó. Giá trị dài thì xuống dòng thay vì làm trang rộng
  ra.
- Props mà trang không đọc được, như một nhãn có dấu xuống dòng do node cũ lưu, thì hiện trạng thái lỗi, thay vì một thẻ
  đoán mò.

Kiểm thử: [status-cards.spec.ts](../packages/contracts/test/status-cards.spec.ts) cho các quy tắc,
[status-cards.spec.ts](../apps/runtime/test/status-cards.spec.ts) cho node,
[status-cards.spec.ts](../packages/conversation-client/test/status-cards.spec.ts) cho trang, và journey trình duyệt
[status-cards.spec.ts](../apps/web/e2e/status-cards.spec.ts), chạy ở 1280 px với giao diện tối và sáng, ở 390 px có
cảm ứng, khi là các ô của một lưới được yêu cầu ba cột (vẽ thành hai cột trong cột hội thoại ở 1280 px, vì lưới không
bao giờ tạo cột hẹp hơn 220 px, và một cột trên điện thoại), và trong Widget Library. Quy tắc về ký tự ẩn nằm trong
[text-rules.ts](../packages/contracts/src/text-rules.ts), được kiểm bởi
[text-rules.spec.ts](../packages/contracts/test/text-rules.spec.ts), và
[status-card-schemas.spec.ts](../packages/widget-catalog/test/status-card-schemas.spec.ts) kiểm rằng JSON Schema và
bộ kiểm của chính thẻ chấp nhận và từ chối cùng những props như nhau.

### 8.5 Mã, diff và tệp

Ba định nghĩa hiển thị một phần công việc: một khối mã, một bản diff dạng unified và một tệp. Mọi thứ trên thẻ là những
gì model viết vào props, được kiểm theo một mô tả chung trong
[artifact-viewers.ts](../packages/contracts/src/artifact-viewers.ts) mà node và trang cùng dùng. Không thẻ nào tải, mở
hay liên kết tới thứ gì. Thẻ artifact và thẻ diff của chính node vẫn do host sở hữu và được dựng từ bản ghi của node. Ba
thẻ này là thẻ catalog mà model đặt bên cạnh chúng.

| Định nghĩa | Nó là gì | Model đặt nó thế nào |
| --- | --- | --- |
| `canvas.code@1` | Một khối mã có số dòng, được tô màu, và một nút sao chép. | `show_view` với `props.code` (tối đa 20.000 ký tự và 400 dòng), và tuỳ chọn `path`, `language`, `startLine` (số của dòng đầu tiên, khi là một đoạn trích) và `truncated`. Khi không có `language`, thẻ lấy nó từ phần mở rộng của đường dẫn. |
| `canvas.diff@1` | Một bản diff dạng unified: các hunk của từng tệp, mỗi dòng có số dòng cũ, số dòng mới và một dấu. | `show_view` với `props.files` (1–20). Mỗi tệp có `path`, `oldPath` tuỳ chọn khi đổi tên, và các hunk (1–20 mỗi tệp) gồm `oldStart`, `newStart`, `section` tuỳ chọn, và `lines` dạng `{ kind: "add" \| "remove" \| "context", text }`. Tổng cộng tối đa 600 dòng và 40.000 ký tự, mỗi dòng tối đa 1.000 ký tự. |
| `canvas.file@1` | Một tệp, được nêu tên và mô tả. | `show_view` với `props.name`, và tuỳ chọn `mediaType` (`type/subtype`), `sizeBytes`, `source` (bằng lời), `path` (dạng chữ) và `summary`. |

Node bảo đảm:

- **Từ chối trước khi lưu bất cứ thứ gì.** Props không khớp bị từ chối kèm lý do, ngay trong lượt đó, và không để lại
  instance nào. Mã hoặc diff vượt một giới hạn bị từ chối kèm lý do nêu rõ giới hạn đó và chỗ bị vượt (độ dài hay số
  dòng của mã, số hunk của một tệp, một dòng của một hunk, hay tổng của cả bản diff), và yêu cầu model cắt bớt rồi đặt
  `truncated`. Diff còn bị từ chối khi có hunk không thay đổi gì, hunk ở dòng cũ 0 mà vẫn giữ hoặc bớt dòng, hunk ở
  dòng mới 0 mà vẫn giữ hoặc thêm dòng, các hunk chồng lên nhau hoặc sai thứ tự, và một tệp được nêu hai lần. Thẻ tệp
  bị từ chối khi tên có kèm thư mục, và khi `path` là một URL (bất cứ thứ gì bắt đầu bằng một scheme như `https:` hay
  `file:`; ổ đĩa Windows như `C:\` là đường dẫn và được giữ nguyên). Thuộc tính lạ, như `url` hay `href`, cũng bị từ
  chối.
- **Các hunk khớp với nhau.** Mỗi hunk sau hunk đầu phải bắt đầu đúng chỗ các hunk phía trên để lại tệp: nếu chúng đưa
  dòng cũ 30 thành dòng mới 32, thì hunk kế tiếp bắt đầu ở dòng cũ 40 phải bắt đầu ở dòng mới 42. Bước kiểm này được bỏ
  qua khi có `truncated`, vì một phần thay đổi có thể đã bị bỏ ra, và với hunk có số đếm 0 ở một phía, vì diff dạng
  unified đánh số hunk chỉ thêm hoặc chỉ bớt từ dòng ngay trước nó.
- **Chữ một dòng giữ nguyên một dòng và cho thấy những gì nó chứa.** Đường dẫn, tên, tiêu đề, section, nguồn và loại
  media bị từ chối nếu chứa ký tự xuống dòng, ký tự điều khiển hướng chữ (U+202A–U+202E, U+2066–U+2069) hay ký tự vô
  hình có thể khiến chữ đọc khác với vẻ ngoài (U+200B, U+200E, U+200F, U+2028, U+2029, U+0085, U+FEFF). Lý do nêu tên
  ký tự đó. Ký tự nối và không nối độ rộng 0 (U+200D, U+200C) được giữ, vì emoji và nhiều hệ chữ cần chúng. `summary`
  của tệp được phép nhiều dòng nhưng vẫn bị từ chối với cùng các ký tự ẩn đó.
- **Ký tự xuống dòng trong mã là một dòng.** `\r\n`, `\r`, U+2028, U+2029 và U+0085 trong mã đều được tính là xuống
  dòng và được lưu thành `\n`, nên số dòng khớp với các dòng người dùng thấy và giới hạn 400 dòng cũng đếm chúng. Một
  dòng của diff bị từ chối nếu chứa bất kỳ ký tự xuống dòng nào: mỗi dòng của diff được đưa thành một dòng riêng.
- **Số đếm lấy từ các dòng.** Tiêu đề `@@ -a,b +c,d @@` của mỗi hunk và mọi số dòng thêm, bớt đều được tính từ chính các
  dòng, nên một bản diff không thể nói có nhiều hay ít thay đổi hơn những gì nó hiển thị.
- **Phương án chữ là chính nội dung.** Khi không có renderer, người đọc nhận được mã, bản diff kèm tiêu đề hunk, hoặc
  tên, loại, kích thước và nguồn của tệp. Nó được cắt ở 4.000 ký tự, kèm ghi chú còn bao nhiêu ký tự nữa trên thẻ, và
  không bao giờ cắt giữa một ký tự. Chú thích (caption) không được dùng thay cho nó. Ký tự ẩn trong mã hay trong một
  dòng diff được viết ở đó thành `⟨U+202E⟩` thay vì được áp dụng, kèm một dòng cho biết có bao nhiêu ký tự như vậy.
- **Những gì voice và lượt kế tiếp đọc không có phần thân.** Tài liệu ngữ nghĩa nêu đường dẫn, ngôn ngữ và khoảng dòng
  của mã, các tệp và số đếm của diff, và tên, loại, kích thước của tệp. Nó không bao giờ chứa mã hay chính các dòng,
  nhưng có nói mã hay diff chứa bao nhiêu ký tự ẩn. Độ mới của nó là `unknown`: thẻ hiển thị những gì model viết lúc
  đặt thẻ, và không có gì được đọc lại.
- **Không phải lá của layout.** Chúng thuộc họ `artifact`, không vùng layout nào đọc họ này. Model đặt từng thẻ riêng.

Trang làm gì:

- Mã và diff được hiển thị dạng chữ. Bộ tô màu chỉ tách chữ thành token và escape nó. Kết quả được dựng thành phần tử
  React, nên mã trông giống markup, kể cả `<script>`, vẫn hiển thị đúng các ký tự của nó.
- Ký tự điều khiển hướng chữ, ký tự vô hình, ký tự thẻ hay ký tự lấp chỗ Hangul trong mã hoặc một dòng diff (chính
  những ký tự mà một trường một dòng từ chối, ở §8.4) được vẽ thành một dấu hiệu nhìn thấy được, như `⟨U+202E⟩`, có
  tooltip cho biết đó là loại ký tự gì, thay vì được áp dụng. Ký tự thẻ dài hai đơn vị UTF-16 và được vẽ thành một dấu
  hiệu duy nhất. Khi đó thẻ có thêm một dòng cảnh báo
  rằng nó chứa ký tự ẩn có thể khiến nội dung đọc khác với vẻ ngoài. Đây là trường hợp "Trojan Source", khi một ký tự
  điều khiển hướng chữ khiến mã chạy khác với cách nó được đọc.
- Khối dài cuộn bên trong một vùng có giới hạn (tối đa `min(24rem, 60vh)`), không xuống dòng và không làm trang rộng
  ra. Vùng đó là một region có tên mà bàn phím tới được và cuộn được, với vòng focus vẽ ở bên trong để góc bo của thẻ
  không cắt mất nó.
- Nút sao chép đưa chính đoạn mã vào clipboard. Nút được đặt tên theo thứ nó sao chép ("Sao chép mã:
  src/auth/role.ts"), bắt đầu bằng chữ hiện trên nút. Nó nói bằng lời việc sao chép có thành công không, và nếu không
  thì hướng dẫn người dùng tự chọn đoạn mã rồi sao chép. Lời đó nằm trong một vùng trạng thái có sẵn trên thẻ từ đầu và
  không chiếm chỗ khi trống, và mỗi kết quả thay cho kết quả trước, nên cùng một lời được đọc lại ở lần thử thứ hai.
- Trong diff, mỗi dòng được phân biệt bằng dấu và nền, không chỉ bằng màu. Trình đọc màn hình nghe loại và số của mỗi
  dòng bằng lời ("Thêm, dòng mới 41:") trước nội dung dòng; các dấu và số mà nó sẽ đọc từng ký tự một được ẩn khỏi nó.
  Tệp đổi tên có ghi tên cũ.
- Thẻ tệp không có liên kết, không có nút mở, không có nút tải về. Nó nói điều đó bằng lời, thay vì vẽ một nút không
  làm gì.
- Khi có `truncated`, thẻ nói rằng đây không phải toàn bộ mã hay toàn bộ diff.

Kiểm thử: [artifact-viewers.spec.ts](../packages/contracts/test/artifact-viewers.spec.ts) cho các quy tắc,
[artifact-viewers.spec.ts](../apps/runtime/test/artifact-viewers.spec.ts) cho node,
[artifact-viewers.spec.ts](../packages/conversation-client/test/artifact-viewers.spec.ts) cho trang, và journey trình
duyệt [artifact-viewers.spec.ts](../apps/web/e2e/artifact-viewers.spec.ts). Journey chạy với cả hai theme, khi giảm
chuyển động, ở 390 px có cảm ứng, và trong thư viện. Nó cũng kiểm ký tự ẩn được vẽ thành dấu hiệu kèm cảnh báo, ký tự
phân dòng (line separator) trong mã mà số dòng vẫn nằm cạnh đúng dòng, ký tự xuống dòng trong một dòng diff bị từ chối,
lần sao chép bị trình duyệt từ chối, và vòng focus phải được vẽ bên trong vùng cuộn.

---

## 9. Semantic contract cho voice và lượt kế tiếp

Những gì widget đang hiển thị đến được với Clark theo hai đường, cả hai đều dựng từ một tài liệu cho mỗi widget:

- **Voice** đọc summary, lựa chọn và các giá trị của widget đang được focus trước khi quyết định một câu nói có nghĩa gì.
- **Lượt gõ hoặc nói kế tiếp** kết thúc bằng một ghi chú ngắn về các widget mà người dùng đã thay đổi trong cuộc trò
  chuyện này. Khi người dùng chọn, tìm hay lưu trên một widget, không có lượt nào được bắt đầu và không có tin nhắn nào
  được ghi: node chỉ ghi nhận widget đã được chạm vào, rồi tính xem thay đổi đó có nghĩa gì khi lượt kế tiếp bắt đầu.

Tài liệu gồm một summary, vài giá trị có tên (khoảng thời gian, chuỗi số liệu được chọn, từ khóa tìm, trang), các
selected ID và những action widget đang cung cấp. Tài liệu ở dạng chuẩn tắc và có giới hạn: tối đa 16 giá trị, danh
sách 12 mục ngắn, 20 selected ID, 12 action và tổng cộng 4 KB. Ký tự điều khiển và ký tự đổi chiều văn bản bị loại bỏ,
mọi thứ trông giống secret đều bị che. Revision chỉ tăng khi tài liệu thay đổi, nên lưu lại cùng một giá trị, một lần
lưu chỉ thuộc view hay mười lần sửa giữa hai lượt đều được tính là một thay đổi hoặc không thay đổi nào.

Ghi chú được nối vào sau mọi thứ khác trong lượt mới và không bao giờ viết lại ngữ cảnh trước đó, nên phần prefix mà
provider đã cache không đổi. Một session chưa thấy widget sẽ được cho biết toàn bộ tài liệu; một session đang tiếp tục
chỉ được cho biết phần đã đổi (`query: "" → "acme"`); một session đã thấy revision hiện tại thì không được cho biết gì.
Ghi chú nêu tối đa ba widget trong khoảng 2.400 ký tự và nói rõ khi nó bỏ bớt phần nào. Model có thể đọc phần còn lại,
chỉ trong cuộc trò chuyện này, bằng tool chỉ-đọc `inspect_ui`. Ghi chú được đánh dấu là dữ liệu từ màn hình, không phải
chỉ dẫn.

Ai viết tài liệu:

- **Surface dựng sẵn và surface ghép** được host mô tả từ state nó lưu: khoảng thời gian, ngày được chọn và các giá trị
  graph đã khai báo.
- **Widget chạy trong frame riêng** đề xuất summary, selected ID và giá trị bằng
  `semantic.publish(summary, selectedIds, values?)`. Host gửi lần publish cuối của một loạt sau 250 ms, kiểm tra theo
  schema chặt (`POST …/widgets/{instanceId}/semantic`), làm sạch và đánh dấu đó là lời của chính widget. Frame không
  được nêu action: action luôn lấy từ binding của instance, nên frame không thể quảng cáo một action mà nó không được
  bind.

Voice và click phải gọi cùng action binding/state path.

Không publish raw DOM, hidden text, full dataset hoặc secret chỉ để voice “hiểu màn hình”.

Ví dụ, từ một frame:

    semantic.publish(
      "Calendar for September 2026; September 20 selected.",
      ["2026-09-20"],
      { view: "month", month: "2026-09" }
    )

Test: [widget-semantic.spec.ts](../packages/contracts/test/widget-semantic.spec.ts) cho tài liệu và ghi chú,
[widget-semantic.spec.ts](../apps/runtime/test/widget-semantic.spec.ts) cho prompt, các route và `inspect_ui`, và
journey trình duyệt [widget-semantic.spec.ts](../apps/web/e2e/widget-semantic.spec.ts).

---

## 10. Widget SDK surface

Author-facing target:

    props.read()
    props.subscribe()

    state.get()
    state.update(expectedRevision, patch)

    events.emit(name, payload)

    actions.invoke(bindingId, input, invocationId)
    actions.availability()
    actions.subscribe(handler)

    capabilities.request(ref, justification)

    host.focus()
    host.resize({ height })
    host.requestPin()
    host.requestDetach()
    host.openExternal(approvedUrl)

    semantic.publish(summary, selectedIds, values?)

    lifecycle.onMount()
    lifecycle.onSuspend()
    lifecycle.onResume()
    lifecycle.onDispose()

Kiểu đã ship là `WidgetAuthorApi` trong `packages/widget-sdk/src/index.ts`. Host làm gì với chúng:

- `actions.invoke` resolve với text output của service khi binding gọi một package service
  (xem [§4](#4-package-manifest)), và với `undefined` trong các trường hợp khác. Nó reject kèm lý do của host, kể cả
  khi action đang chờ approval card. Mỗi lời gọi được trả lời theo `invocationId` của riêng nó, nên hai lời gọi của cùng
  một binding kết thúc độc lập. Khi lý do nói yêu cầu đã tới service, service có thể đã làm một phần.
- `actions.availability()` trả về điều host nói gần nhất về từng binding có service phía sau: `available`, và lý do khi
  không available. `actions.subscribe(handler)` được gọi khi điều đó thay đổi. Host chỉ gửi thông tin này cho binding
  có service phía sau, và chỉ khi câu trả lời thay đổi. Hãy vô hiệu hoá control đó và hiển thị lý do; phần còn lại của
  widget vẫn hoạt động.
- `host.resize({ height })` được host tôn trọng: host đặt chiều cao frame theo yêu cầu, giới hạn trong 80–1200 px.
  Frame mở ở 200 px cho tới khi widget yêu cầu.
- Các message host gửi trước khi runtime của SDK load xong được đệm lại và phát lại đúng thứ tự, nên message
  availability đến sớm không bị mất.

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

Mỗi mục trong `permissions.networkOrigins` phải là đúng một origin ở dạng chuẩn,
`scheme://host[:port]`: `https` hoặc `wss`; `http`/`ws` chỉ được phép với `localhost`,
`127.0.0.1` và `[::1]`. Wildcard, path, query, thông tin đăng nhập, khoảng trắng, `;` hoặc `,`,
và dạng không chuẩn (`https://API.example.com`, `https://example.com:443`) bị từ chối ngay khi
đọc manifest, vì giá trị này được đưa nguyên văn vào `connect-src` của tài liệu widget. Danh
sách rỗng nghĩa là `connect-src 'none'`.

Tài liệu widget được phục vụ với `sandbox allow-scripts` trong CSP, ngoài thuộc tính sandbox
trên frame, nên nó vẫn ở origin mờ (opaque) kể cả khi được mở trực tiếp. Chỉ node phục vụ nó mới
được nhúng nó (`frame-ancestors 'self'`), cộng thêm origin của giao diện khi giao diện chạy ở nơi
khác: `CC_APP_ORIGIN` khai báo origin đó (ví dụ `http://127.0.0.1:5173` cho `pnpm dev:web`;
bước setup local tự ghi giá trị này). Node kiểm tra `CC_APP_ORIGIN` lúc khởi động và từ chối chạy
nếu nó không phải một origin `http(s)` trần. Header `Host` của request không bao giờ được dùng.

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
chạy: instance chuyển offline với text fallback, state và snapshot được giữ. Việc này áp dụng cho mọi widget mà manifest
khai báo, kể cả widget có definition node này không nạp được và widget của package không còn file trên node: id lấy từ
các facet `ui` của manifest và từ danh sách node ghi lại lúc cài package. **Khôi phục** kích hoạt lại đúng
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
từ chối version vi phạm quy tắc ở §20. File này là mốc so sánh nên cần được commit cùng source; nếu đã có
`dist/directory-entry.json` mà thiếu file này (clone mới, dọn `dist`), publish cảnh báo rằng version chưa được kiểm tra.

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
- Product UX: DESIGN.vi.md.
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
lệ có thư mục `.git` lồng bên trong (một checkout vendor hoá) vẫn được hash đầy đủ. Path tương đối của mỗi file được
hash và sắp xếp với dấu phân cách `/` trên mọi hệ điều hành, nên một package có cùng một digest trên Windows, macOS và
Linux: digest mà directory publish từ máy POSIX vẫn khớp khi cài trên Windows.

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

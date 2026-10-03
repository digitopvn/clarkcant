# ClarkCant Widget Developer Standard

> [English](widget-development.md) (mặc định) · Tiếng Việt

> Trạng thái: canonical authoring target cho widget ecosystem.
> Cập nhật: 2026-10-01.
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
`card`, `response`, `modal`). Tài liệu khai báo `appearanceApi.min` là 2 (`{ "min": 2, "max": 2 }`) còn có thể đặt phần
còn lại của diện mạo, mỗi thứ bằng một cái tên hoặc một con số có giới hạn mà chính host biến thành CSS: `typography`
(`body` và `display` chọn trong `clark`, `system`, `serif`, `rounded`, `mono`; `mono` chọn trong `clark`, `typewriter`;
`headingWeight` từ 400 đến 800, theo bước 100), `border` (`width` từ 1 đến 3, `style` là `solid` hoặc `dashed`),
`shadow` (`style` là `soft`, `hard` hoặc `none`; với bóng cứng thì `offset` từ 1 đến 8 và `color` là `text`, `border`
hoặc `accent`), `motion` (`speed` từ 0,5 đến 2, `easing` là `standard`, `snappy`, `linear` hoặc `stepped`),
`icons.stroke` (từ 1 đến 2,5), `radius.field`, `recipes` (mỗi thành phần một kiểu: `button`
`quiet`/`outlined`/`solid`/`raised`/`beveled`, `card` `flat`/`outlined`/`raised`, `input`
`quiet`/`filled`/`outlined`/`underlined`, `modal` `floating`/`framed`, `badge` `pill`/`rounded`/`square`, `composer`
`floating`/`integrated`/`framed`), `effects` (`backdrop.kind` là `dot-grid`, `hard-grid`, `scanlines`, `grain` hoặc
`paper` với `intensity` từ 0 đến 1 và `scale` từ 8 đến 48 px; `surface.kind` là `glass`, `soft-glow`, `paper` hoặc
`grain` với `intensity` từ 0 đến 1; kính phủ thẻ widget và ô soạn tin bằng lớp màu mờ đục và chỉ trong suốt, làm mờ
nền trên hộp thoại, còn ánh sáng theo con trỏ trên nền chỉ mạnh bằng lớp nền) và `orb` (`profile` là một trong các
kiểu Orb có sẵn, kèm `palette` tuỳ chọn gồm các bộ ba màu từ 0 đến 1 cho mọi kênh của Orb trừ `canvas`, kênh do trang
cung cấp; nó chỉ có tác dụng khi người dùng chưa từng tự chọn Orb). Các giới hạn là các hằng số trong
`packages/contracts/src/themes.ts`. Tài liệu dùng bất kỳ trường nào trong số này mà `appearanceApi.min` là 1 sẽ bị từ
chối, vì bản dựng chỉ biết phiên bản 1 không vẽ được nó. Ngoài ra không có gì khác: không CSS, không selector, không tệp
font, không ảnh. Node đọc nó từ các byte đã cài qua cùng cơ chế giới hạn như tệp của
widget, từ chối tài liệu lớn hơn 64 KiB, và kiểm tra nó (`packages/core/src/installed-themes.ts`); theme không qua được
kiểm tra sẽ được liệt kê kèm lý do, và các theme khác của gói vẫn được nạp. Theme hợp lệ còn phải qua bài kiểm tra tương
phản mà Clark Default phải qua, ở cả hai chế độ màu (`requiredPairs` trong `packages/design-tokens/src/contrast.ts`),
và bài kiểm tra trạng thái được bảo vệ (`packages/design-tokens/src/protected.ts`): màu nguy hiểm, cảnh báo, thành công
và màu nhấn phải khác nhau, màu trạng thái phải khác màu chữ, vòng focus phải khác màu viền, chữ bị vô hiệu hoá phải
khác chữ thường, viền phải thấy được trên thẻ và trên nền trang, chữ, màu trạng thái, màu nhấn và vòng focus phải đọc
được trên bề mặt có hiệu ứng và trên nền trang dưới lớp nền cùng ánh sáng theo con trỏ (hộp thoại được đo trên nền
trang sáng nhất và tối nhất mà lớp phủ của nó có thể che, nên kính quá mạnh hay hoa văn dày được chiếu sáng sẽ bị từ
chối), và ánh sáng của Orb phải thấy được trên nền trang. Theme không đạt một trong hai bài kiểm tra sẽ được liệt kê
kèm những gì không đạt và không chọn được, nên hãy kiểm tra cả hai chế độ màu trước khi phát hành. Vòng focus, điều
khiển bị vô hiệu hoá, các thẻ của chính host (đường viền, bề mặt trơn và các nút của chúng: recipe nút không bao giờ
chạm tới nút Phê duyệt và Từ chối của một yêu cầu, các câu trả lời trong hộp thư hay nút Dừng) và chế độ giảm chuyển động, dù đến
từ hệ thống hay từ Cài đặt, luôn do host quyết định, dù theme nói gì. Theme được chọn bằng
`package:<package id>#<theme id>`, và một gói chỉ có theme là một lần làm mới UI, không bao giờ khởi động lại Pi. Theme đã
cài xuất hiện ở Cài đặt → Trải nghiệm → Chủ đề.

**Gói tham chiếu.** [Pixel Arcade](../examples/themes/pixel-arcade/README.md) và
[Neo Brutalism](../examples/themes/neo-brutalism/README.md) là gói tổng quát chỉ chứa dữ liệu, cài qua vòng đời
package hiện có rồi chọn trong Cài đặt → Trải nghiệm. Pixel Arcade có khung vuông, nút vát cạnh, nền đường quét
có giới hạn, chuyển động theo bước và Orb Plasma mặc định; Neo Brutalism có viền dày, bóng cứng lệch, tiêu đề đậm,
nút nổi và Orb Glass mặc định. Cả hai dùng profile phông do host sở hữu với fallback hệ thống, không đóng gói tệp
phông hay tài nguyên kiểu bên ngoài. Manifest mỗi gói ghi nguồn và giấy phép; dữ liệu theme nguyên gốc dùng
Apache-2.0. Lựa chọn Orb riêng và giảm chuyển động vẫn có ưu tiên cao hơn. Clark Default giữ nguyên. Ví dụ trong
checkout này không phải tuyên bố đã xuất bản trên marketplace.

**Tạo chủ đề và Theme Lab.** CLI package hiện có nhận `clark theme init <dir>`, `dev [dir] [--port <port>]`,
`test [dir]` và `pack [dir]`. Từ checkout, chạy `node packages/widget-cli/src/cli.ts theme <command>`.
Init tạo manifest tổng quát và `themes/main.json`, từ chối thư mục không rỗng. Dev mặc định dùng cổng loopback 4319,
phục vụ dữ liệu đã kiểm tra và preview sản phẩm chung, nạp lại bản sửa, giữ draft preview và đóng watcher khi Ctrl-C.
Nó chỉ nhận origin của chính nó và không ghi preference runtime. Preview dùng component sản phẩm: transcript,
composer, điều khiển, thẻ/widget, Cài đặt, modal, phê duyệt/lỗi/trạng thái và Orb, với ví dụ cục bộ được ghi rõ.
Có thể xem chế độ màu, viewport thường/điện thoại/gọn, giảm chuyển động, token đã biên dịch, recipe và kết quả kiểm tra.

Test dùng bộ đọc chủ đề đã cài, compiler và cả hai phép kiểm tra trên tài liệu bất kỳ: manifest, tệp thường trong gói,
typography có giới hạn, thời lượng/easing giảm chuyển động và không có style thực thi hay tài nguyên từ xa. Symlink
trong gói bị từ chối. Gói thuần chủ đề không cần quyền đặc biệt và không chứa script, CSS, HTML hay payload thực thi;
facet khác giữ trust lane riêng. Bố cục/bàn phím browser ghi rõ `requires-dev-host`, không tự động đạt. Pack dùng cùng
artifact bất biến và hash tệp như widget, thêm digest tài liệu chủ đề, ghi kiểm tra chưa làm. Thay đổi nội dung cùng
phiên bản đã pack bị từ chối.

Cài đặt → Trải nghiệm → Duyệt chủ đề mở cùng Lab, giữ hội thoại thật và focus. Preview chỉ đọc; Dùng chủ đề này ghi
preference chuẩn. Bộ ghi đã đăng ký lưu sáu lựa chọn gần đây khác nhau. Màu nhấn và mật độ dùng compiler/snapshot
chung, gồm widget và bề mặt detached. Màu nhấn là cặp hex tối/sáng đã kiểm tra hoặc `null` để dùng màu chủ đề; tương
phản và trạng thái bảo vệ phải đạt trước khi lưu. Nếu bản cập nhật làm màu đã lưu không an toàn, màu của chủ đề được
vẽ với fallback rõ ràng và lựa chọn cũ vẫn giữ. Mật độ gọn giữ typography, giới hạn bố cục và padding nhỏ. Đặt lại tùy
chỉnh đặt lại màu nhấn, mật độ, chuyển động và Orb, giữ chủ đề, chế độ màu và ngôn ngữ; giảm chuyển động hệ điều hành
luôn thắng.

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

Service chạy với tài nguyên gì, và gọi tới nhà cung cấp mà không giữ key ra sao, nằm ở §14.1 và §14.2. Chưa xây: cô
lập bằng VM, và gọi service trên node khác. Model gọi được service của
package ngay trong cuộc trò chuyện bằng cách đặt nút hành động chung với action `invoke` (§8.1). Journey trình duyệt
[`service-facet.spec.ts`](../apps/web/e2e/service-facet.spec.ts) vẫn tạo widget riêng của package kèm binding `invoke`
qua một fixture model.

**Kết nối tài khoản.** Một facet `tools` có thể khai báo `connection` khi service của nó làm việc trên tài khoản của một
người tại một nhà cung cấp ([service-connection.ts](../packages/contracts/src/service-connection.ts)):

```json
"connection": {
  "version": 1,
  "provider": "fake.tasks",
  "displayName": "Fake Tasks (test fixture)",
  "flow": "oauth-pkce",
  "authorization": {
    "authorizationEndpoint": "http://127.0.0.1:8880/oauth/authorize",
    "tokenEndpoint": "http://127.0.0.1:8880/oauth/token",
    "revocationEndpoint": "http://127.0.0.1:8880/oauth/revoke",
    "clientId": "connected-app-dev"
  },
  "scopes": [
    { "scope": "tasks.read", "purpose": "Lists your tasks." },
    { "scope": "tasks.write", "purpose": "Renames a task when you ask." }
  ],
  "endpoints": ["http://127.0.0.1:8880"],
  "probe": { "url": "http://127.0.0.1:8880/api/me" }
}
```

Luồng duy nhất là authorization code với PKCE, nên package không bao giờ mang client secret, và client id là công khai.
Mọi URL phải dùng HTTPS trừ khi là địa chỉ loopback. Probe phải nằm trên một endpoint đã khai báo. Một package khai báo
nhiều nhất một connection, và một endpoint không thể đồng thời là origin của `egress`, nên mỗi origin chỉ có một
credential. Capability nêu các scope nó cần trong `requiredScopes`; mỗi scope phải là scope mà connection có xin. Host
kết nối tài khoản và ký request của service ra sao nằm ở §14.6.

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
| `agent` | Mở một lượt trong cùng cuộc trò chuyện với tin nhắn đúng bằng nhãn; `intent` được gửi kèm cho model, cùng ngữ cảnh mà `contextRefs` chỉ ra, do host đọc. Câu trả lời là kết quả của lần bấm. Với `background: true`, yêu cầu đi vào làn chạy nền của node, và kết quả tới cuộc trò chuyện và hộp thư. | Bản thân việc mở lượt không thay đổi gì; lượt đó làm gì tiếp thì tự đi qua policy. `contextRefs` được kiểm theo ngữ pháp đóng và theo người đặt nút. |
| `invoke` | Gọi một capability của package service qua `invokeCapability`, cùng đường với tool `invoke_capability` của agent và giọng nói, trong hạn chót của binding. | Effect category của chính capability và thế hệ package đang phục vụ nó; tham số được kiểm theo input schema. |
| `workflow` | Chạy các bước theo thứ tự `dependsOn` trong một hạn chót chung, và dừng ở bước đầu tiên không hoàn tất. | Category nặng nhất trong các bước; mỗi bước `invoke` phải do một service đang chạy phục vụ. Mọi bước `invoke` phải gọi capability của cùng một package, và binding ghim thế hệ của package đó; workflow trải qua nhiều package bị từ chối khi biên dịch, nên hãy làm mỗi package một nút. |

Binding digest bao gồm đề xuất, thế hệ package, effect category, nhãn và các giới hạn. Khi package được cập nhật,
binding trở nên cũ (`BINDING_STALE`) thay vì bị trỏ sang đích khác. Lần bấm có cần phê duyệt hay không là quyết định của
execution policy tại thời điểm bấm, không phải một cờ đóng băng lúc biên dịch. Bấm nút và nói yêu cầu cho cùng một nút
đi chung một đường (`invokeWidgetAction`), nhận cùng quyết định policy và cùng kết quả.

Mọi bề mặt đọc trạng thái sẵn sàng từ một hàm duy nhất (`bindingAvailability` trong
`apps/runtime/src/application/action-bindings.ts`), và timeline mang trạng thái đó bên cạnh instance. Service đã dừng,
capability không phải service hay binding cũ đều là nút bị tắt kèm lý do bằng lời, không phải nút trông như bấm được rồi
thất bại. Workflow chỉ sẵn sàng khi capability của mọi bước `invoke` đều sẵn sàng, và lý do nêu tên bước chưa sẵn sàng.
Lần bấm vẫn được kiểm lại khi tới node. Khi bấm, nút hiện trạng thái đang chạy, rồi kết quả trong một dòng
`role="status"`. Kết quả là output của service, câu trả lời của agent, output cuối của workflow, "đã ghim", "đã bắt đầu
chạy nền", "đang chờ bạn phê duyệt" hoặc lý do bị từ chối. Bấm lần hai khi lần đầu còn đang chạy thì không gửi gì. Bấm
nút agent chạy trước mặt khi Clark còn đang trả lời thì bị từ chối với `TURN_IN_PROGRESS` thay vì ngắt ngang.

**Giới hạn.** Đề xuất có thể xin `limits` chặt hơn mặc định. Những gì nó xin được kẹp vào trần khi biên dịch binding, và
binding được lưu không kèm giới hạn thì chạy theo mặc định, nên không binding nào chạy không có giới hạn
(`apps/runtime/src/application/action-limits.ts`).

| Loại | `deadlineMs` | `maxTokens` | `maxCallsPerMinute` |
| --- | --- | --- | --- |
| `invoke` | Mặc định 60 giây, 1–60 giây; trần thời gian gọi của chính service host vẫn áp dụng. | — | Mặc định 30, 1–120. |
| `agent` | — (áp dụng hạn chót của lượt và của việc chạy nền trên node) | Mặc định 4000, 256–16000. | Mặc định 10, 1–30. |
| `workflow` | Mặc định 120 giây, 1–300 giây, cho cả lần chạy. | — | Mặc định 10, 1–60. |

Số lần mỗi phút được tính theo từng binding, trên node này. Một lần bấm được đếm khi nó đã qua phần kiểm binding,
revision và input, trước khi policy quyết định, nên lần bấm mà policy sau đó từ chối hoặc chuyển sang chờ phê duyệt vẫn
dùng mất một lượt. Lần bấm vượt giới hạn bị từ chối với `RATE_LIMITED` (429), kèm `retryAfterMs` và `limit`, và không có
gì chạy. Bộ đếm được giữ trong bộ nhớ cho các binding được bấm trong một phút gần nhất, tối đa 1000 binding.

**Ngữ cảnh cho nút agent.** `contextRefs` là một ngữ pháp đóng: `widget` / `widget:<instanceId>` (widget đang mang ý
nghĩa gì lúc này, lấy từ chính semantic document mà `inspect_ui` đọc), `selection` / `selection:<instanceId>`, và
`state:<key>` / `state:<instanceId>/<key>` (một giá trị trong state của một view ghép). Tham chiếu không có instance id
nghĩa là widget của chính nút. Mọi thứ khác bị từ chối khi biên dịch binding, cũng như một widget mà node này không giữ
hoặc thuộc về người khác. `artifact:<id>` chỉ một tệp được giữ qua artifact broker (§10.1); khi biên dịch binding, nó bị
từ chối nếu node này không giữ tệp đó hoặc tệp thuộc về người khác. Khi bấm, host đọc lại từng tham chiếu cho người đã
bấm và giới hạn mỗi cái ở 4000 ký tự, cắt đúng ranh giới ký tự. Một tệp được đọc với tư cách widget vừa được bấm, theo
đúng quyết định áp dụng cho những lần đọc của chính widget đó: grant của nó, principal, và cuộc trò chuyện nơi nút được
bấm, vốn phải là cuộc trò chuyện của tệp. Model nhận được tên, kiểu và kích thước của tệp, và với kiểu văn bản (văn bản
thuần, Markdown, CSV, TSV, JSON) thì thêm phần đầu nội dung — tối đa 3000 byte, có ghi rõ là chưa đủ khi đúng như vậy. Ảnh
hoặc PDF chỉ được mô tả, không bao giờ được trích. Một tệp không rõ, đã hết hạn hoặc mất byte làm lượt bấm bị từ chối với
`CONTEXT_REF_UNKNOWN`; tệp của principal khác, tệp widget chưa từng được cấp, hoặc grant đã hết hạn hay bị thu hồi làm
lượt bấm bị từ chối với `CONTEXT_REF_FORBIDDEN`. Những gì host đọc có thể là
chữ do widget viết, nên đó là dữ liệu, không bao giờ là chỉ dẫn: nó không được đặt vào ghi chú hướng dẫn của lượt, cũng
không vào văn bản yêu cầu của worker chạy nền. Nó nằm trong một phần riêng sau lời của người dùng và phần hướng dẫn, dưới
một tiêu đề đánh dấu đó là dữ liệu, không phải chỉ dẫn. Ở đó host còn làm nó trơ: dấu ngoặc vuông được đổi thành ngoặc
toàn độ rộng, ký tự phân dòng và phân đoạn được đổi thành xuống dòng thường, và mỗi dòng được thụt vào dưới mục của nó,
nên chữ của widget không thể đóng dấu hướng dẫn hay tự mở một mục mới. Bản thân nút không thêm gì: nút không gửi input,
và bất cứ thứ gì nó gửi đều bị từ chối. Tham chiếu không còn phân giải được thì lần bấm bị từ chối với `CONTEXT_REF_UNKNOWN` (404) hoặc
`CONTEXT_REF_FORBIDDEN` (403) trước khi gọi bất kỳ model nào. Sau đó yêu cầu và ngữ cảnh được đo theo `maxTokens` bằng
một ước lượng thận trọng (số byte UTF-8 / 3). Yêu cầu không vừa bị từ chối trọn vẹn với `TOKEN_BUDGET_EXCEEDED`, và không
có gì được gửi tới model. Yêu cầu chạy nền trao ngân sách này cho worker dưới dạng `maxTokens` của brief. Model adapter
chưa dùng nó để giới hạn output của chính worker.

**Cuộc gọi không bao giờ nhận được câu trả lời.** Stop, Escape hoặc "dừng lại" trong cuộc trò chuyện cũng dừng một cuộc
gọi service hay workflow của nút còn đang chạy ở đó. Khi có cái đang chạy, ô soạn tin hiện Stop. Lần bấm nút agent chạy
trước mặt là một lượt, và cùng nút Stop đó kết thúc nó như một lượt. Nó không bị đếm thêm lần nữa như một thao tác của nút.

Mọi cuộc gọi không phải `read` đều đi qua sổ effect (#273), giống như một thao tác trình duyệt
(`apps/runtime/src/application/action-effects.ts`). Sau khi registry, schema và policy đã cho phép, và trước khi gửi bất
cứ thứ gì, cuộc gọi được ghi là `submitted` dưới một task riêng, trong một transaction. Nếu sổ không ghi được, lần bấm bị
từ chối với `LEDGER_UNAVAILABLE` (503) và không có gì được gửi. Kết quả trả về sẽ chốt nó:

- có câu trả lời thì nó được xác nhận;
- cuộc gọi chưa rời khỏi node (service không chạy, hoặc cuộc gọi bị rút lại trước khi được ghi) thì bị đánh dấu thất bại,
  và không có gì xảy ra;
- mọi kết cục khác thì bị đánh dấu chưa rõ: hết giờ, bị dừng, service thoát giữa chừng (`SERVICE_UNREACHABLE`), hoặc
  service trả lời bằng lỗi sau khi có thể đã làm một phần việc (`SERVICE_TOOL_FAILED`).

Cuộc gọi chưa rõ có thể đã có hiệu lực. Lần bấm trả về `outcome: "uncertain"` với `mayHaveRun: true` và `recorded`, cho
biết sổ có đang giữ câu hỏi đó hay không. Chỉ khi đó mới có thông báo trong hộp thư hỏi người dùng nó đã có hiệu lực
chưa, và chỉ khi đó lời người dùng đọc hoặc nghe mới nhắc tới hộp thư; nếu không, lời đó nhờ người dùng nói rõ trong cuộc
trò chuyện. Nếu node chết giữa cuộc gọi, dòng `submitted` vẫn còn đó, và phần phục hồi lúc khởi động biến nó thành effect
chưa rõ với cùng thông báo trong hộp thư. Cuộc gọi được ghi theo invocation id và không bao giờ được thử lại: cùng id đó
nhận lại câu trả lời chưa rõ và không gửi gì.

Capability `read` không mở mục nào trong sổ. Một lần đọc chưa xong bị từ chối với `readOnly: true`, vì không có gì thay
đổi và bấm lại là an toàn. Service qua MCP stdio được gửi `notifications/cancelled` cho yêu cầu bị rút lại hoặc hết giờ.
Service tôn trọng thông báo này có thể dừng, nhưng host không bao giờ mặc định là nó đã dừng.

**Một kết quả cho mỗi invocation id, kể cả qua khởi động lại.** Trước khi gửi bất cứ thứ gì, node ghi một bản ghi
`started` cho invocation id, và thay nó bằng kết quả khi lần bấm kết thúc. Cùng id đó tới lần nữa thì nhận lại kết quả ấy
và không chạy gì. Khi lần đầu còn đang chạy, câu trả lời là `INVOCATION_IN_PROGRESS`. Sau khi một lần khởi động lại cắt
ngang nó, câu trả lời là `ACTION_INTERRUPTED` với `outcome: "uncertain"`, và nó không được chạy lại. Lần bấm bị từ chối
trước khi gửi gì thì không được ghi, nên cùng lần bấm đó có thể chạy một lần khi điều khiến nó bị từ chối thay đổi. Lần
bấm cũng bị từ chối với `INSTANCE_UNKNOWN` (404) khi widget không nằm trong cuộc trò chuyện mà yêu cầu nêu, nên Stop, thẻ
phê duyệt, việc chạy nền và task trong sổ đều thuộc về chính cuộc trò chuyện của widget.

**Workflow.** Bộ từ vựng bước là đóng và không chứa mã:

- `invoke` gọi một capability qua `invokeCapability`, với phần kiểm registry, kiểm schema, quyết định policy riêng và,
  khi policy hỏi, thẻ phê duyệt riêng;
- `transform` định hình lại output của bước nó phụ thuộc bằng một trong năm hàm thuần: `select-field`,
  `filter-equals`, `map-field`, `take` hoặc `count`;
- `condition` kiểm output đó (`equals`, `not-equals`, `exists`, `greater-than` hoặc `less-than`), và các bước phụ thuộc
  vào một điều kiện sai thì bị bỏ qua.

Tham số của bước `invoke` có thể là `{"$step": "<id>"}` (một bước nó phụ thuộc, có thể kèm `"field"`) hoặc
`{"$input": "<key>"}` (một giá trị lần bấm đã gửi). Lần chạy dừng ở bước đầu tiên bị từ chối, thất bại, xin phê duyệt
hoặc không trả lời kịp. Một bước không được gửi khi hạn chót chỉ còn dưới 250 ms; lần chạy dừng trước bước đó, không gửi
gì. Thông điệp nêu tên bước đó và các bước chưa chạy. Các bước trước nó vẫn giữ nguyên là đã xong,
vì workflow không có rollback và không bao giờ tuyên bố có. Phản hồi nói `outcome: "partial"` khi có bước đã tới service
trước lúc dừng, `"uncertain"` khi bước bị dừng có thể đã chạy, và `"refused"` trong các trường hợp còn lại, kèm một báo
cáo `workflow` về mọi bước. Mọi bước mà lần chạy đã tới, kể cả bước bị bỏ qua, đều được ghi vào nhật ký audit. Phê duyệt
mà một bước xin là một thẻ của host trong cuộc trò chuyện. Phê duyệt nó thì chỉ chạy riêng bước đó và không tiếp tục
workflow. Cuộc gọi đã được phê duyệt chạy theo trần của chính service host (60 giây), không theo hạn chót hay số lần mỗi
phút của nút, và nút Stop của cuộc trò chuyện không dừng được nó.

Body phản hồi nói điều gì đã xảy ra trong `outcome`: `done` (200), `approval-required` (202) hoặc `background` (202).
Body của một lần từ chối mang `code`, `message` và, khi liên quan, `outcome`, `mayHaveRun`, `recorded`, `readOnly`,
`taskId` (mục trong sổ, chỉ khi `recorded`), `retryAfterMs`, `limit` và `workflow`. `message` là tiếng Anh, dành cho log
và agent. Cuộc trò chuyện và giọng nói nói kết quả bằng ngôn ngữ của người dùng, dựa trên code và các chi tiết
(`packages/conversation-client/src/action-messages.ts`, `apps/runtime/src/application/action-speech.ts`). Chúng không bao
giờ hiện code thô, và một cuộc gọi có thể đã chạy thì không bao giờ bị nói là thất bại.

`canvas.cta@1` được giữ để lịch sử vẫn hiển thị. Model không đặt nó được nữa, vì nó không có hành động nào phía sau.

Kiểm thử: `apps/runtime/test/action-widget.spec.ts`, `apps/runtime/test/workflow-executor.spec.ts`,
`apps/runtime/test/action-speech.spec.ts`, các trường hợp gọi có giới hạn trong `apps/runtime/test/service-host.spec.ts`,
`packages/conversation-client/test/action-button.spec.ts`, `packages/conversation-client/test/action-messages.spec.ts`,
và journey trình duyệt `apps/web/e2e/action-widget.spec.ts`, chạy từng loại với một notes service thật trong container,
gồm một workflow, một nút agent có tham chiếu ngữ cảnh và Stop trong lúc một cuộc gọi chậm đang chạy.

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
| `canvas.gallery@1`, `canvas.carousel@1` | `media.select` | `selectedIndex` |

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

Khi phát triển tại máy, `clark widget dev` liệt kê input và event graph đã khai báo của từng definition. Event
simulator kiểm tra rồi áp dụng một mẫu vào graph state tạm bằng chính composition contract dùng chung, sau đó hiển thị
các giá trị đầu ra. Nó kiểm tra từng event đã khai báo riêng lẻ; không dựng cả composition và không gọi capability.

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
| `canvas.file@1` | Một tệp, được nêu tên và mô tả. | `show_view` với `props.name`, và tuỳ chọn `mediaType` (`type/subtype`), `sizeBytes`, `source` (bằng lời), `path` (dạng chữ), `summary` và `artifactRef`, tức nguyên `ArtifactRef` của một tệp mà node đang giữ (§10.1). |

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
- Thẻ tệp không có `artifactRef` thì không có liên kết, không có nút mở, không có nút tải về. Nó nói điều đó bằng
  lời, thay vì vẽ một nút không làm gì.
- Thẻ tệp có `artifactRef` thì có **Mở** và **Lưu thành…**. Mở lấy các byte từ node với tư cách người dùng và xem
  trước ngay trong thẻ: chữ và JSON tới 64 KB, kèm một dòng ghi chú khi còn nhiều hơn, và ảnh. Các kiểu khác thì thẻ
  nói là không xem trước được. Bản xem trước tin kiểu do node ghi nhận, không bao giờ tin lời của thẻ. Lưu thành… là
  của chính host (§10.1). Node kiểm tra lại ref ở mỗi lần mở và mỗi lần lưu. Nó từ chối một artifact thuộc principal
  khác, hoặc một artifact còn đang được ghi, và thẻ hiện lý do. Ở nơi thẻ không gọi được node với tư cách người dùng,
  như bản xem trước trong thư viện hay một cửa sổ tách riêng, thẻ nói rằng không mở được tệp ở đó.
- Khi có `truncated`, thẻ nói rằng đây không phải toàn bộ mã hay toàn bộ diff.

Kiểm thử: [artifact-viewers.spec.ts](../packages/contracts/test/artifact-viewers.spec.ts) cho các quy tắc,
[artifact-viewers.spec.ts](../apps/runtime/test/artifact-viewers.spec.ts) cho node,
[artifact-viewers.spec.ts](../packages/conversation-client/test/artifact-viewers.spec.ts) cho trang, và journey trình
duyệt [artifact-viewers.spec.ts](../apps/web/e2e/artifact-viewers.spec.ts). Journey chạy với cả hai theme, khi giảm
chuyển động, ở 390 px có cảm ứng, và trong thư viện. Nó cũng kiểm ký tự ẩn được vẽ thành dấu hiệu kèm cảnh báo, ký tự
phân dòng (line separator) trong mã mà số dòng vẫn nằm cạnh đúng dòng, ký tự xuống dòng trong một dòng diff bị từ chối,
lần sao chép bị trình duyệt từ chối, và vòng focus phải được vẽ bên trong vùng cuộn.

### 8.6 Biểu đồ vùng và biểu đồ phân tán

Hai định nghĩa vẽ số liệu từ một dataset theo các trường được gọi tên: biểu đồ vùng gồm một hay nhiều chuỗi dọc theo
trục x, có thể xếp chồng, và biểu đồ phân tán gồm các điểm đặt theo hai con số. Chúng dùng lại trục, cách định dạng số,
sắc màu và bảng dự phòng của biểu đồ đường và biểu đồ cột. Một bộ hàm duy nhất, trong
[xy-charts.ts](../packages/contracts/src/xy-charts.ts), đọc props và các hàng, kiểm tra một khung nhìn và viết phần
chữ. Node và trang cùng dùng bộ hàm này, nên trang không bao giờ vẽ một biểu đồ mà node sẽ từ chối.

| Định nghĩa | Là gì | Props |
| --- | --- | --- |
| `canvas.area@1` | Biểu đồ vùng: mỗi chuỗi được tô xuống tới 0, hoặc xếp chồng. | `datasetRef`, `x` (tên một trường), `y` (1–8 tên trường), tuỳ chọn `labels` (tên hiển thị cho từng trường được vẽ, tối đa 60), `unit` (tối đa 20), `title` (tối đa 200) và `stacked`. |
| `canvas.scatter@1` | Biểu đồ phân tán: mỗi hàng và mỗi chuỗi là một điểm, đặt tại x và y của nó. | `datasetRef`, `x`, `y` (1–8), tuỳ chọn `labels`, `unit`, `xUnit` (tối đa 20), `title` và `pointLabel` (trường dùng để gọi tên từng điểm). |

Tên trường dài 1–64 ký tự trên một dòng, không chỉ toàn dấu cách, và không chứa ký tự ẩn nào trong §8.4. Các trường
được gọi tên, không bao giờ bị đoán: biểu đồ thiếu `x` hoặc thiếu `y` bị từ chối, và cũng vậy với một trường được gọi
hai lần, `x` lặp lại trong `y`, một nhãn cho trường mà biểu đồ không vẽ, hay một `pointLabel` trùng với `x` hoặc với
một chuỗi (một điểm được gọi tên bằng trường không dùng để đặt nó, nên bảng dưới biểu đồ không bao giờ có hai cột
giống nhau). `stacked` chỉ dành cho biểu đồ vùng, còn `pointLabel` chỉ dành cho biểu đồ phân tán.

Model đặt từng biểu đồ bằng `show_view`. Chúng thuộc họ `chart`, họ mà không vùng bố cục nào đọc, nên model đặt mỗi
biểu đồ riêng lẻ.

Những gì node bảo đảm:

- **Các hàng được đọc trước khi lưu bất cứ thứ gì.** Node đọc dataset mà biểu đồ gọi tên, với tư cách người đặt biểu
  đồ, và từ chối ngay trong lượt đó, kèm lý do, khi dataset không có trên node này hoặc không thuộc về họ, khi một
  trường được gọi tên không có trong đó (lý do liệt kê các trường nó có), hoặc khi một hàng không khớp: thiếu giá trị,
  giá trị không phải số (một chuỗi dạng số như `"12"` không phải số), x không phải số trên biểu đồ phân tán, x của biểu
  đồ vùng lẫn cả số và chữ hoặc có các số không tăng dần theo từng hàng, một giá trị âm trong biểu đồ vùng xếp chồng,
  hay một hàng xếp chồng có tổng các chuỗi vượt quá số lớn nhất có thể biểu diễn (từng giá trị đều hợp lệ, nhưng
  chồng được vẽ là tổng của chúng). Tối đa năm vấn đề được nêu tên, sau đó là `and N more problem(s) in the same rows`. Không instance nào bị bỏ
  lại.
- **Số điểm có giới hạn.** Một biểu đồ vẽ 500 hàng đầu tiên. Chỉ những hàng đó được kiểm tra, và biểu đồ, phần chữ và
  tài liệu ngữ nghĩa của nó đều nói nó vẽ bao nhiêu trên tổng số bao nhiêu.
- **Điều người dùng thay đổi là một khung nhìn mà node giữ lại.** Ẩn một chuỗi và chọn một điểm là khung nhìn của biểu
  đồ, `{ hiddenSeries, selected? }`, được gửi qua binding `chart.view` riêng của biểu đồ, binding không đọc và không
  thay đổi gì khác. Node kiểm tra từng khung nhìn theo biểu đồ và theo các hàng node đang giữ lúc đó: luôn còn ít nhất
  một chuỗi được hiện, điểm được chọn nằm trên một chuỗi đang hiện, và chỉ số của nó là một trong các điểm được vẽ.
  Khung nhìn không khớp bị từ chối với `the chart view was refused: …`, và trạng thái được giữ nguyên. Một khung nhìn
  thay thế trọn vẹn khung nhìn trước.
- **Văn bản thay thế là lời của chính biểu đồ.** Nó gọi tên các chuỗi, khoảng x, số điểm và khoảng giá trị của từng
  chuỗi. Biểu đồ phân tán còn nói mỗi trục đo gì, lấy từ nhãn của trường (hoặc tên trường) và đơn vị, ví dụ
  `(x axis: Load (%); y axis: Latency (ms))`. Văn bản của biểu đồ vùng, ví dụ `Runs by week: Area chart of Runs, Failures by week, 5 point(s); W36 to W40. Runs: 128 to 164 runs;
  Failures: 3 to 9 runs.`
- **Voice và `inspect_ui` đọc biểu đồ như nó đang là.** Tài liệu ngữ nghĩa (§9) cho biết các chuỗi đang hiện và đang
  ẩn, biểu đồ vùng có xếp chồng hay không, số điểm và việc bị cắt bớt nếu có, khoảng giá trị của từng chuỗi đang hiện,
  khoảng x và điểm được chọn, với điểm đó trong `selectedIds` dưới dạng `field#index`. Biểu đồ phân tán có thêm
  `xAxis` và `yAxis`, chính là tiêu đề trục mà trang vẽ. Nó được dựng từ trạng thái và
  các hàng node đang giữ lúc đó. Điểm được chọn mà không còn trong các hàng thì được nói là đã mất thay vì được mô tả,
  và dataset đã mất thì được nói là không còn. Độ tươi (freshness) của nó là độ tươi của chính dataset.

Những gì trang làm:

- Mỗi chuỗi có sắc màu, kiểu nét và hình dạng điểm riêng, hiện cùng nhau trong chú giải, nên màu sắc không bao giờ là
  tín hiệu duy nhất. Có sáu sắc màu, nên từ chuỗi thứ bảy màu sắc lặp lại; mỗi chuỗi trong tám chuỗi vẫn có kiểu nét và
  hình dạng điểm không chuỗi nào khác có, và chính chúng phân biệt các chuỗi. Chú giải là một hàng nút có `aria-pressed`; chuỗi bị ẩn ghi "(đã ẩn)" bằng chữ. Không thể ẩn chuỗi
  cuối cùng đang hiện, và biểu đồ nói lý do.
- Mỗi điểm là một nút có tên nói chuỗi, x và giá trị của nó, cùng tên điểm khi `pointLabel` có. Một điểm nằm trong thứ
  tự tab. Phím mũi tên trái phải di chuyển dọc trục x, theo thứ tự x với biểu đồ phân tán, lên và xuống đổi chuỗi;
  Home và End tới điểm đầu và điểm cuối; Enter hoặc Space để chọn, và Esc để bỏ chọn. Điểm được chọn được mô tả bên
  cạnh biểu đồ trong một vùng live, kèm một nút bỏ chọn.
- Một thay đổi được vẽ ngay và gửi tới node, mỗi biểu đồ một yêu cầu tại một thời điểm; thay đổi xảy ra trong lúc đó
  được gửi sau, và chỉ thay đổi mới nhất. Khi node từ chối một khung nhìn, biểu đồ nói điều đó bằng ngôn ngữ của người dùng, vẽ khung nhìn
  node đang giữ, và đọc lại dataset, vì các hàng node dùng để kiểm tra có thể không phải các hàng trang đã nhận.
- Biểu đồ phân tán có tiêu đề trục: trục y ở trên vùng vẽ và trục x ở dưới, mỗi trục kèm nhãn và đơn vị.
- Bên dưới biểu đồ có một bảng các hàng đã vẽ, với tên biểu đồ đặt cho các trường. Một trường chỉ được đọc từ chính
  hàng đó, nên trường tên `constructor` hay `toString` được vẽ và gọi tên như mọi trường khác.
- Ký tự ẩn của §8.4 trong phần chữ của các hàng, như ký tự điều khiển bidi trong một giá trị x dạng chữ hay trong tên
  một điểm, được hiện thành dấu đánh dấu như `⟨U+202E⟩` ở mọi nơi biểu đồ nói phần chữ đó: trên trục, trong tên điểm,
  trong điểm được chọn, văn bản thay thế và tài liệu ngữ nghĩa. Trong bảng, đó là cùng dấu đánh dấu mà trình xem mã
  vẽ, kèm tiêu đề nói ký tự đó là gì. Nó không bao giờ đảo thứ tự phần chữ xung quanh.
- Mọi điều biểu đồ nói đều bằng ngôn ngữ của người dùng. Các hàng không còn khớp được mô tả từ hàng, trường và giá trị
  mà bộ kiểm tra dùng chung tìm ra, không phải từ câu tiếng Anh của node, và một khung nhìn bị từ chối được nói bằng
  câu của chính trang. Lý do tiếng Anh của node dành cho model và nhật ký.
- Các trục không bao giờ làm việc không giới hạn. Số vạch chia được đếm trước khi tạo, tối đa 50, và mỗi vạch là chỉ
  số của nó nhân với một bước tròn. Các giá trị gần nhau tới mức không bước tròn nào tách được, như `0.3` và
  `0.1 + 0.2`, được vẽ như một giá trị với khoảng trống hai bên. Nhãn dùng `k`, `M`, `B` và `T` cho tới một nghìn nghìn
  tỷ; vượt quá mức đó, hoặc khi bước nhỏ hơn một phần triệu của đơn vị, nhãn được viết với số mũ và đủ chữ số có nghĩa
  mà bước cần, nên thang `1e-12` không bị ghi `0` ở mọi vạch. Vùng vẽ bắt đầu đủ xa về bên phải để nhãn rộng nhất được
  vẽ trọn vẹn, tối đa hai phần năm chiều rộng biểu đồ.
- Khi có hơn 60 điểm, biểu đồ vùng chỉ vẽ điểm đang có focus và điểm được chọn, để đường vẫn dễ đọc; mọi điểm vẫn tới
  được bằng bàn phím.
- Biểu đồ không tự thêm chuyển động nào, vừa với chiều rộng xuống tới 390 px, và theo theme sáng và tối. Trong Widget
  Library, các fixture dùng được mà không cần node: khung nhìn được giữ trên trang.

Kiểm thử: [xy-charts.spec.ts](../packages/contracts/test/xy-charts.spec.ts) cho các quy tắc,
[xy-charts.spec.ts](../apps/runtime/test/xy-charts.spec.ts) cho node,
[chart-layout.spec.ts](../packages/conversation-client/test/chart-layout.spec.ts) cho thang đo (gồm các giá trị chỉ
cách nhau một số thực, `1e17` cạnh `1e17 + 16`, một điểm duy nhất, các giá trị bằng nhau và thang `1e-12`), hình dạng
điểm và thứ tự bàn phím, [xy-chart-schemas.spec.ts](../packages/widget-catalog/test/xy-chart-schemas.spec.ts), kiểm tra rằng JSON
Schema và các kiểm tra riêng của biểu đồ chấp nhận và từ chối cùng một bộ props, và mọi fixture trong thư viện đều là
fixture node sẽ đặt, và journey trình duyệt [xy-charts.spec.ts](../apps/web/e2e/xy-charts.spec.ts). Journey bao gồm chú
giải, chọn bằng bàn phím, khung nhìn được giữ sau khi tải lại, biểu đồ vùng xếp chồng, 640 hàng được vẽ thành 500 kèm
nhãn nói điều đó, tiêu đề trục của biểu đồ phân tán, các lần từ chối vì thiếu trường và vì giá trị không phải số,
việc từ chối một điểm node không còn giữ được nói bằng tiếng Việt, giảm chuyển động, 390 px có cảm ứng ở theme sáng, và thư viện.

### 8.7 Các kiểu xem lịch

`canvas.calendar@1` hiện các sự kiện của một dataset theo ba kiểu xem: tháng, tuần (thứ Hai đến Chủ nhật) và lịch
trình, tức danh sách những ngày trong tháng có sự kiện. Kiểu xem, ngày được chọn và sự kiện được chọn là trạng thái
widget của lịch. Một bộ hàm duy nhất, trong [calendar-view.ts](../packages/contracts/src/calendar-view.ts), đọc các sự
kiện, đặt chúng vào đúng ngày, kiểm tra một khung nhìn và viết phần chữ. Node và trang cùng dùng bộ hàm này.

| Prop | Là gì |
| --- | --- |
| `datasetRef` | Một dataset trên node này, mỗi hàng là một sự kiện. |
| `month` | Tháng được vẽ, dạng `YYYY-MM`. |
| `timezone` | Múi giờ IANA dùng để hiện các sự kiện; `UTC` khi bỏ trống. |
| `view` | Tuỳ chọn: `month`, `week` hoặc `agenda`, kiểu xem lúc mở. `month` khi bỏ trống. |
| `title` | Tuỳ chọn, tối đa 200 ký tự. |

Một hàng được đọc theo một trong ba dạng. Hàng không khớp dạng nào, hàng không có tiêu đề và hàng kết thúc trước khi
bắt đầu đều được tính là không đọc được, và lịch nói có bao nhiêu hàng như vậy:

- **Có giờ**: `title`, `startsAt` và `endsAt`. Một thời điểm có `Z` hoặc độ lệch như `+07:00` là đúng thời điểm đó.
  Một thời điểm không có độ lệch, như `2026-10-09T14:00`, là giờ đó theo múi giờ của lịch, và node cũng như mọi trang
  đều đọc giống nhau dù chạy ở múi giờ nào. Mọi dạng khác, như `+0700` thiếu dấu hai chấm hoặc chỉ có ngày, là không
  đọc được. Sự kiện nằm trên mọi ngày, từ ngày nó bắt đầu tới ngày nó vẫn còn đang diễn ra, theo múi giờ của lịch. Một sự kiện từ 22:00 tới 02:00 nằm trên cả hai ngày, ghi "từ
  22:00" ở ngày đầu và "đến 02:00" ở ngày sau. Một sự kiện kết thúc lúc nửa đêm không nằm trên ngày mà nửa đêm đó mở
  đầu.
- **Cả ngày**: `title`, `allDay: true`, `startDate` và `endDate` tuỳ chọn, là ngày sau ngày cuối cùng, theo cách
  iCalendar và Google Calendar ghi. Không có `endDate` thì sự kiện kéo dài một ngày, và `date` có thể thay cho
  `startDate`. Sự kiện cả ngày nằm trên đúng các ngày của nó dù được xem ở đâu: nó không bao giờ được đọc thành nửa đêm
  ở một múi giờ nào đó, vì chính cách đọc ấy làm sự kiện cả ngày trôi sang ngày hôm trước.
- **Chỉ có ngày**: `title` và `date`, nằm trên ngày đó, không có giờ.

`eventId` (hoặc `id`) gọi tên hàng; hàng không có nó được gọi tên theo vị trí (`row-3`). Một sự kiện được gọi bằng
khoá của nó: tên của hàng và thời điểm bắt đầu, ví dụ `evt_deploy@2026-10-06T15:00:00.000Z` hoặc
`evt_offsite@2026-10-07`. Hai hàng trùng tên và trùng lúc bắt đầu, chẳng hạn một sự kiện lặp bị xuất hai lần, được thêm
`#2`, `#3` theo thứ tự hàng, nên mỗi hàng là một sự kiện riêng để chọn. `timezone` là múi giờ sự kiện được ghi; nó được
hiện bên cạnh giờ của lịch và không đổi cách đọc một thời điểm không có độ lệch. Lịch đọc 500 hàng đầu tiên và nói khi còn nhiều hơn.

Model đặt lịch bằng `show_view`. Trước khi có instance, node từ chối, kèm lý do, một tháng không phải `YYYY-MM` có
thật, một múi giờ node không biết, và một dataset không có trên node này hoặc không thuộc về người dùng.

Những gì node bảo đảm:

- **Điều người dùng thay đổi là một khung nhìn mà node giữ lại.** Nút đổi kiểu xem, các ngày và các sự kiện đều ghi qua
  một binding `calendar.view` duy nhất của lịch: `{ view, selectedDate?, selectedEventId? }`, trong đó
  `selectedEventId` là khoá của sự kiện. Đây là một thao tác khung
  nhìn: nó chỉ đọc, không thay đổi gì khác, và không bao giờ thêm, dời hay xoá một sự kiện. Node kiểm tra từng khung
  nhìn theo lịch và theo các hàng node đang giữ lúc đó. Kiểu xem là một trong ba kiểu, ngày được chọn là một ngày tháng
  đó vẽ, và sự kiện được chọn là một sự kiện của lịch, nằm trên ngày được chọn khi có ngày được chọn. Khung nhìn không
  khớp bị từ chối kèm lý do, ví dụ `"evt_deploy@2026-10-06T15:00:00.000Z" is not an event on this calendar now`, và
  trạng thái được giữ nguyên. Tên hàng đứng một mình không phải là khoá và cũng bị từ chối như vậy. Một khung nhìn thay
  thế trọn vẹn khung nhìn trước.
- **Lịch được lưu từ trước khi có các kiểu xem mở ra ở kiểu tháng.** Trạng thái của lịch là phiên bản 2. Phiên bản 1
  chỉ giữ `selectedDate`, và bước migration được khai báo cho nó `view: "month"`. Timeline và tài liệu ngữ nghĩa đọc
  trạng thái cũ theo hình dạng hiện tại, còn chính hàng dữ liệu chỉ được ghi thành phiên bản 2 ở lần đổi khung nhìn kế
  tiếp.
- **Lịch được đặt từ trước khi có các kiểu xem được nhận binding của nó.** Lịch như vậy được đặt mà không có binding
  nào. Lần đầu node dựng timeline của cuộc trò chuyện, node cho mỗi lịch nó sở hữu trên một dataset đúng binding
  `calendar.view` mà việc đặt lịch mới tạo ra, một lần, trong một transaction; không cần migration cơ sở dữ liệu. Từ đó
  khung nhìn của lịch được giữ, được đọc lại sau khi tải lại trang, và được voice cùng `inspect_ui` mô tả đúng như nó
  đang là.
- **Văn bản thay thế là lời của chính lịch**: từng sự kiện trong tháng và thời gian của nó, theo múi giờ của lịch, ví
  dụ `Deploy (2026-10-06 at 22:00 to 2026-10-07 at 02:00)`.
- **Voice và `inspect_ui` đọc lịch như nó đang là.** Tài liệu ngữ nghĩa (§9) cho biết kiểu xem, tháng, múi giờ, số sự
  kiện trong tháng, ngày được chọn cùng tiêu đề các sự kiện của ngày đó, và sự kiện được chọn cùng thời gian của nó,
  kèm múi giờ gốc khi sự kiện được ghi ở múi giờ khác. Sự kiện đó cũng nằm trong `selectedIds`. Tài liệu được dựng từ
  trạng thái và các hàng node đang giữ lúc đó. Sự kiện được chọn mà không còn trong các hàng thì được nói là đã mất, và
  dataset đã mất thì được nói là không còn.
- **Sự kiện cục bộ có thể là sự kiện cả ngày.** Các sự kiện riêng của node (`POST /calendar/events`) nhận `allDay: true`
  cùng `startDate` và `endDate` tuỳ chọn, và từ chối một ngày không có thật hoặc một `endDate` không nằm sau
  `startDate` (`INVALID_DATE`, `INVALID_RANGE`). Một thay đổi giữ sự kiện cả ngày là cả ngày, trên đúng các ngày của
  nó, trừ khi thay đổi đó ghi `allDay: false`. Truy vấn theo một khoảng ngày tìm sự kiện cả ngày theo các ngày của nó,
  kể cả khi sự kiện được ghi ở đầu kia của các múi giờ trên thế giới (UTC+14 so với UTC-11), và tìm sự kiện có giờ theo
  các thời điểm của nó.

Những gì trang làm:

- Các kiểu xem là một hàng nút có `aria-pressed`. Ngày được chọn được giữ khi đổi kiểu xem, và kiểu tuần hiện tuần của
  ngày đó, kèm nút sang tuần trước và tuần sau.
- Hôm nay là ngày theo múi giờ của lịch, không phải của trình duyệt. Ngày đó được viền, gạch chân và ghi "hôm nay".
  Một dòng dưới nút đổi kiểu xem nói giờ hiện tại, và một vạch "bây giờ" nằm giữa các sự kiện hôm nay trong kiểu tuần
  và kiểu lịch trình, sau những sự kiện đã bắt đầu. Vạch này dời theo từng phút.
- Sự kiện cả ngày được ghi "Cả ngày" và vẽ với vân sọc cùng viền đôi, còn sự kiện kéo dài nhiều ngày ghi "ngày 2/3",
  nên không điều nào được nhận ra chỉ bằng màu sắc.
- Các ngày và các sự kiện là nút. Trong kiểu tháng, một ngày nằm trong thứ tự tab và phím mũi tên dời một ngày hoặc một
  tuần; Home và End tới hai đầu tuần. Trong kiểu tuần, trái và phải chuyển giữa các tiêu đề ngày. Lên và xuống chuyển
  giữa các sự kiện, Home và End tới sự kiện đầu và cuối, Enter hoặc Space để chọn, và Esc bỏ chọn sự kiện.
- Sự kiện được chọn được mô tả bên dưới khung nhìn trong một vùng live: thời gian theo múi giờ của lịch, nó kéo dài
  bao lâu khi vượt quá một ngày, thời gian theo múi giờ gốc khi đó là múi giờ khác, và một nút bỏ chọn. Sự kiện cả ngày
  qua nhiều ngày ghi "Kéo dài 3 ngày"; sự kiện có giờ ghi đúng độ dài thật, nên 22:00 tới 02:00 là "Kéo dài 4 giờ", không
  phải hai ngày.
- Trong kiểu tuần, mỗi ngày hẹp, nên vạch "bây giờ" chỉ hiện giờ bên cạnh vạch, trên một dòng; nhãn đầy đủ được đọc lên
  và hiện khi di chuột.
- Khi node từ chối một khung nhìn, lịch nói điều đó bằng ngôn ngữ của người dùng, vẽ khung nhìn node đang giữ, và đọc
  lại các sự kiện. Lý do bằng tiếng Anh của node dành cho model và nhật ký.
- Trong một surface được ghép, khung nhìn được giữ trên surface và `date.select` vẫn cấp dữ liệu cho bố cục (§8.3).
- Lịch không tự thêm chuyển động nào. Dưới 560 px, các ngày trong tuần và lịch trình xếp thành một cột, nên kiểu tuần
  dùng được ở 390 px. Lịch theo theme sáng và tối. Trong Widget Library, các fixture tháng, tuần và lịch trình dùng
  được mà không cần node.

Kiểm thử: [calendar-view.spec.ts](../packages/contracts/test/calendar-view.spec.ts) cho các quy tắc,
[calendar-views.spec.ts](../apps/runtime/test/calendar-views.spec.ts) cho node và cho lịch được đặt từ trước khi có các
kiểu xem,
[mini-app-data.spec.ts](../apps/runtime/test/mini-app-data.spec.ts) cho sự kiện cục bộ cả ngày và truy vấn theo khoảng
ngày,
[calendar-layout.spec.ts](../packages/conversation-client/test/calendar-layout.spec.ts) cho bàn phím, tuần và vạch
"bây giờ", [calendar-schemas.spec.ts](../packages/widget-catalog/test/calendar-schemas.spec.ts), kiểm tra phiên bản
trạng thái, bước migration của nó, và rằng mọi fixture trong thư viện đều là khung nhìn node sẽ giữ, và journey trình
duyệt [calendar-views.spec.ts](../apps/web/e2e/calendar-views.spec.ts). Journey chạy trong một trình duyệt ở New York
với một lịch ở Thành phố Hồ Chí Minh. Nó bao gồm từng kiểu xem, bàn phím, sự kiện được chọn được giữ sau khi tải lại,
hôm nay và "bây giờ" theo múi giờ của lịch, sự kiện cả ngày và sự kiện qua đêm, một thời điểm không có độ lệch được
một trình duyệt ở Los Angeles đọc theo múi giờ của lịch, việc từ chối một sự kiện node không còn giữ, một tháng không tồn tại, giảm chuyển động, 390 px có cảm ứng ở theme sáng, và thư viện.

### 8.8 Dòng thời gian hoạt động

`canvas.timeline@1` cho biết điều gì đã xảy ra và khi nào: các mục có ngày giờ do model nêu, được sắp theo thời gian và
nhóm theo ngày. Mọi thứ nó hiện đều nằm trong props. Nó không đọc nguồn dữ liệu trực tiếp nào và không bao giờ nói mình
đang cập nhật trực tiếp; mục mới hơn đến dưới dạng props mới. Mục được chọn là trạng thái widget của dòng thời gian. Một
bộ hàm duy nhất, trong [activity-timeline.ts](../packages/contracts/src/activity-timeline.ts), kiểm tra props, đặt mỗi
mục vào đúng ngày, kiểm tra một lựa chọn và viết phần chữ. Node và trang cùng dùng bộ hàm này.

| Prop | Là gì |
| --- | --- |
| `entries` | Bắt buộc, tối đa 200 mục. Mỗi mục là `{ id, at, title, description?, actor?, tone? }`. |
| `title` | Tuỳ chọn, tối đa 200 ký tự. |
| `order` | Tuỳ chọn: `newest` (mặc định) hoặc `oldest`, tức mới nhất hay cũ nhất trước. |
| `pageSize` | Tuỳ chọn: số mục trên một trang, từ 5 đến 50; 10 khi bỏ trống. |
| `timezone` | Tuỳ chọn: múi giờ IANA dùng để xác định ngày. |
| `truncated` | Tuỳ chọn: `true` khi model đã lược bớt mục, và dòng thời gian nói điều đó. |

`id` của một mục dài tối đa 120 ký tự và không trùng trên dòng thời gian. `title` là một dòng tối đa 200 ký tự, `actor`
một dòng tối đa 80 ký tự, còn `description` tối đa 1.000 ký tự và có thể xuống dòng. `tone` là một trong `neutral` (mặc
định), `info`, `success`, `warning` và `danger`. `at` là một trong hai dạng:

- **Một thời điểm kèm độ lệch**: `2026-09-30T21:05:00+07:00` hoặc `2026-09-30T14:05:00Z`. Thời điểm không có độ lệch
  bị từ chối, vì ở mỗi múi giờ nó lại chỉ một khoảnh khắc khác.
- **Một ngày** (`2026-09-30`) cho mục cả ngày. Mục đó nằm trên đúng ngày ấy dù được đọc ở đâu, không bao giờ bị hiểu
  thành nửa đêm ở một múi giờ nào đó.

Chữ là chữ thuần: không HTML, không liên kết, không callback, và không có khoá nào ngoài các khoá trên. Model đặt dòng
thời gian bằng `show_view`. Trước khi có instance, node từ chối, kèm lý do: thời điểm bị thiếu, không có độ lệch hoặc
không có thật (`2026-02-30`, giờ lớn hơn 23), một id dùng hai lần, một tone không có, quá nhiều mục, chữ quá dài, ký tự
ẩn hoặc ký tự điều khiển hai chiều (được gọi theo mã, ví dụ `U+202E`), và múi giờ node không biết. Dòng thời gian bị
từ chối không để lại gì.

Những gì node bảo đảm:

- **Node và trang đọc ra cùng những ngày.** Khi props không nêu múi giờ, node ghi một múi giờ vào props lúc đặt dòng
  thời gian: múi giờ hiển thị của node, hoặc `UTC` khi không gọi được tên một múi giờ đã biết. Một mục nằm trên ngày của
  nó theo múi giờ đó, ví dụ 17:40 UTC ngày 29 nằm trên ngày 30 ở `Asia/Saigon`. Giờ mùa hè được tính đúng, kể cả giờ bị
  lặp lại và giờ bị bỏ qua. Trong một ngày, mục cả ngày đứng đầu, sau đó là các mục có giờ theo thứ tự của dòng thời
  gian.
- **Điều người dùng chọn là trạng thái mà node giữ lại.** Các mục ghi qua một binding `timeline.select` duy nhất của
  dòng thời gian: `{ selectedId }`, trong đó `selectedId` rỗng là bỏ chọn. Đây là một thao tác khung nhìn: nó chỉ đọc và
  không thay đổi gì khác. Node kiểm tra từng lựa chọn theo các mục node đang giữ. Một id không thuộc các mục đó, một khoá
  khác `selectedId`, hoặc một hình dạng khác bị từ chối kèm lý do, ví dụ `"gone" is not an entry on this timeline now`,
  và trạng thái được giữ nguyên.
- **Văn bản thay thế là lời của chính dòng thời gian**: mỗi ngày một lần, rồi các mục của ngày đó kèm giờ, tone và người
  thực hiện, ví dụ `2026-09-30: all day Release freeze [info]; 23:30 Deploy started [info] by Lan`. Văn bản được rút
  gọn kèm dấu đánh dấu cho vừa snapshot.
- **Voice và `inspect_ui` đọc dòng thời gian như nó đang là.** Tài liệu ngữ nghĩa (§9) cho biết số mục, thứ tự, múi giờ,
  ngày đầu và ngày cuối, có mục nào bị lược bớt hay không, số mục theo từng tone, và mục được chọn cùng thời gian và tone
  của nó. Mục đó cũng nằm trong `selectedIds`. Tài liệu nằm trong giới hạn ngữ nghĩa kể cả với dòng thời gian lớn nhất.
- **Trong một surface được ghép**, dòng thời gian là một lá `timeline`, và `timeline.select` `{ selectedId }` có thể cấp
  dữ liệu cho bố cục (§8.3). Khi không được nối, lựa chọn được giữ trên surface.

Những gì trang làm:

- Mỗi ngày là một tiêu đề với ngày đầy đủ theo ngôn ngữ của người dùng, và các mục của ngày là một danh sách. Một mục
  hiện giờ của nó, hoặc "Cả ngày" kèm viền đôi, tone dưới dạng một ký hiệu và một chữ bên cạnh màu, tiêu đề và người
  thực hiện. Mô tả dài mở ra ở dạng thu gọn, kèm nút để xem phần còn lại.
- Các mục là nút có `aria-pressed`. Một mục trên trang nằm trong thứ tự tab. Phím mũi tên chuyển giữa các mục của trang,
  Home và End tới mục đầu và mục cuối, Enter hoặc Space chọn hoặc bỏ chọn một mục, và Esc bỏ chọn. Tiêu điểm luôn được
  vẽ ra. Một vùng live nói mục vừa được chọn hoặc lựa chọn vừa được bỏ.
- Mục được chọn được mô tả bên dưới danh sách, kèm một nút bỏ chọn. Dòng thời gian dài hơn được chia trang, có nút trang
  trước và trang sau, và mở ra ở trang có mục đang được chọn.
- Danh sách văn bản của mọi mục chỉ cách một cú nhấp, và dòng thời gian nói khi có mục bị lược bớt.
- Khi node từ chối một lựa chọn, dòng thời gian nói điều đó bằng ngôn ngữ của người dùng và vẽ lựa chọn node đang giữ.
  Múi giờ trang không biết được đọc thành UTC, và dòng thời gian nói điều đó.
- Chữ được vẽ thành chữ. Ký tự ẩn trong một dòng thời gian được lưu từ trước khi quy tắc chặt hơn được hiện thành dấu
  đánh dấu, và dòng thời gian nói có bao nhiêu ký tự như vậy.
- Dòng thời gian không tự thêm chuyển động nào. Khi dòng thời gian hẹp hơn 480 px, tiêu đề và người thực hiện của một
  mục xuống dòng dưới giờ của mục, nên nó dùng được ở 390 px. Dòng thời gian theo theme sáng và tối. Trong Widget
  Library, các fixture dùng được mà không cần node, và việc chọn mục cũng hoạt động ở đó.

Không thuộc dòng thời gian: thời lượng, kiểu xem Gantt và nguồn dữ liệu trực tiếp.

Kiểm thử: [activity-timeline.spec.ts](../packages/contracts/test/activity-timeline.spec.ts) cho các quy tắc, ngày qua
các múi giờ và giờ mùa hè, phần chữ và tài liệu ngữ nghĩa;
[activity-timeline.spec.ts](../apps/runtime/test/activity-timeline.spec.ts) cho việc đặt, các lần từ chối, múi giờ node
ghi vào, lựa chọn và lá bố cục;
[activity-timeline.spec.ts](../packages/conversation-client/test/activity-timeline.spec.ts) cho bàn phím, chia trang và
thu gọn; [timeline-schemas.spec.ts](../packages/widget-catalog/test/timeline-schemas.spec.ts), kiểm tra rằng JSON Schema
và các quy tắc chấp nhận và từ chối cùng những props, và rằng mọi fixture trong thư viện đều là thứ node sẽ đặt; và
journey trình duyệt [activity-timeline.spec.ts](../apps/web/e2e/activity-timeline.spec.ts). Journey chạy trong một
trình duyệt ở New York với một dòng thời gian ở Sài Gòn. Nó bao gồm các ngày, bàn phím, lựa chọn được giữ sau khi tải
lại và được bỏ bằng Esc, một lựa chọn node từ chối, một id lặp và một ký tự ẩn bị từ chối khi đặt, chia trang, giảm
chuyển động, thư viện, và 390 px có cảm ứng ở theme sáng và tối.

---

## 8.9 Cây phân cấp

`canvas.tree@1` là một outline do host dựng từ dữ liệu đã có và bị giới hạn kích thước. Cây có tối đa 200 node và 12
cấp. ID dài tối đa 120 ký tự, nhãn 200 ký tự và chữ phụ 300 ký tự. Node từ chối ID node hoặc ID nhánh mở bị lặp,
tham chiếu nhánh mở không tồn tại, vòng lặp, cây quá sâu hoặc quá nhiều node, icon không biết, trường dư và ký tự ẩn.
Nội dung được vẽ dưới dạng chữ; widget không tải node con hay sửa dữ liệu nguồn.

`initiallyExpanded` khai báo các nhánh mở khi đặt. `tree.select` mang `{ selectedId }`; `tree.toggle` mang
`{ nodeId, expanded }`. Node kiểm tra và lưu cả hai thao tác trong trạng thái widget. State đã khôi phục sẽ bỏ qua ID
không còn có trong props hiện tại. Renderer cung cấp các vai trò WAI-ARIA cùng cấp, vị trí, số mục trong nhóm, trạng
thái chọn và mở; phím mũi tên di chuyển và mở/đóng nhánh, Home/End tới hai đầu, gõ chữ để tìm nhãn, Enter/Space để
chọn. Tiêu điểm luôn nhìn thấy được. Lựa chọn và trạng thái mở vẫn còn sau khi khôi phục pin và hội thoại.

Tài liệu semantic báo số node và cấp sâu trong giới hạn, số nhánh đang mở, node được chọn cùng đường dẫn của nó. Phần
dự phòng dạng chữ là outline có thụt lề. Cây không tự tạo chuyển động, theo theme sáng/tối và tùy chọn giảm chuyển
động, đồng thời xuống dòng trong viewport hẹp.

Kiểm thử: [tree-view.spec.ts](../packages/contracts/test/tree-view.spec.ts) kiểm tra giới hạn, cây lỗi, state và
semantic; [tree-view.spec.ts](../apps/runtime/test/tree-view.spec.ts) kiểm tra placement, event và semantic output;
[tree-view.spec.ts](../packages/conversation-client/test/tree-view.spec.ts) kiểm tra thứ tự bàn phím của các node đang
hiện, Home/End và tìm chữ theo locale; [tree-schemas.spec.ts](../packages/widget-catalog/test/tree-schemas.spec.ts)
kiểm tra fixture và sự nhất quán của schema; journey trình duyệt [tree-view.spec.ts](../apps/web/e2e/tree-view.spec.ts)
bao phủ hội thoại, bàn phím, state được giữ qua khôi phục pin, bố cục thích ứng, giảm chuyển động và bản xem trước
trong Widget Library.

---

## 8.10 Bảng Kanban

`canvas.board@1` là bảng do host dựng từ công việc đã biết và bị giới hạn kích thước. Bảng có 1–12 cột và tối đa 120
thẻ; ID cột và ID thẻ dùng chung một namespace duy nhất. Tiêu đề dài tối đa 160 ký tự trên một dòng, mô tả tối đa
500, người phụ trách tối đa 100, và mỗi thẻ có tối đa 8 nhãn dạng chữ thuần. Một cột có thể đặt giới hạn số thẻ.
Node từ chối trường lạ, cột không tồn tại, ID trùng, cột vượt giới hạn và ký tự điều khiển ẩn trước khi đặt widget.
Bảng không tải dữ liệu và không sửa chi tiết thẻ.

Node giữ thứ tự thẻ và thẻ đang chọn dưới dạng trạng thái khung nhìn. Khi không có action binding, di chuyển thẻ chỉ
đổi khung nhìn đã lưu của riêng bảng. `props.action` tuỳ chọn phải là binding `invoke`; node xác định bảng có gắn binding
hay không dựa trên binding host đã lưu, kiểm tra thẻ, cột đích theo props và thứ tự hiện tại, rồi chỉ gửi
`{ cardId, fromColumnId, toColumnId, position }` qua luồng capability chuẩn. Một lần di chuyển có binding ở trạng thái
đang chờ cho tới khi host báo kết quả. Thành công xác nhận thứ tự đang hiển thị; bị từ chối sẽ khôi phục thứ tự trước
đó và hiện lý do; mất phản hồi thì giữ trạng thái không chắc chắn cho tới khi người dùng xác nhận đã hiểu. Trang không
ghi trực tiếp lên provider.

Space chọn hoặc thả thẻ đang focus, các phím mũi tên chuyển vị trí xem trước và Escape huỷ thao tác. Tay nắm kéo cũng
dùng được bằng pointer và cảm ứng; bàn phím không phụ thuộc vào kéo. Khi thẻ xem trước chuyển giữa các cột, focus vẫn
ở trên thẻ; live region đọc thông báo khi chọn, từng vị trí và lúc thả; tay nắm có vùng chạm 44 px. Tone nhãn luôn đi
kèm một từ mô tả, focus nhìn thấy được, viewport hẹp không tràn ngang, và bảng tuân theo tuỳ chọn giảm chuyển động.
Tài liệu semantic báo số cột/thẻ trong giới hạn, lựa chọn và trạng thái đang chờ; phần dự phòng dạng chữ liệt kê thẻ
bên dưới tiêu đề từng cột.

Kiểm thử: [kanban-board.spec.ts](../packages/contracts/test/kanban-board.spec.ts) kiểm tra giới hạn, thứ tự, từ chối,
semantic và văn bản; [board-view.spec.ts](../apps/runtime/test/board-view.spec.ts) kiểm tra binding host, lưu state,
kết quả invoke, khớp approval và rollback khi bị từ chối; browser journey
[kanban-board.spec.ts](../apps/web/e2e/kanban-board.spec.ts) chạy thao tác bàn phím, chuột và cảm ứng trong hội thoại,
theme sáng/tối thích ứng và giảm chuyển động, cùng preview chỉ-đọc trong Widget Library.

### 8.11 Widget media và trạng thái semantic

`canvas.image@1` mô tả alt text được cung cấp và chỉ đưa kích thước vào khi node sở hữu ảnh có các giá trị đó. State
gallery và carousel lưu `selectedIndex` có giới hạn, đếm từ 0 (state version 2); state cũ version 1 được migrate về mục
đầu tiên, và chỉ số luôn được chuẩn hoá theo props hiện tại. Lựa chọn gallery/carousel được ghi qua binding `media.view`
của host. Khi node từ chối một lần ghi, widget vẽ lại mục node đang giữ và nói lý do ngay bên cạnh, giống các view widget
khác. Semantic document của chúng đếm theo cách con người đếm, dưới một tên khác: `selectedNumber` là mục đang chọn đếm
từ 1, đi cùng `itemCount` và alt text của mục đó, còn summary ghi "showing picture 2 of 3". Gallery hoặc carousel được
đặt trước khi có binding này thì không có binding `media.view`; chúng vẫn render và lựa chọn vẫn hoạt động trên trang,
nhưng lựa chọn đó không được lưu, nên document của chúng báo mục đầu tiên.

Layout ghép chỉ liệt kê một widget khi node có nguồn dữ liệu thật cho nó. Với media, đó là một ảnh đã nhập, và giờ có
thêm gallery và carousel: một lá `canvas.gallery@1` hoặc `canvas.carousel@1` hiển thị chính những ảnh người dùng đã
nhập, mới nhất trước, đúng các tham chiếu mà `/images` phục vụ, cắt theo sức chứa của widget (48 với gallery, 24 với
carousel). Bộ ảnh là những ảnh có mặt lúc layout được ghép: ảnh nhập sau đó chỉ xuất hiện trong một layout được ghép
mới, còn ảnh đã bị xoá thì không còn được vẽ. Node điền `imageRefs` và `alts`; model chỉ nêu widget, tiêu đề và cách nối dây, còn ảnh nào model tự nêu
đều bị bỏ qua. Một layout yêu cầu gallery hay carousel khi node không có ảnh nào sẽ bị từ chối kèm lý do, và một bộ ảnh
đã đặt mà mọi ảnh đều bị xoá được hiển thị là thiếu thay vì ảnh hỏng. Video hay YouTube embed vẫn chưa có nguồn và bị từ
chối. Chọn một ảnh trong gallery hay carousel của layout ghép sẽ phát `media.select` với `{ "selectedIndex" }`, đúng
trường mà widget lưu, nên một quy tắc đồ thị như `select-field` vào một khoá number đã khai báo sẽ giữ lựa chọn đó trên
node. Lá nào chọn cùng khoá đó sẽ nhận lại giá trị làm lựa chọn của chính nó: hai lá media nối vào một khoá sẽ đi theo
nhau, và `semanticState` của bề mặt cùng `inspect_ui` đều báo giá trị đó. Giá trị đó là chỉ số được lưu, đếm từ 0:
ảnh thứ hai được giữ và báo là `1`. Chỉ semantic summary riêng của widget media mới đếm từ 1 (`selectedNumber`,
"showing picture 2 of 3"); một khoá đồ thị nhận từ `media.select` thì không, nên model đọc khoá đó phải cộng 1 để gọi
tên ảnh theo cách con người đếm. Gallery hay carousel không nối dây trong một bề mặt ghép chỉ giữ lựa chọn trên trang.

`canvas.video@1` lưu `status`, `position` và `duration` qua cùng binding của host (state version 2; state cũ
version 1 được migrate thành paused tại 0). Các lần ghi vị trí đi qua một bộ gộp playback dùng chung
([playback-coalescer.ts](../packages/conversation-client/src/playback-coalescer.ts)), chính bộ mà trình phát âm thanh
(§8.14) dùng lại: pause, seek và kết thúc ghi ngay; trong khi phát liên tục thì tối đa mỗi
`MEDIA_PLAYBACK_WRITE_INTERVAL_MS` (ba giây) mới ghi một lần. Mỗi lần ghi là một view action có binding, nên nó cũng ghi
một action invocation và trả về timeline của cuộc hội thoại; một đường chỉ-ghi-state nhẹ hơn sẽ cần route mới và không
thuộc thay đổi này. Việc ghi khuếch đại đó, cùng thời gian giữ các bản ghi invocation, được theo dõi ở [#380](https://github.com/digitopvn/clarkcant/issues/380). Khi trang bị ẩn, player ghi vị trí hiện tại; khi rời trang hoặc player bị gỡ, nó tự ghi trạng thái
dừng tại chỗ đã dừng. Lần ghi khi rời trang được gửi ngay với `keepalive`, không phải chờ sau một lần ghi đang chạy, và
dùng revision mà lần ghi đó sẽ tạo ra. Mọi lần ghi này đều là best-effort: trang đang đóng vẫn có thể không gửi xong
request, và lần ghi khi rời trang bị từ chối nếu lần ghi trước nó bị từ chối. Vì vậy node
cũng thôi tin một "playing" đã lưu khi nó cũ hơn `MEDIA_PLAYING_FRESH_MS` (hai khoảng ghi cộng hai giây dư, tính từ
`updated_at` của dòng state): khi đó semantic document báo video dừng ở vị trí đã lưu cuối cùng. Một lần ghi playback bị
từ chối được nói ngay bên cạnh player, player không bị tua đi, và lần ghi kế tiếp vẫn được gửi dù player chưa di chuyển.
Player được khôi
phục sẽ tua tới vị trí đã lưu khi metadata tải xong và vẫn dừng; khôi phục không bao giờ tự phát, và lần tua do khôi
phục không được ghi ngược lại. Semantic document báo vị trí và thời lượng làm tròn tới
một phần mười giây. Semantic của YouTube chỉ dùng video id đã kiểm tra cùng title; không đọc
message playback của bên thứ ba. Image, gallery/carousel, video cục bộ và YouTube dùng chung một document có giới hạn
cho voice, ghi chú lượt kế tiếp và `inspect_ui`.

Ghim một widget media hoạt động như với tree và timeline: pin là một chip gọn trên kệ, và cả bản ghi pin lẫn view state
của widget đều còn sau khi tải lại. Không có player thứ hai được ghim và chạy riêng; sau khi tải lại, chính widget trong
cuộc hội thoại mở lại với state đã lưu.

Unit test nằm ở [media-view.spec.ts](../packages/contracts/test/media-view.spec.ts) (gồm khoảng thời gian còn tin
"playing"),
[playback-coalescer.spec.ts](../packages/conversation-client/test/playback-coalescer.spec.ts) (gồm số lần ghi trong một phút
phát liên tục và các lần ghi khi trang bị ẩn, bị rời đi hoặc player bị gỡ),
[media-renderers.spec.ts](../packages/conversation-client/test/media-renderers.spec.ts) (gồm thông báo từ chối),
[widget-semantic.spec.ts](../apps/runtime/test/widget-semantic.spec.ts) (gồm một "playing" đã cũ, một gallery được đặt
không có binding, và giới hạn ở props lớn nhất được chấp nhận) và
[security.spec.ts](../apps/desktop/test/security.spec.ts) cho media policy của desktop. Các browser journey trong
[widget.spec.ts](../apps/web/e2e/widget.spec.ts) xác minh lựa chọn gallery qua `inspect_ui`, lựa chọn carousel qua ghi
chú lượt kế tiếp, một lựa chọn bị từ chối ở cả hai, và state của carousel sau khi ghim rồi tải lại, với focus bàn phím
và cả hai theme ở 390 px. Gallery và carousel đặt trong layout ghép được kiểm bởi
[compose-layout.spec.ts](../apps/runtime/test/compose-layout.spec.ts) (ảnh của chính node, giới hạn theo từng widget,
từ chối khi không có ảnh), [composition-graph.spec.ts](../apps/runtime/test/composition-graph.spec.ts) (lựa chọn được
giữ, đọc lại, bị từ chối khi sai kiểu, và báo thiếu khi ảnh đã bị xoá) và browser journey trong
[composition-graph.spec.ts](../apps/web/e2e/composition-graph.spec.ts): chọn một ảnh bằng bàn phím, thấy carousel đi
theo, đọc giá trị qua bề mặt live và `inspect_ui`, tải lại, và kiểm tra cả hai theme ở 390 px. [widget.spec.ts](../apps/web/e2e/widget.spec.ts) cũng phát một clip WebM cục bộ thật trong Chromium khoảng năm giây và đếm số lần ghi so
với số nhịp đồng hồ, từ chối một lần ghi, đọc vị trí đã dừng qua `inspect_ui`, rồi tải lại sau khi ghim để kiểm tra
player mở lại đúng vị trí đó mà không tự phát.

Node chưa nhập được video: `/images` chỉ nhận ảnh. Vì vậy video cục bộ chỉ phát được từ một tham chiếu mà host đã phục
vụ sẵn, và browser journey tự trả bytes cho đúng một tham chiếu của clip; phần fetch có xác thực, object URL, page
policy, player và state do node giữ đều là đường production. Video đó phát từ object URL mà client tạo từ bytes đã fetch
bằng token của node, giống hệt ảnh đã nhập. Vì vậy page
policy cho phép `media-src 'self' blob:` ở cả [apps/web/index.html](../apps/web/index.html) và policy của cửa sổ desktop
([security.mjs](../apps/desktop/src/security.mjs)), và không gì hơn: không origin media từ xa và không media `data:`
([#374](https://github.com/digitopvn/clarkcant/issues/374)). Embed YouTube là một frame, do `frame-src` quản lý, không
thuộc directive này.

**Khi nào bytes của player được đọc.** Ảnh, kể cả ảnh poster của video, được đọc ngay khi cuộc hội thoại liệt kê chúng:
poster là một ảnh tĩnh chịu cùng giới hạn nhập như mọi ảnh khác, và là thứ đứng thay player. Bytes của video hay tệp
âm thanh được đọc qua cùng client có xác thực, thành object URL, nhưng chỉ khi thật sự cần
([#403](https://github.com/digitopvn/clarkcant/issues/403)): khi player tới trong phạm vi nửa màn hình quanh phần
transcript đang hiển thị (một `IntersectionObserver` gốc tại chính vùng cuộn của transcript), hoặc khi người dùng bấm
nút Phát của host đứng thay player cho tới lúc đó. Bấm nút sẽ báo bytes đang tải, không bịa ra tiến độ, và giữ focus
trên nút. Khi bytes về, player gốc thế chỗ và nhận focus, khôi phục vị trí đã lưu, rồi phát vì người dùng đã yêu cầu,
nhưng chỉ khi lần bấm đó vẫn còn hiệu lực: nếu trong lúc chờ có player khác đã phát, hoặc người dùng đã chuyển focus
sang chỗ khác, player vẫn dừng. Phát bất kỳ player nào của host sẽ dừng player đang phát, nên chỉ có một nơi phát tại
một thời điểm. Khi không có observer, không gì được đọc cho tới khi bấm Phát. Nguồn không đọc được thì báo trong một
status nhận lại focus của nút Phát: điều gì đã hỏng, cuộc hội thoại vẫn giữ nguyên, và mở lại hội thoại để thử lại.
Các object URL theo đúng quy tắc của ảnh trong
[use-object-urls.ts](../packages/conversation-client/src/use-object-urls.ts): mỗi tham chiếu một lần fetch và một chủ
sở hữu, được giải phóng khi tham chiếu rời cuộc hội thoại, và lần trả về muộn bị giải phóng chứ không được lưu.
Test: [object-urls.spec.ts](../packages/conversation-client/test/object-urls.spec.ts),
[near-viewport.spec.ts](../packages/conversation-client/test/near-viewport.spec.ts),
[playback-owner.spec.ts](../packages/conversation-client/test/playback-owner.spec.ts),
[media-renderers.spec.ts](../packages/conversation-client/test/media-renderers.spec.ts) và browser journey
[lazy-media.spec.ts](../apps/web/e2e/lazy-media.spec.ts). Journey đếm mọi lần đọc media: không lần nào khi mở một cuộc
hội thoại có ba video và một player âm thanh; một lần khi một player vào trong phạm vi lề, trước khi nó hiện ra; một lần
cho player âm thanh khi cuộn tới; và một lần khi phát một player lúc không có observer. Nó cũng kiểm tra vị trí đã dừng
quay lại sau khi tải lại và nút Phát bắt đầu từ vị trí đó, một lần bấm đã cũ không tự phát player, phát một player sẽ
dừng player khác, và nguồn bị từ chối được thông báo và nhận focus.

### 8.12 Sơ đồ và đồ thị

`canvas.diagram@1` vẽ một đồ thị node và cạnh có giới hạn kích thước (lưu đồ, đồ thị phụ thuộc, một cây nhỏ) dưới dạng
SVG do chính host dựng. Không có gì trong đó được thực thi: nhãn là text node, hình và đường là các con số từ một bố cục
dùng chung, và không có HTML, `foreignObject`, liên kết, ảnh, style hay handler nào mà một nhãn có thể gọi tới. Sơ đồ có
tối đa 60 node và 120 cạnh. ID node dài tối đa 64 ký tự gồm chữ cái ASCII, chữ số, `_` và `-`; nhãn là một dòng tối đa
80 ký tự, nhãn cạnh 40, nhóm 40 và tiêu đề 200. Hình của node là `box`, `round`, `diamond` hoặc `circle`; hướng của cạnh
là `forward`, `both` hoặc `none`. Khi đặt, node từ chối ID node bị lặp, cạnh trỏ tới node không tồn tại, cạnh từ một
node về chính nó, cùng một cạnh hai lần, đồ thị vượt số lượng, trường lạ và ký tự ẩn, mỗi trường hợp bằng câu giải thích
của chính host.

`layout` là `layered` (mặc định) hoặc `tree`, còn `direction` là `TB` hoặc `LR`. Bố cục phân lớp phá vòng tại cạnh mà
props dùng để khép vòng, chia lớp theo đường dài nhất, bẻ các cạnh dài qua những lớp chúng đi ngang và sắp thứ tự mỗi lớp
bằng một số lượt barycenter cố định; bố cục cây đặt node con cân giữa dưới node cha và từ chối đồ thị không phải là
rừng. Khoảng trống chứa nhãn của một cạnh được nới rộng để chứa trọn nhãn, và các cạnh nối cùng hai node (ví dụ mỗi
chiều một cạnh) được vẽ tách nhau. Cả hai đều tất định: cùng props luôn cho cùng một hình vẽ, trên node và trên mọi client, và đồ thị lớn nhất được
chấp nhận được dàn trong thời gian có giới hạn ([diagram-layout.ts](../packages/contracts/src/diagram-layout.ts)).

Model cũng có thể đưa cho `show_view` một lưu đồ Mermaid: `{ "mermaid": "flowchart LR ...", "title"?, "layout"? }`.
Node đọc một tập con được tài liệu hóa của cú pháp flowchart ngay trên host và chỉ lưu mô hình sơ đồ thu được; mã nguồn
Mermaid không bao giờ được lưu và renderer của Mermaid không bao giờ được tải. Tập con gồm `flowchart`/`graph` với `TB`,
`TD` hoặc `LR`; node dạng `id`, `id[box]`, `id(round)`, `id{diamond}` và `id((circle))`; liên kết `-->`, `---`,
`<-->`, `-->|nhãn|` và `-- nhãn -->`; một cấp `subgraph` làm nhóm của node (node được nêu bên ngoài trước sẽ vào
subgraph nêu nó sau đó, giống Mermaid, còn node được nêu trong hai subgraph bị từ chối); `accTitle` làm tiêu đề. Chú
thích `%%` và `accDescr` một dòng được bỏ qua vì không vẽ gì. Mã nguồn nêu quá 60 node hoặc 120 liên kết bị từ chối
ngay khi vượt giới hạn. Mọi
thứ cấu hình hoặc mở rộng renderer của Mermaid đều bị từ chối theo dòng kèm lý do: `click`, `href`, `call`, `style`,
`classDef`, `class`, `:::`, `linkStyle`, directive `%%{init}%%`, front matter, HTML hoặc mã entity trong nhãn, chuỗi
Markdown, icon `fa:`, các hình node khác, các kiểu liên kết khác, chuỗi `&`, subgraph lồng nhau và các loại sơ đồ khác
([diagram-mermaid.ts](../packages/contracts/src/diagram-mermaid.ts)).

`diagram.select` mang `{ selectedId }`; node kiểm tra nó với props hiện tại và giữ trong trạng thái widget, nên lựa chọn
vẫn còn sau khi tải lại, và state đã khôi phục bỏ qua ID mà props không còn chứa. Mỗi node là một nút có tên truy cập nói
rõ nhãn, hình, nhóm và các node nó dẫn tới, đến từ và nối với, mỗi node kèm nhãn của cạnh nối chúng ("dẫn tới Ship
(yes)"), nên các nhánh của một quyết định được nghe thấy chứ không chỉ được nhìn thấy. Chỉ một node nằm trong thứ tự tab; phím theo chiều luồng
(Xuống với `TB`, Phải với `LR`) đi theo một cạnh về phía trước, phím ngược lại đi theo cạnh quay về, các phím ngang đi
trong cùng một lớp, Home/End tới node đầu và cuối, Enter/Space chọn node đang có tiêu điểm hoặc bỏ chọn nếu node đó đã được chọn, và Escape để bỏ chọn. Node được chọn làm nổi các
cạnh và node kề bằng độ dày nét và nét đứt chứ không chỉ bằng màu, và một vùng live thông báo thay đổi. Hình vẽ rộng giữ
nguyên kích thước và cuộn bên trong thẻ, nên trang không bao giờ cuộn ngang; sơ đồ không tự tạo chuyển động và theo cả
hai theme. Tài liệu semantic báo số node và cạnh, bố cục và hướng, cùng node được chọn với số cạnh vào/ra/nối và các node kề, mỗi node kèm nhãn cạnh; phần thay
thế dạng chữ, cũng hiện dưới hình vẽ, liệt kê mọi node cùng các cạnh đi ra của nó.

Kiểm thử: [diagram-view.spec.ts](../packages/contracts/test/diagram-view.spec.ts) kiểm tra giới hạn, đồ thị lỗi, state,
chữ và semantic; [diagram-mermaid.spec.ts](../packages/contracts/test/diagram-mermaid.spec.ts) kiểm tra tập con và mọi
cấu trúc bị từ chối; [diagram-layout.spec.ts](../packages/contracts/test/diagram-layout.spec.ts) kiểm tra tính tất
định, việc chia lớp, không chồng lấn ở cả hai hướng và giới hạn thời gian;
[diagram-view.spec.ts](../apps/runtime/test/diagram-view.spec.ts) kiểm tra placement, đầu vào Mermaid, các lần từ chối,
lựa chọn và semantic output; [diagram-view.spec.ts](../packages/conversation-client/test/diagram-view.spec.ts) kiểm tra
di chuyển bằng bàn phím, tên truy cập và nhãn có dạng markup được vẽ thành chữ; journey trình duyệt
[diagram-view.spec.ts](../apps/web/e2e/diagram-view.spec.ts) bao phủ hội thoại, di chuyển bằng bàn phím với tiêu điểm
nhìn thấy được, lựa chọn được giữ qua lần tải lại, DOM không có gì chạy hay tải được, đầu vào Mermaid, các lần từ chối,
cả hai theme ở 390 px, giảm chuyển động và bản xem trước trong Widget Library.

### 8.13 Bản đồ

`canvas.map@1` vẽ một tập điểm, đường và vùng có giới hạn trên một nền bản đồ ngoại tuyến
([#322](https://github.com/digitopvn/clarkcant/issues/322)). Vị trí là `[kinh độ, vĩ độ]` WGS84, theo một tập con chặt
của hình học GeoJSON: `Point`, `LineString` và `Polygon` (một đường viền cộng tối đa 15 lỗ, mỗi vòng phải khép kín). Một
bản đồ có tối đa 200 đối tượng và tổng cộng 5.000 vị trí. ID dài tối đa 120 ký tự, nhãn 120, mô tả 300, tiêu đề 200.
`view` tùy chọn có dạng `{ center, zoom }` (zoom là số nguyên từ 0 đến 18) và thay cho khung nhìn tự canh.

Khi đặt, bản đồ bị từ chối kèm lý do nếu có: tọa độ nằm ngoài địa cầu, loại hình học lạ, quá nhiều đối tượng hoặc vị
trí, chữ quá dài hoặc lặp, ký tự ẩn, và **bất kỳ URL nào**. Một khóa mang tên liên kết (`url`, `href`, `src`, `tile`,
`endpoint`, …) hoặc một giá trị là liên kết (`https://`, `//`, `data:`, `javascript:`, `blob:`) đều bị từ chối, nên props
không bao giờ nêu được một host. Widget này không làm geocoding, chỉ đường, định vị, vector tile, 3D, gom cụm hay
chỉnh sửa.

Nền bản đồ là lớp đất liền Natural Earth tỉ lệ 1:110m, phiên bản 5.1.2, thuộc phạm vi công cộng. Nó được sinh vào
[map-basemap.ts](../packages/conversation-client/src/map-basemap.ts) bằng
[build-map-basemap.mjs](../tools/build-map-basemap.mjs), công cụ này ghim SHA-256 của tệp nguồn, và bản đồ ghi nguồn ngay
dưới mỗi hình vẽ. Nền đi kèm client, nên khi không có tile policy, bản đồ không gửi yêu cầu nào ra ngoài node.

Ô bản đồ raster chỉ xuất hiện khi node có tile policy, tức preference đã đăng ký `maps.tilePolicy`. Mặc định nó là
`null`. Con người ghi nó trong Cài đặt, còn Clark ghi qua công cụ của mình theo execution policy; AI client qua socket hay
MCP không ghi hay hoàn tác trực tiếp được (`isPersonOnlyRoute`). Một policy nêu đúng một nhà cung cấp:

```json
{
  "origin": "https://tiles.example.com",
  "template": "/styles/basic/{z}/{x}/{y}.png",
  "attribution": "© Example contributors",
  "maxZoom": 17,
  "credential": { "secret": "maps:tiles", "header": "x-api-key" }
}
```

`origin` phải đúng dạng `scheme://host[:port]`: https, hoặc http chỉ với địa chỉ loopback. `template` là một đường dẫn
trên origin đó, có `{z}`, `{x}` và `{y}`, mỗi thứ đúng một lần. Query của nó không được chứa khóa, token, secret hay chữ
ký. `credential` là tùy chọn. Khi có, `secret` luôn là `maps:tiles`, khóa ô bản đồ riêng của host, và policy nêu bất kỳ
secret nào khác đều bị từ chối. `header` hoặc `query` nói khóa được đặt ở đâu. Trang không bao giờ fetch nhà cung cấp. Nó
hỏi node qua `GET /map-tiles/:z/:x/:y`, và node:

- dựng địa chỉ từ policy;
- kiểm tra z, x, y theo `maxZoom` (tối đa 19) và lưới ô;
- không đi theo redirect;
- chỉ trả PNG hoặc WebP, kiểm cả content type của nhà cung cấp lẫn bytes, tối đa 512 KiB, kèm `nosniff`;
- giới hạn tốc độ 12 yêu cầu mỗi giây, dồn tối đa 48;
- cache tối đa 256 ô hoặc 24 MiB, trong một giờ.

`GET /map-tiles` cho trang biết origin, attribution và zoom tối đa của nhà cung cấp, không bao giờ cho biết template
hay khóa. Khi không có policy, mọi yêu cầu ô đều bị từ chối với `MAP_TILES_OFF` và không ai bị hỏi. Khi bản đồ chỉ dùng
nền ngoại tuyến, câu trả lời nói lý do trong `offline`:

- `no-provider`: chưa đặt policy nào;
- `key-unavailable`: policy cần khóa nhưng chưa có khóa nào được lưu;
- `key-origin-mismatch`: khóa đã lưu được nhập cho một origin khác.

Ở cả hai trường hợp về khóa, nhà cung cấp không được đưa cho trang, nên trang không xin ô nào chắc chắn sẽ lỗi, và một
yêu cầu ô nhận `503 MAP_TILE_KEY_UNAVAILABLE` kèm cùng lý do `offline`. Dòng attribution của bản đồ nêu lý do và chỗ sửa.
Trang vẽ ô từ URL `blob:`, nên page policy không đổi.

**Khóa gắn với origin của nó.** Con người nhập khóa trong **Cài đặt → Tiện ích → Ô bản đồ**, nơi lưu nó qua route chỉ
dành cho người `PUT /map-tiles/key` thành secret `maps:tiles` của node. Consumer duy nhất của secret là
`maps:tiles@<origin>`, tức origin mà khóa được nhập cho. Proxy xin secret broker theo consumer của origin trong policy, nên
khóa chỉ được gửi tới đúng origin đó, không đi đâu khác. `GET /map-tiles/key` trả `{ key: { origin } }` hoặc
`{ key: null }`, không bao giờ trả giá trị, còn `DELETE /map-tiles/key` xóa khóa. Form credential chung
(`POST /credentials`) từ chối tên `maps:tiles` và mọi consumer `maps:tiles`. Chỉ con người nhập khóa trong Cài đặt mới gắn
được khóa, nên Clark không thể chuyển nó đi.

Con người đặt và xóa policy trong cùng mục Cài đặt đó: địa chỉ nhà cung cấp, đường dẫn ô, ghi công, mức phóng to tối đa,
và một khóa tùy chọn cùng header hoặc query parameter chứa nó. Mục này không bao giờ hiển thị lại khóa. Nó hiện
"Đang kiểm tra…" cho tới khi node trả lời, sau đó cho biết đã lưu khóa chưa và khóa được gửi tới origin nào, và báo lỗi
nếu node không trả lời được. **Tắt ô bản đồ** ghi `null`. **Xóa khóa** bỏ khóa khỏi policy và xóa nó. **Hoàn tác thay
đổi gần nhất** khôi phục policy trước đó, dù ai đã ghi nó.

Clark làm điều tương tự qua công cụ `set_map_tiles`, dùng cùng `writeMapTilePolicy`
([map-tile-policy.ts](../apps/runtime/src/application/map-tile-policy.ts)). Đặt hay xóa policy là một tác động như mọi tác
động khác, và execution policy quyết định nó. Ở chế độ Tự chủ, nó chạy, kèm bản ghi hoạt động và nút Hoàn tác trong Cài
đặt. Ở chế độ Hỏi, nó là một thẻ duyệt do host sở hữu, và chỉ quyết định của con người trên route decide dành riêng cho
người mới ghi nó. Khi mọi tác động đều bị cấm, nó bị từ chối, kể cả vào lúc thẻ được duyệt. Preference ghi lại ai đã ghi
nó: `user` cho Cài đặt, `agent` cho Clark.

Công cụ chỉ nhận tên header hoặc query, không bao giờ nhận khóa hay tên secret. Thẻ duyệt và kết quả nói khóa được gửi
tới đâu: tới origin của policy, hoặc không đi đâu cả khi Clark đặt một nhà cung cấp ở origin khác với origin của khóa. Nhà
cung cấp như vậy chỉ dùng nền ngoại tuyến cho tới khi con người nhập lại khóa cho nó. Widget không chạm được vào bất kỳ
phần nào ở đây.

Khóa không bao giờ đến trang, props, state, log, khóa cache, thông báo lỗi hay model. Dòng attribution dưới bản đồ nêu
origin của ô và attribution của nó, và bản đồ không có huy hiệu "live".
`map.select` mang `{ selectedId }` (rỗng để bỏ chọn), `map.view` mang `{ center, zoom }`. Node kiểm tra cả hai theo props
hiện tại và giữ chúng làm state của widget. Một lần kéo bản đồ được ghi 400 ms sau khi dừng, nên một chuỗi phím chỉ là
một lần ghi. `map.select` cũng là một sự kiện của composition graph, có trường `selectedId`.

Vùng bản đồ nhận focus và dùng được bằng bàn phím:

- phím mũi tên để kéo, giữ Shift để kéo xa hơn;
- `+` và `-` để phóng to, thu nhỏ, `0` để về khung nhìn ban đầu;
- `N` và `P` để đi qua các đối tượng, Escape để bỏ chọn.

Kéo bằng con trỏ cũng được. Trên màn hình cảm ứng, vuốt qua một bản đồ chưa được chạm sẽ cuộn cuộc trò chuyện; sau khi
chạm vào bản đồ, kéo sẽ di chuyển nó. Bản đồ là một thế giới không lặp lại: khung nhìn dừng ở kinh tuyến 180, và bản đồ
nền, các đối tượng cùng các ô đều chỉ được vẽ một lần. Các nút phóng to, thu nhỏ và về ban đầu rộng 44 px. Một live
region đọc khung nhìn khi nó đã dừng, và lựa chọn. Các ô chỉ được xin khi khung nhìn đã dừng; một ô lỗi vì lý do tạm
thời được xin lại sau một lúc. Bên dưới bản đồ, một bảng liệt kê mọi đối tượng cùng loại và vị trí. Nút Chọn trong bảng chọn đối tượng trên
bản đồ và đưa nó vào khung nhìn; chọn trên bản đồ thì tô sáng dòng tương ứng. Bản đồ chỉ trượt khi được phép chuyển
động; với giảm chuyển động, khung nhìn đổi ngay. Mọi màu đều là theme token. Bản đồ hẹp đưa các nút điều khiển xuống
dưới hình và vẽ nhãn lớn hơn, và không có gì tràn ở 390 px.

Tài liệu semantic báo:

- số đối tượng và số lượng từng loại;
- vùng đang thấy và zoom;
- nhãn và tọa độ của đối tượng đang chọn;
- ô bản đồ là ngoại tuyến hay từ origin trong policy.

Bản văn bản thay thế liệt kê mọi đối tượng cùng loại và vị trí. Cả hai đều nằm trong `SEMANTIC_LIMITS`.

Kiểm thử: [map-view.spec.ts](../packages/contracts/test/map-view.spec.ts) kiểm giới hạn, việc từ chối URL, phép chiếu,
semantic, schema của tile policy và route chỉ dành cho người;
[map-view.spec.ts](../apps/runtime/test/map-view.spec.ts) kiểm việc đặt, từ chối, state và semantic khi có và không có
policy; [map-tiles.spec.ts](../apps/runtime/test/map-tiles.spec.ts) kiểm allowlist của proxy, content type, giới hạn
kích thước và zoom, cache, tốc độ, việc từ chối redirect, rằng khóa chỉ được gửi tới origin nó được gắn, và không bao giờ bị trả về;
[map-tile-policy.spec.ts](../apps/runtime/test/map-tile-policy.spec.ts) kiểm việc Cài đặt và Clark đặt, xóa policy ở
từng chế độ thực thi, ai được ghi là tác giả, thẻ duyệt, digest của nó, việc từ chối, việc gắn khóa với origin, việc từ
chối policy nêu secret khác, và rằng khóa không bao giờ bị trả lại;
[open-interfaces.spec.ts](../apps/runtime/test/open-interfaces.spec.ts) kiểm rằng relay từ chối việc ghi policy, việc hoàn
tác nó và các route của khóa; [map-tile-settings.spec.ts](../apps/web/e2e/map-tile-settings.spec.ts) bật ô từ Cài đặt với
một nhà cung cấp giả cục bộ từ chối yêu cầu không có khóa, thấy ô trên bản đồ, tắt đi rồi hoàn tác. Nó cũng để Clark đặt
và xóa nhà cung cấp ở chế độ Tự chủ và qua một thẻ đã được duyệt ở chế độ Hỏi, và cho thấy một nhà cung cấp Clark đặt ở
origin khác với origin của khóa chỉ dùng nền ngoại tuyến với `key-origin-mismatch`;
[map-layout.spec.ts](../packages/conversation-client/test/map-layout.spec.ts) kiểm nguồn gốc của nền bản đồ, phép
chiếu và lưới ô; [map-schemas.spec.ts](../packages/widget-catalog/test/map-schemas.spec.ts) kiểm fixture và sự khớp
nhau giữa schema và runtime. Browser journey [map-view.spec.ts](../apps/web/e2e/map-view.spec.ts) bao quát:

- chọn bằng bàn phím và bằng bảng, giữ qua lần tải lại;
- không có yêu cầu nào ra ngoài node khi không có policy;
- ô fixture được lấy qua node kèm attribution;
- các trường hợp bị từ chối;
- cả hai theme, giảm chuyển động và 390 px;
- bản xem trước trong Widget Library.

### 8.14 Trình phát âm thanh và xem trước tài liệu

`canvas.audio@1` phát một tệp âm thanh và `canvas.document@1` xem trước phần chữ của một tệp PDF hoặc tệp văn bản
([#324](https://github.com/digitopvn/clarkcant/issues/324)). Cả hai là widget catalog do host vẽ, được model đặt bằng
`show_view`. Không widget nào nhận thứ gì mà trang phải tự fetch: model nêu một nguồn, node đọc nguồn đó, kiểm tra theo
chính sách nội dung media (§14.5) và chỉ lưu những gì đã kiểm tra.

**Âm thanh.** Model nêu đúng một nguồn và một `title`, kèm `transcript` tuỳ chọn (tối đa 4.000 ký tự):

- `artifactId` hoặc `attachmentId`: một tệp mà người dùng đang có trong cuộc hội thoại này, chẳng hạn một tệp WAV họ đã gửi
  (loại tệp đính kèm `audio`) hoặc một tệp WAV mà service của package đã render (§14.4);
- `url`: một URL `https` thuộc origin mà chính sách media của node cho phép. Node fetch, kiểm tra, rồi giữ tệp thành
  một artifact đã niêm phong của cuộc hội thoại, cấp quyền cho player, trong cùng transaction đặt player. Về sau có thể
  đặt lại artifact đó bằng id mà không phải fetch lần nữa.

Node tự điền `audioRef` (`artifact:<id>` hoặc `attachment:<id>`, không bao giờ là URL), `mimeType`, `durationSeconds`,
`sizeBytes` và, với tệp được fetch, `sourceOrigin`. Model nào tự đưa các trường này đều bị từ chối, nên player không bao
giờ tuyên bố một kiểu hay một độ dài mà chưa ai kiểm tra. Trang phát tệp từ node qua cùng object URL có xác thực như ảnh,
chỉ được đọc khi player thật sự cần (§8.11), với điều khiển gốc của trình duyệt (dùng được bằng bàn phím) và
`preload="metadata"`. Nó không bao giờ tự phát, kể cả lần vẽ đầu hay khi khôi phục. Bản ghi lời được vẽ thành chữ trong
một khối mở/đóng, mọi ký tự ẩn hiện thành dấu đánh dấu. Trạng thái phát giống video: `status`, `position` và `duration` qua binding `media.view` (state version 2), ghi qua
bộ gộp playback dùng chung và khôi phục ở trạng thái dừng tại vị trí đã lưu. Semantic document báo trạng thái, vị trí và
thời lượng làm tròn tới một phần mười giây, tiêu đề và việc có bản ghi lời hay không; khi player chưa báo thời lượng,
độ dài node đọc được từ tệp được dùng thay.

**Tài liệu.** Model nêu đúng một nguồn, `artifactId` hoặc `attachmentId`, là một tệp PDF hoặc tệp văn bản
(`text/plain`, `text/markdown`, `text/csv`, `text/tab-separated-values`, `application/json`) trong cuộc hội thoại này,
kèm `title` tuỳ chọn. Node đọc phần chữ (chữ trong PDF được đọc bằng bộ đọc riêng của node, không thêm dependency),
chia thành tối đa 10 trang, mỗi trang tối đa 2.000 ký tự, ngắt ở cuối dòng hoặc ở dấu cách gần cuối trang và không bao
giờ cắt giữa một ký tự, và giữ tối đa 20.000 ký tự. Node lưu các trang, số trang của chính tệp PDF khi đọc được,
`totalChars` và `truncated`. Bản xem trước chỉ có chữ: hình ảnh và bố cục không được hiển thị, và không gì trong tệp
được phân tích như markup hay được chạy. Trang hiển thị từng trang trong một vùng cuộn mà bàn phím tới được. Có nút
Trang trước và Trang sau, vị trí được thông báo nhẹ nhàng, và một dòng báo khi bản xem trước bị cắt cùng phần được hiển
thị. Ký tự ẩn được vẽ thành dấu đánh dấu kèm cảnh báo. Trang người dùng đang xem là state (`{ "page" }`, đếm từ 0, state
version 2; state cũ hơn được migrate về trang đầu), ghi qua `media.view` và được kiểm tra với các trang widget đang
giữ. Semantic document đếm từ 1: `currentPage` trên `pageCount`, kèm `sourcePages` và `truncated`.

Cả hai widget không có trong layout ghép: mỗi widget được đặt bằng `show_view` riêng, nơi node kiểm tra nguồn của nó.
Thẻ trong Library dùng props mẫu không có tệp trên node; thẻ âm thanh nói rằng chưa phát được thay vì giả vờ, và lưới
gallery không bao giờ gắn player.

Test: [media-content.spec.ts](../packages/contracts/test/media-content.spec.ts) (các quy tắc URL của chính sách, chia
trang, state của trang), [media-content.spec.ts](../apps/runtime/test/media-content.spec.ts) (đọc từng kiểu âm thanh
và độ dài từ bytes, và lần fetch có giới hạn tới một origin https cục bộ thật),
[media-views.spec.ts](../apps/runtime/test/media-views.spec.ts) (đặt widget, các lần từ chối, artifact được lưu, state
và giới hạn semantic), [pdf-text.spec.ts](../apps/runtime/test/pdf-text.spec.ts) (số trang),
[media-renderers.spec.ts](../packages/conversation-client/test/media-renderers.spec.ts) và browser journey
[audio-document.spec.ts](../apps/web/e2e/audio-document.spec.ts). Journey fetch âm thanh từ một origin https cục bộ có
trong chính sách và từ ArtifactRef đã lưu. Nó kiểm tra origin chỉ nghe thấy node và trang chỉ gọi tới origin của chính
nó, phát rồi dừng bằng bàn phím, và tải lại về đúng vị trí đã dừng. Nó lật trang tài liệu bằng bàn phím và giữ trang
qua lần tải lại, và kiểm tra cả hai theme, 390 px, giảm chuyển động và bản xem trước trong Library.

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
  graph đã khai báo. Widget media chỉ được mô tả từ props đã kiểm tra và view state có giới hạn của chúng: alt text và
  kích thước đã biết của ảnh, mục đang chọn của gallery hoặc carousel (`selectedNumber`, đếm từ 1), trạng thái phát và
  vị trí của video cục bộ (một "playing" mà player không còn ghi mới được đọc là đang dừng), cùng
  id đã kiểm tra và title của video YouTube ([§8.11](#811-widget-media-và-trạng-thái-semantic)).
- **Widget chạy trong frame riêng** đề xuất summary, selected ID và giá trị bằng
  `semantic.publish(summary, selectedIds, values?)`. Host gửi lần publish cuối của một loạt sau 250 ms, kiểm tra theo
  schema chặt (`POST …/widgets/{instanceId}/semantic`), làm sạch và đánh dấu đó là lời của chính widget. Frame không
  được nêu action: action luôn lấy từ binding của instance, nên frame không thể quảng cáo một action mà nó không được
  bind.

  Một lần bấm có thể đọc điều frame đã publish: `contextRefs` của binding `agent` (`selection:…`, `widget:…`). Trước
  khi chạy lần bấm như vậy, host gửi lần publish còn đang chờ ổn định và chờ đến khi node đã giữ mô tả được publish
  trước lần bấm, hoặc một mô tả mới hơn, nên lần bấm không bao giờ đọc một mô tả cũ hơn. Các lần publish sau lần bấm
  vẫn được gửi như thường nhưng không được chờ, nên một widget publish liên tục không thể giữ lần bấm lại.
  Các lần bấm khác chỉ chờ lần publish còn đang chờ ổn định, hoặc lần mà node vừa từ chối. Thời gian chờ có giới hạn: mỗi lần gửi bị bỏ sau
  5 giây và toàn bộ việc chờ sau 8 giây. Mô tả bị node từ chối được gửi lại một lần; nếu vẫn hỏng, hoặc hết thời gian
  chờ, `actions.invoke` bị từ chối kèm câu của host ("Chưa gửi kịp cho Clark điều widget đang hiển thị, nên hành động
  này chưa chạy…"). Không có gì trong frame bị thay đổi, và người dùng có thể bấm lại. Widget nên hiện lời từ chối đó ở
  chỗ người dùng đã bấm.

Khi phát triển package, semantic inspector hiển thị tài liệu sau cùng bước chuẩn hoá, delta, ghi chú ngữ cảnh cho lượt
kế tiếp và `inspect_ui`. Nó đánh dấu các trường mà normalizer đã cắt hoặc loại bỏ, đồng thời cảnh báo khi publish quá
bốn lần mỗi giây. Các chẩn đoán này không chạy model turn và không đổi giới hạn của runtime.

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

    artifacts.available()
    artifacts.pick({ accept? })
    artifacts.read(ref, { offset, length })
    artifacts.create({ mimeType, name? })
    artifacts.write(ref, chunk)
    artifacts.finalize(ref)
    artifacts.export(ref, { suggestedName })
    artifacts.attachToConversation(ref, { name? })
    artifacts.discard(ref)

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

### Diện mạo (`appearance@1`)

`appearance.current()` trả về `AppearanceSnapshot` đã kiểm tra và đóng băng sâu dùng để vẽ widget này, hoặc `undefined`
khi host không cung cấp extension. `appearance.subscribe(handler)` nhận các revision thay đổi và trả về hàm huỷ đăng
ký. Snapshot ban đầu có trước `lifecycle.onMount`; thay đổi không mount lại frame, ghi state, công bố nội dung semantic
hay bắt đầu lượt model. Snapshot đã phân giải phạm vi sáng/tối thực tế và giảm chuyển động. Nó chỉ chứa token công khai
có giới hạn và revision, không chứa theme thô, thông tin xác thực hay quyền truy cập host.

SDK core không phụ thuộc DOM. Với widget DOM, import `bindAppearance` từ `@clarkcant/widget-sdk/dom`, rồi gọi
`const unbind = bindAppearance(document.documentElement, api.appearance)` và gọi `unbind()` khi dispose.
`applyAppearanceToElement(element, snapshot)` áp dụng một snapshot đã kiểm tra. Các helper chỉ ghi biến token chuẩn
và thuộc tính diện mạo trên phần tử được truyền vào; giữ nguyên biến riêng của tác giả. Runtime `/widget-runtime.js`
do host phục vụ cũng export các helper này.

Định nghĩa widget có thể khai báo `"appearanceMode": "fixed"` cho hệ thống giao diện riêng; thiếu trường hoặc
`"adaptive"` nghĩa là thích ứng. Widget Lab và thẻ chi tiết cho biết widget dùng chế độ fixed. Directory có thể mang
khai báo `widgetAppearance` tuỳ chọn (`[{ "id": "…", "mode": "fixed" }]`) để hiển thị trên marketplace; định nghĩa
đã cài và kiểm tra digest vẫn là nguồn quyết định. Widget fixed vẫn nhận diện mạo và phải tôn trọng giảm chuyển động.

Bridge phiên bản 2 mang `appearance` ban đầu tuỳ chọn và công bố `appearance@1`; message cập nhật là
`{ kind: "appearance.changed", nonce, revision, appearance }`, với revision trùng khớp và kiểm tra source/nonce hiện
có. SDK mới nhận host phiên bản 1 không có extension này. SDK cũ phiên bản 1 đóng gói trong widget phải được nâng cấp
để chạy với host phiên bản 2; hãy dùng runtime do host cung cấp hoặc build lại bằng SDK hiện tại. Composition tách ra
cửa sổ riêng nhận cùng revision đã phân giải qua bootstrap/event chỉ đọc của desktop, không truy vấn theme hay nhận
thông tin xác thực. Đổi diện mạo giữ nguyên presentation đã lưu, props, state, nguồn gốc và văn bản dự phòng.

### 10.1 Tệp theo tham chiếu (`artifacts@1`)

Một widget chạy trong frame riêng có thể làm việc với tệp mà không bao giờ cầm một tệp nào. Nó chỉ giữ một
`ArtifactRef`:

    { "v": 1, "artifactId": "art_…", "kind": "external", "mimeType": "text/plain",
      "sizeBytes": 302420, "name": "bao-cao.txt", "digest": "sha256:…" }

Một ref cho biết tệp là gì: loại, kiểu, kích thước, tên hiển thị và, khi các byte đã cố định, digest của chúng. Nó
không bao giờ cho biết tệp nằm ở đâu. Không ref, message qua bridge, prop, state, dòng log hay prompt nào mang
đường dẫn, tên tệp tạm hay thư mục mà tệp được chọn nằm trong đó. **Ref là con trỏ, không phải quyền.** Node kiểm tra
lại mỗi lần dùng: chủ sở hữu, grant của instance này, grant đã hết hạn hay bị thu hồi chưa, và trạng thái của chính
artifact. Một ref bị chép sang widget khác, hoặc sang yêu cầu của principal khác, sẽ bị từ chối ở đó kèm lý do.
Hợp đồng nằm ở [artifacts.ts](../packages/contracts/src/artifacts.ts).

Extension này được đưa ra trong `init.extensions` của bridge. `artifacts.available()` cho biết host này có đưa ra nó
hay không, và khi không thì mọi lời gọi đều bị từ chối ngay trong frame. Host đưa nó cho mọi frame cách ly trong một
cuộc trò chuyện.

| Loại | Là gì | Được làm gì với nó |
| --- | --- | --- |
| `external` | Bản chụp một tệp người dùng đã chọn qua giao diện của host. | Đọc. Đã niêm phong, có digest. |
| `working` | Các byte mà instance này đang ghi. | Chỉ instance đã tạo nó được ghi, theo đúng thứ tự. Hết hạn 24 giờ sau lần ghi cuối nếu chưa cố định. |
| `finalized` | Một artifact `working` mà các byte đã được cố định. | Đọc, lưu ra, đính kèm. Được giữ lâu bằng cuộc trò chuyện của nó. |
| `attachment` | Dành sẵn cho một tệp người dùng đã đính kèm, được giao cho widget. Chưa có luồng nào của host tạo ra loại này. | – |

Mỗi lời gọi làm gì:

- `pick({ accept })` xin người dùng chọn một tệp. Widget không tự mở hộp thoại; host vẽ lời nhắc của riêng nó, bên
  ngoài frame. Lời nhắc nêu tên widget theo tiêu đề của nó, nói rằng widget chỉ nhận được tệp đã chọn chứ không bao giờ
  biết tệp nằm ở đâu, và liệt kê các kiểu được nhận bằng lời ("tệp văn bản", "ảnh PNG"). Lời nhắc nhận bàn phím ở tiêu
  đề chứ không ở một nút, nên một phím người dùng bấm cho widget không thể trả lời nó. Lời nhắc chỉ nhận bàn phím khi
  bàn phím đang ở trong frame hoặc trong phần giao diện của host quanh nó; khi người dùng đang gõ ở chỗ khác, như ô soạn
  tin, lời nhắc được đọc lên và chờ cạnh frame. Esc hoặc Huỷ trả về `undefined`. Trên desktop, lời nhắc mở hộp thoại chọn tệp
  của hệ điều hành; trên web, nó mở ô chọn tệp của trình duyệt. Node xác định kiểu từ chính các byte, đối chiếu với
  `accept`, và áp dụng các quy tắc đính kèm: kiểu nằm trong danh sách cho phép, tối đa 25 MiB một tệp, và hạn mức
  của principal. Kiểu mà hệ thống đưa ra chỉ là một lời khai, được đọc theo tên node dùng: `application/vnd.ms-excel`
  cho một tệp `.csv` trên Windows là CSV, và `image/jpg` là JPEG. Một kiểu bị thiếu hoặc chung chung
  (`application/octet-stream`) được lấy từ phần mở rộng đối với Markdown, CSV, TSV và JSON, còn lại thì đọc từ các byte.
  Giá trị phân tách bằng tab (`text/tab-separated-values`, lưu thành `.tsv`, còn được gọi là `text/tsv` hoặc `.tab`)
  theo cùng các quy tắc như CSV.
  Các ký tự đảo chiều đọc văn bản (ký tự điều khiển bidi) bị bỏ khỏi tên tệp.
- `read(ref, { offset, length })` đọc một đoạn tối đa 256 KiB và cho biết đã tới cuối tệp chưa. Tệp lớn hơn thì phải
  đọc nhiều lần.
- `create({ mimeType, name? })` bắt đầu một artifact `working` thuộc kiểu mà luồng đính kèm chấp nhận.
  `write(ref, chunk)` ghi nối thêm tối đa 256 KiB. Mỗi lần ghi phải bắt đầu đúng chỗ artifact đang kết thúc, nên một
  đoạn gửi hai lần hoặc sai thứ tự sẽ bị từ chối (`ARTIFACT_OFFSET_MISMATCH`) chứ không bị lưu hai lần. Mỗi lần ghi
  kéo dài thời hạn của artifact và grant của instance đang ghi.
- `finalize(ref)` cố định các byte. Node dò các byte đối chiếu với kiểu đã khai báo. Nếu không khớp, node từ chối với
  `ARTIFACT_TYPE_MISMATCH` và để artifact vẫn ghi được, để widget sửa lại.
- `export(ref, { suggestedName })` xin người dùng lưu một bản sao, bằng lời nhắc Lưu thành… của chính host, có nêu tên
  widget. Nó trả về `true` khi tệp đã được lưu hoặc, trên web, khi việc tải xuống đã bắt đầu, và `false` khi người dùng
  từ chối. Tên được lưu giữ theo gợi ý nhưng mang phần mở rộng của kiểu byte, nên một tệp `text/plain` được gợi ý là
  `invoice.bat` sẽ được lưu thành `invoice.txt`. Desktop dùng hộp thoại lưu của hệ điều hành, chỉ đưa ra các phần mở
  rộng của kiểu đó. Khi người dùng đã chọn một tệp trên desktop trong frame này và widget lưu ra một tệp cùng kiểu, lời
  nhắc còn đưa ra "Ghi đè “tệp gốc” bằng “tệp mới”". Nút này nêu tên cả hai tệp, vì không có gì chứng minh tệp của
  widget được làm từ tệp đã chọn. Đường dẫn đứng sau vẫn nằm trong main process của desktop, và hệ điều hành hỏi trước
  khi ghi đè. Byte mới được ghi cạnh tệp gốc rồi đổi tên đè lên nó, nên một lần ghi hỏng để nguyên tệp gốc. Tệp gốc
  giữ nguyên quyền truy cập, một liên kết được đi theo tới tệp mà nó trỏ tới, và trên Windows việc đổi tên được thử
  lại trong chốc lát khi một chương trình khác, như trình lập chỉ mục hay phần mềm diệt virus, đang giữ tệp.
  Web giao tệp cho luồng tải xuống của trình duyệt và nói "Đã bắt đầu tải xuống", vì trình duyệt, không phải trang,
  quyết định tệp nằm ở đâu; web cũng nói rằng ghi đè tệp gốc là tính năng của desktop.
- `attachToConversation(ref)` đưa một artifact đã cố định vào luồng đính kèm. Các byte được dò kiểu lại, danh sách
  cho phép, kích thước và hạn mức được kiểm tra lại. Kết quả là một chip sẵn sàng trong ô soạn tin, người dùng gửi nó
  cùng tin nhắn kế tiếp như mọi tệp họ tự đính kèm. Model sau đó đọc nó theo đúng cách đó. Mỗi tệp chỉ được đính
  kèm một lần: yêu cầu lại sẽ trả về đúng tệp đính kèm đó.
  `name` (tuỳ chọn) đề xuất tên tệp cho tệp đính kèm. Tên được rút gọn chứ không bị từ chối: runtime bỏ qua tên rỗng
  và cắt tên dài xuống 200 ký tự của bridge trước khi gửi. Sau đó node chỉ giữ phần cuối của bất cứ thứ gì trông như
  đường dẫn, bỏ các ký tự điều khiển, ký tự định dạng, ký tự đổi hướng chữ và ký tự vô hình (default-ignorable), đổi
  mọi ký tự không phải chữ cái, chữ số, dấu cách và `. _ - ( )` thành dấu gạch ngang, gộp `..` lại, cắt dấu chấm, dấu
  gạch ngang và dấu cách ở hai đầu, rồi rút tên xuống còn 100 ký tự. Node cũng buộc phần mở rộng theo kiểu của các
  byte: một ảnh PNG được đề xuất là `anh.exe` sẽ được đính kèm thành `anh.png`, còn `kite-v2.1` thành
  `kite-v2.1.png`. Khi không còn gì dùng được, node dùng tên mặc định của kiểu đó, như `untitled.png`. Không có
  `name`, tệp đính kèm lấy tên riêng của artifact, cũng được làm sạch theo cùng cách. Lần đính kèm đầu tiên quyết định
  tên: đính kèm lại cùng tệp đó sẽ trả về đúng tệp đính kèm ấy, dù lần sau đề xuất tên nào.
- `discard(ref)` bỏ một tệp mà instance này đã tạo, dù đang ghi hay đã cố định: bản ghi và các grant của nó bị xoá, và
  byte cũng bị xoá trừ khi một tệp đính kèm hoặc bản ghi khác vẫn trỏ tới chúng. Nó chờ các lần ghi đang dở của ref
  xong trước. Tệp người dùng đã chọn, hoặc tệp do widget khác tạo, bị từ chối với `ARTIFACT_NOT_CREATOR`.

Lời từ chối reject kèm mã của host đứng trước (`ARTIFACT_GRANT_EXPIRED: …`). Danh sách mã nằm trong
`ARTIFACT_REFUSAL_CODES`. Host cho người dùng biết vì sao một lần chọn hay lưu không thành, bằng ngôn ngữ của họ, chọn
theo mã từ chối; widget nhận mã và một câu cố định, và không nhận gì từ hệ thống tệp của desktop ngoài mã lỗi của chính
nó (`EBUSY`), không bao giờ là đường dẫn. Chọn tệp và lưu tệp là hành động của người dùng: node từ chối chúng trên các
bề mặt máy ([open-interfaces.vi.md](open-interfaces.vi.md)), và widget không làm được việc nào trong hai việc đó nếu
không có lời nhắc của host.

Các yêu cầu tệp của một frame bị giới hạn tốc độ: một đợt 300 yêu cầu, sau đó 10 yêu cầu mỗi giây, được đếm trước khi
yêu cầu được kiểm tra, và tối đa 4 yêu cầu chờ trả lời cùng lúc. Một tin nhắn đến từ cửa sổ khác bị từ chối trước khi
được đếm, nên một widget không thể tiêu hết tốc độ của widget khác. SDK xếp hàng phần còn lại, nên một widget đọc tệp lớn
trong vòng lặp được điều nhịp chứ không bị từ chối. Yêu cầu vượt tốc độ được trả lời bằng `ARTIFACT_RATE_LIMITED`, và
frame vẫn hoạt động.

Node giữ những gì:

- **Một kho và một hạn mức.** Các byte của artifact nằm trong kho blob của node, cũng là kho mà tệp đính kèm dùng.
  Chúng được tính vào hạn mức đính kèm của principal (1 GiB). Một artifact đã đính kèm được tính một lần là artifact
  và một lần là tệp đính kèm. Trong hạn mức đó, một instance widget giữ tối đa 128 MiB
  (`ARTIFACT_INSTANCE_QUOTA_EXCEEDED`). Phần này tính các tệp widget đã tạo và các tệp đính kèm nó làm từ chúng,
  chừng nào các tệp đính kèm đó còn được giữ. Nó không tính các tệp người dùng đã chọn cho widget, vì chỉ người dùng
  mới thêm được và widget không thể bỏ chúng; các tệp đó chỉ tính vào hạn mức của người dùng. `discard` trả lại chỗ
  của một tệp; tệp đính kèm làm từ tệp đó giữ chỗ riêng cho tới khi nó bị xoá. Một widget bị từ chối vì hạn mức của
  người dùng đã đầy chỉ được biết điều đó, không bao giờ biết người dùng đang lưu bao nhiêu.
- **Grant thuộc về một instance.** Grant kéo dài 24 giờ kể từ lúc chọn tệp hoặc lần ghi cuối của instance, và mỗi lần
  ghi làm mới nó. Widget vẫn đọc được một tệp nó đã ghi và cố định chừng nào tệp đó còn; tệp người dùng đã chọn thì
  phải được chọn lại sau 24 giờ. Grant được kiểm tra ở mỗi lần dùng; không có gì quét dọn chúng. Một grant đã bị thu
  hồi sẽ chặn lời gọi kế tiếp, nhưng hiện chưa có bề mặt nào cho người dùng thu hồi grant. Xoá hội thoại sẽ giải phóng
  artifact cùng grant của nó; việc này không thêm nút ngừng chia sẻ riêng.
- **Lưu giữ.** Các artifact `working` hết hạn bị xoá mỗi 10 phút, và trước khi lưu một artifact mới. Khi node khởi
  động, nó xoá các byte tạm mà một tiến trình trước để lại và không còn artifact `working` nào đang ghi. Artifact đã cố
  định tồn tại lâu bằng hội thoại của nó, kể cả tệp đã cố định nhưng chưa đính kèm. Khi người dùng
  [xoá hội thoại](open-interfaces.vi.md#xoá-hội-thoại), artifact, grant và tệp đính kèm được giải phóng trong cùng một
  transaction. Sau commit, chỉ byte không còn tệp đính kèm, artifact, ảnh, bằng chứng task hay tin nhắn nào dùng chung
  mới bị xoá. Tệp không xoá được nằm trong hàng đợi bền vững, được dọn lại lúc khởi động và mỗi 10 phút; kết quả báo số
  tệp đang chờ. Không giữ bản sao để Hoàn tác nên hạn mức được trả ngay. Bộ nhớ đã lưu, tài nguyên độc lập, nhật ký phiên
  và lịch sử kiểm toán vẫn còn; đây không phải thao tác xoá mọi dữ liệu. Công việc chưa kết thúc hoặc chưa rõ kết quả
  phải được xử lý trước.

Kiểm thử: [artifacts.spec.ts](../packages/contracts/test/artifacts.spec.ts) cho các quy tắc,
[artifact-refs.spec.ts](../packages/storage/test/artifact-refs.spec.ts) cho phần lưu trữ,
[artifact-broker.spec.ts](../apps/runtime/test/artifact-broker.spec.ts) cho node và các route,
[artifact-server.spec.ts](../apps/runtime/test/artifact-server.spec.ts) cho tên tệp tiếng Việt qua một socket thật,
[action-widget.spec.ts](../apps/runtime/test/action-widget.spec.ts) cho tham chiếu ngữ cảnh `artifact:<id>`,
[runtime.spec.ts](../packages/widget-sdk/test/runtime.spec.ts) và
[session.spec.ts](../packages/widget-host/test/session.spec.ts) cho bridge,
[widget-artifacts.spec.ts](../packages/conversation-client/test/widget-artifacts.spec.ts) cho trang,
[file-bridge.spec.ts](../apps/desktop/test/file-bridge.spec.ts) cho các hộp thoại của desktop, và hành trình trên
trình duyệt [widget-artifacts.spec.ts](../apps/web/e2e/widget-artifacts.spec.ts). Hành trình đó chọn một tệp lớn hơn
một đoạn, đọc nó trong hai đoạn, ghi và lưu một bản sao, đính kèm nó, rồi mở lại từ một thẻ tệp. Nó chạy ở cả hai
giao diện và ở 390 px.

### 10.2 Job chạy lâu (`jobs@1`)

Một capability của package có công việc kéo dài hơn một lần bấm khai báo điều đó trong tools facet:

    { "ref": "com.example.notes.export@1", "tool": "export_notes", "effectCategory": "read",
      "execution": { "kind": "job", "version": 1 } }

Một lần bấm vào binding của capability đó không chờ service làm xong. `actions.invoke` trả về một **JobRef**, là một
id `job_…` không mang nghĩa, và node chạy lời gọi ở nền. Widget giữ JobRef trong state của chính nó, nhờ vậy một frame
được mount lại vẫn theo dõi đúng job đó:

    const jobId = await api.actions.invoke("binding_notes_export", { steps: 12, stepMs: 1500 }, invocationId);
    await api.state.update((state) => ({ ...state, exportJob: jobId }), { exportJob: jobId });
    const stop = api.jobs.subscribe(jobId, (job) => render(job));

`jobs.available()` cho biết host có cung cấp `jobs@1` trong `init.extensions` hay không; khi không có, mọi lời gọi bị
từ chối ngay tại chỗ. `jobs.get(ref)` đọc một snapshot: trạng thái (`queued`, `running`, `waiting`, `completed`,
`failed`, `cancelled`), tiến độ, output, lỗi, tệp kết quả và các mốc thời gian. `jobs.subscribe(ref, handler)` bắt đầu
từ snapshot đó, hỏi lại mỗi giây, chỉ đưa cho handler những snapshot đã thay đổi, và tự dừng khi job kết thúc, khi gặp
`JOB_NOT_FOUND` hoặc `EXTENSION_NOT_OFFERED`, hoặc sau 30 lần đọc bị từ chối liên tiếp. `jobs.cancel(ref)` yêu cầu node
dừng job; job đã kết thúc bị từ chối với `JOB_NOT_RUNNING`. `jobs.list()` trả về các job mà chính các binding của
widget này đã khởi chạy, mới nhất trước và tối đa 20, kể cả job được khởi chạy bằng giọng nói hoặc bởi Clark cho widget
này, để widget hiển thị được cả việc không bắt đầu từ một cú nhấn. Contract nằm ở
[jobs.ts](../packages/contracts/src/jobs.ts).

**Việc liệt kê là một extension riêng, `jobs.list@1`.** Nó có sau `jobs@1`, và một host chỉ mở `jobs@1` sẽ từ chối
`{ op: "list" }` vì nằm ngoài schema của nó và không bao giờ trả lời. Vì vậy host nào trả lời được thì cũng mở
`jobs.list@1` trong `init.extensions`, và `jobs.canList()` cho biết host có mở hay không; khi không mở, `jobs.list()` bị
từ chối ngay tại chỗ mà không gửi gì đi. Widget có liệt kê thì kiểm tra trước và giảm cấp: không liệt kê được thì nó
hiển thị các job được khởi chạy trong lúc nó đang mở (các JobRef mà `actions.invoke` trả về, được theo dõi bằng
`jobs.subscribe`) và nói rằng các job trước đó không được hiển thị. Hằng số trong SDK là `JOBS_LIST_EXTENSION`. Một job
được liệt kê có cùng các trường như job đọc bằng `jobs.get`.

**`error` của một job thất bại có thể mang chính lời của service.** Khi công cụ của service báo lỗi, node giữ nguyên
văn bản đó, đặt trong ngoặc kép, bên trong một câu của chính node: `The package service reported an error: “…”. Its
effect may have happened; review before retrying.` Phần trong ngoặc kép là lời của service, và có thể là lời của nhà
cung cấp: các ký tự điều khiển và ký tự định dạng vô hình (kể cả ký tự đảo chiều bidi) bị loại bỏ và nó bị cắt ở 400 ký
tự, nhưng ngoài ra không được bảo đảm gì thêm. Hãy hiển thị nó như lời service đã nói, bên trong câu chữ của chính bạn,
chứ không phải như câu của widget hay của host. Node xoá key của nhà cung cấp khỏi những gì nhà cung cấp gửi về trước khi
service đọc, nên một nhà cung cấp lặp lại key sẽ để lại `[redacted]` ở chỗ đó.

**JobRef là con trỏ, không phải quyền.** Node kiểm tra lại mọi lần đọc và huỷ theo chủ sở hữu của job: principal,
widget instance, binding của nó cùng package generation mà binding đó được cấp quyền, và capability. Bất kỳ sai lệch
nào, kể cả một ref bị chép sang widget khác, đều nhận `JOB_NOT_FOUND`, giống hệt một ref chưa từng tồn tại.

Những gì job báo cáo là của chính service: tiến độ chỉ đến từ `notifications/progress` của MCP mà service gửi cho lời
gọi đó, và các tệp nó trả về trở thành `ArtifactRef` mà widget đọc được qua `artifacts@1`. Việc đọc job có ngân sách
riêng cho mỗi phiên frame (tối đa 60 lần dồn, sau đó 5 lần mỗi giây, tối đa 4 lần chờ cùng lúc), tách khỏi ngân sách
message, nên widget đang theo dõi job không làm nghẽn các lời gọi bridge khác.

Một job được chạy tối đa 30 phút thay vì hạn 60 giây của một lần bấm; quá thời hạn đó nó kết thúc ở trạng thái thất
bại. Trong lúc chạy, nó nằm trong danh sách công việc đang chạy của node (`GET /work`), và việc dừng nó ở đó
(`POST /work/{id}/cancel`), Dừng khẩn cấp và việc tắt node đều huỷ nó. Nút Dừng của hội thoại kết thúc câu trả lời và
một lần bấm còn đang chờ, không kết thúc một job đã chạy, giống như các công việc nền khác. Lệnh huỷ được báo cho service
qua cơ chế huỷ của MCP; vì service có thể đã làm xong tác động trước khi nhận được, phần kết thúc ghi rằng job "may
already have completed its effect" thay vì khẳng định không có gì xảy ra. Job còn mở khi node khởi động lại được đánh
dấu thất bại kèm lời giải thích đó; nó không bao giờ tự chạy lại.

Khi job kết thúc, hội thoại nhận một ghi chú nêu capability, tối đa ba tệp kết quả và bước tiếp theo, và hộp thư ghi
lại cùng kết thúc đó. Nếu execution policy cần hỏi trước khi capability chạy, lần bấm sẽ hiện thẻ phê duyệt của host
trước, và job chỉ bắt đầu sau khi một người phê duyệt ở đó; widget không bao giờ tự phê duyệt job của chính nó. Hội
thoại còn job đang mở thì không xoá được cho tới khi job kết thúc hoặc bị huỷ.

Kiểm thử: [jobs.spec.ts](../packages/contracts/test/jobs.spec.ts) cho các quy tắc,
[job-host.spec.ts](../apps/runtime/test/job-host.spec.ts) cho job host của node, Dừng và khởi động lại,
[action-widget.spec.ts](../apps/runtime/test/action-widget.spec.ts) cho lần bấm, phê duyệt và các route bridge,
[runtime.spec.ts](../packages/widget-sdk/test/runtime.spec.ts) cho SDK, và hành trình trên trình duyệt
[package-job.spec.ts](../apps/web/e2e/package-job.spec.ts). Hành trình đó theo dõi tiến độ của một service thật qua
một lần tải lại, từ chối một JobRef giả, huỷ từ widget, hoàn tất kèm một tệp và kết thúc một job bằng Dừng khẩn cấp.

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

Token trình duyệt ngắn hạn, có phạm vi, là ngoại lệ duy nhất của quy tắc "widget không bao giờ giữ credential của nhà
cung cấp", và chỉ khi package khai báo nó (§14.3). Key dài hạn ở lại trong node: service gọi tới nhà cung cấp qua node,
và chính node gắn key vào (§14.2).

### 14.1 Resource profile

Package xin tài nguyên cho mã của nó bằng cách nêu tên một profile, không bao giờ bằng con số:

    "resources": { "version": 1, "profile": "interactive-heavy" }

Node sở hữu bảng giá trị ([resource-profiles.ts](../packages/contracts/src/resource-profiles.ts)) và quyết định cấp gì.
Package không nêu gì sẽ chạy với `interactive-light`, đúng từng giá trị của giới hạn mà mọi service đã chạy trước khi có
profile, nên package hiện có chạy y như trước.

| Profile | Bộ nhớ / CPU / tiến trình / `/tmp` | Mỗi lần gọi | Mỗi job | Số job cùng lúc | Khi ra khỏi màn hình |
|---|---|---|---|---|---|
| `interactive-light` | 256 MiB / 1 / 128 / 16 MiB | 60 giây | 30 phút | 4 | gỡ khỏi trang |
| `interactive-heavy` | 1 GiB / 2 / 256 / 64 MiB | 120 giây | 30 phút | 2 | gỡ khỏi trang |
| `media-workstation` | 4 GiB / 4 / 512 / 512 MiB | 300 giây | 2 giờ | 1 | có thể tiếp tục phát |
| `background-compute` | 2 GiB / 2 / 256 / 256 MiB | 60 giây | 4 giờ | 2 | gỡ khỏi trang |

Mọi profile đều không có mạng riêng (`--network none`; service chỉ gọi tới nhà cung cấp qua node, §14.2) và `/tmp` là
`noexec`. Service và job vẫn chạy dù frame có đang được
mount hay không. Tệp kết quả lớn nhất vẫn là mức tối đa của tệp đính kèm, vì tệp mà service trả về phải đính kèm được vào
cuộc trò chuyện. Ba profile lớn hơn là mặc định kỹ thuật mà người review có thể đổi trong file đó. Các giới hạn được áp vào
`--memory`, `--cpus`, `--pids-limit` và dung lượng `/tmp` của container, hạn chót của mỗi lần gọi và mỗi job, và số job
chạy đồng thời của job host.

Hàm quyết định, `decideResourceProfile`, đi qua các bước theo thứ tự:

1. Không bao giờ cấp GPU: node không chuyển GPU vào container.
2. Luôn cấp `interactive-light`.
3. Lời từ chối của execution policy được ưu tiên.
4. Không cấp profile cần nhiều CPU hơn số container engine báo, hoặc nhiều hơn một nửa bộ nhớ của engine.

Profile không cấp được thì không bao giờ bị thay bằng profile nhỏ hơn. Package ở trạng thái degraded: service của nó không
được khởi động, và mỗi capability hiện lý do. Settings → Extensions hiện profile cạnh mỗi package đã cài: các giới hạn khi
được cấp, hoặc "Đã xin … nhưng không được cấp: …" khi không. Năng lực máy là con số engine báo, được giữ lại khi engine
đã trả lời. Engine chưa trả lời sẽ được hỏi lại ở lần khởi động sau. Với Docker Desktop đó là con số của Linux VM của nó.

Khoảng chênh với Podman: Podman rootless không được ủy quyền controller cgroup v2 vẫn nhận `--memory` và `--cpus` nhưng
không áp dụng. Khi đó node vẫn cấp profile kèm ghi chú "the container engine does not enforce memory and CPU limits here",
và chi tiết package hiện ghi chú đó. Bài test với engine thật
[`service-container-engine.spec.ts`](../apps/runtime/test/service-container-engine.spec.ts) kiểm tra giới hạn mà một
container đang chạy nhận được.

**Khi ra khỏi màn hình.** Frame bị gỡ khi cuộn ra khỏi màn hình. Frame của package được cấp `media-workstation` có thêm
một nút gạt trong chrome của host, "Tiếp tục phát khi cuộn đi". Khi bật, frame vẫn được mount dù ra khỏi màn hình, và host
báo "<tiêu đề> vẫn đang chạy ngoài màn hình". Nút này tắt sẵn cho mỗi lần mount mới, và widget không tự bật được.
Frame của profile khác không có nút gạt này và bị gỡ khi ra khỏi màn hình. Nút Dừng vẫn kết thúc frame đang phát ngoài
màn hình. Test: [offscreen-playback.spec.ts](../packages/conversation-client/test/offscreen-playback.spec.ts) cho phần
quyết định, và journey trình duyệt [offscreen-playback.spec.ts](../apps/web/e2e/offscreen-playback.spec.ts).

### 14.2 Service gọi tới nhà cung cấp

Facet `tools` khai báo các secret nó cần và các origin nó được gọi tới:

    "egress": {
      "version": 1,
      "secrets": [{ "name": "LOOKUP_API_KEY", "purpose": "Signs the lookups in with the provider." }],
      "origins": [{
        "origin": "https://api.example.com",
        "purpose": "Looks up the words you ask about.",
        "credential": { "secret": "LOOKUP_API_KEY", "header": "authorization", "scheme": "bearer" }
      }]
    }

Container vẫn không có mạng, và service không bao giờ giữ key. Node đề nghị egress trong `initialize` của MCP
(`capabilities.experimental["clarkcant/egress"]`, `version: 1`). Sau đó service gửi cho node request
`clarkcant/egress.fetch` với `{ version: 1, url, method?, headers?, body? }` qua cùng kết nối stdio, và chính node thực
hiện HTTP request
([service-egress.ts](../packages/contracts/src/service-egress.ts), [broker](../apps/runtime/src/service-egress.ts)):

- chỉ tới origin đã khai báo, so khớp chính xác, và không bao giờ tới URL có chứa thông tin đăng nhập;
- không tới origin loopback, mạng riêng hay link-local (`localhost`, `127.0.0.0/8`, `0.0.0.0/8`, `10.0.0.0/8`,
  `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `::`, `fc00::/7`, `fe80::/10` và các dạng IPv4-mapped của
  chúng), kể cả khi đã khai báo, trừ khi người dùng khởi động node với `CC_EGRESS_ALLOW_PRIVATE_NETWORK=1`. Mặc định là
  tắt. Đây là thiết lập của node, và không trường nào trong manifest bật được nó. Bước kiểm tra đọc host của URL. Nó không
  kiểm tra một tên công khai được phân giải ra địa chỉ nào;
- chỉ khi đang có một lần gọi của host tới service đó. Request của service dừng khi lần gọi cuối kết thúc, bị hủy, hoặc
  service bị dừng;
- chỉ với method mà các lần gọi đang chạy cho phép. Khi mỗi lần gọi đều được quyết định là `read` hoặc `local-write`,
  request chỉ được `GET` hoặc `HEAD`. Method khác làm thay đổi dữ liệu ở nhà cung cấp, nên cần một lần gọi được quyết
  định là `external-write`, `destructive`, `financial` hoặc `communication`, là những loại mà risk gate của execution
  policy hỏi tới. Request không cho biết nó phục vụ lần gọi nào, nên effect của mọi lần gọi đang chạy cùng giới hạn nó;
- hoàn toàn không, khi có một lần gọi đang chạy giữ tệp của người dùng (§14.4), trừ khi mỗi lần gọi như vậy được quyết
  định là `external-write`, `communication`, `destructive` hoặc `financial`. Request có thể mang dữ liệu của tệp đi, `GET`
  cũng như `POST`, nên lần gọi được quyết định là `read` hoặc `local-write` mà giữ tệp sẽ nhận `-32019` cho tới khi nó
  kết thúc;
- mỗi service đang chạy gửi tối đa 30 request liền, sau đó được thêm 10 request mỗi giây;
- với header đã khai báo do node gắn vào từ secret mà người dùng lưu cho consumer `package:<id>`. Header cùng tên do
  service tự đặt bị bỏ;
- với các header cookie, proxy, forwarding và framing bị loại, gửi đi tối đa 1 MiB và nhận về tối đa 2 MiB, mỗi request
  30 giây. Chính node yêu cầu kết quả không nén (`accept-encoding: identity`), và bỏ `accept-encoding` do service tự đặt;
- không đi theo redirect, nên key không bao giờ đi sang origin khác;
- với key được thay bằng `[redacted]` trong mọi header và trong body của kết quả trả về, ở dạng đã gửi, dạng JSON-escape,
  dạng URL-encode, và dạng mã hóa base64 hoặc base64url. Đây là lớp bảo vệ ở mức cố gắng tối đa trước nhà cung cấp lặp
  lại key. Nó không phải một bảo đảm: key mà nhà cung cấp trả về ở dạng khác, như bị chia nhỏ, băm, mã hóa hoặc nằm
  trong một kiểu mã hóa khác, vẫn tới được service.

Lời từ chối là một lỗi JSON-RPC: `-32010` origin chưa khai báo, `-32011` không có lần gọi nào đang chạy, `-32012` không có
credential, `-32013` quá lớn, `-32014` không gọi được nhà cung cấp, `-32015` đã dừng, `-32016` method mà các lần gọi đang
chạy không cho phép, `-32017` quá nhiều request, `-32018` origin mà node này không gọi tới. Mỗi request được ghi audit với
loại `egress`, gồm package, method, origin, tên secret, status và kết quả. Audit không bao giờ ghi path, body, giá trị hay
độ dài. Lời từ chối cùng loại với một lời đã được ghi trong 60 giây qua thì không được ghi ngay: phần còn lại được ghi
thành một dòng kèm số lượng khi khung thời gian khép lại hoặc service dừng, nên service không thể làm tràn audit.

Khi secret đã khai báo chưa dùng được, các capability của package được báo là chưa đăng nhập (`authenticated: false`)
kèm lý do, ví dụ "the secret LOOKUP_API_KEY has not been provided on this node". Nút bấm, agent và giọng nói đều bị từ
chối với `CAPABILITY_NOT_AUTHENTICATED`. Đây là trạng thái "cần đăng nhập" của service: nó không phải trạng thái vòng
đời widget `needs_auth`, trạng thái đó vẫn không được đặt. Lưu key (`POST /credentials` với `"consumer": "package:<id>"`) sẽ đăng nhập
service mà không cần khởi động lại, và xóa key thì đăng xuất. Secret cũng được lưu cho một consumer `command:` sẽ được
đưa vào lệnh đó dưới dạng biến môi trường. Egress không dùng loại secret này, nên hãy lưu một secret riêng cho package.

**Sự đồng ý khi cài hiện những gì.** Một mục trong thư mục nêu phạm vi tiếp cận của package trong `declaredReach`
(`{ origins, secrets, browserTokens, connections }`, [declared-reach.ts](../packages/contracts/src/declared-reach.ts)); mục không có
trường này nghĩa là package không tiếp cận gì. Thẻ thư mục trong cuộc trò chuyện, câu hỏi cài đặt trong hộp thư, và chi
tiết package trong Settings → Extensions liệt kê từng origin kèm mục đích, từng key theo tên kèm mục đích (không bao giờ
hiện giá trị), từng nhà cung cấp token trình duyệt kèm scope và mục đích, và từng kết nối tài khoản kèm nhà cung cấp,
scope và endpoint (§14.6), trước khi cấp bất cứ thứ gì. Artifact có
manifest khai báo phạm vi khác với mục trong thư mục bị từ chối với `409 DECLARED_REACH_MISMATCH` trước khi ghi lại bất cứ
thứ gì, nên sự đồng ý bao gồm đúng những gì đã hiện. Thông báo cập nhật chưa liệt kê phạm vi này.

Chưa xây: mạng qua proxy cho service cần socket thô. Cho container có mạng sẽ làm yếu một mặc định cô lập, nên việc này
chờ quyết định đó.

### 14.3 Token trình duyệt (`tokens@1`)

Một số SDK của nhà cung cấp chỉ chạy được khi có token trong trình duyệt. Facet `ui` có thể khai báo các nhà cung cấp mà
frame cần token (tối đa 8 nhà cung cấp, mỗi nhà cung cấp 16 scope):

    "browserTokens": {
      "version": 1,
      "providers": [{ "provider": "example.maps", "scopes": ["tiles:read"], "purpose": "Draws the map tiles." }]
    }

Host chỉ đề nghị `tokens@1` trong `init.extensions` cho frame có package đã khai báo token trình duyệt:

    if (api.tokens.available()) {
      const token = await api.tokens.request({ provider: "example.maps", scopes: ["tiles:read"], ttlSeconds: 300 });
      sdk.setAccessToken(token.value); // { provider, value, scopes, expiresAt }
    }

Mỗi lần mount frame là một phiên riêng, với một id ngẫu nhiên do chrome của host giữ. Node chỉ cấp token cho đúng
instance và phiên đó (`POST /conversations/{id}/widgets/{instanceId}/browser-tokens`, chỉ người dùng gọi được). Node thu
hồi những gì phiên đã nhận khi frame bị gỡ (`DELETE …/browser-tokens/{session}`), khi package bị gỡ cài đặt, rollback hoặc cập nhật sang mã mới,
tại thời điểm hết hạn khi nhà cung cấp cho thời hạn dài hơn yêu cầu, và khi node dừng.

Token chỉ được cấp khi tất cả các điều sau đúng:

- nhà cung cấp và mọi scope đều có trong khai báo;
- node có adapter cho nhà cung cấp (`BrowserTokenAdapter` trong
  [`@clarkcant/integration-sdk`](../packages/integration-sdk/src/browser-token.ts)), và adapter nói nó cấp được token có
  phạm vi với các scope đó;
- thời hạn nằm trong khoảng 30–3600 giây và không vượt mức tối đa của nhà cung cấp. Request không nêu thời hạn được
  900 giây, cũng bị giới hạn như vậy.

Token được cấp trong lúc frame đóng, hoặc trong lúc mã của package kết thúc, sẽ bị rút và từ chối với
`TOKEN_SESSION_ENDED` thay vì được giao. Request bị từ chối chứ không bao giờ bị thu hẹp. Các mã là `TOKEN_PROVIDER_NOT_DECLARED`, `TOKEN_SCOPE_NOT_DECLARED`,
`TOKEN_PROVIDER_UNAVAILABLE`, `TOKEN_PROVIDER_UNSCOPED`, `TOKEN_SCOPE_NOT_SUPPORTED`, `TOKEN_TTL_TOO_LONG`,
`TOKEN_SESSION_ENDED` và `TOKEN_ISSUE_FAILED`. Nhà cung cấp trả về token có thời hạn dài hơn yêu cầu mà không thu hồi
được thì bị từ chối. Mỗi phiên giữ tối đa 8 token; token thứ chín sẽ rút token cũ nhất.

Node và host giữ giá trị token ngoài những gì chúng lưu và chuyển tiếp:

- node chỉ giữ token id của nhà cung cấp;
- audit (`browser-token`) ghi nhà cung cấp, instance và kết quả, không bao giờ ghi giá trị;
- cả SDK và phiên frame của host đều từ chối, với `TOKEN_NOT_ALLOWED`, `state.update`, `semantic.publish`,
  `actions.invoke`, lần ghi artifact (tên hoặc nội dung) hoặc liên kết bên ngoài có chứa token đã cấp. Lần ghi state được
  trả lời bằng state đã lưu kèm `STATE_HOLDS_TOKEN`.

Lớp bảo vệ này ở mức cố gắng tối đa. Nó bắt được token được chuyển tiếp đúng như lúc cấp, là lỗi thường gặp. Nó không
chặn được widget mã hóa hoặc chia nhỏ token, hay gửi token đi qua request mạng của chính nó. Mã của widget có giá trị
token, nên điều giới hạn rò rỉ là token có phạm vi, ngắn hạn và bị thu hồi khi frame bị gỡ.

Request token có ngân sách riêng cho mỗi phiên frame: tối đa 10 liền, sau đó mỗi 5 giây một, và tối đa 2 request chờ cùng
lúc.

Giới hạn: ClarkCant chưa kèm adapter cho nhà cung cấp nào, nên trên node không có adapter, mọi request đều là
`503 TOKEN_PROVIDER_UNAVAILABLE`. Bộ test trình duyệt đăng ký các nhà cung cấp fixture chạy trong tiến trình bằng
`CC_BROWSER_TOKEN_FIXTURE=1`. Token của nhà cung cấp `expiry-only` không rút sớm được; nó chỉ hết hạn đúng lúc.

Test: [browser-token.spec.ts](../packages/contracts/test/browser-token.spec.ts) và
[bước kiểm tra request](../packages/integration-sdk/test/browser-token.spec.ts) cho các quy tắc,
[browser-token-broker.spec.ts](../apps/runtime/test/browser-token-broker.spec.ts) cho node,
[session.spec.ts](../packages/widget-host/test/session.spec.ts) và
[runtime.spec.ts](../packages/widget-sdk/test/runtime.spec.ts) cho bridge, và journey trình duyệt
[resource-egress.spec.ts](../apps/web/e2e/resource-egress.spec.ts). Journey hiện profile đã cấp trong chi tiết package
và trên container đang chạy. Nó gọi tới một nhà cung cấp giả bằng key mà trang, frame, bridge, storage và container đều
không giữ. Sau đó nó giữ một token vừa cấp trong frame và thu hồi token khi frame đóng.

### 14.4 Tệp mà service đọc

Service không bao giờ nhận đường dẫn hay handle tới tệp của người dùng. Nó đọc dữ liệu từ node theo từng khoảng, và chỉ
trong lời gọi được giao tệp đó. Container của nó không có mạng riêng. Trong lúc lời gọi như vậy đang chạy, node cũng từ
chối egress của service (§14.2), trừ khi lời gọi đó được quyết định là `external-write`, `communication`, `destructive`
hoặc `financial`, là những loại mà risk gate của execution policy hỏi tới. `GET` mang được dữ liệu trong URL cũng như
`POST` mang trong body, nên lời gọi được quyết định là `read` hoặc `local-write` mà giữ tệp thì không có egress nào cho
tới khi nó kết thúc. Lời từ chối là `-32019` (`EGRESS_ERROR_CODES.inputHeld`) và nói rõ lý do. Capability vừa đọc tệp
của người dùng vừa gửi nó tới nhà cung cấp phải khai báo `external-write` (hoặc cao hơn), để chính sách của người dùng
quyết định lần gửi đó.

Capability làm việc trên một tệp mà widget đang giữ sẽ nêu tên các trường tham số chứa mã artifact:

    { "tool": "render_audio", "ref": "com.example.media.render@1", "effectCategory": "read",
      "execution": { "kind": "job", "version": 1 },
      "inputArtifacts": { "version": 1, "fields": ["source"] } }

Lời gọi có nêu một tệp trong các trường đó chỉ được bắt đầu từ nút của chính widget instance đang giữ tệp. Cùng lời
gọi đó từ Clark, giọng nói, MCP hay CLI bị từ chối với `ARTIFACT_INPUT_REFUSED`, vì không bên nào giữ quyền của widget
trên tệp. Trước khi gửi lời gọi, node kiểm tra từng mã được nêu
([capability-invoke.ts](../apps/runtime/src/application/capability-invoke.ts)):

- widget instance đang nhấn có quyền trên tệp, và tệp đã được chốt, không còn đang được ghi
  (`403 ARTIFACT_INPUT_REFUSED`);
- tệp thuộc cuộc trò chuyện nơi lần nhấn xảy ra, và cuộc trò chuyện đó vẫn giữ widget, giống bước kiểm tra khi nút agent
  đọc ngữ cảnh `artifact:` (`403 ARTIFACT_INPUT_REFUSED`);
- node nêu được profile mà package được cấp; node không nêu được thì bị từ chối, thay vì được tin mà không có giới hạn
  nào (`403 ARTIFACT_INPUT_REFUSED`);
- tệp nằm trong giới hạn đầu vào của profile đó (`413 ARTIFACT_INPUT_TOO_LARGE`).

Lời gọi bị từ chối không gửi gì tới service.

Khi execution policy hỏi trước một lời gọi như vậy, thẻ phê duyệt nêu lần nhấn mà nó xuất phát (widget instance và
action binding của nó), và mã băm mà người dùng phê duyệt bao gồm cả lần nhấn đó. Phê duyệt sẽ chạy lời gọi như chính lần
nhấn đó: node kiểm tra lại rằng cuộc trò chuyện vẫn giữ widget và binding vẫn gọi capability này, rồi làm mọi bước kiểm
tra ở trên. Thẻ mà widget của nó không còn bị từ chối với `APPROVAL_STALE`. Điều này đúng với capability trả lời ngay cũng
như với job.

Node đưa quyền đọc tệp trong MCP `initialize` (`capabilities.experimental["clarkcant/artifacts"]`,
[service-artifacts.ts](../packages/contracts/src/service-artifacts.ts)):

    { "version": 1, "methods": ["clarkcant/artifacts.read"], "chunkBytes": 262144,
      "maxInputBytes": …, "maxMediaSeconds": …, "maxResultBytes": … }

Trong lúc lời gọi đang chạy, và chỉ khi đó, service gửi `clarkcant/artifacts.read` với
`{ version: 1, artifactId, offset, length }`, mỗi lần tối đa một đoạn (256 KiB). Câu trả lời là
`{ artifactId, offset, bytes (base64), eof, sizeBytes, mimeType }`. Node kiểm tra lại quyền ở mỗi lần đọc, và đọc đĩa
ngoài luồng chính của nó. Khoảng dài hơn bị từ chối với `-32602`. Mã mà lời gọi không nêu trong một trường đã khai báo
bị từ chối với `-32020`, và lần đọc có câu trả lời tới sau khi lời gọi đã kết thúc cũng vậy: dữ liệu của nó không được
giao. Lần đọc mà node từ chối vì lý do khác bị từ chối với `-32021`: quyền đã bị thu hồi, tệp không còn, hoặc lời gọi đã
dùng hết hạn mức đọc.

Hạn mức đọc giới hạn tổng lượng một lời gọi đọc: bốn lượt qua các tệp của nó (`passes × size` byte), trong tối đa bốn
lần đọc cho mỗi đoạn 256 KiB cộng thêm 16 lần cho phần đầu tệp và các lần nhảy vị trí
([`serviceArtifactReadBudget`](../packages/contracts/src/service-artifacts.ts)). Service đọc đầu vào một hay hai lượt
nằm gọn trong đó; service đọc lặp lại cùng dữ liệu bị từ chối khi đã dùng hết.

Các giới hạn lấy từ profile đã cấp, không bao giờ từ manifest. Manifest chỉ nêu tên trường, không nêu kích thước, nên
không nâng được giới hạn nào:

| Profile | Tệp đầu vào | Độ dài media |
|---|---|---|
| `interactive-light` | 8 MiB | 2 phút |
| `interactive-heavy` | 16 MiB | 10 phút |
| `media-workstation` | 25 MiB | 2 giờ |
| `background-compute` | 25 MiB | 1 giờ |

Chỉ service đọc được độ dài của một đoạn âm thanh, nên service phải tự áp `maxMediaSeconds`. Nó từ chối đoạn dài hơn
trước khi dựng bất cứ phần nào. `maxResultBytes` là tệp lớn nhất một kết quả mang được (khoảng 2,95 MiB, giới hạn tin
nhắn stdio sau khi mã hoá base64). Tệp mà service trả về chỉ trở thành artifact khi job hoàn tất, nên job bị huỷ hay
thất bại không để lại tệp nào được trình bày như tệp đã xong.

Test: [service-artifact-input.spec.ts](../apps/runtime/test/service-artifact-input.spec.ts) cho node với một tiến trình
service thật: egress bị từ chối, Clark và giọng nói bị từ chối, lần đọc sau khi lời gọi kết thúc, quyền bị thu hồi giữa
chừng, lần đọc quá dài, tệp đang được ghi, hạn mức đọc, node không có profile, tệp của cuộc trò chuyện khác, và lần chạy
lại sau phê duyệt. Ứng dụng tham chiếu ở §24.4.

### 14.5 Chính sách nội dung media

Trình phát âm thanh có thể phát một tệp trên web, nhưng trang không bao giờ tự fetch tệp đó: node làm việc này, theo
chính sách trong [media-content.ts](../packages/contracts/src/media-content.ts) và
[media-fetch.ts](../apps/runtime/src/media-fetch.ts). Mỗi lần từ chối nêu quy tắc bị vi phạm, dưới dạng
`(media policy rule: <rule>)` ở cuối thông điệp mà model đọc.

| Quy tắc | Điều bị từ chối |
| --- | --- |
| `origin-not-allowed` | origin mà người vận hành không liệt kê trong `CC_MEDIA_ORIGINS`. Mặc định danh sách rỗng, nên node không fetch gì cho tới khi người vận hành nêu một origin |
| `https-only` | mọi scheme khác `https`, trong URL hoặc trong một lần chuyển hướng |
| `credentials-in-url` | tên người dùng hoặc mật khẩu trong URL hoặc trong một lần chuyển hướng |
| `private-address` | một tên phân giải ra địa chỉ loopback, private hoặc link-local. Việc kiểm tra chạy trên chính địa chỉ được kết nối, nên một tên đổi câu trả lời cũng không lọt qua. Origin mà người vận hành viết bằng địa chỉ (`https://127.0.0.1:8443`) tự nêu địa chỉ đó và được phép |
| `redirect-off-origin`, `too-many-redirects` | chuyển hướng sang origin khác, hoặc quá 3 lần |
| `type-not-allowed` | kiểu được khai báo không phải `audio/mpeg`, `audio/ogg`, `audio/wav` hay `audio/webm` |
| `type-mismatch` | bytes không đúng kiểu được khai báo, kiểm tra bằng cách nhận diện container, hoặc dữ liệu truyền bị nén |
| `too-large` | quá 25 MiB, bị từ chối từ độ dài khai báo hoặc ngay khi phần thân vượt mức |
| `too-long`, `duration-unknown` | dài quá một giờ, hoặc container không ghi độ dài (một giới hạn không kiểm tra được thì không phải giới hạn) |
| `timeout`, `not-found`, `fetch-failed` | lần fetch quá 30 giây, tệp không tồn tại, hoặc không kết nối được |
| `source` | không đúng một nguồn, hoặc id không do node cấp |

Request không mang cookie, authorization hay referrer, và dùng một kết nối mới. Tệp vượt qua kiểm tra được tính vào
dung lượng lưu trữ của người dùng. Cùng các kiểm tra kiểu, kích thước và độ dài cũng áp dụng cho tệp âm thanh người dùng
đã có. `CC_MEDIA_ORIGINS` là danh sách các origin `https` trần, cách nhau bằng dấu phẩy, tối đa 32. Danh sách có một mục
không hợp lệ bị bỏ qua toàn bộ, node không cho phép gì, và nói lý do một lần lúc khởi động. Page policy không đổi:
`media-src 'self' blob:`.

Bộ test trình duyệt chạy một origin https thật trên loopback với chứng chỉ được tạo lúc chạy và không bao giờ được commit
([media-fixtures.ts](../apps/runtime/src/test-support/media-fixtures.ts)), được node mà bộ test khởi động tin qua
`NODE_EXTRA_CA_CERTS`.

### 14.6 Kết nối tài khoản

Một service làm việc trên tài khoản của một người tại một nhà cung cấp, chẳng hạn danh sách công việc hay lịch của họ,
khai báo một `connection` trên facet tools của nó (§4). Host làm mọi việc chạm tới credential của tài khoản
([package-connections.ts](../apps/runtime/src/package-connections.ts)); service thấy câu trả lời của nhà cung cấp và
widget thấy một trạng thái. Cả hai không bao giờ giữ access token, refresh token hay authorization code.

1. **Kết nối.** Người dùng bấm *Connect* trên package trong Settings → Extensions. Đây là UI của host, không phải của
   widget. `POST /packages/:id/connection` tạo một cặp PKCE (S256) và một `state` dùng một lần, giữ trong bộ nhớ mười
   phút, rồi trả về URL uỷ quyền của nhà cung cấp. Client mở URL đó trong trình duyệt hệ thống. Route này chỉ dành cho
   người dùng: request đi qua MCP hay relay bị từ chối với `403 PERSON_ONLY`, nên một AI client không thể tự bắt đầu
   kết nối cho chính nó. Route trả `409 CONNECT_ON_THIS_MACHINE` nếu request không tới node qua loopback, vì nhà cung
   cấp chuyển trình duyệt về `http://127.0.0.1:<port>/connections/callback/<package id>`. Mỗi package có đường dẫn
   callback riêng, nên code gửi về đường dẫn của package này không bao giờ được đổi cho package khác (tấn công OAuth
   mix-up).
2. **Quay về.** `GET /connections/callback/:id` là công khai, vì trình duyệt đi theo một lần chuyển hướng không mang
   token của gateway: `state` dùng một lần mới là thứ xác thực nó. Node kiểm tra state, và rằng state đó được cấp cho
   đúng package mà đường dẫn nêu, trước khi gửi code đi bất cứ đâu. Node đổi code tại token endpoint đã khai báo, so scope được cấp với scope đã khai báo, và gọi probe đã khai báo. Chỉ khi đó
   node mới giữ kết nối. Token nằm trong bảng riêng trên node (`package_connection_tokens`). Trang mà trình duyệt mở ra
   không bao giờ lặp lại code hay state, không gửi referrer, và một callback bị phát lại hoặc giả mạo bị từ chối.
3. **Ký.** Service vẫn chạy không có mạng, như trước (§14.2). Khi nó xin một URL trên một endpoint của connection bằng
   `clarkcant/egress.fetch`, node tự thêm `authorization: Bearer …`, chỉ trong lúc một lời gọi của service đang chạy, và
   che token khỏi mọi câu trả lời trả lại cho service. Token sắp hết hạn được làm mới trước; lần làm mới giữ nguyên các
   scope đã cấp lúc đồng ý trừ khi nhà cung cấp nói khác. Khi nhà cung cấp trả `401` cho token đang dùng, node làm mới
   một lần; nếu token endpoint từ chối bằng `400` hoặc `401`, kết nối bị thu hồi, còn `408`, `429` hay `5xx` thì để
   nguyên kết nối. Request không bao giờ được thử lại.
4. **Sẵn sàng.** `GET /packages/:id/connection` trả về `ConnectionStatus`: `not-connected`, `connected`, `partial`,
   `expired` hoặc `revoked`, các scope đã xin, đã cấp và còn thiếu, kèm lý do. Capability không sẵn sàng khi kết nối
   chưa có, đã hết hạn hoặc bị thu hồi, hoặc không cấp một scope trong `requiredScopes` của nó, và lý do nói rõ là cái
   nào, ví dụ "the Fake Tasks (test fixture) account did not grant tasks.write; reconnect it in Settings and allow it".
   Widget đọc lý do từ `actions.availability()` (§10); một lần bấm, agent và giọng nói bị từ chối với
   `CAPABILITY_NOT_AUTHENTICATED` và cùng lý do đó. Capability có đủ scope đã cấp vẫn chạy trên kết nối `partial`.
5. **Thu hồi.** *Revoke* trong Settings gọi `POST /packages/:id/connection/revoke`. Node gọi revocation endpoint của nhà
   cung cấp nếu có khai báo, xoá token, và trạng thái thành `revoked` trước khi request trả lời, kể cả khi một lần làm
   mới đang chạy. *Reconnect* chạy lại bước 1. Gỡ package, từ Settings hoặc bằng cách nhờ Clark (`manage_package`),
   cũng quên kết nối theo cách đó, và một lần uỷ quyền còn đang chờ callback không thể hoàn tất nữa.
6. **Phiên bản mới.** Node giữ một dấu vân tay về nơi mà khai báo cho phép token của tài khoản đi tới: nhà cung cấp,
   client id, các endpoint uỷ quyền, token và thu hồi, các endpoint và probe. Nếu một lần cập nhật hay quay về phiên bản
   cũ thay đổi bất kỳ mục nào, kết nối thành `revoked`, token bị xoá mà không được gửi tới địa chỉ mới, và người dùng
   kết nối lại theo khai báo mới.

Kết nối không thay đổi cách một capability chạy: binding của widget, `invoke_capability` của Clark và lệnh nói vẫn đi
tới `invokeCapability`, execution policy của người dùng, approval card do host sở hữu và cùng một audit trail (§4). Một
lần ghi không nhận được câu trả lời trước hạn chót được ghi nhận là không rõ kết quả và không được thử lại.

Desktop shell chỉ mở địa chỉ HTTPS trong trình duyệt hệ thống, nên nhà cung cấp trên địa chỉ `http` loopback (fake
connector bên dưới) được kết nối từ client trình duyệt. Nhà cung cấp thật dùng HTTPS. Mới chỉ có luồng authorization
code với PKCE. Nhiều tài khoản cho một package, và một kết nối dùng chung giữa các package, chưa được xây.

**Ứng dụng mẫu và template.** [examples/reference-apps/connected-app](../examples/reference-apps/connected-app/) liệt kê
và đổi tên công việc qua một kết nối như vậy, và `clark widget init --template connected-app` sao chép nó (§16). Nhà cung
cấp của nó là một **fake connector**, `dev/fake-connector.mjs`: fixture cho kiểm thử và phát triển, gồm một máy chủ
OAuth và một API công việc tí hon trên loopback, không có tài khoản thật, và các giá trị kiểm thử ngẫu nhiên chỉ nằm trong
bộ nhớ. Node chỉ gọi tới endpoint loopback của nó khi có `CC_EGRESS_ALLOW_PRIVATE_NETWORK=1`. Nhà cung cấp thật sẽ đến
sau [#333](https://github.com/digitopvn/clarkcant/issues/333). Các kiểm thử là
[package-connections.spec.ts](../apps/runtime/test/package-connections.spec.ts) cho broker,
[package-connection-routes.spec.ts](../apps/runtime/test/package-connection-routes.spec.ts) cho các route, và journey
trình duyệt [connected-app.spec.ts](../apps/web/e2e/connected-app.spec.ts). Journey kết nối, đọc và đổi tên từ widget,
gọi cùng capability từ Clark và bằng giọng nói với một audit trail, thu hồi rồi kết nối lại, chỉ cấp một phần scope, để
một lần đổi tên quá hạn, và kiểm tra rằng không token, code hay secret nào tới được frame, trang, bản ghi của node, file
của node hay container của service.

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
Settings, chat và voice. Cài lại package sau khi gỡ, cùng phiên bản hay phiên bản khác, cũng đưa các instance đang offline trở lại
cùng state như **Khôi phục**, và khi đó không còn gì để khôi phục.

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
- pure-ui: bản sao của trình soạn thảo văn bản mẫu ([§24.1](#241-trình-soạn-thảo-văn-bản)), mang id,
  facet id và tên riêng của package mới, không kèm các kiểm thử của trình soạn thảo;
- media-tool: bản sao của trình dựng âm thanh mẫu ([§24.4](#244-trình-dựng-âm-thanh)), gồm một widget và một
  service, mang id riêng của package mới, không kèm các kiểm thử của công cụ;
- connected-app: bản sao của ứng dụng kết nối mẫu ([§14.6](#146-kết-nối-tài-khoản)) mang id và tên riêng của package
  mới: một widget, một service có các capability nêu scope chúng cần trên một connection đã khai báo, skills, fake
  connector mà nó được kiểm thử, và `dev/service.test.mjs` di động của service. Hãy thay nhà cung cấp, client id, scope
  và endpoint bằng của nhà cung cấp thật trước khi phát hành;
- editor;
- media;
- MCP App adapter;
- `ai-generator` và `ui-with-service`, sao chép từ ứng dụng tham chiếu tạo ảnh ([§24.3](#243-trình-tạo-ảnh)); `ai-generator` bắt đầu với một origin nhà cung cấp giữ chỗ cần được thay.

Hiện tại `clark widget init --template` nhận `blank`, `form`, `dashboard`, `pure-ui`, `ai-generator`,
`ui-with-service`, `media-tool` và `connected-app`. `editor`, `media` và MCP App
adapter chưa được triển khai.

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

Với một package, dev host thực hiện bắt tay `init` thật của bridge. Nó gửi props của fixture đang chọn và đưa ra
`artifacts@1` (§10.1). Control **File picker** của nó giả lập lựa chọn của người dùng. Control này liệt kê các tệp
trong `fixtures/files/` của package, thêm một mục Huỷ, và lần `pick` kế tiếp trả về mục đang được chọn. Nó chỉ liệt kê
những tệp mà node sẽ nhận: kiểu nằm trong danh sách cho phép, tên tệp đơn thuần, tối đa 25 MiB, và tối đa 32 tệp. Tệp
nào bị bỏ qua thì được liệt kê kèm lý do. Nó trả lời `read`, `create`, `write`, `finalize`, `export` và `attach` với
cùng các mã từ chối và cùng giới hạn 256 KiB như node. Widget nhận được tên trần, kiểu, kích thước và digest của tệp,
không bao giờ biết tệp nằm ở đâu. Bản giả lập giữ mọi thứ trong bộ nhớ và quên hết khi dev host dừng. Nó không dò
kiểu từ byte, và không ghi gì xuống đĩa. Một lần `export` hay `attach` chỉ được ghi vào nhật ký của shell, nên một
bản phát hành vẫn phải được kiểm thử với Lưu thành… và ô soạn tin của một host thật.

Với mỗi capability `tools`, shell có thể đặt readiness dịch vụ thành `loading`, `ready`, `blocked` hoặc `unhealthy`,
kèm lý do cho trạng thái blocked và unhealthy. Offline được ưu tiên hơn readiness; capability đang ready vẫn dùng
được khi một capability khác unhealthy, và shell ghi nhãn trạng thái kết hợp này là degraded. **Simulate service
restart** hiển thị loading rồi đưa các capability đã khai báo trở lại ready. Các control này gửi message availability
`actions` và `action-result` của bridge tới frame. Chúng không khởi chạy service facet hoặc kết nối provider.

Fixture tuỳ chọn chỉ chứa dữ liệu `fixtures/dev-host-services.json` ánh xạ từng `actionBindingId` tới capability `ref`
trong tools facet đã khai báo và một kết quả bridge có giới hạn, ví dụ:

    { "bindings": [{ "actionBindingId": "notes.list", "capabilityRef": "com.example.notes.list@1",
      "outcome": { "status": "accepted", "message": "Loaded", "output": "One sample note" } }] }

File tối đa 32 KiB và 64 binding. Capability ref chưa khai báo và binding ID trùng sẽ bị từ chối. Host kiểm tra từng
kết quả theo schema bridge của widget; kết quả sai schema trở thành một lời từ chối hợp lệ. Fixture này chỉ kiểm tra
cách widget vẽ trạng thái và xử lý bridge, không chứng minh service hoạt động đúng. Package frame nhận cùng widget SDK
runtime dùng cho bridge, vẫn nằm trong opaque-origin sandbox, và chỉ tải module package qua dev host.

Binding tới capability được khai báo với `"execution": { "kind": "job", "version": 1 }` dùng fixture `job` thay cho
`outcome`, và mọi binding như vậy đều phải có nó:

    { "actionBindingId": "binding_notes_export", "capabilityRef": "com.example.notes.export@1",
      "job": { "steps": [{ "current": 1, "total": 3, "message": "exported step 1 of 3" }],
               "output": "Exported 1 note(s).", "error": "the export could not be written" } }

Khi đó một lần bấm trả về một JobRef mô phỏng, và danh sách **Simulated jobs** của shell hiển thị từng job với **Next
step**, **Complete** và **Fail**. Next step chuyển job từ queued sang running rồi đi qua từng bước tiến độ của fixture;
`jobs.cancel` của chính widget kết thúc nó ở trạng thái cancelled. Mọi kết thúc đều ghi "(simulated by clark widget
dev)". Host giữ tối đa 32 job trong bộ nhớ, dọn chỗ từ các job đã kết thúc, và quên hết khi dừng. Nó không bao giờ gọi
service, nên một job thật vẫn phải được kiểm thử trên node.

Semantic inspector nhận đề xuất `semantic.publish` từ frame qua normalizer dùng chung với runtime. Nó hiển thị tài
liệu đã chuẩn hoá, các trường bị cắt hoặc loại bỏ, delta so với lần publish trước, ghi chú ngữ cảnh cho lượt kế tiếp
và nội dung `inspect_ui`. Nội dung do frame đề xuất luôn được xem là dữ liệu không đáng tin; publish hơn bốn lần
trong một giây sẽ hiện cảnh báo churn. Composition simulator liệt kê graph event đã khai báo cùng `eventSchemas` của
package; nó kiểm payload bằng contract graph dùng chung hoặc schema package tương ứng, rồi hiển thị giá trị graph mô
phỏng hoặc payload đã kiểm tra và ghi vào action log. Event sai định dạng hoặc chưa khai báo sẽ bị từ chối. Bản mô
phỏng không gọi capability thật và không cấp quyền. Bằng chứng chạy browser thật nằm tại
[`semantic-composition-real-browser.e2e.spec.ts`](../packages/widget-cli/test/semantic-composition-real-browser.e2e.spec.ts).

Với một package, bảng **Resource profile · simulated** hiện profile mà package xin, do chính `decideResourceProfile` của
node quyết định. **Policy refuses** trả lời như một node có execution policy từ chối profile đó: mọi action của service
đều không dùng được, kèm câu của node. `interactive-light` và request có GPU trả lời như trên node, dù chọn nút nào. Năng
lực của engine không được mô phỏng. Package có facet UI khai báo `browserTokens` được đề nghị `tokens@1`, được kiểm tra
theo khai báo bằng đúng bước kiểm tra và mã của node. **Provider issues** trả về một giá trị ngẫu nhiên `dev-simulated-…`
không mở được gì, còn **Provider unavailable** trả về `TOKEN_PROVIDER_UNAVAILABLE`. Mọi câu trả lời đều ghi là mô phỏng,
và log chỉ ghi nhà cung cấp và kết quả, không bao giờ ghi giá trị
([dev-resources.spec.ts](../packages/widget-cli/test/dev-resources.spec.ts)).

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
- tài liệu semantic dựng từ fixture nằm trong `SEMANTIC_LIMITS`, và schema event đã khai báo có thể được đọc và kiểm
  tra;
- state version valid;
- unknown event/action reject.
- `fixtures/dev-host-services.json`, nếu có, chỉ nêu các capability đã khai báo và cung cấp fixture `job` cho đúng
  những binding có capability chạy dưới dạng job.

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
- blocked service;
- offline;
- reduced motion;
- text fallback.

---

## 18. Directory metadata

Directory entry cần:

- package id;
- current version: một phiên bản semantic dài tối đa 80 ký tự, vì card marketplace hiển thị nó và Install gửi lại nó
  nguyên vẹn; một index có phiên bản dài hơn sẽ bị từ chối khi đọc, kèm lý do;
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
  tìm thấy gì". Nút Cài trên mỗi dòng gọi đúng một install path (`POST /packages/install`), nơi digest được kiểm và
  execution policy quyết định; bản thân card không cài gì, nên một listing không bao giờ biến thành authorization. Một
  listing bằng đường dẫn trên máy này còn mang `contentDigest`, digest các tệp của nó lúc được liệt kê, mà nút gửi lại
  để lần cài bị từ chối nếu các tệp đã đổi từ đó; khi ấy dòng đó cho thấy chúng đã đổi và mời tìm lại thay vì cùng nút
  Cài. Việc kiểm tra chỉ diễn ra lúc cài: gói vẫn được liên kết với đường dẫn của nó. Mỗi dòng còn lặp lại
  `declaredReach` (những gì gói được phép chạm tới khi cài) và các khai báo `widgetAppearance` của listing, theo đúng
  schema của mục trong directory, nên dòng đó hiển thị chúng trước khi bấm Cài. Một card không khớp với contract của nó
  bị bỏ khỏi câu trả lời, và node ghi log `host card dropped` kèm loại card và đường dẫn các trường lỗi, không bao giờ
  kèm giá trị. Không có registry từ xa — search chỉ đọc thứ tồn tại trên máy hoặc ở URL người dùng chỉ định.
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

---

## 24. Ứng dụng tham chiếu

Ứng dụng tham chiếu là các package hoàn chỉnh cho thấy các phần của nền tảng ghép lại với nhau trong một widget thật.
Chúng nằm trong `examples/reference-apps/` và được kiểm thử như mọi package khác, cộng thêm một hành trình trình duyệt
qua một node thật.

### 24.1 Trình soạn thảo văn bản

[`examples/reference-apps/text-editor`](../examples/reference-apps/text-editor) là một ứng dụng hoàn chỉnh chỉ dựng
trên các hợp đồng ở [§10](#10-widget-sdk-surface). Nó có một facet UI cách ly, không có service, không xin quyền nào và không yêu cầu capability
nào. Người dùng mở một tệp văn bản, sửa, lưu và nhờ Clark viết lại một đoạn đang chọn, còn frame không bao giờ thấy tệp
nằm ở đâu. `clark widget init --template pure-ui` tạo một package mới từ bản sao của nó
([§16](#16-developer-cli-target)).

**Package.** `clarkcant.json` là manifest schema phiên bản 2 cho mọi nền tảng và cho web. `widget.json` nhận hai
prop: `title`, và `rewriteBinding` là id của binding `agent` mà trình soạn thảo được phép bấm. `stateSchema` chỉ nhận
`file`, `base` (hai `ArtifactRef`), `draft` và `draftTooLarge`, với `additionalProperties: false`. Các quy tắc là hàm
thuần trong [`editor-core.js`](../examples/reference-apps/text-editor/widgets/main/editor-core.js), được kiểm thử không
cần trình duyệt; `main.js` lo phần DOM và các lời gọi SDK.

**Mở tệp.** `artifacts.pick({ accept: ["text/plain", "text/markdown", "text/csv", "application/json"] })` hỏi host,
và host vẽ hộp hỏi bên ngoài frame. Trình soạn thảo từ chối tệp lớn hơn 1 MiB trước khi đọc byte nào. Phần còn lại được
đọc theo từng đoạn 256 KiB và giải mã UTF-8 nghiêm ngặt: byte không phải văn bản bị từ chối kèm lý do, thay vì được hiển
thị bằng ký tự thay thế mà một lần lưu sẽ ghi ngược lại vào tệp.

**Sửa và giữ bản nháp.** Bản nháp chưa lưu được ghi vào widget state 400 ms sau khi người dùng ngừng gõ, mỗi lần chỉ một
lượt ghi. Trình soạn thảo nhớ lượt ghi chưa được trả lời cùng revision mà nó ghi dựa trên, nên khi host commit lượt ghi
đó sau lúc người dùng đã gõ tiếp, nó được nhận ra là lượt ghi của chính trình soạn thảo chứ không bị coi là thay đổi từ
một cửa sổ khác. Một lượt ghi bị từ chối được trả lời bằng state mà host đã commit. Vì vậy tải lại trang, một bản đã ghim
hay một thiết bị khác đều thấy cùng bản nháp. Widget state chứa tối đa 16 KiB, nên bản nháp có JSON lớn hơn 12 KiB không
được giữ và cũng không bao giờ bị cắt. Trình soạn thảo nói rõ bản nháp sẽ không còn sau khi tải lại, và cờ báo được giữ
lại để lần tải sau cũng nói như vậy. Khi tải, trình soạn thảo đọc lại các byte đã lưu qua `base`. Nếu không đọc được
(quyền với một tệp đã chọn chỉ kéo dài 24 giờ), bản nháp chưa lưu vẫn được hiển thị, đánh dấu chưa lưu, kèm lý do. Nếu
không có bản nháp thì không có gì để hiển thị: trình soạn thảo không mở tài liệu nào, nói lý do và đưa ra *Mở tệp*, nên
một ô văn bản trống không bao giờ được trình bày, hay được lưu, như thể là tệp đó.

**Hai chỗ xem cùng một trình soạn thảo.** Khi state đã commit đến từ một chỗ xem khác, trình soạn thảo nhận lấy nếu
nó không còn gì chưa gửi. Nếu cả hai cùng đổi, nó hiện *Giữ bản của tôi* và *Dùng bản kia*, và không vứt bản nào. Câu
hỏi này không lấy bàn phím của người đang gõ; dòng trạng thái thông báo nó. Một chỗ xem chưa mở tài liệu nào, chẳng hạn
chỗ xem không đọc lại được bản đã lưu, không có bản nháp của riêng nó: nó luôn nhận state đã commit, không bao giờ hỏi,
và không ghi state cho đến khi người dùng mở một tệp, nên không thể xoá bản nháp của chỗ xem khác. Một
chỗ xem còn đang mở lại tệp sau khi tải lại thì không phải chỗ xem như vậy: state được commit trong lúc đó được giữ lại
và nhận sau khi mở lại xong, còn một lần đọc bản đã lưu bị lần đọc mới hơn vượt qua sẽ bị bỏ, nên văn bản cũ không bao
giờ thay văn bản mới.

**Lưu.** Trình soạn thảo ghi một artifact `working` cùng loại và cùng tên với tệp đã mở, theo từng đoạn, finalize nó
rồi gọi `export(ref, { suggestedName })`. Host quyết định điều đó nghĩa là gì. Trên máy tính, host đưa ra *Ghi đè tệp
gốc* cho tệp đã chọn trong frame này, vì cùng loại; trên web, host bắt đầu tải xuống và nói rằng ghi đè tệp gốc là tính
năng của ứng dụng máy tính. Trình soạn thảo chỉ biết `true` hoặc `false`, nên với `true` nó nói đã giao bản sao cho
ứng dụng và để thông báo riêng của host nói bản đó đi đâu: trên web, việc tải xuống mới chỉ bắt đầu. Với `true`, bản sao
trở thành `base` mới và bản sao trước đó do trình soạn thảo tạo bị bỏ; với `false`, bản sao không dùng đến bị bỏ. Trình
soạn thảo không bao giờ bỏ tệp mà người dùng đã chọn. Ctrl+S (Cmd+S trên macOS) để lưu. *Đính kèm* finalize một bản sao
rồi gọi `attachToConversation`.

*Ghi đè tệp gốc* chỉ được đưa ra trong frame nơi tệp được chọn, và chỉ cho đến khi frame đó được tải lại: host giữ
handle của máy tính cho tệp đã chọn trong bộ nhớ, bên cạnh đúng frame đó, và không bao giờ lưu nó lại. Sau khi tải lại,
trong một bản đã ghim hoặc trong một cửa sổ tách riêng, máy tính chỉ đưa ra Lưu thành.

**Những gì Clark được cho xem.** Trình soạn thảo công bố một câu tóm tắt ("Editing notes.txt: 3 lines, with unsaved
changes.") và các giá trị `open`, `file`, `lines`, `dirty`, `selectionStart`, `selectionEnd`, `selectedChars` và
`selectedText`. Đoạn trích bị cắt ở 200 đơn vị UTF-16, giới hạn của host cho một giá trị, và chỗ cắt được đánh dấu.
Khoảng đang chọn cũng là một id được chọn (`chars:6-11`). Host giới hạn, che thông tin nhạy cảm và đánh dấu tất cả là
lời của chính widget.

**Nhờ Clark sửa đoạn đang chọn.** Trình soạn thảo bấm một binding `agent` có `contextRefs` là
`["selection", "widget"]`, được nêu tên qua prop `rewriteBinding`. Hiện tại chỉ model kịch bản (fixture) của repository
đặt trình soạn thảo kèm binding đó; chưa có đường nào của sản phẩm đặt một widget từ package đã cài kèm binding. Vì vậy
trong một bản cài thật, nút này vẫn bị tắt và hiện lý do ("Clark chưa được gắn vào trình soạn thảo này…") cho đến khi
[#382](https://github.com/digitopvn/clarkcant/issues/382) hoàn tất. Khi có binding và người dùng bấm *Nhờ Clark viết lại
đoạn chọn*:

1. Trình soạn thảo chỉ hỏi về một đoạn chọn mà host chuyển cho Clark nguyên vẹn. Host làm phẳng xuống dòng, tab và các
   dãy khoảng trắng, bỏ ký tự vô hình, che nội dung giống khoá bí mật và cắt một giá trị ở 200 đơn vị UTF-16, nên đoạn
   chọn nào bị host thay đổi sẽ bị từ chối ngay trong trình soạn thảo kèm lý do: quá dài; nhiều hơn một dòng; có ký tự
   ẩn hoặc khoảng trắng đặc biệt như khoảng trắng không ngắt dòng; hoặc có nội dung host che vì có thể là thông tin
   riêng, như địa chỉ e-mail, dãy số dài, đường dẫn thư mục người dùng hay chuỗi giống khoá bí mật. Văn bản mà host
   chuyển nguyên vẹn thì không bao giờ bị từ chối. Khoảng trắng ở hai đầu được bỏ khỏi khoảng chọn, vì host cắt bỏ
   chúng. Bản sao quy tắc làm sạch của host trong trình soạn thảo được so với chính quy tắc của host trong các kiểm thử
   của package.
2. Trình soạn thảo công bố semantic document, chuyển ô văn bản sang chỉ đọc và giữ nguyên đoạn chọn đã công bố cho đến
   khi có câu trả lời. Vì binding này đọc đoạn đang chọn, host gửi lần publish còn đang chờ ổn định và chờ đến khi node
   đã giữ mô tả được publish trước lần bấm, hoặc một mô tả mới hơn, rồi mới chạy lần bấm. Thời gian chờ có giới hạn
   (8 giây); nếu không gửi được mô tả trong thời
   gian đó, lần bấm bị từ chối, không có gì được hỏi, ô văn bản sửa được trở lại và dòng trạng thái nhắc thử lại sau
   giây lát.
3. `actions.invoke(rewriteBinding, {}, invocationId)` bắt đầu một lượt. Host đọc đoạn đang chọn và document của widget
   vào phần dữ liệu của lượt đó, phần này được đánh dấu là dữ liệu chứ không phải chỉ dẫn.
4. Câu trả lời quay về dưới dạng output của lần bấm, tối đa 2.000 ký tự. Trình soạn thảo coi nó là văn bản không tin
   cậy và chỉ nhận làm đề xuất khi nó chứa đúng một khối có rào (```) đã đóng trong giới hạn đó; khối ấy là đoạn thay
   thế, đã bỏ các ký tự điều khiển và ký tự vô hình trừ xuống dòng và tab. Mọi câu trả lời khác được hiển thị như lời
   của Clark, không có gì để áp dụng.
5. Đề xuất hiển thị đoạn thay thế cùng đoạn văn bản nó sẽ thay, và nhận bàn phím tại tiêu đề của nó. *Thay đoạn đã
   chọn* chỉ áp dụng nếu khoảng đã chọn vẫn còn đúng đoạn văn bản Clark đã đọc; Escape hoặc *Bỏ qua* để đóng. Thay đổi
   được đưa vào qua cơ chế soạn thảo của trình duyệt, nên Ctrl+Z hoàn tác được như mọi thứ đã gõ; nếu trình duyệt từ chối
   cách đó, văn bản được đặt trực tiếp và trình soạn thảo không đề nghị hoàn tác. Thay đổi đã áp dụng là một chỉnh sửa
   chưa lưu như mọi chỉnh sửa khác.

Clark không bao giờ ghi vào frame, và không model nào phê duyệt một lần lưu: xuất tệp vẫn là hành động của người dùng
trong hộp hỏi của host.

**Khoảng trống đã biết.** Hiện tại, gõ yêu cầu trong ô soạn tin ("rút ngắn dòng thứ hai") không thể thay đổi trình soạn
thảo, và chưa có đường nào của sản phẩm đặt trình soạn thảo kèm binding viết lại. Chưa có công cụ agent nào thực hiện
được action riêng của một widget cách ly, nên thay đổi chỉ đến được frame qua nút của chính trình soạn thảo. Clark vẫn
đọc được trình soạn thảo qua ghi chú lượt kế tiếp và `inspect_ui`. Cả hai được theo dõi ở
[#382](https://github.com/digitopvn/clarkcant/issues/382).

**Trợ năng.** Mọi điều khiển đều là nút gốc hoặc ô văn bản, theo thứ tự tab cố định, với viền focus nhìn thấy được. Hộp
hỏi của host và các bảng của trình soạn thảo nhận bàn phím tại tiêu đề của chúng, trừ câu hỏi về hai chỗ xem để bàn
phím lại cho người đang gõ. Escape đóng bảng đang mở: đóng đề xuất, huỷ việc mở tệp khác, và giữ bản nháp của chỗ xem
này trong câu hỏi về hai chỗ xem. Màu lấy từ appearance token của host (`appearance@1`), nếu không có thì theo lựa chọn
sáng hoặc tối của hệ thống. Chế độ giảm chuyển động bỏ mọi hiệu ứng chuyển tiếp. Thanh công cụ xuống dòng ở 390 px, và
frame xin host chiều cao đúng bằng nội dung.

Kiểm thử: [editor-core.spec.ts](../examples/reference-apps/text-editor/test/editor-core.spec.ts) cho các quy tắc,
[package.spec.ts](../examples/reference-apps/text-editor/test/package.spec.ts) cho conformance, manifest và bản sao quy
tắc làm sạch của host, [pure-ui-template.spec.ts](../packages/widget-cli/test/pure-ui-template.spec.ts) cho template,
[semantic-settle.spec.ts](../packages/conversation-client/test/semantic-settle.spec.ts) cho việc gửi publish đang chờ
trước một lần bấm, và hành trình trên trình duyệt [text-editor.spec.ts](../apps/web/e2e/text-editor.spec.ts). Hành
trình đó mở, sửa, tải lại, lưu thành tệp tải xuống rồi mở lại trên web. Nó gõ tiếp trong lúc một lượt ghi bản nháp bị
giữ lại trên đường tới node, và kiểm tra rằng không có xung đột nào hiện ra và không mất gì đã gõ. Kiểm thử máy tính
của nó chỉ là phần của trang: nó ghi đè tệp gốc rồi mở lại với một preload được mô phỏng theo hợp đồng của shell. Các
hàm hỗ trợ của shell (từ handle ra đường dẫn, giữ loại tệp, ghi nguyên khối) được kiểm thử đơn vị trong
[file-bridge.spec.ts](../apps/desktop/test/file-bridge.spec.ts); IPC handler của shell và hộp xác nhận của nó chưa được
cái nào chạy tới, và một hành trình với shell thật vẫn còn phải làm. Hành trình nhờ Clark qua model kịch bản, model này
trích đoạn đang chọn từ phần dữ liệu; nó hiển thị đoạn sẽ bị thay, áp dụng câu trả lời rồi hoàn tác, từ chối một đoạn
chọn nhiều dòng, và từ chối một câu trả lời khi khoảng đã chọn đã đổi. Nó chạy chỉ bằng bàn phím, ở 390 px với cả hai
giao diện sáng và tối khi bật giảm chuyển động, và kiểm tra, với tin nhắn được ghi ở cả hai chiều, rằng không có vị trí
trên đĩa hay file handle nào đi qua bridge.

### 24.2 Bảng tính

`examples/reference-apps/spreadsheet` ([#318](https://github.com/digitopvn/clarkcant/issues/318), thuộc [#200](https://github.com/digitopvn/clarkcant/issues/200)) là một package manifest v2 có một facet
giao diện cách ly và không có service. Package cho thấy một widget làm việc với tệp, giữ một tài liệu lớn trong giới
hạn, tự mô tả cho Clark và áp dụng một thay đổi do Clark chọn.

- **Tệp.** CSV và TSV được nhập qua `api.artifacts.pick` ([§10.1](#101-tệp-theo-tham-chiếu-artifacts1)) và đọc theo
  từng đoạn 256 KiB; widget không bao giờ thấy đường dẫn. Xuất ghi một tệp mới qua `create`, `write`, `finalize` và
  `export`, có dấu BOM như chức năng xuất bảng của host. XLSX không được hỗ trợ: trong mã nguồn không có bộ phân tích
  đã được thẩm định, và broker tệp của host không chấp nhận kiểu này.
- **Giới hạn.** Tải tối đa 25.000 ô, 64 cột và 5.000 hàng, và không tệp nào được đọc quá 8 MiB. Giới hạn ô áp lên
  hình chữ nhật mà các hàng tạo thành (số hàng nhân với hàng rộng nhất), đúng quy tắc bảng áp cho một lần sửa, nên một
  tệp có hàng dài ngắn không đều bị cắt ở chỗ hình chữ nhật hết vừa, thay vì tải ra một bảng rồi từ chối mọi lần sửa.
  Việc đọc dừng ở giới hạn và một thông báo cho biết đã hiện bao nhiêu và khi xuất chỉ ghi phần đó. Lần đọc bị dừng ở
  mức 8 MiB bỏ dòng đang đọc dở thay vì hiện một mảnh như thể là một hàng, và vẫn được báo là bị cắt kể cả khi giới hạn
  rơi đúng vào cuối một dòng. Dòng trống ở cuối tệp không được tính, nên
  không bao giờ làm một tệp vừa giới hạn trông như bị cắt. Hàng và cột được vẽ ảo, nên một bảng lớn chỉ giữ các ô đang
  nhìn thấy trong trang.
- **Trạng thái.** Trạng thái widget giữ tham chiếu tới tệp nguồn, các sửa đổi từ đó và định dạng, không bao giờ giữ
  chính bảng. Ô hiện tại và vùng chọn được khai báo trong `ephemeralStateKeys` ([§5](#5-widget-definition)): host giữ
  chúng cho frame và không bao giờ ghi xuống node, và việc di chuyển con trỏ gửi tối đa một lần cập nhật sau mỗi lần
  dừng tay. Ngay sau khi nhập, widget ghi bảng vào một tệp riêng của nó, và tệp ấy trở thành nguồn. Quyền đọc của
  widget trên một tệp được chọn chỉ kéo dài 24 giờ kể từ lúc chọn, còn một tệp đã hoàn tất do chính widget ghi thì
  không hết hạn. Nếu lần ghi ấy thất bại, dòng trạng thái nói rõ và lần sửa tiếp theo sẽ thử lại; trong lúc đó bảng vẫn
  phụ thuộc vào tệp được chọn. Khi sửa đổi vượt 10 KiB trong 16 KiB host cho phép, widget cũng ghi toàn bộ bảng vào
  một tệp riêng như vậy và bắt đầu lại từ tệp ấy. Mỗi lúc chỉ chạy một checkpoint như vậy, và chờ thêm tối đa một cái.
  Các sửa đổi làm trong lúc một checkpoint đang được ghi vẫn được giữ và được lưu sau nó, và chỉ những sửa đổi tệp ấy
  đã chứa mới được xoá. Khi một checkpoint đã được ghi nhận, widget yêu cầu host huỷ checkpoint mà nó thay thế, và một
  checkpoint được ghi cho một bảng đã bị lần nhập khác thay thế trong lúc đó cũng bị huỷ. Nếu host từ chối huỷ, tệp ấy
  vẫn nằm trong vùng lưu trữ của widget. Một checkpoint không tải được trọn vẹn sau khi tải lại sẽ được nói rõ trong
  thông báo. Xoá một vùng chọn là một lần sửa gộp, nên xoá cả bảng chỉ mất một lát chứ không phải vài phút.
- **Tải bảng.** Khi được gắn vào, bảng được đọc lại từ nguồn. Cho tới khi tải xong, lưới không nhận sửa đổi, các nút
  Nhập, Xuất và "Nhờ Clark" phải chờ, và dòng trạng thái báo bảng đang được mở. Khi không đọc được nguồn, dòng trạng
  thái nói rõ, lưới chỉ hiện các sửa đổi làm sau đó và không nhận sửa đổi nào, và không có gì được lưu, nên bảng đã lưu
  vẫn còn nguyên ở lần gắn sau. Nhập một tệp sẽ bắt đầu lại từ tệp ấy.
- **Công thức.** Một tập đóng: số học, tham chiếu ô và vùng, và `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`. Một bộ
  phân tích dựng cây và widget duyệt cây đó; không văn bản nào được chạy như mã. Lỗi là giá trị (`#DIV/0!`,
  `#VALUE!`, `#REF!`, `#NAME?`, `#PARSE!`, `#NUM!`, `#LIMIT!`), và tham chiếu vòng là `#CIRC!`, với các ô
  trên vòng được nêu tên trong thông báo. Một lần tính lại đọc tối đa 5.000.000 ô qua các vùng và lần theo tối đa
  2.000.000 liên kết giữa các công thức. `#LIMIT!` chỉ đánh dấu công thức vượt một trong hai giới hạn đó, cùng các công
  thức đọc nó; một công thức không có vùng, như `=1+1`, luôn được tính. Một tổng luỹ kế như `=SUM($A$1:A3000)` kéo
  xuống 3.000 hàng vẫn vừa.
- **Chèn công thức vào CSV.** Tệp xuất mang giá trị đã tính, không bao giờ mang công thức. Văn bản bắt đầu bằng `=`,
  `+`, `-`, `@`, tab hoặc ký tự CR được ghi kèm dấu `'` ở đầu, đúng quy tắc của `toCsv`. Văn bản mà bảng này sẽ đọc
  lại thành thứ khác, như `007`, `1e3` hoặc văn bản tự nó bắt đầu bằng `'`, cũng được ghi kèm dấu `'`. Dấu `'` ở đầu
  được đọc lại là văn bản, nên một tệp đã xuất nhập lại vào bảng này vẫn ra cùng giá trị. Một ứng dụng bảng tính khác
  hiện dấu `'` đó như một phần của văn bản, giống như với quy tắc công thức.
- **Tài liệu ngữ nghĩa.** Vùng chọn dạng A1, một đoạn trích tối đa 12 hàng × 8 cột, công thức và giá trị của ô hiện tại,
  và kích thước bảng, vừa trong giới hạn ngữ nghĩa của host nên không gì bị cắt.
- **Định dạng qua Clark.** Nút "định dạng phần trăm" của widget bấm một binding `agent` có id được truyền qua prop
  `formatBinding` và ngữ cảnh là `selection` và `widget`. Lần bấm không gửi gì: host đọc vùng chọn từ tài liệu ngữ
  nghĩa của widget và yêu cầu đúng một dòng, `format: percent <vùng>`. Widget coi câu trả lời là không đáng tin. Nó
  nhận một tập dòng đóng, `format: percent|number|plain <vùng>`, và chỉ áp dụng khi vùng đúng là vùng đã chọn lúc bấm;
  nếu không, nó nói rõ và không thay đổi gì. Vùng chọn bị khoá cho tới khi có câu trả lời. Bảng giữ tối đa 32 định dạng.
  Khi một định dạng mới đẩy định dạng cũ nhất ra, dòng trạng thái nêu tên vùng bị mất định dạng. "Hoàn tác định dạng",
  hoặc Ctrl+Z trong lưới, khôi phục các định dạng trước thay đổi của Clark. Widget không có thao tác hoàn tác nào khác.
- **Bàn phím.** Lưới là một điểm dừng Tab duy nhất. Phím mũi tên để di chuyển, Shift mở rộng vùng chọn, Home/End và
  Ctrl+Home/End để nhảy, Page Up/Down để lật trang. Enter hoặc F2 để sửa, gõ phím để bắt đầu sửa, và Enter xác nhận rồi
  xuống dưới. Escape huỷ lần sửa hoặc thu vùng chọn về ô hiện tại. Delete xoá vùng chọn, và Ctrl+Z hoàn tác định dạng
  gần nhất. Tab và Shift+Tab rời lưới, nên vẫn tới được Nhập, Xuất, "Nhờ Clark" và phần còn lại của trang. Chỉ khi đang
  sửa, Tab mới xác nhận và sang phải.
- **Con trỏ và cảm ứng.** Chuột chọn bằng cách bấm, Shift+bấm hoặc kéo. Trên màn hình cảm ứng, chạm để chọn một ô và
  vuốt để cuộn lưới. "Chọn vùng" làm các lần chạm sau mở rộng vùng chọn từ ô đã chạm trước đó; chạm lại để tắt. Các nút
  cao ít nhất 40 px.

Hai giới hạn được nói rõ thay vì giấu đi. Hiện chưa có gì trong sản phẩm đặt một widget của package kèm một hành động đã
gắn: trong bộ kiểm thử trình duyệt, node fixture đặt bảng tính và biên dịch binding của nó theo cách host biên dịch đề
xuất của model. Và một yêu cầu gõ trong ô soạn tin tới được Clark qua ghi chú ngữ nghĩa nhưng không thay đổi được frame.
Cả hai được theo dõi ở [#382](https://github.com/digitopvn/clarkcant/issues/382). Một lần bấm ngay sau khi vùng chọn
đổi không nằm trong số đó: trước khi chạy lần bấm, host gửi tài liệu ngữ nghĩa đang chờ của widget và chờ đến khi node
đã giữ nó ([§24.1](#241-trình-soạn-thảo-văn-bản)), nên Clark đọc đúng vùng đã chọn lúc bấm. Một câu trả lời nêu vùng
khác vẫn bị từ chối, và không có gì thay đổi.

Kiểm thử: unit test cho bộ phân tích, công thức, giới hạn và tài liệu ngữ nghĩa trong
[test/](../examples/reference-apps/spreadsheet/test/) (56 test), gồm cả checkpoint với một host giả: sửa đổi làm trong lúc
một checkpoint đang được ghi vẫn còn sau khi tải lại, mỗi lúc một checkpoint, tệp bị thay thế được huỷ, checkpoint bị
từ chối thì sửa đổi vẫn giữ trong bộ nhớ, bảng bị thay giữa lúc ghi hoặc lúc ghi nhận, tệp nhập được ghi thành tệp riêng
của widget, và không lưu gì trước khi bảng tải xong hay sau khi không đọc được nguồn. `clark widget test` qua 22 kiểm tra, 12 kiểm
tra cần dev host. Hành trình trình duyệt [spreadsheet.spec.ts](../apps/web/e2e/spreadsheet.spec.ts) (4 test) gồm:

- nhập, sửa, xuất và nhập lại ở CSV và TSV ra cùng giá trị;
- một vùng chọn được Clark định dạng phần trăm, vùng chọn bị khoá trong lúc Clark trả lời, và hoàn tác;
- một tệp vượt giới hạn chỉ tải phần đầu, nói rõ điều đó, vẫn phản hồi nhanh, và xoá cả 25.000 ô một lần;
- không đường dẫn nào trong lưu lượng bridge hay frame;
- dùng lưới bằng bàn phím (Tab và Shift+Tab rời lưới), bằng cảm ứng với "Chọn vùng", và bằng cách kéo chuột;
- cả hai giao diện sáng tối, nút cao 40 px, và 390 px với lưới cuộn bên trong thẻ của nó;
- một bảng đang tải hoặc không đọc được nguồn thì không nhận sửa đổi và giữ nguyên bảng đã lưu, và một checkpoint thất
  bại thì nói rõ những gì được giữ và được lưu ở lần sửa tiếp theo.

### 24.3 Trình tạo ảnh

[`examples/reference-apps/image-generator`](../examples/reference-apps/image-generator)
([#319](https://github.com/digitopvn/clarkcant/issues/319), thuộc
[#200](https://github.com/digitopvn/clarkcant/issues/200)) là một package manifest v2 có một facet giao diện cách ly và
một facet service. Package cho thấy một widget khởi động việc dài trên service, theo dõi nó và nhận lại một tệp, trong
khi service gọi tới nhà cung cấp bằng một key mà nó không bao giờ giữ.

- **Capability.** Service cung cấp `com.clarkcant.reference.image-generator.image.generate@1` (ref của capability được
  đặt dưới id của package), với `effectCategory: "external-write"` và `execution: { kind: "job", version: 1 }`. Một lần
  bấm trả về ngay một JobRef ([§10.2](#102-job-chạy-lâu-jobs1)).
- **Vì sao là `external-write`.** Yêu cầu nhà cung cấp vẽ là ghi vào dịch vụ của người khác: nó làm việc ở đó và tiêu
  hạn mức của người dùng. Đó cũng là điều cho phép service bắt đầu ảnh bằng một POST với prompt nằm trong body JSON:
  node chỉ gửi request của service bằng phương thức khác GET hay HEAD cho capability được quyết định là `external-write`
  trở lên ([§14.2](#142-service-gọi-tới-nhà-cung-cấp)), và prompt nằm trong URL sẽ bị ghi vào nhiều log hơn body. Với
  chính sách tự chủ mặc định, một lần bấm chạy luôn; người dùng có chính sách hỏi trước khi ghi ra ngoài sẽ thấy thẻ
  duyệt của host trước, và widget được báo rằng lần bấm đang chờ.
- **Nhà cung cấp.** Facet tools khai báo một origin và một secret, `IMAGE_PROVIDER_KEY`. Service bắt đầu một ảnh bằng
  POST, đọc trạng thái mỗi bước một lần và lấy tệp PNG bằng GET, tất cả qua `clarkcant/egress.fetch`; node thêm key vào
  như một header bearer. Cho tới khi người dùng lưu key, nút bị tắt kèm lý do của node. Nhà cung cấp trong repository
  này là một bản giả trong phần kiểm thử của package: nó chỉ trả lời request có key, từ chối prompt nằm trong URL, và
  trả về một ảnh tất định. Nhà cung cấp thật là [#321](https://github.com/digitopvn/clarkcant/issues/321).
- **Tiến độ và kết quả.** Mỗi bước xong là một progress của MCP, được job ghi lại và widget hiển thị; widget không ước
  đoán gì. Tệp PNG trả về dưới dạng một phần ảnh, được node lưu làm artifact kết quả của job. Lỗi của service được giữ
  trên job thất bại bằng chính lời của service ([§10.2](#102-job-chạy-lâu-jobs1)), và widget hiển thị những lời đó
  trong ngoặc kép như lời của service, bên trong câu của chính nó. Mỗi job đang chạy có một khung riêng với tiến độ và
  nút Dừng riêng, nút này huỷ đúng job đó; service ngừng đọc nhà cung cấp.
- **Thư viện ảnh.** Khi host mở `jobs.list@1`, widget liệt kê các job của chính nó, theo dõi những job đang mở, và đọc
  ảnh đã xong dưới dạng `ArtifactRef` theo từng đoạn 256 KiB; tải lại trang hay mở trên thiết bị khác vẫn thấy cùng các
  job, vì chúng thuộc về node. Trên host không có extension đó, thư viện ảnh chỉ giữ các job được khởi chạy trong lúc
  widget đang mở và nói rõ điều đó. Mỗi ảnh có thể được đính kèm vào cuộc trò chuyện hoặc xuất ra qua host
  ([§10.1](#101-tệp-theo-tham-chiếu-artifacts1)). Khi đính kèm, widget đề xuất một tên ghép từ slug ngắn của prompt và
  phần cuối mã job, như `a-red-kite-over-a-green-sea-3f9a1c.png`, nên hai ảnh được đính kèm có hai tên khác nhau; node
  làm sạch tên đó.
- **Widget, Clark và giọng nói.** Nút là một action binding `invoke` có tên trong props là `generateBinding`. Binding
  lấy `prompt` từ bản nháp trong widget state, và từ input của lần bấm khi có. Nói nhãn của nút khi widget đang mở sẽ
  bấm nó với bản nháp, và câu trả lời nói job đã bắt đầu. Công cụ `invoke_capability` của Clark khởi động một capability
  dạng job qua widget trong cuộc trò chuyện có binding tới nó, để widget đó theo dõi job. Nếu không có widget nào thì
  không có gì chạy và Clark nói rõ; nếu có nhiều thì Clark được cho biết `instanceId` và `actionBindingId` của từng nút
  và chọn một. Clark bị từ chối khi bấm một binding hỏi chính Clark, vì lần bấm đó sẽ được gửi như tin nhắn của chính
  người dùng.
- **Ngôn ngữ.** Giống trình soạn thảo văn bản ([§24.1](#241-trình-soạn-thảo-văn-bản)), chữ của chính frame
  chỉ có tiếng Việt: DESIGN §11.1 dịch phần giao diện mặc định của host, không dịch chữ của widget.
- **Template.** `clark widget init --template ai-generator` sao chép ứng dụng này dưới id của package mới, kể cả nhà
  cung cấp, với origin giữ chỗ `https://images.example.com` thay cho origin của nhà cung cấp kiểm thử: hãy thay nó, cùng
  các đường dẫn trong `service/server.mjs`, bằng của nhà cung cấp của bạn trước khi phát hành. `--template
  ui-with-service` sao chép cùng widget và job với một service tự vẽ ảnh, không khai báo nhà cung cấp nào, nên chỉ đọc.
  Cả hai vượt qua `clark widget test` và `pack` ngay khi được tạo. `pure-ui` và cả hai template này đi qua cùng một bộ
  sao chép trong CLI.

Hiện chỉ có model fixture có kịch bản của repository đặt widget kèm `generateBinding`. Chưa có đường đi nào của sản
phẩm đặt một widget của package đã cài kèm binding ([#382](https://github.com/digitopvn/clarkcant/issues/382)), nên
trong một bản cài thật widget sẽ nói nó chưa được gắn với service.

Kiểm thử: [service-job.spec.ts](../examples/reference-apps/image-generator/test/service-job.spec.ts) cho service với
nhà cung cấp giả qua job host, egress broker và artifact broker (hoàn tất, tiến độ, POST bắt đầu một ảnh, thất bại, key
bị từ chối, huỷ, lỗi của nhà cung cấp lặp lại key, và key không có trong lệnh khởi chạy service, job, cơ sở dữ liệu,
log, audit, thông báo và tệp); [package.spec.ts](../examples/reference-apps/image-generator/test/package.spec.ts) cho
conformance và manifest; [reference-templates.spec.ts](../packages/widget-cli/test/reference-templates.spec.ts) cho
các template và bộ sao chép dùng chung; và hành trình trình duyệt
[image-generator.spec.ts](../apps/web/e2e/image-generator.spec.ts). Hành trình bao gồm từ chối khi chưa có key, tiến độ
qua một lần tải lại, thư viện ảnh, hai job mỗi job có nút Dừng riêng, nhà cung cấp báo lỗi có lặp lại key, đính kèm và
xuất, Clark, giọng nói, duyệt trên thẻ của host, host không có `jobs.list@1`, bàn phím, hai theme, 390 px và giảm
chuyển động. Sau mỗi hành trình, key được tìm trong trang, bridge, tệp và bảng của node, và container của service.

### 24.4 Trình dựng âm thanh

`examples/reference-apps/media-render` ([#320](https://github.com/digitopvn/clarkcant/issues/320), thuộc
[#200](https://github.com/digitopvn/clarkcant/issues/200)) là một package manifest v2 có một facet giao diện cách ly
và một service. Package dựng lại một tệp WAV người dùng chọn, với mức âm lượng mới và phần cắt, thành một job mà widget
theo dõi được và dừng được. `clark widget init --template media-tool` tạo package mới từ package này.

- **Tệp theo tham chiếu.** Widget chọn tệp qua `api.artifacts.pick` ([§10.1](#101-tệp-theo-tham-chiếu-artifacts1)) và
  chỉ giữ `ArtifactRef` của nó. Binding `render` của widget gửi cho service mã artifact của tệp, và service đọc dữ liệu
  từ node theo từng đoạn ([§14.4](#144-tệp-mà-service-đọc)). Widget không bao giờ thấy đường dẫn, và service không nhận
  đường dẫn hay handle nào. Service không khai báo egress, và lời gọi `read` đang giữ tệp cũng không dùng được egress.
- **Profile.** Package xin `background-compute` theo tên ([§14.1](#141-resource-profile)). Node từ chối tệp vượt giới
  hạn đầu vào 25 MiB của profile trước khi gửi lời gọi. Service từ chối đoạn dài hơn một giờ của profile trước khi dựng
  bất cứ phần nào, và từ chối bản dựng lớn hơn mức một kết quả mang được.
- **Job.** Lần nhấn trả về một JobRef ([§10.2](#102-job-chạy-lâu-jobs1)), widget giữ nó trong trạng thái. Tiến độ là
  MCP progress của chính service, tính bằng số byte đã dựng. Nút Dừng, hoặc phím Escape, huỷ job; service ngừng đọc và
  không trả lời, nên không tệp dở dang nào được giữ lại. Lần dừng mà node từ chối được nói rõ, và nút Dừng cùng phím
  Escape dùng lại được. Frame tải lại theo dõi đúng job đó từ trạng thái. Lần nhấn mới chỉ thay bản dựng đang hiện khi
  node đã nhận nó, nên lần nhấn bị từ chối giữ nguyên tệp trước cùng nút Đính kèm và Lưu. Bản dựng đã xong mà node không
  giữ được tệp kết quả sẽ nói cái gì hỏng và rằng tệp gốc vẫn còn.
- **Cảm ứng.** Ô âm lượng xin bàn phím chữ (`inputmode="text"`), vì bàn phím số thập phân trên iOS không có dấu trừ mà
  phần lớn khoảng giá trị là giảm âm lượng. Ô này nhận cả dấu trừ kiểu chữ in và dấu phẩy thập phân. Mọi nút và ô nhập đều
  cao ít nhất 44 px.
- **Xem trước.** Tệp đã dựng là một `ArtifactRef` đã chốt. Widget đọc lại tệp và vẽ dạng sóng trên canvas, kèm thời
  lượng, định dạng và mã băm sha256 do node tính. Chính sách của frame không cho nguồn media, nên không có trình phát âm
  thanh. Đính kèm đưa tệp vào ô soạn tin; Lưu đi qua hộp xuất tệp của host.
- **Profile không khả dụng.** Khi node không cấp được `background-compute`, vì một quy tắc chính sách từ chối hoặc
  container engine quá nhỏ, service không được khởi động. Nút Dựng bị tắt, và lý do của host hiện ở chỗ đó.
- **Nhịp của fixture.** Node khởi động với `CC_MODEL_FIXTURE=1` giữ lại mỗi câu trả lời cho lần đọc tệp của service
  700 ms (`timings.artifactReadDelayMs` của service host), để hành trình theo dõi được tiến độ và dừng một lần dựng giữa
  chừng. Công cụ của service không có tham số điều nhịp, template `media-tool` cũng vậy.
- **Đặt widget.** Hiện chỉ fixture model có kịch bản của repo mới đặt widget kèm `renderBinding`. Chưa có đường nào
  trong sản phẩm đặt widget của một package đã cài kèm binding
  ([#382](https://github.com/digitopvn/clarkcant/issues/382)), nên trong bản cài thật nút Dựng hiện lý do đó.

Test: [wav.spec.ts](../examples/reference-apps/media-render/test/wav.spec.ts) cho phép biến đổi và mã băm cố định,
[service.spec.ts](../examples/reference-apps/media-render/test/service.spec.ts) cho tiến trình service (tiến độ, huỷ,
các giới hạn, một lần đọc bị từ chối), [package.spec.ts](../examples/reference-apps/media-render/test/package.spec.ts)
cho bộ kiểm tra tuân thủ và manifest,
[media-tool-template.spec.ts](../packages/widget-cli/test/media-tool-template.spec.ts) cho template, và hành trình
trình duyệt [media-render.spec.ts](../apps/web/e2e/media-render.spec.ts). Hành trình dựng một tệp dài mười hai đoạn có
tiến độ và bản xem trước, giữ bản xem trước đó qua một lần nhấn bị từ chối, dừng một lần dựng giữa chừng sau một lần
dừng bị từ chối, theo dõi một lần dựng qua một lần tải lại, hiện lý do profile bị từ chối, và chạy chỉ bằng bàn phím ở
390 px trong giao diện tối với giảm chuyển động, với nút cao 44 px và âm lượng âm. Hành trình cần một container engine
chạy được container Linux.

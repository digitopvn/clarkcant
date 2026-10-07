# clarkcant

> [English](README.md) (mặc định) · Tiếng Việt

Nền tảng agent lấy hội thoại làm trung tâm: một runtime di động mà ai cũng có thể cài trên
máy của mình hoặc trên VPS, cùng các execution node được ghép cặp, widget phong phú ngay trong
hội thoại, và các capability pack được cài qua chat.

Hội thoại là giao diện duy nhất người dùng phải học. Desktop và web là client của một runtime
cũng chạy được ở chế độ headless; các runtime đã ghép cặp có thể chuyển việc cho nhau và trả
kết quả về cùng một hội thoại.

## Trạng thái

**Đây là bản bootstrap, không phải bản phát hành.** Nó gồm nền móng P1 cùng những phần có thể
kiểm chứng của P2–P9: contracts, độ bền dữ liệu (durability), các invariant cốt lõi, các
security primitive, và adapter cho mọi thứ cần tài khoản bên ngoài.

[`docs/conformance-traceability.md`](docs/conformance-traceability.md) là sổ cái trung thực:
mọi hạng mục scope (V01–V18) và mọi acceptance test (T01–T72) trong
[`docs/implementation-plan.vi.md`](docs/implementation-plan.vi.md) đều có trạng thái PASS,
BLOCKED hoặc NOT-IMPLEMENTED, kèm bằng chứng cho từng mục. Không mục nào ở đó được đánh dấu là
hoàn tất.

Tra trạng thái và điều kiện còn thiếu tại [bảng conformance](docs/conformance-traceability.md).
Test từng lớp không thay thế kiểm chứng hành trình; các hành trình trình duyệt nằm
trong [apps/web/e2e](apps/web/e2e). Fixture không chứng minh provider thật hoạt động.

## Những gì thực sự hoạt động

Những điều sau được kiểm chứng bằng test trong repository này, không chỉ được mô tả bằng lời:

- **Xử lý command bền vững.** Một command được thử lại với cùng idempotency key sẽ trả về
  acknowledgement ban đầu thay vì tạo task thứ hai. Dùng lại key đó cho một payload khác sẽ bị
  từ chối. (`packages/storage`)
- **Vòng đời task.** Một state machine đầy đủ và toàn phần, trong đó trạng thái thành công chỉ
  đạt được qua bước xác minh có bằng chứng được ghi lại, và một external effect chưa được giải
  quyết sẽ chặn việc báo thành công. (`packages/contracts/src/tasks.ts`, `packages/core`)
- **Đối soát effect.** Một lần submit bị mất acknowledgement sẽ chuyển sang `unknown` và không
  bao giờ bị gửi lại một cách âm thầm. (`packages/contracts/src/effects.ts`)
- **Thẩm quyền.** Các grant giao nhau thay vì cộng dồn, nên A→B→C không thể mở rộng mức tin
  cậy, và chỉ một user principal mới được phê duyệt một thao tác.
  (`packages/contracts/src/grants.ts`)
- **Resource lease có fencing.** Mỗi resource chỉ có một lease đang sống, được đảm bảo bằng
  một partial unique index, kèm một epoch để chặn holder đã bị thay thế. (`packages/core`)
- **Vòng đời cài đặt.** Một plan cho mỗi capability và node, consent gắn với digest của plan,
  các generation bất biến, và rollback giữ generation trước tiếp tục phục vụ.
  (`packages/core/src/install-lifecycle.ts`)
- **Security primitive.** Một credential vault AES-256-GCM không có getter trả plaintext,
  che giấu credential, PKCE, so sánh state trong thời gian hằng, xác minh scope là tập con,
  kiểm tra audience của MCP token, và một allowlist biến môi trường loại bỏ `SSH_AUTH_SOCK`,
  `AWS_*`, `GITHUB_TOKEN` cùng các provider key trước khi spawn tiến trình con.
  (`packages/host-adapters`, `packages/integration-sdk`, `packages/mcp-adapters`,
  `packages/execution-supervisor`)
- **Tích hợp Pi SDK thật.** `packages/pi-adapter` được định kiểu theo SDK đã cài, và probe
  P0.1 ghi lại những bước vòng đời nào thực sự đã chạy.
  (`docs/research/compatibility-lock.md`)
- **Một conversation client.** Câu trả lời hiện dần ra khi model đang viết, markdown và khối
  code có rào được render với ngôn ngữ được tô sáng, một tool mà lượt hội thoại gọi xuất hiện
  dưới dạng widget người đọc có thể mở, và ô soạn thảo giãn ra tới năm dòng rồi mới cuộn. Gõ
  `/` để gọi tên một skill, và `@` để gọi một project, file, thư mục, service, hội thoại hoặc
  background task; node kiểm tra lại từng tham chiếu khi tin nhắn được gửi. Khung tin nhắn — bong
  bóng cho người dùng, dấu hiệu riêng của agent cho câu trả lời — theo bản thiết kế tham chiếu
  trong `docs/demo-ui`. Được kiểm chứng end-to-end bởi `apps/web/e2e/`, bộ test chạy một
  production build với một node thật. (`packages/conversation-client`)
- **Tool call dưới dạng widget.** Mọi tool mà một lượt gọi đều được ghi lại cùng các đối số đã
  nhận và kết quả đã trả về, được báo trên stream trong lúc chạy, và được vẽ thành một phần thu
  gọn mở ra khi đang làm và đóng lại khi xong. Phần suy luận (reasoning) là một widget thu gọn
  riêng, vì đó không phải điều model nói với người dùng.
  (`apps/runtime/src/model-turn.ts`, `packages/contracts/src/surfaces.ts`)
- **Tìm kiếm toàn máy, chỉ đọc.** Một lượt duyệt filesystem có giới hạn, không xây index, bỏ
  qua cây dependency và cây hệ thống, báo lại đã quét những gì và vì sao dừng, và chỉ gửi những
  dòng khớp cho model. (`apps/runtime/src/fs-search.ts`)
- **Một headless node khởi động được.** `node apps/runtime/src/main.ts` chạy một node với
  identity và database riêng, và từ chối mọi command không có bearer token của nó.
- **Điều phối task.** Khi conductor chọn một capability cho task, một worker thực sự chạy nó:
  một pool worker process có giới hạn (vượt quá pool thì xếp hàng), một lease cho mỗi
  capability có fencing để hai lần chạy cùng capability không va chạm, giới hạn các root của
  worker trong phạm vi node sở hữu, một deadline, ngân sách thời gian thực và token của task,
  một trần output cho tiến trình con, và một allowlist biến môi trường của execution-supervisor
  để tiến trình con không bao giờ thừa hưởng provider key hay SSH agent socket. Bằng chứng của
  lần chạy sẽ chốt task qua cùng state machine mà mọi đường khác sử dụng — thành công chỉ qua
  xác minh — và kết quả đến hội thoại như một host reply thông thường, cùng cơ chế mà một
  background request đã dùng. `POST /stop` kill mọi worker còn đang chạy.
  (`apps/runtime/src/task-dispatch.ts`, `apps/runtime/src/worker-process.ts`)
- **Backup có thể kiểm chứng.** SQLite `VACUUM INTO`, kiểm tra tính toàn vẹn và foreign key,
  so sánh số dòng, và từ chối khôi phục một backup được tạo bởi schema mới hơn.
- **Giao diện mở.** Ứng dụng bên thứ ba và các công cụ AI đến cùng một gateway, dưới cùng một
  token, qua REST (OpenAPI 3.1 tại `/openapi.json`), SSE streaming, MCP (`POST /mcp`, và stdio
  qua `clarkcant mcp`), một JSON WebSocket (`/ws`) và CLI `clarkcant`. MCP cố ý không có tool
  phê duyệt. ([`docs/open-interfaces.vi.md`](docs/open-interfaces.vi.md),
  `apps/runtime/test/open-interfaces.spec.ts`, `apps/cli`)

## Tự chủ

Mặc định là tự chủ: agent hành động theo ý định được giao, và điều khiến việc đó đứng vững không
phải một hộp thoại mà là host. Mọi effect đi qua một bước preflight tất định, giới hạn nó trong các
thư mục node này sở hữu, kiểm tra resource có tồn tại, và gắn một deadline cùng một trần output.
Sau đó một lớp policy có thể từ chối, thu hẹp hoặc hỏi một câu làm rõ — và nó chỉ có thể thu hẹp,
không bao giờ mở rộng.

- **Execution policy.** `guarded` là mặc định: không ai bị hỏi, và guardrail vẫn có thể từ chối.
  `confirm` giữ nguyên thẻ phê duyệt cho ai muốn được hỏi; `auto` và `deny` tắt và bật các lớp
  này.
- **Câu hỏi, không phải hộp thoại xin quyền.** `ask_user_question` kết thúc lượt đã hỏi, và câu
  trả lời đến như một lượt mới — đó là lý do một câu hỏi không tốn gì trong lúc chờ. Giọng nói và
  một cú click gửi cùng một câu trả lời tới cùng một route.
- **Secret là metadata.** Agent biết rằng `github_token` tồn tại, dùng để làm gì và ai được dùng
  nó. Giá trị đi từ một backend vào đúng một lần gọi — một tool call, môi trường của một tiến
  trình con, một request header — và không bao giờ được trả về cho model.
- **Một pool model.** Nhiều profile có vai trò và độ ưu tiên; `Cmd/Ctrl+]` chuyển sang profile
  kế tiếp, và thay đổi đó trở thành một generation mới ở ranh giới lượt kế tiếp, vì Pi resolve
  model khi một session được tạo.
- **Stop và audit.** `POST /stop` kill các command đang chạy, ngắt các lượt và dừng background
  worker. Mọi effect được ghi vào một audit trail chỉ-ghi-thêm theo tên và kết quả, không bao
  giờ theo giá trị.
- **Một supervisor cho công việc đang chạy.** Background request, tiến trình `run_command`, task
  worker và terminal được liệt kê và dừng qua một work supervisor duy nhất — từ process panel,
  bằng cách hỏi Clark (`list_work` / `stop_work`), bằng `POST /stop`, hoặc khi tắt máy chủ. Tối đa
  3 background request chạy cùng lúc (1/3/5 trong Settings) với hàng đợi 10; mỗi tiến trình con
  chạy trong process group riêng, nên lệnh dừng chạm tới cả tiến trình cháu. Một command do model
  chạy chỉ thừa hưởng một allowlist cộng với secret mà broker đã cấp, nên một token được export
  trong môi trường của node (ví dụ `GH_TOKEN`) không còn hiển thị với `run_command`; một terminal
  giữ môi trường của chính người dùng, trừ những gì node tự nạp. Sau khi khởi động lại, mỗi
  công việc chưa xong được báo một lần trong hội thoại của nó.
  (`apps/runtime/src/work-supervisor.ts`, `work-recovery.ts`, `child-env.ts`)

## Những gì chưa hoạt động

Nói thẳng, vì một bản bootstrap che giấu điều này còn tệ hơn vô dụng:

- **Desktop shell** ngoài phạm vi mà typed IPC bridge của nó cung cấp: bộ test trình duyệt
  chứng minh nhánh của client khi có hộp thoại chọn thư mục, không phải một bản build Electron.
- **OAuth** chạy thật, **Google Calendar**, **MCP streamable-HTTP client transport** để kết nối
  tới các MCP server bên ngoài (stdio đã được xây và test; endpoint `/mcp` của chính node được
  nêu ở trên), và **native driver cho macOS/Linux**. Contract, state machine và các lời từ chối
  của chúng đã được triển khai và test; các transport đó thì chưa.
- **Tải artifact thật cho nguồn cài `git`/`npm`.** `/packages/install` resolve, lock và kích
  hoạt một package `local` end-to-end (byte đã có trên đĩa; xem
  `apps/runtime/test/package-install-local-chain.spec.ts`), vì bước xác minh là `digest-only`
  và không có gì để tải. Một nguồn remote vẫn bị từ chối trước điểm đó — transport biến một mục
  `git`/`npm` đã resolve thành byte trên node này chưa tồn tại.
- **Một luồng consent thật cấp dữ liệu cho `grantedCapabilities`.** Route cài đặt công khai
  không còn tin một grant do client khai báo trong request body (một grant giả mạo không thể
  trở thành thẩm quyền; xem `apps/runtime/test/package-install-route.spec.ts`) — thay vào đó nó
  fail closed với tập grant rỗng. Vì vậy một package vừa cài sẽ được kích hoạt nhưng không đăng
  ký capability nào mà một task được điều phối có thể dùng; chỗ nối đó được xác định chính xác
  và đặt tên trong `apps/runtime/src/application/package-install.ts`, chứ không âm thầm thiếu.
- **Vòng đời cài đặt và capability** trong giao diện: các thẻ được render và các lời từ chối là
  trung thực, nhưng chưa có lần cài nào được chạy end-to-end từ trình duyệt.

## Yêu cầu

- Node.js 22.19 trở lên (khuyến nghị 24; runtime thực thi TypeScript trực tiếp)
- pnpm 12 qua Corepack

Các tính năng cốt lõi không cần native module: SQLite đến từ `node:sqlite` có sẵn trong Node.

Semantic search là ngoại lệ duy nhất, và nó là tùy chọn. Khi `sqlite-vec` và local embedding
runtime đã được cài, lịch sử có thể được index thành vector và kết hợp với kết quả lexical bằng
reciprocal rank fusion; khi chúng chưa được cài, node tìm kiếm theo lexical và báo lý do. Không
thành phần nào là bắt buộc để cài, khởi động hay vượt qua bộ test — xem "Turning semantic search
on, and when not to" trong `docs/mini-app/jev-configuration.vi.md`.

## Bắt đầu

Cách nhanh nhất là dùng trình cài đặt. Nó kiểm tra máy, clone repository và chạy phần
onboarding tương tác (model, key, thư mục dữ liệu, chạy local hoặc Docker):

```bash
curl -fsSL https://raw.githubusercontent.com/digitopvn/clarkcant/main/tools/install.sh | sh   # macOS / Linux
irm https://raw.githubusercontent.com/digitopvn/clarkcant/main/tools/install.ps1 | iex          # Windows PowerShell
node tools/setup.mjs                                                                          # from a checkout
```

[`docs/installation.vi.md`](docs/installation.vi.md) bao quát mọi nền tảng, Docker, VPS có
HTTPS, cài đặt không tương tác và xử lý sự cố. Cài thủ công:

```bash
corepack enable
pnpm install
pnpm verify                 # invariants, typecheck, lint and the full test suite
node apps/runtime/src/main.ts --data-dir ./.data --label dev
```

Node in identity của nó khi khởi động. Các command yêu cầu bearer token nằm trong
`./.data/identity.json`.

```bash
# /health, /openapi.json and /.well-known/clarkcant.json are unauthenticated; everything else needs the token.
curl -s -H "authorization: Bearer $(node -e 'console.log(require("./.data/identity.json").localToken)')" \
  http://127.0.0.1:8765/health
```

Hoặc dùng CLI, công cụ tự tìm token trong thư mục dữ liệu:

```bash
pnpm clarkcant status --data-dir ./.data
pnpm clarkcant ask "what can you do?" --data-dir ./.data
```

Chạy probe vòng đời SDK P0.1:

```bash
node packages/pi-adapter/src/probe-cli.ts            # report to stderr
node packages/pi-adapter/src/probe-cli.ts --json     # machine-readable
node packages/pi-adapter/src/probe-cli.ts --write    # refresh docs/research/compatibility-lock.md
```

## Bố cục

```text
apps/        runtime (headless node), web, desktop, worker, cli
packages/    contracts, storage, core, pi-adapter, node-link, capability-host,
             integration-sdk, widget-sdk, widget-host, mcp-adapters, host-adapters,
             execution-supervisor, voice-adapters, conversation-client, design-tokens
packs/       project-work, data-canvas, browser-playwright, computer-macos,
             computer-linux-desktop, google-calendar
examples/    note-widget, media-widget-contract, mcp-app-fixture
docs/        the blueprint, the compatibility lock, and the conformance ledger
```

Mỗi workspace package khai báo `clarkcant.phase` và `clarkcant.status` trong `package.json`,
nên mọi file đều có thể truy ngược về milestone sở hữu nó. `phase` là milestone sở hữu package;
`status` là tuyên bố ở cấp package về code của chính package đó, và nhận một trong ba giá trị.
`implemented` — code đó đã được viết và được kiểm chứng bằng test trong repository này. `stub` —
package vẫn còn nợ code của chính nó, và không có gì bên ngoài repository này đang cản công việc
đó. `external-blocked` — package vẫn còn nợ công việc không thể hoàn thành hay kiểm chứng tại đây,
vì nó chờ một thứ bên ngoài repository: một tài khoản, một signing identity, một service hoặc
thiết bị mà máy này không có, hoặc một host thứ hai — chính là gate mà mục registry mang khoảng
trống đó nêu tên trong `externalGate` (#2, #3, #4 và #5 là các gate mà chương trình này vẫn để
mở). Giá trị này thô hơn trạng thái của một capability trong
[`IMPLEMENTATION_STATUS`](packages/contracts/src/implementation-status.ts): một package có thể
mang nhiều mục ở các trạng thái khác nhau, và sự phân tách nằm ở các mục đó. Hai giá trị được
phân biệt theo mục đích của chính package chứ không theo việc có một gate ở đâu đó bên trong: một
package là `external-blocked` khi công việc mà mục đích của nó phụ thuộc không thể hoàn thành hay
kiểm chứng tại đây, nên không thứ gì nó cung cấp có thể được chạy thử trên máy này
(`packs/google-calendar`, `packages/node-link`), còn một package đồng thời cung cấp code mà
repository này chạy và test thì vẫn là `implemented` ngay cả khi một capability nó mang chưa hoàn
chỉnh — sự chưa hoàn chỉnh đó được nêu trong mục registry, không phải trong manifest
(`packages/integration-sdk`, `packages/widget-cli`). `pnpm invariants` đảm bảo trường này có mặt
và dùng đúng bộ từ vựng, cùng với hash trong manifest tài liệu, việc không có credential bị
commit, các dependency specifier được ghim, và cú pháp TypeScript mà loader type-stripping của
Node không thể thực thi.

## Các quyết định thiết kế nên biết

- **Contract được xác thực lúc runtime, không chỉ được định kiểu.** Chúng đi qua ranh giới
  tiến trình, node và bản phát hành, nơi một kiểu compile-time không còn là bằng chứng.
- **SQLite không phụ thuộc.** `node:sqlite` tránh một dependency phải biên dịch trong tầng
  storage, điều quan trọng với câu chuyện supply-chain.
- **Chính sách supply-chain nằm trong `pnpm-workspace.yaml`.** pnpm 12 đọc các thiết lập bảo
  mật ở đó, không phải từ `.npmrc`: tuổi phát hành tối thiểu 24 giờ, chặn sub-dependency lạ, và
  một danh sách `allowBuilds` tường minh để không package nào chạy lifecycle script mà chưa được
  review.
- **Bước từ "đã cài" sang "dùng được" là tường minh.** `installed`, `loaded`, `authenticated`,
  `authorized` và `healthy` là các sự kiện riêng biệt, vì "package đã cài" và "integration hoạt
  động" là hai tuyên bố khác nhau.
- **Sự không chắc chắn là một trạng thái nghỉ.** `unknown` không bao giờ bị retry thành
  `failed` hay `succeeded`; nó chờ được quan sát.

## Tài liệu

Định hướng UI/UX nằm trong [DESIGN.vi.md](DESIGN.vi.md), quy trình dành cho agent nằm trong
[AGENTS.md](AGENTS.md). Attachments có bằng chứng tại [browser tests](apps/web/e2e/attachments.spec.ts)
và [runtime tests](apps/runtime/test/attachment-in-turn.spec.ts); không suy ra các giai đoạn
voice/action parity hay compact desktop đã hoàn tất từ phần attachments.

Đọc theo thứ tự: [`docs/scope-lock.vi.md`](docs/scope-lock.vi.md),
[`docs/system-architecture.vi.md`](docs/system-architecture.vi.md),
[`docs/conformance-traceability.md`](docs/conformance-traceability.md). Toàn bộ blueprint bắt
đầu tại [`docs/README.vi.md`](docs/README.vi.md).

## Giấy phép

Apache-2.0. Xem [`LICENSE`](LICENSE).

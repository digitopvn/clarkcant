# Kongming — chiến lược: seam model→block, voice, thứ tự triển khai

**Ngày:** 2026-09-16 · **Repo:** `/Volumes/GOON/www/digitop/clarkcant` · **Commit nền:** `54b978a`
**Câu hỏi:** (A) seam model→block nên là tool call, text protocol hay cách khác; (B) kiến trúc voice để API key không tới browser; (C) thứ tự 11 task ít rủi ro nhất.
**Trạng thái:** tư vấn, không sửa code.

---

## 0. TL;DR

1. **(A) Chọn (a) tool call — nhưng không phải "model phát ra block". Model xin một *view*, host dựng *block*.** Một tool duy nhất `show_view({view, props, caption})`, không có `type: "system-card"` ở đâu trong schema tham số. Model không bao giờ chạm vào từ vựng host-owned, nên rủi ro "model bịa card nói dối về trạng thái hệ thống" bị đóng bằng cấu trúc, không bằng niềm tin.
2. **Việc đầu tiên không phải cái seam, mà là cái gate.** `prepareBlocksForRender` (drop block host-owned từ nguồn không phải host) và `maxSurfaceBytes` **đã có code, đã có test, và chưa được nối vào đường render nào cả**. Comment ở `blocks.tsx:5-9` tuyên bố renderer từ chối card không do host dựng — điều đó hiện **không đúng**. Nối gate trước, rồi mới mở seam.
3. **(B) Proxy WebSocket ở node là mặc định; ephemeral token của Google là tối ưu hoá làm sau, sau cùng một seam.** Seam `VoiceProviderAdapter.connect({ tokenProvider })` đã có sẵn chỗ cho cả hai, nên đổi về sau không phải viết lại state machine/transcript/media focus.
4. **(C) Thứ tự: gate + trust → seam model→view → Settings modal/theme (đi cùng nhau) → onboarding → voice → PR.** Lý do duy nhất và đủ: mọi thứ phía sau đọc `ModelTurnReply` và shape của message; làm seam sau cùng là viết lại UI hai lần.

---

## 1. Reframe

Câu hỏi thật không phải "truyền block từ model sang UI bằng kênh nào", mà là: **ở đâu có một chỗ duy nhất mà một giá trị do model sinh ra trở thành một block, và cái gì từ chối nó.**

Ba yêu cầu ràng buộc câu trả lời:

- **R1** Model phải làm được card/widget hiện trong câu trả lời, xen giữa text.
- **R2** Model không bao giờ tạo được block host-owned (10 type trong `HOST_OWNED_BLOCK_TYPES`).
- **R3** Test được **không cần model thật** — CI không có provider account, và `live-model-completion` đang là **BLOCKED** trong `docs/research/compatibility-lock.md`.
- **R4** Một gate bị chặn phải ghi là `blocked`, không đổi tên. Card nói về hệ thống do host dựng, không do model.

Non-goal: streaming SSE. Hiện `POST /conversations/:id/messages` trả **cả timeline một lần** (`apps/runtime/src/gateway.ts:246`), không stream. Nên "card xuất hiện giữa dòng" trong PR này là **bài toán thứ tự block**, không phải bài toán streaming.

---

## 2. Bằng chứng đã đọc (A)

| Sự kiện | Chỗ | Ý nghĩa |
|---|---|---|
| `prepareBlocksForRender()` drop block host-owned khi `builtByHost: false`, và đã **có test** | `packages/widget-host/src/index.ts:203-231`, test `packages/widget-host/test/seams.spec.ts:531-541` | Cơ chế đúng của blueprint đã tồn tại và đã được kiểm chứng |
| Nó **không được gọi ở đâu trong production** | `grep prepareBlocksForRender` chỉ ra `widget-host/src` + test | Gate chưa nối |
| Client render thẳng | `packages/conversation-client/src/Conversation.tsx:296,300`: `message.blocks.map((block, i) => renderBlock(block, i, renderSurface))` | Không có tham số provenance nào |
| `renderBlock` chỉ switch theo `block.type` (string) | `packages/conversation-client/src/blocks.tsx:574-631` | Không phân biệt nguồn |
| Comment nói ngược lại | `blocks.tsx:5-9` | **Tuyên bố sai**, phải sửa |
| `maxSurfaceBytes` **không được truyền ở production** | xuất hiện chỉ ở `surfaces.ts:483`, test `contracts.spec.ts:633`, `seams.spec.ts:539` | Trần kích thước snapshot hiện **không được thực thi** |
| Storage không validate block | `packages/storage/src/repositories.ts:731-747` (`toJson`) và `:759` (`parseJson<MessageRecord>` assert type) | Không có lưới nào ở tầng ghi |
| `assertBlockProvenance()` có, có test, **không ai gọi** | `packages/contracts/src/surfaces.ts:446-461`; test `contracts/test/contracts.spec.ts:617` | Một nửa của gate đang nằm im |
| `registerTool` **đã implement thật** ở cả hai adapter | `packages/pi-adapter/src/real.ts:247-276`, `fake.ts:77-86` | Kênh tool call không phải làm mới |
| `FakePiAdapter.callTool(sessionId, toolName, params)` **đã có**, emit `tool-start`/`tool-end` | `packages/pi-adapter/src/fake.ts:174-191` | Test double cho tool call đã tồn tại |
| `ToolDefinition.parameters` là JSON Schema; `typebox@1.3.31` **đã là dependency** | `pi-adapter/src/types.ts:45-51`, `pi-adapter/package.json:25` | Không cần cast `as never` nếu dùng TypeBox thật |
| `RealPiAdapter` cast `parameters as never` | `real.ts:261-275` | Cast đã **chưa bao giờ được chạy thật** |
| Probe **không** đăng ký/không gọi tool nào | `grep -n tool packages/pi-adapter/src/probe-cli.ts` → chỉ có `tools: [...READ_ONLY_TOOLS]` ở :133 | |
| Comment nói probe có chạy | `real.ts:255-259` ("The P0.1 probe exercises registration and invocation") | **Tuyên bố sai thứ hai**, phải sửa hoặc phải làm cho nó đúng |
| `model-turn.ts` không nhận adapter injection | `apps/runtime/src/model-turn.ts:61` hardcode `new RealPiAdapter(...)` | Không test được nếu không thêm seam |
| `model-turn.ts` throw khi text rỗng | `model-turn.ts:139-143` | Reply chỉ có card sẽ **bị coi là lỗi** |
| `buffer: string[]` chỉ gom text-delta | `model-turn.ts:34,109-111` | Không có chỗ cho thứ tự |
| Conductor append 1 message nhiều block | `packages/core/src/conductor.ts:352-378` | Đã hỗ trợ xen kẽ trong một message |
| Conductor test được bằng `respondWithModel` inject | `apps/runtime/test/j1-journey.spec.ts:276-306` | Nửa conductor dễ test |
| `TextBlock` render text trần, `white-space: pre-wrap`, không markdown, không HTML | `blocks.tsx:17-25` | Hôm nay text của model là **trơ** — chưa có lỗ injection HTML |
| `format: "markdown"` được khai nhưng render như text thường | `conductor.ts:367` vs `blocks.tsx:17-25` | `format` hiện là trang trí |

---

## 3. A — Trả lời

### 3.1 Chọn gì

**(a) tool call, với từ vựng (c): model xin *view*, host dựng *block*.**

Tên tool không phải `emit_card`/`emit_block`. Model **không bao giờ phát ra block** — nó phát ra một yêu cầu hiển thị, và host là bên duy nhất dựng block. Tên đề xuất: `show_view`.

Tham số (JSON Schema, dựng bằng TypeBox để không phải cast):

```
view:   enum — CHỈ gồm các renderer đã có thật trong catalog
props:  object — props cho view đó
caption: string ngắn
```

Hôm nay catalog chỉ có 5 renderer (`renderers.tsx`: line, bar, donut→bar, table, note), nên `enum` hôm nay có 4–5 giá trị. **Không có `type`, không có `owner`, không có `cardId`, không có `status` ở đâu trong schema tham số.** Đó là toàn bộ điểm mấu chốt: không thể bịa một `system-card` nếu từ vựng không có từ "system-card".

### 3.2 Vì sao không phải (b) text protocol

Ba lý do, xếp theo mức nghiêm trọng:

1. **Prompt injection biến model thành confused deputy.** Nội dung model đọc (một trang web qua browser driver, một file trong repo, một message từ node khác) có thể chứa đúng cái fence. Khi đó "card trong câu trả lời" không còn do model viết — nó do kẻ tấn công viết, qua model. Với (a), kẻ tấn công chèn được cũng chỉ gọi được `show_view` với vài props đã validate; không có đường nào tới `status: "blocked"` hay `data-owner="host"`.
2. **Parse prose là nơi bug ẩn.** ```json vs ```clarkcant, fence chưa đóng khi stream, dấu ngoặc lồng trong string, và một câu trả lời *giải thích về* protocol sẽ tự parse thành card. Mỗi trường hợp là một nhánh test, và mỗi nhánh là một cách sai.
3. **Không có schema phía provider.** Với tool call, SDK/tool schema cho model phản hồi về việc gọi sai. Với text protocol, model viết sai thì runtime im lặng bỏ, và người dùng chỉ thấy "model nói sẽ hiện chart" mà không có chart.

Và một điểm làm (b) trở thành lựa chọn dở về kiến trúc: **để (b) an toàn, bạn vẫn phải viết đúng cái rejection theo type ở cuối parser — tức là bạn vừa xây (a) với một parser tệ hơn.** (b) không tiết kiệm được gì.

### 3.3 Vì sao không phải "để model xuất JSON thuần"

Phá câu trả lời hội thoại. Loại.

### 3.4 Chỗ "model xin view, host dựng block" mua được gì thêm

Nếu host là bên dựng block, host cũng là bên có thể **từ chối trung thực**:

- Model xin `view` không có trong catalog → tool trả text nói rõ `"view X is not on this node"`, host không dựng gì. Model thấy text đó **trong cùng lượt** và tự sửa.
- Props sai `validateProps` → như trên.
- Dữ liệu do model cung cấp → snapshot phải mang freshness `sample`/`model-provided`, **không bao giờ** `live`. Host là bên dán nhãn, không phải model. Đây chính là gate "blocked phải ghi là blocked" áp vào freshness.
- Model xin một view cần capability node không có → host dựng `system-card` **host-built** với `status: "blocked"` và `blockedReason`, và tool trả cùng nội dung đó cho model, để prose và card khớp nhau.

### 3.5 Thứ tự block trong câu trả lời

Thay `buffer: string[]` bằng danh sách segment có thứ tự:

```
segments: Array<{ kind: "text"; text: string } | { kind: "block"; block: MessageBlock }>
```

- `text-delta` → nối vào segment text đang mở.
- `tool-start` với `toolName === "show_view"` → **flush** segment text đang mở thành một block `text`, rồi chèn block mới. (`tool-start` bắn lúc bắt đầu execute, tức là sau khi model đã phát hết text trước lời gọi — nên đây đúng là điểm chèn.)
- `tool-end` → mở lại segment text.
- Cuối lượt → trim text run cuối, bỏ segment text rỗng.

**Đừng làm cách ngây thơ**: nối hết text rồi đẩy hết card xuống cuối message. Nó mất vị trí, và khi SSE được thêm sau này thì phải viết lại. Danh sách segment hôm nay là thứ tự render, ngày mai là thứ tự stream — cùng một cấu trúc.

### 3.6 Test không cần model thật

Đây là lợi thế lớn nhất của (a) mà repo **đã trả tiền sẵn**:

1. Thêm `adapter?: PiAdapter` vào `createModelTurn(options)` (`model-turn.ts:53`), mặc định `RealPiAdapter`. Đây là seam bắt buộc — hiện tại `model-turn.ts` là file duy nhất của đường model mà **không có một test nào**.
2. `FakePiAdapter.callTool()` đã tồn tại. Mở rộng `run()` để script có bước gọi tool (hoặc thêm option `steps`). Thay đổi nhỏ, trong repo.
3. Test vitest: script `text → callTool("show_view", {view, props}) → text` → assert `ModelTurnReply.blocks` đúng thứ tự, và assert `system-card` bị **từ chối** khi model thử gọi.
4. Nửa conductor test bằng `respondWithModel` inject như `j1-journey.spec.ts:276` đang làm: reply có `blocks` → message phải có `[system-card host-built, ...blocks]`.
5. Không test nào cần provider account. CI xanh như hôm nay.

### 3.7 Hai tuyên bố sai phải sửa (không phải optional)

Repo này vận hành trên nguyên tắc "blocked phải ghi là blocked". Hai comment dưới đây nói ngược lại sự thật, và cả hai đều nằm trên đường đi của item này:

1. `packages/conversation-client/src/blocks.tsx:5-9` — "the renderer refuses to draw one that did not come from the host". `renderBlock` không có tham số provenance. **Sai.**
2. `packages/pi-adapter/src/real.ts:255-259` — "The P0.1 probe exercises registration and invocation to keep this cast honest". `probe-cli.ts` không đăng ký, không gọi tool nào; `live-model-completion` là BLOCKED. **Sai.** Cách sửa đúng là *làm cho nó đúng*: thêm step probe `custom-tool-registration` (chắc chắn chạy được, không cần account) và ghi `custom-tool-invocation-by-model` là **BLOCKED** với điều kiện mở, đúng như `live-model-completion`.

Một reviewer đọc PR này sẽ tìm hai chỗ đó. Sửa trước khi mở PR thì rẻ hơn nhiều so với bị hỏi.

---

## 4. A — Kế hoạch thực thi

1. **Gate hai tầng, trước tiên.**
   - Tầng ghi: hàm mới `acceptModelBlocks(input: unknown)` trong `packages/contracts/src/surfaces.ts`, cạnh `assertBlockProvenance`: `messageBlockSchema.safeParse` từng phần tử + từ chối `isHostOwnedBlock` + trần số block (đề xuất 8). Trả `{ok, blocks} | {ok:false, reason}`. Runtime gọi nó trong `execute` — **trước khi** giá trị trở thành block.
   - Tầng đọc: nối `prepareBlocksForRender` (từ `@clarkcant/widget-host`, không có import `node:*`, browser-safe) vào `Conversation.tsx`. `renderBlock` nhận thêm tham số `builtByHost: boolean`; `false` thì drop các type host-owned. Điều này đồng thời thực thi `maxSurfaceBytes` — trần đang bị coi là có mà thực tế không có.
   - Thêm `@clarkcant/widget-host` vào deps của `conversation-client`. Không cycle (`widget-host` chỉ phụ thuộc contracts/design-tokens/widget-sdk/zod).
   - Nguồn của `builtByHost`: đừng suy từ `authorNodeId` — một card hợp lệ từ node khác sẽ bị drop oan. Dùng cờ tường minh trên message (field optional mới trong `messageRecordSchema`, zod optional để document cũ vẫn parse được), do node stamp.
2. **Đổi `ToolDefinition` + adapter.** Dùng TypeBox thật cho `parameters` để bỏ `as never`. `execute` nhận `params: unknown` và validate phòng thủ (nếu là string thì `JSON.parse` có trần kích thước) — vì cast hiện tại chưa bao giờ được chạy, hình dạng thật của `params` là **chưa biết**.
3. **`show_view` + host dựng block.** Handler: tra catalog → `validateProps` → `createInstance` → `captureSnapshot` → dựng `surface` (+ `widget-ref` nếu cần) **bằng đúng code path của `runSampleRecipe`** (`conductor.ts:381+`), không viết đường thứ hai. Gắn nhãn freshness khi dữ liệu do model cung cấp.
4. **`model-turn.ts`**: `segments` thay `buffer`; `registerTool` một lần trong `turnFor` (nó throw nếu đăng ký trùng — đúng, giữ nguyên); thêm `adapter?` injection; sửa guard rỗng thành `text === "" && blocks.length === 0`; cập nhật header comment: lượt hội thoại **vẫn** không có tool chạm vào bất cứ thứ gì — `builtinTools: []` và `allowedCapabilityRefs: []` không đổi, và `show_view` là kênh xuất thuần trong bộ nhớ, không I/O. Viết đúng câu đó, vì nếu không thì trông như đang phá chính sách đã tuyên bố của file.
5. **`ModelTurnReply`**: thêm `blocks?: MessageBlock[]`. Optional để 3 test hiện có ở `j1-journey.spec.ts` vẫn compile và vẫn đúng nghĩa.
6. **Conductor**: `runModelTurn` append `[system-card(model-turn, host-built), ...blocks]`; khi `blocks` vắng thì giữ `[{type:"text", format, content: reply.text}]` như hôm nay. Card host vẫn **đứng đầu** và vẫn là thứ duy nhất nói provider/model/thời gian.
7. **Probe**: thêm step `custom-tool-registration` (PASS được ngay, không cần account) và `custom-tool-invocation-by-model` (**BLOCKED**, điều kiện mở: chạy `pnpm probe:pi -- --live` với credential). Sửa comment ở `real.ts`.

---

## 5. B — Voice: API key không tới browser

### Sự kiện đã đọc

- `LiveVoiceAdapter` là stub, provider `"gpt-live"`, `connect()` throw (milestone P9). `packages/voice-adapters/src/index.ts:198-244`.
- Seam đã có chỗ cho cả hai hướng: `connect(input: { sessionId; tokenProvider: () => Promise<string> })` (`voice-adapters/src/index.ts:31`). State machine, transcript assembly, media focus, mute/end semantics **đã implement và đã test**.
- Blueprint **đã chốt** "GPT-Live adapter đầu tiên" (`docs/scope-lock.md:36`). Đổi sang Gemini Live là **đổi một quyết định đã ghi**, nên phải ghi vào `docs/research-and-decisions.md` như một deviation, không phải im lặng thay.
- Runtime và web **không có** dependency `ws`; server là `node:http createServer` (`apps/runtime/src/main.ts:90`).
- Browser **đã** giữ bearer token của node trong `sessionStorage`, nạp từ `?token=` trên URL (`apps/web/src/App.tsx:14-26`). Token node có **toàn quyền**, không phải token scoped.

### Hai kiến trúc

**B1 — Node proxy WebSocket.** Browser mở `ws://127.0.0.1:<port>/voice`, node xác thực bằng đúng bearer check hiện có, rồi mở `wss` lên Google với API key nằm ở phía node, và relay frame hai chiều (Gemini Live dùng JSON frame, audio base64 trong JSON — nên không phải tự parse binary framing, chỉ relay text frame).

- Phức tạp thật: `node:http` **không** có WebSocket upgrade sẵn. Phải tự cài RFC 6455 (accept key SHA-1, unmask frame client→server, ping/pong, close) — khoảng 150–250 dòng thuộc đúng loại code hay có bug tinh vi. **Cách rẻ hơn: thêm `ws` (đã được kiểm chứng, phủ cả server và client upstream), pinned.** Repo đã có invariant bắt pin mọi specifier, nên đây là một quyết định supply-chain một dòng, không phải một dự án.
- Chi phí: thêm **một hop loopback** cho mỗi frame audio (dưới 1ms) + một core phần trăm CPU. Không đáng kể.
- Được: key không bao giờ rời node; node giữ được policy, redaction, metering, budget — đúng những gì V18 và các rule telemetry-redaction/resource-budget muốn; browser không cần credential thứ hai; cùng route đó phục vụ luôn desktop shell.

**B2 — Ephemeral token của Google.** Node gọi `AuthTokenService.CreateToken` với API key, nhận token dùng-một-lần TTL ngắn, đưa token đó cho browser qua route gateway đã xác thực; browser nối **thẳng** tới `wss://generativelanguage.googleapis.com/...BidiGenerateContent` không qua node.

- Phức tạp: ~40 dòng (`fetch` + route + timer refresh) + client Live phía browser (cần **cả hai** cách). Không có WS server trong node, không hop thêm, latency thấp nhất.
- Rủi ro: token lộ = một phiên Live dùng quota của operator trong TTL, **không có node nào nhìn thấy**. Endpoint là `v1alpha` — version-skew là rủi ro thường trực. Và tôi **chưa xác minh được** (không có web access trong lượt này) rằng đường ephemeral token hiện vẫn tồn tại và vẫn dùng được cho các Live model hiện tại; đây là thứ phải kiểm tra trước khi cam kết.

### Khuyến nghị

**B1 là mặc định. B2 để sau, sau cùng một seam.** Bốn lý do: (i) nó dùng lại đúng mô hình tin cậy đang có (gateway loopback + bearer) thay vì thêm một mô hình thứ hai; (ii) nó không phụ thuộc vào một endpoint `v1alpha` còn tồn tại hay không; (iii) nó là cách duy nhất giữ node trong đường đi để V18 redaction/budget có nghĩa; (iv) `prepareBlocksForRender`-style: seam `tokenProvider` **đã** cho phép thay transport sau này mà không đụng state machine, transcript, media focus, hay UI. Nghĩa là chọn B1 không khoá đường tới B2.

**Chi tiết dễ làm sai:** WebSocket handshake của browser **không set được header tuỳ ý**. Đừng đặt bearer token vào query string — nó lọt vào log và `Referer`. Mint một **ticket dùng một lần** qua route HTTP đã xác thực, rồi chỉ đặt ticket trong query string (hoặc dùng `Sec-WebSocket-Protocol`). Chi phí nhỏ, đóng một rò rỉ thật.

**Về "Gemini 3.8 Live":** tôi không xác minh được định danh model đó (không có web access ở lượt này). Đừng để một tên viết tay đi vào code — resolve nó qua catalogue của provider và **pin** đúng id đã chạy được, giống cách `#resolveModel` đang từ chối provider/model không tồn tại bằng tên (`real.ts:126-146`).

**Khuyến nghị về phạm vi:** voice là item duy nhất (1) đổi một quyết định đã ghi trong blueprint, (2) cần provider account có Live access — hiện là gate BLOCKED, (3) không thể accept mà không có một phiên live thật. Nếu phải cắt, cắt cái này. Nếu vẫn làm trong đợt này: dựng transport với **fake upstream WS server trong test**, và ghi gate live là **blocked** — đúng như repo đang làm với `live-model-completion`. Làm vậy thì PR vẫn thật và repo vẫn không nói dối.

---

## 6. C — Thứ tự

**Giả định:** danh sách 11 task **không nằm trong repo** (work list "item 6, group N" chỉ xuất hiện trong message commit, không có file). Tôi suy ra thứ tự từ 6 deliverable đã nêu, và nguyên tắc áp dụng cho 5 task còn lại là: **cái gì định hình shape dữ liệu thì trước; cái gì chỉ tiêu thụ shape đó thì sau.**

| # | Việc | Vì sao ở đây |
|---|---|---|
| 0 | Gate hai tầng + sửa 2 comment sai + bước probe | Rẻ, test được ngay, là nơi reviewer đọc đầu tiên. Mở seam **trước** khi có gate là ship đúng cái lỗ mà blueprint sợ nhất. |
| 1 | Seam model→view end-to-end (+ fake adapter, + `ModelTurnReply.blocks`) | Rủi ro cao nhất **và** định hình dữ liệu nhiều nhất. Settings/theme/onboarding không phụ thuộc nó, nhưng nếu làm sau thì chúng được viết trên shape sẽ đổi → viết lại hai lần. |
| 2 | Settings modal 4 tab | Phần lớn là refactor của `SettingsPanel` (drawer, 383 dòng) + `Modal` (đã có, đã xử lý Escape/scrim/focus-return) đã tồn tại. Một tab tự nhiên là "Model/Agent" hiển thị `selection`, `budget`, và từ vựng view **thật** — nên sau #1 thì tab đó có dữ liệu thật để hiển thị, không phải placeholder. |
| 3 | Light/system theme | Đi cùng #2 vì Settings sở hữu control. |
| 4 | Onboarding | Cần #1: một onboarding kết thúc bằng câu trả lời thật kèm card mới là onboarding thật. |
| 5 | Voice | Item duy nhất đổi quyết định đã ghi và cần account ngoài. Cuối cùng. |
| 6 | PR | Xem bên dưới. |

### Chi tiết ở #3 mà dễ bị bỏ sót (đã kiểm trong code)

- **`data-cc-theme="system"` sẽ làm hỏng toàn bộ UI.** `tokensToCss` phát `:root[data-cc-theme="dark"]` và `:root[data-cc-theme="light"]` (`packages/design-tokens/src/css.ts:83`). Không có rule mặc định nào khi attribute vắng. Đặt giá trị thứ ba → **không rule nào khớp → mọi token undefined.** Cách đúng: `data-cc-theme` **luôn** nhận `dark|light` đã resolve; "system" là **preference** được lưu riêng, resolve qua `matchMedia` + listener. Đừng thêm nhánh `@media` thứ ba.
- **Preference hôm nay không tồn tại, và theme bị hardcode hai chỗ.** `apps/web/src/App.tsx:14` gọi `installStyles("dark")` ở module scope; `Conversation.tsx:67` có `useState<"dark"|"light">("dark")`. Gộp thành một nguồn duy nhất, đọc preference + `matchMedia` **trước first paint**, nếu không sẽ nháy dark trên hệ thống sáng. Lưu preference ở `localStorage` — theme không phải credential, khác với token được cố tình để trong `sessionStorage`.
- **Orb sẽ sai màu sau khi đổi theme.** `readCanvasColor()` đọc `--cc-canvas` **một lần trong effect lúc mount** (`packages/conversation-client/src/Orb.tsx:56-61`). Đổi theme lúc runtime → orb giữ màu canvas cũ → một hình chữ nhật lộ ra trên nền sáng. Đây là bug thật đang nằm sẵn trong item theme; phải đọc lại khi theme đổi.

### Về PR

11 task trong một PR là vấn đề reviewability, không phải vấn đề kỹ thuật. Commit log hiện tại đã cho thấy nhóm commit theo concern ("item 6, group 3a/3b") — giữ đúng cách đó. Khuyến nghị **3 PR**: (P1) gate + seam, (P2) UI surfaces settings/theme/onboarding, (P3) voice. Nếu buộc một PR: mở **draft PR ngay sau #1** để reviewer thấy câu chuyện trust sớm, và giữ ít nhất 3 nhóm commit.

**Trạng thái working tree:** 6 file PNG evidence đang modified chưa stage (`plans/reports/evidence/j1-0*.png`). Quyết định dứt khoát trước khi mở PR — commit lại (screenshot được regenerate) hay revert. Đừng để chúng lẫn vào diff của seam.

---

## 7. Cần tránh

- **Đừng để model chạm vào từ vựng host-owned, dù chỉ trong schema tham số.** Một `type` enum có `"system-card"` trong đó là đủ để model thử.
- **Đừng nối gate ở client mà bỏ gate ở tầng ghi, và ngược lại.** Tầng ghi bảo vệ timeline khỏi dữ liệu rác vĩnh viễn; tầng đọc bảo vệ khỏi node khác và khỏi DB đã bị ghi rác từ trước.
- **Đừng suy `builtByHost` từ `authorNodeId`.** Sẽ drop oan card hợp lệ của node khác (ví dụ `reconnect-card`).
- **Đừng render markdown trong đợt này.** `TextBlock` đang render text trơ (`white-space: pre-wrap`). `format: "markdown"` hiện là trang trí. Thêm một markdown lib là mở đường HTML injection đúng lúc bạn đang mở một kênh do model điều khiển. Nếu muốn nhất quán, đổi giá trị `format` cho khớp thực tế, đừng thêm renderer.
- **Đừng để trần `maxSurfaceBytes` tiếp tục chỉ tồn tại trong signature hàm.** Nó được truyền ở đúng 0 chỗ trong production.
- **Đừng viết đường `createInstance`/`captureSnapshot` thứ hai cho model.** `runSampleRecipe` đã làm đúng việc đó.
- **Đừng để `validateProps` là lưới duy nhất cho props do model cung cấp.** Nó là subset shallow (`string`/`number`/`maxLength`/`required`/`additionalProperties`), **không** validate array/object lồng nhau. Nếu model được cấp `rows`, phải có validate theo hàng + trần số hàng. Một mảng `rows` không giới hạn từ model là payload đi thẳng vào timeline.
- **Đừng đặt bearer token vào query string của WebSocket.**
- **Đừng đổi provider voice im lặng.** Blueprint đã chốt GPT-Live; ghi deviation.
- **Đừng tin tuyên bố trong comment khi cast chưa được chạy.** `parameters as never` và hình dạng `params` thật của `defineTool` là **chưa biết** cho tới khi probe gọi được tool.

---

## 8. Success metrics

| Metric | Cách đo | Ngưỡng |
|---|---|---|
| Model không tạo được host card | test: model script gọi `show_view` với `type:"system-card"` trong props → không block nào được thêm, message vẫn có đúng 1 host card | 0 block host-owned từ đường model |
| Gate ở tầng đọc có thật | test: timeline chứa `system-card` với `builtByHost:false` → DOM không có `[data-host-card="system"][data-owner="host"]` | drop, có đếm |
| Trần snapshot được thực thi | test: snapshot > ngưỡng → degrade thành `text` | có hiệu lực |
| Thứ tự block đúng | test: `text → tool → text` → `[text, surface, text]` theo đúng thứ tự đó | khớp |
| Test được không cần provider | `pnpm test` xanh, 0 test cần account | 100% |
| Probe trung thực | `docs/research/compatibility-lock.md`: `custom-tool-registration` PASS, `custom-tool-invocation-by-model` ghi **BLOCKED** + điều kiện mở | không có step nào bị đổi tên |
| Theme system không làm vỡ UI | e2e: đặt preference `system`, ép `prefers-color-scheme: light` → `--cc-canvas` resolve được, orb đúng nền | không có token undefined |
| Reviewer đọc được | P1 là PR riêng, gate và seam trong cùng một PR để câu chuyện trust liền mạch | — |

---

## 9. Assumptions

| Giả định | Độ tin cậy | Điều gì làm đổi câu trả lời |
|---|---|---|
| Danh sách 11 task không nằm trong repo; tôi suy thứ tự từ 6 deliverable đã nêu | **cao** — đã grep `docs/` và `plans/`, chỉ thấy nhắc "work list không nằm trong repo" trong `plans/reports/review-260916-1813-docs-vs-codebase-coverage.md:200` | Có file work list thật thì thứ tự cụ thể có thể khác, nhưng nguyên tắc "shape trước, tiêu thụ sau" không đổi |
| Pi SDK **thực sự** gọi được custom tool với JSON-Schema params | **trung bình** — `defineTool` có trong `REQUIRED_SDK_EXPORTS` và `registerTool` đã implement, nhưng probe **chưa bao giờ chạy invocation**, và cast `as never` che mất khớp kiểu | Probe cho thấy `params` không tới đúng dạng → phải viết lại phần validate, **không** phải viết lại kiến trúc. Đây là lý do (a) vẫn nên đi trước nhưng phải có step 0 validate phòng thủ |
| `registerTool` sau `createWorkerSession` là đủ để model thấy tool | **trung bình-cao** — `setActiveTools` ghi rõ "Assignment, not a reload. The SDK copies the top-level array", ám chỉ SDK đọc `state.tools` mỗi lượt | SDK đọc tool set lúc tạo session → phải truyền qua `builtinTools`/`customTools` lúc `createAgentSession`, sửa `model-turn.ts:61` |
| Gemini Live vẫn hỗ trợ ephemeral token qua `v1alpha` | **thấp** — không có web access lượt này để xác minh; đây là endpoint `v1alpha` và đã từng thay đổi | Nếu B2 còn sống và ổn định thì B2 thắng B1 về latency/chi phí, và khuyến nghị đảo — nhưng vẫn nên làm B1 trước vì seam cho phép đổi sau |
| Model Gemini mà người dùng gọi là "3.8 Live" tồn tại dưới một id cụ thể | **thấp** — không xác minh được; "3.8" không phải định danh tôi nhận ra cho dòng Live | Phải resolve qua catalogue provider và pin đúng id; đừng hardcode tên |
| Chỉ có một node, chưa có peer thật, nên rò rỉ tin cậy hôm nay là **nội bộ một process** | **cao** — `docs/scope-lock.md` V04 40%, review §3 ghi "chưa chạy 2 node" | Khi node-link có transport thật thì gate tầng đọc từ "phòng xa" thành "bắt buộc", và cờ provenance trên message thành một phần của protocol chứ không chỉ của schema |
| Không có `ws` trong repo và không có WebSocket upgrade nào | **cao** — grep sạch; server chỉ là `node:http createServer` | Nếu `ws` đã có gián tiếp trong tree thì chi phí B1 giảm gần hết |

---

## 10. Câu hỏi chưa giải quyết

1. Danh sách 11 task đầy đủ ở đâu? Thứ tự §6 dựa trên 6 deliverable đã nêu trong brief.
2. Định danh model Live chính xác cần pin là gì (`gemini-live-2.5-flash`? một biến thể native-audio?), và provider account đã có chưa?
3. Node có phải phục vụ **nhiều** browser tab đồng thời trên `/voice` không? Nếu có, giới hạn số phiên Live đồng thời là một setting của node, không phải chi tiết của transport.
4. 6 file PNG evidence đang modified: commit lại hay revert trước PR?

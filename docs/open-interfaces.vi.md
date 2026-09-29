# Giao diện mở — API, MCP, WebSocket, CLI

> [English](open-interfaces.md) (mặc định) · Tiếng Việt

Actually you don't need to read this — thật ra bạn không cần đọc tài liệu này: khi node đang chạy, cứ hỏi Clark
(`clarkcant ask "làm sao kết nối Cursor với bạn?"`).

ClarkCant được thiết kế theo tiêu chuẩn mở để bất kỳ ứng dụng bên thứ ba hay công cụ AI nào cũng làm việc được với
cùng một Clark mà người dùng đang trò chuyện. Mọi bề mặt dưới đây đều do một node runtime phục vụ, cùng origin, cùng
bearer token, và đều kết thúc ở cùng một gateway handler (`apps/runtime/src/gateway.ts`). Không có stack business
logic thứ hai: một MCP tool, một frame WebSocket hay một lệnh CLI đều là một request tới route mà caller HTTP cũng gọi
được, nên kiểm tra, từ chối và audit trail giống hệt nhau ở mọi nơi.

| Bề mặt | Tiêu chuẩn | Endpoint | Code |
|---|---|---|---|
| REST API | HTTP/JSON, OpenAPI 3.1 | `/openapi.json` | `apps/runtime/src/routes/*` |
| Streaming | Server-Sent Events | `POST /conversations/{id}/messages/stream` | `routes/conversations.ts` |
| MCP | Model Context Protocol, Streamable HTTP | `POST /mcp` | `routes/mcp.ts` |
| MCP (stdio) | Model Context Protocol, stdio | `clarkcant mcp` | `apps/cli/src/cli.ts` |
| WebSocket | frame JSON, `clarkcant.ws.v1` | `/ws` | `apps/runtime/src/api-socket.ts` |
| CLI | – | `clarkcant` | `apps/cli` |
| Discovery | JSON | `/.well-known/clarkcant.json` | `apps/runtime/src/open-interfaces.ts` |

Test: `apps/runtime/test/open-interfaces.spec.ts`, `apps/cli/test/cli.spec.ts`.

## Kết nối

- URL mặc định `http://127.0.0.1:8765`. Node chỉ bind loopback trừ khi chạy với `--allow-public-bind`, và khi đó phải
  có TLS phía trước (xem [cài đặt](installation.vi.md)).
- Mọi route trừ `/health`, `/.well-known/clarkcant.json` và `/openapi.json` đều cần `Authorization: Bearer <token>`.
  Token là `localToken` trong `<data-dir>/identity.json` (mặc định `~/.clarkcant`, Docker `/data/identity.json`).
  Thiếu token và sai token nhận cùng một `401 UNAUTHENTICATED`.
- Lời từ chối là JSON: `{ "code": "SOME_CODE", "message": "..." }`.

## REST

Bề mặt ổn định là phần `/openapi.json` mô tả:

| Method | Path | Body |
|---|---|---|
| GET | `/node` | – |
| GET / POST | `/conversations` | `{ title? }` |
| POST | `/conversations/{id}/messages` | `{ text, attachmentIds? }` — chờ câu trả lời |
| POST | `/conversations/{id}/messages/stream` | như trên, trả về dạng SSE: `delta`, `reasoning`, `tool-start`, `tool-end`, `host-control`, `error`, `done` |
| POST | `/conversations/{id}/stop` | `{ source? }` — dừng câu trả lời đang viết; giữ phần đã viết, gắn nhãn đã dừng; trả về `{ stopped }` |
| GET | `/conversations/{id}/timeline?after=N` | – |
| POST | `/conversations/{id}/questions/{questionId}/answer` | `{ text?, optionIds?, confirmed? }` |
| POST | `/conversations/{id}/questions/{questionId}/cancel` | – |
| POST | `/signals` | `{ source, topic, subject?, payload, occurredAt, dedupeKey, provenance? }` — báo một việc vừa xảy ra; `202` đã ghi, `200` đã ghi từ trước |
| POST | `/signals/github` | một lần giao webhook của GitHub, ký bằng webhook secret thay cho token — xem bên dưới |
| POST | `/signals/webhook/{source}` | `{ id, topic, payload?, subject?, occurredAt? }` ký bằng secret của nguồn đó thay cho token — xem bên dưới |
| GET | `/automations` | – những việc tự động đã đặt trong hội thoại, kèm các lần chạy gần nhất |
| POST | `/stop` | – dừng khẩn cấp |

```bash
TOKEN=$(jq -r .localToken ~/.clarkcant/identity.json)
ID=$(curl -s -X POST localhost:8765/conversations -H "authorization: Bearer $TOKEN" | jq -r .conversationId)
curl -N -X POST localhost:8765/conversations/$ID/messages/stream \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"text":"xin chào"}'
```

Event `host-control` là agent yêu cầu trang thay đổi một thứ gì đó (mở Settings ở một tab, đổi model, mở chế độ
giọng nói). Khi do agent yêu cầu, decision của event mang một `controlId`, và trang trả lời bằng
`POST /app-intents/host-control/{controlId}` `{ ran, say }` sau khi đã thực hiện xong hoặc không thực hiện được.
Agent nhận đúng câu trả lời của trang, nên chỉ nói app đã thay đổi khi trang báo là đã làm; nếu không có câu trả lời
trong vài giây, agent được báo là hành động chưa được xác nhận. Mỗi `controlId` chỉ được trả lời một lần (lần thứ hai
nhận `404 HOST_CONTROL_NOT_EXPECTED`), và route `/messages` thường không bao giờ chờ câu trả lời. Bản ghi audit của
một hành động agent yêu cầu khi đang trả lời một câu nói có `source: "voice-agent"`, khác với lệnh do chính người dùng
nói (`source: "voice"`).

Signal là cách mọi thứ bên ngoài hội thoại báo cho node biết một việc vừa xảy ra: một lần chạy CI, một script, một
dịch vụ của riêng bạn. Signal được ghi lại trước khi đối chiếu bất cứ thứ gì, rồi mới đối chiếu với những yêu cầu lâu
dài mà người dùng đã đặt bằng cách nói với Clark "khi X xảy ra thì làm Y". Topic là các từ chữ thường nối bằng dấu
chấm (`build.finished`); payload tối đa 64 KB; cùng một `(source.sourceId, dedupeKey)` gửi lại thì nhận `200` kèm
signal đã ghi từ trước, nên bên gửi có thử lại cũng không bao giờ khởi động công việc hai lần. Nguồn `timer` và
`system` là của chính node và bị từ chối với `403 SOURCE_RESERVED`. Việc tự động được tạo, tạm dừng, chạy lại và xoá
trong hội thoại; `/automations` chỉ để đọc.

```bash
curl -X POST localhost:8765/signals -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "source": { "kind": "external", "provider": "ci", "sourceId": "ci:my-repo" },
  "topic": "build.finished",
  "subject": { "type": "build", "id": "812" },
  "payload": { "status": "failed" },
  "occurredAt": "2026-09-29T08:00:00.000Z",
  "dedupeKey": "build-812"
}'
```

GitHub gửi tới `POST /signals/github` mà không cần token của node: webhook của repository (content type
`application/json`) ký mỗi lần giao bằng một secret mà node giữ dưới tên `github_webhook_secret`, và lần giao nào có
`X-Hub-Signature-256` không khớp thì bị từ chối `401`, không ghi gì. Clark xin secret đó qua form secret do host sở hữu
vào lần đầu một việc tự động GitHub được thiết lập, nên giá trị không bao giờ đi vào hội thoại. Lần giao đã xác minh trở
thành một signal — `github.issue.labeled|opened|edited`, `github.pull_request.opened|synchronize`,
`github.issue_comment.created`, `github.pull_request_review_comment.created`, `github.workflow_run.completed`,
`github.check_suite.completed`, cùng các action khác của những event đó — với repository ở `subject.refs.repository`,
khử trùng theo `X-GitHub-Delivery`. Việc do chính các login GitHub của node gây ra (preference
`signals.github.selfLogins`) được đánh dấu tự gây ra và không khởi động gì, trừ khi việc tự động yêu cầu điều đó; và
một task chỉ bắt đầu trong bản clone cục bộ có `origin` đúng là repository mà signal nói tới. Body quá 2 MiB bị từ chối
`413`. Với node mà GitHub không gọi tới được, `@clarkcant/signal-sources` còn có một poller đọc các event của
repository thành cùng loại signal đó; node chưa tự chạy nó theo lịch.

Bất cứ thứ gì khác ký được một request đều có thể gửi tới `POST /signals/webhook/{source}`, cũng không cần token của
node. Người dùng đặt tên nguồn khi thiết lập một yêu cầu lâu dài trên topic `webhook.<source>.<việc đã xảy ra>`, và
Clark xin secret dùng chung của nguồn đó qua cùng form do host sở hữu, lưu dưới tên `webhook_<source>_secret` chỉ cho
nguồn đó. Bên gửi ký body thô bằng secret này — `X-Signature-256: sha256=<hex HMAC-SHA256>` — và gửi
`{ "id": "build-812", "topic": "build.failed", "payload": { "branch": "main" } }`; node ghi signal
`webhook.<source>.build.failed`, khử trùng theo `id`. Topic luôn được gắn tiền tố tên nguồn, nên bên gửi không thể làm
lần giao của mình trông như của GitHub hay của một nguồn khác. Chữ ký thiếu hoặc sai bị từ chối `401` và không ghi gì,
nguồn chưa có secret trả `404`, và body quá 256 KiB bị từ chối `413`.

```bash
BODY='{"id":"build-812","topic":"build.failed","payload":{"branch":"main"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/^.* //')
curl -X POST localhost:8765/signals/webhook/deploys -H 'content-type: application/json' \
  -H "x-signature-256: sha256=$SIG" -d "$BODY"
```

Một node đã ghép cặp báo cho node kia biết việc vừa xảy ra bằng `POST /peers/{nodeId}/signals` `{ id, topic, payload?,
subject?, occurredAt? }` trên gateway của chính nó, với token của chính nó. Signal được xếp vào outbox và chuyển tới peer
dưới dạng message NodeLink `signal`; peer ghi nó thành `peer.<topic>` từ node mà kênh đã xác thực nói là bên gửi, nên
chính các yêu cầu lâu dài trên peer quyết định nó khởi động gì, nếu có. Xem [runtime phân tán](distributed-runtime.vi.md).

Task của một yêu cầu lâu dài cũng có thể chạy trên một node đã ghép cặp. Việc này được đặt trong hội thoại, không qua
một route: chủ của node gửi nêu peer làm executor của task, và chủ của node nhận nói peer đó được chạy gì ở đó (thư
mục, repository, effect). Hai node trao đổi grant, lần giao (`delegate`), câu trả lời (`result`) và lệnh dừng
(`cancel.request`) bằng message NodeLink; bên nhận chỉ chạy task trong phạm vi cả hai cho phép, và mỗi chủ node nghe
kết quả trong hội thoại của chính mình.

Các route khác (settings, packages, widgets, peers…) vẫn gọi được với cùng token nhưng chưa thuộc mô tả ổn định và
có thể thay đổi.

## MCP

`POST /mcp` hiện thực transport Streamable HTTP, trả lời bằng JSON (protocol `2025-06-18`, cùng `2025-03-26` và
`2024-11-05`). `GET /mcp` trả `405`: server không bao giờ chủ động gửi trước. Method: `initialize`, `ping`,
`tools/list`, `tools/call`; notification nhận `202` không có body.

| Tool | Tham số | Route được gọi |
|---|---|---|
| `ask_clark` | `text`, `conversationId?`, `title?` | `POST /conversations` (khi cần), `POST /conversations/{id}/messages` |
| `list_conversations` | – | `GET /conversations` |
| `create_conversation` | `title?` | `POST /conversations` |
| `read_conversation` | `conversationId`, `after?` | `GET /conversations/{id}/timeline` |
| `answer_question` | `conversationId`, `questionId`, `text?`, `optionIds?`, `confirmed?` | `POST …/questions/{questionId}/answer` |
| `stop_reply` | `conversationId` | `POST /conversations/{id}/stop` |
| `stop_all_work` | – | `POST /stop` |
| `node_status` | – | `GET /node` |

**Cố ý không có tool duyệt approval.** Approval là quyết định của con người về việc agent muốn làm; một MCP tool cho
nó sẽ cho phép client AI tự duyệt hành động bị guard của chính nó. Approval chỉ nằm trên bề mặt của người dùng, và
các relay tổng quát (frame `request` qua WebSocket, `clarkcant api`) cùng MCP từ chối mọi route ghi nhận quyết định
của con người với `403 PERSON_ONLY` vì cùng lý do đó: duyệt hành động bị guard (trên thẻ, hoặc do một task đang
chạy raise ra), quyết định capability của package,
xác nhận app intent, báo cáo trang đã làm gì với một hành động agent yêu cầu, tin cậy một peer đã ghép cặp và cấp
grant. Xuất một bảng ra file CSV
(`POST /conversations/{id}/widgets/{instanceId}/export`) cũng bị các relay đó từ chối: file được viết cho người đang
xem bảng, không trao cho một client máy. Dừng, trả lời câu hỏi và đọc vẫn dùng được. Discovery document ghi điều này
ở mục `personDecisions`.

Cấu hình client — HTTP:

```json
{ "mcpServers": { "clarkcant": { "url": "http://127.0.0.1:8765/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
```

stdio, cho client khởi chạy một process (bridge đọc token từ `~/.clarkcant` hoặc `CLARKCANT_TOKEN`):

```json
{ "mcpServers": { "clarkcant": { "command": "node", "args": ["/path/to/clarkcant/apps/cli/src/main.ts", "mcp"] } } }
```

## WebSocket

`ws://127.0.0.1:8765/ws`. Trình duyệt không đặt được header cho WebSocket, nên frame đầu tiên dùng để xác thực, giống
socket `/voice` và `/terminal`:

```
→ { "type": "auth", "token": "<token>" }
← { "type": "ready", "protocol": "clarkcant.ws.v1" }
→ { "type": "request", "id": "1", "method": "POST", "path": "/conversations/<id>/messages/stream", "body": { "text": "hi" } }
← { "type": "event", "id": "1", "event": "delta", "data": { "text": "Hel" } }
← { "type": "event", "id": "1", "event": "done", "data": { … } }
← { "type": "response", "id": "1", "status": 200, "body": null }
```

- Gửi được mọi route REST, trừ quyết định của con người, dưới dạng frame `request`; câu trả lời là status và body
  của chính gateway.
- `id` được trả lại đúng như khi gửi, dù là chuỗi hay số.
- Tham số query đặt trong object `query` của frame, không đặt trong `path`.
- Tối đa 16 request chạy đồng thời trên một socket, phân biệt bằng `id`.
- Request bị từ chối (`INVALID_FRAME`, `TOO_MANY_REQUESTS`) nhận một frame `error` mang `id` của nó thay cho
  `response`; đó là frame cuối cùng của `id` đó.
- Route trả về bytes (attachment, ảnh) trả `415 USE_HTTP`.
- `ping` → `pong`. Không xác thực trong 10 giây, hoặc sai token: frame `error` và close code `4401`.

## CLI

`apps/cli` (`@clarkcant/cli`) chỉ là client của gateway. Chưa publish lên npm; chạy từ checkout bằng
`node apps/cli/src/main.ts` hoặc `pnpm clarkcant`.

| Lệnh | |
|---|---|
| `clarkcant ask "<text>" [-c <conversationId>]` | stream câu trả lời ra stdout; id hội thoại ra stderr |
| `clarkcant status` | nhãn node, URL, model |
| `clarkcant conversations` / `new [title]` / `read <id>` | hội thoại |
| `clarkcant stop` | dừng khẩn cấp |
| `clarkcant api <METHOD> <path> [jsonBody]` | gọi route bất kỳ, trừ quyết định của con người |
| `clarkcant mcp` | MCP qua stdio |
| `clarkcant discover` | discovery document |

Kết nối: `--url` / `CLARKCANT_URL`, `--token` / `CLARKCANT_TOKEN`, nếu không thì đọc `identity.json` trong
`--data-dir` / `CLARKCANT_DATA_DIR` (mặc định `~/.clarkcant`). File identity chỉ được đọc cho node trên chính máy
này (`localhost`, `127.x`, `::1`); `--url` trỏ tới máy khác cần `--token` hoặc `CLARKCANT_TOKEN`, nên token cục bộ không
bao giờ bị gửi sang host khác. `clarkcant mcp` chuyển tiếp từng dòng ngay khi nhận, nên `ping` vẫn được trả lời trong
lúc một lệnh gọi dài đang chạy. `--json` in JSON thô.

## Thay đổi một bề mặt

Theo quy tắc trong [AGENTS.md](../AGENTS.md#open-interfaces): năng lực mới đi qua một route của gateway trước, các bề
mặt khác gọi tới qua route đó, `open-interfaces.ts` và tài liệu này (cả hai ngôn ngữ) đổi trong cùng PR, và thay đổi
docs cho website được tạo thành issue có nhãn `ai-handle` trên `digitopvn/clarkcant-web`.

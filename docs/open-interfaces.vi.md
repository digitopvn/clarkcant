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
| GET | `/conversations/{id}/timeline?after=N` | – |
| POST | `/conversations/{id}/questions/{questionId}/answer` | `{ text?, optionIds?, confirmed? }` |
| POST | `/conversations/{id}/questions/{questionId}/cancel` | – |
| POST | `/stop` | – dừng khẩn cấp |

```bash
TOKEN=$(jq -r .localToken ~/.clarkcant/identity.json)
ID=$(curl -s -X POST localhost:8765/conversations -H "authorization: Bearer $TOKEN" | jq -r .conversationId)
curl -N -X POST localhost:8765/conversations/$ID/messages/stream \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"text":"xin chào"}'
```

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
| `stop_all_work` | – | `POST /stop` |
| `node_status` | – | `GET /node` |

**Cố ý không có tool duyệt approval.** Approval là quyết định của con người về việc agent muốn làm; một MCP tool cho
nó sẽ cho phép client AI tự duyệt hành động bị guard của chính nó. Approval chỉ nằm trên bề mặt của người dùng, và
các relay tổng quát (frame `request` qua WebSocket, `clarkcant api`) từ chối các route quyết định approval với
`403 PERSON_ONLY` vì cùng lý do đó.

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

- Gửi được mọi route REST, trừ route quyết định approval, dưới dạng frame `request`; câu trả lời là status và body
  của chính gateway.
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
| `clarkcant api <METHOD> <path> [jsonBody]` | gọi route bất kỳ, trừ route quyết định approval |
| `clarkcant mcp` | MCP qua stdio |
| `clarkcant discover` | discovery document |

Kết nối: `--url` / `CLARKCANT_URL`, `--token` / `CLARKCANT_TOKEN`, nếu không thì đọc `identity.json` trong
`--data-dir` / `CLARKCANT_DATA_DIR` (mặc định `~/.clarkcant`). `--json` in JSON thô.

## Thay đổi một bề mặt

Theo quy tắc trong [AGENTS.md](../AGENTS.md#open-interfaces): năng lực mới đi qua một route của gateway trước, các bề
mặt khác gọi tới qua route đó, `open-interfaces.ts` và tài liệu này (cả hai ngôn ngữ) đổi trong cùng PR, và thay đổi
docs cho website được tạo thành issue có nhãn `ai-handle` trên `digitopvn/clarkcant-web`.

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
| POST | `/conversations/{id}/messages` | `{ text, attachmentIds?, references? }` — chờ câu trả lời |
| POST | `/conversations/{id}/messages/stream` | như trên, trả về dạng SSE: `delta`, `reasoning`, `tool-start`, `tool-end`, `host-control`, `error`, `done` |
| POST | `/conversations/{id}/stop` | `{ source? }` — dừng câu trả lời đang viết; giữ phần đã viết, gắn nhãn đã dừng; trả về `{ stopped }` |
| GET | `/conversations/{id}/timeline?after=N` | – |
| POST | `/conversations/{id}/questions/{questionId}/answer` | `{ text?, optionIds?, confirmed? }` |
| POST | `/conversations/{id}/questions/{questionId}/cancel` | – |
| POST | `/signals` | `{ source, topic, subject?, payload, occurredAt, dedupeKey, provenance? }` — báo một việc vừa xảy ra; `202` đã ghi, `200` đã ghi từ trước |
| POST | `/signals/github` | một lần giao webhook của GitHub, ký bằng webhook secret thay cho token — xem bên dưới |
| POST | `/signals/webhook/{source}` | `{ id, topic, payload?, subject?, occurredAt? }` ký bằng secret của nguồn đó thay cho token — xem bên dưới |
| GET | `/automations` | – những việc tự động đã đặt trong hội thoại, kèm các lần chạy gần nhất |
| GET | `/composer/suggestions?trigger=/\|@&q=&conversationId=` | – những gì ô soạn tin gợi ý sau `/` hoặc `@` |
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
`413`.

Node mà GitHub không gọi tới được sẽ tự poll thay vào đó, không cần thiết lập gì. Mỗi repository trên github.com mà
một việc tự động `github.*` đang hoạt động nêu qua `subject.refs.repository` (`equals`, hoặc từng tên của `in`) được
đọc danh sách Events API thành cùng loại signal — issue, pull request và comment của chúng; CI run vẫn cần webhook —
khử trùng theo id của event. Mỗi repository được poll nhiều nhất năm phút một lần, hoặc thưa hơn khi `X-Poll-Interval`
của GitHub yêu cầu, kèm `If-None-Match` để danh sách không đổi chỉ là một `304`; khi bị giới hạn tốc độ, node chờ tới
lúc GitHub reset. Cursor và tag được lưu theo từng repository, nên sau khi khởi động lại node đi tiếp từ chỗ đã dừng và
mỗi event chỉ được ghi một lần. Repository đã có webhook delivery được xác minh trong 24 giờ qua thì không bị poll, và
node không có việc tự động nào như vậy thì không gửi request nào. Repository công khai không cần token; repository
riêng tư được đọc bằng `github_token` khi người dùng đã lưu nó cho consumer `signals:github`. Một lần bị từ chối, hoặc
ba lần lỗi liên tiếp, để lại đúng một thông báo trong inbox, và repository được thử lại với thời gian chờ tăng dần (tối
đa sáu giờ), hoặc ngay lập tức khi token được lưu lại. Việc tự động gắn với `subject.refs.host` khác được để cho webhook.

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

Một node đã ghép cặp đưa một thông báo vào inbox của chủ node kia bằng `POST /peers/{nodeId}/notices` `{ id, title,
body?, category?, severity? }` trên gateway của chính nó, với token của chính nó (`202` đã xếp hàng; `404`
`PEER_UNKNOWN` khi peer chưa được ghép cặp và xác nhận; `409` `NOTICES_UNSUPPORTED` khi peer chưa cho biết nó nhận
thông báo, kèm lời dặn gửi cho peer đó một thứ gì trước hoặc cập nhật nó; `400` cho mọi trường hợp khác). Hiện route này là nguồn tạo duy nhất: không node nào tự gửi thông báo, nên
các công cụ cục bộ — CLI, một client MCP, một automation — dùng nó để báo cho một Clark đã ghép cặp và chịu nhận. Nó đi
dưới dạng message NodeLink `notice` với payload là `notice` `{ key, category, severity, title, body? }` — một object
strict: title tối đa 120 ký tự, body tối đa 500, key tối đa 160, và không gì khác, nên không có trường nào cho action,
subject hay liên kết. Bên nhận chỉ ghi nó khi chính chủ của mình đã chọn làm việc với bên gửi — một grant còn hiệu
lực do bên nhận viết cho peer đó, hoặc một allowance còn hiệu lực dành cho nó; grant do bên gửi viết không tính — và
tối đa 30 thông báo mỗi phút từ một peer. Nếu không, nó trả `accepted: false` kèm một `code` (`PEER_NOT_ALLOWED`, `RATE_LIMITED`,
`NOTICE_UNREADABLE`, `NOTICES_OFF`) và một `reason`, và câu trả lời đó là cuối cùng: bên gửi không gửi lại, ghi nó lên
dòng outbox, và đặt vào inbox của chính chủ mình mỗi peer và mỗi lý do một thông báo, nói điều gì không tới, vì sao, và
điều gì sẽ thay đổi được việc đó. Thông báo được ghi là của peer (`sourceKind` `peer`, `originNodeId`, subject `peer`) dưới
khóa `peer:<senderNodeId>:<key>`, nên gửi lại hay replay vẫn chỉ là một thông báo; nội dung được coi là dữ liệu (bỏ ký
tự điều khiển, ký tự bidi và ký tự độ rộng bằng không); mỗi peer giữ tối đa 20 thông báo chưa bỏ qua, cái cũ nhất đi
trước, mà không đẩy thông báo của chính node hay của peer khác ra; và việc có thể làm với nó do host bên nhận tự xác
định như với mọi thông báo khác.

Mọi phản hồi `200` từ `POST /peers/messages` đều mang `features` (những gì node trả lời nhận thêm ngoài các envelope
cơ bản; hiện là `["notice", "skip"]`) và `label` (tên nó tự gọi mình), và phản hồi `409` `SEQUENCE_GAP` cũng vậy
(`{ code, expected, received, features, label }`). Bên gửi ghi cả hai cho peer đó, chỉ từ câu trả lời cho một thứ nó đã
giao qua kênh đã xác thực; lời mời ghép cặp cũng có thể mang `features`. Feature lạ bị bỏ, label được làm sạch và cắt
còn 64 ký tự, và một peer chưa cho biết gì — một bản dựng có trước thay đổi này — không được gửi thông báo hay skip cho
tới khi một câu trả lời nói nó nhận. Bên gửi chỉ đọc tối đa 16 KiB của một câu trả lời, trong hạn 30 giây của lần giao;
câu trả lời vượt một trong hai bị bỏ qua, và message vẫn được xác nhận khi mã của nó là `200`.

NodeLink đánh số thứ tự mọi envelope một node gửi cho một peer, và peer từ chối mọi thứ nằm sau một chỗ hổng bằng `409`
`SEQUENCE_GAP`. Khi bên gửi bỏ một message sau 12 lần thử thất bại, một peer có quảng bá `skip` được gửi một message
NodeLink `skip` thay cho nó; envelope vẫn ở phiên bản giao thức 1, và chính feature được quảng bá là thứ đánh phiên bản
cho nó. (Message của một ghép cặp đã bị thu hồi cũng bị bỏ, nhưng không có gì, kể cả skip, được gửi tới một peer đã bị
thu hồi.) Payload của nó là `skip` `{ through, lost: [{ sequence, messageId, kind, taskId? }] }` — một object chặt:
`through` bằng chính `sourceSequence` của envelope (vị trí của message cuối cùng nó bỏ, nên nó không bao giờ vượt qua
một message chưa gửi), `lost` liệt kê từ 1 tới 50 message đã bị bỏ theo thứ tự tăng dần, cái cuối cùng nằm đúng ở
`through`, không cái nào có kind `skip`, và `taskId` phải có dạng id; mọi thứ khác bị từ chối cả khối bằng `400`
`SKIP_INVALID`. Bên gửi chỉ bao các message đã bỏ nằm trên số thứ tự cao nhất mà peer đã xác nhận và dưới số thấp nhất
còn đang nợ, mỗi lần một skip, và gửi đủ số skip mà một chuỗi dài hơn cần trước khi gửi lại bất cứ thứ gì chỗ hổng sẽ
từ chối. Bên nhận chỉ xử lý một skip nằm trước con trỏ của nó, dời con trỏ tới `through`, và trả lời `accepted: true`
kèm `from` (số thứ tự đầu tiên nó chưa nhận), `through` và `settled` (các task nó đã giao cho bên gửi mà `result` bị mất
đã được chốt là chưa rõ); một lần gửi lại được trả lời từ inbox của nó, và một skip mà mọi số thứ tự nó bao rốt cuộc
đều đã tới được trả lời `200` `status: "stale"` với `code` `SKIP_STALE`, không thay đổi gì. Bên gửi chỉ xác nhận một
skip khi đã đọc được câu trả lời đó: nó báo cho chủ trước, rồi ghi xác nhận cùng audit event của nó trong một lần, nên
một câu trả lời không đọc được, hay một lần sập, sẽ khiến skip được gửi lại và câu trả lời cho lần gửi lại chỉ báo một
lần. Cả hai bên ghi một audit event loại `peer` và đặt một thông báo vào inbox của chủ mình (khóa
`peer-lost:<peerNodeId>:out|in:<through>`) nói cái gì thất bại, cái gì được giữ và các task liên quan sẽ ra sao trước
khi liệt kê cái gì bị mất, nên danh sách mới là phần bị rút gọn cho vừa; bên nhận báo cho chủ tối đa 30 lần một phút cho
mỗi peer. Một node không có handler cho skip trả lời `400` `UNSUPPORTED_KIND` và không quảng bá nó; bên gửi có skip bị
trả lời `400` với bất kỳ mã nào khác `SKIP_INVALID` ghi nhận peer đó không nhận skip (cho tới khi một câu trả lời quảng
bá `skip` lại), bỏ skip đó và báo ghép cặp đang bị kẹt. Với một peer không quảng bá `skip`, việc giao vẫn như trước, và
chủ của bên gửi được báo một lần cho mỗi quãng không có xác nhận (`peer-stuck:<peerNodeId>:<lastAck|never>`) rằng ghép
cặp đang bị kẹt cho tới khi thiết bị đó cập nhật, nhưng chỉ khi một message đã bỏ vẫn còn thiếu ở đó; `409` kế tiếp từ
một peer đã cập nhật mang `skip`, và skip được gửi ngay sau đó. Với một peer nhận skip, các message đi theo số thứ tự
thấp nhất trước và từng cái một, nên những gì chờ sau một message bị từ chối không bị từ chối theo.

Task của một yêu cầu lâu dài cũng có thể chạy trên một node đã ghép cặp. Việc này được đặt trong hội thoại, không qua
một route: chủ của node gửi nêu peer làm executor của task, và chủ của node nhận nói peer đó được chạy gì ở đó (thư
mục, repository, effect). Hai node trao đổi grant, lần giao (`delegate`), câu trả lời (`result`) và lệnh dừng
(`cancel.request`) bằng message NodeLink; bên nhận chỉ chạy task trong phạm vi cả hai cho phép, và mỗi chủ node nghe
kết quả trong hội thoại của chính mình. Trong lúc task chờ chủ node nhận duyệt, bên nhận báo điều đó bằng `status`
(`taskState` là `waiting_approval`, rồi `running` khi đã được cho phép), và chủ node gửi được báo mà không được đưa
quyền quyết định. Tạm dừng hoặc gỡ automation sẽ rút grant riêng của nó bằng `revoke` (`grantId`, `reason`), và chỉ
bên gửi grant mới gửi được message này. Giới hạn thời gian cho mỗi lần chạy, đặt khi tạo automation
(`maxMinutesPerRun`), đi theo grant dưới dạng `budget.maxWallClockMs`, và bên nhận dừng lần chạy khi hết thời gian;
`maxRuns` và `maxTokens` của grant cũng được giữ theo cách đó.

Một tin nhắn có thể mang theo những gì người dùng chọn sau `/` hoặc `@` trong ô soạn tin dưới dạng `references`:
`{ "version": 1, "items": [...] }`, tối đa 8 mục, mỗi mục là một trong `skill { skillId, source, revision }`,
`project { projectId }`, `file|folder { projectId, path }` (đường dẫn tương đối trong dự án, không bao giờ là đường dẫn
tuyệt đối), `mcp-server { serviceKey }`, `conversation { conversationId }`, `background-work { workId }` hoặc
`notice { noticeId }`, tất cả đều có `label`. Node kiểm tra lại từng mục lúc gửi — kỹ năng vẫn còn ở đúng revision,
đường dẫn vẫn nằm trong dự án sau khi đi theo liên kết, dự án vẫn nằm trong các thư mục được phép, thông báo vẫn còn trong
hộp thư — và một tham chiếu không còn đúng sẽ khiến cả tin nhắn bị từ chối với `400 REFERENCE_NOT_AVAILABLE`, nêu rõ tên
tham chiếu đó, trước khi bất cứ thứ gì được lưu. Những gì hợp lệ được giữ trên tin nhắn của người dùng thành block
`reference` và được đưa vào lượt trả lời bằng đường dẫn tương đối trong dự án; chỉ dẫn của kỹ năng được đưa vào lượt đó.
Tham chiếu là con trỏ, không phải quyền: đọc, chạy hay thay đổi thứ nó trỏ tới vẫn đi qua các bước kiểm tra thường lệ
của node.

`GET /composer/suggestions` là thứ lấp đầy bộ chọn: kỹ năng sau `/`; dự án, dịch vụ, hội thoại (theo tiêu đề, hoặc theo
phần đầu tin nhắn đầu tiên khi tiêu đề chỉ là tên mặc định của client) và việc nền sau `@`; một thư mục của dự án sau
`@<dự án>/`. Tối đa 8 dòng, xếp theo khớp chính xác, rồi khớp đầu, rồi khớp một phần, rồi theo loại (dự án, dịch vụ, hội
thoại, việc nền), thứ dùng gần đây lên trước, gõ dấu hay không đều được. Khi chưa gõ gì sau `@`, mỗi loại đều có phần
dòng của mình. Dòng không chọn được sẽ nói lý do trong `disabledReason`. Dịch vụ được gọi bằng id mà gói của nó đặt và
chỉ mang trạng thái (đang chạy, đang lỗi, chưa chạy), không bao giờ kèm thứ nó được khởi động cùng hay lý do nó lỗi;
`serviceKey` của nó còn gắn với thế hệ gói đang chạy nó, nên một bản cập nhật làm tham chiếu cũ hết hiệu lực.

Các route hộp thư gọi được với cùng token nhưng **chưa** có trong `/openapi.json` và có thể thay đổi: `GET /inbox`
(những gì đang chờ người dùng, các thông báo, các thông báo đang hoãn và các loại đang tắt báo), `GET /inbox/summary`,
`POST /inbox/read` và `/inbox/unread`, với từng thông báo là `POST /inbox/notices/:id/<action>` trong đó action là
`dismiss`, `restore`, `snooze`, `unsnooze`, `suppress` hoặc `unsuppress`, và `DELETE /inbox/suppressions/:id`.
`snooze` nhận `{ "until": "<ISO instant>" }`, nằm sau hiện tại và không xa quá 30 ngày (nếu không thì
`400 SNOOZE_OUT_OF_RANGE`); thông báo rời khỏi danh sách và số chưa đọc, rồi quay lại ở trạng thái chưa đọc khi đã qua
thời điểm đó; `unsnooze` đưa nó trở lại ngay, đã đọc hay chưa đọc như trước khi hoãn. `suppress` tắt báo loại của thông
báo cho principal này: các thông báo cùng loại về sau vẫn được liệt kê nhưng đến ở trạng thái đã đọc và không hiện thông
báo. Chỉ loại đủ hẹp mới tắt báo được, tức loại gắn với một việc tự động, một nguồn tín hiệu, một gói, một node, hoặc
việc nền của chính người dùng; loại khác sẽ tắt luôn cả lời nhắc và thông báo của mọi việc tự động khác, nên route từ
chối bằng `409 SUPPRESSION_TOO_BROAD` và `actions` của thông báo không bao giờ đưa ra thao tác này. Mỗi route chỉ tác động lên thông báo của chính principal gọi nó.
`POST /effects/:effectId/reconcile` với `{ "outcome": "confirmed" | "failed", "source"?: "click" | "chat" | "voice" }`
ghi nhận điều người dùng thấy về một thao tác chưa rõ kết quả, tức câu trả lời mà thông báo chưa rõ kết quả đưa ra
thành hai nút: `404 RESOURCE_NOT_FOUND` với effect thuộc task của principal khác, của node khác, hoặc không tồn tại,
`409 EFFECT_NOT_UNKNOWN` khi nó không còn ở trạng thái chưa rõ; route này chỉ dành cho người dùng, như bên dưới.
`source` là nhãn do bên gọi gửi để cho biết câu trả lời được đưa ra ở đâu và được lưu đúng như vậy, không phải
nguồn gốc đã xác minh; ai trả lời là principal đã xác thực. Hình dạng dữ liệu ở `packages/contracts/src/inbox.ts`; hành vi được mô tả trong
[system-architecture.vi.md](system-architecture.vi.md) ở phần hộp thư.

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
xác nhận app intent, báo cáo trang đã làm gì với một hành động agent yêu cầu, tin cậy một peer đã ghép cặp, cấp
grant, và ghi nhận một thao tác không ai thấy kết quả đã có hiệu lực hay chưa (`POST /effects/{effectId}/reconcile`;
một client AI nói được "lần push đó đã thành công" thì có thể tự gỡ trạng thái chưa rõ của task của chính nó rồi tự
báo là đã xong). Xuất một bảng ra file CSV
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

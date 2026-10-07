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
| GET | `/changelog?since=` | – — phiên bản Clark này thay đổi gì, đọc từ ghi chú phát hành đi kèm bản build (không cần mạng, chỉ đọc); `since` chỉ giữ các phiên bản sau một phiên bản như `1.4`; bản chạy từ mã nguồn có thêm `notesCover`, commit và ngày mà ghi chú dừng lại; `400` khi giá trị không phải phiên bản, `503 CHANGELOG_UNAVAILABLE` khi bản build không có ghi chú đọc được ([phát hành](releases.vi.md)) |
| GET / POST | `/conversations` | `{ title? }` |
| POST | `/conversations/{id}/delete` | `{ deletionPermit? }` — xoá trên bề mặt của người dùng; policy có thể hỏi hoặc từ chối |
| POST | `/conversations/{id}/messages` | `{ text, attachmentIds?, references? }` — chờ câu trả lời |
| POST | `/conversations/{id}/messages/stream` | như trên, trả về dạng SSE: `delta`, `reasoning`, `tool-start`, `tool-end`, `host-control`, `widget-perform`, `error`, `done` |
| POST | `/conversations/{id}/stop` | `{ source? }` — dừng câu trả lời đang viết; giữ phần đã viết, gắn nhãn đã dừng; trả về `{ stopped }` |
| GET | `/conversations/{id}/timeline?after=N` · `?before=N` · `?window=latest`, mỗi kiểu kèm `&limit=` | – một trang của hội thoại; xem [Đọc một hội thoại dài](#đọc-một-hội-thoại-dài) |
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

Event `widget-perform` là Clark nhờ một widget đang hiện trên trang thực hiện một trong các hành động mà gói của nó
cung cấp (`offeredActions`, [widget-development.vi.md §10.3](widget-development.vi.md#103-hành-động-clark-thực-hiện-actionsperform1)).
Node đã kiểm tra xong: binding, input so với schema đã khai báo, và chính sách thực thi của người dùng. Node chỉ gửi
event này trên một yêu cầu stream mang `x-clarkcant-widget-perform: 1`, tức phiên bản mà trang chạy được. Mọi bên gọi
khác không được gửi event nào, và lần thực hiện bị từ chối ngay với `FRAME_NOT_MOUNTED`. Điều này bao gồm route
`/messages` thường, MCP, relay và `clarkcant api`.

`request` của event là `{ v: 1, performId, instanceId, actionBindingId, action, input }`. Trang chuyển nó cho frame
đang được mount và trả lời bằng `POST /app-intents/widget-perform/{performId}` với một trong các dạng:

- `{ status: "done", output? }`;
- `{ status: "refused", by: "page" | "widget", code, message }`;
- `{ status: "no-answer", message }`.

`by: "page"` chỉ được chấp nhận với các mã của chính trang, như `FRAME_NOT_MOUNTED`, `SURFACE_GONE`,
`PERFORM_UNREADABLE` và `PERFORM_VERSION_UNSUPPORTED`. Trang không đọc được yêu cầu, hoặc nhận một phiên bản khác, vẫn
trả lời theo `performId` của nó. Lời từ chối của widget tới Clark dưới dạng `WIDGET_REFUSED`, với mã của widget trong
`detail.widgetCode` và lý do của chính widget, khi widget có nêu, trong `detail.widgetMessage`. Cả hai là lời của
widget, không phải của host: bề mặt nào hiển thị hoặc đọc chúng lên đều trích dẫn chúng như lời của widget.

Mỗi `performId` chỉ được trả lời một lần; lần thứ hai nhận `404 WIDGET_PERFORM_NOT_EXPECTED`. Không có gì được xếp hàng
chờ về sau. Nếu không có câu trả lời trong 8 giây, hoặc trang báo `no-answer`, lần thực hiện được ghi là chưa rõ kết quả
và không được thử lại. Route báo cáo chỉ dành cho người dùng, giống route báo cáo host-control.

Khi chính sách thực thi muốn hỏi trước, câu trả lời là một thẻ phê duyệt của host. Khi quyết định thẻ đó tại
`POST /conversations/{id}/approvals/{approvalId}/decide` với cùng header, lần thực hiện đã được duyệt có thể được chuyển
cho trang này. Khi đó câu trả lời của quyết định mang `perform` (yêu cầu), và trang báo cáo theo cùng cách. Một yêu cầu
quyết định không có header thì phê duyệt mà không gửi gì, và biên nhận nói rõ điều đó. Cùng lần thực hiện đó được yêu
cầu lại trong lúc thẻ của nó còn chờ thì được trả `202` với `approvalRequired.approvalId` của thẻ đó và
`alreadyWaiting: true`, không có thẻ thứ hai. Một hội thoại giữ tối đa 8 thẻ perform đang chờ
(`429 PERFORM_CARDS_WAITING`), và input dài hơn 1.200 ký tự khi viết dạng JSON bị từ chối (`413 PERFORM_INPUT_TOO_LONG`)
vì thẻ hiện toàn bộ input.

Trang của chính node gửi `x-clarkcant-surface: composer` kèm các tin nhắn người dùng gõ vào đó, và node lưu giá trị
này thành `surface` của tin nhắn; một tin nhắn nói bằng giọng được chính node lưu với `surface: "voice"`. Một tin nhắn
gửi không kèm header (MCP, relay WebSocket, `clarkcant api`, một script) được lưu mà không có surface. Chỉ tin nhắn có
surface mới được tính là lời của chính người dùng ở những chỗ điều đó quan trọng, chẳng hạn các trang mà một việc trên
trình duyệt được phép thao tác; mọi giá trị khác của header đều bị bỏ qua.

### Đọc một hội thoại dài

Một hội thoại có thể dài hơn rất nhiều so với lượng một lần đọc nên mang, nên route timeline trả về một trang tin nhắn,
cũ trước mới sau, chọn theo số thứ tự tin nhắn (sequence): thứ tự node lưu các tin nhắn của một hội thoại.

| Query | Trang |
|---|---|
| không có, hoặc `after=N` | các tin nhắn ngay sau sequence `N`; không có tham số nghĩa là `after=0`, trang route này vẫn luôn trả về |
| `before=N` | các tin nhắn ngay trước sequence `N`, để cuộn ngược lên |
| `window=latest` | các tin nhắn mới nhất, là thứ hiện ra khi mở lại một hội thoại |

Chỉ được dùng tối đa một trong ba kiểu trên, và `limit` quyết định cỡ trang: từ 1 đến 500, mặc định 200. Mọi giá trị
khác bị trả về `400 INVALID_SCHEMA`.

Mọi timeline, dù từ route này hay đi kèm một câu trả lời khác, đều có `window`:

```json
{ "version": 1, "fromSequence": 1901, "toSequence": 2100, "hasOlder": true, "hasNewer": false, "sequences": [1901, 1902, "..."] }
```

Trang chứa mọi tin nhắn đã lưu có `fromSequence <= sequence <= toSequence`, và không chứa tin nhắn nào khác.
`sequences` cho biết sequence của từng tin nhắn theo đúng thứ tự của `messages`. `hasOlder` nghĩa là
`before=<fromSequence>` đọc được trang nối liền với trang này, và `hasNewer` nghĩa là `after=<toSequence>` cũng vậy. Hai
trang có khoảng chạm nhau hoặc chồng lên nhau gộp thành một khoảng, không tin nhắn nào lặp lại và không có khoảng trống.
Bên trong khoảng của chính nó, trang đọc sau là đúng, nên một tin nhắn đã bị xoá sẽ biến mất. Các trang không chạm nhau
thì không thể nối với nhau, và bên đọc biết được điều đó chỉ từ các con số.

`cursor` sự kiện mà timeline cũng mang theo là một con số khác. Nó cho biết bên đọc đã thấy những sự kiện nào, chứ
không phải đang giữ những tin nhắn nào, và không bao giờ là con trỏ trang.

Mọi câu trả lời có mang hội thoại đều trả về trang mới nhất của nó. Điều này áp dụng cho gửi tin nhắn, sự kiện SSE
`done`, hành động của widget, ghim, trả lời câu hỏi và thẻ, và phê duyệt. Câu trả lời của một hành động widget còn mang
theo instance vừa được thao tác, và mọi timeline đều mang instance của các widget đang ghim, dù tin nhắn của chúng nằm ở
đâu. Bên đọc đang giữ lịch sử cũ hơn gộp trang đó vào những gì nó đang giữ thay vì bắt đầu lại từ đầu.

### Ai đã yêu cầu: nguồn gốc của một lượt

Node cũng ghi lại ai đã bắt đầu mỗi lượt, thành `origin` của tin nhắn người dùng, ngay khi nhận tin nhắn. Giá trị này
được đọc từ những gì gateway đã biết, không bao giờ từ thân request:

| `origin` | Khi nào |
|---|---|
| `person` | trang của chính node gửi tin nhắn (`x-clarkcant-surface: composer`), tin nhắn được nói, hoặc người dùng trả lời một thẻ hay bấm một hành động widget trong trang |
| `mcp` | MCP `ask_clark`, gửi kèm `x-clarkcant-surface: mcp` |
| `relay` | relay WebSocket, gửi kèm `x-clarkcant-surface: relay` |
| `cli-api` | mọi người giữ token khác: `clarkcant api`, một script, hoặc mọi giá trị khác của header |
| `automation` | tác vụ của một tự động hoá đã lên lịch hoặc thường trực |
| `peer` | tác vụ một node khác uỷ cho node này |
| `channel` | một tin nhắn trên kênh nhắn tin bên ngoài được gắn với cuộc trò chuyện (chỉ dịch vụ kênh của node đặt giá trị này) |

Một trường trong thân như `"origin": "person"` bị bỏ qua, nên một bề mặt máy không thể tự nhận là người dùng. Token là
ranh giới tin cậy, giống như với `surface`: người giữ token tự gửi header của ô soạn thảo được xem như chính trang.

Nguồn gốc được chuyển cho chính sách thực thi như một phần của ý định, và được ghi trên thẻ duyệt mà lượt đó tạo ra,
trên dòng của nó trong `GET /activity` (`origin`), và trong nhật ký audit. Mặc định nó không đổi quyết định nào: một
lượt do ứng dụng AI bắt đầu qua MCP được quyết định y như tin nhắn của chính người dùng. Người muốn chặt hơn đặt
`machineTurns` của chính sách thành `"ask"` (preference `execution.machineTurns`, hoặc Cài đặt → Kiểm soát → Yêu cầu
từ chương trình khác). Khi đó một lượt từ `mcp`, `relay` hoặc `cli-api` sẽ hỏi trước một tác động rủi ro
(`external-write`, `destructive`, `financial`, `communication`, `media-capture`) mà chính sách lẽ ra đã chạy. Quy tắc
từ chối hoặc lệnh cấm vẫn thắng; việc đọc, ghi cục bộ, lượt của chính người dùng, tự động hoá và node ngang hàng không
đổi.

Nguồn gốc đi theo công việc mà nó bắt đầu:

- Khi người dùng duyệt một thẻ do lượt của một chương trình tạo ra, lượt tiếp tục sau khi duyệt vẫn giữ nguồn gốc của
  chương trình đó. Người dùng chỉ duyệt đúng một tác động, không duyệt phần còn lại trong kế hoạch của chương trình, nên
  với `"ask"` bước rủi ro tiếp theo vẫn được hỏi lại. Dòng audit và hoạt động của tác động đã duyệt cũng giữ nguồn gốc.
  Không ai gõ tin nhắn người dùng mà lượt đó trả lời, nên node lưu nó kèm
  `hostWritten: { "kind": "host-continuation", "version": 1 }`. Client vẽ tin nhắn như vậy thành một dòng lặng lẽ của
  host bằng ngôn ngữ của chính client ("Đã duyệt — Clark tiếp tục") thay vì lời của người dùng, và xử lý y như vậy với
  mọi kind hoặc version nó không biết; tìm kiếm và phần tóm tắt cho phiên mới đều bỏ qua nó.
- Trên route `/messages` thường, một tin nhắn tới khi có lượt đang trả lời được quyết định ngay tại đó: nhập (steer) vào
  lượt đang chạy, ngắt lượt đó, hoặc chạy nền. Một tin nhắn có nguồn gốc khác với lượt đang chạy, một tin nhắn gõ
  trong lúc đang có lượt nói bằng giọng, hoặc một tin nhắn có tệp đính kèm, không bao giờ được nhập (steer) vào lượt đó. Khi steer được chọn cho một tin
  nhắn như vậy, nó cũng không ngắt lượt đang chạy: nó chờ và được trả lời thành một lượt riêng với nguồn gốc của chính
  nó, và Stop hủy được nó trong lúc chờ. Lượt đang chạy chỉ bị ngắt khi bộ quyết định chọn ngắt, khi tin nhắn mới có
  tham chiếu, hoặc khi chạy nền mà không có worker nào nhận. Tin nhắn được chuyển sang làn chạy nền được ghi vào nhật ký audit cùng nguồn
  gốc.
- Một lượt chỉ đang được chuẩn bị — phiên của nó còn đang được tạo, hoặc việc đổi model còn chưa xong — thì chưa trả
  lời. Stop vẫn chạm tới nó, nhưng tin nhắn mới không được quyết định dựa trên nó: tin nhắn đó không bao giờ dừng nó, và
  được trả lời sau nó như mục tiếp theo mô tả. Hai tin nhắn gửi liên tiếp ngay sau khi đổi model đều được trả lời.
- Mọi cách khác để bắt đầu một lượt (route streaming, phần tiếp tục sau khi duyệt, một câu hỏi đã được trả lời, giọng
  nói) không bao giờ gửi prompt thứ hai cho một lượt đang chạy. Văn bản thuần cùng nguồn gốc, không có tệp đính kèm, tham
  chiếu, chỉ dẫn hay dữ liệu và không phải lời nói, được nhập (steer) vào lượt đó trong lúc câu trả lời đang được viết;
  câu trả lời đó trả lời luôn tin nhắn này, và phản hồi của tin nhắn cùng event `done` của stream báo
  `resolution: "steered"` và không có message id nào (`clarkcant ask` báo điều này trên stderr). Chữ gõ không bao giờ
  nhập vào một lượt nói. Mọi tin nhắn khác chờ lượt đang chạy kết thúc rồi trở thành một lượt riêng, đọc tệp đính kèm và
  tham chiếu của chính nó. Một tin nhắn đang chờ giữ request HTTP (hoặc stream) của nó mở cho tới khi lượt của chính nó
  trả lời xong. Stop, dừng khẩn cấp hoặc node tắt đều kết thúc mọi tin nhắn còn đang chờ, nên không tin nhắn nào trong số
  đó được bắt đầu; thẻ trả lời của nó nói rằng nó đã được dừng trước khi bắt đầu và vẫn được lưu.
- Thao tác widget bị từ chối với `TURN_IN_PROGRESS` khi lượt của cuộc trò chuyện đang chạy hoặc đang được chuẩn bị; hãy
  bấm lại khi câu trả lời đã xong. Thao tác widget cho làn chạy nền không chờ lượt.

`machineTurns` là một phần của chính sách thực thi, và các route chính sách (`PUT /preferences/execution.policy`,
`execution.machineTurns`, các route `/undo` của chúng, và `POST /autonomy`) mở cho mọi người giữ token, kể cả relay và
`clarkcant api`. Vì vậy một chương trình giữ token của node có thể đổi cài đặt này. Hoàn tác `execution.machineTurns`
chỉ đặt lại đúng lựa chọn đó; nó trả về `undone: false` khi lần ghi chính sách gần nhất không đổi lựa chọn này.

Lượt `channel` khác với các bề mặt máy: người gửi là một người trên kênh bên ngoài, không phải người giữ token của node
này, và việc lượt đó được làm gì tùy vào người đó là ai. Node quyết định điều này từ principal mà tài khoản của người gửi
được ánh xạ tới, không bao giờ từ tên hiển thị hay nội dung tin nhắn:

- **Chủ sở hữu.** Tài khoản của chính chủ sở hữu, hoặc bất kỳ tài khoản bên ngoài nào được liên kết với principal của chủ
  sở hữu, hành động như chủ sở hữu: lượt đó có ngữ cảnh của chủ sở hữu và được quyết định bởi chính sách thực thi duy
  nhất như mọi lượt khác, không hỏi thêm.
- **Người tham gia.** Bất kỳ ai khác. Lượt đó không nhận bộ nhớ, chỉ dẫn cá nhân hay chỉ dẫn dự án, ngữ cảnh màn hình
  hay các tệp ngữ cảnh trên máy của chủ sở hữu, và chạy trên một phiên model riêng (phiên đã phục vụ chủ sở hữu không bao
  giờ được dùng lại cho nó). Host nói với model rằng người gửi không phải chủ sở hữu. Trò chuyện (trả lời trong cùng
  luồng, một khung xem hay một câu hỏi đặt vào đó) vẫn tự chủ; mọi lời gọi công cụ khác chỉ chạy khi một quyền thường trực trên binding bao gồm công cụ đó
  (`grantRefs`, mỗi mục dạng `tool:<tên>`) hoặc chủ sở hữu đã duyệt đúng lời gọi đó. Nếu không, lời gọi bị giữ lại,
  không có gì chạy, và chủ sở hữu được hỏi bằng một thẻ duyệt trong cuộc trò chuyện; duyệt thì lượt tiếp tục dưới tư
  cách người tham gia và cho đúng lời gọi đó chạy một lần. Việc quyết định một yêu cầu duyệt không bao giờ được mở cho
  người tham gia.

Đối tượng mặc định của binding nhận mọi người trong không gian đã gắn; các quy tắc trên là thứ giữ cho điều đó an toàn.
Tin nhắn người dùng như vậy còn mang `authorPrincipalId` (principal mà người gửi trên kênh
được ánh xạ tới, để bản ghi phân biệt được nhiều người nói) và, khi nó trả lời một tin nhắn của cuộc trò chuyện này,
`inReplyToMessageId`. Cả hai đều không bắt buộc, chỉ node đặt, và không có trên mọi tin nhắn khác. Bản build này chưa
kèm nhà cung cấp kênh nào và chưa có route HTTP nào nhận dữ liệu từ kênh; phần nền được mô tả trong
[system-architecture.vi.md](system-architecture.vi.md) (§7.3, "Kênh nhắn tin bên ngoài").

### Model nào đã trả lời: ghi chú model

Mỗi lượt của model kết thúc bằng một `system-card` của host có `subject` là `"connection"`: ghi chú cho biết model nào
đã trả lời. Các `fields` của nó là những dòng để đọc, được viết bằng ngôn ngữ của chủ node lúc ghi. Cùng các dữ kiện đó
cũng nằm trên thẻ dưới dạng dữ liệu, nên client không bao giờ phải đọc nhãn của một dòng:
`modelNote: { "version": 1, "elapsedMs": <số nguyên ≥ 0>, "fallback"?: { "from": "<provider/model>" } }`.
`elapsedMs` là thời gian model đã dùng, đúng con số mà dòng thời gian hiển thị. `fallback` chỉ có khi một model dự phòng
trả lời thay cho model người dùng đã chọn, và `from` là tên model đã chọn. Thẻ được ghi trước khi có trường này thì không
có `modelNote`. Client gặp thẻ không có trường này, có version mà nó không biết, hoặc có ghi chú nó không đọc được, thì
quay về đọc các dòng.

### Xoá hội thoại

Lệnh gõ “xoá hội thoại này” và lệnh nói tương ứng cùng đi qua intent `conversation.delete` như capability REST.
`POST /conversations/{id}/delete` nhận `{}`. Policy thực thi hiện tại quyết định chạy, hỏi hay từ chối: chế độ tự trị
làm theo yêu cầu rõ ràng của người dùng; chế độ guarded/ask hoặc rule yêu cầu hỏi có thể trả `202` cùng
`{ deleted: false, decision: { kind: "needs-confirmation", intent, readBack, confirmationToken } }`. Trả lời bằng
`POST /app-intents/confirm` trên bề mặt của người dùng, gửi token và `decision: "granted" | "denied"`. Khi được duyệt,
decision có `intent.deletionPermit`; gửi nó về route xoá ban đầu. Quyền này ràng buộc với principal và đúng hội thoại,
hết hạn sau hai phút và chỉ được dùng một lần trong transaction xoá. Từ chối làm token xác nhận hết hiệu lực nhưng
không xoá dữ liệu. Policy được kiểm tra lại; rule từ chối mới luôn thắng quyền đã duyệt trước đó.

`200` báo `{ deleted: true, conversationId, attachments, artifacts, pendingFiles, readBack }`. `409` cùng
`{ deleted: false, decision: { kind: "refused", say } }` giải thích cái gì được giữ và bước tiếp theo. Task chưa kết
thúc, đang tạm dừng hoặc chưa rõ kết quả, lượt trả lời, công việc nền và thao tác widget còn đang xử lý kết quả đều
chặn việc xoá. Foreign key vẫn bật; các row của hội thoại, tệp đính kèm, mọi artifact widget (kể cả tệp đã cố định
nhưng chưa đính kèm), grant và hàng đợi dọn tệp commit cùng nhau. Tệp vật lý chỉ bị xoá sau commit; byte dùng chung
được giữ lại. Tệp đang khoá nằm trong hàng đợi dọn lúc khởi động/định kỳ; `pendingFiles` báo số tệp còn chờ.

Không giữ bản sao để Hoàn tác vì mục tiêu là giải phóng tệp và hạn mức. Bộ nhớ đã lưu, tài nguyên độc lập, nhật ký phiên
và lịch sử kiểm toán/đồng bộ chỉ ghi thêm vẫn còn. Client chỉ chuyển sang hội thoại mới khi xoá thành công. Mất phản hồi
mạng nghĩa là chưa rõ kết quả, nên tải lại trước khi thử lại. MCP, relay WebSocket và `clarkcant api` từ chối route xoá
cùng route xác nhận bằng `403 PERSON_ONLY`; app intent do agent yêu cầu cũng không được xoá.

### Báo lỗi và đề xuất tính năng

Báo lỗi hoặc đề xuất tính năng cho chính ClarkCant được gửi từ hội thoại, và chỉ tới repo chuẩn `digitopvn/clarkcant`:
đích đến lấy từ cấu hình tin cậy, không trường nào trong yêu cầu đổi được nó. `/report` một mình (hoặc chỉ kèm loại)
gọi Feedback Composer, một `feedback-card` do host sở hữu: Lỗi hay Tính năng, lời của người dùng, và mục "Những gì sẽ
được chia sẻ" mở ra khi cần. `/report bug ...`, `/report feature ...` (hoặc `lỗi`, `tính năng`) đi tới cùng service
báo cáo qua bộ xử lý lệnh slash; một câu nói với Clark và giọng nói đi tới đó qua công cụ model `report_feedback`. Các
cách này chỉ chuẩn bị: chúng hiện issue đúng như sẽ được gửi, kèm nút Create issue, và không gửi gì. Chỉ cú bấm của
người dùng trên thẻ đó mới gửi báo cáo; Clark, công cụ của nó và giọng nói đều không thể.

| Method | Path | Body và phản hồi |
|---|---|---|
| POST | `/feedback/reports` | `{ request, conversationId? }` — `201 { draft, diagnostics }`. Chuẩn bị và lưu bản nháp; chưa gửi gì |
| GET | `/feedback/reports/{reportId}` | `{ draft, status, publication? }` |
| POST | `/feedback/reports/{reportId}/publish` | `{ conversationId, intent?: "send" \| "check" \| "send-anyway", answers? }` — `{ publication, eligibility?, messageId, timeline }`, kèm thẻ kết quả ghi vào hội thoại. **Chỉ người dùng** |

`request` là `{ kind: "bug" | "feature", description, source, includeDiagnostics?, title?, subsystem?, bug?, feature?,
evidence?, error?, philosophy? }`. Phần nào không ai nói tới thì bị bỏ khỏi issue, và bước tái hiện không ai đưa ra
được ghi "Not known yet." Chẩn đoán an toàn được chia sẻ mặc định và có thể tắt: phiên bản ClarkCant, hệ điều hành và
kiến trúc, runtime, ngôn ngữ và cách nhập, phần liên quan, provider và model, cùng lỗi dưới dạng trích đoạn 300 ký tự
đã che bí mật với dấu vân 12 ký tự hex. Không thu thập transcript, system prompt, tệp, biến môi trường, log thô, đường
dẫn thư mục home hay thông tin đăng nhập, và mọi văn bản gửi ra ngoài đều qua bộ che bí mật dùng chung, thư mục home
được thay bằng `~`. Đề xuất tính năng kèm mức phù hợp triết lý (`aligned`, `aligned-with-constraints`,
`material-conflict`); luật của host và đánh giá của model được kết hợp, mức chặt hơn được giữ, và yêu cầu xung đột vẫn
được gửi đúng như người dùng nói.

Trước khi gửi, các issue đang mở và issue đóng trong 90 ngày gần nhất được tìm. Khớp mạnh với một issue đang mở (cùng
dấu vân lỗi, hoặc gần như cùng tiêu đề và mô tả) thì bình luận vào issue đó thay vì tạo issue mới.
`publication.status` chỉ là `published` sau khi đọc lại GitHub và thấy dấu ẩn `<!-- clark-report:rpt_... -->` của báo
cáo. `intent` mặc định là `send`; `answers` nêu thẻ mà cú bấm nằm trên, để từ đó thẻ ấy hiện là đã dùng, kể cả sau
khi tải lại. Lần ghi không nhận được phản hồi là `unknown`, và thẻ của nó có nút Kiểm tra lại (`intent: "check"`), chỉ
tìm dấu và không bao giờ gửi; kiểm tra một báo cáo chưa từng gửi trả `409 NOTHING_SENT`. Khi danh sách của chính GitHub
cho thấy không có dấu ít nhất hai phút sau lần thử (tính từ lúc thử gửi, không phải lần kiểm tra gần nhất), báo cáo
chuyển thành `failed` kèm `retryable`, và thẻ có nút Gửi lại, gửi nó lần đầu tiên. Không gửi gì khi chưa kiểm tra được
GitHub. Dấu được tìm trong các issue do chủ token mở (`creator`, lấy từ `GET /user`), tối đa ba trang 100 mục. Khi danh
sách đó vẫn dài hơn phạm vi đọc, hoặc sổ hiệu ứng không còn ghi lần thử, việc kiểm tra không thể ngã ngũ: báo cáo là
`unknown` kèm `inconclusive: { since, searchUrl, manualUrl }`, và thẻ ghi "Clark không thể biết GitHub đã giữ báo cáo
này hay chưa, và kiểm tra lại cũng không thay đổi được điều đó." Thay cho Kiểm tra lại, thẻ dẫn tới các issue người dùng
đã mở từ lần thử và trang tạo issue đã điền sẵn, cảnh báo rằng gửi lại có thể tạo bản trùng, và có nút Vẫn gửi
(`intent: "send-anyway"`, chỉ nhận cho báo cáo như vậy, nếu không thì `409 NOT_INCONCLUSIVE`), có thể gửi nó hai lần.
Node không bao giờ tự gửi lại. Khi node khởi động, mọi báo cáo còn ở `publishing` hay `unknown` được kiểm tra theo cùng cách, và kết quả đã ngã
ngũ được ghi vào hội thoại của nó thành thẻ kết quả. Các trạng thái khác là `needs-access` (chưa có `github_token`; kèm
`manualUrl`, trang tạo issue của GitHub đã điền sẵn) và `refused`. Lần ghi là một hiệu ứng `external-write` trong sổ
hiệu ứng, và policy thực thi áp dụng cho cú bấm của người dùng: luật hay lệnh cấm từ chối thì báo cáo là `refused` và
không gửi gì, còn policy lẽ ra sẽ hỏi thì chính cú bấm là câu trả lời, và được ghi lại như vậy. Token là thông tin đăng
nhập GitHub người dùng đã đặt cho nguồn signal, đọc qua secret broker với consumer `feedback:github`. Các `@handle`
trong lời người dùng được vô hiệu hoá để việc gửi báo cáo không thông báo cho ai.

Báo cáo đã gửi kèm `eligibility`: Clark có được tự xử lý issue hay không. Các kiểm tra gồm repo, trạng thái mở, epic
(`suggestion: "plan-split"`), người được giao, nhãn in-progress, `external-gate` và `blocked`, pull request đang mở,
bình luận nhận việc, issue chặn còn mở được nêu trong nội dung, việc dở dang của chính Clark, và xung đột triết lý.
Trong bản này mọi báo cáo đều kết thúc `eligible: false` với `code: "handling-unavailable"`, vì backend chạy nền chuẩn
(#402) và hợp đồng phát hành (#508) mà nó cần chưa có; không có nút Handle nào. Node khởi động với `CC_GITHUB_FIXTURE=1`
gửi tới một GitHub trong tiến trình thay vì repo thật, dành cho bộ test trình duyệt.

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
cơ bản; hiện là `["notice", "skip", "capabilities", "artifacts"]`) và `label` (tên nó tự gọi mình), và phản hồi `409` `SEQUENCE_GAP` cũng vậy
(`{ code, expected, received, features, label }`). Bên gửi ghi cả hai cho peer đó, chỉ từ câu trả lời cho một thứ nó đã
giao qua kênh đã xác thực; lời mời ghép cặp cũng có thể mang `features`. Feature lạ bị bỏ, label được làm sạch và cắt
còn 64 ký tự, và một peer chưa cho biết gì — một bản dựng có trước thay đổi này — không được gửi thông báo hay skip cho
tới khi một câu trả lời nói nó nhận. Bên gửi chỉ đọc tối đa 16 KiB của một câu trả lời, trong hạn 30 giây của lần giao;
câu trả lời vượt một trong hai bị bỏ qua, và message vẫn được xác nhận khi mã của nó là `200`.

Một node có quảng bá `capabilities` trả lời `GET /peers/capabilities` cho một peer đã ghép cặp, với peer token dẫn xuất
của peer đó (mọi trường hợp khác là `401` `UNAUTHENTICATED`), bằng `{ version: 1, allowed, waits, capabilities: [{
ref, ready }] }` — một object nghiêm ngặt, tối đa 32 mục, chỉ dựng từ allowance mà chủ node đó đặt cho peer hỏi: các capability ref
mà allowance bao và việc node hiện có chạy được từng ref không; `allowed: false` với danh sách rỗng khi không có
allowance. `waits` cho biết một lượt chạy peer hỏi giao sang mà node chưa bắt đầu được sẽ chờ ở đó (`true`) hay bị từ
chối ngay (`false`: node chưa nghe rằng peer có quảng bá `capabilities`), và cảnh báo lúc thiết lập chỉ nói lượt chạy
sẽ chờ khi nó là `true`. Không có thư mục, capability khác hay lý do nào trong đó. Bên hỏi chờ tối đa 5 giây, từ chối redirect, và bỏ
nguyên câu trả lời không khớp đúng schema; `list_peers` và `create_automation` có `executor` dùng nó để hiển thị và cảnh
báo, không bao giờ để từ chối. Khi một lần giao phải chờ một capability trên node nhận, và bên gửi có quảng bá
`capabilities`, bên nhận gửi message NodeLink `status` có payload `{ taskState: "waiting_capability", taskRevision,
message, capabilityRef }`, rồi cùng payload đó với `taskState: "running"` khi task bắt đầu chạy. Việc chờ không có giới hạn thời gian; cả hai chủ node được báo khi nó bắt đầu chờ, và bên gửi có
thể dừng nó. Bên gửi không quảng bá `capabilities` thì bị từ chối ngay như trước.
Envelope vẫn ở phiên bản giao thức 1; chính feature được quảng bá là thứ đánh phiên bản cho route và các status này. Xem
[distributed runtime](distributed-runtime.md).

Với một bên gửi có quảng bá `artifacts`, node đã chạy một task được giao đề nghị gửi lại từng tệp mà worker của nó ghi,
mỗi tệp trong một message NodeLink `artifact.offer` riêng cho `taskId` đó, xếp hàng trước `result`: payload `{ artifact:
{ artifactId, digest, sizeBytes, mimeType, classification, originNodeId }, digest, sizeBytes, classification, name }`,
trong đó `name` là đường dẫn của tệp tương đối với thư mục nơi nó được ghi (tối đa 200 ký tự, được coi là dữ liệu).
`evidence.artifacts` của `result` nêu đúng các tệp đó dưới dạng `[{ artifactId, digest, name, sizeBytes, mimeType }]` —
tối đa 8 tệp, mỗi tệp tối đa 4 MiB, digest dạng `sha256:<64 hex>`. Bên gửi trả lời từng lời đề nghị là `accepted` hay
không kèm `reason`, chỉ dựa trên grant của chính chủ nó cho task đó: `budget.maxArtifactBytes` của grant, tính dồn qua
các tệp của task, trong đó không đặt hoặc bằng 0 thì không nhận tệp nào. Sau đó nó kéo tệp đã nhận từ `GET
/peers/artifacts/{digest}` bằng peer token dẫn xuất của nó; node đề nghị chỉ phục vụ một digest cho đúng peer nó đã đề
nghị (`401` khi không có peer token, `404` trong mọi trường hợp khác, giống như một digest không biết), và bên gửi không
đọc quá kích thước đã đề nghị và kiểm tra digest trước khi lưu. Node đề nghị chỉ gửi tệp khi grant của bên gửi cho task
đặt hạn mức byte lớn hơn 0 và allowance của chính chủ nó cho bên gửi đó cũng đặt một hạn mức (`allow_peer_tasks` nhận
`maxArtifactBytes`, 0 đến 16 MiB; không đặt thì là không có), cả hai đều bao gồm lớp `internal`, và trong phạm vi hạn mức
nhỏ hơn. Nó bỏ mọi đường dẫn worker báo nằm ngoài các thư mục của task, không bao giờ đề nghị gửi loại markup hay script,
và nêu tên từng tệp nó bỏ ra trong lời nhắn của `result` mà không lưu tệp đó. Các MIME type bị chặn được so khớp sau khi
chuyển về chữ thường và bỏ tham số. `create_automation` nhận `maxArtifactBytes` (0 đến 16 MiB,
chỉ khi có `executor`). Bên gửi không quảng bá `artifacts` không được đề nghị tệp nào. Envelope vẫn ở phiên bản giao
thức 1; feature được quảng bá là thứ đánh phiên bản cho các lời đề nghị và `evidence.artifacts`.

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
(những gì đang chờ người dùng, các thông báo, các thông báo đang hoãn, các loại đang tắt báo và các phiên bản đã bỏ
qua), `GET /inbox/summary`,
`POST /inbox/read` và `/inbox/unread`, với từng thông báo là `POST /inbox/notices/:id/<action>` trong đó action là
`dismiss`, `restore`, `snooze`, `unsnooze`, `suppress`, `unsuppress`, `skip-version` hoặc `unskip-version`, và
`DELETE /inbox/suppressions/:id` cùng `DELETE /inbox/skipped-versions/:kind/:name/:version` (`package` hoặc `pi`, mỗi phần
được URL-encode) để rút lại một lần bỏ qua từ danh sách, kể cả khi thông báo của nó đã không còn.
`snooze` nhận `{ "until": "<ISO instant>" }`, nằm sau hiện tại và không xa quá 30 ngày (nếu không thì
`400 SNOOZE_OUT_OF_RANGE`); thông báo rời khỏi danh sách và số chưa đọc, rồi quay lại ở trạng thái chưa đọc khi đã qua
thời điểm đó; `unsnooze` đưa nó trở lại ngay, đã đọc hay chưa đọc như trước khi hoãn. `suppress` tắt báo loại của thông
báo cho principal này: các thông báo cùng loại về sau vẫn được liệt kê nhưng đến ở trạng thái đã đọc và không hiện thông
báo. Chỉ loại đủ hẹp mới tắt báo được, tức loại gắn với một việc tự động, một nguồn tín hiệu, một gói, một node, hoặc
việc nền của chính người dùng; loại khác sẽ tắt luôn cả lời nhắc và thông báo của mọi việc tự động khác, nên route từ
chối bằng `409 SUPPRESSION_TOO_BROAD` và `actions` của thông báo không bao giờ đưa ra thao tác này. `skip-version`
ngừng báo cập nhật cho principal này về phiên bản mà thông báo đã lưu nêu, và mọi bản cũ hơn, rồi bỏ thông báo; body
nào gửi kèm cũng bị bỏ qua, thông báo không nêu phiên bản thì trả `409 NOT_AN_UPDATE`, và `unskip-version` hoàn tác
việc đó. Mỗi route chỉ tác động lên thông báo của chính principal gọi nó.
`POST /effects/:effectId/reconcile` với `{ "outcome": "confirmed" | "failed", "source"?: "click" | "chat" | "voice" }`
ghi nhận điều người dùng thấy về một thao tác chưa rõ kết quả (một lệnh do task chạy, hoặc một biểu mẫu mà việc trên
trình duyệt đã gửi nhưng trang không bao giờ trả lời), tức câu trả lời mà thông báo chưa rõ kết quả đưa ra
thành hai nút: `404 RESOURCE_NOT_FOUND` với effect thuộc task của principal khác, của node khác, hoặc không tồn tại,
`409 EFFECT_NOT_UNKNOWN` khi nó không còn ở trạng thái chưa rõ; route này chỉ dành cho người dùng, như bên dưới.
`source` là nhãn do bên gọi gửi để cho biết câu trả lời được đưa ra ở đâu và được lưu đúng như vậy, không phải
nguồn gốc đã xác minh; ai trả lời là principal đã xác thực. `actions` của một thông báo (tối đa 12) cũng có thể đưa
ra thao tác trên chính thứ được nói tới, mỗi thao tác có route thật phía sau: `retry` là `POST /work/:id/retry` (chạy
lại một lần việc nền bị lỗi, bị dừng hoặc bị gián đoạn thành việc mới trong cùng hội thoại), `ask-again` là
`POST /conversations/:id/questions/:questionId/ask-again` (hỏi lại một câu hỏi đã hết hạn thành câu hỏi mới),
`update` là `POST /packages/install` thông thường với phiên bản mà thông báo nêu, và `review-update` mở Cài đặt.
Thông báo cập nhật gói còn mang `reachChange` khi gói đã được cài: phạm vi tiếp cận mà listing của phiên bản được nêu
có so với manifest đang cài, dạng `{ verdict: "wider" | "narrower" | "unchanged", profile?, gpu?, origins, secrets,
keyDestinations, browserTokens, connectionScopes, connectionEndpoints }`, mỗi tập là `{ added, removed, addedMore?,
removedMore? }` với tối đa 32 mục mỗi danh sách và phần còn lại được đếm, `keyDestinations` là từng cặp (key, origin) mà
một key được gửi tới, và `profile` gồm tên hai mức tài nguyên kèm từng giới hạn có đổi; hoặc `{ verdict: "unknown" }`
khi gói đang được cài ở phiên bản khác và không so sánh được hai bản (`packages/contracts/src/reach-change.ts`). Thông báo
còn mang `unreadFields` (`{ count, names }`) khi listing của phiên bản được nêu có những trường node này không đọc được
và đã bỏ đi, để thay đổi được hiển thị không bị coi là toàn bộ những gì listing nói. Web
client đọc `GET /inbox` theo từng mục, nên một mục không khớp hợp đồng bị bỏ ra và được đếm, thay vì làm hỏng cả hộp
thư. Thao
tác được liệt kê kèm `unavailable` (`conversation-gone`, `work-gone`, `package-gone`, `already-current`) nói rõ vì
sao lúc này không làm được. Hình dạng dữ liệu ở `packages/contracts/src/inbox.ts`; hành vi được mô tả trong
[system-architecture.vi.md](system-architecture.vi.md) ở phần hộp thư.

Các route theme gọi được với cùng token nhưng **chưa** có trong `/openapi.json` và có thể thay đổi. `GET /themes` trả
về `{ themes, problems, unchecked }`: Clark Default đứng đầu, rồi đến mọi theme mà facet `themes` của các gói đã cài
cung cấp, mỗi theme kèm `themeRef` (`package:<package id>#<theme id>`) và nơi cung cấp (package id, phiên bản, digest,
trust lane và source tier); `problems` nêu tên từng theme không qua được kiểm tra, còn `unchecked` nêu từng gói đã cài
mà node này không đọc được tệp. Theme có màu không qua được bài kiểm tra tương phản mà Clark Default phải qua
(`requiredPairs` trong `packages/design-tokens/src/contrast.ts`) cũng là một `problems`, kèm danh sách `contrast` gồm
các cặp màu không đạt, và không được liệt kê để chọn. Mỗi cặp là `{ scheme, foreground, background, ratio, minimum }`:
chế độ màu, tên hai token màu, tỉ lệ đo được làm tròn hai chữ số thập phân và tỉ lệ cần đạt. Theme đọc được nhưng làm
một trạng thái được bảo vệ khó phân biệt (nguy hiểm với cảnh báo hoặc thành công, một trạng thái với chữ thường, vòng
tiêu điểm với các đường viền khác, chữ bị vô hiệu với chữ bình thường, đường viền với thẻ hoặc nền trang, chữ, màu
trạng thái, màu nhấn hay vòng tiêu điểm trên bề mặt có hiệu ứng hoặc trên nền trang dưới lớp nền và ánh sáng theo con
trỏ, hay một Orb mặc định có ánh sáng chìm vào nền trang) cũng là một `problems` theo cùng cách, nhưng kèm danh sách
`protected`: mỗi mục là `{ scheme, check, first, second, value, minimum }`, trong đó `check` là một trong
`status-distinct`, `status-vs-text`, `focus-vs-border`, `disabled-distinct`, `edge-visible`, `surface-readable` hoặc
`orb-visible`, còn `value` là khoảng cách cảm nhận (OKLab ΔE × 100), hoặc tỉ lệ tương phản với `surface-readable`.
`first` là tên một token màu, hoặc `"orb"` với `orb-visible`, mục đo ánh sáng sáng nhất mà Orb của theme thêm vào so
với `canvas`. Các trường `message` là tiếng Anh, dành cho log; client diễn đạt lỗi cho người đọc từ `code`, `contrast`
và `protected`, và diễn đạt một `code` nó không biết bằng một câu chung. `GET /appearance` trả về thứ trang
cần vẽ: `selectedRef` (preference `experience.themeRef`, được chọn bằng `PUT /preferences/experience.themeRef`
`{ "value": "<themeRef>" }`), `appliedRef`, tài liệu `theme` đã kiểm tra (`null` với Clark Default), `provider` của
nó, và `fallback` `{ code, message, contrast?, protected? }` khi lựa chọn không vẽ được — `THEME_NOT_INSTALLED`,
`THEME_INVALID`, `THEME_LOW_CONTRAST` (mã duy nhất kèm `contrast`), `THEME_PROTECTED` (mã duy nhất kèm `protected`),
`THEME_UNAVAILABLE` hoặc `THEME_UNKNOWN` — khi đó Clark Default được vẽ và `selectedRef` vẫn được giữ, nên cài lại gói
là theme quay lại. Khi ghi `experience.themeRef`, tham chiếu được kiểm tra trước: tham chiếu mà node này không vẽ được
sẽ bị từ chối bằng `409` kèm đúng mã, lý do và `contrast` hoặc `protected` đó, và không có gì được lưu. Node
không đẩy thay đổi gói về client: client đọc lại `/appearance` sau khi chính nó thay đổi một gói và khi cửa sổ được
nhìn lại. Hình dạng dữ liệu ở `packages/contracts/src/themes.ts`.

`GET /appearance?themeRef=<tham chiếu đã encode>` phân giải chủ đề đã kiểm tra để preview chỉ đọc, không ghi
preference. Tham chiếu sai hình dạng trả `400`; chủ đề không có trả fallback thường. Diện mạo cá nhân thêm
`customization: { accent, density, font, codeFont }` khi có: accent là `null` hoặc `{ dark: "#RRGGBB", light: "#RRGGBB" }`, density
là `comfortable | compact`, font là `null` hoặc một profile phông chữ thân (`clark | system | serif | rounded | mono | inter | geist`,
áp dụng cho cả nội dung và tiêu đề), codeFont là `null` hoặc một profile phông mono (`clark | typewriter | jetbrains | geist-mono`);
`null` giữ phông của chủ đề. Ghi qua preference đã đăng ký `experience.accent`, `experience.density`, `experience.font`
và `experience.codeFont`.
Màu nhấn phải qua kiểm tra cả hai chế độ và trạng thái bảo vệ trước khi ghi (cả khi chọn chủ đề với màu nhấn đã lưu);
từ chối trả `409`, giữ nguyên dữ liệu. `customizationFallback` nói vì sao bản cập nhật đã cài làm màu nhấn cũ không
an toàn; màu của chủ đề được vẽ và preference cũ vẫn giữ. Compiler sở hữu các lựa chọn này, nên renderer iframe và
detached nhận cùng snapshot có giới hạn. `experience.recentThemes` chứa tối đa sáu tham chiếu khác nhau, cập nhật
nguyên tử cùng một lần ghi chủ đề đã đăng ký.

Widget nhận `AppearanceSnapshot` công khai đã phân giải thay vì phản hồi theme thô này. Bridge v2 có thể mang
`appearance` trong init kèm `appearance@1`, rồi gửi
`{ kind: "appearance.changed", nonce, revision, appearance }` có revision trùng khớp, được kiểm tra source/nonce.
SDK không phụ thuộc DOM cung cấp `appearance.current()` / `subscribe(handler)` với snapshot đóng băng sâu; không có
lệnh ghi state hay cấp capability đi kèm. Relay bootstrap/event của desktop tách cửa sổ mang cùng revision đã kiểm
tra và không mang thông tin xác thực. Định nghĩa widget có thể khai báo `appearanceMode: "adaptive" | "fixed"`
(thiếu nghĩa là thích ứng); directory có thể mang `widgetAppearance: [{ id, mode }]` như khai báo khám phá, không phải
nguồn cấp quyền, và mỗi dòng của card `marketplace-results` lặp lại chúng theo cùng schema đó. Xem [cách viết widget và tương thích bridge](widget-development.vi.md#diện-mạo-appearance1).

Tài liệu theme khai báo `appearanceApi.min` là 2 còn có thể chọn phần còn lại của diện mạo, luôn bằng tên hoặc số có
giới hạn và không bao giờ bằng CSS: `typography` (bộ phông và độ đậm tiêu đề), `border`, `shadow`, `motion` (tốc độ và
đường cong; giảm chuyển động vẫn là không chuyển động dù theme nói gì), `icons`, `radius.field`, `recipes` (một recipe
do host sở hữu cho mỗi nút, thẻ, ô nhập, hộp thoại, nhãn và ô soạn tin), `effects` (nền: lưới chấm, lưới kẻ, đường quét,
hạt hoặc giấy; lớp hoàn thiện bề mặt: kính, phát sáng nhẹ, giấy hoặc hạt; mỗi hiệu ứng có cường độ trong giới hạn) và
`orb` (một preset Orb mặc định kèm màu tùy chọn, chỉ dùng khi người dùng chưa tự chọn Orb). Trường, recipe hay hiệu ứng
lạ, hoặc giá trị ngoài giới hạn, đều bị từ chối. Các app intent về diện mạo là `appearance.set-theme` (`themeRef`),
`appearance.set-color-scheme` (`colorScheme`: `light`, `dark` hoặc `system`), `appearance.reset` (Clark Default, theo
hệ thống) và `appearance.open-theme-gallery`. `POST /app-intents` và `control_app` của agent đều nhận chúng; theme được
đối chiếu với các theme của node này và bị từ chối bằng một câu nói rõ khi không vẽ được. Không intent nào hỏi xác nhận.

`POST /inbox/notices/:id/actions/:action` là route duy nhất cho các thao tác của chính một thông báo, dù ai yêu cầu:
hộp thư, một câu gõ hoặc nói, agent chính và voice agent, `act_on_notice` của MCP và `clarkcant api`. Thao tác là
một trong `mark-read`, `mark-unread`, `dismiss`, `restore`, `snooze`, `unsnooze`, `suppress`, `unsuppress`, `retry`,
`update`, `skip-version` hoặc `ask-again` (`NOTICE_OPERATION_IDS`), so khớp đúng như được gửi: đoạn đường dẫn này không
bao giờ được giải mã phần trăm, nên một tên đã mã hoá như `%75pdate` nhận `400 UNKNOWN_ACTION`, không thành `update`.
Body là `{}`, hoặc mang `until` (một ISO instant, chỉ cho `snooze` và bắt buộc ở đó) và `source` (`click`, `chat`
hoặc `voice`: người dùng đã yêu cầu bằng cách nào, được ghi lại cùng thao tác; đây là nhãn, không phải nguồn gốc đã
xác minh). Trừ `mark-read` và `mark-unread`, node đối chiếu thao tác với `actions` của thông báo ngay lúc đó và từ chối
mọi thứ khác mà không đổi gì: `400 UNKNOWN_ACTION` với tên không phải thao tác của thông báo, `403 PERSON_ONLY` với
`reconcile-confirmed` và `reconcile-failed` (câu trả lời của người dùng, có route riêng bên dưới), `409 SURFACE_ACTION`
với `open`, `ask-clark`, `add-to-context`, `review-update` và `copy-details` (chúng đổi thứ đang hiện hoặc đang giữ trên
màn hình của người dùng, nên chỉ màn hình đó làm được), `404 RESOURCE_NOT_FOUND` với thông báo đã mất, đã bị bỏ hoặc thuộc principal khác,
`409 ACTION_NOT_OFFERED` khi thông báo lúc này không đưa ra thao tác đó, và `409 ACTION_UNAVAILABLE` kèm mã `reason`
(`conversation-gone`, `work-gone`, `package-gone`, `already-current`) khi thao tác được liệt kê nhưng lúc này không làm
được; client diễn đạt lý do đó cho người đọc, còn `message` tiếng Anh là để ghi log. `restore` là hoàn tác của
`dismiss`: nó đưa trở lại một thông báo bị bỏ trong năm phút vừa qua (`NOTICE_DISMISS_UNDO_WINDOW_MS`), trả `done` với
thông báo chưa bị bỏ, và `409 UNDO_EXPIRED` khi đã quá thời hạn đó. **`update` chỉ dành cho người dùng**: nó cài mã và
cấp những gì gói yêu cầu, nên relay WebSocket, `clarkcant api` và MCP từ chối route này với `403 PERSON_ONLY`
(`isPersonOnlyRoute`), `act_on_notice` của MCP không đưa ra nó, và node từ chối bằng cùng mã đó khi `act_on_notice` của
một agent nêu tên nó. Trang của chính người dùng đi tới nó từ nút Cập nhật của thông báo, hoặc từ một yêu cầu bằng giọng
nói mà người dùng đã xác nhận. Một `update` thứ hai cho cùng thông báo trong lúc bản trước đang cài nhận
`409 ACTION_IN_PROGRESS`. `update` trả nguyên các lời từ chối của route cài đặt, và `202` với
`{ "outcome": "approval-required", "approvalId", "version" }` khi chế độ thực thi của người dùng yêu cầu hỏi trước khi
cài; khi đó không có gì được cài, và yêu cầu lần nữa trong lúc approval đó còn chờ nhận lại đúng `approvalId` đó.
Approval đó chờ trong hộp thư dưới dạng một mục `install-approval`, nơi người dùng quyết định nó (xem bên dưới). Còn
lại là `200` với `{ noticeId, action, outcome: "done" }` cùng
những gì thao tác tạo ra (`snoozedUntil`, `workId` kèm `state` và `position`, `version` kèm `pendingCapabilities` và
`deniedCapabilities` cho một bản cập nhật đã cài, `questionId`); `retry` và `ask-again` gỡ thông báo cũ, nên yêu cầu
lần thứ hai nhận `404`. Mọi thao tác, bị từ chối hay không, đều được ghi thành một sự kiện `inbox.notice-action` kèm
bề mặt đã yêu cầu nó và kết quả. Các route theo từng thao tác ở trên vẫn trả lời như trước.

Các tệp mà widget giữ theo tham chiếu (`artifacts@1`, [widget-development.vi.md §10.1](widget-development.vi.md#101-tệp-theo-tham-chiếu-artifacts1))
nằm trong `/openapi.json`. Mọi câu trả lời mang một `ArtifactRef` (`{ v, artifactId, kind, mimeType, sizeBytes, name,
digest? }`), các byte, hoặc một lời từ chối có mã nêu rõ điều gì sai (`packages/contracts/src/artifacts.ts`). Không
câu trả lời nào mang đường dẫn.

| Method | Path | Body / câu trả lời |
|---|---|---|
| GET | `/artifacts/{artifactId}` | – artifact, kèm `artifactRef` của nó nếu là tệp một widget đang giữ; của principal khác thì `404 ARTIFACT_NOT_FOUND` |
| GET | `/artifacts/{artifactId}/content` | – các byte của một artifact đã cố định, cho nút Mở của host; `409 ARTIFACT_NOT_FINALIZED` khi nó còn đang được ghi |
| POST | `/artifacts/{artifactId}/export` | `{ suggestedName? }` — Lưu thành…: các byte dưới dạng tải xuống, theo một tên tệp chứ không bao giờ là đường dẫn. **Chỉ người dùng** |
| POST | `/conversations/{id}/widgets/{instanceId}/artifacts` | `{ mimeType, name? }` — một artifact `working` mà instance này được ghi; `201 { artifactRef }` |
| POST | `/conversations/{id}/widgets/{instanceId}/artifacts/pick` | `{ name, mimeType, contentBase64, accept? }` — một tệp người dùng chọn qua giao diện của host, cấp cho instance này. **Chỉ người dùng** |
| GET | `/conversations/{id}/widgets/{instanceId}/artifacts/{artifactId}` | – ref, nếu grant của instance này vẫn còn hiệu lực |
| GET | `/conversations/{id}/widgets/{instanceId}/artifacts/{artifactId}/content?offset=&length=` | – `{ artifactRef, offset, eof, contentBase64 }`, tối đa 262.144 byte |
| POST | `/conversations/{id}/widgets/{instanceId}/artifacts/{artifactId}/chunks` | `{ offset, contentBase64 }` — tối đa 262.144 byte, bắt đầu đúng chỗ artifact đang kết thúc |
| POST | `/conversations/{id}/widgets/{instanceId}/artifacts/{artifactId}/finalize` | – cố định các byte sau khi đối chiếu chúng với kiểu đã khai báo |
| POST | `/conversations/{id}/widgets/{instanceId}/artifacts/{artifactId}/attach` | `{ name? }` – `201 { artifactRef, attachmentRef }` qua luồng đính kèm; người dùng gửi nó cùng tin nhắn kế tiếp. `name` là tên tệp widget đề xuất, được node làm sạch, giống như node làm sạch tên riêng của artifact khi không có `name` (`name` không phải chuỗi sẽ nhận `400 INVALID_SCHEMA`). Lần đính kèm đầu tiên quyết định tên: đính kèm lại cùng artifact đó sẽ trả về đúng tệp đính kèm ấy, dù đề xuất `name` nào |
| DELETE | `/conversations/{id}/widgets/{instanceId}/artifacts/{artifactId}` | – bỏ một tệp instance này đã tạo, cùng byte của nó trừ khi một tệp đính kèm hoặc bản ghi khác vẫn trỏ tới; tệp của instance khác là `403 ARTIFACT_NOT_CREATOR` |

**Trên bề mặt máy, năm route ghi đi qua chính sách thực thi.** Tạo, ghi chunk, chốt, đính kèm và bỏ tệp là việc của
widget. App của chính người dùng vẫn gọi chúng như trước. Khi MCP, relay WebSocket hoặc `clarkcant api` mang một lời gọi
như vậy, một AI client hoặc một máy từ xa sẽ ghi với tư cách widget, nên node quyết định từng lần ghi theo chính sách thực
thi của người dùng (`packages/contracts/src/machine-surfaces.ts`,
`apps/runtime/src/application/machine-artifact-writes.ts`). Mỗi lần ghi là một hiệu ứng `local-write`, trừ việc bỏ một
tệp không phải tệp đang ghi dở do chính bên yêu cầu đó bắt đầu (cùng kết nối relay, hoặc cùng bề mặt với MCP và `clarkcant api`): việc này có thể xoá bản duy nhất của người dùng, nên nó là
`destructive`, và được hỏi ở chế độ Guarded, và vì không ai trong hội thoại yêu cầu nó, cả ở chế độ Autonomous. Khi người dùng đã chọn được hỏi về các lượt từ bề mặt máy (`machineTurns: "ask"`), mỗi lần ghi được quyết định như một lượt do bề mặt đó yêu cầu: khi đó một lần bỏ tệp `destructive` vẫn được hỏi kể cả khi có quy tắc cho chạy hiệu ứng destructive, và thẻ nói rõ ai đã yêu cầu.

- **Chính sách cho chạy** (Autonomous, hoặc Guarded khi không có quy tắc nào hỏi): lần ghi chạy và trả lời như trên.
- **Chính sách hỏi** (Hỏi mỗi lần, một quy tắc yêu cầu hỏi, hoặc một lần bỏ tệp `destructive`): không có gì được ghi.
  Một thẻ phê duyệt do host sở hữu được thêm vào hội thoại của widget, viết bằng ngôn ngữ của người dùng, và bên gọi nhận
  `202 { outcome: "approval-required", approvalRequired: { approvalId }, operation, message }`. Chỉ người dùng quyết
  định thẻ đó, trên route quyết định chỉ dành cho người dùng; relay và `clarkcant api` từ chối route này với
  `403 PERSON_ONLY`, còn MCP không có công cụ nào cho nó. Mỗi thẻ là cho một tệp, không bao giờ cho từng chunk, và không
  bao giờ chứa byte. Duyệt một lệnh tạo sẽ tạo tệp và cấp một quyền ghi trên tệp đó: các chunk và lệnh chốt của nó chạy
  mà không cần thẻ khác trong 15 phút. Một chunk hoặc lệnh chốt cho một tệp đang ghi dở đã có sẽ hỏi cùng quyền ghi đó,
  và được gửi lại khi người dùng duyệt. Quyền này kết thúc khi tệp được chốt, bị bỏ hoặc hết hạn. Ai giữ quyền này tuỳ
  vào những gì node phân biệt được: qua relay WebSocket, chỉ đúng kết nối đã yêu cầu (node cấp cho mỗi socket một mã
  riêng); lời gọi MCP và các lần chạy `clarkcant api` không mang danh tính riêng của từng client, nên ở đó là mọi client
  của bề mặt đó, không chỉ client đã yêu cầu. Thẻ và biên nhận của nó nói rõ điều này, trước và sau khi người dùng quyết
  định. Đính kèm và bỏ tệp được hỏi từng lần một. Một biên
  nhận (`widget_artifact_write`, có `args.approvalId` và `args.artifactId`, hoặc `args.code` khi thất bại) trả lời mọi
  thẻ đã được quyết định, kể cả thẻ không còn chạy được vì widget đã rời hội thoại, chính sách đã đổi, tệp đã thay đổi
  hoặc thẻ đã bị sửa. Hỏi lại đúng việc đó sẽ nhận lại thẻ đang chờ; quá 8 thẻ đang chờ từ một bề mặt trong một hội
  thoại, câu trả lời là `429 APPROVALS_PENDING`. Số đếm này được giữ trong bộ nhớ, nên khởi động lại sẽ đặt lại nó;
  các thẻ đã có trong hội thoại vẫn chờ người dùng.
- **Chính sách từ chối** (một quy tắc từ chối loại hiệu ứng đó, hoặc lệnh cấm trên toàn node): `403 POLICY_REFUSED`,
  không có gì được ghi.

Một kiểu nội dung không phải media type, hoặc một mã artifact không do node cấp, bị từ chối trước khi có thẻ nào được
hiển thị, cũng như mọi thứ mà broker vốn sẽ từ chối. Mọi lần ghi do bề mặt máy mang tới đều được ghi vào nhật ký kiểm
toán (loại `widget-artifact`) cùng bề mặt (`mcp`, `relay` hoặc `cli-api`), instance widget, mã artifact, thao tác và
quyết định. Lần ghi mà chính sách cho chạy cũng có một bản ghi hoạt động sau khi broker chấp nhận nó. Cả nhật ký kiểm
toán lẫn hội thoại đều không bao giờ chứa byte của tệp. Bề mặt được đọc từ header `x-clarkcant-surface` mà các bề mặt
của chính node đặt (`clarkcant api` gửi `cli-api`); một trường trong body không bao giờ đặt được nó, và một frame
WebSocket cũng không. Một yêu cầu qua HTTP thuần không có header đó là chính token của người dùng hành động trực tiếp,
như app của người dùng, và không đi qua kiểm tra chính sách; bất kỳ bên gọi HTTP nào cũng có thể thêm header này, nên nó
chỉ có thể khiến một lần ghi phải đi qua chính sách, không bao giờ giúp lần ghi bỏ qua chính sách. Các route đọc vẫn dùng
được trên mọi bề mặt. Save As và bộ chọn tệp vẫn chỉ dành cho người dùng.

Các job của package mà widget theo dõi (`jobs@1`, [widget-development.vi.md §10.2](widget-development.vi.md#102-job-chạy-lâu-jobs1))
có trong `/openapi.json`. Một lần bấm vào binding có capability chạy dưới dạng job trả về một JobRef (`job_…`) thay vì
chờ service; các route này đọc và dừng job đó. JobRef là con trỏ, không phải quyền: node chỉ trả lời khi chính một
invoke binding của instance này đã khởi động job, trong hội thoại này, cho cùng principal, package generation và
capability. Mọi trường hợp khác, kể cả một ref không tồn tại, đều là `404 JOB_NOT_FOUND`
(`packages/contracts/src/jobs.ts`).

| Method | Path | Body / câu trả lời |
|---|---|---|
| GET | `/conversations/{id}/widgets/{instanceId}/jobs` | – `{ jobs: [...] }`, mới nhất trước và tối đa 20: các job mà chính các invoke binding của widget này đã khởi chạy, để widget được mount lại tìm thấy job đang chạy. Mỗi mục có cùng các trường như `job` của route một job và qua cùng phép kiểm tra chủ sở hữu; instance không thuộc cuộc trò chuyện là `404 INSTANCE_UNKNOWN`. Trong frame, đây là `jobs.list()`, được mở như một extension riêng của bridge, `jobs.list@1`, bên cạnh `jobs@1` |
| GET | `/conversations/{id}/widgets/{instanceId}/jobs/{jobId}` | – `{ job: { jobId, status, progress?, resultRefs, output?, error?, createdAt, startedAt?, endedAt? } }`; tệp là `ArtifactRef`, không bao giờ là đường dẫn |
| POST | `/conversations/{id}/widgets/{instanceId}/jobs/{jobId}` | – huỷ request tới service, `202 { accepted, jobId }`; job đã kết thúc là `409 JOB_NOT_RUNNING` và vẫn đọc được |

Node không có job host trả lời `503 JOB_UNAVAILABLE`. `POST /stop` cũng huỷ các job package đang chạy và đếm chúng
trong `stopped.jobs`.

Route liệt kê không bị giới hạn trong các bề mặt của riêng người dùng, theo thiết kế, giống các route một job bên cạnh
nó (`packages/contracts/src/machine-surfaces.ts` không nêu route nào trong số đó). Một client máy, như client MCP hoặc
relay, có thể liệt kê các job của một instance, output và các `ArtifactRef` của chúng mà không cần biết trước JobRef.
Nó không biết thêm gì mà nó không đọc được từng job một, và không đọc được byte của tệp qua các route này.

Token trình duyệt mà frame yêu cầu (`tokens@1`, [widget-development.vi.md §14.3](widget-development.vi.md#143-token-trình-duyệt-tokens1))
có trong `/openapi.json`. Chrome của host yêu cầu token thay cho frame mà nó đã mount, kèm session id ngẫu nhiên nó cấp
cho lần mount đó. Token chỉ được cấp cho nhà cung cấp và scope mà package của widget đã khai báo trong `browserTokens`
của facet UI, và chỉ khi node có adapter cấp được token có phạm vi cho các scope và thời hạn đó (30–3600 giây, 900 giây
khi request không nêu thời hạn). Request bị từ chối chứ không bao giờ bị thu hẹp. Node chỉ giữ token id của nhà cung
cấp và ghi audit nhà cung cấp cùng kết quả với loại `browser-token`, không bao giờ ghi giá trị
(`packages/contracts/src/browser-token.ts`).

| Method | Path | Body / câu trả lời |
|---|---|---|
| POST | `/conversations/{id}/widgets/{instanceId}/browser-tokens` | `{ session, request: { provider, scopes, ttlSeconds? } }` — `{ token: { provider, token, scopes, expiresAt } }`. Chỉ người dùng gọi được |
| DELETE | `/conversations/{id}/widgets/{instanceId}/browser-tokens/{session}` | – `{ ended: true, revoked }`; token của phiên được thu hồi nếu nhà cung cấp hỗ trợ, và request sau đó cho phiên này là `409 TOKEN_SESSION_ENDED` |

Các lời từ chối: `403 TOKEN_PROVIDER_NOT_DECLARED` hoặc `TOKEN_SCOPE_NOT_DECLARED`, `409 TOKEN_PACKAGE_NOT_ACTIVE`
hoặc `TOKEN_SESSION_ENDED`, `422 TOKEN_PROVIDER_UNSCOPED`, `TOKEN_SCOPE_NOT_SUPPORTED` hoặc `TOKEN_TTL_TOO_LONG`,
`502 TOKEN_ISSUE_FAILED`, và `503 TOKEN_PROVIDER_UNAVAILABLE` trên node không có adapter cho nhà cung cấp đó. ClarkCant
chưa kèm adapter cho nhà cung cấp nào. Node khởi động với `CC_BROWSER_TOKEN_FIXTURE=1` đăng ký các nhà cung cấp fixture
chạy trong tiến trình cho bộ test trình duyệt và trả lời `GET /browser-token-fixture/issued`; không có biến này, route
đó trả `404`. Node khởi động với `CC_UPDATE_CHECK_FIXTURE=1` trả lời `POST /update-check-fixture/run` bằng cách chạy
kiểm tra cập nhật gói một lần (`{ packageUpdates }`), để bộ test trình duyệt được đề nghị cập nhật sau khi cài; không có
biến này, route đó trả `404`.

Phía bridge (`tokens@1`) chỉ được đề nghị trong `init.extensions` cho frame có package đã khai báo token trình duyệt.
`token.request` được trả lời bằng `token-result`; SDK và phiên frame của host từ chối `state.update`,
`semantic.publish` hoặc `actions.invoke` có chứa token đã cấp với `TOKEN_NOT_ALLOWED`.


Mọi route của instance đều được kiểm tra lại theo grant của instance đó. Ref là con trỏ, không phải quyền, nên một
grant đã hết hạn (`403 ARTIFACT_GRANT_EXPIRED`) hoặc bị thu hồi (`403 ARTIFACT_GRANT_REVOKED`) sẽ chặn ngay lời gọi
kế tiếp. Kích thước, kiểu và hạn mức theo quy tắc đính kèm (`413 ARTIFACT_TOO_LARGE`, `415 ARTIFACT_TYPE_MISMATCH`,
`409 ARTIFACT_QUOTA_EXCEEDED`), và một instance giữ tối đa 128 MiB trong hạn mức đó
(`409 ARTIFACT_INSTANCE_QUOTA_EXCEEDED`), tính các tệp nó đã tạo và các tệp đính kèm nó làm từ chúng nhưng không tính
các tệp người dùng đã chọn cho nó. Đính kèm một tệp đã được đính kèm sẽ trả về đúng tệp đính kèm đó.
Tên tệp trong `Content-Disposition` được gửi theo RFC 6266: một `filename` ASCII và tên thật dưới dạng UTF-8 mã hoá
phần trăm trong `filename*`. Ký tự điều khiển bidi bị bỏ khỏi cả hai, dấu phần trăm thành `_` trong tên ASCII, và
một tên dài hơn 120 ký tự được rút ngắn ở phần trước phần mở rộng, phần mở rộng luôn được giữ.

**Listing đến từ đâu.** Directory mà một node tìm và cài từ đó được ghép từ các nguồn: file index mà
`CC_DIRECTORY_INDEX` trỏ tới, từng feed trong `CC_DIRECTORY_MARKETPLACES`, và ClarkCant Marketplace chính thức (bật
trừ khi `CC_OFFICIAL_MARKETPLACE=off`); thứ tự ưu tiên, cách làm mới và định dạng feed nằm ở
[metadata directory](widget-development.vi.md#18-directory-metadata). Card `marketplace-results` mang
`origin: { kind, label }` trên mỗi dòng khi card chứa nhiều nguồn (`kind` là `local-file`, `custom-marketplace` hoặc
`official-marketplace`), và `sources: [{ kind, label, state, fetchedAt?, reason? }]` cho mỗi nguồn chưa trả lời đầy
đủ (`state` là `stale`, `not-fetched`, `unreachable`, `unsupported` hoặc `unreadable`). Mỗi dòng còn mang `sourceId`
(`local`, `official` hoặc `custom-<hash>`), được nút Cài gửi lại. `search_directory` nhận thêm `packageId` tuỳ chọn và
khi đó liệt kê mọi version của gói đó kèm thông tin chi tiết. `POST /packages/install` làm mới một nguồn từ xa một lần
khi listing không có trong bản sao của node, trả `404 NOT_IN_DIRECTORY` có nêu tên nguồn nào chưa trả lời, và
`409 DIRECTORY_UNREADABLE` khi không đọc được nguồn nào hoặc file index bị hỏng. Route nhận thêm `sourceId` tuỳ chọn:
nguồn mà người dùng đã chọn khi bấm Cài trên một dòng. Không có nó, route trả `409 DIRECTORY_SOURCE_UNREAD` khi một
nguồn đứng trước không đọc được, và `409 DIRECTORY_SOURCE_CHANGED` khi gói đang được cài từ một nguồn khác. Có nó,
route trả `409 DIRECTORY_SOURCE_CHANGED` khi giờ đây một nguồn khác sở hữu listing đó. Node ghi nguồn lên generation
đã cài (`directorySource`), và thông báo cập nhật chỉ đến từ chính nguồn đó; generation được cài trước khi nguồn được
ghi lại được coi là cài từ file index. Các bản build của [phiên phát triển widget](#phiên-phát-triển-widget) trên node được
liệt kê trước mọi nguồn khác dưới nguồn riêng của chúng, `widget-dev` (kind `widget-dev`), và chỉ trên node này, không
bao giờ xuất hiện trong kết quả tìm kiếm: một lần cài có `sourceId` chỉ tới nguồn khác sẽ trả
`409 DIRECTORY_SOURCE_CHANGED` thay vì lấy bản build của phiên có cùng id và version. Một yêu cầu chấp thuận cài đặt giữ nguồn sở hữu listing lúc người dùng được hỏi,
và `POST /packages/approvals/{id}/decision` với `granted` trả `409 DIRECTORY_SOURCE_CHANGED` khi lúc đó một nguồn khác
đã sở hữu listing. Một listing từ marketplace được cài qua đúng những bước kiểm tra như listing từ file.

**Cài một gói chỉ dành cho người dùng.** `POST /packages/install` `{ "packageId", "version" }` là route mà nút Cài
của chính ứng dụng và thao tác `update` của một thông báo gọi; không tool nào của agent cài gói từ thư mục (tool quản lý
gói chỉ liệt kê, gỡ, khôi phục và quay lại bản trước), và relay WebSocket, `clarkcant api` cùng MCP từ chối route này với
`403 PERSON_ONLY`. Tool duy nhất của agent đi tới đường cài là `develop_widget`
([phiên phát triển widget](#phiên-phát-triển-widget)). Tool này chỉ chạy trong một lượt do chính người dùng gửi. Nó
theo dõi không gian widget riêng của Clark (việc chọn một thư mục dự án khác hiện chưa có; xem
[#538](https://github.com/digitopvn/clarkcant/issues/538)), và chính sách quyết định các lần cài của nó như đề xuất của
chính Clark.

Với một gói được liệt kê bằng đường dẫn trên máy này, node sao chép các tệp của nó vào bộ nhớ đệm gói
(`<dataDir>/package-cache/local/<sha256>`) và tính digest của bản sao (`digestOfDirectory`, cùng digest mà một lần
fetch git hay npm tính), nên request không cần client gửi digest nào. Bản sao được dựng trong một thư mục tạm, tính
digest từ chính những byte đã ghi ở đó, rồi mới được đổi tên thành tên theo nội dung của nó; cài lại đúng những byte đó
thì dùng lại bản sao đã có. Việc sao chép không làm node bị đứng trong lúc chạy. Card `marketplace-results` mang digest
của các tệp trong `contentDigest` của mỗi listing cục bộ, tính lúc node liệt kê chúng, và nút Cài gửi lại nó dưới dạng
`{ "contentDigest" }`. Nếu bản sao khác với nó (các tệp đã đổi kể từ lúc danh sách được tạo, kể cả trong lúc lần cài
đang sao chép chúng), lần cài bị từ chối với `409 DIGEST_MISMATCH` kèm lý do nói rõ điều đó và bảo người dùng tìm lại;
không có gì được cài, được hỏi hay được lưu vào bộ nhớ đệm, và card đánh dấu dòng đó là đã đổi thay vì mời bấm lại đúng
lần cài vừa bị từ chối. Một request không có `contentDigest` (card có từ trước khi có trường này, hoặc thao tác `update`
của một thông báo) cài các tệp như chúng đang có lúc request tới: node liệt kê lại đường dẫn sau khi sao chép, và nếu
có tệp hay thư mục nào đổi kích thước, thời điểm sửa đổi hay định danh trong lúc đang được sao chép, lần cài bị từ chối
với `409 DIGEST_MISMATCH` kèm lý do nói rõ điều đó, nên một bản sao không bao giờ là hỗn hợp của hai phiên bản. Gói đã
cài chạy từ bản sao, không phải từ đường dẫn: các tệp, frame, widget, theme và service của nó được đọc từ snapshot mà
generation của nó ghi lại (`snapshotDigest` trên generation và trong `GET /packages`), nên những chỉnh sửa sau này ở
đường dẫn không bao giờ được chạy cho tới khi gói được cài lại; lần cài lại sao chép và kiểm tra các tệp từ đầu rồi kích
hoạt một generation mới. Nếu ngược lại listing thay đổi dưới một gói đã cài (cùng phiên bản được liệt kê lại với một
`digest` khác, hoặc một phiên bản khác được liệt kê), cả bản sao lẫn đường dẫn đều không được phục vụ cho listing đó:
`GET /packages/:id/:version/files/…`, route frame và lần đọc widget của cuộc hội thoại trả về `409 NOT_INSTALLED` cho
tới khi gói được cài lại, và các widget của nó vẫn giữ trạng thái. Một đường dẫn không sao chép được các tệp bị từ chối
với `400 LOCAL_SOURCE_UNREADABLE`: không đọc được, chứa symbolic link, junction hay hard link (thứ mà bản sao từ chối
thay vì đi theo; trên mọi nền tảng, một tệp bị thay bằng link hay một tệp khác sau khi đã được liệt kê cũng bị từ chối),
hoặc quá lớn để xác minh (hơn 5.000 tệp, 5.000 thư mục, thư mục lồng sâu 64 cấp hay 64 MiB, giới hạn giữ cho các digest
của một lần tìm kiếm rẻ; khi đó card không mang `contentDigest` cho nó). Thư mục `.git` ở gốc được bỏ qua dù viết hoa
hay viết thường. Một bản sao mà node không ghi được vào bộ nhớ đệm của chính nó (đĩa đầy, thư mục bộ nhớ đệm không có
quyền ghi, một lần đổi tên mà Windows liên tục từ chối) bị từ chối với `503 PACKAGE_CACHE_UNAVAILABLE` kèm lý do nói rằng
các tệp không bị thay đổi và hãy thử lại. Các kiểm tra này chạy trước khi chính sách thực thi quyết định, nên một người
có chế độ sẽ từ chối lần cài vẫn nhận `409`, `400` hay `503` thay vì `403 POLICY_REFUSED`; bản sao mà một lần cài bị từ
chối hay đang chờ hỏi đã tạo vẫn nằm trong bộ nhớ đệm và được dùng lại. Bản ghi `effect.executed` của một lần cài cục bộ
nêu bản sao mà nó chạy (`files sha256:…` trong phần mô tả). Plan và generation của một lần cài cục bộ mang `digest` của
listing; client nào gửi `{ "localDigest" }` thì tự đặt định danh đó như trước, và lần cài của nó vẫn chạy từ một bản
sao. Một gói đã cài từ đường dẫn trước khi có snapshot vẫn đọc đường dẫn của nó cho tới khi được cài lại; không có gì bị
chuyển đổi hay bị xoá. Các thư mục tạm mà một lần cài bị dừng giữa chừng để lại trong bộ nhớ đệm được một lần cài sau
xoá khi chúng đã cũ hơn một giờ; ngoài ra bộ nhớ đệm gói không có cơ chế dọn rác, với snapshot cũng như với artifact git
và npm, nên một snapshot không còn generation nào dùng vẫn nằm trên đĩa cho tới khi bộ nhớ đệm được xoá bằng tay.

Khi chế độ thực thi của người dùng yêu cầu hỏi trước khi cài, route trả `202` với
`{ "code": "APPROVAL_REQUIRED", "approvalId" }` và không cài gì. Câu hỏi đó chờ trong `GET /inbox`, ở `waiting`, dưới
dạng `{ "kind": "install-approval", approvalId, packageId, version, displayName, riskTier, permissions, description,
operationDigest, requestedAt, expiresAt, reach?, reachChange?, unreadFields? }`: `permissions` là những quyền mà listing nói gói xin,
`reach` là những gì gói tiếp cận ngoài vùng cách ly, `reachChange` (với bản cập nhật của gói đã cài) là những gì phiên
bản đó thêm hoặc bỏ so với bản đang cài, cùng dạng như trên thông báo cập nhật, `unreadFields` (`{ count, names }`) là
các trường listing mang mà node này không đọc được và đã bỏ đi, được đếm đủ và chỉ nêu tên khi là đường dẫn định danh thuần, tối đa 8 tên (cùng trường này có trên mỗi dòng
`marketplace-results` và trên thông báo cập nhật package; xem
[directory metadata](widget-development.vi.md#18-directory-metadata)), còn `operationDigest`
là digest của artifact được liệt kê mà câu hỏi nói tới. Mục này chỉ được liệt kê khi thư mục vẫn còn liệt kê đúng
artifact đó; một gói hay phiên bản được phát hành lại từ đó bị bỏ ra, và cài lại nó sẽ hỏi về chính nó ở hiện tại.
Người dùng quyết định bằng `POST /packages/approvals/:id/decision`
`{ "decision": "granted" | "denied", "digest": "<operationDigest>" }`, cùng route chỉ dành cho người dùng dùng để quyết
định capability của gói. `denied` trả `200` `{ decision, packageId, version }` và không cài gì. `granted` chạy lại
đúng lần cài đó, với mọi kiểm tra của nó, gắn với digest đó: một listing có digest đã đổi kể từ lúc hỏi bị từ chối với
`409 DIGEST_MISMATCH` trước khi quyết định bất cứ điều gì, và approval vẫn ở trạng thái chờ. Với một gói được liệt kê
bằng đường dẫn trên máy này, câu hỏi còn ghim nội dung các tệp của nó lúc hỏi (`digestOfDirectory`, cùng digest mà một
lần fetch git hay npm tính); nếu các tệp đó đổi sau khi hỏi thì câu hỏi không còn được liệt kê, và Duyệt bị từ chối với
cùng `409 DIGEST_MISMATCH` kèm lý do, không cài gì; cài lại sẽ hỏi về các tệp như hiện tại, và một đường dẫn không đọc
được tệp bị từ chối ngay lúc hỏi (`400 LOCAL_SOURCE_UNREADABLE`). Một chính sách giờ cấm cài
vẫn từ chối (`403 POLICY_REFUSED`); thành công trả `200` với `{ decision: "granted", installed: { packageId, version },
generationId, state, pendingCapabilities, deniedCapabilities }`. Quyết định trên một digest khác là
`409 APPROVAL_FORGED`, quyết định lần hai là `409 APPROVAL_ALREADY_DECIDED`, và quyết định sau hạn mười phút là
`409 APPROVAL_EXPIRED`. Approval không ai quyết định kịp được lượt quét định kỳ của node chốt là hết hạn, kèm một thông
báo rằng chưa có gì được cài. Mọi kết quả (`asked`, `installed`, `denied`, `expired`, `refused` hoặc `failed`, kèm mã)
đều được ghi thành một sự kiện `package.install-approval`.

### Phiên phát triển widget

Một phiên soạn trực tiếp cho một gói widget nằm trong một thư mục trên node này: thư mục được theo dõi, mỗi thay đổi đọc
được thành một gói trở thành một generation bất biến, và generation đó được cài qua đúng đường cài ở trên rồi hiện trong
cuộc hội thoại bằng frame widget dùng trong bản chính thức. Dạng dữ liệu là `widgetDevSessionViewSchema` và
`widgetDevSessionCreateSchema` (`packages/contracts/src/widget-dev-session.ts`).

| Route | Tác dụng |
|---|---|
| `POST /widget-dev/sessions` `{ "root", "conversationId"?, "widgetId"? }` | Bắt đầu theo dõi `root` (đường dẫn tuyệt đối trên node). Trả `201` kèm phiên sau khi lần dựng đầu tiên đã chạy và đã được kích hoạt trong phạm vi chính sách cho phép. Có `conversationId` thì widget được đặt vào đó (ghim mở) ngay khi một generation chạy. Bắt đầu một thư mục đã có phiên bị dừng sẽ tiếp tục chính phiên đó. |
| `GET /widget-dev/sessions` | `{ sessions: [...] }`. |
| `GET /widget-dev/sessions/:id` | Một phiên: `latest` (bản dựng tốt mới nhất), `running` (generation node đang chạy), `activation` (`active`, `awaiting-approval` kèm `approvalId`, `refused` kèm `code` và `message`, hoặc `none`), `lastBuild` (kèm `diagnostics` khi lỗi), `showingLastKnownGood`, `placed`, và với phiên đã dừng là `stopReason` (`requested`, `watch-failed`, `folder-gone`, `capacity` hoặc `root-refused`). Việc đọc không thay đổi gì: nó không dựng, không cài và không theo một câu trả lời. Phiên tự theo câu trả lời từ hộp thư trong khoảng hai giây. |
| `DELETE /widget-dev/sessions/:id` | Dừng theo dõi (`stopReason: "requested"`). Generation đang chạy vẫn được cài và vẫn hiển thị ở nơi nó đã được đặt. |
| `POST /widget-dev/sessions/:id/rebuild` | Dựng thư mục ngay. `409 SESSION_STOPPED` với phiên đã dừng. |
| `POST /widget-dev/sessions/:id/place` `{ "conversationId", "widgetId"? }` | Đặt widget đang chạy vào một cuộc hội thoại. |

Các lần từ chối: `400 ROOT_NOT_ABSOLUTE`, `400 ROOT_NOT_A_FOLDER`, `404 ROOT_NOT_FOUND`, `404 CONVERSATION_NOT_FOUND`,
`404 SESSION_NOT_FOUND`, `409 TOO_MANY_SESSIONS`, `409 NOT_ACTIVE`, `400 NO_SUCH_WIDGET`, `409 NOT_PLACED` và
`503 WIDGET_DEV_UNAVAILABLE`:

- `409 TOO_MANY_SESSIONS` dành cho phiên đang chạy thứ chín trên node, hoặc cho kho lưu đã giữ 256 phiên mà phiên nào
  cũng vẫn đang chạy bản đã dựng. Các phiên đã dừng cũ hơn và không còn chạy gì sẽ bị quên trước để lấy chỗ.
- `409 NOT_ACTIVE`, `400 NO_SUCH_WIDGET` và `409 NOT_PLACED` dành cho lần đặt khi chưa có gì chạy, khi gói không khai báo
  widget đó, hoặc khi widget không đặt được.
- `503 WIDGET_DEV_UNAVAILABLE` dành cho node không chạy phiên phát triển.

**Thư mục nào.** `root` được phân giải thành đường dẫn thật (đi theo liên kết tượng trưng và junction) trước khi kiểm:

- `400 ROOT_NOT_LOCAL` từ chối đường dẫn chia sẻ mạng hoặc đường dẫn thiết bị của Windows (`\\host\share`, `\\?\…`,
  `\\.\…`).
- `400 ROOT_IN_DATA_FOLDER` từ chối thư mục dữ liệu của node, mọi thư mục nằm trong nó và mọi thư mục chứa nó. Ngoại lệ
  duy nhất là không gian widget của Clark, `<dataDir>/widget-workspace`.
- Một phiên người dùng bắt đầu trên route này được theo dõi mọi thư mục cục bộ khác.
- Một phiên Clark bắt đầu bằng `develop_widget` theo dõi không gian widget, nơi Clark dựng khung một widget mới. Để phát
  triển một dự án có sẵn, hãy chép thư mục của nó vào không gian widget. Mọi thư mục khác bị từ chối với
  `403 ROOT_NOT_OWNED`, bằng ngôn ngữ của chủ máy, và thông báo nói đúng như vậy.
- Việc chọn một thư mục dự án khác để Clark phát triển hiện chưa có; việc này được theo dõi tại
  [#538](https://github.com/digitopvn/clarkcant/issues/538). Bước kiểm cũng sẽ chấp nhận một thư mục nằm trong tùy chọn
  `workspace.roots` do chính người dùng ghi, nhưng hiện chưa có cài đặt, bước bắt đầu dùng hay route nào ghi tùy chọn
  này, còn các thư mục gốc mặc định có sẵn (thư mục home và ổ đĩa node đang chạy) và giá trị do Clark ghi đều không được
  tính.

**Gói nào.** Một phiên chỉ chạy các gói có facet nằm trong frame widget hoặc là dữ liệu (`isolated-ui` và
`declarative`). Lần dựng một gói có facet dịch vụ, công cụ hoặc native sẽ lỗi với một chẩn đoán mang mã
`FACET_LANE_UNSUPPORTED`; hãy cài gói như vậy theo cách thông thường. Lần dựng của một phiên cũng bị từ chối, không cài
và không liệt kê gì, khi id gói của nó thuộc về một thứ khác trên node:

- `PACKAGE_LISTED`: thư mục gói đã cấu hình liệt kê cùng id và phiên bản.
- `PACKAGE_IN_OTHER_SESSION`: một phiên khác đang phát triển id đó, hoặc vẫn đang chạy một bản dựng của nó.
- `PACKAGE_INSTALLED_OTHERWISE`: id đó đã được cài từ nơi khác.

Các mã này xuất hiện dưới dạng `activation.state: "refused"` kèm mã.

Mỗi generation được đặt tên theo digest nội dung các tệp của nó, được sao chép vào bộ nhớ đệm gói và chỉ được liệt kê
cho riêng node này (`<dataDir>/widget-dev/sessions.json`). Không có index, npm hay Marketplace nào tham gia, và không có
gì được phát hành.

**Những gì được dựng.** Thư mục `node_modules` ở gốc bị loại khỏi digest, bản sao và việc theo dõi, với mọi kiểu chữ hoa
thường, giống như `.git`. Đầu ra đã dựng như `dist` vẫn được giữ. Một lần dựng không lấy được các tệp sẽ lỗi với một
mã chẩn đoán, và generation đang chạy vẫn giữ nguyên:

- `FILES_TOO_LARGE`: thư mục chứa hơn 5.000 tệp hoặc 64 MiB. Lần dựng vẫn bị từ chối cho tới khi bớt tệp.
- `FILES_LINK_REFUSED`: thư mục chứa một liên kết mà bước sao chép từ chối, tức một liên kết tượng trưng hoặc junction
  trỏ ra ngoài thư mục, hoặc một tệp có liên kết cứng thứ hai. Lần dựng vẫn bị từ chối cho tới khi xoá liên kết hoặc
  chép thứ nó trỏ tới vào thư mục.
- `FILES_UNREADABLE`: không đọc hoặc sao chép được các tệp, chẳng hạn vì chúng thay đổi trong lúc sao chép. Lần lưu tiếp
  theo sẽ dựng lại.

**Dọn dẹp.** Sau mỗi lần cài, phiên xóa những gì các generation đã bị thay thế để lại: bản ghi generation và bản sao của
chúng trong bộ nhớ đệm gói. Phiên giữ generation đang chạy, mọi bản dựng đang chờ một câu hỏi, và generation bị thay thế
mới nhất, tức generation mà thao tác quay lại bản trước sẽ trở về.

**Kho lưu.** Nếu không đọc được `sessions.json`, tệp được chuyển sang một bên thành
`sessions.json.unreadable-<thời điểm>` và node bắt đầu mà không có phiên nào; tệp không bao giờ bị ghi đè.

**Khi việc theo dõi dừng.** Một phiên mà thư mục không còn theo dõi được sẽ được đánh dấu là đã dừng, kèm lý do, thay vì
vẫn hiện là đang chạy:

- `watch-failed`: bộ theo dõi bị lỗi, hoặc thư mục không xem được liên tục trong 30 giây vì một lý do khác "không tìm
  thấy" (xem bên dưới). Nhật ký của node ghi rõ lỗi, ví dụ `EPERM`.
- `folder-gone`: thư mục đã bị xoá hoặc đổi tên, hoặc đường dẫn không còn là một thư mục. Node kiểm tra thư mục ít nhất
  mỗi giây một lần và trước mỗi lần dựng, vì Windows không báo gì khi một thư mục đang được theo dõi bị xoá. Chỉ lỗi
  "không tìm thấy" mới được tính: một thư mục không xem được vì lý do khác, chẳng hạn phần mềm diệt virus hoặc trình lập
  chỉ mục đang giữ nó (`EPERM`, `EBUSY`), vẫn giữ phiên đang chạy và được kiểm tra lại, tối đa 30 giây lỗi liên tục; sau
  đó phiên dừng với lý do `watch-failed`. Lý do này cũng dùng khi thư mục không còn sau một lần khởi động lại.

Một thư mục vẫn còn đó nhưng mang định danh khác không làm phiên dừng. Node so sánh device và file id của thư mục với
những giá trị lúc bắt đầu theo dõi; khi chúng khác nhau, thư mục đã được tạo lại ở cùng đường dẫn (chẳng hạn bởi
`rm -rf out && build`), hoặc hệ thống tệp đã cấp cho nó một id mới (một số ổ FUSE và ổ mạng làm vậy). Node theo dõi thư
mục hiện nằm ở đường dẫn đó và dựng nó, giống như khi dựng một thay đổi đã lưu.

Trong mọi trường hợp, generation đang chạy vẫn tiếp tục chạy.
- `capacity`: node đã theo dõi tám thư mục lúc tiếp tục các phiên.
- `root-refused`: sau một lần khởi động lại, thư mục không qua được bước kiểm mà một lần bắt đầu thực hiện. Ví dụ, một
  phiên do Clark bắt đầu có thư mục nằm ngoài không gian widget.

**Sự đồng ý.** Chính sách quyết định mỗi lần cài theo một **phạm vi đồng ý** thay vì theo artifact. Phạm vi là id gói
cùng mọi thứ bản dựng ràng buộc về phạm vi tiếp cận của nó:

- reach đã khai báo và tài nguyên;
- lane của facet, và từng facet theo loại, id và lane;
- quyền;
- các capability mà gói yêu cầu.

Câu hỏi cài trong `GET /inbox` mang phạm vi đó làm `operationDigest`, và được quyết định bằng
`POST /packages/approvals/:id/decision` thông thường với giá trị đó. Một lần dựng sau có cùng phạm vi được cài theo
approval đó mà không hỏi lần hai. Một lần dựng có phạm vi đã đổi, rộng hơn hay hẹp hơn, là một câu hỏi mới, và
generation trước nó vẫn chạy trong lúc chờ.

Ý định mà một lần cài thực hiện tùy vào người bắt đầu phiên:

- Một phiên người dùng bắt đầu trên route này cài như yêu cầu của chính họ.
- Một phiên Clark bắt đầu bằng `develop_widget` cài như đề xuất của chính Clark. Chế độ có kiểm soát hỏi trước, trừ khi
  một quy tắc cho phép ghi cục bộ; chế độ luôn hỏi thì hỏi; chế độ tự chủ thì chạy.

Một chế độ không hỏi thì chạy mọi lần dựng, như với mọi lần cài. Khi một lần dựng như vậy tiếp cận nhiều hơn lần trước
và không ai được hỏi, node nói điều đó trong cuộc hội thoại của phiên kèm những gì nó thêm vào. Mỗi lần cài được ghi lại
như mọi lần cài khác (`effect.executed`, kèm đúng các tệp).

Một lần dựng không đọc được thành gói (manifest hỏng, định nghĩa widget không parse được, không có facet widget) không
tạo generation nào: `lastBuild.ok` là `false` kèm tối đa 32 `diagnostics`, generation đang chạy vẫn chạy, và
`showingLastKnownGood` là `true`. Điều này cũng đúng khi một lần dựng mới hơn đang chờ người dùng hoặc đã bị từ chối.

Lần đọc trực tiếp của một widget đang chạy generation của một phiên, `GET /conversations/:id/widgets/:instanceId/live`,
mang `development: { sessionId }`, và `frame.document` của nó nêu tên generation, nên client mount lại frame (và chỉ
frame) khi một generation mới chạy; instance, state và migration của nó là những thứ thông thường. Mã widget không bao
giờ được cho biết nó đang ở trong một phiên.

`POST /widget-dev/sessions`, `/:id/rebuild` và `/:id/place` cài mã. Relay WebSocket, `clarkcant api` và MCP từ chối
chúng với `403 PERSON_ONLY`, và chính route cũng từ chối như vậy với mọi yêu cầu được một bề mặt máy đánh dấu. Đọc và
dừng một phiên vẫn gọi được ở mọi nơi.

Trong cuộc hội thoại, tool `develop_widget` của Clark (`start`, `status`, `rebuild`, `place`, `stop`) điều khiển cùng các
phiên đó. Tool chỉ bắt đầu, dựng lại hoặc đặt widget trong một lượt do người dùng gửi; một lượt do bề mặt máy, tác vụ tự
động hoặc máy ngang hàng gửi không làm được những việc này.

Lời gọi action của widget, `POST /conversations/{id}/widgets/{instanceId}/actions`, nhận một body được route kiểm bằng
`actionInvocationSchema` (`packages/contracts/src/widgets.ts`); body nằm ngoài schema nhận `400 INVALID_SCHEMA`, và một
`invocationId` bắt đầu bằng `view-state:` cũng vậy, vì tiền tố này dành riêng cho bản ghi của chính node. Một `variant`
tuỳ chọn chọn loại lời gọi. Không có `variant` là lời gọi thường, được trả về kết quả cùng timeline của cuộc hội thoại.
`"view-state"` là lần ghi chỉ-state cho trạng thái phát của trình phát do host giữ (`canvas.video@1`, `canvas.audio@1`),
và bắt buộc kèm `sequence`: một số nguyên dương tăng theo mỗi lần ghi của trình phát, kể cả qua các lần tải lại trang,
không vượt quá đồng hồ của node quá một ngày (host gửi `max(thời điểm hiện tại tính bằng mili giây, giá trị trước + 1)`).
Lần ghi này qua cùng các bước kiểm tra chủ sở hữu, binding, revision, digest và input, rồi trả
`200 { variant, duplicate, instanceId, revision, stateRevision, state }`, không kèm timeline, không đổi revision của
instance và chỉ giữ một bản ghi invocation cho mỗi binding. Lần ghi có `sequence` không mới hơn giá trị node đã nhận gần
nhất, kể cả lần thử lại hay một id cũ bị phát lại, không ghi gì và được trả `duplicate: true` (kèm `stale: true` khi đó là
lần ghi cũ hơn) cùng state và revision node đang giữ. `sequence` không kèm variant, hoặc variant không kèm `sequence`,
nhận `400 INVALID_SCHEMA`; mọi binding khác nhận `400 UNSUPPORTED_ACTION`, và mọi giá trị `variant` khác nhận
`400 INVALID_SCHEMA`. Xem [phát triển widget §8.11](widget-development.vi.md#811-widget-media-và-trạng-thái-semantic).

Một lời gọi thường gọi tới capability của service trả `200 { outcome: "done", output, structuredContent? }` cùng các
trường ở trên. `output` là phần chữ service trả về, như trước. `structuredContent` là trường bổ sung, tuỳ chọn: object
JSON mà service trả về trong `structuredContent` của MCP, khi node giữ lại nó. Node bỏ nó, và ghi lý do vào `output`,
khi nó không phải JSON thuần có giới hạn (sâu tối đa 32 tầng và 16.384 giá trị, không có khoá `__proto__`,
`constructor` hay `prototype`), khi JSON của nó dài hơn 65.536 ký tự, hoặc khi nó không khớp `outputSchema` mà service khai
báo cho tool. Đây là dữ liệu của service, không bao giờ là chỉ dẫn và không bao giờ thành thẻ, và một `invocationId`
lặp lại được trả lại đúng giá trị đó. Tool `invoke_capability` của agent và lệnh nói đi tới cùng lời gọi capability
và nhận cùng giá trị. Tệp vẫn là `ArtifactRef` ([phát triển widget §6](widget-development.vi.md)). Client bỏ qua
trường này thấy đúng phản hồi như trước.

Các route khác (settings, packages, widgets, peers…) vẫn gọi được với cùng token nhưng chưa thuộc mô tả ổn định và
có thể thay đổi.

## MCP

`POST /mcp` hiện thực transport Streamable HTTP, trả lời bằng JSON (protocol `2025-06-18`, cùng `2025-03-26` và
`2024-11-05`). `GET /mcp` trả `405`: server không bao giờ chủ động gửi trước. Method: `initialize`, `ping`,
`tools/list`, `tools/call`; notification nhận `202` không có body. `initialize` xưng tên server là `clarkcant`, với phiên bản Clark
làm `serverInfo.version` ([một phiên bản Clark](releases.vi.md#một-phiên-bản-clark)), và khi node kết nối tới service MCP
của một gói, nó tự giới thiệu theo cùng cách trong `clientInfo`.

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
| `read_inbox` | – | `GET /inbox` |
| `act_on_notice` | `noticeId`, `action`, `until?` | `POST /inbox/notices/{noticeId}/actions/{action}` |

`read_conversation` không có `after` sẽ đọc trang mới nhất (`window=latest`), nên câu hỏi Clark đang chờ luôn nằm trong đó
dù cuộc trò chuyện dài đến đâu. `structuredContent.cursor` của nó là `window.toSequence` của trang: một số thứ tự tin nhắn,
truyền lại làm `after` để chỉ đọc những tin nhắn được viết từ đó. Đây không phải `cursor` sự kiện của timeline, và nó không
bao giờ vượt quá tin nhắn mới nhất: một `after` lớn hơn sẽ được trả về bằng số thứ tự của tin nhắn mới nhất. `hasNewer` cho biết
sau trang này vẫn còn tin nhắn; hãy đọc lại với cursor mới cho đến khi không còn tin nhắn nào được trả về.

**Cố ý không có tool duyệt approval.** Approval là quyết định của con người về việc agent muốn làm; một MCP tool cho
nó sẽ cho phép client AI tự duyệt hành động bị guard của chính nó. Approval chỉ nằm trên bề mặt của người dùng, và
các relay tổng quát (frame `request` qua WebSocket, `clarkcant api`) cùng MCP từ chối mọi route ghi nhận quyết định
của con người với `403 PERSON_ONLY` vì cùng lý do đó: duyệt hành động bị guard (trên thẻ, hoặc do một task đang
chạy raise ra), quyết định capability của package, cài một gói (`POST /packages/install`, hoặc `POST /widget-dev/sessions`,
`/rebuild` và `/place` của một phiên phát triển widget) hoặc quyết định một lần
cài mà chế độ thực thi của người dùng đã hỏi, xác nhận app intent, báo cáo trang đã làm gì với một hành động agent yêu cầu, báo cáo frame của widget đã làm gì với một hành động Clark nhờ nó thực hiện (`POST /app-intents/widget-perform/{performId}`), tin cậy một peer đã ghép cặp, cấp
grant, xin token trình duyệt cho một frame (`POST /conversations/{id}/widgets/{instanceId}/browser-tokens`; chỉ chrome
của host đã mount frame mới xin, và một client máy xin tức là xin một credential để giữ), gửi một báo cáo sản phẩm
(`POST /feedback/reports/{reportId}/publish`; gửi lên GitHub thay người dùng là quyết định của họ), và ghi nhận một thao tác không ai thấy kết quả đã có hiệu lực hay chưa (`POST /effects/{effectId}/reconcile`;
một client AI nói được "lần push đó đã thành công" thì có thể tự gỡ trạng thái chưa rõ của task của chính nó rồi tự
báo là đã xong). Xuất một bảng ra file CSV
(`POST /conversations/{id}/widgets/{instanceId}/export`) cũng bị các relay đó từ chối: file được viết cho người đang
xem bảng, không trao cho một client máy. Lưu artifact của một widget ra tệp
(`POST /artifacts/{artifactId}/export`) và giao cho widget một tệp người dùng đã chọn
(`POST /conversations/{id}/widgets/{instanceId}/artifacts/pick`) cũng bị từ chối như vậy. Điều bị giữ lại là hành động,
không phải dữ liệu: lưu là người dùng chọn giữ một tệp, và một client máy vẫn đọc được byte của artifact đã cố định qua
`GET /artifacts/{artifactId}/content`. Việc chọn tệp cấp cho widget những byte mà chỉ lựa chọn của người dùng mới được
trao. Dừng, trả lời câu hỏi và đọc vẫn dùng được, và `act_on_notice` cũng vậy:
nó không bao giờ đưa ra câu trả lời của người dùng về một thao tác chưa rõ kết quả hay việc cài bản cập nhật của một
thông báo (`403 PERSON_ONLY` cho cả hai, route cập nhật bị từ chối như trên). `read_inbox` đánh dấu tiêu đề và nội
dung của mọi thông báo là dữ liệu do việc khác báo lại, không bao giờ là chỉ dẫn, và giữ mỗi thông báo trên một dòng.
Discovery document ghi điều này ở mục `personDecisions`.

**Kết nối MCP riêng của service trong package.** Node là MCP client của mỗi service trong package mà nó chạy qua
stdio. Khi facet `tools` của service khai báo `egress`, request `initialize` của node đề nghị
`capabilities.experimental["clarkcant/egress"]` (`version: 1`), và service có thể gửi cho node request
`clarkcant/egress.fetch` với `{ version: 1, url, method?, headers?, body? }`. Node chỉ thực hiện HTTP request tới
origin đã khai báo, gắn header credential đã khai báo từ secret được lưu cho `package:<id>`, không đi theo redirect, và
thay secret bằng `[redacted]` trong kết quả trả về như một lớp bảo vệ ở mức cố gắng tối đa. Node chỉ trả lời `GET` và
`HEAD` trừ khi một lần gọi đang chạy được quyết định là `external-write` hoặc rủi ro hơn, giới hạn tốc độ cho từng
service, và từ chối origin loopback và mạng riêng trừ khi node chạy với `CC_EGRESS_ALLOW_PRIVATE_NETWORK=1`. Lời từ chối
là các lỗi JSON-RPC từ `-32010` tới `-32018`
(`packages/contracts/src/service-egress.ts`, [widget-development.vi.md §14.2](widget-development.vi.md#142-service-gọi-tới-nhà-cung-cấp)).
Method này không có trên `POST /mcp`.

WebMCP (trang web đưa tool cho agent của chính trình duyệt) đã được cân nhắc cho cùng các thao tác thông báo và chưa
được đưa ra: đề xuất này vẫn là bản nháp, chưa có API trình duyệt nào ship, và trang của ClarkCant không có bề mặt
tool riêng để đưa ra; các MCP tool ở trên là bề mặt dành cho máy.

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

- Gửi được mọi route REST, trừ quyết định của con người và việc cài gói, dưới dạng frame `request`; câu trả lời là
  status và body của chính gateway.
- `id` được trả lại đúng như khi gửi, dù là chuỗi hay số.
- Tham số query đặt trong object `query` của frame, không đặt trong `path`.
- Tối đa 16 request chạy đồng thời trên một socket, phân biệt bằng `id`.
- Request bị từ chối (`INVALID_FRAME`, `TOO_MANY_REQUESTS`) nhận một frame `error` mang `id` của nó thay cho
  `response`; đó là frame cuối cùng của `id` đó.
- Route trả về bytes (attachment, ảnh) trả `415 USE_HTTP`.
- `ping` → `pong`. Không xác thực trong 10 giây, hoặc sai token: frame `error` và close code `4401`.

## CLI

`apps/cli` (`@clarkcant/cli`) là client của gateway. Ngoại lệ duy nhất là `instructions check`: lệnh này không liên
lạc với node nào mà kiểm tra một tệp cục bộ theo một hợp đồng mở. CLI chưa được publish lên npm; chạy từ checkout bằng
`node apps/cli/src/main.ts` hoặc `pnpm clarkcant`.

| Lệnh | |
|---|---|
| `clarkcant ask "<text>" [-c <conversationId>]` | stream câu trả lời ra stdout; id hội thoại ra stderr |
| `clarkcant status` | nhãn node, URL, model |
| `clarkcant conversations` / `new [title]` / `read <id>` | hội thoại |
| `clarkcant stop` | dừng khẩn cấp |
| `clarkcant api <METHOD> <path> [jsonBody]` | gọi route bất kỳ, trừ quyết định của con người và việc cài gói |
| `clarkcant mcp` | MCP qua stdio |
| `clarkcant discover` | discovery document |
| `clarkcant instructions check [file\|folder]` | kiểm tra ngoại tuyến tệp `.clarkcant/instructions.json` của một dự án (xem bên dưới) |

Kết nối: `--url` / `CLARKCANT_URL`, `--token` / `CLARKCANT_TOKEN`, nếu không thì đọc `identity.json` trong
`--data-dir` / `CLARKCANT_DATA_DIR` (mặc định `~/.clarkcant`). File identity chỉ được đọc cho node trên chính máy
này (`localhost`, `127.x`, `::1`); `--url` trỏ tới máy khác cần `--token` hoặc `CLARKCANT_TOKEN`, nên token cục bộ không
bao giờ bị gửi sang host khác. `clarkcant mcp` chuyển tiếp từng dòng ngay khi nhận, nên `ping` vẫn được trả lời trong
lúc một lệnh gọi dài đang chạy. `--json` in JSON thô.

## Tệp hướng dẫn của dự án

`<project>/.clarkcant/instructions.json` chứa các hướng dẫn có điều kiện của một dự án. Mỗi quy tắc nêu một đoạn hướng
dẫn (`<project>/.clarkcant/instructions/<name>.md`) khi công việc chạm vào đúng thứ mà quy tắc nói tới. Đây là một hợp
đồng mở có phiên bản. Schema nằm ở `packages/contracts/src/project-instructions.ts`
(`projectInstructionsFileSchema`, `readProjectInstructions`, `projectInstructionsProblems`). Node đọc tệp bằng schema
này, và `clarkcant instructions check` cũng dùng đúng schema đó để kiểm tra. Cách một quy tắc được áp dụng được mô tả ở
[system-architecture.vi.md §7.2](system-architecture.vi.md).

```json
{
  "version": 1,
  "rules": [
    { "when": { "path": "packages/storage/**", "operation": "write" }, "include": ["migrations"], "pin": false }
  ]
}
```

- Tệp viết từ bây giờ phải có `version`. Hiện chỉ có phiên bản 1. Một tệp không có `version`, được viết trước khi trường
  này trở thành bắt buộc, vẫn được đọc như phiên bản 1. Node không đọc tệp có phiên bản mà nó không biết, và lệnh kiểm
  tra báo trong một dòng rằng tệp cần một bản ClarkCant mới hơn.
- `rules` chứa tối đa 32 quy tắc. Mỗi quy tắc có `when`, danh sách `include` gồm 1 đến 8 tên đoạn hướng dẫn (chữ
  thường, chữ số và `-`, tối đa 64 ký tự), và `pin` không bắt buộc. `when` có thể nêu `project`, `path`, `operation`
  (`read`, `write`, `command`, `test`, `deploy`), `capability`, `role` (`foreground`, `background`, `task`) và `skill`.
  Mỗi trường nhận một giá trị hoặc một danh sách tối đa 16 giá trị. Một glob `path` có tối đa 200 ký tự, 16 ký tự đại
  diện và 32 thư mục. Tệp lớn hơn 64 KB không được đọc.
- Khóa lạ: ở cấp cao nhất chỉ cho phép `$schema` (một chuỗi, dành cho JSON schema của trình soạn thảo), và mọi khóa lạ
  khác ở cấp cao nhất khiến node không đọc gì từ tệp. Một khóa lạ bên trong một quy tắc hoặc bên trong `when` của nó chỉ
  làm bỏ qua quy tắc đó. Lệnh kiểm tra báo cả hai trường hợp.
- Node bỏ qua quy tắc không phân tích được và vẫn áp dụng các quy tắc còn lại. Khi không đọc được gì từ một tệp, node
  ghi một dòng `instructions-invalid` ra stderr, kèm tên thư mục dự án và một `reason`: `too-large`, `not-json`,
  `shape` hoặc `unknown-version`.
- `clarkcant instructions check` kiểm tra tệp theo quy tắc dành cho việc viết tệp: thiếu `version` và từng quy tắc
  không hợp lệ đều được báo trên một dòng riêng, và mã thoát là 1. Một quy tắc include một tên không có
  `instructions/<name>.md` nằm cạnh tệp chỉ là cảnh báo; mã thoát vẫn là 0. `--json` in
  `{ path, ok, problems, warnings }`. Tệp mặc định là `.clarkcant/instructions.json` trong thư mục hiện tại, và có thể
  truyền thư mục dự án thay cho tệp.
- Một hướng dẫn không cấp quyền gì. Node chỉ đọc nó từ một dự án nằm trong root mà người dùng đã cấp, và mọi tác động
  vẫn đi qua chính sách thực thi. Hiện một gói chưa thể đóng góp quy tắc.

## Thay đổi một bề mặt

Theo quy tắc trong [AGENTS.md](../AGENTS.md#open-interfaces): năng lực mới đi qua một route của gateway trước, các bề
mặt khác gọi tới qua route đó, `open-interfaces.ts` và tài liệu này (cả hai ngôn ngữ) đổi trong cùng PR, và thay đổi
docs cho website được tạo thành issue có nhãn `ai-handle` trên `digitopvn/clarkcant-web`.

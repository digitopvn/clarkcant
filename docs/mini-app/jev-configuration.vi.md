# Jev selector: configuration and privacy

> [English](jev-configuration.md) (mặc định) · Tiếng Việt

Jev (TypeSafe System One) is the node's *selector*. It chooses among options the host has already
authorized — a presentation template, a renderer for one region, a runtime to dispatch to — and it
may answer `none`. It never receives data, never grants permission, and never decides a side
effect. Everything that turns its answer into something the user sees is host code.

This document is the operator's half: what to set, what leaves the machine, what is recorded, and
what happens when the provider is unavailable.

Selector là một vai trò, và Jev là provider đảm nhận vai trò đó theo mặc định. Nó tách biệt với model
hội thoại: Pi trả lời cuộc hội thoại, còn decision provider chỉ trả lời các câu hỏi nhỏ có kiểu bên
dưới. Người vận hành có thể chọn Cloudflare Clef trên Workers AI hoặc decisions API của OpenRouter thay
thế, và người dùng có thể chọn trong Cài đặt (xem [Chọn decision provider](#chọn-decision-provider)).
Chính sách của Clark — những gì được đưa ra để chọn, những gì bị che, các ngưỡng, ngân sách thời
gian và mọi fallback — giống hệt nhau dù provider nào trả lời; chỉ endpoint, credential và model được
ghim là khác. Trừ khi một mục nói khác, "provider" bên dưới là provider đang được chọn.

## Configuration

Mọi thiết lập được đọc từ môi trường của process runtime, trừ việc lựa chọn của người dùng trong Cài
đặt (bên dưới) thay thế provider, model của nó và account id của Cloudflare. Credential của provider
đang được chọn (`TYPESAFE_API_KEY`, `CLOUDFLARE_API_TOKEN` hoặc `OPENROUTER_API_KEY`, hoặc key đã lưu
trong thẻ của provider đó) là credential duy nhất được dùng, và nó không bao giờ được renderer đọc, ghi vào props, lưu trong snapshot hay ghi log. Các thiết
lập `CLARKCANT_JEV_*`, trừ model và endpoint, áp dụng cho provider nào đang được chọn; giá trị `jev`
của `CLARKCANT_SEARCH_DECIDER` hay `CLARKCANT_CONTEXT_DECIDER` nghĩa là "hỏi decision provider đang
được chọn".

| Variable | Default | Meaning |
|---|---|---|
| `CLARKCANT_DECISION_PROVIDER` | `typesafe` | `typesafe` (Jev), `cloudflare` (Clef) hoặc `openrouter` (decisions API của OpenRouter). Giá trị khác thì từ chối mọi lời gọi quyết định, chứ không quay về TypeSafe. Lựa chọn trong Cài đặt thắng biến này. |
| `CLARKCANT_DECISION_MODEL` | *(xem ý nghĩa)* | Model id chính xác cho provider đang được chọn. Với TypeSafe, nó thắng `CLARKCANT_JEV_MODEL`, và khi không đặt thì thiết lập đó vẫn quyết định. Với Cloudflare, nó là bắt buộc và phải là `clef` hoặc `clef-flash`. Với OpenRouter, nó là bắt buộc và phải là một slug được ghim (`nhà-cung-cấp/model`, chữ thường, không dùng alias `~`), ví dụ `cloudflare/clef-flash` hay `typesafe/jev-1.13`. |
| `TYPESAFE_API_KEY` | *(none)* | Credential của TypeSafe. Khi chọn TypeSafe, không có key nghĩa là selector bị tắt. |
| `CLOUDFLARE_ACCOUNT_ID` | *(none)* | Chỉ cho Cloudflare. 32 ký tự thập lục phân; giá trị khác thì mọi lời gọi bị từ chối. Account id chọn trong Cài đặt thắng biến này. |
| `CLOUDFLARE_API_TOKEN` | *(none)* | Chỉ cho Cloudflare. Một token được phép chạy Workers AI. Token lưu trong thẻ Cloudflare của decision provider thắng biến này. Khi chọn Cloudflare mà không có token ở nơi nào, selector bị tắt; key của TypeSafe không bao giờ được dùng thay. |
| `OPENROUTER_API_KEY` | *(none)* | Chỉ cho OpenRouter, dùng cho quyết định. Key lưu trong thẻ OpenRouter của decision provider thắng biến này. Khi chọn OpenRouter mà không có key ở nơi nào, selector bị tắt. Đây cũng là biến Pi có thể dùng cho model hội thoại; chỉ khi chọn OpenRouter làm decision provider thì quyết định mới dùng nó. |
| `CLARKCANT_JEV_ENABLED` | derived | Explicit override. Defaults to "a key is present and the node is not local-only". |
| `CLARKCANT_JEV_LOCAL_ONLY` | off | `1`/`true` forbids sending any intent to a third party. Outranks a key being present. |
| `CLARKCANT_JEV_MODEL` | `jev-1.13.0` | Chỉ cho TypeSafe. Exact model id. `jev-latest` resolves to the same id today but drifts by definition. |
| `CLARKCANT_JEV_ENDPOINT` | `https://api.typesafe.ai/v1/systemone` | Chỉ cho TypeSafe. Must be `https`, with no embedded credentials, and must not point at a loopback or private address. |
| `CLARKCANT_JEV_TIMEOUT_MS` | `4000` | Budget for **all** selector calls made while composing one turn. |
| `CLARKCANT_JEV_SEARCH_TIMEOUT_MS` | `2000` | Budget for **one decision** rather than a whole composition: the selector choosing between close search results, or between usable capabilities. A value that is not a positive number falls back to the default. |
| `CLARKCANT_JEV_POLICY_VERSION` | `2026-09-17` | Stamped into telemetry and composition provenance so a decision can be traced to a policy. |
| `CLARKCANT_SEARCH_DECIDER` | `rank` | `rank` uses BM25 alone; `jev` asks the selector to choose between results that are close. Any other value falls back to `rank`. |
| `CLARKCANT_SEARCH_SEMANTIC` | off | `1`/`true` turns on vector retrieval (sqlite-vec + local E5-small), fused with the lexical results by RRF. Off because it was measured: on the Phase 8 corpus it did not improve top-1 and cost precision when the cosine ceiling was loose. |
| `CLARKCANT_CONTEXT_PLANNER` | bật | `off` trả lại phần tóm tắt cố định (12 tin mới nhất) và bản ghi nhớ cố định (12 ghi nhớ mới nhất), và thôi đưa ngữ cảnh đã truy xuất cho việc chạy nền và task worker được điều phối. Hai cải tiến vẫn giữ ở cả hai chế độ: bản ghi nhớ không đọc được thì lượt chạy tiếp mà không có nó thay vì thất bại, và một lượt có thể được dừng trong lúc đang đọc ngữ cảnh. Phần tóm tắt cũng đọc 40 tin mới nhất ở cả hai chế độ. Khi bật, cả hai tập trung vào tin đang được trả lời, và quay về dạng cố định khi không có gì khớp. `off` cũng tắt việc giữ lại theo mức dữ liệu trong recap, bản ghi nhớ, bundle truy xuất, hướng dẫn dự án và `search_history`; định tuyến nền theo mức dữ liệu vẫn áp dụng (xem [system-architecture.vi.md §7.2](../system-architecture.vi.md)). |
| `CLARKCANT_CONTEXT_DECIDER` | `rank` | `jev` cho selector sắp lại 8 kết quả khớp nhất của phần tóm tắt và bản ghi nhớ khi thứ hạng sát nhau, và chọn một nhóm tool cho tin không nhắc nhóm nào khi đang mở dần tool. Nó chỉ được hỏi khi câu trả lời có thể đổi điều được gửi đi. Khi được hỏi, nội dung rời khỏi node tới provider của Jev: tin đang được trả lời (đã che thông tin nhạy cảm, tối đa 300 ký tự; 400 ký tự khi chọn nhóm tool) và từng ghi nhớ hay tin cũ hơn là ứng viên mà toàn bộ là `public` hoặc `internal` (đã che, tối đa 200 ký tự; ứng viên nhạy cảm hơn không được đưa ra). Lỗi hay hết giờ thì giữ thứ tự tất định. Giá trị khác là `rank`. |
| `CLARKCANT_TOOL_DISCLOSURE` | `all` | `progressive` đưa cho hội thoại các tool lõi cùng các nhóm tool mà tin nhắn nhắc tới, chỉ tăng thêm trong một session. Tắt vì đã đo: trong ước tính offline, nó tiết kiệm token schema nhưng tốn hơn khi tính cả việc ghi lại prompt cache (xem [system-architecture.vi.md §7.3](../system-architecture.vi.md)). Giá trị khác là `all`. |
| `CLARKCANT_CONDITIONAL_INSTRUCTIONS` | on | `off` ngừng đọc `.clarkcant/instructions.json` của dự án, nên không hướng dẫn có điều kiện nào được nêu cho hội thoại hay task worker (xem [system-architecture.vi.md §7.2](../system-architecture.vi.md)). Mọi giá trị khác là bật. |
| `CLARKCANT_SESSION_POLICY` | `off` | `observe` báo mỗi lượt session của hội thoại sẽ được giữ hay dựng lại và vì sao, dưới dạng số đếm trên stderr; `rebuild` dựng lại thật, chỉ khi cache đã nguội, context lớn và chủ đề mới (xem [system-architecture.vi.md §7.3](../system-architecture.vi.md)). Với `CLARKCANT_CONTEXT_DECIDER=jev`, Jev được hỏi ở vùng chưa rõ và chỉ được xem số đếm. Mọi giá trị khác là `off`. |

The key belongs in the runtime's environment or its local, gitignored `.env`. It does not belong in
a `VITE_`/`NEXT_PUBLIC_` variable, a URL query, a fixture, or another repository's `.env` path
referenced from code. Key của TypeSafe cũng có thể được nhập vào thẻ cài đặt. Khi cả hai nơi đều có,
key lưu trong thẻ được ưu tiên, theo quy tắc chung cho mọi credential của nhà cung cấp; key trong môi
trường chỉ được dùng khi thẻ chưa có key. Lưu hoặc xoá key trong thẻ có hiệu lực từ quyết định kế tiếp, không cần khởi động lại; khi không còn key ở cả hai nơi, selector bị tắt. Câu trả lời readiness của node (`GET /readiness`, trường `sources`) cho biết key nào đang được dùng, không bao giờ hiện giá trị. 

Key của Cloudflare và OpenRouter theo cùng quy tắc, nhưng được lưu dưới các tên vault do host sở hữu
(`decision:cloudflare`, `decision:openrouter`) mà chỉ thẻ riêng của decision provider được ghi
(`PUT /decision-provider/credential`). Kho credential chung từ chối các tên này, nên một secret ai đó
lưu cho mục đích khác (chẳng hạn token `cloudflare` cho lệnh deploy) không bao giờ trở thành credential
của decision provider, và key quyết định không thể bị thay từ một biểu mẫu. Mỗi provider chỉ đọc tên
của chính nó: key của TypeSafe không bao giờ được gửi tới Cloudflare hay OpenRouter, và ngược lại.

### Chọn decision provider

TypeSafe Jev vẫn là mặc định. Có hai cách chọn provider khác, và cách thứ nhất thắng:

1. **Trong Cài đặt.** Người dùng chọn một provider (và, với Cloudflare và OpenRouter, một model) rồi
   lưu key của provider đó trong thẻ riêng của nó. Lựa chọn được lưu thành preference
   `ai.decisionProvider`, nên có revision và có thể hoàn tác. Chọn "theo môi trường" sẽ lưu `null` và
   trả quyền chọn về cho các biến bên dưới. Cùng lựa chọn đó cũng có qua API của node:
   `PUT /decision-provider` với thân như
   `{"selection": {"provider": "cloudflare", "model": "clef", "accountId": "<32 hex>"}}`,
   `{"selection": {"provider": "openrouter", "model": "cloudflare/clef-flash"}}`,
   `{"selection": {"provider": "typesafe"}}` hoặc `{"selection": null}`. Key được gửi tới
   `PUT /decision-provider/credential` với `{provider, value}` và được xoá bằng
   `DELETE /decision-provider/credential/<provider>`. Mọi thao tác ghi này chỉ con người được làm: một
   AI client hay một bề mặt máy khác không thể chọn bên thứ ba nào nhận quyết định.
2. **Trong môi trường**, cho người vận hành cấu hình node mà không qua Cài đặt:

```bash
CLARKCANT_DECISION_PROVIDER=cloudflare
CLARKCANT_DECISION_MODEL=clef        # hoặc clef-flash
CLOUDFLARE_ACCOUNT_ID=<32 ký tự thập lục phân>
CLOUDFLARE_API_TOKEN=<một token được phép chạy Workers AI>

# hoặc
CLARKCANT_DECISION_PROVIDER=openrouter
CLARKCANT_DECISION_MODEL=cloudflare/clef-flash   # một slug được ghim
OPENROUTER_API_KEY=<một key OpenRouter>
```

| | TypeSafe Jev | Cloudflare Clef | OpenRouter |
|---|---|---|---|
| Nơi nhận request | `https://api.typesafe.ai/v1/systemone`, hoặc `CLARKCANT_JEV_ENDPOINT` | `https://api.cloudflare.com/client/v4/accounts/<account>/ai/run/@cf/cloudflare/<model>`, dựng từ hai giá trị đã kiểm tra; không có cách ghi đè endpoint | `https://openrouter.ai/api/alpha/decisions`; không có cách ghi đè endpoint. OpenRouter chuyển tiếp request tới công ty phục vụ model được chọn. |
| Model | `jev-1.13.0` nếu không ghi đè | `clef` hoặc `clef-flash`, luôn phải nêu rõ | Một slug được ghim như `cloudflare/clef-flash` hay `typesafe/jev-1.13`, luôn phải nêu rõ; alias `~` bị từ chối |
| Credential | Key từ thẻ cài đặt, nếu không có thì `TYPESAFE_API_KEY` | Thẻ Cloudflare của decision provider, nếu không có thì `CLOUDFLARE_API_TOKEN` | Thẻ OpenRouter của decision provider, nếu không có thì `OPENROUTER_API_KEY` |
| Thân request | System One: `{state, model, questions}` | Cùng một thân | Cùng một thân |
| Response | Câu trả lời System One | Cùng câu trả lời đó nằm trong envelope REST của Cloudflare; chỉ `success: true` mới được mở ra | Câu trả lời System One cộng thêm `id`, `provider` và `usage.cost` của OpenRouter, các trường này bị bỏ. Model trả về là bản snapshot có ngày của slug được ghim (`typesafe/jev-1.13-20260917`) và được chấp nhận; model khác là drift. |

Những gì rời khỏi node là giống hệt nhau cho mọi provider: cùng một state đã che và giới hạn kích
thước, cùng các lựa chọn được đưa ra, tất cả được dựng trước khi biết provider nào nhận. Chế độ
local-only từ chối tất cả, và mọi lỗi đều fallback đúng như mô tả ở
[Failure behaviour](#failure-behaviour). Đổi provider là đổi bên nhận dữ liệu quyết định, nên đó là một
quyết định chia sẻ dữ liệu chứ không chỉ là một lựa chọn kỹ thuật. Với OpenRouter, có hai bên nhận dữ
liệu: OpenRouter và công ty phục vụ model.

OpenRouter đánh dấu decisions API của họ là alpha. Trang API reference ghi đường dẫn
`/api/v1/api/alpha/decisions` trong khi các hướng dẫn dùng `/api/alpha/decisions`; node gọi đường dẫn
thứ hai, là đường dẫn đã trả lời khi chạy thật (bên dưới).

Cloudflare công bố benchmark so sánh Clef với Jev. Đó là số liệu của nhà cung cấp trên workload của
họ, không phải bằng chứng về các quyết định của node này, và vì thế mặc định không thay đổi.

**Khi nào thay đổi có hiệu lực.** Thay đổi provider, model, account id của Cloudflare hay key, làm
trong Cài đặt hoặc qua API, có hiệu lực từ quyết định kế tiếp. Node không khởi động lại, và một lời gọi
quyết định đang chạy sẽ kết thúc với cấu hình lúc nó bắt đầu: một lời gọi không bao giờ ghép key của
provider này với endpoint của provider khác. Dòng in lúc khởi động (xem runbook) vẫn mô tả node như lúc
nó khởi động. Thay đổi biến môi trường, kể cả `CLARKCANT_JEV_LOCAL_ONLY` và `CLARKCANT_JEV_ENABLED`, vẫn
cần khởi động lại; Cài đặt và API đều không thể gỡ chế độ local-only.

**Xem cấu hình đang có hiệu lực.** `GET /decision-provider` trả về provider và model đang có hiệu lực,
cái gì đã chọn chúng (`settings`, `environment` hoặc `default`), host nhận quyết định, key lấy từ đâu
(`vault`, `environment` hoặc `none`, không bao giờ là giá trị), với Cloudflare thì account id lấy từ
đâu, một `status` (`ready`, `local-only`, `misconfigured`, `no-credential` hoặc `disabled`) kèm lý do,
kết quả của lời gọi gần nhất kể từ khi node khởi động, và nguồn credential của từng provider, để một bộ
chọn có thể cho thấy provider nào đã sẵn sàng.

**Chuyển về TypeSafe.** Chọn TypeSafe (hoặc "theo môi trường") trong Cài đặt, hoặc bỏ
`CLARKCANT_DECISION_PROVIDER` (hoặc đặt thành `typesafe`) rồi khởi động lại. Một surface do provider
khác chọn vẫn đọc được: một lượt được phát lại trả về surface đã lưu mà không hỏi provider nào, và
provenance của nó vẫn ghi provider và model đó, vì nó ghi lại ai đã quyết định chứ không phải cấu hình
hiện tại. Quyết định mới được ghi như một node mặc định vẫn ghi, không có trường `provider`. Còn hạ chính
node về một bản phát hành cũ hơn thì khác: bản phát hành có schema surface đã lưu không biết
`provider: "cloudflare"` (hoặc, trước khi hỗ trợ OpenRouter, `provider: "openrouter"`) sẽ từ chối đọc
surface đó (phát lại hay làm mới nó sẽ thất bại). Hãy chuyển provider về trước, và giữ một bản phát hành
đọc được trường này chừng nào các surface đó còn cần.

**Bằng chứng chạy thật (2026-10-08).** Chạy với key thật và chỉ state tổng hợp, bằng các bài kiểm tra
tự chọn ở [Running the checks](#running-the-checks):

| Provider và model | Chọn template | Câu hỏi có/không |
|---|---|---|
| Cloudflare `clef` | đạt | đạt |
| Cloudflare `clef-flash` | đạt | đạt |
| OpenRouter `cloudflare/clef` | đạt | đạt |
| OpenRouter `cloudflare/clef-flash` | đạt | đạt |
| OpenRouter `typesafe/jev-1.13` | bị chặn: một HTTP 529 (provider quá tải), sau đó hết giờ | bị chặn |
| TypeSafe `jev-1.13.0` trực tiếp | bị chặn: hết giờ ở 4 s và 20 s | bị chặn |

Các lần chạy đạt đi qua cùng bước kiểm tra model và phân tích response như production, nên envelope
và model id của Clef mà adapter mong đợi đã được xác nhận khi chạy thật. Hai hàng bị chặn là tình trạng
sẵn sàng trong ngày hôm đó, không phải kết luận về tương thích: TypeSafe vẫn trả lời bài kiểm tra từ
chối model sai đúng như mong đợi.

### The exact-model gate

`jev-1.13.0` was verified against the live endpoint on 2026-09-17: HTTP 200 in 999 ms with the
response naming `jev-1.13.0`, and the alias `jev-latest` resolving to the same id in 673 ms. The
adapter re-checks this on every call. If the response names a different model, the call is reported
as unavailable with `model_drift` in telemetry rather than accepted. A policy calibrated against
one model is not a policy calibrated against whatever answers next.

## What is sent

One request, containing:

- the user's intent, **sanitized**: control characters collapsed, token-shaped strings, JWTs,
  long base64/hex runs, email addresses and phone-like digit runs replaced with `[redacted]`, and
  the whole string truncated to 1000 characters;
- the locale;
- candidate **ids and kinds** — `overview@1`, `canvas.line@1@1.0.0` — plus the field *names* of a
  definition's props schema (`datasetRef:string!`);
- data references as `{ref, kind, scale, freshness}`, where `scale` is a bucket (`empty`, `small`,
  `medium`, `large`) rather than a count.

It never contains row values, private titles, file paths, message history, image bytes, the API
key, or any host-owned card. The assembled state is capped at 16 KiB and is refused before the call
rather than sent and rejected. A second check re-scans the serialized state for a credential
and refuses to send it at all if one survives.

**Trần data class.** Trong mọi lời gọi quyết định, dù là quyết định nào và provider nào nhận, nội dung
do người dùng, một tệp hay một bản ghi cung cấp chỉ được thuộc các class mà selector được phép xem:
`public` và `internal` (`SELECTOR_DATA_CLASSES`, cùng giới hạn mà context planner áp dụng). Nội dung
vượt trần bị bỏ ra trước khi dựng request, không bao giờ gửi đi rồi mới lọc:

- một ứng viên đại diện cho một bản ghi dữ liệu của người dùng (một kết quả tìm kiếm, một ghi nhớ hay
  một tin cũ hơn) chỉ được đưa ra khi toàn bộ bản ghi nằm trong trần. Một kết quả tìm kiếm được xét
  trên toàn bộ mục đã lưu, không phải trên đoạn trích 200 ký tự cắt ra từ nó, vì một giá trị bị cắt
  đôi ở mép đoạn trích không còn trông giống chính nó. Kết quả bị bỏ ra vẫn giữ vị trí trong thứ hạng;
  khi còn lại ít hơn hai kết quả, provider hoàn toàn không được hỏi;
- văn bản tự do (lời người dùng, tên thư mục, mô tả của một ứng viên, các quy tắc guardrail của chính
  người dùng) được che trên toàn văn trước khi cắt, và được kiểm tra lại sau khi cắt. Một lần cắt để
  lại một dạng nhạy cảm (mười chữ số vốn nối liền với chữ cái nay đứng cuối văn bản) sẽ được che lần
  nữa, và văn bản vẫn vượt trần thì không được gửi.

Những gì do chính host viết được miễn khỏi trần này, vì với bộ phân loại theo hình dạng, một model id
có ngày tháng trông như số điện thoại:

- định danh: id lựa chọn, ref, id và loại của ứng viên, locale, và các con số đếm;
- các chỉ dẫn và câu mô tả lựa chọn cố định của host;
- mô tả trong danh mục: `alias (provider/modelId)` của một tuyến model, nhãn của một template trình
  bày, mô tả của một cách thu hẹp mà guardrail đưa ra, và dòng `about` của một nhóm tool.

Chúng vẫn nằm trong phạm vi kiểm tra credential bên dưới. Trường nào trong request của từng quyết
định thuộc bên nào được liệt kê từng trường một trong
`apps/runtime/test/decision-request-fields.spec.ts`; một trường mới sẽ làm test đó thất bại cho tới khi
nó được xếp vào một bên.

Bước cuối cùng trước khi gọi bất kỳ provider nào, dù provider nào được chọn, trước hết đo request đã tuần
tự hoá: request lớn hơn 64 KiB không được gửi, và không gì đọc tiếp nó. Sau đó bước này quét toàn bộ
request (state và các câu hỏi, kể cả mô tả của từng lựa chọn) để tìm credential, bằng bộ phân loại mà
ranh giới gửi dùng cho đầu vào của model. Id và tên chỉ giống token thì không tính; một header HTTP Basic
được viết thành một key và giá trị của nó (`{"Authorization": "Basic …"}`), thành một phép gán
(`headers["Authorization"] = "Basic …"`) hay trong dấu backtick thì có tính. Nếu phát hiện,
request hoàn toàn không được gửi; lời gọi quay về phương án dự phòng như mọi lỗi provider khác, và lý do
cùng telemetry không chứa phần nào của giá trị.

`CLARKCANT_JEV_LOCAL_ONLY=1` disables outbound calls entirely. The composition step then uses the
deterministic path and the default-model fallback, exactly as it does when the provider is down.

## Policy

| Setting | Default | Behaviour |
|---|---|---|
| Choice floor | 0.85 | The winner's probability must reach it, read from the distribution. |
| Margin floor | 0.20 | The winner must lead the runner-up by at least this much. |
| Noul on | 0.85 | Probability at or above this is a yes. |
| Noul off | 0.15 | Probability at or below this is a no. |
| Noul middle band | 0.15–0.85 | **Uncertain.** The smoke test returned 0.58 for a general calendar question; this band exists so that answer is not rounded into a decision. |

The floors and the margin are applied together. A 0.90 winner beside a 0.85 runner-up passes the
floor and fails the margin, and is treated as a coin toss rather than a choice.

These numbers are proposed, not calibrated: the live calibration against the labelled corpus on
2026-09-17 left them unchanged for want of cases in the middle band, and its outcome is recorded in
the release evidence rather than tuned to taste.

## Failure behaviour

| Condition | Outcome |
|---|---|
| No key, disabled, or local-only | `unavailable`; no network call. |
| Tên provider không xác định, model hay account id của Cloudflare bị thiếu hoặc sai dạng, hoặc model của OpenRouter bị thiếu, là alias, hoặc không phải slug được ghim | `unavailable`; không có lời gọi mạng, và lý do nêu tên thiết lập. |
| Chọn TypeSafe nhưng model id là của Cloudflare (`clef`, `clef-flash`, hoặc bất kỳ id `@cf/` nào) hoặc là slug của OpenRouter (bất cứ thứ gì có `/`) | `unavailable`; không có lời gọi mạng, và lý do hướng dẫn chọn provider phục vụ model đó hoặc bỏ `CLARKCANT_DECISION_MODEL`. |
| Lựa chọn trong Cài đặt không thuộc một trong ba dạng, hoặc key rỗng hay dài quá 4096 ký tự | Bị từ chối khi lưu, nêu tên trường và không bao giờ nêu giá trị; cấu hình đang có hiệu lực không đổi. |
| Còn sót một credential ở bất kỳ đâu trong request | `unavailable`; không có lời gọi mạng, và lý do không chứa phần nào của giá trị. |
| Request lớn hơn 64 KiB sau khi tuần tự hoá | `unavailable`; không có lời gọi mạng, và request không bị quét. |
| Ít hơn hai kết quả tìm kiếm nằm trong trần của selector | Giữ nguyên thứ hạng; không có lời gọi mạng. |
| Budget exhausted before a call | `unavailable`; no network call. |
| 401 | `unavailable`, reason names the credential, not the request. |
| 422 | `unavailable`; body lỗi của provider bị huỷ mà không đọc, và không bao giờ được trả về, ghi log hay lưu lại. |
| 429 / 529 / 5xx | `unavailable`; **no retry**. A retry inside a four-second budget only makes a slow answer a late one. |
| Deadline exceeded | The call is aborted through its `AbortSignal`, and the reason names the budget. |
| Một redirect | Lời gọi thất bại thay vì đi theo redirect, nên credential không bao giờ tới một host mà bước kiểm tra endpoint chưa duyệt. Áp dụng cho cả hai provider. |
| Response lớn hơn 256 KiB | Không đọc quá giới hạn (theo độ dài khai báo, hoặc bằng cách đếm luồng dữ liệu), và bị coi là sai dạng. Đường gọi chung giữ cùng giới hạn đó bất kể transport nào đưa câu trả lời về. Áp dụng cho cả hai provider. |
| Malformed or drifted response | `abstained` or `unavailable`; a missing field is never read as a default. Với Cloudflare, envelope không có `success: true` hoặc không có `result` dạng System One được coi là sai dạng. Với OpenRouter, model khác slug được ghim hoặc bản snapshot có ngày của nó (`<slug>-YYYYMMDD`) là drift. |
| Low confidence, tie, or `none` | `abstained`, with the reason recorded. |

An abstention is not a failure. It is the answer that says "no offered option fits", and the
caller's job is then to fall back — a deterministic template compile, the configured model, or a
clarifying question — and to record that the composition was a fallback.

## Telemetry

One line per call, printed through the injected sink and kept to the last 200 in memory. It holds:
request id, event (`call`, `refusal`, `policy`, `model_drift`, `error`, `oversized_state`), model id,
policy version, duration, question count, token counts, the selected enum, and a reason. Khi một
provider khác TypeSafe được chọn, mỗi dòng còn nêu tên provider đó (`provider: "cloudflare"` hoặc
`provider: "openrouter"`); dòng từ một node mặc định không có trường `provider`, giống hệt trước đây.
Model id là model mà provider đã trả lời, nên một dòng của OpenRouter ghi bản snapshot có ngày đã phục
vụ lời gọi. Model id do provider trả về được cắt còn 64 ký tự trước khi được ghi lại hoặc nhắc lại
trong một lý do. `GET /decision-provider` hiện event, status, model, thời lượng và lý do của dòng gần
nhất.

Quy tắc này cũng áp dụng cho những gì được lưu kèm một quyết định: provenance của bộ chọn trong một
composition và bản ghi decider của kết quả tìm kiếm chỉ có `provider` khi provider đó không phải TypeSafe.

It holds **no** request body, no prompt, no headers, no key, and no full URL with a query. The
provider's error bodies are discarded for the same reason — they routinely echo the request.

`NodeServices.jev.providerCallCount()` exposes the count of provider calls made by the process.
It exists so that "rendering history does not call the provider" is an assertion rather than a
claim.

## Operator runbook

**The selector is one flag and one credential.** At startup the node prints one line about it:

```
selector: jev-1.13.0 pinned, 4000 ms per turn
selector: clef-flash pinned on cloudflare, 4000 ms per turn
selector: disabled (no credential or local-only); composed surfaces use the deterministic path
```

Dạng thứ hai chỉ xuất hiện khi một provider khác được chọn (`on cloudflare`, `on openrouter`). Dòng
này mô tả node lúc khởi động: một provider được chọn, hay một key được lưu hoặc xoá, trong Cài đặt sau
đó thay đổi cách selector hoạt động mà không làm thay đổi dòng này. `GET /decision-provider` là câu trả
lời hiện tại.

If that line says disabled, everything still works: composed surfaces compile through the
deterministic path, search ranks with BM25, and the finder resolves by ranking or by asking one
question. Nothing in the product depends on the provider being reachable, which is the point of the
fallback.

**Turning it off in a hurry.** Set `CLARKCANT_JEV_LOCAL_ONLY=1` and restart. That outranks a key
being present, so it cannot be undone by an environment that still has one.

**Deciding whether to turn the search decider on.** `rank` is the default because it is the measured
one, and it has now been measured both ways. Deterministically, the labelled corpus answered 96.8% of
lexical queries with BM25 alone. Live, with `jev-1.13.0` on the same corpus, the selector tied it:
31/34 (91.2%) either way, and 8/16 on the routing corpus. Nothing beat the ranking, so nothing bought
the extra call per search. `CLARKCANT_SEARCH_DECIDER=jev` is opt-in, and the comparison harness is
`CLARKCANT_JEV_LIVE=1 pnpm exec vitest run apps/runtime/test/jev-calibration-live.spec.ts`. It prints
a per-case line and a total for both paths; the numbers belong in a report before the default
changes — see `plans/reports/verification-260917-1815-jev-live-integration-and-calibration.md`.

**Turning semantic search on, and when not to.** It needs two optional native pieces on the machine:
`sqlite-vec` (the vector index) and the local embedding runtime with E5-small (`@huggingface/transformers`
plus `onnxruntime-node`). Both are `optionalDependencies` of the runtime, so a checkout without them
installs, boots and passes `pnpm verify` — search is simply lexical, and the search answer says which
reason applies (a `semantic.reason` on a `/search/sessions` response, and
`NodeServices.vectors.status()` in process): the extension is missing, the model could not be loaded,
or the index holds vectors from a different model and needs a reindex.

It is off by default for a measured reason, not a cautious one. On the 34-query labelled corpus the
lexical path answered 31 top-1 correctly; the hybrid path also answered 31 when the cosine ceiling was
0.1, and only 25 when the ceiling was 0.2 or higher — because a KNN query always returns its nearest
neighbours, so a question whose honest answer is "nothing in your history" came back with a near-miss.
The semantic-only subset (queries that share no vocabulary with the target) stayed at 9/12 either way.
Turn it on with `CLARKCANT_SEARCH_SEMANTIC=1` when the history is large enough that a near-miss beats
nothing, and re-measure with
`CLARKCANT_EMBEDDINGS_LIVE=1 pnpm exec vitest run apps/runtime/test/hybrid-calibration-live.spec.ts`,
which prints a per-ceiling sweep. The numbers belong in a report before the default changes.

**Một surface được dựng tốn bao nhiêu.** Mỗi lần dựng tốn một lô gọi selector khi chưa có template nào
được nêu tên (tối đa hai lô, nếu template làm đổi tập ứng viên), và không tốn lời gọi nào khi model đã
nêu tên một template. Tìm kiếm chỉ tốn một lời gọi khi `decider = jev`, có ít nhất hai kết quả sát
nhau, thứ hạng chưa tự tách chúng ra, và có ít nhất hai kết quả nằm trong trần data class của
selector. Việc xét class của các kết quả tốn thêm cho tìm kiếm nhiều nhất một lần đọc: kết quả từ tìm
kiếm theo từ khoá được xét trên chính văn bản mà tìm kiếm đã trả về, các kết quả chỉ phía vector tìm
thấy được đọc lại cùng nhau trong một truy vấn duy nhất, và chỉ những kết quả sắp được đưa cho selector
mới được xét.

**Project finder.** `workspace.roots` and `workspace.ignore` are preferences on the node (default:
the home directory, and the system ignore list). Changing them needs no restart. What the selector
sees from the finder is a name, a path relative to the root, a kind and marker names — never an
absolute path and never a file's contents. The scan is bounded (depth 5, 20 000 entries), skips
symlinks and dependency directories, and stops descending as soon as it finds a project marker.

When the finder finds nothing, it asks the user for a directory, and the answer is a path. On the
desktop build the client also offers the OS directory dialog for that answer (`pickDirectory()` on
the shell's bridge, channel `desktop:pickDirectory`), and the path it returns is submitted through
the same route as a typed one; the web build has no bridge, so the text field is the whole answer
there. Three rules make that question answerable and safe:

- **A path is read from the user's own words, before redaction.** The redactor replaces absolute
  paths with a placeholder — a home path is what it exists to remove — so reading it afterwards would
  have discarded the answer and asked again. The path is used locally to open a directory; the
  redacted text is what any search or selector call sees.
- **A directory the user names is indexed even when nothing marks it**, because naming it is the
  signal. It still has to be inside an approved root: a path is not a way to reach outside what the
  user approved, and a path that is missing, outside the roots, or not a directory is refused with
  that reason rather than met with the question again.
- **The directory used last is offered, not opened.** A query that matches nothing but has a recent
  project produces a question ("did you mean …?"); silently opening the last one is how asking for a
  project that does not exist opens the wrong one.

Paths travel relative to the approved root that contains them, so a workspace on another volume does
not disclose the home directory's layout as a relative path.

**Fixture turns.** `CC_MODEL_FIXTURE=1` replaces the model turn with a scripted one that composes an
overview through the production pipeline. `CC_SESSION_FIXTURE=1` does the same for starting a worker
session in a chosen directory: it reports a session id and spawns nothing. Both exist so the browser
suite can exercise real paths without a provider, both print a line saying they are loaded, and
neither belongs on a node a person uses: the reply says a fixture produced it and the node says so at
startup.

## Running the checks

```bash
# Unit and boundary tests: no credentials, no network.
pnpm exec vitest run apps/runtime/test/jev-selector.spec.ts
pnpm exec vitest run apps/runtime/test/cloudflare-decision-provider.spec.ts apps/runtime/test/decision-provider-parity.spec.ts
pnpm exec vitest run apps/runtime/test/openrouter-decision-provider.spec.ts apps/runtime/test/decision-provider-settings.spec.ts

# Live smoke: opt-in, needs a real key, sends only synthetic state.
CLARKCANT_JEV_LIVE=1 pnpm exec vitest run apps/runtime/test/jev-live.spec.ts

# Live smoke cho Clef: opt-in, cần các thiết lập Cloudflare ở trên, chỉ gửi state tổng hợp.
CLARKCANT_CLEF_LIVE=1 pnpm exec vitest run apps/runtime/test/clef-live.spec.ts

# Live smoke cho OpenRouter: opt-in, cần OPENROUTER_API_KEY và CLARKCANT_DECISION_MODEL (một slug được ghim).
CLARKCANT_OPENROUTER_DECISION_LIVE=1 pnpm exec vitest run apps/runtime/test/openrouter-decision-live.spec.ts
```

Mỗi file live báo `BLOCKED` kèm biến còn thiếu khi không chạy được. It deliberately
never passes silently: "no live evidence" and "live evidence is fine" must not look the same in a
test report.

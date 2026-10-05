# Jev selector: configuration and privacy

> [English](jev-configuration.md) (mặc định) · Tiếng Việt

Jev (TypeSafe System One) is the node's *selector*. It chooses among options the host has already
authorized — a presentation template, a renderer for one region, a runtime to dispatch to — and it
may answer `none`. It never receives data, never grants permission, and never decides a side
effect. Everything that turns its answer into something the user sees is host code.

This document is the operator's half: what to set, what leaves the machine, what is recorded, and
what happens when the provider is unavailable.

Selector là một vai trò, và Jev là provider đảm nhận vai trò đó theo mặc định. Người vận hành có thể
chọn Cloudflare Clef trên Workers AI thay thế (xem [Chọn decision provider](#chọn-decision-provider)).
Chính sách của Clark — những gì được đưa ra để chọn, những gì bị che, các ngưỡng, ngân sách thời
gian và mọi fallback — giống hệt nhau dù provider nào trả lời; chỉ endpoint, credential và model được
ghim là khác. Trừ khi một mục nói khác, "provider" bên dưới là provider đang được chọn.

## Configuration

Mọi thiết lập được đọc từ môi trường của process runtime. Credential của provider đang được chọn
(`TYPESAFE_API_KEY`, hoặc `CLOUDFLARE_API_TOKEN` khi chọn Cloudflare) là credential duy nhất được
dùng, và nó không bao giờ được renderer đọc, ghi vào props, lưu trong snapshot hay ghi log. Các thiết
lập `CLARKCANT_JEV_*`, trừ model và endpoint, áp dụng cho provider nào đang được chọn; giá trị `jev`
của `CLARKCANT_SEARCH_DECIDER` hay `CLARKCANT_CONTEXT_DECIDER` nghĩa là "hỏi decision provider đang
được chọn".

| Variable | Default | Meaning |
|---|---|---|
| `CLARKCANT_DECISION_PROVIDER` | `typesafe` | `typesafe` (Jev) hoặc `cloudflare` (Clef). Giá trị khác thì từ chối mọi lời gọi quyết định, chứ không quay về TypeSafe. |
| `CLARKCANT_DECISION_MODEL` | *(xem ý nghĩa)* | Model id chính xác cho provider đang được chọn. Với TypeSafe, nó thắng `CLARKCANT_JEV_MODEL`, và khi không đặt thì thiết lập đó vẫn quyết định. Với Cloudflare, nó là bắt buộc và phải là `clef` hoặc `clef-flash`. |
| `TYPESAFE_API_KEY` | *(none)* | Credential của TypeSafe. Khi chọn TypeSafe, không có key nghĩa là selector bị tắt. |
| `CLOUDFLARE_ACCOUNT_ID` | *(none)* | Chỉ cho Cloudflare. 32 ký tự thập lục phân; giá trị khác thì mọi lời gọi bị từ chối. |
| `CLOUDFLARE_API_TOKEN` | *(none)* | Chỉ cho Cloudflare. Một token được phép chạy Workers AI. Khi chọn Cloudflare, không có token nghĩa là selector bị tắt; key của TypeSafe không bao giờ được dùng thay. |
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
| `CLARKCANT_CONTEXT_DECIDER` | `rank` | `jev` cho selector sắp lại 8 kết quả khớp nhất của phần tóm tắt và bản ghi nhớ khi thứ hạng sát nhau, và chọn một nhóm tool cho tin không nhắc nhóm nào khi đang mở dần tool. Nó chỉ được hỏi khi câu trả lời có thể đổi điều được gửi đi. Khi được hỏi, nội dung rời khỏi node tới provider của Jev: tin đang được trả lời (đã che thông tin nhạy cảm, tối đa 300 ký tự; 400 ký tự khi chọn nhóm tool) và từng ghi nhớ hay tin cũ hơn là ứng viên (đã che, tối đa 200 ký tự). Lỗi hay hết giờ thì giữ thứ tự tất định. Giá trị khác là `rank`. |
| `CLARKCANT_TOOL_DISCLOSURE` | `all` | `progressive` đưa cho hội thoại các tool lõi cùng các nhóm tool mà tin nhắn nhắc tới, chỉ tăng thêm trong một session. Tắt vì đã đo: trong ước tính offline, nó tiết kiệm token schema nhưng tốn hơn khi tính cả việc ghi lại prompt cache (xem [system-architecture.vi.md §7.3](../system-architecture.vi.md)). Giá trị khác là `all`. |
| `CLARKCANT_CONDITIONAL_INSTRUCTIONS` | on | `off` ngừng đọc `.clarkcant/instructions.json` của dự án, nên không hướng dẫn có điều kiện nào được nêu cho hội thoại hay task worker (xem [system-architecture.vi.md §7.2](../system-architecture.vi.md)). Mọi giá trị khác là bật. |
| `CLARKCANT_SESSION_POLICY` | `off` | `observe` báo mỗi lượt session của hội thoại sẽ được giữ hay dựng lại và vì sao, dưới dạng số đếm trên stderr; `rebuild` dựng lại thật, chỉ khi cache đã nguội, context lớn và chủ đề mới (xem [system-architecture.vi.md §7.3](../system-architecture.vi.md)). Với `CLARKCANT_CONTEXT_DECIDER=jev`, Jev được hỏi ở vùng chưa rõ và chỉ được xem số đếm. Mọi giá trị khác là `off`. |

The key belongs in the runtime's environment or its local, gitignored `.env`. It does not belong in
a `VITE_`/`NEXT_PUBLIC_` variable, a URL query, a fixture, or another repository's `.env` path
referenced from code. Một key được lưu qua giao diện sẽ được đọc từ kho credential của node theo tên
provider (`typesafe` hoặc `cloudflare`) khi môi trường không có; biến đặt trong môi trường luôn thắng.

### Chọn decision provider

TypeSafe Jev vẫn là mặc định. Cloudflare Clef chỉ được dùng khi người vận hành đặt đủ cả bốn:

```bash
CLARKCANT_DECISION_PROVIDER=cloudflare
CLARKCANT_DECISION_MODEL=clef        # hoặc clef-flash
CLOUDFLARE_ACCOUNT_ID=<32 ký tự thập lục phân>
CLOUDFLARE_API_TOKEN=<một token được phép chạy Workers AI>
```

| | TypeSafe Jev | Cloudflare Clef |
|---|---|---|
| Nơi nhận request | `https://api.typesafe.ai/v1/systemone`, hoặc `CLARKCANT_JEV_ENDPOINT` | `https://api.cloudflare.com/client/v4/accounts/<account>/ai/run/@cf/cloudflare/<model>`, dựng từ hai giá trị đã kiểm tra; không có cách ghi đè endpoint |
| Model | `jev-1.13.0` nếu không ghi đè | `clef` hoặc `clef-flash`, luôn phải nêu rõ |
| Credential | `TYPESAFE_API_KEY`, nếu không có thì key `typesafe` đã lưu | `CLOUDFLARE_API_TOKEN`, nếu không có thì key `cloudflare` đã lưu |
| Thân request | System One: `{state, model, questions}` | Cùng một thân |
| Response | Câu trả lời System One | Cùng câu trả lời đó nằm trong envelope REST của Cloudflare; chỉ `success: true` mới được mở ra |

Những gì rời khỏi node là giống hệt nhau cho cả hai: cùng một state đã che và giới hạn kích thước,
cùng các lựa chọn được đưa ra, tất cả được dựng trước khi biết provider nào nhận. Chế độ local-only từ
chối cả hai, và mọi lỗi đều fallback đúng như mô tả ở [Failure behaviour](#failure-behaviour). Đổi
provider là đổi bên nhận dữ liệu quyết định, nên đó là một quyết định chia sẻ dữ liệu chứ không chỉ là
một lựa chọn kỹ thuật.

Cloudflare công bố benchmark so sánh Clef với Jev. Đó là số liệu của nhà cung cấp trên workload của
họ, không phải bằng chứng về các quyết định của node này, và vì thế mặc định không thay đổi.

Những gì chưa được kiểm chứng với dịch vụ Workers AI thật: model id chính xác trong response của Clef
(`clef` và `@cf/cloudflare/clef` đều được đọc là `clef`; mọi giá trị khác bị từ chối như drift), và
envelope mà Clef thực sự trả về, vốn đang theo tài liệu REST chung của Cloudflare. `clef-live.spec.ts`
(bên dưới) là bài kiểm tra sẽ tạo ra bằng chứng đó.

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
rather than sent and rejected. A second check re-scans the serialized state for secret-shaped
values and refuses to send it at all if one survives.

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
| Tên provider không xác định, hoặc model hay account id của Cloudflare bị thiếu hoặc sai dạng | `unavailable`; không có lời gọi mạng, và lý do nêu tên thiết lập. |
| Budget exhausted before a call | `unavailable`; no network call. |
| 401 | `unavailable`, reason names the credential, not the request. |
| 422 | `unavailable`; the provider's error body is read and discarded. |
| 429 / 529 / 5xx | `unavailable`; **no retry**. A retry inside a four-second budget only makes a slow answer a late one. |
| Deadline exceeded | The call is aborted through its `AbortSignal`, and the reason names the budget. |
| Malformed or drifted response | `abstained` or `unavailable`; a missing field is never read as a default. Với Cloudflare, envelope không có `success: true` hoặc không có `result` dạng System One được coi là sai dạng. |
| Low confidence, tie, or `none` | `abstained`, with the reason recorded. |

An abstention is not a failure. It is the answer that says "no offered option fits", and the
caller's job is then to fall back — a deterministic template compile, the configured model, or a
clarifying question — and to record that the composition was a fallback.

## Telemetry

One line per call, printed through the injected sink and kept to the last 200 in memory. It holds:
request id, event (`call`, `refusal`, `policy`, `model_drift`, `error`, `oversized_state`), model id,
policy version, duration, question count, token counts, the selected enum, and a reason. Khi một
provider khác TypeSafe được chọn, mỗi dòng còn nêu tên provider đó (`provider: "cloudflare"`); dòng
từ một node mặc định không có trường `provider`, giống hệt trước đây.

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

Dạng thứ hai chỉ xuất hiện khi Cloudflare được chọn.

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

**What a composed surface costs.** One selector batch per composition when no template was named (two
at most, if the template changes the candidate set), and zero when the model names a template. Search
costs one call only when `decider = jev`, at least two results are close, and the ranking did not
already separate them.

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

# Live smoke: opt-in, needs a real key, sends only synthetic state.
CLARKCANT_JEV_LIVE=1 pnpm exec vitest run apps/runtime/test/jev-live.spec.ts

# Live smoke cho Clef: opt-in, cần các thiết lập Cloudflare ở trên, chỉ gửi state tổng hợp.
CLARKCANT_CLEF_LIVE=1 pnpm exec vitest run apps/runtime/test/clef-live.spec.ts
```

Mỗi file live báo `BLOCKED` kèm biến còn thiếu khi không chạy được. It deliberately
never passes silently: "no live evidence" and "live evidence is fine" must not look the same in a
test report.

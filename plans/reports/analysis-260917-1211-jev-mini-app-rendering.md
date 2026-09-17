# Mini-app rendering với Jev — đề xuất và gap analysis

## Kết luận

Triển khai Jev như **bộ chọn presentation có kiểu**, không phải model sinh React/HTML. Main LLM hiểu yêu cầu và diễn giải; Jev chọn giữa những template và data candidates hợp lệ; host kiểm tra, biên dịch, lưu spec rồi React render bằng catalog. Không gọi Jev từ render, mount, reload hay mở pin.

Ba quyết định người dùng đã xác nhận:
1. **Jev chọn + code ghép**; main LLM tiếp tục viết nội dung và đề xuất tác vụ.
2. **Snapshot + mở live**; lịch sử bất biến, mở/ghim cùng logical instance để thao tác dữ liệu hiện tại.
3. **Đủ sketch, dữ liệu local**; milestone có tương tác thật, không chỉ giống hình. Google Calendar OAuth và custom iframe/SDK là các nhánh sau, không phải tính năng đã có.

Phạm vi lần này: nghiên cứu và kế hoạch. Không sửa source, không chạy feature tests, không commit/push. Kế hoạch: [Jev mini-app rendering](../260917-0528-jev-mini-app-rendering/plan.md). CLI sinh timestamp UTC `0528`; dùng nguyên thư mục do CLI quản lý thay vì đổi tên làm lệch plan store.

## 1. Đọc hai sketch

Nguồn: [surface](../../docs/mini-app/mini-app-surface.jpeg), [conversation](../../docs/mini-app/mini-app-in-conversation.jpeg).

Hai hình là yêu cầu về một trải nghiệm mini-app dùng lại được ở hai vị trí, không phải hai dashboard độc lập. Các thành phần cần có: chỉ số tổng hợp, lựa chọn khoảng thời gian, biểu đồ, lịch, ảnh, CTA. Trong conversation, presentation nằm cạnh diễn giải; khi mở rộng vẫn giữ identity, filter và dữ liệu hiện hành. Các tên template, nguồn dữ liệu và hành vi dưới đây là **đề xuất kỹ thuật**, không phải thông tin suy ra chắc chắn từ ảnh.

| Vùng | Hợp đồng đề xuất | Hành vi phải chứng minh |
|---|---|---|
| KPI | Metric label/value/unit + provenance | Tính từ cùng dataset revision với chart |
| Dropdown | Week/month enum, timezone | Đổi khoảng ngày thật; không gọi lại Jev |
| Chart | Time-series line/bar; donut riêng cho category | Dữ liệu khớp filter; không giả donut bằng bar |
| Calendar | Date/title/event id, timezone | Chọn ngày hiển thị event; local, chưa phải Google sync |
| Image | Opaque approved artifact ref + alt | Host phục vụ ảnh đã kiểm tra; không remote URL tùy ý |
| CTA | Server-compiled binding | Lưu bản xem/ghim có kết quả và chống double click |
| Conversation | Timestamped snapshot + text alternative | Không đổi số liệu cũ khi live instance thay đổi |
| Expanded/pinned | Một logical live owner | Không tạo bản sao mini-app khi đổi vị trí |

## 2. Jev làm gì — và không làm gì

Nguồn chính thức đã đọc:
- [Quickstart](https://docs.typesafe.ai/introduction/quickstart)
- [Docs index](https://docs.typesafe.ai/llms.txt)
- [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [API](https://docs.typesafe.ai/api)
- [Confidence](https://docs.typesafe.ai/confidence)

API `POST https://api.typesafe.ai/v1/systemone` nhận `state`, `model`, `questions`; auth Bearer chỉ ở server. Choice chọn option và trả probabilities/confidence; Score đánh giá theo descriptive levels; Noul trả xác suất yes. Noul không có nghĩa là boolean chắc chắn. Không dùng Score/Noul thay cho authorization.

**Giá trị Jev:** phân loại ý định ngôn ngữ tự nhiên giữa nhiều kiểu hiển thị và candidate dataset phù hợp. Nếu caller đã chỉ rõ template hợp lệ hoặc người dùng đổi filter, code deterministic là đủ. Không ép một model call vào mọi UI action để biện minh cho tích hợp.

Ví dụ yêu cầu tổng quan công việc → `overview`; dữ liệu ngày → `line`; dữ liệu category → `bar/donut`. Code chỉ cho Jev thấy các candidate đã được kiểm tra access/schema, kèm lựa chọn `none`. Jev không tự đặt dataset id, tool name, capability, CSS, URL hoặc permission.

### Bằng chứng provider smoke

Ngày 2026-09-17, một request dùng state tổng hợp không chứa dữ liệu người dùng, key đọc qua đường không echo:
- HTTP 200; 1075 ms.
- Alias `jev-latest` được response báo là `jev-1.13.0`.
- `template=overview`, confidence 0.99; `chart=line`, confidence 0.99; `calendar` Noul 0.91.
- Usage: 655 input tokens, 90 output tokens. **Không phải chi phí tiền tệ.**

Đây là một **provider smoke**, không phải kiểm chứng UI, latency SLO, calibration hay reliability. Chưa kiểm chứng gọi trực tiếp model id `jev-1.13.0`. Implementation phải thử exact id trước khi pin; không silent fallback sang latest. Nếu exact id không được API hỗ trợ, báo blocker hoặc xin chấp thuận alias có monitoring drift.

## 3. Kiến trúc đề xuất

```text
User intent / main LLM show_view request
  → runtime composeMiniApp step (async, explicit)
  → authorized candidate builder (schema + provenance, bounded metadata)
  → Jev selection OR deterministic explicit-selection path
  → validate selection + confidence policy + capability compatibility
  → pure host compiler: SurfaceCompositionSpec
  → transaction: instance + composition + bindings + snapshot + message
  → timeline DTO
      ├─ immutable snapshot renderer (conversation)
      └─ live surface renderer (expanded/pinned, one owner)
Action → gateway → current authorization + revision/digest/idempotency
       → state/data update → live redraw (no Jev re-selection)
```

### 3.1 Surface granularity

Chọn **composite surface gồm nhiều leaf catalog blocks**, không sinh một cây DOM tự do và không biến mỗi child thành một mini-app độc lập. Một composition có một logical instance, revision và live owner. Leaf sections dùng lại renderer/catalog schemas hiện có; state dùng key theo section trong parent.

Contract `surface` hiện có chỉ trỏ một definition/snapshot. Để giữ compatibility, thêm một host catalog definition mỏng `canvas.overview@1` làm entry của composition; props chứa reference đến `SurfaceCompositionSpec`, không nhét rows vào message. Composition renderer chỉ xếp leaf renderer theo slots cố định. Đây là host layout container, không phải widget khổng lồ tự quản data/actions. `prepareBlocksForRender` vẫn là validation/fallback boundary, **không phải layout engine**.

Không thêm một message-block type tùy ý. Mọi host-owned card vẫn ngoài catalog này. Không có recursive arbitrary nesting; v1 chỉ một tầng sections, tối đa 12 sections, mọi leaf thuộc allowlist và version được pin.

### 3.2 Spec seam (mới, chưa triển khai)

`SurfaceCompositionSpecV1` gồm:
- `schemaVersion: 1`, `compositionId`, `instanceId`, `templateId`, `templateVersion`, `catalogDigest`.
- `sections[]`: stable `sectionId`, slot enum, exact `definitionRef`, bounded validated props, authorized versioned data refs, text alternative.
- `initialState`: period enum, selected date, timezone; live state sau đó nằm trong widget_state.
- `actions`: refs đến bindings do server compile; không nhận proposal executable từ Jev.
- `provenance`: createdAt, source revisions, selector mode/model/policy version, sanitized selection summary.

Các entry snapshot còn giữ exact definition digest và **materialized presentation bundle** hoặc refs tới immutable dataset/artifact revisions. `presentationRef` hiện tại dạng `catalog:id` chỉ nói renderer nào, chưa giữ dữ liệu đã thấy. Không thể gọi current dataset rồi gắn timestamp cũ để giả snapshot.

Snapshot bundle lưu trong storage riêng, timeline mang opaque ref. Giới hạn đề xuất: selection metadata ≤16 KiB, presentation bundle ≤1 MiB; oversize trả fallback có lý do, không cắt âm thầm. Artifact bytes tách riêng, tránh nhân bản ảnh vào mỗi message. Chính sách xóa dữ liệu có thể xóa bundle theo authorization/privacy; message còn text tombstone thay vì hồi sinh nội dung đã xóa.

### 3.3 Selection policy

- Một batch hỏi template và các lựa chọn độc lập; validate lại cả combination sau response. Không nhân các confidence thành xác suất joint.
- Nếu template quyết định candidate set, chỉ thêm một follow-up batch cần thiết; v1 tối đa 2 calls, total deadline đề xuất 4 giây, không retry lồng SDK + caller.
- Mốc khởi đầu **chưa calibrated**: Choice top ≥0.85 và margin với runner-up ≥0.20; Noul ≥0.85 bật, ≤0.15 tắt, vùng giữa không đoán. Optional section có thể bỏ với explanation; ambiguity về mục tiêu chuyển text/clarifying question.
- `none`, low confidence, malformed payload, unknown id/version, timeout, 429/5xx: **fallback do pi agent/model mặc định generate template** (quyết định user 2026-09-17 — Jev là giải pháp thử nghiệm, cần khả năng hoạt động độc lập khi nó biến mất); nếu model fallback cũng không cho template hợp lệ thì text fallback. Không trả UI trắng, không trình bày kết quả fallback như Jev đã chọn.
- Model output không cấp quyền, không chọn account/node/resource ngoài candidates. Schema-valid vẫn cần semantic/data compatibility check.
- Cache theo authorized scope, intent digest, catalog/policy/model version và data schema/revision signature; không cache permission decision. Replay message dùng spec đã persist, không gọi provider.

### 3.4 Dữ liệu local thật — baseline đề xuất

- **Task metrics/trend:** derive từ tasks/runs/events trong SQLite của node hiện tại; field map chuẩn hóa `taskId/status/createdAt/completedAt`. Phase 1 phải xác minh field thực tế, không giả completedAt tồn tại. Nếu cần derive từ lifecycle events, lưu provenance và ngày UTC.
- **Calendar:** local events do người dùng nhập qua runtime CRUD; lưu `id/title/start/end/timezone` và principal scope. Tasks không có lịch không được tự bịa due date. Google Calendar là connector sau.
- **Image:** ảnh người dùng import vào approved artifact store; MIME/size/dimensions/path kiểm tra ở host; alt text bắt buộc. Không dùng screenshot tham chiếu làm dữ liệu sản phẩm mặc định.
- **CTA:** lưu bản xem = lưu current filter/state rồi pin same instance, không dispatch arbitrary agent task. Cần có toast/status, durable result và idempotency.
- Khi store rỗng: empty state thật, có hướng dẫn tạo event/import ảnh; tuyệt đối không điền số liệu mẫu để giống sketch.
- Test tạo records/files trong isolated local store qua production API. Fixture provider có thể dùng để fault injection/deterministic CI, nhưng không được tính là bằng chứng model live hoặc dữ liệu production. Acceptance visual dùng dataset local có ghi rõ nguồn do người dùng tạo/import.

### 3.5 Security và observability

Key qua server env `TYPESAFE_API_KEY`; không hardcode đường dẫn .env của repo khác trong implementation. Dev dùng secret loader riêng; deploy dùng secret injection. Không VITE_/NEXT_PUBLIC_ key, không localStorage, URL query, payload logs hay snapshots chứa secrets.

Dữ liệu gửi Jev mặc định chỉ intent đã sanitize và metadata/schema đã allowlist, không raw rows, tên event riêng tư, nội dung ảnh hay lịch sử chat toàn bộ. Nếu intent vẫn chứa dữ liệu nhạy cảm, không gửi cho đến khi có policy/consent cho third-party processing; local-only mode dùng deterministic fallback. Tenant/principal isolation phải có ở candidate builder và action gateway.

Telemetry chỉ request id, model id, schema/policy version, duration, tokens, fallback reason, enum selection; không response body/prompt/header thô. Redact lỗi SDK trước logging. Cancellation không tạo nửa instance. Provider error không block conversation narration.

## 4. Gap matrix: mini-app

Các nhận xét dưới đây là static inspection trên checkout, không phải test end-to-end.

| Gap | Có sẵn / bằng chứng | Việc cần làm | Phase |
|---|---|---|---|
| Selector | `apps/runtime/src/model-turn.ts`: show_view; chưa tìm thấy Jev adapter trong path đọc | Explicit compose step, typed adapter, confidence/fallback | 2,5 |
| Composition | `apps/runtime/src/view-catalog.ts:55` map từng widget; mỗi build một surface | Bounded spec + host layout container + catalog leaf reuse | 1,3 |
| UI parity | `packages/conversation-client/src/renderers.tsx:391` donut đang dùng BarChart | Metrics/filter/calendar/image/CTA, donut đúng, responsive states | 3 |
| History correctness | `packages/core/src/widget-service.ts` captureSnapshot giữ revision/ref/text; `apps/runtime/src/services.ts:206`, `Conversation.tsx:255` lấy current props | Persist exact snapshot presentation/data; DTO snapshot/live tách biệt | 1,4 |
| Actions | `Conversation.tsx:257` callback bỏ action; gateway có pins/datasets nhưng chưa thấy mini-app action route | Client transport + core dispatcher + auth/revision/idempotency | 4 |
| Shared live view | `widget_live_owners`, widget_state và pins có trong migrate.ts | Wire inline/expanded/pinned ownership và crash recovery | 4 |
| Data completeness | `packs/data-canvas/src/index.ts` có charts/table/note; opaque refs có sẵn | Local task derivation, calendar store/import, approved image | 3 |
| Verification | `apps/web/e2e/widget.spec.ts` có table test; fallback test chỉ kiểm tra conversation rỗng | Non-vacuous fallback, snapshot/action/visual/model integration evidence | 6 |
| SDK runtime | widget-sdk codec đã có; runtime status pending | Không gọi là custom app runtime đã hoàn thành; nhánh riêng | Sau M1 |

## 5. Tổng hợp gaps kiến trúc rộng hơn

Mini-app không thay thế wiring còn thiếu của nền tảng. Không rewrite các module đã có.

| Mảng | Bằng chứng / phân biệt | Ưu tiên và ranh giới |
|---|---|---|
| Task execution | `packages/core/src/conductor.ts:270` chọn usable[0]; `runDispatchedTask` ở cùng file; gateway có nhánh trả 202 | Kiểm chứng enqueue → execute → persisted events → UI trước claim generic agent CTA; ngoài CTA save-view M1 |
| Session persistence | `packages/pi-adapter/src/real.ts:239` inMemory; worker sessionFile undefined | Durable session/resume và ownership; không chặn local mini-app rendering |
| Memory/retrieval | Storage tables đã có; retrieval pipeline chưa tìm thấy trong inspection | Bổ sung ingest/index/retrieve/provenance, không gọi là thiếu toàn bộ storage |
| Supervisor isolation | execution-supervisor marker stub cụ thể cho container/VM adapters | Không tuyên bố supervisor hoàn toàn trống; security profile runtime verification riêng |
| Multi-node | node-link marker stub cho TLS/WebSocket transport | Discovery/routing/delivery/reconnect tests trước distributed ownership claims |
| Capability install | capability-host marker stub cho staged install pipeline | Quarantine/signature/locking/rollback trước third-party packs |
| MCP/custom mini-app | Contracts/bridge codec tồn tại nhưng renderer runtime chưa được chứng minh | Isolated-app + mcp-app là milestone sau, giữ nonce/origin/capability boundaries |
| Traceability | `docs/conformance-traceability.md`, `pnpm invariants` | Update theo bằng chứng, không thay pending thành done chỉ vì schema tồn tại |

Thứ tự nền tảng đề xuất: task vertical slice → durable session/memory → supervisor adapters → desktop/multi-node. Mini-app M1 chạy song song trên local runtime nhưng CTA không được hứa generic task dispatch trước vertical slice tương ứng.

### Mở rộng 2026-09-17: search session history với Jev

Theo yêu cầu user, plan được mở rộng thêm Phase 7-9 (P2): durable session persistence → FTS5 retrieval → Jev query routing/rerank. Phân vai giữ nguyên nguyên tắc: Jev chỉ làm routing intent (Choice live/history/both, Noul thời gian) và rerank khi rank gần nhau; khớp văn bản là FTS5/BM25; tìm runtime đang chạy là lookup trạng thái (leases/live owners), không qua search index. Fallback khi Jev uncertain = FTS thuần + parser thời gian deterministic, sau đó pi agent/model mặc định. Phase 9 có calibration gate: nếu FTS thuần đạt ≥90% acceptable trên corpus thật, gỡ Jev khỏi search path. Privacy chặt hơn mini-app vì search chạm toàn bộ history: chỉ gửi query đã redact, có chế độ local-only.

Probe 2026-09-17: FTS5 hoạt động trong `node:sqlite` (bm25, unicode61, trigram OK) — Phase 8 không cần native dep; persistent mode của pi SDK SessionManager chưa xác minh được (node_modules bị chặn đọc) và là verification bắt buộc đầu Phase 7.

## 6. Phân kỳ và acceptance

1. Contracts/snapshot model/data schema; additive migration có backup/restore test.
2. Jev server adapter với exact-model validation và fail-safe selection.
3. Local data + composite catalog + đủ leaf UI.
4. Snapshot/live, action transport, pin/expand, revision/ownership.
5. Turn-pipeline composition tích hợp main LLM/show_view và Jev.
6. Full tests, visual evidence, live provider integration, docs và release gates.

Milestone được nghiệm thu khi đủ sketch **và** filter/calendar/save hoạt động, history không đổi theo live, reload không gọi Jev, provider down vẫn đọc/điều khiển view đã lưu, security tests pass. Xem phase files cho test matrix và paths.

## 7. Giới hạn và câu hỏi còn mở

- Đã chốt (validation 2026-09-17): pin exact `jev-1.13.0`, chặn nếu API không nhận; CTA lưu = pin cùng instance; fallback = pi agent/model mặc định; acceptance visual = user import khi nghiệm thu. Exact model id vẫn phải live-verify khi implement; smoke hiện tại chỉ dùng alias.
- Confidence/deadline/size thresholds là defaults đề xuất, cần calibration với corpus Việt/Anh; không SLA đã đo.
- Chưa có ảnh/dataset người dùng chỉ định cho acceptance cuối; dùng local records thật được tạo/import, báo empty nếu thiếu. Không chặn xây data plumbing nhưng chặn claim đủ visual evidence với dữ liệu thật.
- Google OAuth, custom iframe/MCP app runtime và full task execution cần kế hoạch/acceptance riêng; không nằm trong ước lượng M1.

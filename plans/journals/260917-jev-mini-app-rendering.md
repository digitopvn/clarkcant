---
title: "Jev mini-app rendering: 11 phase, 4 objection của audit, và những con số buộc hạ kỳ vọng"
date: 2026-09-17
summary: "Nhánh feat/jev-mini-app-rendering: 38 commit, gate 825 passed / 7 skipped, 7 lỗi thật, mặc định giữ rank và tắt semantic theo số đo live; pre-landing review tìm thêm 1 blocker về budget và 5 lỗi privacy/toàn vẹn dữ liệu"
---

# Jev mini-app rendering: 11 phase, 4 objection của audit, và những con số buộc hạ kỳ vọng

**Ngày**: 2026-09-17 17:20 (Europe/Berlin)
**Mức độ**: High
**Component**: nhánh `feat/jev-mini-app-rendering` (PR #12) — composed surface, durable session history, retrieval, Jev selector/decider, project finder
**Trạng thái**: Resolved — gate xanh trên HEAD, còn 4 hạng mục defer nêu ở cuối

## What Happened

Nhánh có **38 commit** trên `origin/main`, HEAD `1ff7cc2`; diff **120 file, +23 659 / −222** (`git diff --stat origin/main...HEAD`). Plan `plans/260917-0528-jev-mini-app-rendering/` có 11 phase, tất cả `status: done`, và **0 ô `[ ]` còn trống** trên cả 12 file plan: 46 ô `[x]` trong 11 phase file + 4 ô `[x]` trong `plan.md`. Phần code lớn nhất: `packages/core/src/widget-service.ts` (+843), `apps/runtime/src/compose-mini-app.ts` (776 mới), `mini-app-data.ts` (791), `project-finder.ts` (781), `session-search.ts` (527), `jev-selector.ts` (876), `jev-decider.ts` (446), `packages/storage/src/repositories.ts` (+1 318), `migrate.ts` (+248).

Gate chạy lại trong phiên viết journal này, trên HEAD `1ff7cc2`, node v22.23.2 / pnpm 12.4.2:

| Lệnh | Kết quả đo được |
|---|---|
| `pnpm verify` | 7/7 invariant, `tsc` (2 project) + `eslint .` sạch, **60 file test — 825 passed / 7 skipped** |
| `pnpm build` (report 1444) | pass, `vite build` 151 module, 351 ms |
| `pnpm test:e2e` (report 1444) | **25 passed** (23 test cũ + 2 journey picker), chromium headless linux x64 — **lần đầu e2e chạy trên linux**; không chạy lại trong phiên này |

Bằng chứng live với model thật `jev-1.13.0` (`CLARKCANT_JEV_LIVE=1`, key lấy từ environment của operator, không vào repo): `jev-live.spec.ts` 3 passed — chọn `overview@1` với confidence 1.000, Noul trả 0.980 (không bịa trường `confidence`), model id khác bị provider từ chối HTTP 400.

## The Brutal Truth

Audit đúng cả bốn objection, và hai trong bốn là **cùng một lỗi**: một seam được khai báo, được test, và **không nơi nào cấp**. `decideRuntimeTarget` chỉ được gọi từ test/calibration, `createFindProjectTool` chỉ được test của chính nó gọi, còn `main.ts` đăng ký hai tool khác. Nghĩa là **825 test xanh không nói được gì** về việc đường đó có tồn tại trong production hay không — và chúng tôi đã tick criterion cho một file dialog native chưa từng được viết. Cái đau nhất không phải lỗi, mà là cảm giác an toàn giả do con số test tạo ra.

## Technical Details

Bảy lỗi thật, không phải giả thuyết:

1. **Redaction ăn mất path người dùng vừa gõ.** `resolveProject` redact intent trước khi đọc path; `dùng /var/folders/.../home/gone` → `dùng /[redacted]-x[redacted]`, nên path hợp lệ không bao giờ resolve và user bị hỏi lại đúng thứ họ vừa trả lời. Sửa: đọc path từ **câu gốc, dùng cục bộ**; mọi thứ đi ra ngoài vẫn dùng bản đã redact.
2. **`relPath` tính từ home → rò cấu trúc máy.** Repo ở `/Volumes/...`, home `/Users/duynguyen` ⇒ `../../Volumes/GOON/...` đi vào cả state gửi selector lẫn câu hỏi hiển thị. Sửa: tính từ approved root chứa nó.
3. **Recent-use tự mở thư mục.** Fallback gắn nhãn `how: "search"`, nên với 1 candidate node mở luôn dự án vừa dùng cho một câu hỏi về dự án không tồn tại — đúng cái "invent a directory" mà plan cấm. Sửa: nhãn `how: "recent"` và candidate chỉ đến từ recent-use thì **được hỏi**, không tự mở.
4. **Redactor thiếu pattern path home** (`packages/contracts/src/redaction.ts:25`, `:31`), bắt được nhờ một test kiểm state gửi ra ngoài.
5. **Vùng ảnh không có đường tới người dùng**: không template nào có slot `image`, `publishMiniAppData` trả `imageRefs: []`; và `img-src 'self' data:` chặn blob URL dù node trả **đúng từng byte** (74 byte, sha khớp, `content-type: image/png`). Đã nối end-to-end và thêm `blob:` vào CSP (`packages/widget-host/src/index.ts`). Kèm lỗi tài nguyên: transcript và pinned view mỗi bên tự `revokeObjectURL`, gom về `use-image-urls.ts`.
6. **Message hết hạn nói sai deadline**: báo `config.timeoutMs` 4000 ms trong khi thực tế chặn ở 2000 ms.
7. **Phép đo hybrid sai vì harness.** Chạy bằng `tsx` khiến `createRequire(import.meta.url)("sqlite-vec")` không resolve ⇒ lần đo "hybrid" đầu tiên thực chất là FTS thuần (`0 embedded of 0`). Harness được chuyển vào `apps/runtime/test/` mới đúng.

Ghi nhận thêm: report `verification-260917-1630` ghi Phase 9 BLOCKED vì "thiếu `TYPESAFE_API_KEY`". **Sai** — key nằm trong workspace và gate chạy được ngay từ đầu; đó là lỗi của người thực thi, không phải của môi trường.

## Quyết định, và con số buộc chúng

| Quyết định | Số đo dẫn tới |
|---|---|
| `CLARKCANT_SEARCH_DECIDER` giữ **`rank`** | search: `rank` 31/34 (91,2%) **=** `jev` 31/34; baseline FTS lexical 30/31 (96,8%), semantic-only 2/8 (25%) — selector không sửa được vấn đề thiếu từ vựng, và tốn 1 call/truy vấn |
| `CLARKCANT_SEARCH_SEMANTIC` mặc định **tắt**; ceiling **0.1** | sweep: FTS 31/34; hybrid 0.1 → 31/34; 0.15 → 30/34; 0.2 → 26/34 kèm **4/5** câu "không có đáp án" trả về hàng xóm; 0.25+ → 25/34 và **5/5**. KNN luôn trả k hàng xóm, nên nới ceiling là tự tạo câu trả lời sai |
| Routing chưa bật mặc định | `jev` 8/16 (50,0%) nhưng **3/3** câu ngoài phạm vi abstain đúng (`none`); giữ confidence/margin 0.85/0.20 vì chưa có ca nào rơi vùng 0,5–0,85 |
| Deadline quyết định **2000 ms**, tổng search **2500 ms** (`SEARCH_DECISION_TIMEOUT_MS`, `SEARCH_TOTAL_BUDGET_MS`) | plan Phase 9 đòi ≤2 s / ≤2,5 s, code cũ dùng chung budget composition 4 s; telemetry 9 call: p50 **322 ms**, p95 **824 ms** ⇒ 2 call vẫn nằm trong budget với biên rộng |
| `runtime-candidates`: thêm kind `"capability"`, nhưng `find_runtime` **không** quảng bá nó; thêm field `describe` | một filter không bao giờ khớp là một filter nói dối; thiếu `describe` thì mọi candidate route A có cùng một dòng mô tả và selector chọn như tung đồng xu |
| Làm file dialog native thay vì hạ criterion | hạ criterion là chấp nhận một phần yêu cầu của plan; nhưng bản thân `dialog.showOpenDialog` không chạy được headless |
| `chooseExecutionNode` ở lại core (hook, không phải import) | chuyển sang runtime sẽ buộc conductor gọi ngược vào runtime |

## What We Tried

Ba lỗi project-finder (1–3 ở trên) **không lộ ra khi đọc code**, chỉ lộ khi viết browser journey. Đó là lý do journey đó tồn tại: đọc `resolveProject` thì "redact trước khi đọc path" trông hợp lý; chạy nó mới thấy user bị hỏi lại câu vừa trả lời.

## Root Cause Analysis

Test được viết **tại module định nghĩa seam**, không qua entry point thật. Sau khi sửa, test nghiệm thu route A chạy qua `bootNodeServices` + `handleUserMessage` thật (`apps/runtime/test/conductor-routing.spec.ts`, 7 test) — ba nhánh cuối (id lạ, provider chậm, registry đổi giữa call) chỉ có thể fail nếu `chooseExecutionNode` thực sự được cấp. Cùng cách, `find_project` được sửa bằng `createNodeTools({search, projects})` (`apps/runtime/src/node-tools.ts`) vì chính list viết inline trong closure của `main.ts` là chỗ khiến lỗi vô hình; giờ có test assert đúng ba tên tool. Hai nguyên nhân còn lại: tick criterion theo lời hứa trong phase file thay vì theo con trỏ bằng chứng, và tuyên bố BLOCKED mà không kiểm tra environment.

## Lessons Learned

- Seam chỉ được gọi từ test **phải** được assert qua entry point production, nếu không coverage xanh trên code chết.
- Không tick acceptance criterion khi chưa có lệnh chạy lại được; và khi ghi BLOCKED phải kèm đúng command + output quan sát được.
- Harness đo thuộc về test runner (vitest), không phải script `tsx` rời: native dep optional sẽ im lặng no-op và bạn sẽ đo nhầm thứ khác mà vẫn thấy số.
- Bất kỳ plan step nào nói "expose X cho model" phải assert **danh sách** tool, không assert factory.
- Với KNN, "không có kết quả" là một câu trả lời hợp lệ mà vector search không có khả năng đưa ra: phải có ceiling hoặc rerank, không thể chỉ trộn RRF rồi tin.

## Pre-landing review trước khi merge (`/ak:ship main --merge`)

Review độc lập trên `origin/main...HEAD` trả verdict **BLOCK** với một blocker, và blocker đó thuộc **đúng lớp lỗi mà audit đã chỉ ra**: một seam được khai báo, được test, và không được cấp đúng cách.

- **Blocker:** `services.ts:358`/`:409` dựng `searchDecisionBudget()` **một lần lúc boot** cho search decider và project finder, mà budget mang `deadlineAt` tuyệt đối. Từ ~2 giây uptime, `refusalReason` từ chối mọi call, nên hai đường đó **không bao giờ gọi provider** và lý do trả về trông y hệt sự cố provider. Ngay cạnh đó `:288` (route A) và `:437` (composition) đã dựng theo từng lần gọi — đây là chỗ sót, không phải quyết định thiết kế. Sửa: `DecideDeps.budget` thành factory, **một budget cho mỗi quyết định** (không phải mỗi call, vì Choice rồi Noul mà mỗi call một deadline riêng thì một quyết định tiêu 2×2 s, phá trần 2,5 s của plan). Comment trong `buildDecider` vốn đã mô tả đúng ý định này trong khi code truyền một giá trị.
- **Vì sao 825 test không bắt được:** mọi test tự inject budget mới của nó. Test hồi quy mới `selector-budget-wiring.spec.ts` boot node thật, chờ quá deadline rồi mới hỏi — nó **đỏ trên code cũ** (đã kiểm bằng cách tạm hoàn nguyên) và xanh sau khi sửa.
- **Năm lỗi đã sửa cùng:** `search_history` trả snippet chưa redact cho provider; payload project finder không qua redaction (khi sửa còn tìm thêm một chỗ rò mà review chưa nêu — `state.candidates[].name` cũng nguyên văn, test mới bắt được ở lần chạy đầu); comment nói dối về parity `sanitizeIntent`; `void vectors.ensure()` là floating promise có thể giết tiến trình vì unhandled rejection; guard prune bỏ qua `stoppedEarly` nên một scan bị abort xoá sạch project index (test đỏ trên code cũ với **5 row bị xoá**).
- **Defer có lý do:** 11 finding còn lại (principal check ở route snapshot, transcript chưa redact at rest và cursor lệch dòng, timezone tuỳ ý trong `period.change`, gap test vô hiệu khi bật fusion, N+1 ở route timeline, và các mục nhỏ khác) — chi tiết và lý do trong `plans/reports/review-260917-1731-pre-landing-ship-review.md`.

## Still Blocked / Deferred

- **e2e chỉ chạy trên máy dev** (linux headless ở phiên này), CI không chạy web e2e — quyết định đã ghi: không thêm vào CI (thay đổi hạ tầng + rủi ro flake), tách thành việc riêng.
- **`dialog.showOpenDialog` thật chưa được chạy**: cái được chứng minh là client dùng dialog khi bridge tồn tại, channel được allowlist, bridge expose đúng method; journey browser dùng bridge giả. Cần `pnpm --filter @clarkcant/app-desktop run smoke` trên máy có display.
- **Semantic tắt, corpus nhỏ**: 34 query search + 16 routing + 15 history row; kết luận đúng cho corpus này, không phải "chất lượng retrieval" nói chung. Chưa có bước rerank (cross-encoder) — chính bước có khả năng sửa đúng thất bại đã đo.
- Ingest embedding chưa có tiến trình nền (`limit` 128 mỗi `ensure()`); `searchEmbedding` lấy `k = limit * 4` rồi lọc principal trong SQL (chưa đo với nhiều principal); model ONNX nạp trong tiến trình node, chưa đo ảnh hưởng boot; **kích thước file model không ghi số vì không quan sát được cache**.
- Telemetry 9 call (3 110 input / 231 output token) đến từ `.pi/tmp/jev-telemetry.ts` — **script không nằm trong repo**, nên không tái lập được từ repo; đọc ở mức tin báo cáo, không phải SLA.
- Số PR #12 lấy từ report/handoff, chưa xác nhận bằng `gh` trong phiên này (**unverified**).

## Next Steps

1. Trước khi đổi bất kỳ default nào (`search.decider`, semantic, routing): **mở rộng corpus trước** (≥50 tình huống routing), vì 34 query hiện tại chỉ chứng minh plumbing.
2. Xác nhận OS dialog thật bằng desktop smoke trên máy có display; nếu fail thì journey với bridge giả đang chứng minh một nửa sự thật.
3. Ai muốn CI bắt khác biệt platform thì mở issue riêng cho web e2e trên linux, không nhét vào `pnpm verify`.
4. Phiên sau đọc `plans/reports/verification-260917-1444-jev-rework-audit-objections.md` (bốn objection + quyết định cho ba câu hỏi treo) và `.../verification-260917-1915-plan-completion-pass.md` (ba lỗi thật + probe CI).
5. Môi trường: trên máy này **`pnpm` trần = 12.4.2 và đúng**; `corepack pnpm` resolve ra pnpm 11.25.0 và **fail** version check của repo — hướng dẫn "luôn dùng `corepack pnpm`" trong handoff cũ đúng với máy cũ, sai với máy này. Không bao giờ đặt `CLARKCANT_JEV_LIVE=1` mà không có key của operator, không ghi key vào file tracked, và không để đường dẫn `.env` của repo khác xuất hiện trong code/docs/plans.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.

# Pre-landing review trước khi ship lên `main` — 1 blocker, 16 finding khác

- **Loại:** review
- **Ngày:** 2026-09-17
- **Branch:** `feat/jev-mini-app-rendering` (PR #12), base `origin/main`
- **Reviewer:** subagent `code-reviewer` (fresh context), diff `origin/main...HEAD` (120 file, +23 659/−222)
- **Bối cảnh:** bước Step 5 của `/ak:ship main --merge`. Verdict ban đầu: **BLOCK**.

## Kết luận

Review tìm ra **một lỗi blocking** và 16 finding khác. Blocker đã sửa kèm test hồi quy; 4 finding về ranh giới privacy/redaction và một về toàn vẹn dữ liệu cũng đã sửa vì chúng phủ định chính acceptance criterion của plan ("no secrets/raw private rows sent/logged"); phần còn lại được ghi nhận và defer có lý do.

Điều đáng nói: blocker thuộc **đúng lớp lỗi mà audit trước đó đã chỉ ra** — một seam được khai báo, được test, và không được cấp đúng cách. Lần này là budget, không phải tool.

## Blocker đã sửa

**`services.ts:358` và `:409` — budget của search decider và project finder được dựng một lần lúc boot, nên sau ~2 giây uptime mọi quyết định trả `unavailable`.**

`searchDecisionBudget()` trả một giá trị có `deadlineAt` **tuyệt đối** (`Date.now() + timeoutMs`). Hai call site này đánh giá nó bên trong `bootNodeServices`, còn `refusalReason` (`jev-selector.ts:394`) từ chối mọi call khi `remainingBudget <= 0`. Hệ quả: từ giây thứ hai của tiến trình, search decider (khi `CLARKCANT_SEARCH_DECIDER=jev`) và tie-break của project finder **không bao giờ gọi provider**, và lý do trả về ("the selector budget for this turn was exhausted before the call") trông y hệt một sự cố provider. Không test nào bắt được vì mọi test tự inject budget mới của nó.

Ngay cạnh đó, `services.ts:288` (route A) và `:437` (composition) đã dựng budget theo từng lần gọi, nên đây là một chỗ sót chứ không phải một quyết định thiết kế.

**Sửa:** `DecideDeps.budget` từ `JevBudget` thành `() => JevBudget`, dựng **một budget cho mỗi quyết định** và dùng chung cho mọi call trong quyết định đó. Không phải một budget cho mỗi *call*: một quyết định search có thể hỏi Choice rồi hỏi Noul, và cấp mỗi call một deadline riêng sẽ cho phép một quyết định tiêu 2×2 s, phá trần 2,5 s cho cả đường search của plan. Comment trong `buildDecider` ("`budget` is a function rather than a value so each request gets its own deadline") đã mô tả đúng ý định này từ trước trong khi code truyền một giá trị — nay comment và code khớp nhau.

**Bằng chứng:**

- `apps/runtime/test/selector-budget-wiring.spec.ts` (mới, 2 test) boot node thật qua `bootNodeServices`, chờ 600 ms (deadline đặt 250 ms), rồi hỏi. Test **fail trên code cũ** (đã kiểm bằng cách tạm hoàn nguyên `services.ts`: cả 2 test đỏ) và pass sau khi sửa; test search còn assert provider **đã được gọi thật** và outcome là `mode: "jev"` chứ không phải `rank`.
- Cập nhật call site theo factory: `jev-decider.spec.ts`, `jev-calibration-live.spec.ts`, `project-finder.spec.ts`, `session-search.spec.ts`.

## Đã sửa: ranh giới privacy

Bốn finding này phủ định acceptance criterion của plan ("no secrets/raw private rows sent/logged"), nên chúng được xử lý chứ không defer.

**(#4) `search_history` trả snippet chưa redact cho provider.** Tool đưa thẳng `hit.snippet` vào kết quả tool — thứ provider đọc — trong khi đường search-decision redact đúng văn bản đó trước khi nó rời node. Đã bọc `redactSecrets`. Test: `session-search.spec.ts` "redacts a credential-shaped string in history before the tool returns it" (assert `[redacted]` và không còn token).

**(#8) Payload của project finder không đi qua redaction.** `criteria` dựng từ tên thư mục, markers và `relPath` nguyên văn. **Khi sửa tôi tìm thêm một chỗ rò mà review chưa nêu:** `state.candidates[].name` cũng gửi tên thư mục nguyên văn, nên chỉ redact `criteria` là chưa đủ — test mới bắt được đúng điều này ở lần chạy đầu. Đã redact cả hai. `relPath` vẫn tương đối (pattern home-path của redactor đòi tiền tố tuyệt đối `/Users/`, `/home/`, `/private/var/`, nên `~/…` không bị ăn) — đúng như Phase 11 cho phép. Test: `jev-decider.spec.ts` "redacts a credential-shaped name and marker, and keeps the candidate" (assert secret biến mất, `[redacted]` xuất hiện, và **candidate không bị loại bỏ**: `agentkit`/`package.json` vẫn còn).

**(#9) Comment nói dối về parity sanitization.** Comment nói intent "sanitized by the same function the composition path uses" nhưng code chỉ `redactSecrets(...).slice(0, 500)`, thiếu `stripControlCharacters`, gộp whitespace và `stateLooksRedacted`. Đã dùng thẳng `sanitizeIntent(input.intent, 500)` để comment thành đúng.

**(#12) `void vectors.ensure()` là floating promise không có handler.** `vectorIndexStatus` được gọi ngoài try/catch bên trong `ensure()`, nên một database lỗi làm promise reject; Node kết thúc tiến trình khi gặp unhandled rejection — với một tính năng **optional** mà node có thể chạy thiếu. Đã thêm `.catch(() => undefined)` kèm giải thích (trạng thái vẫn được báo qua `vectors.status()`).

## Đã sửa: toàn vẹn dữ liệu

**(#2, một phần) Guard prune bỏ qua `stoppedEarly`.** Comment nói "a bounded or interrupted scan did not see every directory" nhưng điều kiện chỉ kiểm `scan.truncated`. Một scan bị abort **trước khi walk đầu tiên** báo `truncated: false` với `projects: []`, và prune theo danh sách rỗng **xoá sạch project index của node** — kể cả `aliases` và `last_used_at` mà một lần rescan không dựng lại được. Đã thêm `&& !scan.stoppedEarly`. Test: `project-finder.spec.ts` "does not prune the index when a scan was interrupted" — fail trên code cũ với **5 row bị xoá**, pass sau khi sửa.

## Defer, kèm lý do

Không finding nào dưới đây chặn ship, và sửa chúng là thay đổi thiết kế chứ không phải sửa lỗi:

| # | Finding | Vì sao defer |
|---|---|---|
| #2 phần còn lại | `indexDirectoryPath` index cả thư mục người dùng gõ **không có marker**, nhưng walker chỉ index thư mục có marker/media → lần refresh sau prune lại row đó, mất `last_used_at` của thư mục vừa dùng | Sửa đúng là prune theo **tập thư mục scan đã đi qua**, không theo tập đã phân loại — đổi ngữ nghĩa prune (row của thư mục đã bị xoá sẽ ở lại vĩnh viễn nếu không được visit). Cần test riêng cho ranh giới đó. Journey browser hiện tại vẫn xanh vì thư mục test có `README.md` (marker). |
| #3 | Route snapshot presentation là route widget duy nhất không kiểm principal (`gateway.ts:916-925`); `readSnapshotForDisplay` chọn theo id và trả `textAlternative` (dữ liệu thật) | Hôm nay chưa khai thác được: gateway xác thực bằng một node-owner token. Thành cross-principal read khi phục vụ principal thứ hai — sửa cùng lúc với việc đó. |
| #5 | `redactRegisteredSession` không có caller production, nên transcript không được redact at rest, trong khi một commit nói "durable, indexed and redacted" | Wiring nó là **thay đổi hành vi ghi file session** (rủi ro hỏng transcript) và cần quyết định thời điểm chạy. Ít nhất comment/claim phải sửa — nằm trong #6. |
| #6 | Redact transcript làm `ingestCursor` (offset ký tự) lệch dòng, gây index dòng cụt hoặc 500 | Cùng khu vực với #5; sửa kèm khi wire redaction (reset cursor về 0 trong cùng upsert). |
| #7 | `period.change` nhận timezone tuỳ ý (chỉ kiểm độ dài) và persist vào state; `"not/a zone"` làm `/live` của instance đó 500 vĩnh viễn | Không crash (có boundary ở `main.ts:265`), và cần một fallback có chủ đích về `composition.initialState.timezone`. |
| #10 | Với fusion bật, RRF cho các score cách nhau ~1,5 % nên `rankGapIsClear` (25 %) không bao giờ đạt → mọi search ≥2 kết quả tốn một call | Chỉ xảy ra khi bật **cả** `jev` **và** semantic; cả hai đang tắt mặc định theo số đo. Sửa là bỏ gap test khi `rankedBy === "rrf"`. |
| #11 | Vòng lặp snapshot mới là một query cho mỗi message trong tối đa 200 message, trên route nóng nhất | Tối ưu hiệu năng, không phải lỗi; cần batch reader + index `widget_snapshots(message_id)`. |
| #13 | `summariseSessions().ingested` so sánh cursor (chỉ số UTF-16) với `byteSize` (byte) → luôn false với transcript tiếng Việt | `summariseSessions` không có caller production. |
| #14 | `COUNT(*)` được chạy rồi bỏ (`void stale`) trong mỗi lần claim live owner | Lãng phí nhỏ; xoá query là việc một dòng nhưng không cấp thiết. |
| #15 | Parity bridge/allowlist chỉ được kiểm ở máy dev, không ở CI | CI đã cài chromium và chạy `pnpm verify`; thêm `electron --smoke-test` cần display. Đây là lỗ CI thật, nên có issue riêng. |
| #16 | Embedding model fetch từ revision không pin (`Xenova/multilingual-e5-small`), `modelDigest` băm id chứ không băm bytes | Semantic đang tắt mặc định; pin revision là việc của lần bật nó. |
| #17 | `pickDirectory` bị từ chối thì im lặng, không phản hồi cho user | UX nhỏ; sửa bằng cách đưa `chosen.refused` vào `sessionNotice`. |

Reviewer cũng xác nhận **không có finding** ở: injection (SQL/FTS/command — mọi truy vấn tham số hoá, `toMatchExpression` quote từng term), rò secret vào log/telemetry/error, authorization bypass trên các route mới, race/double-effect ở các write path mới, an toàn migration (10–15 additive, mỗi cái một transaction), và dữ liệu gửi ra ngoài.

## Ba câu hỏi reviewer được hỏi

1. **`chooseExecutionNode`** có thể dispatch tới capability không usable, hoặc map id bị nhầm không? Không, và điều kiện thứ hai không dựng được: `capabilityRefSchema` cấm `@` thứ hai nên `${ref}@${node}` không nhập nhằng. Một bất đối xứng **có từ trước**, không phải hồi quy: nhánh fallback (`conductor.ts:246`) dispatch theo snapshot trước khi quyết định, nên chỉ target **được chọn** mới được verify lại.
2. **`desktop:pickDirectory`** có còn enforce allowlist và top-frame? Có — handler đăng ký qua `handle()` nên `reviewIpcCall` chạy trước dialog, và renderer chỉ chạm được `title` (cắt 120 ký tự); không có `defaultPath`/filter/`properties` nào đến từ renderer.
3. **Chữ của user hoặc path tuyệt đối có vào payload Jev không?** Chữ user vào dưới dạng intent (đã redact mọi đường); path tuyệt đối thì không. Hai lỗ thật là #8 và #9, đã sửa.

## Gate sau khi sửa

Chạy trên chính commit của vòng này, sau toàn bộ sửa đổi ở trên:

| Lệnh | Kết quả |
|---|---|
| `pnpm verify` | 7/7 invariant, typecheck + lint sạch, 61 file test — **830 passed / 7 skipped** (825 trước đó + 5 test mới của vòng review) |
| `pnpm build` | pass (`vite build`, 276 ms) |
| `pnpm test:e2e` | **25 passed** (chromium headless linux, không hồi quy) |
| `pnpm exec vitest run` (các file bị ảnh hưởng) | 93 passed |

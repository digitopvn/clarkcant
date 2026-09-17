# Xác minh vòng hoàn thiện kế hoạch — deadline quyết định, đường nhập path, probe CI

- **Loại:** verification
- **Ngày:** 2026-09-17 (Asia/Saigon)
- **Branch:** `feat/jev-mini-app-rendering`
- **Kế hoạch:** `plans/260917-0528-jev-mini-app-rendering/plan.md`
- **Bối cảnh:** 11 phase đã Done; vòng này đóng các khoảng trống còn lại giữa **điều plan yêu cầu** và **điều repo chứng minh được**.

## Kết luận

Đối chiếu từng acceptance criterion của plan với repo cho ra bốn khoảng trống thật, và cả bốn đã đóng bằng code + test:

1. **Phase 9 đòi deadline quyết định ≤2 s (tổng search ≤2.5 s); code dùng chung budget 4 s của composition.** Đã tách: `SEARCH_DECISION_TIMEOUT_MS = 2000`, `SEARCH_TOTAL_BUDGET_MS = 2500`, `searchDecisionBudget()` và `buildDecider()` mặc định theo deadline quyết định; `CLARKCANT_JEV_SEARCH_TIMEOUT_MS` để override. Kèm một sửa nhỏ nhưng quan trọng: message khi hết hạn nay nêu **deadline thực sự bị chặn**, không phải `config.timeoutMs` (trước đó log nói 4000 ms trong khi thực tế chặn ở 2000 ms).
2. **Config `search.decider`**: plan viết `jev | none`; code chỉ hiểu `jev`, mọi giá trị khác thành `rank` mà không nói gì. Nay `none` được ghi nhận là tên của off-switch, và mọi giá trị lạ đều là `rank` — một lỗi gõ không thể bật provider trả phí.
3. **Phase 11: đường "0 candidate → hỏi user chỉ thư mục" không tới được người dùng.** Server hỏi nhưng không có gì trả lời được: `resolveProject` coi path người dùng gõ như một *query*, nên nó hỏi lại mãi; và web không có control nào gọi `POST /start-session`. Đã làm cả hai phía, và tìm ra ba lỗi thật (dưới đây).
4. **Phase 10: probe Linux x64 chưa chạy** (máy dev là darwin arm64). Đã thêm `tools/probe-vector-extension.mjs` + step CI trên `ubuntu-latest`.

## Ba lỗi thật tìm được trong vòng này

**(a) Redaction ăn mất path người dùng vừa gõ.** `resolveProject` redact intent *trước* khi đọc path, và redactor thay mọi đường dẫn tuyệt đối bằng placeholder: `dùng /var/folders/.../home/gone` → `dùng /[redacted]-x[redacted]`. Hệ quả: một path hợp lệ không bao giờ resolve được, và người dùng bị hỏi lại đúng thứ họ vừa trả lời. Sửa: đọc path từ **câu gốc của người dùng** (dùng cục bộ), còn mọi thứ *đi ra ngoài* (search text, selector state) vẫn dùng bản đã redact — đúng yêu cầu privacy của Phase 11.

**(b) `relPath` tính từ home, nên workspace ngoài home rò cấu trúc máy.** Repo nằm ở `/Volumes/...` còn home là `/Users/duynguyen`, nên relPath thành `../../Volumes/GOON/...`. Điều này vi phạm chính tiêu chí Phase 11 ("relPath-from-root, không path tuyệt đối home dir"), và tệ hơn là nó đi vào cả state gửi selector lẫn câu hỏi hiển thị cho user. Sửa: relPath tính từ **approved root chứa nó**.

**(c) Recent-use tự mở thư mục, kể cả khi câu hỏi không khớp gì.** Fallback "dùng gần đây" gắn nhãn `how: "search"`, nên một candidate đến từ thói quen trông y hệt một candidate khớp tên — và với 1 candidate thì node mở luôn. Nghĩa là hỏi một dự án không tồn tại sẽ mở dự án vừa dùng, im lặng: đúng cái "invent a directory" mà plan cấm. Sửa: nhãn `how: "recent"` (type đã có sẵn, chỉ là không được dùng) và candidate chỉ đến từ recent-use thì **được hỏi**, không tự mở.

Cả ba đều lộ ra từ việc viết browser journey — không phải từ đọc code. Đó cũng là lý do journey đó tồn tại.

## Đã thêm

| Hạng mục | Nội dung |
|---|---|
| `apps/runtime/src/jev-decider.ts` | Deadline quyết định + hằng số của plan, `decisionTimeoutMsFromEnv`, `searchDecisionBudget`, `buildDecider` dùng deadline quyết định |
| `apps/runtime/src/jev-selector.ts` | `JevBudget.timeoutMs` để message nêu đúng deadline bị chặn |
| `apps/runtime/src/services.ts` | Search decider và project-finder decider dùng budget quyết định |
| `apps/runtime/src/project-finder.ts` | `pathFromIntent`, `indexDirectoryPath` (index một thư mục được nêu tên, vẫn phải trong approved root), path branch đọc từ câu gốc, `how: "recent"`, recent-only thì hỏi, relPath theo root |
| `apps/runtime/src/project-session.ts`, `node.ts` | Seam `projectSessions` (thay cả starter), cho node không có worker |
| `apps/runtime/src/main.ts` | `CC_SESSION_FIXTURE=1`: starter không spawn worker, có dòng stderr nói rõ là fixture |
| `packages/conversation-client/src/api.ts` | `startSession` + `StartSessionResponse` |
| `packages/conversation-client/src/Conversation.tsx`, `styles.ts` | Affordance "Mở phiên trong dự án": toggle, ô nhập, submit, options khi `clarify`, và ô nhập chuyển thành "Đường dẫn thư mục" khi node hỏi `needs-path` |
| `apps/web/e2e/project-session.spec.ts` | 2 journey: nhập path → mở phiên; tên không khớp → node **hỏi** thay vì mở nhầm, chọn option → mở phiên |
| `tools/probe-vector-extension.mjs`, `.github/workflows/ci.yml` | Probe extension trên platform CI, ba trạng thái: không cài (exit 0, có lý do), cài+dùng được (exit 0 + version), cài mà hỏng (exit 1) |
| `packages/storage/test/storage.spec.ts` | Test bổ sung cho tiêu chí Phase 7: message giữ `conversation_id`/`role`/`sequence`/`created_at`/`delivery` qua write→read, và conversation khác không thấy |
| `apps/runtime/test/session-search.spec.ts` | Test bổ sung cho tiêu chí Phase 9 ở mức **cả đường search**: selector chậm hơn deadline → `mode: "rank"`, không có `chosen`, lý do nêu deadline bị chặn, và tổng thời gian nằm trong `SEARCH_TOTAL_BUDGET_MS` |

### Evidence trong browser

Ảnh do chính suite sinh ra (gitignored, regenerated mỗi lần chạy) nằm ở `plans/reports/evidence/`. Vòng này thêm:

| File | Journey | Assertion đi kèm |
|---|---|---|
| `session-01-started-from-typed-path.png` | `project-session.spec.ts` "a project session is started from a path the user types" | Node hỏi `needs-path` → nhập path → trạng thái `started` và câu trả lời của node nằm trong transcript |

Bảy ảnh `miniapp-0*.png` của Phase 6 vẫn được sinh lại bởi `mini-app.spec.ts` (desktop/mobile, light/dark, live-vs-snapshot, ownership refused, keyboard).

## Gate

| Lệnh | Kết quả |
|---|---|
| `corepack pnpm verify` | 7/7 invariant, 56 file, **812 passed / 7 skipped** (tăng từ 798 nhờ các test mới của vòng này) |
| `corepack pnpm test:e2e` | **23 passed** (2 journey mới project-session; không hồi quy ở 21 test cũ) |
| `node tools/probe-vector-extension.mjs` (darwin arm64) | `v0.1.9`, create/insert/KNN ok, exit 0 |
| Probe trên Linux x64 (CI, `ubuntu-latest`) | `v0.1.9` nạp từ `sqlite-vec-linux-x64@0.1.9/vec0.so`; create, insert và KNN đều chạy — xem mục CI bên dưới |

## Tiêu chí của plan

Toàn bộ `- [ ]` trong `plans/260917-0528-jev-mini-app-rendering/*.md` đã được đối chiếu và tick kèm con trỏ bằng chứng (Phase 7/8/9/11), Phase 10 ghi rõ probe nào chạy ở đâu.

**Một hạng mục được ghi là KHÔNG LÀM, không tick:** file dialog native trên desktop. Web dùng ô nhập đường dẫn và Electron host chính UI đó, nên đường nhập path là đường duy nhất hiện có; một dialog native là việc riêng của shell desktop.

## CI

Dòng log của step "Probe the optional vector extension" trên `ubuntu-latest` (linux x64), node 22.19:

```text
vector extension: v0.1.9 loaded from /home/runner/work/clarkcant/clarkcant/node_modules/.pnpm/sqlite-vec-linux-x64@0.1.9/node_modules/sqlite-vec-linux-x64/vec0.so; create, insert and KNN all work on linux/x64
```

Đây là câu trả lời cho pre-gate của Phase 10: extension cài và dùng được trên linux x64, không chỉ trên máy dev darwin arm64. Lần chạy CI đầu tiên của nhánh bị **cancel bởi chính concurrency group của workflow** (một push sau đó thay thế nó), không phải fail; step probe đã chạy xong và in dòng trên trước khi bị huỷ.

## Chưa đo / còn lại

- Browser suite (`pnpm test:e2e`) chỉ chạy trên máy dev darwin arm64; CI chạy unit/invariant/typecheck/lint và các driver test, không chạy e2e web.
- `pnpm test:e2e` chạy trên máy dev (darwin arm64) với node cô lập; Linux e2e không chạy ở đây.
- Corpus calibration vẫn nhỏ (34 search + 16 routing): đủ để chốt default, không đủ để nói về chất lượng Jev nói chung.

## Câu hỏi chưa giải quyết

- Có nên chạy browser suite trên Linux trong CI (chromium headless) để bắt khác biệt platform, hay giữ e2e ở máy dev và chỉ probe native deps trên CI?
- Có nên cho `disambiguate()` nhận một `question` tuỳ biến để câu hỏi "thư mục dùng gần đây nhất" và câu hỏi "nhiều thư mục khớp" dùng chung một đường, thay vì hai nhánh như hiện tại?

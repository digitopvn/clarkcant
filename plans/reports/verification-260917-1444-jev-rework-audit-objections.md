# Xác minh vòng rework sau audit — bốn objection

- **Loại:** verification
- **Ngày:** 2026-09-17
- **Branch:** `feat/jev-mini-app-rendering` (PR #12)
- **Kế hoạch:** `plans/260917-0528-jev-mini-app-rendering/plan.md`
- **Bối cảnh:** completion request trước bị auditor từ chối với bốn objection. Vòng này đóng cả bốn, thay vì giải thích tại sao chúng không quan trọng.

## Kết luận

Cả bốn objection đều đúng khi nêu ra, và cả bốn nay đã đóng bằng code + test chạy được. Hai trong số đó là **seam được khai báo nhưng không nơi nào cấp** — cùng một loại lỗi, và cùng loại lỗi mà objection #1 phát hiện: một hàm tồn tại, được test trực tiếp, và không bao giờ được gọi trong production.

| # | Objection | Trạng thái |
|---|---|---|
| 1 | `find_project` không được đăng ký cho Main Pi | Đóng ở phiên trước (`c63f901`), gate bằng `pnpm verify` đầy đủ trong vòng này |
| 2 | Đường A (điều phối runtime) chưa được tích hợp | **Đóng trong vòng này** |
| 3 | File dialog native trên desktop chưa làm, criterion lại đang tick | **Đóng trong vòng này** — đã làm thật, không hạ criterion |
| 4 | Plan tự ghi là chưa triển khai | **Đóng trong vòng này** |

## #1 — `find_project` được đăng ký cho Main Pi

`createFindProjectTool` chỉ được test của chính nó gọi; `main.ts` chỉ đăng ký `search_history` và `find_runtime`. Đã sửa ở phiên trước bằng `apps/runtime/src/node-tools.ts` (`createNodeTools({search, projects})`) — lý do phải tách thành hàm là chính list viết inline trong closure khiến lỗi này vô hình với test. `apps/runtime/test/node-tools.spec.ts` assert đúng ba tên tool và assert `find_project` trả báo cáo chứ không mở gì.

Vòng này chạy `pnpm verify` đầy đủ để objection này có gate thật, không chỉ có test file tồn tại.

## #2 — Đường A được tích hợp thật

**Khoảng trống:** `decideRuntimeTarget` chỉ được gọi từ test/calibration. `packages/core/src/conductor.ts` có seam `chooseExecutionNode` và trả `usable[0]` khi không có decider, nhưng `apps/runtime/src/services.ts` không cấp key đó — nên trong production Jev không bao giờ được hỏi cho route A.

**Cách sửa trong `services.ts`:** cấp `chooseExecutionNode`, dựng candidate từ chính danh sách capability mà conductor đã lọc (`id = "<capabilityRef>@<executionNodeId>"`, `capabilities: [ref]`, `live: true`), gọi `decideRuntimeTarget` với:

- **budget quyết định** (2 s, `searchDecisionBudget`) — chọn capability nào làm việc là một *quyết định*, không phải một composition;
- **`verify` đọc lại registry**: `listCapabilitySummaries(..., {usableOnly:true})` phải vẫn chứa đúng cặp `(capabilityRef, executionNodeId)`. Đây là điều kiện "host verify grant trước dispatch" của Phase 9, và nó khiến một capability bị unload giữa lúc selector đang suy nghĩ trở thành fallback chứ không phải một dispatch.
- Trả `{capabilityRef, executionNodeId}` **chỉ khi** `status === "selected"`; `none`, `fallback`, hoặc id không còn trong map ⇒ trả `undefined` để conductor giữ thứ tự xác định. Đúng luật của plan: Jev vắng/uncertain → rank thuần, không giả vờ Jev đã chọn.
- Map `id → pair` giữ trong closure thay vì parse id, nên một `ref` tình cờ chứa `@` không thể bị đọc thành hai trường.

**Hai thay đổi type đi kèm, có lý do:**

- `RuntimeCandidateKind` thêm `"capability"`. Route A chọn một *capability*, không phải một thứ đang chạy, nên dùng lại `"node"` sẽ là nhãn sai. `find_runtime` **không** quảng bá kind này: nó đọc trạng thái đang chạy, còn candidate route A do conductor dựng, nên một filter không bao giờ khớp sẽ là một filter nói dối.
- `RuntimeCandidate.describe` (optional): `describeRuntimeCandidate` cũ chỉ trả `"<kind>, đang bận|đang rảnh"`, nên **mọi** candidate route A có cùng một dòng mô tả và selector sẽ chọn như tung đồng xu. Field này chở `summary` + `effectCategory` từ registry — metadata của registry, không phải chữ của user; `label` (chứa goal/path của user) vẫn không được gửi đi, đúng như comment gốc của file.

**Test nghiệm thu — `apps/runtime/test/conductor-routing.spec.ts` (7 test), chạy qua `bootNodeServices` + `handleUserMessage` thật:**

| Test | Chứng minh |
|---|---|
| "asks the selector when there is a real choice, and dispatches to what it chose" | 1 call, dispatch đi đúng node mà selector chọn (khác node của `usable[0]`) |
| "describes candidates with registry metadata only, never user text" | body gửi đi không chứa path trong câu user, không chứa label |
| "keeps the deterministic order when the selector is unavailable" | 429 → `usable[0]` |
| "does not call the provider at all when it is switched off" | 0 call khi `enabled: false` |
| "keeps the deterministic order when the selector is slower than the deadline" | transport tôn trọng `AbortSignal`, quá deadline → `usable[0]` |
| "does not dispatch to something the selector named but was never offered" | id lạ → `usable[0]` |
| "does not dispatch to a candidate that stopped being usable while the selector was thinking" | registry đổi giữa call → `verify` fail → `usable[0]` |

Ba test cuối là ba nhánh mà một seam rỗng sẽ pass một cách vô nghĩa: chúng chỉ có thể fail nếu `chooseExecutionNode` thực sự được cấp.

## #3 — File dialog native trên desktop

**Khoảng trống:** Phase 11 viết "host file dialog trên desktop, nhập path trên web". Chỉ có đường nhập path, nhưng criterion vẫn đang `[x]`. Hai lựa chọn là làm hoặc hạ criterion; vòng này **làm**, vì hạ criterion là chấp nhận một phần yêu cầu của plan.

**Đã làm, bốn lớp:**

| Lớp | Thay đổi |
|---|---|
| `apps/desktop/src/security.mjs` | `"desktop:pickDirectory"` vào `IPC_CHANNELS` (allowlist là bản enforce) |
| `apps/desktop/src/main.mjs` | `"pickDirectory"` vào `EXPECTED_BRIDGE_METHODS` (6 method ↔ 6 channel, smoke test assert bằng nhau) + handler `dialog.showOpenDialog({properties:["openDirectory"]})`, trả `{ok, path, canceled}` |
| `apps/desktop/src/preload.cjs`, `apps/desktop/src/index.ts` | method `pickDirectory()` + khai báo trong `DesktopBridge` |
| `packages/conversation-client/src/Conversation.tsx`, `styles.ts` | nút "Chọn thư mục…" chỉ render khi bridge tồn tại; path chọn được gửi qua **đúng đường của path gõ tay** (`openProjectSession`), nên không có đường thứ hai để mở phiên |

Nút **không** render trên web, thay vì render rồi không làm gì: một control mở dialog không tồn tại là một lời hứa build không giữ được.

**Bằng chứng:** `apps/desktop/test/security.spec.ts` (allowlist channel), `packages/conversation-client/test/directory-picker.spec.ts` (4 test: bridge vắng / không có method / method không callable / callable được bind và trả path), và hai journey browser trong `apps/web/e2e/project-session.spec.ts`:

- "the desktop shell picks a directory in an OS dialog instead of asking for a typed path" — `addInitScript` cài bridge giả (dialog OS không drive được headless), bấm nút, phiên mở từ path mà dialog trả về, host reply nằm trong transcript;
- "the web build offers no directory picker" — không bridge ⇒ không nút, ô nhập vẫn là đường duy nhất.

**Giới hạn được nói rõ:** bản thân `dialog.showOpenDialog` không chạy trong test headless. Cái được chứng minh là *client dùng dialog khi có*, *channel được allowlist*, và *bridge expose đúng method*; phần OS dialog thật vẫn phải xác nhận bằng `pnpm --filter @clarkcant/app-desktop run smoke` trên máy có display.

## #4 — Plan tự ghi là chưa triển khai

`plan.md` front matter `status: pending` → `status: done`; câu "**Đây là plan chưa triển khai.**" trong Overview thay bằng trạng thái đã triển khai kèm con trỏ tới report này. `ak plan validate plans/260917-0528-jev-mini-app-rendering` pass.

## Gate

| Lệnh | Kết quả |
|---|---|
| `pnpm verify` | 7/7 invariant, typecheck + lint sạch, 60 file test (59 pass + 1 skip), **825 passed / 7 skipped** |
| `pnpm build` | pass (`vite build`: 151 module, 351 ms) |
| `pnpm test:e2e` | **25 passed** (23 test cũ + 2 journey picker mới), chromium headless trên linux |

## Còn lại / chưa đo

- Browser suite chạy trên Linux headless tại máy này (khác với darwin arm64 của phiên trước), nên đây là lần đầu e2e chạy trên linux.
- `dialog.showOpenDialog` thật (Electron, cần display) không nằm trong CI; xem mục #3.
- Corpus calibration vẫn nhỏ (34 search + 16 routing) — không đổi trong vòng này, vì `jev-decider.ts` không bị sửa.
- Cảnh báo vận hành gặp trong vòng này: `corepack pnpm` trên máy này resolve ra pnpm 11.25.0 và **fail** version check của repo; `pnpm` trần lại đúng 12.4.2. Nghĩa là hướng dẫn "luôn dùng `corepack pnpm`" trong handoff cũ đúng với máy cũ nhưng sai với máy này.

## Quyết định cho ba câu hỏi còn mở của handoff

Theo uỷ quyền của goal ("cho phép tự đề xuất & quyết định"), ba câu hỏi trong handoff §7 được chốt như sau, kèm lý do — không còn treo.

1. **Browser suite trên Linux trong CI: chưa thêm.** CI đã cài chromium (`pnpm exec playwright install --with-deps chromium`) nên `pnpm verify` chạy đủ test driver; thêm cả suite e2e web vào CI cần build + boot node + cấp port riêng, là thay đổi hạ tầng không nằm trong plan và có rủi ro flake. Plan chỉ đòi e2e *pass*, và nó pass; chỗ chạy được ghi rõ là máy này. Khi nào muốn CI bắt được khác biệt platform thì đó là một việc riêng, có issue riêng.
2. **Confidence dưới `confidenceFloor`: giữ `usable[0]` im lặng.** Đúng câu chữ của plan ("Jev vắng/uncertain → rank thuần") và đúng nguyên tắc "không trả fallback như thể Jev đã chọn". Hỏi lại người dùng trong trường hợp này là biến một lựa chọn *bên trong* một turn thành một cuộc đối thoại mới, và plan chỉ cho phép điều đó ở đường B (search) khi còn mơ hồ.
3. **`chooseExecutionNode` ở lại core.** Chính vì nó là *hook* chứ không phải import: core không được biết về selector, provider hay config, còn runtime là nơi biết. Chuyển seam sang runtime sẽ khiến conductor phải gọi ngược vào runtime — đúng thứ mà comment trong `conductor.ts` đang tránh.

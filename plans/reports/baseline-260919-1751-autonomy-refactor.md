# Baseline & kiến trúc đích — autonomy + guardrails refactor

**Ngày:** 19/09/2026 · **Branch:** `mrgoonie/refactor-architecture-guardrails` · **Base commit:** `e1c67d4`
**Goal:** `mu89l7f1-3h0hxt` — autonomous-by-default, host preflight giữ authority, Jev chỉ thu hẹp,
Interaction Manager, Secret Broker với JIT injection, trọn P1–P8 + emergency stop + audit trail.
**Task tương ứng:** `t0-baseline-docs` (task 1/11).

## 1. Baseline đã đo (trước mọi thay đổi code)

`pnpm verify` (invariants + typecheck + lint + unit tests), chạy trên cây chỉ mới sửa docs:

```
Test Files  85 passed | 1 skipped (86)
Tests       1099 passed | 7 skipped (1106)
Duration    30.75s
```

`node tools/check-invariants.mjs`: cả 7 check PASS (docs-manifest-integrity, workspace-phase-traceability,
stub-marks-owning-phase, node-type-stripping-syntax, no-committed-secrets, pinned-dependency-specifiers,
scope-and-acceptance-traceability).

Con số này là mốc so sánh cho mọi phase sau: test mới được **thêm**, không được làm con số cũ giảm.

## 2. Hiện trạng code liên quan (đã đối chiếu, không suy đoán)

| Điều đã kiểm | Bằng chứng |
|---|---|
| `guardCommand()` đã bỏ giới hạn thư mục và tự nói thẻ duyệt là chỗ quyết định | `apps/runtime/src/run-command.ts:70-89` |
| `run_command` chỉ được đăng ký khi có approval infra | `apps/runtime/src/node-tools.ts:38,190-213`, `apps/runtime/src/main.ts:107` |
| Đường chạy lệnh: card → `/approvals/:id/decide` → `runApprovedCommand` → continuation | `apps/runtime/src/gateway.ts:1220-1250, 1584-1660` |
| Voice chỉ hiểu một dạng chờ duyệt | `apps/runtime/src/voice-session.ts:98,138,292,390,432` |
| `ask_user_question` / `question-card` / `InteractionManager` / `request_secret` chưa tồn tại | grep toàn repo: 0 kết quả |
| Credentials đã có KV + `credential-card`, chưa có metadata/consumers/injection policy | `packages/storage/src/repositories.ts:2371-2410`, `apps/runtime/src/gateway.ts:341-373` |
| Jev đã có 5 quyết định A–E | `apps/runtime/src/jev-decider.ts` (`decideRuntimeTarget`, `decideProject`, `decideTurnAction`, `decideSearchResult`), `apps/runtime/src/jev-selector.ts` (`selectTemplate`, `selectSections`) |
| Model hiện là một preference đơn `key: "model"` scope `node` | `apps/runtime/src/gateway.ts:256-278`, `apps/runtime/src/main.ts:335-344` |
| `catalogue()` / `handoff()` có thật trong Pi adapter | `packages/pi-adapter/src/types.ts:141,178`, `real.ts:253,453` |
| Chưa có endpoint cancel/stop nào | `apps/runtime/src/gateway.ts:1564` chỉ có comment "nothing here cancels a task" |
| `pnpm invariants` ràng buộc `docs/manifest.json` (17 entry) | `tools/check-invariants.mjs` check #1 |

## 3. Quyết định đã chốt với user (nguồn cho mọi phase sau)

1. **Phạm vi:** trọn P1–P8 trong một goal, cộng governance (stop + audit).
2. **Invariant cứng:** containment theo resource ownership — mọi effect (cwd, ghi, target tool) phải nằm
   trong resource mà conversation/node sở hữu; ra ngoài bị **preflight deny**, Jev chỉ được thu hẹp thêm.
3. **Secret backend:** metadata + backend abstraction; store hiện tại (SQLite `credentials`) là backend đầu
   tiên; keychain adapter để sau. Không tự "encrypt" SQLite bằng key đặt cạnh DB.
4. **Governance:** stop phải dừng được command/background đang chạy; audit trail bền cho mọi effect.
   Không thêm nút stop nổi bật mới (đó là option đã bị loại).
5. **Fail-open khi Jev vắng** là mặc định và đổi được trong settings; fail-open chỉ bỏ lớp judgment,
   **không** bỏ preflight hay containment.
6. **Approval không bị xoá ở P1** — đổi default trước, hạ xuống policy mode `confirm` ở P8.

## 4. Kiến trúc đích đã ghi vào docs (t0)

- `docs/system-architecture.md`: thêm §7.4 (autonomy: preflight → Jev guardrail → execution broker →
  secret broker, `ExecutionPolicy`, fail-open), §7.5 (Interaction Manager + `PendingInteraction` +
  `ask_user_question`), §7.6 (Model Registry + đổi model là generation mới). Cập nhật §7.2 (trỏ tới hai
  quyết định mới), §7.3 (`run_command` spawn do `ExecutionPolicy` quyết định), §10 (metadata secret ở DB,
  value ở backend), §13 (invariant #11). Cả ba mục mới đều ghi rõ "không thay sơ đồ" theo luật PNG-thắng.
- `docs/research-and-decisions.md`: ADR 2026-09-19 (autonomous mặc định, authority ở host, Jev chỉ thu hẹp)
  + hai dòng B16/B17.
- `docs/manifest.json`: cập nhật `bytes` + `sha256` cho hai file trên (44473 / `6851ff6a…`,
  18544 / `bfe74b87…`).
- Lưu ý: contract của task ghi "(R-id)", nhưng quy ước của repo này là `Rxx` = nguồn upstream và quyết định
  nằm ở ADR có ngày + bảng `Bxx`. Đã làm theo quy ước repo (ADR 2026-09-19 + B16/B17).

## 6. Tiến độ theo phase

### t1-autonomy-core (P1) — đã implement, đang chạy gate

| Thay đổi | File |
|---|---|
| `executionPolicySchema` (auto/guarded/confirm/deny), `guardClassSchema`, `autonomySettingsSchema` + `parseAutonomySettings` field-wise, `guardrailConstraintSchema`, `DEFAULT_AUTONOMY_SETTINGS` | `packages/contracts/src/execution.ts` (+ `index.ts`, `test/execution.spec.ts` — 14 test) |
| Host preflight: ownership (containment), existence, budget, capability existence; classifier `classifyCommand`; `applyGuardrailConstraints` chỉ cho thu hẹp | `apps/runtime/src/preflight.ts` (+ `test/preflight.spec.ts` — 24 test) |
| `guardOperation` — quyết định thứ 6 của Jev: allow/deny/constrain/clarify/unavailable; constrain chọn **id** do host cấp (Jev không tự đặt constraint) | `apps/runtime/src/jev-decider.ts` |
| `runGuardedCommand` — chạy không cần approval, trả blocks (tool-activity + evidence) và receipt cho model | `apps/runtime/src/run-command.ts` |
| `policyForEffect`, `decideGuardrailForCommand`, `createRunCommandTool` tự chạy; `run_command` đăng ký **không** cần approval infra | `apps/runtime/src/node-tools.ts` (+ `test/command-policy.spec.ts` — 17 test) |
| `hostBlocks?` để một tool ghi được nhiều block | `packages/pi-adapter/src/types.ts`, `apps/runtime/src/model-turn.ts` |
| Đọc/ghi settings + bảng narrowing do host sở hữu, route `GET/POST /autonomy` | `apps/runtime/src/autonomy-settings.ts`, `apps/runtime/src/gateway.ts` |
| Tab Autonomy (execution mode, guardrails, instructions, fail-open, guard classes) | `packages/conversation-client/src/SettingsPanel.tsx`, `api.ts` |
| Fixture "chạy lệnh tự động" (drives the real tool) + e2e guarded run & settings tab | `apps/runtime/src/main.ts`, `apps/web/e2e/autonomy.spec.ts` |

Quyết định thiết kế đáng nhớ cho các phase sau:

- **Narrowing là host-owned.** Jev chọn một `id` trong bảng host cấp; host biến nó thành `GuardrailConstraint`. Vì vậy không có đường nào để model mô tả một phong bì rộng hơn, và `applyGuardrailConstraints` từ chối cả câu trả lời nếu có phần nào nới rộng (không clamp).
- **`unavailable` không phải `deny`.** Nó là *thiếu* phán đoán, nên `whenJevUnavailable` (mặc định allow) quyết định, không phải một đồng xu tung ở trong tool.
- **`clarify` trả câu hỏi về cho model (P1), P2 sẽ thay bằng question-card.** Đây là điểm nối giữa t1 và t2.
- **Containment roots** = `workspace.roots` (settings) + data dir của node + `process.cwd()`. Node chạy trong một checkout được người vận hành chỉ vào chính checkout đó.
- **Lỗ hổng đã biết, sẽ đóng ở P8:** đường `confirm` vẫn dùng `guardCommand` cũ (không containment) vì payload đến từ card đã hiển thị; P8 phải đưa preflight vào cả đường confirm tại thời điểm quyết định.

### Ghi chú cho t2 (InteractionManager) khi bắt đầu

Điểm nối đã có: `decideGuardrailForCommand` trả `{ kind: "refuse", text }` cho `clarify`; P2 nên đổi thành một `QuestionInteraction` thật. Hạ tầng hiện có để bắt chước: `hostCard`/`hostBlocks` trong `ToolDefinition`, `turn.segments.push({kind: "host-card"})` ở `model-turn.ts`, `pendingApproval` ở `voice-session.ts`, và route `/conversations/:id/approvals/:approvalId/decide` trong `gateway.ts` (mẫu cho `POST /interactions/:id/answer`).

Ràng buộc kỹ thuật phải nhớ: Node chạy `.ts` trực tiếp nên **không** dùng `enum`, `namespace`, hay
constructor parameter properties; deps exact-pinned; e2e dùng data dir và port riêng của playwright.

## 7. Bằng chứng gate t1 (verify:full) và 4 lỗi e2e có sẵn từ trước

`pnpm verify:full` (task `bd7086c3c`): phase unit xanh toàn bộ; phase e2e 48 passed / 5 failed.

- 1 lỗi là regression của t1: `appearance.spec.ts` assert `[role="tab"]` phải là 4, và tab Autonomy
  làm nó thành 5. Đã sửa **cả hai phía**: module doc của `SettingsPanel` (bỏ câu "four distinct areas",
  nêu lý do Autonomy là một khu vực chứ không phải một dòng trong General) và chính test (đổi thành 5,
  kèm comment giải thích, theo đúng cách comment cũ giải thích vì sao voice không nằm trong dialog).
  Chạy lại sạch: test đó xanh.
- 4 lỗi còn lại **có sẵn từ trước, không do P1**: `appearance.spec.ts:229` (tab Models), `j1.spec.ts:204`
  (background session), `onboarding.spec.ts:86` và `:110` (first run).
  Chứng minh: `rm -rf .data/e2e`, `git switch --detach e1c67d4`, chạy đúng 3 file spec đó →
  **23 passed / 4 failed, cùng danh sách, cùng thời lượng timeout**. Trên nhánh này cũng 23/4 với cùng
  danh sách, nên chúng không phải do thay đổi của t1.

Điều kiện còn thiếu của 4 test đó (theo luật "blocked phải nêu điều kiện, không được skip im lặng"):

- `appearance.spec.ts:229` cần node e2e báo được ít nhất một provider: `playwright.config.ts` chạy node
  với `CC_MODEL_FIXTURE=1` và **không** có provider key/model nào, nên catalogue rỗng, panel rơi vào nhánh
  "Node chưa báo provider nào" và `[data-search-input='model']` không hề tồn tại. Lỗi là
  `element(s) not found`, không phải sai giá trị.
- `j1.spec.ts:204`, `onboarding.spec.ts:86/110`: cùng trạng thái trên base commit, nằm ngoài mọi đường code
  mà P1 chạm tới. Chưa xác định được điều kiện thiếu cụ thể; cần một lượt điều tra riêng khi tới phase
  chạm vào background session hoặc first-run.

Ghi chú: chúng **không** được sửa hay nới trong goal này. Nếu một phase sau (P3 voice, P7 background
routing) chạm đúng đường đó thì phải xử lý ở đó, kèm điều kiện thiếu được nêu tên.

## 8. Kế hoạch t2 (InteractionManager) — đang làm

Đã có: `packages/contracts/src/interactions.ts` (PendingInteraction, 4 question kind, `normalizeAnswer`,
`voicePromptFor`, `answerNote`, `isWaiting`) + `test/interactions.spec.ts`; và block `question-card`
trong `packages/contracts/src/surfaces.ts` (union + HOST_OWNED_BLOCK_TYPES).

Thiết kế đã chốt, dựa trên đúng mẫu mà approval card đang dùng:

1. **Không thêm bảng mới.** Card là một message block (`question-card`, `status: "waiting"`), và câu trả lời
   là một message đi sau nó. Message bất biến, nên trạng thái "đã trả lời" được suy ra từ message trả lời —
   y như `data-approval-decision="answered"` suy ra từ receipt. Đây là điều làm cho "answer đến sau 10 phút"
   hoạt động mà không cần giữ một Pi call nào mở.
2. **InteractionManager** trong `apps/runtime/src/interactions.ts`: `create()`, `answer()`, `cancel()`,
   `expire()`, `pendingForConversation()`, nhận `db`/`conversationId`/`now`/`newId` như các module khác.
   `answer()` chuẩn hoá qua `normalizeAnswer`, append `answerNote(...)` như một message người dùng thấy.
3. **Tool `ask_user_question`** (`apps/runtime/src/node-tools.ts`): validate bằng `askUserQuestionSchema`,
   tạo interaction, trả `hostBlocks: [question-card]` và text "đã hỏi, lượt này kết thúc". **Không** await
   input trong `execute`.
4. **Route** `POST /conversations/:id/questions/:questionId/answer` trong `gateway.ts`, mẫu theo route
   approval hiện có: trả timeline mới, rồi chạy một turn mới với `answerNote` làm nội dung.
5. **Từ chối hỏi secret, deterministic**: nếu `question` khớp mẫu secret (api key/token/mật khẩu) → trả
   "This question appears to request a secret. Use request_secret instead." Không cần Jev.
6. **Project-finder/search clarify** chuyển thành `QuestionInteraction` thay vì text cho model.
7. **Client**: render `question-card` (4 kind) + `api.answerQuestion()`, sau đó e2e: card hiện, trả lời, turn
   tiếp theo nhận answer.

Điểm nối P1→P2 cần đổi: `decideGuardrailForCommand` hiện trả `{kind:"refuse", text}` cho `clarify`; P2 nên
tạo `QuestionInteraction` thật ở đó.

## 9. Trạng thái t2 (cập nhật)

Đã xanh: `apps/runtime/src/interactions.ts` (createQuestion/answerQuestion/cancelQuestion/expireQuestions/
pendingForConversation/interactionFromBlock) + 13 test; `packages/contracts/src/interactions.ts` + 16 test;
`apps/runtime/src/ask-user-question.ts` (host tool) + 3 test; block `question-card` trong union; route
`POST /conversations/:id/questions/:questionId/answer` và `/cancel`; `interactionDepsFor(services, conversationId)`
export từ gateway; tool đã đăng ký trong `createNodeTools` khi có `interactions`, và main.ts đã nối
`interactionWiring` theo conversation.

Còn lại của t2:
1. Client: render `question-card` (4 kind) + `api.answerQuestion()`/`cancelQuestion()`.
2. E2E: card hiện, trả lời, turn tiếp theo nhận answer (cần một fixture `ask_user_question` như fixture
   `chạy lệnh tự động` đã làm cho P1).
3. Chuyển `clarify` của project-finder/search (và của guardrail P1) thành `QuestionInteraction` thật
   thay vì text trả về cho model.

Quyết định đáng nhớ: câu trả lời KHÔNG append một text block thứ hai — chỉ ghi `tool-activity`
(`name: "ask_user_question"`, `args.questionId`, `decision: answered|cancelled|expired`), còn message
người dùng thấy do route tạo qua `handleUserMessage` (text = note, note = note + "hãy tiếp tục").

## 10. t2 — hoàn tất (chờ verify cuối)

Đã xong toàn bộ contract của t2:

| Mục contract | Bằng chứng |
|---|---|
| create/answer/cancel/expire/pendingForConversation | `apps/runtime/test/interactions.spec.ts` (13 test) |
| `ask_user_question` kết thúc turn, không await input | `apps/runtime/test/ask-user-question.spec.ts` (3 test) |
| Answer → Pi turn mới với nội dung answer | route `POST /conversations/:id/questions/:questionId/answer` qua `handleUserMessage`; e2e `apps/web/e2e/interactions.spec.ts` |
| 4 kind có schema hợp lệ + voice prompt do host sinh | `packages/contracts/test/interactions.spec.ts` (16 test) |
| Câu hỏi đòi secret bị từ chối deterministic | manager + tool test (`SECRET_REQUEST_MESSAGE`) |
| project-finder ambiguity → QuestionInteraction | `command-policy.spec.ts`: "becomes a question card rather than a question the model has to carry" + fallback khi node không hỏi được |
| E2E card render → trả lời → turn sau nhận answer | `apps/web/e2e/interactions.spec.ts` pass (1/1) |
| Client render + api | `QuestionCardBlock` trong `blocks.tsx` (4 kind), `api.answerQuestion`/`cancelQuestion`, `Conversation.tsx` suy `answeredQuestions` từ transcript |

Fixture mới ở main.ts: "hỏi tui chọn" (chạy qua đúng `createAskUserQuestionTool`) và nhánh trả lời cho turn
tiếp theo. Tổng unit test mới của t2: 51 (gồm cả regression của P1).

## 11. t3 — hoàn tất (chờ gate) + thiết kế t4 đã recon

### t3

- `packages/contracts/src/interactions.ts`: `foldWords`, `answerFromUtterance` (confirm → yes/no, single-choice →
  label dài nhất khớp trước, multi-choice → nhiều label **theo thứ tự đã offer**, text → nguyên văn; trả undefined
  khi không khớp để hỏi lại thay vì đoán). 7 test mới trong `contracts/test/interactions.spec.ts`.
- `apps/runtime/src/voice-session.ts`: `PendingVoiceInteraction` (approval | question) thay cho `pendingApproval`
  cứng; dep `answerQuestion`; nhánh approval giữ `interpretDecision` như cũ; nhánh question dùng
  `answerFromUtterance` rồi gọi `answerQuestion`.
- **Một code path cho click và voice:** `answerQuestionForNode(services, input)` export từ `gateway.ts`; route
  `POST /conversations/:id/questions/:questionId/answer` và voice wiring trong `main.ts` cùng gọi hàm đó.
- Test: 2 test mới trong `apps/runtime/test/voice-gateway.spec.ts` (đọc câu hỏi bằng voice prompt của host, nói
  "production" → gửi `optionIds: ["production"]`; nói lạc → hỏi lại, không ghi gì). Cả file 33 test xanh.

### t4 — recon đã xong

- `packages/storage/src/migrate.ts`: `MIGRATIONS` ở dòng 29, version cao nhất là **17**; bảng `credentials` được
  tạo ở migration **version 16** (dòng ~873–886). Migration mới phải là **version 18** và không được sửa cái cũ.
- `packages/storage/src/repositories.ts:2371+`: `putCredential` / `hasCredential` / `credentialNames` /
  `readCredential` — value chỉ ra khỏi DB qua `readCredential`, không có hàm nào liệt kê value.
- Kế hoạch t4: migration 18 tạo bảng `secrets` (secret_id, principal_id, node_id, name, description, kind,
  backend, backend_ref, allowed_consumers JSON, injection_policy, created_at, updated_at, last_used_at,
  UNIQUE(principal_id,name)); interface `SecretBackend` (has/read/write/delete) với backend đầu tiên là
  `node-store` chạy trên chính bảng `credentials` (backend_ref = tên credential); repository chỉ trả metadata;
  host tool `request_secret` (có → `available`, chưa có → credential-card); nâng `credential-card` thêm
  description/consumer/scope. E2E: value không xuất hiện trong DOM và không có trong continuation payload.

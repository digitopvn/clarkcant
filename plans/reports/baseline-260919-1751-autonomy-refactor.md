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

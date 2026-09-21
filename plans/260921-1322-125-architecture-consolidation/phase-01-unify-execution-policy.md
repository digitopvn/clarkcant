---
phase: 1
title: "Canonical execution policy cho command, widget, install và capability"
status: pending
priority: P1
effort: "2-3 ngày"
dependencies: []
---

# Phase 1 — Canonical execution policy

PR 1. Nhánh riêng từ `main` mới nhất. Đây là phase nặng nhất về semantics; nếu phải đánh đổi, ưu tiên không nới lỏng quyền.

## Goal

Một execution policy chuẩn duy nhất, một resolver duy nhất, được command / widget action / install / capability effect cùng đọc; `execution.*` và `autonomy` cũ chỉ còn là compatibility reader và được migrate mà không âm thầm nới lỏng cấu hình chặt hơn của user.

## Files to Create / Modify

- Modify: `packages/contracts/src/execution.ts` — thêm canonical config type/schema, fold guardrail fields; giữ `guardClassFor`, `applyGuardrailConstraints`-related types.
- Modify: `packages/contracts/src/preferences.ts` — thêm registry entry cho policy chuẩn (ví dụ `execution.policy`); giữ `execution.mode` / `execution.rules` như compatibility reader.
- Modify: `packages/contracts/src/index.ts` — export type/schema mới.
- Modify: `packages/core/src/execution-policy.ts` — `decideExecution()` nhận policy chuẩn (mode + rules + guardrails).
- Create: `packages/core/src/execution-policy-migration.ts` — đọc cả hai họ preference cũ, chọn hành vi chặt hơn, ghi policy chuẩn.
- Modify: `packages/core/src/preference-registry.ts` — nếu cần đọc/ghi typed policy value.
- Modify: `packages/core/src/widget-service.ts` — call site `decideExecution` (khoảng dòng 1190) đọc policy chuẩn.
- Modify: `apps/runtime/src/node-tools.ts` — `policyForEffect()`, `decideGuardrailForCommand()`, call site `input.autonomy()`.
- Modify: `apps/runtime/src/autonomy-settings.ts` — chuyển thành compatibility reader/writer của policy chuẩn.
- Modify: `apps/runtime/src/gateway.ts` — call site `decideExecution` (~1497), route `/autonomy` (GET ~893, POST ~900), route `/packages/install` (~1461).
- Modify: `packages/conversation-client/src/settings/ControlSettings.tsx` — một policy surface duy nhất.
- Modify: `apps/runtime/src/preflight.ts` — chỉ khi cần đổi signature; **không** đổi thứ tự host-preflight-trước-policy.
- Tests: `packages/core/test/execution-policy.spec.ts`, `apps/runtime/test/command-policy.spec.ts`, `apps/runtime/test/preflight.spec.ts`, `apps/runtime/test/package-install-route.spec.ts`, `apps/web/e2e/autonomy.spec.ts`.
- Create: `packages/core/test/execution-policy-parity.spec.ts`, `packages/core/test/execution-policy-migration.spec.ts`.
- Docs khi và chỉ khi behavior được ghi trong DESIGN.md thực sự đổi: `DESIGN.md`, `docs/system-architecture.md`, `docs/conformance-traceability.md`, `docs/manifest.json` (bytes + sha256).

## Tasks & Steps

### Task 1.1 — Chốt canonical contract
- Goal: một type/schema policy chuẩn, không tạo schema thứ ba.
- Steps:
  1. Đọc `packages/contracts/src/execution.ts` và `packages/contracts/src/preferences.ts` để liệt kê chính xác type đang có (`ExecutionMode`, `ExecutionRule`, `AutonomySettings`, `GuardClass`, `ExecutionPolicy`).
  2. Định nghĩa `ExecutionPolicyConfig` = `{ mode: ExecutionMode; rules: ExecutionRule[]; guardrails: { enabled: boolean; instructions: string; guardedClasses: GuardClass[]; whenUnavailable: "allow" | "deny" } }`, tái dùng đúng các type đã có; **không** định nghĩa lại `ExecutionMode` hay `ExecutionRule`.
  3. Thêm schema parse field-wise (giống `parseAutonomySettings`) và export từ `packages/contracts/src/index.ts`.
  4. Xử lý `executionPolicySchema = "auto" | "guarded" | "confirm" | "deny"`: giữ type cũ như kiểu legacy chỉ dùng trong migration, ghi chú rõ nó không còn là authority.
- Success criteria: `ExecutionPolicyConfig` parse được value thiếu field (fallback default) và value sai kiểu (không throw ra ngoài).
- Verify: `pnpm exec vitest run packages/core/test/execution-policy.spec.ts` exits 0.

### Task 1.2 — Resolver chuẩn
- Goal: `decideExecution()` chỉ còn một nguồn policy.
- Steps:
  1. Đổi tham số của `decideExecution(question)` để nhận `policy: ExecutionPolicyConfig` thay cho `{ mode, rules }` rời.
  2. Giữ nguyên thứ tự quyết định đang ghi trong doc comment của module: view action → hard boundary → user rule refuse → mode.
  3. Thêm bước guardrail như một judgment stage **bên trong** resolver: guardrail chỉ được deny / clarify / constrain; mọi nới rộng trả về refuse.
  4. Không đổi semantics của `recordEffectExecution` và audit/activity.
- Success criteria: resolver không còn đọc trực tiếp bất kỳ preference key nào; policy luôn được truyền vào.
- Verify: `pnpm typecheck` exits 0 và `grep -n "execution.mode\|execution.rules\|\"autonomy\"" packages/core/src/execution-policy.ts` không trả về kết quả.

### Task 1.3 — Migration không nới lỏng quyền
- Goal: cả hai họ preference cũ map sang policy chuẩn, chọn hành vi chặt hơn khi không map chính xác được.
- Steps:
  1. Viết bảng map trong `packages/core/src/execution-policy-migration.ts`:
     - `autonomy.executionPolicy`: `auto` → `autonomous`, `guarded` → `guarded`, `confirm` → `ask`, `deny` → không có mode tương đương ⇒ giữ como rule deny toàn cục + `mode: "ask"` (chặt hơn, không rộng hơn).
     - `execution.mode`: giữ nguyên giá trị khi chỉ có họ này.
     - Khi cả hai họ cùng tồn tại: chọn cặp cho **hành vi hiệu dụng chặt hơn**, thứ tự chặt dần `autonomous < guarded < ask`, và rule/guardrail nào chặt hơn thì giữ.
  2. Ghi `execution.policy` canonical; chỉ ghi lại khi giá trị hiện tại khác giá trị đã migrate (idempotent).
  3. Không xoá hai key cũ trong cùng PR này; chúng vẫn đọc được nhưng không còn là authority độc lập.
  4. Ghi audit/event cho lần migrate đầu tiên.
- Success criteria: hai lần chạy migration cho cùng kết quả; cấu hình `deny` cũ không bao giờ trở thành `autonomous`.
- Verify: `pnpm exec vitest run packages/core/test/execution-policy-migration.spec.ts` exits 0 và in ra case `deny stays restrictive`.

### Task 1.4 — Adopt ở bốn surface
- Goal: command, widget, install và capability effect cùng đọc policy chuẩn.
- Steps:
  1. `apps/runtime/src/node-tools.ts`: `policyForEffect()` và `decideGuardrailForCommand()` nhận policy chuẩn; giữ nguyên thứ tự `preflightCommand` → guardrail.
  2. `packages/core/src/widget-service.ts`: call site `decideExecution` dùng policy chuẩn.
  3. `apps/runtime/src/gateway.ts`: route `/packages/install` và call site `decideExecution` dùng policy chuẩn.
  4. Capability effect dùng `preflightCapability()` rồi cùng resolver; không viết nhánh quyết định thứ hai.
  5. Route `/autonomy` GET/POST trở thành compatibility reader/writer của policy chuẩn (đọc/ghi cùng một nguồn), không giữ state song song.
- Success criteria: `grep -rn "readAutonomySettings\|policyForEffect" apps/runtime/src packages/core/src` chỉ còn đi qua file compatibility/resolver trung tâm.
- Verify: `pnpm exec vitest run apps/runtime/test/command-policy.spec.ts apps/runtime/test/preflight.spec.ts apps/runtime/test/package-install-route.spec.ts` exits 0.

### Task 1.5 — Parity test xuyên surface
- Goal: cùng mode + rules thì effect category tương đương cho cùng execute/ask/deny outcome.
- Steps:
  1. Tạo `packages/core/test/execution-policy-parity.spec.ts`.
  2. Với mỗi cặp (mode ∈ autonomous/guarded/ask) × (category tương đương giữa command và widget/install) × (explicitUserIntent true/false) × (hard boundary có/không), assert cùng `PolicyDecision.kind`.
  3. Thêm case khẳng định `explicitUserIntent` semantics: Autonomous chạy effect user thực sự yêu cầu; effect do agent tự khởi tạo vẫn có thể bị guard.
  4. Thêm case khẳng định hard boundary được ask trong cả Autonomous.
- Success criteria: test matrix chạy hết, không case nào bị skip.
- Verify: `pnpm exec vitest run packages/core/test/execution-policy-parity.spec.ts` exits 0 và output liệt kê số case đã chạy.

### Task 1.6 — Một Settings surface
- Goal: user không còn thấy "command autonomy" tách khỏi "other effects".
- Steps:
  1. Trong `ControlSettings.tsx`, gộp hai section thành một control duy nhất cho mode và một vùng rules/guardrails.
  2. Xoá ghi chú "Two policies is one more than this product wants" sau khi thật sự còn một policy.
  3. Giữ nguyên progressive disclosure và các data attribute đang được e2e dùng; nếu đổi, cập nhật `apps/web/e2e/autonomy.spec.ts`.
- Success criteria: chỉ còn một nơi đổi execution policy trong UI; e2e autonomy xanh.
- Verify: `pnpm test:e2e --grep autonomy` exits 0 (giải phóng port 8876 và 4273 trước khi chạy).

### Task 1.7 — Gate và docs
- Goal: PR 1 xanh theo định nghĩa của repo.
- Steps:
  1. Chạy focused tests, rồi `pnpm invariants`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, rồi `pnpm verify`.
  2. Chạy `pnpm verify:full` nếu môi trường cho phép; nếu không, ghi rõ điều kiện thiếu.
  3. Cập nhật `docs/conformance-traceability.md` và `docs/manifest.json` nếu có file thuộc manifest bị sửa.
  4. Viết authority/data-flow ngắn trong PR description: ai đọc policy, ai quyết, Jev ở đâu.
- Success criteria: `pnpm verify` 0 failure; CI terminal xanh trên đúng head.
- Verify: `pnpm verify` exits 0; `gh pr checks <pr>` không còn check pending/failed.

## Verification

Thứ tự bắt buộc: focused vitest → `pnpm invariants` → `pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm verify` → `pnpm verify:full`/`pnpm test:e2e` cho journey nhìn thấy được → PR check xanh → sau merge CI `main` xanh.

Riêng phase này bắt buộc giữ và mở rộng bộ test hiện có: `packages/core/test/execution-policy.spec.ts`, `apps/runtime/test/command-policy.spec.ts`, `apps/runtime/test/preflight.spec.ts`.

---

# Advisory corrections — supersedes the tasks above where they conflict

Nguồn: kongming advisory checkpoint, 2026-09-21. Đọc phần này trước khi viết code. Các mục 1–8 là pre-condition cho Task 1.1.

## AC-0. Quyết định đã chốt: canonical default là `autonomous`

Không còn là câu hỏi mở. Căn cứ đã đọc trực tiếp:

- `DESIGN.md` §1.3 «User-owned autonomy»: *"Default execution policy là **Autonomous**"*, và bảng mode định nghĩa Guarded là *"hỏi trước các hành động irreversible, external-public, destructive hoặc sensitive theo policy"*.
- `DESIGN.md` §5.3 «Policy setup»: *"Default Autonomous, với one-line disclosure có link Đổi chế độ"*.
- `AGENTS.md`: *"Autonomous — default; execute explicit user intent without per-action approval"* và *"Guarded — ask only where configured/risk policy requires it"*.

Hệ quả bắt buộc, phải ghi trong PR body và `evidence.md`:

1. Canonical default = `autonomous`. Các hằng số legacy mâu thuẫn (`DEFAULT_EXECUTION_POLICY = "guarded"`, `DEFAULT_AUTONOMY_SETTINGS.executionPolicy = "guarded"`, registry default của `execution.mode` nếu khác) phải được đồng bộ hoặc ghi rõ là legacy-only.
2. **Đây là behavior change, không phải behavior-preserving.** Đường command hôm nay chạy legacy `guarded`: Jev được hỏi nhưng **không bao giờ mở approval card** (`apps/runtime/src/node-tools.ts:697`: *"`guarded` và `auto` differ only in whether the policy layer is consulted. Neither asks a person."*). Canonical `guarded` theo `decideExecution` **hỏi trên mọi `RISKY_CATEGORIES` bất kể `explicitUserIntent`**. Map `guarded → guarded` vì thế đổi hành vi command: card sẽ xuất hiện ở `destructive` / `external-write` / `financial` / `communication` / `media-capture`. Đó là **target đã ghi trong DESIGN.md**, nhưng phải công bố là thay đổi có chủ ý — tuyệt đối không được mô tả PR 1 là "không đổi hành vi".
3. `apps/web/e2e/autonomy.spec.ts:65` assert `[data-segment="guarded"]` pressed theo default — assertion đó mã hoá drift legacy, không phải target. Được phép đổi. **Giữ** assertion hành vi ở test 1 ("a command runs without an approval card under the default policy") vì dưới canonical autonomous + explicit user intent thì vẫn không có card. Nguyên tắc: **giữ behavioral assertion, bỏ legacy vocabulary**.

## AC-1. Behavior-change ledger phải tồn tại TRƯỚC code migration

Tạo mục `## Phase 1 — behavior-change ledger` trong `evidence.md` với một dòng cho mỗi tuple `(surface, effectCategory, explicitUserIntent, hardBoundary?) × (legacy-autonomy, legacy-execution.mode, legacy-both)`, hai cột *legacy decision* và *canonical decision*.

Thuộc tính phải khẳng định được: **không tuple nào canonical rộng hơn (looser) so với cả hai legacy family.** Đây là artifact làm PR 1 review được, và nó biến assertion e2e từ phỏng đoán thành dữ kiện đã kiểm.

Task 1.5 như viết ở trên chỉ test canonical-vs-canonical giữa các surface. Phải bổ sung **legacy-vs-canonical** — đó mới là chỗ regression thật nằm.

## AC-2. `prohibition` — không encode legacy `deny` bằng 7 rule

Thiết kế cũ (map `deny` → deny-all rule + mode `ask`) **bị loại**, vì bốn lý do đã kiểm trong tree:

1. **Fail open khi thêm category.** `executionRuleSchema.effectCategory` là list đóng 7 giá trị (`packages/contracts/src/primitives.ts:206-214`). Deny 7 rule là ảnh chụp tại thời điểm migrate; build thêm category thứ 8 sẽ **không** có deny cho nó. Hôm nay `policyForEffect` (`node-tools.ts:381`) trả `deny` cho mọi thứ, hiện tại và tương lai.
2. **`hardBoundary` được kiểm TRƯỚC rules** (`packages/core/src/execution-policy.ts:141-149`). Nên deny-as-rule bị override: effect có hard boundary trả `askFor`, và nếu được duyệt thì **chạy**. Người đã chọn "node này không bao giờ làm effect tài chính" sẽ được mời một màn hình consent OAuth.
3. **Cap 24 rule.** `executionRulesPreferenceSchema` tối đa 24 entry (`packages/contracts/src/preferences.ts:187`). Thêm 7 rule deny vào node đã đủ cap làm write invalid; `writeRegisteredPreference` **refuse** — migration phải kiểm outcome, không được coi "không throw" là thành công.
4. **`mode: "ask"` là companion sai**: `ask` yếu hơn `deny` ở mọi category mà denial không phủ, và biến "không bao giờ xảy ra" thành "có thể xảy ra nếu bạn bấm".

**Thiết kế đúng:** thêm một trục cấm vào canonical config với tính đóng cấu trúc (không đếm được):

```ts
prohibition: "none" | "all"   // legacy autonomy.executionPolicy === "deny" ⇒ "all"
```

- Đánh giá `prohibition === "all"` **TRÊN `hardBoundary`**. Justification: legacy deny vốn đã thắng mọi thứ trên đường command, nên đây là bảo toàn hành vi chứ không phải phát minh; và "user đã nói không bao giờ" không được bị huỷ bởi một consent screen do app khởi tạo.
- Companion mode cho `prohibition: "all"` dùng `guarded` (default của resolver), **không** dùng `ask`: `mode` chỉ giữ một nghĩa — *ai được hỏi khi effect được phép xảy ra*.
- Deny theo class không cần field mới: `executionRuleSchema.decision` đã có `deny` và đã được đánh giá trước mode.
- **Yêu cầu UI mới:** prohibition không biểu diễn được bằng mode segment, nên Task 1.6 phải có control riêng hiển thị rõ "từ chối mọi effect", nếu không user legacy-deny sẽ mở Settings và đọc "Guarded" trên một node từ chối tất cả.

Test bắt buộc thêm: (a) prohibition không sinh `execute` và không sinh `ask` cho effect không có hard boundary, ở mọi tổ hợp mode; (b) prohibition vẫn đứng khi có hard boundary; (c) migration cho node đang ở cap 24 rule.

## AC-3. Join hai legacy family phải pointwise, không gộp scalar

"Chọn hành vi hiệu dụng chặt hơn" **không** tính được bằng so sánh `autonomous < guarded < ask`, vì độ chặt là thuộc tính của hàm `(category × intent × boundary) → decision`, không phải của mode. Dùng construction đơn điệu:

| Thành phần | Phép join |
| --- | --- |
| `mode` | chặt nhất (most restrictive) |
| deny per category | hợp (union) của deny hai bên |
| execute per category | giao (intersection) — rule execute không có ở cả hai thì bỏ |
| `guardrail.enabled` | AND |
| `guardrail.classes` | hợp (union) |

Nhờ vậy invariant "không nới" chứng minh được bằng construction và test được pointwise.

## AC-4. Guardrail ở trong cùng document, nhưng đứng khác tầng

Giữ Jev trong canonical config (đừng tách storage khi đã gộp UI — tách sẽ dựng lại đúng hai read path là nợ đang phải trả). Ba điều kiện:

1. **Parse field-wise xuyên object lồng nhau.** `parseAutonomySettings` (`packages/contracts/src/execution.ts:142-165`) cố ý parse từng leaf, và comment nói rõ vì sao. Nếu `guardrails: {...}` parse all-or-nothing thì một `instructions` hỏng sẽ reset cả mode — đó là đường nới lỏng. Đây là **success criterion của Task 1.1**, không phải hệ quả ngầm.
2. **Đổi tên để hết trùng chữ "guarded":** `guardrail.guardedClasses` → `guardrail.classes`. `guardrail.classes` nghĩa là "class nào thì gọi Jev"; `mode: "guarded"` nghĩa là "ai được hỏi". Để một cái trong cái kia là bảo đảm đọc sai về sau.
3. **Không bao giờ persist output của Jev vào config.** Chỉ configuration là config; `allow`/`deny`/`constrain`/`clarify` vẫn ephemeral và chỉ đi qua `applyGuardrailConstraints`.

**Precedence table phải công bố và assert trong parity spec:**

```text
prohibition > hard boundary > rules > mode
Jev được gọi iff guardrail.enabled && guardClass(effect) ∈ guardrail.classes
```

Điểm chồng lấn phải giải tường minh: `rules[].decision` (theo `effectCategory`) và `guardrail.classes` (theo `GuardClass`) là hai knob chồng nhau. Authority cho "Jev có được gọi hay không" là `guardrail.classes` (đó là mental model của user và UI render nó thành `data-autonomy-class` checkbox).

## AC-5. Một reader duy nhất

`readExecutionPolicy` (`packages/core/src/execution-policy.ts:245`) phải **trở thành** canonical reader trỏ vào key `execution.policy` — không phải thêm một reader thứ ba cạnh nó. Thêm grep invariant: **chỉ một module được đọc policy preference**; `policyForEffect` chỉ còn reachable từ compatibility shim.

## AC-6. Command path phải adopt `decideExecution`

Task 1.4 như viết ở trên chỉ đổi nguồn đọc. Thực tế đường command hiện **không hề gọi `decideExecution`** — nó dùng `policyForEffect()` + `decideGuardrailForCommand()`. Unification thật nghĩa là command path đi qua canonical resolver, và đó chính là thay đổi hành vi ở AC-0 mục 2. Nếu implementation chọn **không** đổi đường command trong PR 1 thì phải nói rõ trong PR body rằng command path vẫn là legacy authority và mở follow-up — không được im lặng để hai authority cùng tồn tại.

## AC-7. Merge và auto-close

- `main` không được protect và `allow_auto_merge = false`. Merge bằng `gh pr merge --merge --match-head-commit <sha>` và **ghi `<sha>` + URL run xanh vào `evidence.md`**.
- Sau **mọi** rebase, chạy lại `pnpm verify`.
- **Mọi PR từ Phase 1 trở đi** phải ghi trong body rằng PR đó **không** đóng `#93`/`#2`/`#3`/`#4`/`#5`, và không chứa keyword `Closes`/`Fixes` cho chúng. `main` không có human gate, nên auto-close xảy ra lúc merge — kiểm ở Phase 6 là quá muộn.

## AC-8. Sửa lỗi văn bản

Task 1.3 step 1 có một từ tiếng Tây Ban Nha trong câu tiếng Việt: "giữ **como** rule deny toàn cục" → đọc là **như**. (Câu này cũng bị AC-2 thay thế.)

## AC-9. Escape hatch

Task 1.6 (gộp UI) là việc ít rủi ro nhất và được phép **tách thành PR riêng** nếu phase kéo dài. Không được nén Task 1.1–1.3 để bù tiến độ. Ghi rõ lựa chọn này ngay từ đầu để áp lực schedule không được trả bằng cách nới verification.

## Failure Protocol

If any Verify step does not meet its stated pass condition, STOP this phase.
Do not improvise a fix, retry blindly, or reason around the failure.
Spawn the `kongming` subagent for next-step counsel and pass:
- the phase and task id,
- what you attempted (the steps you ran),
- the exact command and its full output,
- the pass condition it failed to meet.
Apply kongming's guidance, then re-run the Verify step.
If `kongming` cannot be spawned in this environment, STOP and report the same
failure evidence to the user. Never continue by self-reasoning.

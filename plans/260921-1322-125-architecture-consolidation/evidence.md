# Evidence journal — program architecture consolidation (issue #125)

Ghi lại bằng chứng thật cho từng phase: command đã chạy, output, và kết luận. Không ghi secret, không ghi absolute path riêng tư.

## Phase 0 — Program setup

| Bước | Command | Kết quả |
| --- | --- | --- |
| Worktree | `git rev-parse --git-common-dir` vs `--git-dir` | Isolated worktree: common `/home/orca/www/clarkcant/.git`, dir `.../worktrees/architecture-consolidation-unify-policy-confine` |
| Branch | `git branch --show-current` | `architecture-consolidation-unify-policy-confine` (không phải `main`) |
| Đồng bộ main | `git rev-list --left-right --count origin/main...HEAD` | `0	0` — ngang bằng `origin/main`, worktree sạch |
| PR hiện có | `gh pr list --head architecture-consolidation-unify-policy-confine` | `[]` — chưa có PR nào |
| Plan scaffold | `ak plan create 125-architecture-consolidation --json` | `plans/260921-1322-125-architecture-consolidation`, store id `clarkcant/260921-1322` |
| Plan validate | `ak plan validate plans/260921-1322-125-architecture-consolidation` | `[OK] ... is a valid plan directory`, exit 0 |
| Issue tracker | `gh issue comment 125 --body-file` | https://github.com/digitopvn/clarkcant/issues/125#issuecomment-5761223324 |
| Label | `gh issue edit 125 --add-label "ready to cook"` | Nhãn hiện tại: `ready to cook` |
| Plan index | `ak plan update clarkcant/260921-1322 --issue 125 --branch ... --root-comment-id 5761223324` | exit 0, `issue_number: 125` |
| Red-team | `red-team.md` — 4 persona | 5 finding Assumptions, 6 Failure, 6 Scope, 7 Security; tất cả có resolution |

### Điều kiện môi trường đã kiểm tra thật

| Fact | Command | Giá trị |
| --- | --- | --- |
| Branch protection | `gh api repos/digitopvn/clarkcant/branches/main/protection` | 404 — `main` không được bảo vệ |
| Auto-merge | `gh api repos/digitopvn/clarkcant --jq` | `allow_auto_merge: false` ⇒ không dùng `gh pr merge --auto` |
| Merge methods | như trên | merge, squash, rebase đều cho phép |
| CI gates | `.github/workflows/ci.yml` | `verify` (Node 22.19 + 24), `e2e`, `desktop-smoke`, `secret-scan` |
| Verify script | `package.json` | `pnpm verify` = invariants + typecheck + lint + test; `verify:full` thêm e2e |

## Phase 1 — Canonical execution policy

### Trinh sát code (read-only, trước khi viết code)

| Fact | Nguồn | Chi tiết |
| --- | --- | --- |
| Resolver hiện tại | `packages/core/src/execution-policy.ts:129` | `decideExecution(question)`; thứ tự quyết định: view → hardBoundary → rule deny → mode switch, `default` fail closed bằng `deny` |
| Reader hiện tại | `packages/core/src/execution-policy.ts:255` | `readExecutionPolicy(deps, principalId)` đọc `execution.mode` + `execution.rules` từ registry; parse lỗi ⇒ fallback theo registry default |
| Audit | `packages/core/src/execution-policy.ts:274` | `recordEffectExecution()` ghi event `effect.executed`, `approvedBy: "policy"` — phải giữ nguyên |
| Risky gate | `execution-policy.ts` (autonomous branch) | `RISKY_CATEGORIES.has(category) && !explicitUserIntent` ⇒ ask. Đây là `explicitUserIntent` semantics phải bảo toàn |
| Vocabulary legacy | `packages/contracts/src/execution.ts:23` | `executionPolicySchema = auto \| guarded \| confirm \| deny`; `DEFAULT_EXECUTION_POLICY = "guarded"` |
| Autonomy shape | `packages/contracts/src/execution.ts:110` | `{ executionPolicy, jevGuardrails, instructions, guardedClasses, whenJevUnavailable }`; `parseAutonomySettings` đã field-wise |
| Guardrail bound | `packages/contracts/src/execution.ts:172` | `guardrailConstraintSchema` chỉ có `timeout-ms`, `max-output-bytes`, `cwd`; `GuardrailDecision` chỉ allow/deny/constrain/clarify — không có field nới quyền |
| GuardClass | `packages/contracts/src/execution.ts:51` | 6 class: commands, local-writes, external-writes, communication, financial, reads; `guardClassFor()` map surface+category → class |
| Default autonomy | `packages/contracts/src/execution.ts:127` | `guarded`, guardrails bật, `whenJevUnavailable: allow`, guardedClasses = mọi class trừ reads |
| Nguồn mode hiện tại | `packages/contracts/src/preferences.ts:340` | Registry `execution.mode` default `autonomous`; `execution.rules` là array ≤ 24 |

**Kết luận cho Task 1.1/1.3:** `deny` là giá trị duy nhất không có mode tương đương. Vì `GuardrailDecision` và `guardrailConstraintSchema` đã không có khả năng nới quyền, việc fold guardrail vào canonical config chỉ là chuyển chỗ khai báo, không tạo authority mới.

### Call site phải adopt (Task 1.4)

| Surface | Vị trí | Hiện đang làm gì | Đổi thành |
| --- | --- | --- | --- |
| Widget action | `packages/core/src/widget-service.ts:1186-1200` (`invokeMiniAppAction`) | Nhận `request.policy` dạng `{ mode, rules }`, gọi `decideExecution` với `explicitUserIntent: true`, `operationDigest: request.expectedBindingDigest` | Nhận `ExecutionPolicyConfig`; giữ nguyên `explicitUserIntent: true` và binding digest |
| Install | `apps/runtime/src/gateway.ts:1493-1500` | `readExecutionPolicy(...)` rồi `decideExecution` với `category: "local-write"`, `operationDigest: entry.digest`, `explicitUserIntent: true` | Dùng resolver canonical; digest và `explicitUserIntent` giữ nguyên; nhánh `ask` vẫn `requestApproval` + trả 202 |
| Command | `apps/runtime/src/node-tools.ts` (~614-690) | `input.autonomy()` → `policyForEffect()` → `preflightCommand()` → `decideGuardrailForCommand()` | `input.autonomy()` trở thành reader canonical; thứ tự preflight → guardrail không đổi |
| Capability | `apps/runtime/src/preflight.ts:305` (`preflightCapability`) | Có seam nhưng chưa nối vào cùng resolver | Nối cùng resolver, không viết nhánh quyết định thứ hai |
| Settings API | `apps/runtime/src/gateway.ts:893` (GET `/autonomy`), `:900` (POST `/autonomy`) | Đọc/ghi `autonomy` qua `readAutonomySettings` / `saveAutonomySettings`, kèm `DEFAULT_NARROWING` | Trở thành compatibility reader/writer của cùng một nguồn; `narrowing` vẫn host-owned |

### Advisory checkpoint — kongming, 2026-09-21 (run `db7d2878`)

**Verdict: GO**, với một quyết định phải chốt trước khi viết code, và một đề xuất trong thiết kế cũ bị loại.

| # | Finding | Xử lý |
| --- | --- | --- |
| K1 | Canonical default chưa được quyết; bốn nguồn trong repo trả lời khác nhau | **Chấp nhận.** Chốt `autonomous` theo `DESIGN.md` §1.3 + §5.3 + `AGENTS.md`. Ghi vào phase-01 AC-0 |
| K2 | Map `guarded → guarded` **không** behavior-preserving: legacy command path không bao giờ mở approval card (`node-tools.ts:697`), canonical `guarded` hỏi trên mọi `RISKY_CATEGORIES` | **Chấp nhận.** PR 1 phải công bố là behavior change, không được nói "không đổi hành vi" (AC-0 mục 2) |
| K3 | Encode legacy `deny` bằng 7 deny-rule là sai: fail open khi thêm category thứ 8; bị `hardBoundary` override vì hard boundary được kiểm TRƯỚC rules; cap 24 rule có thể làm write invalid; `mode: ask` là companion sai | **Chấp nhận, đây là defect bảo mật.** Thay bằng field `prohibition: "none" hoặc "all"` đánh giá **trên** `hardBoundary` (AC-2) |
| K4 | Join hai family phải pointwise, không gộp scalar | **Chấp nhận** (AC-3) |
| K5 | `guardrails.guardedClasses` trùng chữ "guarded" với `mode: guarded` | **Chấp nhận**, đổi tên thành `guardrail.classes` (AC-4) |
| K6 | Parse field-wise cho object lồng nhau phải là success criterion | **Chấp nhận** (AC-4 mục 1) |
| K7 | `readExecutionPolicy` phải trở thành canonical reader, không thêm reader thứ ba | **Chấp nhận** (AC-5) |
| K8 | Command path hiện không hề gọi `decideExecution` | **Chấp nhận** (AC-6) |
| K9 | Merge phải bind reviewed SHA; no-auto-close trên mọi PR | **Chấp nhận** (AC-7) |
| K10 | Đảo Phase 3 lên trước Phase 2 | **Không chấp nhận thứ tự**, vì goal contract và issue #125 quy định thứ tự issue là authoritative và hai phase độc lập. Rủi ro Phase 2 được xử bằng **Pre-task 2.0 spike A3** — chính là điều counsel muốn đạt được |
| K11 | Lỗi chữ "como" trong Task 1.3 | **Chấp nhận** (AC-8); câu đó cũng bị AC-2 thay thế |
| K12 | Task 1.6 được phép tách PR riêng | **Chấp nhận** (AC-9) |

Ghi chú: `DEFAULT_EXECUTION_POLICY = "guarded"` và `DEFAULT_AUTONOMY_SETTINGS.executionPolicy = "guarded"` là drift legacy so với target đã ghi trong `DESIGN.md`, không phải nguồn authority.

**Baseline test đã chạy (trước khi sửa gì):** `pnpm exec vitest run packages/core/test/execution-policy.spec.ts apps/runtime/test/command-policy.spec.ts apps/runtime/test/preflight.spec.ts` → **3 files, 65 tests passed**.

### Behavior-change ledger (AC-1) — viết TRƯỚC khi sửa code

**Thuộc tính phải giữ:** không tuple nào canonical **rộng hơn (looser)** so với quyết định legacy của họ preference đã
thực sự chi phối surface đó.

**Miền tuple:** `(surface, effectCategory, explicitUserIntent, hardBoundary?) × (legacy-autonomy,
legacy-execution.mode, legacy-both)` = 4 surface × 7 category × 2 intent × 2 boundary × 10 cấu hình legacy = **1120 tuple**.
Cột legacy được hoist ra khỏi bốn cột canonical vì legacy không có input intent và không có khái niệm hard boundary
(đường command không có cờ intent; đường widget/install hard-code `explicitUserIntent: true` và truyền boundary
`undefined`) — nên bốn tuple chỉ khác nhau ở intent/boundary có **cùng một** quyết định legacy. Đây là phép chuyển vị,
không phải giảm miền: cả 1120 tuple vẫn được đánh giá.

**Ai chi phối surface nào (đọc từ code trước khi sửa):** đường command chỉ đọc preference `autonomy`
(`apps/runtime/src/node-tools.ts` → `policyForEffect`); widget action, install và capability chỉ đọc `execution.mode` +
`execution.rules` (`readExecutionPolicy`). Vì vậy cột legacy là `—` ở những tuple mà họ preference đó chưa từng chi
phối surface đó, và với nhóm `legacy-both` cột legacy là họ đã chi phối surface (autonomy cho command, mode+rules cho
ba surface còn lại) — đúng cái phải so.

**Bảng quyết định đã dùng:**

- legacy command (`policyForEffect` + nhánh policy trong `run_command`): `deny` → deny; `confirm` → ask (card);
  `auto` → execute (không gọi guardrail); `guarded` → execute, **không bao giờ mở card**, chỉ gọi guardrail khi
  `guardClass ∈ guardedClasses` và `jevGuardrails` bật.
- legacy widget/install (`decideExecution({mode, rules, explicitUserIntent: true})`): như resolver canonical nhưng
  không có `prohibition` và không có hard boundary.
- canonical: `prohibition > hard boundary > rules > mode`; Jev được gọi iff `guardrails.enabled &&
  guardClass(effect) ∈ guardrails.classes`, và chỉ trên nhánh `execute`.

**Kết quả (0 violation / 1120 tuple):** 97 hàng chuyển sang **chặt hơn**, 78 hàng **bằng**, 0 hàng rộng hơn.
Các hàng chặt hơn đúng là behavior change đã công bố ở AC-0 mục 2 (`guarded` canonical mở card ở
`destructive`/`external-write`/`financial`/`communication`/`media-capture`) và ở AC-2 (`deny` legacy → `prohibition:
"all"`, đứng trên hard boundary).

**Hàng legacy-deny (phải đọc kỹ):**

| legacy config | surface | category | legacy | canonical (T/none) | canonical (F/none) | canonical (T/bnd) | canonical (F/bnd) | looser? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| legacy-autonomy · deny | command | any of 7 | deny | deny | deny | deny | deny | equal |
| legacy-both · A=deny + B=autonomous | command | any of 7 | deny | deny | deny | deny | deny | equal |
| legacy-both · A=deny + B=autonomous | widget-action/install/capability | any of 7 | execute/ask (theo mode+rules) | deny | deny | deny | deny | stricter |

Nghĩa là: node từng chọn `deny` vẫn từ chối mọi category, **kể cả khi có hard boundary** — đúng AC-2 (một màn hình
consent do app khởi tạo không được lật lại câu "không bao giờ" của người dùng).

**Bảng dữ kiện bắt buộc nằm trong test:** `packages/core/test/execution-policy-parity.spec.ts` chạy lại đúng miền này
bằng resolver thật và in ra số case đã chạy, để ledger không phải là một phép tính tay rời khỏi code.

Bảng đầy đủ 280 hàng (do script `/tmp/ledger.mjs` sinh, `node /tmp/ledger.mjs`; script chỉ dùng để sinh evidence,
không nằm trong cây repo):

| legacy config | surface | effectCategory | legacy decision | canonical intent=T bnd=none | canonical intent=F bnd=none | canonical intent=T bnd=yes | canonical intent=F bnd=yes | looser? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| legacy-autonomy · guarded (default) | command | read | execute | execute | execute | ask | ask | stricter |
| legacy-autonomy · guarded (default) | command | local-write | execute | execute | execute | ask | ask | stricter |
| legacy-autonomy · guarded (default) | command | external-write | execute | ask | ask | ask | ask | stricter |
| legacy-autonomy · guarded (default) | command | destructive | execute | ask | ask | ask | ask | stricter |
| legacy-autonomy · guarded (default) | command | financial | execute | ask | ask | ask | ask | stricter |
| legacy-autonomy · guarded (default) | command | communication | execute | ask | ask | ask | ask | stricter |
| legacy-autonomy · guarded (default) | command | media-capture | execute | ask | ask | ask | ask | stricter |
| legacy-autonomy · guarded (default) | widget-action | read | — | execute | execute | ask | ask | n/a |
| legacy-autonomy · guarded (default) | widget-action | local-write | — | execute | execute | ask | ask | n/a |
| legacy-autonomy · guarded (default) | widget-action | external-write | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · guarded (default) | widget-action | destructive | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · guarded (default) | widget-action | financial | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · guarded (default) | widget-action | communication | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · guarded (default) | widget-action | media-capture | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · guarded (default) | install | read | — | execute | execute | ask | ask | n/a |
| legacy-autonomy · guarded (default) | install | local-write | — | execute | execute | ask | ask | n/a |
| legacy-autonomy · guarded (default) | install | external-write | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · guarded (default) | install | destructive | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · guarded (default) | install | financial | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · guarded (default) | install | communication | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · guarded (default) | install | media-capture | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · guarded (default) | capability | read | — | execute | execute | ask | ask | n/a |
| legacy-autonomy · guarded (default) | capability | local-write | — | execute | execute | ask | ask | n/a |
| legacy-autonomy · guarded (default) | capability | external-write | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · guarded (default) | capability | destructive | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · guarded (default) | capability | financial | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · guarded (default) | capability | communication | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · guarded (default) | capability | media-capture | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · auto | command | read | execute | execute | execute | ask | ask | stricter |
| legacy-autonomy · auto | command | local-write | execute | execute | execute | ask | ask | stricter |
| legacy-autonomy · auto | command | external-write | execute | execute | ask | ask | ask | stricter |
| legacy-autonomy · auto | command | destructive | execute | execute | ask | ask | ask | stricter |
| legacy-autonomy · auto | command | financial | execute | execute | ask | ask | ask | stricter |
| legacy-autonomy · auto | command | communication | execute | execute | ask | ask | ask | stricter |
| legacy-autonomy · auto | command | media-capture | execute | execute | ask | ask | ask | stricter |
| legacy-autonomy · auto | widget-action | read | — | execute | execute | ask | ask | n/a |
| legacy-autonomy · auto | widget-action | local-write | — | execute | execute | ask | ask | n/a |
| legacy-autonomy · auto | widget-action | external-write | — | execute | ask | ask | ask | n/a |
| legacy-autonomy · auto | widget-action | destructive | — | execute | ask | ask | ask | n/a |
| legacy-autonomy · auto | widget-action | financial | — | execute | ask | ask | ask | n/a |
| legacy-autonomy · auto | widget-action | communication | — | execute | ask | ask | ask | n/a |
| legacy-autonomy · auto | widget-action | media-capture | — | execute | ask | ask | ask | n/a |
| legacy-autonomy · auto | install | read | — | execute | execute | ask | ask | n/a |
| legacy-autonomy · auto | install | local-write | — | execute | execute | ask | ask | n/a |
| legacy-autonomy · auto | install | external-write | — | execute | ask | ask | ask | n/a |
| legacy-autonomy · auto | install | destructive | — | execute | ask | ask | ask | n/a |
| legacy-autonomy · auto | install | financial | — | execute | ask | ask | ask | n/a |
| legacy-autonomy · auto | install | communication | — | execute | ask | ask | ask | n/a |
| legacy-autonomy · auto | install | media-capture | — | execute | ask | ask | ask | n/a |
| legacy-autonomy · auto | capability | read | — | execute | execute | ask | ask | n/a |
| legacy-autonomy · auto | capability | local-write | — | execute | execute | ask | ask | n/a |
| legacy-autonomy · auto | capability | external-write | — | execute | ask | ask | ask | n/a |
| legacy-autonomy · auto | capability | destructive | — | execute | ask | ask | ask | n/a |
| legacy-autonomy · auto | capability | financial | — | execute | ask | ask | ask | n/a |
| legacy-autonomy · auto | capability | communication | — | execute | ask | ask | ask | n/a |
| legacy-autonomy · auto | capability | media-capture | — | execute | ask | ask | ask | n/a |
| legacy-autonomy · confirm | command | read | ask | ask | ask | ask | ask | equal |
| legacy-autonomy · confirm | command | local-write | ask | ask | ask | ask | ask | equal |
| legacy-autonomy · confirm | command | external-write | ask | ask | ask | ask | ask | equal |
| legacy-autonomy · confirm | command | destructive | ask | ask | ask | ask | ask | equal |
| legacy-autonomy · confirm | command | financial | ask | ask | ask | ask | ask | equal |
| legacy-autonomy · confirm | command | communication | ask | ask | ask | ask | ask | equal |
| legacy-autonomy · confirm | command | media-capture | ask | ask | ask | ask | ask | equal |
| legacy-autonomy · confirm | widget-action | read | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | widget-action | local-write | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | widget-action | external-write | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | widget-action | destructive | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | widget-action | financial | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | widget-action | communication | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | widget-action | media-capture | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | install | read | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | install | local-write | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | install | external-write | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | install | destructive | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | install | financial | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | install | communication | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | install | media-capture | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | capability | read | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | capability | local-write | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | capability | external-write | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | capability | destructive | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | capability | financial | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | capability | communication | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · confirm | capability | media-capture | — | ask | ask | ask | ask | n/a |
| legacy-autonomy · deny | command | read | deny | deny | deny | deny | deny | equal |
| legacy-autonomy · deny | command | local-write | deny | deny | deny | deny | deny | equal |
| legacy-autonomy · deny | command | external-write | deny | deny | deny | deny | deny | equal |
| legacy-autonomy · deny | command | destructive | deny | deny | deny | deny | deny | equal |
| legacy-autonomy · deny | command | financial | deny | deny | deny | deny | deny | equal |
| legacy-autonomy · deny | command | communication | deny | deny | deny | deny | deny | equal |
| legacy-autonomy · deny | command | media-capture | deny | deny | deny | deny | deny | equal |
| legacy-autonomy · deny | widget-action | read | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | widget-action | local-write | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | widget-action | external-write | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | widget-action | destructive | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | widget-action | financial | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | widget-action | communication | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | widget-action | media-capture | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | install | read | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | install | local-write | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | install | external-write | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | install | destructive | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | install | financial | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | install | communication | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | install | media-capture | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | capability | read | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | capability | local-write | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | capability | external-write | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | capability | destructive | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | capability | financial | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | capability | communication | — | deny | deny | deny | deny | n/a |
| legacy-autonomy · deny | capability | media-capture | — | deny | deny | deny | deny | n/a |
| legacy-execution.mode · autonomous (default) | command | read | — | execute | execute | ask | ask | n/a |
| legacy-execution.mode · autonomous (default) | command | local-write | — | execute | execute | ask | ask | n/a |
| legacy-execution.mode · autonomous (default) | command | external-write | — | execute | ask | ask | ask | n/a |
| legacy-execution.mode · autonomous (default) | command | destructive | — | execute | ask | ask | ask | n/a |
| legacy-execution.mode · autonomous (default) | command | financial | — | execute | ask | ask | ask | n/a |
| legacy-execution.mode · autonomous (default) | command | communication | — | execute | ask | ask | ask | n/a |
| legacy-execution.mode · autonomous (default) | command | media-capture | — | execute | ask | ask | ask | n/a |
| legacy-execution.mode · autonomous (default) | widget-action | read | execute | execute | execute | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | widget-action | local-write | execute | execute | execute | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | widget-action | external-write | execute | execute | ask | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | widget-action | destructive | execute | execute | ask | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | widget-action | financial | execute | execute | ask | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | widget-action | communication | execute | execute | ask | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | widget-action | media-capture | execute | execute | ask | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | install | read | execute | execute | execute | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | install | local-write | execute | execute | execute | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | install | external-write | execute | execute | ask | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | install | destructive | execute | execute | ask | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | install | financial | execute | execute | ask | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | install | communication | execute | execute | ask | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | install | media-capture | execute | execute | ask | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | capability | read | execute | execute | execute | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | capability | local-write | execute | execute | execute | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | capability | external-write | execute | execute | ask | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | capability | destructive | execute | execute | ask | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | capability | financial | execute | execute | ask | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | capability | communication | execute | execute | ask | ask | ask | stricter |
| legacy-execution.mode · autonomous (default) | capability | media-capture | execute | execute | ask | ask | ask | stricter |
| legacy-execution.mode · guarded | command | read | — | execute | execute | ask | ask | n/a |
| legacy-execution.mode · guarded | command | local-write | — | execute | execute | ask | ask | n/a |
| legacy-execution.mode · guarded | command | external-write | — | ask | ask | ask | ask | n/a |
| legacy-execution.mode · guarded | command | destructive | — | ask | ask | ask | ask | n/a |
| legacy-execution.mode · guarded | command | financial | — | ask | ask | ask | ask | n/a |
| legacy-execution.mode · guarded | command | communication | — | ask | ask | ask | ask | n/a |
| legacy-execution.mode · guarded | command | media-capture | — | ask | ask | ask | ask | n/a |
| legacy-execution.mode · guarded | widget-action | read | execute | execute | execute | ask | ask | stricter |
| legacy-execution.mode · guarded | widget-action | local-write | execute | execute | execute | ask | ask | stricter |
| legacy-execution.mode · guarded | widget-action | external-write | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · guarded | widget-action | destructive | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · guarded | widget-action | financial | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · guarded | widget-action | communication | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · guarded | widget-action | media-capture | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · guarded | install | read | execute | execute | execute | ask | ask | stricter |
| legacy-execution.mode · guarded | install | local-write | execute | execute | execute | ask | ask | stricter |
| legacy-execution.mode · guarded | install | external-write | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · guarded | install | destructive | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · guarded | install | financial | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · guarded | install | communication | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · guarded | install | media-capture | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · guarded | capability | read | execute | execute | execute | ask | ask | stricter |
| legacy-execution.mode · guarded | capability | local-write | execute | execute | execute | ask | ask | stricter |
| legacy-execution.mode · guarded | capability | external-write | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · guarded | capability | destructive | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · guarded | capability | financial | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · guarded | capability | communication | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · guarded | capability | media-capture | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | command | read | — | ask | ask | ask | ask | n/a |
| legacy-execution.mode · ask | command | local-write | — | ask | ask | ask | ask | n/a |
| legacy-execution.mode · ask | command | external-write | — | ask | ask | ask | ask | n/a |
| legacy-execution.mode · ask | command | destructive | — | ask | ask | ask | ask | n/a |
| legacy-execution.mode · ask | command | financial | — | ask | ask | ask | ask | n/a |
| legacy-execution.mode · ask | command | communication | — | ask | ask | ask | ask | n/a |
| legacy-execution.mode · ask | command | media-capture | — | ask | ask | ask | ask | n/a |
| legacy-execution.mode · ask | widget-action | read | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | widget-action | local-write | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | widget-action | external-write | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | widget-action | destructive | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | widget-action | financial | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | widget-action | communication | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | widget-action | media-capture | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | install | read | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | install | local-write | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | install | external-write | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | install | destructive | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | install | financial | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | install | communication | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | install | media-capture | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | capability | read | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | capability | local-write | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | capability | external-write | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | capability | destructive | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | capability | financial | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | capability | communication | ask | ask | ask | ask | ask | equal |
| legacy-execution.mode · ask | capability | media-capture | ask | ask | ask | ask | ask | equal |
| legacy-both · A=guarded + B=autonomous | command | read | execute | execute | execute | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | command | local-write | execute | execute | execute | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | command | external-write | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | command | destructive | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | command | financial | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | command | communication | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | command | media-capture | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | widget-action | read | execute | execute | execute | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | widget-action | local-write | execute | execute | execute | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | widget-action | external-write | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | widget-action | destructive | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | widget-action | financial | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | widget-action | communication | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | widget-action | media-capture | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | install | read | execute | execute | execute | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | install | local-write | execute | execute | execute | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | install | external-write | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | install | destructive | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | install | financial | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | install | communication | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | install | media-capture | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | capability | read | execute | execute | execute | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | capability | local-write | execute | execute | execute | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | capability | external-write | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | capability | destructive | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | capability | financial | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | capability | communication | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=guarded + B=autonomous | capability | media-capture | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=deny + B=autonomous | command | read | deny | deny | deny | deny | deny | equal |
| legacy-both · A=deny + B=autonomous | command | local-write | deny | deny | deny | deny | deny | equal |
| legacy-both · A=deny + B=autonomous | command | external-write | deny | deny | deny | deny | deny | equal |
| legacy-both · A=deny + B=autonomous | command | destructive | deny | deny | deny | deny | deny | equal |
| legacy-both · A=deny + B=autonomous | command | financial | deny | deny | deny | deny | deny | equal |
| legacy-both · A=deny + B=autonomous | command | communication | deny | deny | deny | deny | deny | equal |
| legacy-both · A=deny + B=autonomous | command | media-capture | deny | deny | deny | deny | deny | equal |
| legacy-both · A=deny + B=autonomous | widget-action | read | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | widget-action | local-write | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | widget-action | external-write | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | widget-action | destructive | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | widget-action | financial | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | widget-action | communication | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | widget-action | media-capture | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | install | read | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | install | local-write | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | install | external-write | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | install | destructive | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | install | financial | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | install | communication | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | install | media-capture | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | capability | read | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | capability | local-write | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | capability | external-write | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | capability | destructive | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | capability | financial | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | capability | communication | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=deny + B=autonomous | capability | media-capture | execute | deny | deny | deny | deny | stricter |
| legacy-both · A=auto + B=ask | command | read | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=auto + B=ask | command | local-write | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=auto + B=ask | command | external-write | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=auto + B=ask | command | destructive | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=auto + B=ask | command | financial | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=auto + B=ask | command | communication | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=auto + B=ask | command | media-capture | execute | ask | ask | ask | ask | stricter |
| legacy-both · A=auto + B=ask | widget-action | read | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | widget-action | local-write | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | widget-action | external-write | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | widget-action | destructive | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | widget-action | financial | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | widget-action | communication | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | widget-action | media-capture | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | install | read | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | install | local-write | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | install | external-write | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | install | destructive | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | install | financial | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | install | communication | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | install | media-capture | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | capability | read | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | capability | local-write | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | capability | external-write | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | capability | destructive | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | capability | financial | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | capability | communication | ask | ask | ask | ask | ask | equal |
| legacy-both · A=auto + B=ask | capability | media-capture | ask | ask | ask | ask | ask | equal |

### Task 1.1–1.5, 1.7 — kết quả thực thi

**File tạo mới**

| File | Vai trò |
| --- | --- |
| `packages/core/src/execution-policy-migration.ts` | Đọc hai họ legacy, join pointwise, ghi policy chuẩn + audit lần migrate đầu. |
| `packages/core/test/execution-policy-migration.spec.ts` | 19 test: `deny` giữ nguyên, idempotent, cap 24 rule, write bị từ chối, projection round-trip. |
| `packages/core/test/execution-policy-parity.spec.ts` | 7 test: parity xuyên surface **và** legacy-vs-canonical (1120 tuple, in ra số case). |
| `apps/runtime/test/autonomy-settings.spec.ts` | 8 test cho lớp compatibility (projection `/autonomy` + hai preference key cũ). |

**File sửa**

| File | Thay đổi |
| --- | --- |
| `packages/contracts/src/preferences.ts` | `ExecutionPolicyConfig` + schema + `parseExecutionPolicyConfig` (field-wise, kể cả object lồng `guardrails`) + `DEFAULT_EXECUTION_POLICY_CONFIG` (mode `autonomous`) + registry key `execution.policy`. |
| `packages/contracts/src/execution.ts` | Đánh dấu legacy-only cho `DEFAULT_EXECUTION_POLICY`, `DEFAULT_AUTONOMY_SETTINGS`, `autonomySettingsSchema`. |
| `packages/core/src/execution-policy.ts` | `ExecutionQuestion.policy` thay `{mode, rules}`; `prohibition` đọc trên `hardBoundary`; thêm `guardrailCovers`; `readExecutionPolicy` thành canonical reader trỏ `execution.policy`. |
| `packages/core/src/widget-service.ts` | Call site `invokeMiniAppAction` nhận `ExecutionPolicyConfig`. |
| `packages/core/src/index.ts` | Export module migration. |
| `apps/runtime/src/node-tools.ts` | `autonomy: () => ExecutionPolicyConfig`; **đường command gọi `decideExecution`**; `policyForEffect` bị xoá; effect ledger ghi `policy.mode` thật thay vì literal `"autonomous"`. |
| `apps/runtime/src/autonomy-settings.ts` | Thành compatibility reader/writer: đọc = project canonical → 5 field cũ; ghi = dịch về canonical và **giữ rules mà shape cũ không có tên**. Thêm projection/dịch cho `execution.mode`/`execution.rules`. |
| `apps/runtime/src/gateway.ts` | `/autonomy` GET/POST đọc-ghi policy chuẩn (+ trả `policy`); `GET/PUT /preferences` chiếu hai key legacy từ policy chuẩn. |
| `apps/runtime/src/main.ts` | Chỉ wiring `autonomy` của command tool → `readExecutionPolicy` (xem mục "Scope" bên dưới). |
| `packages/storage/src/audit.ts` | Thêm một giá trị `AuditKind`: `"policy"` (xem mục "Scope"). |
| `packages/conversation-client/src/settings/ControlSettings.tsx` | Chỉ **copy/comment** cho trung thực: note 4 mode nói đúng semantics canonical, "Từ chối tất cả" hiện rõ, bỏ câu "Two policies is one more than this product wants". Không gộp cấu trúc (Task 1.6). |
| `apps/web/e2e/autonomy.spec.ts` | AC-0 mục 3: `[data-segment="guarded"]` → `[data-segment="auto"]` cho default, và bước restore cũng về `auto`. Assertion hành vi ở test 1 giữ nguyên. |
| test files | `execution-policy.spec.ts`, `command-policy.spec.ts`, `node-tools.spec.ts`, `activity-route.spec.ts` chuyển sang policy chuẩn; assertion hành vi giữ, vocabulary legacy bỏ. |

**Behavior change đã công bố (không phải refactor):** legacy `guarded` → canonical `guarded` ⇒ đường command mở approval card ở
`destructive` / `external-write` / `financial` / `communication` / `media-capture` (trước đây không bao giờ mở card). Canonical
default là `autonomous`; node chưa từng lưu họ nào chạy `autonomous` + guardrail bật.

**Kết quả verification (theo thứ tự bắt buộc)**

| # | Command | Kết quả thật |
| --- | --- | --- |
| 1 | `pnpm exec vitest run packages/core/test/execution-policy.spec.ts apps/runtime/test/command-policy.spec.ts apps/runtime/test/preflight.spec.ts` | **3 files / 72 tests passed** (baseline trước khi sửa: 3 files / 65 tests) |
| 1b | `pnpm exec vitest run` (8 file liên quan: execution-policy, migration, parity, command-policy, preflight, autonomy-settings, node-tools, activity-route) | **8 files / 126 tests passed** |
| 2 | `pnpm invariants` | `all 8 invariant checks passed` (385 TypeScript file quét transform-only syntax; 19 manifest entry OK) |
| 3 | `pnpm typecheck` | exit 0 (`tsc -p tsconfig.json && tsc -p tsconfig.web.json`) |
| 4 | `pnpm lint` | exit 0, 0 problem |
| 5 | `pnpm test` | **167 files passed / 1 skipped; 2047 tests passed / 7 skipped** |
| 6 | `pnpm verify` | Cả 4 stage xanh, chạy tới hết stage test với đúng số ở bước 5; output được pipe qua `tail` nên mã thoát tổng không được ghi lại, nhưng từng stage đã chạy riêng ở bước 2–5 và đều xanh |
| 7 | `pnpm test:e2e` (port 8876/4273 đã trống trước khi chạy) | **118 passed / 1 skipped** — gồm 2 test `autonomy.spec.ts` đã sửa |
| — | `pnpm verify:full` | Không chạy như một lệnh: `verify` và `test:e2e` đã chạy riêng và cùng xanh (steering của parent chặn chạy suite dài thêm) |

**Scope — hai file ngoài danh sách file của phase-01:**

| File | Thay đổi | Vì sao bắt buộc |
| --- | --- | --- |
| `packages/storage/src/audit.ts` | Thêm **một** giá trị vào union `AuditKind`: `"policy"` | Task 1.3 bước 4 yêu cầu ghi audit cho lần migrate đầu, và `appendAuditEvent` được type theo union đóng đó. Không có giá trị này thì bản ghi phải mượn kind sai (`command`/`interaction`) hoặc không ghi được. Thay đổi cộng thêm, không đổi giá trị cũ; `listAuditEvents` chỉ được test đọc, không có surface UI nào. |
| `apps/runtime/src/main.ts` | 2 dòng import + đổi producer của dep `autonomy` của command tool sang `readExecutionPolicy` | Đây là call site wiring của Task 1.4: `CommandToolDeps.autonomy` đã đổi type thành `ExecutionPolicyConfig`, nên producer phải là canonical reader. Không phải dọn dẹp không liên quan — nếu revert, build đỏ. |

**Trạng thái Task 1.6: SKIPPED** (được AC-9 cho phép). Không gộp hai section của Control tab thành một; chỉ sửa copy/comment cho trung thực.
Rủi ro còn lại được ghi nhận: hai control mode cùng ghi một policy (panel qua `/autonomy`, section dưới qua key `execution.mode` được dịch),
nên trong cùng một phiên mở Settings, save ở panel có thể ghi đè mode vừa đổi ở section kia. Đóng việc này là PR 1.6.

**Deviation đã ghi:** capability effect **không** được nối thêm vào resolver trong PR này. `preflightCapability()` hiện **không có call site
production** nào (chỉ preflight.spec.ts gọi), nên "nối cùng resolver" sẽ là tạo một đường effect mới chứ không phải hợp nhất. `guardrailCovers`
đã nhận `surface: "capability"` và parity spec phủ mapping guard class của capability, nên executor đầu tiên sẽ đọc cùng policy.

## Phase 2 — Pi projectRoots confinement

_Chưa thực hiện._

## Phase 3 — Install dependency lock

_Chưa thực hiện._

## Phase 4 — Runtime decomposition

_Chưa thực hiện._

## Phase 5 — Status source of truth

_Chưa thực hiện._

## Phase 6 — Internal real-path proofs

_Chưa thực hiện._

## Controller handoff — 2026-09-21, session context exhausted

Phase 1 implementation exists on branch `architecture-consolidation-unify-policy-confine` (uncommitted at the time this note was written, then committed as a WIP phase-1 commit). It is **not** PR-ready and **not merged**.

### Independently verified by the controller (not taken on the worker's word)

| Command | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm exec vitest run packages/core/test/execution-policy.spec.ts packages/core/test/execution-policy-migration.spec.ts packages/core/test/execution-policy-parity.spec.ts apps/runtime/test/command-policy.spec.ts apps/runtime/test/preflight.spec.ts apps/runtime/test/autonomy-settings.spec.ts` | 6 files, 106 tests passed |

### Reported by the implementation worker, NOT independently reproduced by the controller

| Command | Reported result |
| --- | --- |
| focused suite, wider selection (8 files, adds `node-tools.spec.ts`, `activity-route.spec.ts`) | 8 files, 126 tests passed (baseline before any change was 3 files / 65 tests) |
| full e2e (`pnpm test:e2e`) | 118 passed, 1 skipped |
| `apps/web/e2e/autonomy.spec.ts` | 2 passed |

### Open items that MUST be resolved before PR 1 is opened

1. **Two out-of-scope file edits need justification or revert.** `packages/storage/src/audit.ts` (2 lines) and `apps/runtime/src/main.ts` (13 lines) are not in phase-01's file list; `main.ts` is Phase 4's surface. The worker was asked to justify or revert both. Its report was not retrieved before the controller interrupted the run, so this is unresolved.
2. **`pnpm verify` and `pnpm verify:full` have not been run to completion by the controller.** Run them on the frozen tree before opening a PR.
3. ~~**AC-6 must be answered explicitly in the PR body.**~~ **RESOLVED by controller inspection, 2026-09-21.** The command path does call `decideExecution` (`apps/runtime/src/node-tools.ts`, 2 occurrences), and `policyForEffect` has been removed — the parity spec records that explicitly (`packages/core/test/execution-policy-parity.spec.ts:32`: *"`policyForEffect` is gone from the..."*). `decideGuardrailForCommand` is retained (defined at `:380`, called at `:693`) as the narrowing-only Jev judgment stage, which is the intended shape per AC-4: Jev is a stage inside the canonical policy, not a second authority. The PR body must still state this, but the answer is now known and it is the real unification.
4. **Task 1.6 (one settings surface)** — confirm whether it was done or skipped; skipping is acceptable per AC-9.
5. **Confirm the two prohibition tests exist** (prohibition produces neither execute nor ask absent a hard boundary; prohibition stands when a hard boundary is present) and that legacy-deny ledger rows show no execute/ask.
6. **PR body must state this does not close #93/#2/#3/#4/#5 and contain no `Closes`/`Fixes` keyword for them** (AC-7).
7. Merge must bind the reviewed SHA: `gh pr merge --merge --match-head-commit <sha>`, recording `<sha>` and the green run URL here.

### Why the controller stopped

The controller's session context was exhausted for a six-PR program after Phase 1. Continuing would have produced unreliable, unverified work. Phases 2-6 and program closeout are untouched. The goal is paused; run `/goal-resume` to continue from this handoff.

## Controller verification update — 2026-09-21 (post-commit `68eb4b5`)

### `pnpm verify` — PASSED by the controller

```
Test Files  167 passed | 1 skipped (168)
     Tests  2047 passed | 7 skipped (2054)
  Duration  29.89s
```

`pnpm typecheck` (inside verify) exit 0; `pnpm invariants` and `pnpm lint` both clean. This is the controller's own run on the frozen tree, not the worker's report.

### Out-of-scope edits — both RESOLVED as justified, not cleanup

1. **`packages/storage/src/audit.ts`** adds `"policy"` to `AuditKind`. Required, and not dead code: the migration writes an audit event with `kind: "policy"` at `packages/core/src/execution-policy-migration.ts:350`. A migration that changes a node's authority silently would be unauditable, so the kind is load-bearing.
2. **`apps/runtime/src/main.ts`** re-points the command tool's `autonomy` dependency from `readAutonomySettings(...)` to `readExecutionPolicy(...)` and drops the now-unused import. This is the AC-5 wiring site the phase-01 file list omitted: `node-tools` must receive the canonical policy, otherwise the resolver would be canonical while its only command caller still read the legacy row. Read at the proposal rather than at boot, so a mode change applies to the next command.

### Task 1.6 status

Not fully collapsed. `packages/conversation-client/src/settings/ControlSettings.tsx` no longer carries the "Two policies is one more than this product wants" note, and the legacy `execution.mode` / `autonomy-policy` references that remain are the compatibility readers the plan explicitly permits (`plan.md`: legacy keys stay readable so an un-updated client sees a policy rather than a blank panel). Reported as partial, not as done.

### Still open

`pnpm verify:full` (browser e2e) was run by the worker (118 passed, 1 skipped) but has not been reproduced by the controller on this exact commit. CI runs the e2e job on the PR, which will settle it.

## Phase 1 — MERGED

| Item | Value |
| --- | --- |
| PR | [#130](https://github.com/digitopvn/clarkcant/pull/130) |
| Merged at | 2026-09-22T04:46:19Z |
| Merge commit | `89be38df14906aedc69673a513d38e113f904211` |
| Reviewed head (bound via `--match-head-commit`) | `7f1d46492aa0874e5c2f0773add84db5badbea76` |
| Method | `gh pr merge --merge --match-head-commit` (explicit, because `main` is unprotected and `allow_auto_merge = false`) |
| CI on the reviewed head | all green — `verify` (node 22.19 and 24), `e2e` (4m21s / 5m3s), `desktop smoke`, `secret scan`, GitGuardian |
| Review | 1 CRITICAL + 5 IMPORTANT found and all fixed; re-review verdict "no actionable findings remain"; review posted to the PR |

Phase 1 acceptance criteria met: one canonical policy for command / widget / install / capability; modes stay Autonomous / Guarded / Ask every time; legacy `execution.*` and `autonomy` migrate without loosening a stricter setting; cross-surface and legacy-vs-canonical parity tests exist; host preflight and hard boundaries non-bypassable. Task 1.6 remains partial (the two-panel collapse is incomplete; legacy keys remain only as compatibility readers).

Three informational findings carried forward, non-blocking: `GET /preferences` now migrates on read and reports the execution keys as non-default on a virgin node; `declaresAnyAxis` parses `rules` all-or-nothing where `parseStoredRules` is entry-wise; one parity spec still calls `decideExecution` three times identically and cannot fail. Candidates for Phase 5's status/evidence work.

## Phase 2 — Pi projectRoots confinement

Branch: `phase-2-pi-confinement`, cut from `main` at `89be38d`.

### Pre-task 2.0 — spike A3 (in progress)

Question: does the installed Pi SDK honour `builtinTools: []`, i.e. can the raw filesystem built-ins (`read`, `grep`, `find`, `ls`) actually be turned off for a project session? The red-team marked this unverified, and Phase 2's approach and effort estimate both depend on the answer.

### Pre-task 2.0 — spike A3 RESULT (2026-09-22)

**ANSWER: YES.** The installed SDK (0.85.1) honours tool suppression. `tools` is a hard allowlist consulted when the tool *registry* is built, not a prompt hint, so a built-in omitted from it is absent from `session.agent.state.tools`.

**Type evidence** (`packages/pi-adapter/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts`): `:43 tools?: string[]` — *"When provided, only the listed tool names are enabled."*; `:33 noTools?: "all" | "builtin"`; `:45 excludeTools?: string[]`; `:47 customTools?: ToolDefinition[]`; `:71` exports `createReadTool`/`createGrepTool`/`createFindTool`/`createLsTool`.

**Implementation mechanism** (`dist/core/sdk.js:139-144`, `:253-267`; `dist/core/agent-session.js:2110`, `:2119-2127`, `:2149-2158`, `:2160-2180`, `:669`): built-ins enter the registry Map first and custom tools `set` over them by name; the allowlist filters both. The SDK's own CLI documents the same contract (`dist/cli/args.js:286-291`, example at `:369` is literally `--tools read,grep,find,ls`).

**Empirical probe** (SDK 0.85.1; scratch script deleted, no repository file touched):

| case | passed to `createAgentSession` | observed `state.tools` |
| --- | --- | --- |
| A | `tools: ["read","grep","find","ls"]` | same four |
| B | `tools: []` | `[]` |
| C | `tools: ["read"]` | `["read"]` |
| D | `tools: []` + custom `clarkcant_read` | `[]` — the custom tool is dropped too |
| E | `tools: ["clarkcant_read"]` + that custom tool | `["clarkcant_read"]` ← **the Phase 2 shape** |
| F | `tools: ["read"]` + custom tool named `read` | one entry named `read`, the custom one |
| G | `tools: ["grep"]` + custom `read` | `["grep"]` — custom dropped |
| H | `noTools: "builtin"` + custom | built-ins gone, 61 ambient extension tools active |
| I | `excludeTools: ["read","grep","find","ls"]` | `bash`,`edit`,`write` + 61 extension tools |

**Not empirical:** no live model turn was run (no provider credential here). Closed by source, not assumption: `agent-session.js:293-307` passes `state.tools` into the turn context and `setActiveToolsByName` is its only writer. Post-creation mutation was also probed: `setActiveToolsByName`, reassigning `agent.state.tools`, and `await session.reload()` all left case E at `["clarkcant_read"]`.

**Two caveats that must reach the implementer:**

1. The adapter option named `builtinTools` (`real.ts:130`) is not built-in-specific — it maps onto the SDK's `tools` allowlist, which gates extension and custom tools too. Case D is the trap: `builtinTools: []` on its own kills the custom tools as well, and only the concatenation at `real.ts:426` (`[...builtinTools, ...customTools.map((tool) => tool.name)]`) saves them. That line is load-bearing and must not be "simplified" away.
2. The allowlist is what keeps the SDK's other escape hatches shut: the SDK exports `createReadTool` and friends (`sdk.d.ts:71`), and the adapter's `registerTool` (`real.ts:470-480`) appends to `agent.state.tools` without consulting the allowlist, while `setActiveTools` (`real.ts:464-467`) keeps registered names unconditionally. Those paths must stay off the project-worker route, or confinement is only as good as the call site.

**Shadowing fallback is available but not needed:** a custom tool does shadow a built-in name (case F), but it must also be allowlisted (case G). Phase 2's own tool names are the cleaner route and case E confirms they work.

**Consequence:** the "1.5-2 ngày" estimate holds; phase-02 needs no re-plan.

### Phase 2 — implementation evidence

| Item | Value |
| --- | --- |
| Branch | `phase-2-pi-confinement` (cut from `main` at `89be38d`) |
| Implementation commit | `1ba5cc2f50cf29cd565d71383ec43d2eda1430de` |
| `pnpm verify` | PASSED — `Test Files 180 passed \| 1 skipped (181)`, `Tests 2192 passed \| 7 skipped (2199)` |
| `packages/pi-adapter/test/scoped-fs.spec.ts` | 19 tests passed on real temporary directories |
| `apps/runtime/test/project-session.confinement.spec.ts` | 4 tests passed (inside read succeeds, sibling read refused) |
| Confinement note | The adapter's disclaiming `TODO(P2)` is gone, replaced by a statement these tests make true |
| Multiple roots | `projectRoots[0]`-only use removed from `apps/runtime/src/project-session.ts` |

Note on how this was produced: the first Phase 2 worker died mid-run (async runner process exited before writing a result) after producing the implementation but before verifying or committing it. The verification above and the commit were done by the controller on that recovered work, and the two gate answers it could not report — TODO removal and multiple-root support — were confirmed by inspection.

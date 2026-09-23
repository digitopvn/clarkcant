# Hostile review — Widget Library / Widget Lab plan (assumption destroyer + scope auditor)

Lens: ASSUMPTION DESTROYER (skeptic) with SCOPE AUDITOR verification role.
Snapshot reviewed (the plan directory was being edited during the review; these are the hashes of the
revision every citation below was checked against):

```text
01a210f1415d94bed961862bc7475f4fc03366155a15494b986ced277091ce01  phase-01-canonical-catalog.md
76e93489f723d81e1edb38fb3b81a5e905208f7fe46bb12c410af583ff3bd2c4  phase-02-browse-surface.md
f06a8cf9d8e6b6926ff481db43e0f9992290ae4b24341d84e227a3d6c8127dc8  phase-03-widget-lab.md
416459c343a3ee9a6b1091a631b50fd1ed545b5d9f21ad7897bcc0968d512f6b  phase-04-app-intents.md
fea99e0f78a8a378c122005720e82a31f89a6905b7dc60ddbc87da524a813c55  phase-05-devhost-and-provenance.md
626773fd83ec6252e0b4a6361771f3f849f8d206b4f00b626caf266b32290830  phase-06-verify-ship.md
d0bc36ff39082927c1f11409e8350a3d5284bca2b362cfea6ac5fdcff51577f7  plan.md
```

Findings: 10. Severity: 1 Critical, 4 High, 5 Medium.

---

## Finding 1: `@clarkcant/widget-catalog/preview` has no resolvable path in any of the four registration points the plan names

- Severity: Critical
- Location: Phase 1, "Thực hiện" steps 3 and 8; Phase 3, "Quyết định thiết kế" and step 1; Phase 5, "Quyết định thiết kế" bullet 1 and step 2; `plan.md` §"Kiểm chứng plan" ("Đăng ký package mới cần **bốn** chỗ").
- Flaw: Phase 1 step 3 (`phase-01-canonical-catalog.md:74`) declares the new package's `exports` as `src/index.ts` only. Phase 3 (`phase-03-widget-lab.md:7`, `:48`) and Phase 5 (`phase-05-devhost-and-provenance.md:13`, `:28`) then import the **subpath** `@clarkcant/widget-catalog/preview` — from `conversation-client` (browser/tsc/vitest) and from `widget-cli/src/dev-shell.ts` (Node). A subpath only resolves if it is declared in the `exports` map; the repo's precedent shows exactly that (`packs/data-canvas/package.json:10-13` declares `"./sample"` because the runtime imports it). Phase 1 step 8 adds only the **bare** name to `tsconfig.json`/`tsconfig.web.json`/`vitest.config.ts`, and `plan.md`'s "four places" list does not include the `exports` subpath at all. Worse, the vitest instruction is actively harmful: the alias table is prefix-matched, and the file says so in its own comment (`vitest.config.ts:36-44`: "the prefix aliases below rewrite everything that *starts with* a package name, so `@clarkcant/widget-host/session` would become a path under the barrel that does not exist") — so adding `"@clarkcant/widget-catalog": "packages/widget-catalog/src/index.ts"` rewrites the `preview` import to `packages/widget-catalog/src/index.ts/preview`.
- Failure scenario: the implementer follows phase 1 verbatim, then phase 3's first line of code fails to resolve. `pnpm run typecheck` (phase 3 "Kiểm chứng") and `pnpm exec vitest run packages/conversation-client/test` cannot exit 0, and phase 5's own manual check `node packages/widget-cli/src/cli.ts dev …` (`phase-05:38`) dies with `ERR_PACKAGE_PATH_NOT_EXPORTED`. If the implementer instead "fixes" it by importing the barrel, the subpath never gets declared, and the repo's own browser-node-builtin gate stops covering that edge silently: `tools/check-invariants.mjs:349` resolves a workspace specifier through `manifest.exports[subpath]`, and `tools/check-invariants.mjs:365` skips the module when that lookup returns `undefined` — so a `node:` import reachable only through the undeclared subpath would be invisible to the gate the plan is relying on.
- Evidence: `plans/…/phase-01-canonical-catalog.md:74`, `:79`; `plans/…/phase-03-widget-lab.md:7`, `:48`; `plans/…/phase-05-devhost-and-provenance.md:13`, `:28`; `packs/data-canvas/package.json:10-13`; `vitest.config.ts:36-44`; `tools/check-invariants.mjs:337-350`, `:365`; `tsconfig.web.json:19-32` (paths block, bare names only).
- Suggested fix: declare `"./preview": "./src/preview.ts"` (and any other subpath) in `packages/widget-catalog/package.json` in phase 1 step 3, and change step 8 to use **exact-match regex** aliases for every subpath (the pattern already used for `@clarkcant/data-canvas` and `@clarkcant/widget-host/session` in `vitest.config.ts:36-40`) plus matching `paths` entries in `tsconfig.json`/`tsconfig.web.json`. Add an invariant/test that every `@clarkcant/widget-catalog/*` specifier used anywhere resolves through the `exports` map.

---

## Finding 2: Phase 4 injects `widgetTargets` through a seam that lives in a file the phase does not own, and the request/audit contracts cannot carry the target

- Severity: High
- Location: Phase 4, "Sở hữu file" (`phase-04-app-intents.md:9`), "Quyết định thiết kế" bullet 2 (`:18-26`), "Thực hiện" step 5 (`:56`), "Rủi ro" bullet 1.
- Flaw: The phase now specifies the matcher signatures correctly (`:22-23`) and says `apps/runtime/src/main.ts`'s `appIntentDepsFor` builds `widgetTargets`. But `appIntentDepsFor` returns `AppIntentDeps`, and that interface is **declared in `apps/runtime/src/app-intents.ts:48-53`**, not in `main.ts`; the only node-side caller of `resolveAppIntent` is `decideAppIntent` in the same file (`apps/runtime/src/app-intents.ts:168-190`, call at `:174`), which receives no `widgetTargets` and forwards nothing. `apps/runtime/src/app-intents.ts` is absent from the phase's owned-file list, which lists `main.ts` "(chỉ `appIntentDepsFor`)" — so the change the plan describes cannot be made inside the ownership boundary it declares. The phase's risk bullet ("kiểm tra `apps/runtime/src/app-intents.ts` và `gateway.ts` sau khi mở rộng") asks for a check, not an edit.
- Failure scenario: the implementer adds `widgetTargets` to `appIntentDepsFor`'s return object; `tsc` rejects the excess property against `AppIntentDeps`, and the honest fix requires editing a file the plan told them not to touch. The cheaper wrong fix is to widen `appIntentDepsFor`'s return type locally or cast — and then the matcher never sees targets on the node path, so `"hiện widget lịch"` (phase 4 test 2) and E2E journey 6 degrade to "open the library in browse mode" while every unit test in `packages/core/test` stays green because it calls the matcher directly with targets.
- Evidence: `apps/runtime/src/app-intents.ts:48-53`, `:168-190`; `apps/runtime/src/main.ts:109-116`; `packages/core/src/app-intents.ts:299`, `:337-346`; `plans/…/phase-04-app-intents.md:9`, `:56`.
- Suggested fix: add `apps/runtime/src/app-intents.ts` to phase 4's owned files and to the "Thực hiện" steps (extend `AppIntentDeps` with `widgetTargets` and pass it from `decideAppIntent` into `resolveAppIntent`), or move the injection to a parameter of `decideAppIntent` and update `main.ts:1714-1721` accordingly. Also note the second, unaddressed consequence: `appIntentRequestSchema` is a `strictObject` of `text|kind|tab|conversationId|source` (`packages/contracts/src/app-intents.ts:201-215`) and `appIntentEventDocumentSchema` records only `kind|tab|source|confirmed` (`:223-228`), so a click-sourced target cannot be carried and the audit row can never answer *which* widget was shown — neither contract change appears in the phase's test matrix.

---

## Finding 3: the new mandatory fixture invariant is justified by a line that does not implement it, and the real trigger of the failure it claims to prevent is untested

- Severity: High
- Location: Phase 1, "Bất biến bắt buộc" bullet 2 (`phase-01-canonical-catalog.md:23`), "Ma trận test" item 2 (`:58`); `plan.md` Red Team Finding 2 (accepted).
- Flaw: The plan makes it mandatory that `props.datasetRef === fixture.dataset.datasetId` and states the consequence: "nếu không preview sẽ rơi vào nhánh `Unavailable` (`packages/conversation-client/src/renderers.tsx:147`)". The cited line is the `Unavailable` branch of `LineChart`, and its condition is `if (!dataset || dataset.rows.length === 0)` (`renderers.tsx:145-152`) — the same shape in `BarChart` (`:203-208`), `Donut`, `DataTable` (`:265`), `Metrics` (`:409`), `Filter` (`:531`) and `Calendar`, where the condition is `cells.length === 0` (`:625-630`). **No renderer reads `props.datasetRef` at all** (grep for `datasetRef` in `renderers.tsx` returns zero matches), and `RendererDataset` carries no `datasetId` (`renderers.tsx:33-37`), so nothing downstream can verify the binding even if it were set. In production the ref is resolved by the host (`Conversation.tsx:1581-1582`, `datasets[datasetRef]`), but the Lab path passes `dataset` straight from the fixture (phase-02 step 2), which makes the binding decorative in exactly the surface the rule is written for.
- Failure scenario: a fixture with `props.datasetRef === fixture.dataset.datasetId` and `rows: []` — or a chart whose `series` names a column that does not exist — still renders `data-widget-unavailable`, so E2E journey 3's "assert không có `data-widget-unavailable`" fails for a reason the plan's rule cannot prevent. Meanwhile the negative test demanded in `:58` ("một fixture cố ý lệch `datasetRef` phải bị validator bắt") only tests the plan's own new validator, i.e. a rule with no product meaning: the test passes whether or not previews actually render.
- Evidence: `packages/conversation-client/src/renderers.tsx:33-37`, `:145-152`, `:203-208`, `:265`, `:625-630`; `packages/conversation-client/src/Conversation.tsx:1581-1582`; `plans/…/phase-01-canonical-catalog.md:23`, `:58`; `plans/…/plan.md` Red Team Finding 2.
- Suggested fix: state the invariant that is actually load-bearing — every library-visible dataset-backed fixture must supply a non-empty `dataset.rows` whose columns satisfy the renderer's selection rule, and `props.datasetRef` is only a label for the preview chrome. Keep the binding rule as a consistency check, but re-justify it (or drop the claim about `Unavailable`) and add a fixture test that a `normal` fixture produces a renderer that does **not** emit `data-widget-unavailable`.

---

## Finding 4: `clark widget dev --builtin …` cannot run — the CLI turns the flag value into the package directory, and the dev host's fixture vocabulary is not the Lab's

- Severity: High
- Location: Phase 5, "Quyết định thiết kế" bullet 2 (`phase-05-devhost-and-provenance.md:14`), "Thực hiện" step 3, "Kiểm chứng" line 3 (`:38`).
- Flaw: `runCli` derives the package directory as the first argument that is not a flag (`packages/widget-cli/src/cli.ts:407`: `const dir = rest.find((arg) => !arg.startsWith("--")) ?? process.cwd()`), so `dev --builtin canvas.table@1 --fixture empty` sets `dir = "canvas.table@1"` and `startDevHost` calls `readPackage("canvas.table@1")` (`dev-host.ts:171`). Beyond the parsing, the dev host is a package-facet host: it requires a widget facet (`dev-host.ts:172-175`), reads its fixture **names** from the package's `fixtures/` directory (`dev-host.ts:177`), and rejects any fixture name not in that list (`dev-shell.ts:74-76`). Catalog fixtures are a different object shape (phase 1's `WidgetFixture`: id/label/props/state/dataset/mode) and built-in catalog definitions have no HTML facet entry at all, so "author thấy cùng bộ fixture như trong Lab" is not achievable by pointing the existing host at the catalog: it needs a catalog→dev-host adapter and a catalog renderer inside the dev-shell page, neither of which the plan specifies. The plan also never mentions `WIDGET_COMMANDS` (`cli.ts:44-50`), the single list that both the dispatch gate and the help text read — the new flags cannot appear in the help without editing it.
- Failure scenario: the phase's own verification command fails at `readPackage`, and even after hand-rolling a fixture directory the dev host serves the package HTML in the sandboxed frame (`dev-host.ts` iframe with `allow-same-origin` deliberately absent) while the Lab renders React renderers — so "hội tụ" is asserted by a test that compares nothing (`phase-05:21` item 2 only compares viewport/theme/reduced-motion reducer results, which is a different claim than fixture convergence).
- Evidence: `packages/widget-cli/src/cli.ts:407`, `:44-50`; `packages/widget-cli/src/dev-host.ts:171-177`, `:203`; `packages/widget-cli/src/dev-shell.ts:44-56`, `:74-76`; `plans/…/phase-05-devhost-and-provenance.md:14`, `:21`, `:38`.
- Suggested fix: either drop `--builtin` from phase 5 and state that convergence is limited to the preview reducer (viewport/theme/reduced-motion) plus a shared fixture *schema*, or specify the adapter explicitly: how `--builtin` bypasses `readPackage`, where the fixture JSON is served from, which HTML entry a catalog definition uses, and how `WIDGET_COMMANDS`' usage line is updated. Also fix the flag parser so flag values are not treated as positional arguments.

---

## Finding 5: the fixture contract cannot express the states the repository's own widget standard requires, and it invents a "state" that is a viewport

- Severity: High
- Location: Phase 1, "Hợp đồng dữ liệu" (`WidgetFixture`) and "Ma trận test" item 2 (`phase-01-canonical-catalog.md:58`).
- Flaw: `WidgetFixture.dataset.source` is typed `"sample" | "cached"`, but the value the renderer actually consumes is `RendererDataset.freshness: "live" | "cached" | "sample" | "unknown"` (`renderers.tsx:33-37`), and the widget standard requires fixtures for a longer, different list: `loading; empty; live; cached; offline; partial/unavailable; error; read-only snapshot; action pending; action refused/failed; compact; expanded` (`docs/widget-development.md:165-176`). The plan's required coverage set is `normal/empty/loading/unavailable/error/read-only/narrow` (`:58`) — it drops `live`, `cached`, `offline`, `partial`, `action pending`, `action refused` and `compact/expanded`, and adds `narrow`, which is a viewport in phase 3's `PREVIEW_WIDTHS`, not a data state. Two of the four freshness badges the renderer can display (`dữ liệu vừa đọc`, `chưa rõ độ mới`, `renderers.tsx:70-75`) therefore cannot be produced by any fixture the contract allows.
- Failure scenario: phase 1's coverage test asserts coverage "khi definition hỗ trợ" against a taxonomy the product's standard does not use, so the Lab ships unable to show a `live` or `unknown` freshness state while `docs/widget-development.md` continues to require them — the exact code/docs divergence the phase claims to end. A `cached` fixture asserting freshness also cannot be distinguished from `sample` in the inspector, because the contract has no field for the "sampled" versus "stored" distinction the renderer chrome is built around.
- Evidence: `plans/…/phase-01-canonical-catalog.md` (WidgetFixture block, `:58`); `packages/conversation-client/src/renderers.tsx:33-37`, `:70-75`; `docs/widget-development.md:165-176`; `packages/widget-cli/src/cli.ts:135-139` (the shipped scaffold writes `default/empty/error/compact`).
- Suggested fix: type `dataset.source` as the same union as `RendererDataset.freshness` (or reference it), map each required state in `docs/widget-development.md:165-176` to a named fixture id, and remove `narrow` from the data-state list — viewport coverage belongs to the Lab's viewport control and to the E2E, not to a fixture.

---

## Finding 6: Phase 4 silently widens the app-intent parameter space and introduces a second, looser definition-id pattern next to the canonical one

- Severity: Medium
- Location: Phase 4, "Quyết định thiết kế" bullet 3 (`phase-04-app-intents.md:27`), "Thực hiện" step 1.
- Flaw: `packages/contracts/src/app-intents.ts:24-29` states the design invariant in prose: "Every kind below is a fixed capability of the shell itself, and the parameter space is one enumerated tab. That is deliberate: this is the vocabulary of a control channel, not a scripting surface, and nothing here can be widened from the outside by putting more words into a sentence." Phase 4 adds a free-form `definitionId` that is populated from a spoken/typed sentence and flows into the UI, and validates it with `^[a-z][a-z0-9.-]*@\d+$` — a **second** pattern for the same concept, looser than the canonical one already in the repo: `capabilityRefSchema` uses `^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+@\d+$` (`packages/contracts/src/grants.ts:50-56`, whose error message is "must look like namespace.name@1"). The plan never reconciles the two or explains why the invariant no longer holds.
- Failure scenario: an id such as `a..b@1` or `a.@1` satisfies the plan's pattern and fails the canonical one; the contract's own docstring now describes something that is no longer true, and a future reader changing one pattern has no way to know the other exists. If a `widgetTargets` phrase is later reused for a capability ref (both are `namespace.name@major`), the two vocabularies drift with no gate.
- Evidence: `packages/contracts/src/app-intents.ts:24-29`, `:52-58`; `packages/contracts/src/grants.ts:50-56`; `plans/…/phase-04-app-intents.md:27`.
- Suggested fix: reuse `capabilityRefSchema` (or export a `widgetDefinitionRefSchema` derived from it) instead of a new regex, and update the contract's docstring in the same change to say what the parameter space now is and why a widget target is not "scripting".

---

## Finding 7: "exact-pinned dependency" for workspace packages contradicts every manifest in the repo, and the invariant gate would not notice

- Severity: Medium
- Location: Phase 1, "Thực hiện" step 3 (`phase-01-canonical-catalog.md:74`); Phase 1 "Kiểm chứng" (`pnpm run invariants exit 0`); `plan.md` §"Kiểm chứng plan".
- Flaw: Step 3 requires "exact-pinned dependency `@clarkcant/contracts` và `@clarkcant/data-canvas`". Every workspace manifest in this repo uses `workspace:*` (`packs/data-canvas/package.json:19-23`, `packages/widget-cli/package.json:22-27`), and the lockfile records that as a link (`pnpm-lock.yaml:537-547`: `specifier: workspace:*` → `version: link:../../packages/contracts`). `pnpm-workspace.yaml` sets `saveExact: true` (`:52`) and declares no `linkWorkspacePackages`, and `.npmrc` explicitly holds only registry settings, so a literal `"0.2.0"` spec for a `private: true` package must be resolved from the registry. The gate the plan leans on only rejects `latest`, `*` and git/url specs (`tools/check-invariants.mjs:214-243`), so an exact pin passes `pnpm run invariants` while being unresolvable.
- Failure scenario: the implementer follows the instruction literally, `pnpm install` (or CI's install) fails to resolve `@clarkcant/contracts@0.2.0`, and phase 1's stated verification — which does not include an install — reports green. The mistake surfaces later, as a CI failure attributed to something else.
- Evidence: `plans/…/phase-01-canonical-catalog.md:74`, `:87`; `packs/data-canvas/package.json:19-23`; `packages/widget-cli/package.json:22-27`; `pnpm-lock.yaml:537-547`; `pnpm-workspace.yaml:52`; `tools/check-invariants.mjs:214-243`.
- Suggested fix: change the wording to `workspace:*` (matching every other manifest) and add `pnpm install --frozen-lockfile` to phase 1's verification so a bad specifier fails where it is introduced.

---

## Finding 8: Phase 5 puts the new dependency in the wrong package, and the new browser-safety test is a weaker substitute for the gate that already exists

- Severity: Medium
- Location: Phase 5, "Thực hiện" step 4 (`phase-05-devhost-and-provenance.md:30`); Phase 1, "Thực hiện" step 10 (`phase-01-canonical-catalog.md:81`).
- Flaw: Step 4 reads "`packages/widget-catalog/package.json`: thêm dependency cho widget-cli; cập nhật `packages/widget-cli/package.json`" — the dependency is to be added to **widget-catalog**, which makes `widget-catalog ↔ widget-cli` a cycle while the phase's own direction of use is `widget-cli → widget-catalog` (step 2/3: dev-shell and cli read fixtures from the catalog). That cycle matters because widget-cli's entry is Node-only at its first four lines (`packages/widget-cli/src/cli.ts:1-4`: `node:crypto`, `node:fs`, `node:path`, `node:url`), and widget-catalog is on the browser graph via `conversation-client`. Separately, phase 1 step 10's new `browser-safety.spec.ts` is a source scan of three directories, whereas the repo already walks the real module graph from `apps/web/src/main.tsx` and `apps/web/src/widget-runtime.ts` through each package's `exports` map and fails on any reachable `node:` import (`tools/check-invariants.mjs:307-377`). A source scan cannot see a transitive `node:` import reached through a barrel the scanned file does not mention.
- Failure scenario: a later import of anything from `@clarkcant/widget-cli` inside widget-catalog (e.g. reusing a helper) drags `node:crypto` into the browser graph. The new `browser-safety.spec.ts` stays green because it only reads files under three directories; the failure appears as a broken `pnpm dev:web`, which is precisely the failure mode the existing gate's comment (`tools/check-invariants.mjs:300-306`) says was already suffered once.
- Evidence: `plans/…/phase-05-devhost-and-provenance.md:30`, `:28`; `plans/…/phase-01-canonical-catalog.md:81`; `packages/widget-cli/src/cli.ts:1-4`; `tools/check-invariants.mjs:307-377`.
- Suggested fix: state the edge once and in the right direction (`packages/widget-cli/package.json` depends on `@clarkcant/widget-catalog`; nothing in widget-catalog depends on widget-cli), and either delete `browser-safety.spec.ts` in favour of extending the existing graph walk or state explicitly that it is a secondary check whose scope is source-level.

---

## Finding 9: Phase 2's `missingRenderer` test cannot be written against the state contract Phase 2 declares

- Severity: Medium
- Location: Phase 2, "Quyết định thiết kế" bullet 1 (`phase-02-browse-surface.md:13`) vs "Ma trận test" item 6 (`:27`).
- Flaw: The surface state is declared as `{ open, mode, query, family, selectedId }` with `applyLibraryAction` as the only transition, and the component is described as the only place that reads the renderer registry (design bullet 3 renders the `data-widget-preview-missing` block). Test 6 then asserts "state đánh dấu `missingRenderer`" — a field the declared state does not have — and says the case is produced "bằng mock catalog", although the only resolver is the module-level `resolveRenderer` imported from `renderers.tsx` (`packages/conversation-client/src/renderers.tsx:952`, `CATALOG` at `:935`), with no injection seam in the reducer or in `visibleEntries(entries, state)`.
- Failure scenario: the implementer either adds a state field the design never mentions (and then the "open/close returns exactly the initial state" invariant in test 5 has one more field to keep clean for no reason), or writes test 6 against a fabricated id that happens to be absent from `CATALOG`, which proves nothing about the mock-catalog path the plan describes. Either way the test name promises a behavior the plan has not designed.
- Evidence: `plans/…/phase-02-browse-surface.md:13`, `:27`, `:33`; `packages/conversation-client/src/renderers.tsx:935`, `:952`.
- Suggested fix: decide where the missing-renderer fact lives — either a field on the surface state (and then say so in the state contract and in test 5's invariant) or a render-time check in `WidgetPreview` (and then retitle test 6 to assert the rendered `data-widget-preview-missing` attribute for an id absent from `CATALOG`).

---

## Finding 10: the "lifecycle invariant" test proves nothing about the state it names

- Severity: Medium
- Location: Phase 2, "Ma trận test" item 5 (`phase-02-browse-surface.md:26`), "Kiểm chứng" (`:52`).
- Flaw: The test is "gọi reducer mở rồi đóng trả lại **đúng** state ban đầu (so sánh sâu), chứng minh không có field nào của hội thoại bị chạm". The reducer owns five fields (`:13`); the state the plan's constraint 2 and this sentence are about — conversation, composer, pinned widgets, live-effect ownership, media, voice, model/session config — lives in `Conversation.tsx` as dozens of `useState` hooks (`Conversation.tsx:195-382`), entirely outside the reducer. A deep-equality assertion on the library state cannot observe any of them, and the plan's own constraint 2 is the acceptance criterion this test is cited against.
- Failure scenario: the real failure mode (a remount of the conversation subtree, or a reset of `timeline`/`datasets`/`live`) passes this test. The only evidence that actually covers it is E2E journey 2 in phase 6 ("Hội thoại vẫn mounted"), which the plan lists as a *later* phase — so phase 2 reports "lifecycle proven" on evidence that cannot fail for the right reason.
- Evidence: `plans/…/phase-02-browse-surface.md:13`, `:26`, `:52`; `packages/conversation-client/src/Conversation.tsx:195-382`, `:2206-2215` (the sibling mount point).
- Suggested fix: keep the reducer test as a state-machine unit test but stop describing it as proof about the conversation, and make phase 2's verification name the E2E journey (or a render-tree assertion that the conversation subtree's key/identity is unchanged) as the evidence for constraint 2.

---

## Overlap note (verified, not re-filed)

Two sibling reports on this same plan (`plans/reports/code-review-260921-1518-widget-library-plan-hostile-review.md`,
`…-redteam.md`) already filed the Escape/two-dialog collision and the noun-table defect. I verified both
independently and they still hold at the revision hashed above, so I did not spend finding slots on them:

- Escape: `Modal.tsx:45-46` closes unconditionally and `Modal.tsx:77` registers the listener on `document`, so a
  sibling library surface cannot stop it; `SettingsPanel.tsx:189` returns `null` when closed, which unmounts the
  opener button the same Escape press destroys, making phase 6 journey 5's "focus trở về nút đã mở" unachievable.
- Noun table: `matchAppIntent("hiện widget lịch")`, `matchAppIntent("show the calendar widget")` and
  `matchAppIntent("hiện widget media")` all return `undefined` today (executed against
  `packages/core/src/app-intents.ts`), and the four `APP_NOUNS` additions listed in
  `phase-04-app-intents.md:53` match none of those sentences under the whole-word rule at
  `packages/core/src/app-intents.ts:267` (verified by replaying `containsPhrase` with the plan's noun list:
  zero matches for all three).

Unresolved questions: (1) which of phase 1's four registration points is authoritative if the package ends up
needing subpaths — `exports` or the path aliases; (2) whether phase 5 is in scope at all if the dev-host
convergence cannot be delivered without a catalog→package adapter; (3) whether `apps/runtime/src/app-intents.ts`
may be edited, since phase 4's seam does not exist without it.

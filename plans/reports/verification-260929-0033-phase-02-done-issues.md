# Verification: six "done" issues against origin/main

- Date: 2026-09-29 (Asia/Saigon). Host: Windows 11, Git Bash / PowerShell, pnpm via corepack.
- Tree: detached `origin/main` at `76e6ce8` in worktree `.claude/worktrees/agent-a8bf089cc8d523caa`.
  Setup ran `corepack pnpm install --frozen-lockfile`, which passed.
- Scope: #173, #174, #169, #171, #93, #129.
- Nothing was pushed, and no issue or PR was commented on, edited or closed.
- Issue text was read as data only.

## Summary

| Issue | Verdict | One line |
|---|---|---|
| #173 | **CLOSABLE** | A denial now leaves a structured `decide_approval` record, and the card shows "đã từ chối" with no buttons. Unit and e2e tests pass. |
| #174 | **CLOSABLE** | "mở hộp thư email của tôi" falls through to the agent, "mở hộp thư" gives `inbox.open`, and the attach phrases still match. |
| #169 | **CLOSABLE** (with documented limitations) | The producer, dedup, offline quietness and risk-lane labels are all tested, and there is no fake Update button. Limitations are listed below. |
| #171 | **CLOSABLE** | All acceptance criteria are met. The desktop click-to-inbox path was proven in a real Electron shell by a local, uncommitted spec. Only the pixel click on the OS toast is not automatable. |
| #93 | **GAPS** | The P0 items and the capability-authority items landed. CSP origin validation, the one-init regression test and explicit, validated `CC_APP_ORIGIN` configuration are missing. |
| #129 | **GAPS** | The contract, tool, transport, refusal and quit gate landed. Missing: audit distinction between voice agent and spoken user, alias/note update after an agent model switch, an async/ack executor, a no-replay test, and e2e beyond `nav.home`. |

## Test runs (exact commands, all from the worktree root)

1. Vitest, focused suites (35 files):
   - Command:
     ```
     corepack pnpm exec vitest run apps/runtime/test/api.spec.ts packages/core/test/app-intents.spec.ts apps/runtime/test/update-checks.spec.ts apps/runtime/test/inbox.spec.ts packages/conversation-client/test/inbox-model.spec.ts packages/conversation-client/test/inbox-notify-decide.spec.ts packages/conversation-client/test/desktop-notify-status.spec.ts packages/contracts/test/preferences.spec.ts packages/core/test/preference-registry.spec.ts apps/runtime/test/preference-routes.spec.ts apps/desktop/test packages/core/test/package-files.spec.ts apps/runtime/test/package-files-route.spec.ts packages/core/test/install-consent.spec.ts packages/core/test/widget-frame.spec.ts packages/core/test/widget-document.spec.ts packages/core/test/frame-grant.spec.ts apps/runtime/test/package-install-route.spec.ts apps/runtime/test/package-install-local-chain.spec.ts apps/runtime/test/installed-widgets-route.spec.ts packages/widget-host/test packages/widget-sdk/test apps/runtime/test/app-intents.spec.ts apps/runtime/test/control-app-tool.spec.ts packages/contracts/test/app-intents-agent-control.spec.ts packages/conversation-client/test/app-intents-agent-control.spec.ts packages/conversation-client/test/app-intents.spec.ts apps/runtime/test/voice-gateway.spec.ts apps/runtime/test/voice-live.spec.ts apps/runtime/test/stop-and-audit.spec.ts apps/runtime/test/turn-control.spec.ts
     ```
   - Result: **PASS**. Test Files 35 passed (35); Tests 529 passed (529).
2. Playwright, browser suite subset (10 spec files, 39 tests):
   - Command:
     ```
     corepack pnpm exec playwright test approval.spec.ts widget-frame.spec.ts inbox-notifications.spec.ts inbox.spec.ts voice-agent-control.spec.ts voice-control.spec.ts model-pool.spec.ts desktop-window-controls.spec.ts package-install.spec.ts installed-packages.spec.ts
     ```
   - Result: **PASS**. 39 passed (1.8m).
3. Playwright plus a real Electron shell, #171 click path. This spec is local and **uncommitted**: `apps/web/e2e/desktop-notification-click.spec.ts`.
   - Command:
     ```
     corepack pnpm exec playwright test apps/web/e2e/desktop-notification-click.spec.ts --reporter=line
     ```
   - Result: **PASS**. 1 passed (24.8s). Before the argv fix described under #171, it failed with `electron.launch: Process failed to launch!`.
4. CSP probe for #93. The script is local and gitignored: `.data/probe-csp.ts`.
   - Command:
     ```
     node .data/probe-csp.ts
     ```
   - Result: it **reproduces the gap**. See the #93 section.
5. Full repository check:
   - Command:
     ```
     corepack pnpm verify
     ```
     This runs invariants, typecheck, lint and test.
   - Result: **PASS** (exit 0). All invariants passed. Test Files 250 passed | 1 skipped (251); Tests 2965 passed | 31 skipped (2996). The skips are pre-existing platform-conditional cases, such as `terminal-sessions.spec.ts` and `portable-runtime.spec.ts` on Windows.

---

## #173: Approval card keeps offering Approve/Deny after the command was denied

**Verdict: CLOSABLE**

Landed in PR #176. The key commit is `bf30c82` ("fix(runtime): a denied approval leaves a record the card can read").

| Criterion | Evidence | Test command | Result |
|---|---|---|---|
| A denial carries `approvalId` in a structured way, with no string matching | `apps/runtime/src/routes/conversations.ts` ~909 and 1392–1411 emit a `tool-activity` `decide_approval` block with `args: {approvalId, decision: "denied"}`. `packages/conversation-client/src/use-block-actions.ts:101-113`: `decidedApprovals` reads both the `run_command` receipt and the `decide_approval` record. | Run 1: `apps/runtime/test/api.spec.ts` › "records a refusal, and nothing runs" (lines 722–739, asserts `refusal.args` equals `{approvalId, decision:"denied"}`) | PASS |
| E2E "refusing runs nothing and says so" also asserts that the card has no buttons after a denial | `apps/web/e2e/approval.spec.ts:89-91`: `[data-approve]` and `[data-deny]` have count 0 | Run 2: `approval.spec.ts:76` | PASS |
| The card shows the "đã từ chối" outcome | `packages/conversation-client/src/blocks.tsx` ~436, 762, 812 render `data-approval-decision`. `approval.spec.ts:92` asserts `[data-approval-decision="denied"]` has text "đã từ chối". | Run 2 | PASS |

**Closing comment draft**

> Verified on `main` @ 76e6ce8. A denial now leaves a structured `decide_approval` record carrying `{approvalId, decision: "denied"}` (bf30c82, PR #176). `decidedApprovals` reads it the same way as an approval receipt, so the card stops offering Approve/Deny and shows "đã từ chối".
> Evidence:
> - `apps/runtime/test/api.spec.ts` › "records a refusal, and nothing runs" passes.
> - `apps/web/e2e/approval.spec.ts` › "refusing runs nothing and says so" passes. It now asserts no `[data-approve]`/`[data-deny]` and `[data-approval-decision="denied"]` = "đã từ chối".
> Closing.

---

## #174: composer.attach opener "mo hop" refuses "mở hộp thư email của tôi"

**Verdict: CLOSABLE**

The fix landed in `3cfb749` (PR #175, the inbox). The ambiguous opener now returns no-match instead of a refusal when the rest of the sentence does not fit (`packages/core/src/app-intents.ts` ~207–248).

| Criterion | Evidence | Test command | Result |
|---|---|---|---|
| "mở hộp thư email của tôi" is not an app intent | `packages/core/test/app-intents.spec.ts:295` (`matchAppIntent(...)` is undefined) and `:278` (`resolveAppIntent(...).kind === "none"`) | Run 1 › "leaves a request that only starts like the file dialog to the agent" and "leaves a request about an email inbox or an error message to the agent" | PASS |
| "mở hộp thư" gives `inbox.open` | `app-intents.spec.ts:297-298`, plus phrase table `:126` | same | PASS |
| Existing attach phrases still match | `app-intents.spec.ts:299-300` ("mở hộp thoại chọn tệp" gives `composer.attach`), plus the existing composer.attach phrase tables in the same file | same | PASS |

**Closing comment draft**

> Verified on `main` @ 76e6ce8 (fix in 3cfb749 / PR #175). In `packages/core/test/app-intents.spec.ts`:
> - "mở hộp thư email của tôi" gives no match and resolves to `none`, so it falls through to the model turn;
> - "mở hộp thư" gives `inbox.open`;
> - "mở hộp thoại chọn tệp" and the existing attach phrases still give `composer.attach`.
>
> All pass (`corepack pnpm exec vitest run packages/core/test/app-intents.spec.ts`). Closing.

---

## #169: Inbox update checks for Pi, installed packages and widgets

**Verdict: CLOSABLE, with limitations recorded for follow-up**

Landed in PR #176. Commits: `6aa949d` (producer), `62cd086` (newest installable only, no prerelease for a stable install), `e517e76` (platform pin in tests).

| Criterion / checklist | Evidence | Test command | Result |
|---|---|---|---|
| Pi SDK version compared with the registry | `apps/runtime/src/update-checks.ts` (Pi SDK reader). `apps/runtime/test/update-checks.spec.ts` › "Pi SDK" block, lines 291–400. | Run 1 | PASS |
| Installed packages and widgets compared with the directory index | `runUpdateCheckOnce` wires `listInstalledPackages` and the directory index (spec :403, :422 with a real index file) | Run 1 | PASS |
| Periodic, rate-limited job with no overlapping passes; stop aborts it | `startUpdateCheckTimer` (spec :506, :539, :569) | Run 1 | PASS |
| Offline or network errors create no error notices | spec :328 "stays quiet … when the registry cannot be reached", :343 non-2xx, :358 invalid semver, :387 offline Pi does not block packages | Run 1 | PASS |
| `dedupKey` per (package, new version) | spec :249 "dedups: checking the same newer version twice writes only one row", :266 new key for a newer version. Writes go through `tryRecordNodeNotice` (`apps/runtime/src/notices.ts` ~136–161). | Run 1 | PASS |
| Notice shows source, current → new version, and risk lane (native versus isolated) | spec :120 "naming source and risk lane", :142 "labels a trusted-native package differently from an isolated widget", :292 Pi as trusted-native, :422 `riskTier` mapped to lane | Run 1 | PASS |
| No fake "Update" button in the inbox | `packages/conversation-client/src` has no update action. An update notice appears only as a notice, and only `inbox/inbox-notify-decide.ts:42` routes `category === "update"` to the `updates` notification group. | inspection; Run 2 `inbox.spec.ts` | PASS |

Known limitations. These do not block the acceptance criteria, but should be stated when closing:

1. A **git**-source package whose version does not change is not detected, because comparison is by semver version only.
2. There is **no Update action**. That work continues in #196 phase 3, which must go through the existing install/rollback lifecycle.
3. Installed packages are checked only against the **directory index**. Local-source packages are not checked, and npm/git sources are not queried directly for newer versions.

**Closing comment draft**

> Verified on `main` @ 76e6ce8 (6aa949d, 62cd086, e517e76 via PR #176). `apps/runtime/src/update-checks.ts` produces `category: "update"` notices for the Pi SDK (registry) and for installed packages and widgets (directory index).
> - The check runs on a non-overlapping timer.
> - It stays silent offline, on non-2xx responses and on invalid semver.
> - It dedups by `(package, newVersion)`.
> - It labels the source, current → new version and the risk lane (trusted-native versus isolated).
>
> `apps/runtime/test/update-checks.spec.ts` covers dedup, offline and risk lane, and all pass. The inbox shows no Update button.
> Known limitations, tracked forward:
> 1. A git source without a version bump is not detected.
> 2. There is no Update action yet (#196 phase 3, via the install/rollback lifecycle).
> 3. Only directory-index entries are checked, so local sources are not.
>
> Closing.

---

## #171: Inbox OS notifications, per-category preferences and quiet hours

**Verdict: CLOSABLE**

Landed in PR #176. Commits:
- `1dce660`: preference contract;
- `72bd585`: pure decision logic;
- `b00c488`: delivery outside the app;
- `4cfb8a8`: Electron main-process `Notification`;
- `e649664`: Settings controls;
- `c40360a`: browser e2e;
- `c70ecb3`: real permission and click routing.

Follow-up `0117920` (PR #184) reports notify refusals.

| Criterion / checklist | Evidence | Test command | Result |
|---|---|---|---|
| Desktop: an OS notification from the main process, host-owned, with a redacted title only | `apps/desktop/src/main.mjs` ~188 and 373–401 (`desktop:notify` handler builds an Electron `Notification`; IPC reviewed against `rendererUrl`), `apps/desktop/src/preload.cjs` bridge | Run 1 (`apps/desktop/test`); Run 3 | PASS |
| Clicking it opens the inbox | `main.mjs` click handler restores and focuses the shell and sends `desktop:notificationClicked`; the renderer opens the inbox. **Proven in a real Electron shell** by run 3: `notification.emit("click")` on the captured instance, then `[data-inbox-panel="ready"]` is visible in the dialog. | Run 3 | PASS (local spec) |
| Web: Web Notification API only after opt-in in Settings, with browser permission as the consent boundary | `use-inbox-notifications.ts`; `inbox-notifications.spec.ts:310` (refused permission reported beside the toggle) | Run 2 | PASS |
| Settings → Control: group toggles and quiet hours, each saved immediately with no Save button | `ControlSettings.tsx`; `packages/contracts/src/preferences.ts` ~419–447 (`inbox.notifications`); `preference-routes.spec.ts`; `inbox-notify-decide.spec.ts` :79–88 (quiet-hours windows, including across midnight), :131 | Runs 1 and 2 | PASS |
| A near-expiry reminder (≤ 1 min) fires once, not repeatedly | `inbox-notify-decide.ts:25` `NEAR_EXPIRY_MS = 60_000`; spec :181 "reminds once …", :197 prune | Run 1 | PASS |
| Reduced motion and wake phrase unaffected | The change touches neither; no dedicated test | inspection | N/A (not an acceptance criterion) |
| **AC: E2E, a disabled group produces no OS notification for that group** | `inbox-notifications.spec.ts:137` "disabling a group silences its notification, the other group's still shows …" (web channel). Run 3 does the same for the desktop OS channel: group off gives no captured `Notification`; group on gives one. | Runs 2 and 3 | PASS |
| **AC: an OS notification never contains a secret** | `inbox-notifications.spec.ts:137` ("neither carries a secret"), `:201` ("never carries its command or a secret-shaped token"); `inbox-notify-decide.spec.ts:176`, `:202` (redaction) | Runs 1 and 2 | PASS |

**How the Electron click path was automated, and what could not be:**

- The spec launches `apps/desktop` with Playwright's `_electron`, pointing `--renderer-url` at the e2e web build and `--node-url`/`--data-dir` at the e2e node.
- It replaces `Notification.prototype.show` in the main process so the instance is captured instead of being handed to the OS. It then calls `emit("click")` on it.
- Everything else is real: the main process, preload, IPC review, the renderer poll, the `desktop:notify` handler, the click handler, and the renderer opening the inbox.
- The **OS toast pixel itself cannot be clicked** by any Playwright or Electron automation. It is drawn by the OS notification shell (Windows Action Center, macOS Notification Center, or a libnotify daemon), which is outside the browser and Electron process tree. That substitution is the only one.

**Side finding while doing this (a real Windows bug, separate from #171).** On Windows, Electron exits immediately with code -1 and no output when **any argument follows a URL-shaped argument**, unless `--` came earlier in argv. This is Electron's guard against protocol-handler command-line injection.

Reproduced with `Start-Process electron.exe`, 4 s liveness check:

| Arguments | Outcome |
|---|---|
| `apps/desktop --renderer-url http://127.0.0.1:9/ --data-dir .data/e2e` | exit -1 |
| `apps/desktop --renderer-url http://127.0.0.1:9/ plainarg` | exit -1 |
| `apps/desktop --data-dir .data/e2e --renderer-url http://127.0.0.1:9/` | alive |
| `apps/desktop -- --renderer-url … --node-url … --data-dir …` | alive |
| **The exact shape `tools/dev-desktop.mjs:156-165` uses** (`--dev --renderer-url <url> --node-url <url> --data-dir <dir>`) | **exit -1** |

Consequences:
- `pnpm dev:desktop` (PR #187) cannot start the Electron shell on Windows.
- The documented `electron . --renderer-url <url> --data-dir <dir>` (`docs/widgets-and-extensions.md:145`) fails on Windows the same way.

The smallest fix is to insert `"--"` after the app path in `tools/dev-desktop.mjs`. `main.mjs` reads flags with `indexOf`, so the `--` is harmless. The docs example needs the same change. The local spec uses exactly this fix. Linux and macOS were not tested. This should get its own issue; none was filed because this task forbade issue edits.

**Closing comment draft**

> Verified on `main` @ 76e6ce8 (PR #176: 1dce660, 72bd585, b00c488, 4cfb8a8, e649664, c40360a, c70ecb3; plus 0117920 / PR #184).
> - Desktop notifications come from the Electron main process with a redacted title only. Web notifications appear only after opt-in and browser permission.
> - Settings → Control has per-group toggles and quiet hours, saved immediately.
> - The near-expiry reminder fires once.
>
> Acceptance:
> - `apps/web/e2e/inbox-notifications.spec.ts` shows that disabling a group silences that group's notification, and that no notification carries a command or secret-shaped token. It passes.
> - A local Electron run also showed:
>   - a disabled group produces no main-process `Notification`;
>   - an enabled one does;
>   - clicking it (`notification.emit("click")`; the OS toast pixel itself is outside any automation surface) focuses the shell and opens the inbox.
>
> Closing.
> Note: on Windows, launching the desktop shell with `--renderer-url <url>` followed by more flags makes Electron exit -1 unless `--` precedes the flags. This affects `pnpm dev:desktop`. It is tracked separately.

---

## #93: Hardening of isolated-widget trust-boundary gaps, and proof of the browser journey

**Verdict: GAPS**

Commits confirmed on `main`, all ancestors of `76e6ce8` (via PR #153):
- `18ace13`: canonical package-file containment;
- `52c157b`: install route no longer accepts client grants;
- `379f460`: remote package sources plus derived granted capabilities;
- `bf8be35`: `CC_APP_ORIGIN` validation plus network origins threaded into the CSP;
- `46d8852`: single init.

The P2 "document required checks" item landed via PR #207 (`e82e4d0`), in `REVIEW.md:171-186`.

| Acceptance criterion | Evidence | Test command | Result |
|---|---|---|---|
| Outside-package symlink blocked by a regression test | `18ace13`; `packages/core/src/package-files.ts` canonicalises root and opened file; `packages/core/test/package-files.spec.ts` (traversal, outside symlink, normal file, inside symlink); `apps/runtime/test/package-files-route.spec.ts` (frame-grant and bearer routes share the rule) | Run 1 | PASS |
| Normal package resources still load | same specs; `widget-frame.spec.ts:51` loads the document and relative JS | Runs 1 and 2 | PASS |
| Real browser isolated-frame journey reaches ready and exercises a bound action | `apps/web/e2e/widget-frame.spec.ts` :51 (runs, package code), :66 (sandbox `allow-scripts`, no shared origin), :73 (action frame → host → back), :88 (state persists) | Run 2 | PASS |
| Unknown action or binding cannot escape the authorization path | Unit-covered in `packages/widget-host/test` (session refusals) and runtime action routes. **No e2e case** for an unknown binding from a real frame (issue item 6). | Run 1 | PARTIAL |
| Exactly one init per frame load | Fix landed: `WidgetFrame.tsx:192` calls `live.init()` once, and `packages/widget-host/src/session.ts:121` says the session posts. **No regression test** proves one load gives one init and one ready: `packages/widget-host/test/session.spec.ts:57-68` checks only `posted[0]`, not the count, and nothing tests the component. | — | **GAP** |
| Requested and granted capabilities are distinct in types and runtime | `379f460`; `packages/core/test/install-consent.spec.ts`, `frame-grant.spec.ts`, `widget-frame.spec.ts` (request ≠ grant; an undelegated capability is not brokered) | Run 1 | PASS |
| Forged install-request grants do not become authority | `52c157b`; `apps/runtime/test/package-install-route.spec.ts` › "does not let a forged grantedCapabilities in the request body become authority (issue #93, P1)" | Runs 1 and 5 | PASS |
| **Network-origin CSP derived from *validated* manifest permissions, defaulting to none** | The default is `connect-src 'none'`, and origins are threaded for local sources only (`apps/runtime/src/routes/packages.ts:396-411`, `routes/widget-serving.ts:69-84`). **Origins are not validated.** The manifest schema is only `z.string().min(1).max(300)` (`packages/core/src/widget-package.ts:40`, `packages/contracts/src/install.ts:68`), and `widgetDocumentPolicy` joins them verbatim (`packages/core/src/widget-document.ts` ~133). The probe (run 4) with origins `["https://api.example.com *", "https://x.example; report-uri https://evil.example"]` outputs `connect-src https://api.example.com * https://x.example; report-uri https://evil.example; …`, which shows **wildcard broadening and directive injection**. There are no tests for allowed, empty or malicious origins. | Run 4 | **GAP** |
| **Framing origin configuration explicit and validated** | `bf8be35` validates `CC_APP_ORIGIN` when it is read, but per request rather than at startup. When unset, the runtime still **falls back to the request Host** in the frame routes. `CC_APP_ORIGIN` is **not in `.env.example`** or the runtime docs, and there are no split-origin tests. | inspection | **GAP** |
| Sandbox, frame-grant and action-binding invariants intact | `WidgetFrame.tsx` `sandbox="allow-scripts"` only; `frame-grant.spec.ts`; `widget-frame.spec.ts:66` | Runs 1 and 2 | PASS |
| Focused tests and repository verification green | Runs 1, 2 and 5 are green (`pnpm verify` exit 0) | Runs 1, 2, 5 | PASS |
| P2: early frozen-lockfile gate; widget journey in the required browser suite; required checks documented | `.github/workflows/ci.yml:82,186,217` run `pnpm install --frozen-lockfile`. Job `name: e2e (browser suite)` (`ci.yml:170`) runs `pnpm test:e2e` (`:192`), which runs every `apps/web/e2e/*.spec.ts`, including `widget-frame.spec.ts`. `REVIEW.md:171-186` names `e2e (browser suite)` as required in the `main: required CI` ruleset (PR #207). | inspection | PASS |
| Final PR description explains the authority flow | PR #153 is a multi-topic PR; its body was not audited against this item | — | not verified |

**What is missing, and the smallest fix for each:**

1. **Validate network origins at the manifest boundary.** In `packages/core/src/widget-package.ts` (and `packages/contracts/src/install.ts`, ideally sharing one validator), refine `networkOrigins` entries so that `new URL(v).origin === v`. The scheme must be `https:`, or `http:` only for loopback. Reject whitespace, `;`, `,`, `*`, userinfo, path, query and fragment. As defence in depth, have `widgetDocumentPolicy` drop anything that fails the same check.
   Add `packages/core/test/widget-document.spec.ts` cases:
   - one allowed origin gives exactly that origin in `connect-src`;
   - empty gives `connect-src 'none'`;
   - `"https://a *"`, `"https://a; report-uri x"` and `"https://u@h"` are each refused or dropped.
2. **Add a one-init regression test.** In `packages/widget-host/test/session.spec.ts`, assert that after `init()` the list has `posted.filter(m => m.kind === "init").length === 1`. Add an assertion in `apps/web/e2e/widget-frame.spec.ts`, or in a component test, that counts `init` messages the frame receives for one load (e.g. via a fixture counter) and checks that the runtime never reports `DUPLICATE_INIT`.
3. **Make `CC_APP_ORIGIN` explicit.**
   - Parse and validate it once at runtime startup and fail fast when it is malformed.
   - When it is unset, use the node's own configured origin, not the request Host header.
   - Add it to `.env.example` and the runtime docs (EN/VI).
   - Add tests for the default same-origin topology and for split origins.
4. *(Optional, completes issue item 6)* Add an e2e case in `widget-frame.spec.ts` where the fixture widget invokes an unknown binding ID, and assert that the host refuses it with nothing observable changing.

**Comment draft (status, not closing)**

> Re-verified on `main` @ 76e6ce8.
> Landed and tested:
> - symlink-safe containment (18ace13);
> - forged install grants ignored (52c157b);
> - requested versus granted capabilities (379f460);
> - single init (46d8852);
> - the real-browser frame journey in `widget-frame.spec.ts`, which runs in the required `e2e (browser suite)` job;
> - required checks documented in REVIEW.md (#207).
>
> Remaining before this can close:
> 1. `permissions.networkOrigins` are interpolated into the CSP unvalidated. A manifest origin like `https://a *` or `https://a; report-uri …` broadens or injects directives. Validate them at the manifest schema and add allowed, empty and malicious tests.
> 2. There is no regression test asserting one init and one ready per frame load.
> 3. `CC_APP_ORIGIN` is validated only per request, still falls back to the Host header, and is missing from `.env.example` and the docs.
> 4. (Optional) There is no e2e for an unknown binding from a real frame.

---

## #129: Main and voice agents control the app via a unified AppIntent

**Verdict: GAPS.** The real-audio voice half is gated by #4 and is out of scope here.

Landed, mostly via PR #153:
- `22b97c2`: contract kinds plus agent source;
- `a2a4da1`: phrases plus host-control events;
- `dda6913`: `control_app` tool;
- `445f6cf`: client runs it through `runAppIntent`;
- `90710ad` and `17cb79a`: voice-turn forwarding;
- `ed345fa`: voice e2e;
- `988adef`: traceability.

| Criterion | Evidence | Test command | Result |
|---|---|---|---|
| Contract has `voice.open`, `nav.conversation`, `model.cycle`, `model.select{alias}` plus existing kinds | `packages/contracts/src/app-intents.ts:42-142`; `packages/contracts/test/app-intents-agent-control.spec.ts` | Run 1 | PASS |
| `control_app` registered as a real tool with a finite vocabulary (no DOM, URL, JS or provider strings) | `apps/runtime/src/node-tools.ts:258-404`; `apps/runtime/test/control-app-tool.spec.ts` :68, :75, :102 (`app.quit` outside the vocabulary) | Run 1 | PASS |
| Ephemeral host-control event on stream and non-stream, not a persisted block | `apps/runtime/src/model-turn.ts:553`; `routes/conversations.ts:1533` (own frame) | Run 1 (`turn-control.spec.ts`, `control-app-tool.spec.ts:60`) | PASS |
| `NO_ACTIVE_HOST_SURFACE` refusal | `node-tools.ts:295, 389`; `control-app-tool.spec.ts:51` | Run 1 | PASS |
| One client executor (`runAppIntent`), with `nav.home` ≠ `nav.conversation` | `packages/conversation-client/src/app-intents.ts`; `use-app-intent-surfaces.ts:126-135`; `packages/conversation-client/test/app-intents-agent-control.spec.ts` :29–82 | Run 1 | PASS |
| Main agent → the UI visibly changes, for all 8 actions | Only `nav.home` is e2e-proven (`voice-agent-control.spec.ts:90`). The other 7 are unit-covered at the tool and executor level only. | Run 2 | **PARTIAL** |
| Voice agent uses the same contract and executor | `apps/runtime/src/bootstrap/voice-bootstrap.ts` ~185–349; `voice-agent-control.spec.ts:112` (fixture voice → `control_app` → same read-back) | Run 2 | PASS (fixture model; real audio gated by #4) |
| Direct typed and spoken commands intact, with no model call | `voice-control.spec.ts` (9 tests); `app-intents.spec.ts` (core, runtime, client) | Runs 1 and 2 | PASS |
| **No replay after reload** | The design avoids persisted blocks, but **no test** reloads or re-renders a conversation that contained a `control_app` call and asserts that nothing re-executes | — | **GAP (untested)** |
| Model switching validated against configured profiles, next-turn boundary | `apps/runtime/src/routes/node.ts:207-250` (select by alias validated against the pool, applies to a new generation); `model-pool.spec.ts:37` | Runs 1 and 2 | PASS |
| **Model switching updates the visible alias/note like the hotkey** | `use-app-intent-surfaces.ts:136-141`: `cycleModel`/`selectModel` call the client and **discard the result**, touching only the failure notice. The hotkey path (`use-model-alias.ts:41-69`) sets the alias and note from the response. After an agent `model.cycle`/`model.select`, the header label is stale. | inspection | **GAP** |
| **Async executor; success reported only after the host executed it** | `runAppIntent` is still synchronous. Model calls are fire-and-forget (`void …catch`). `control_app` returns `status: "delivered"` with the intent's success read-back (`node-tools.ts:403`, e.g. "Tôi về màn hình bắt đầu nhé") once the event is handed to the stream, not after the page acknowledged it. The model and the person hear success even if the page then fails (for example, a rejected `selectModel`). | inspection | **GAP** |
| **Audit distinguishes click / typed user / spoken user / main agent / voice agent** | The main agent is `source: "agent"` (`model-bootstrap.ts:216`; spec :107). The **voice agent is recorded as `source: "voice"`** (`voice-bootstrap.ts:183`; `control-app-tool.spec.ts:118`), the same as a spoken user command (`voice-bootstrap.ts:328-329`). Spoken user and voice agent are therefore indistinguishable in audit. | Run 1 | **GAP** |
| `app.quit` still requires confirmation | outside the `control_app` vocabulary (spec :102); `voice-control.spec.ts:141` "a spoken quit asks instead of closing anything" | Runs 1 and 2 | PASS |
| Browser truthfully refuses desktop-only window actions | `voice-control.spec.ts:223`; `desktop-window-controls.spec.ts:98, 147` | Run 2 | PASS |
| Microphone permission not bypassed | `voice.open` goes through the existing `openVoice()` path, which uses the browser/OS mic permission; there is no dedicated test | inspection | PASS (by construction) |

**What is missing, and the smallest fix for each:**

1. **Audit origin.** Add `origin: "user" | "agent"` next to the channel on `recordAppIntentEvent` records (or a `source: "voice-agent"` value). Set it in `voice-bootstrap.ts` for the `control_app` path, and assert it in `control-app-tool.spec.ts:118`.
2. **Alias/note after an agent model switch.** Route `cycleModel`/`selectModel` in `use-app-intent-surfaces.ts:136-141` through the same setter the hotkey uses in `use-model-alias.ts`, so the header label and note update from the response. Add a client test, or extend `model-pool.spec.ts` with a `control_app` `model.cycle` fixture sentence.
3. **Truthful completion.** Either make `runAppIntent` async and have the page acknowledge the result back to the runtime, or change the `delivered` read-back to "sent to the app" wording that does not claim success. At minimum, surface a failed `selectModel` in the conversation.
4. **A no-replay test.** Add an e2e step: run the `control_app` `nav.home` fixture, reload the page on that conversation, and assert that the start screen is not re-triggered and no host-control event is emitted from history.
5. **E2E breadth.** Add fixture sentences for `settings.open`, `settings.tab`, `nav.conversation`, `voice.open`/`voice.end` and `model.cycle`/`model.select` to `voice-agent-control.spec.ts`, each asserting the visible change.

**Comment draft (status, not closing)**

> Re-verified on `main` @ 76e6ce8 (22b97c2, a2a4da1, dda6913, 445f6cf, 90710ad, 17cb79a, ed345fa).
> Working and tested:
> - `control_app` has a finite vocabulary, and the ephemeral host-control event goes through `runAppIntent`;
> - `NO_ACTIVE_HOST_SURFACE` refusal;
> - `model.select` is validated by alias against the pool;
> - quit stays confirmation-gated;
> - the browser refuses window intents;
> - voice-agent parity with a fixture model.
>
> Remaining:
> 1. A voice-agent action and a spoken user command are both audited as `source: "voice"`.
> 2. An agent `model.cycle`/`model.select` does not update the visible alias/note the way the hotkey does.
> 3. `runAppIntent` is still synchronous, and `control_app` reports success on delivery rather than on execution.
> 4. There is no test that reload/history render does not replay an action.
> 5. The main-agent e2e covers only `nav.home`.
>
> The real-audio voice half stays gated by #4.

---

## Local artifacts (not committed, not pushed)

- `apps/web/e2e/desktop-notification-click.spec.ts` in worktree `agent-a8bf089cc8d523caa` is untracked.
  - It would be picked up by a local `pnpm test:e2e`.
  - It needs a display, so it is not suitable for the headless CI browser job as is. It could run in the xvfb desktop-smoke job.
- `.data/probe-csp.ts` and `.data/probe-electron.mjs` are gitignored scratch probes.

Status: DONE_WITH_CONCERNS
Summary: #173, #174, #169 and #171 are closable, with evidence and passing tests (529 focused vitest tests, 39 plus 1 Playwright tests, and `pnpm verify` green). #93 and #129 have concrete gaps, listed above with the smallest fixes.
Concerns:
- #93: unvalidated CSP origins are an exploitable directive-injection vector for local-source packages.
- A newly found Windows bug: Electron exits -1 when flags follow a URL argument, which breaks `pnpm dev:desktop` and the documented desktop launch. It needs its own issue.
- #171's desktop click proof is a local, uncommitted spec, and the OS toast pixel is not automatable.

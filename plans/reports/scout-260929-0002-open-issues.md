# ClarkCant open-issue scout — 2026-09-29

Sources: `issues.json` snapshot (27 issues), `gh pr view` for #188/#205–#208, `origin/main` at `1d11a5e`,
`docs/conformance-traceability.md`, `plans/260924-0840-171-inbox-followups/plan.md`, and targeted greps.
Issue text was treated as data. "Verified on main" means I checked the code or the git log. "Per issue"
means the claim comes from the issue text only.

## 0. The snapshot has drifted (read this first)

- **PR #208 merged today** (`1d11a5e`), and **#191 is now CLOSED**.
- **The merge gate is deadlocked.** The `main: required CI` ruleset (id 24128511) already requires
  `verify (windows-latest, node 24)`, but only PR #207's workflow defines that job. So #205, #206 and #188 show
  `BLOCKED`: all their CI checks are green, but the required Windows check never runs on their branches.
  - PR #207 is `CONFLICTING/DIRTY` against main.
  - #207 duplicates two changes: #206's `tools/invariants/context.mjs` fix, and #208's `terminal-gateway` win32 skip, which has already landed.
- **Several open issues are already implemented on main** and only need an acceptance-criteria check and closure:
  - **#93:** every P0/P1 item landed on 2026-09-23.
  - **#169, #171, #173, #174:** the inbox follow-ups plan's result table marks them done.
  - **#129:** `control_app` landed on 2026-09-23.
  - **#137:** half fixed.
  - **#5 (V04/V05):** now PASS in conformance for two nodes on one machine over HTTP.
- **Untracked item:** PR #188's audit reports a P0 "no Stop for a running turn". No open issue tracks it. I did not verify it on main. Its other P0, the composer keeping the draft, was fixed by #189.

## 1. Open PRs

| PR | Branch | Closes | CI | Merge state | Note |
|---|---|---|---|---|---|
| #205 | fix/desktop-shell-window-handlers | — (no issue) | all green (no Windows job) | MERGEABLE / BLOCKED; branch behind main | Detached-window IPC target bug. Needs a rebase after #207 so the Windows job runs. |
| #206 | fix/invariants-posix-repo-paths | #190 | all green (no Windows job) | MERGEABLE / BLOCKED | Same `context.mjs` fix as #207, plus 3 `path.win32` tests that #207 lacks. |
| #207 | ci/windows-verify-and-merge-policy | — (fixes #190 in effect) | all green, including Windows | CONFLICTING / DIRTY | Adds the Windows CI job the ruleset already requires. Also adds `.gitattributes` LF, REVIEW.md merge policy and the #93 P2 "document required checks". Must be rebased onto main (drop the terminal-gateway change #208 already landed). |
| #208 | fix/windows-runtime-tests | #191 | — | **MERGED today** | #191 closed. |
| #188 | claude/ui-ux-design-analysis-r02rs2 | — | green | Draft; BLOCKED | Vietnamese UX audit report only (115 findings). Its composer P0 was fixed by #189; the "no Stop" P0 is untracked. |

## 2. Per-issue analysis

Types: **bug**, **sec** (security-hardening), **feat**, **epic**, **ext** (externally gated).

### #2 — V10 Google Calendar live connector
- **Intent / type / size:** Prove the Calendar connector against a real Google account. ext. M–L.
- **State on main:** V10 is PARTIAL. The read/write path runs against a loopback fake. Conformance says: "there is no Google account, so the API … has never been called."
- **Sub-deliverables:**
  - token exchange and refresh;
  - persisting `connections`;
  - capability probe;
  - conductor wiring;
  - T37 ETag conflict;
  - `calendar` renderer (the last piece of V11);
  - optional push channel.
- **Dependencies:** none on other issues. #172's "OAuth connection expired" producer needs the `connections` writer this issue creates.
- **External prerequisites:**
  - a Google Cloud project with the Calendar API enabled;
  - an OAuth client (Desktop app for desktop; Web app plus a registered HTTPS callback for headless);
  - an owned test calendar;
  - consent-screen verification for a consumer build.
- **Open decisions:** consumer consent verification versus a documented BYO-client wizard for self-host.
- **Open PR:** none.

### #3 — V15 Computer Use
- **Intent / type / size:** Native macOS driver and Linux virtual-desktop runner. ext. XL.
- **State on main:** V15 is PARTIAL. The probe returns `requires-signed-bundle` / `requires-container-engine`.
- **Sub-deliverables:**
  - macOS driver binding (peekaboo, pinned);
  - grant/deny/revoke tested on a signed build;
  - Linux runner image with display and preview transport;
  - T61 (reject unauthenticated preview);
  - conductor escalation wiring;
  - screenshot retention and redaction.
- **Dependencies:** #193 Phase 5 (native Linux control) must stay separate from this pack.
- **External prerequisites:**
  - Apple notarisation credentials;
  - a **human granting Accessibility and Screen Recording** in System Settings (cannot be done programmatically);
  - a macOS machine (the current host is Windows);
  - a published runner image, which needs a registry account (Docker is available per the issue).
- **Open decisions:** driver candidate (peekaboo), to be confirmed after TCC verification.
- **Open PR:** none.

### #4 — V17 Live voice
- **Intent / type / size:** Real realtime voice transport. ext. L.
- **State on main:** V17 is PARTIAL. A Gemini Live adapter exists but is **opt-in** (live e2e skipped). `control_app` via voice is proven, but the "speech-recognition half … is not exercised".
- **Sub-deliverables:**
  - WebRTC transport;
  - token bridge;
  - T66 and T68 on real transport;
  - barge-in timing as two separate numbers (target 150 ms);
  - Pi reload keeps the session;
  - VI/EN code-switching.
- **Dependencies:** none.
- **External prerequisites:**
  - a provider account with realtime access and a recorded model id;
  - a real microphone and speaker, with a human speaking for the timing and barge-in measurements.
- **Open decisions:** the issue explicitly refuses an STT+TTS substitute under the "live" name.
- **Open PR:** none.

### #5 — V04/V05 Node pairing and remote delegation
- **Intent / type / size:** Pair and delegate across two independent hosts. ext. L.
- **State on main:** conformance now marks **V04 and V05 PASS** for two live nodes on one machine (two ports, two databases, real HTTP). Transport is still plain HTTP: "the socket transport in `packages/node-link` is still a stub".
- **Remaining sub-deliverables:**
  - WebSocket `NodeLinkTransport` (reconnect cursor, keepalive, backpressure);
  - J4 journey;
  - T12, T13 and T71 across the wire;
  - no-duplicate rerun after a drop;
  - revoke during a running task.
- **External prerequisites:** "Two genuinely independent Linux hosts (VPS or namespaces)", plus a TLS endpoint or Tailscale network path.
  - The WebSocket transport itself can be built autonomously.
  - Two real hosts cannot be provisioned autonomously, unless a Linux-namespaces setup is accepted — which needs Linux, and this host is Windows.
- **Downstream:** hard blocker for #170, #209 (continuity proof), #210 (remote providers only), #197 Phase 5 and #172's pairing notice.
- **Open decisions:** whether the "namespaces" option counts as evidence. Automatic home failover is explicitly excluded.
- **Open PR:** none.

### #93 — Isolated-widget trust-boundary hardening
- **Intent / type / size:** Close the package-root symlink escape and the grant/CSP/app-origin gaps. sec. S remaining.
- **State on main (verified) — every P0/P1 item has landed:**
  - `18ace13`: realpath containment, with `package-files.spec.ts` present;
  - `52c157b`: the route no longer reads `grantedCapabilities`;
  - `379f460`: grants derived from the manifest through policy; the frame gets grant ∩ requested;
  - `bf8be35`: `CC_APP_ORIGIN` validated and network origins threaded into CSP;
  - `46d8852`: duplicate init fixed;
  - `apps/web/e2e/widget-frame.spec.ts`: sandbox, action round-trip and state tests;
  - CI already uses `--frozen-lockfile`.
- **Remaining:**
  - P2: document the required checks. PR #207 adds this to REVIEW.md.
  - Confirm that the isolated-frame spec runs in the required `e2e (browser suite)` job.
  - Tick the acceptance criteria and close.
- **Dependencies:** #209 lists #93 as a security dependency.
- **External prerequisites:** none.
- **Open PR:** #207 covers the P2 part.

### #129 — Main and voice agents control the app via AppIntent
- **Intent / type / size:** `control_app` tool plus agent-origin intents. feat. S remaining.
- **State on main (verified):** landed 2026-09-23 in `22b97c2` (agent kinds and source), `dda6913` (`control_app` in `node-tools.ts`), `445f6cf` (runs through `runAppIntent`), `17cb79a` and `ed345fa` (voice path, e2e). `NO_ACTIVE_HOST_SURFACE` exists in `model-turn.ts`.
- **Remaining:**
  - audit each acceptance criterion: no replay after reload, model.select by alias, audit origin distinctions, quit confirmation;
  - the voice-provider speech half, which is gated by #4.
- **Downstream:** #201 (appearance intents) and #196 Phase 5 build on it.
- **External prerequisites:** only for real-audio voice proof (#4).
- **Open PR:** none.

### #137 — Packed-worker lane not confined by projectRoots
- **Intent / type / size:** Confine the packed-worker lane. sec. S–M.
- **State on main (verified):**
  - The second defect is fixed: `40bbca1` makes `apps/worker/src/tools.ts` use `canonicalRoots` / `resolveInsideRoots`.
  - Still open:
    - `apps/runtime/src/pack-load.ts:118` sends `projectRoots: []` (now a probe run);
    - `model-turn.ts:788,904` also pass `[]` (lane not audited);
    - `packages/pi-adapter/src/real.ts:423-460` still enables built-in `READ_ONLY_TOOLS` against `process.cwd()` whenever roots are empty;
    - `task-dispatch.ts:332` hands the worker node-wide `projects.roots()`.
- **Remaining work:** decide the lane's roots (or make empty roots fail closed), and add a regression test.
- **Dependencies / overlap:** overlaps #197 Phase 1 (task-scoped resources). #209 names #137 a hard blocker for remote autonomous execution.
- **External prerequisites:** none.
- **Open decisions:** "Decide what the packed-worker lane's roots actually are."
- **Open PR:** none.

### #169 — Inbox update checks
- **Intent / type / size:** Update notices for Pi, packages and widgets. feat. Done.
- **State on main:** implemented (`62cd086`, `apps/runtime/src/update-checks.ts`). The plan's result table says "xong, có giới hạn" (done, with limits).
- **Limitations (per plan):**
  - a git-source package that does not bump its version is not detected;
  - there is no "Update" button, because no update route is wired to the install/rollback lifecycle.
- **Remaining:** verify and close. The update action continues in #196 Phase 3.
- **External prerequisites:** none. **Open PR:** none.

### #170 — Inbox notices from other nodes over NodeLink
- **Intent / type / size:** A `notice` kind on NodeLink and cross-node waiting items. feat. M.
- **Dependencies:** blocked by #5, per its own comment ("cần NodeLink pairing (#5)"). The receiving side is ready.
  - Pairing now works over HTTP between two local nodes (V04 PASS), so a two-node-on-one-machine test may now be feasible.
  - This contradicts the comment and should be re-assessed.
- **Downstream:** reused by #209.
- **External prerequisites:** real two-host proof needs #5's hosts.
- **Open PR:** none.

### #171 — OS notifications, per-category preferences, quiet hours
- **Intent / type / size:** feat. Done.
- **State on main:** implemented (`4cfb8a8`, `e649664`, `b00c488`, `c40360a`, `c70ecb3`); the plan marks it "xong" (done).
- **Caveat (per plan):** "Chưa kiểm tra tay hành vi click trên Electron có GUI" — the Electron notification click has not been hand-tested with a GUI. That is a minor manual check.
- **Remaining:** verify and close. Deep links continue in #196 Phase 5.
- **External prerequisites:** a GUI desktop session for the manual click check. **Open PR:** none.

### #172 — More inbox producers; decision route for task-dispatch approvals
- **Intent / type / size:** feat. Partially done; M remaining.
- **Done on main:**
  - `POST /tasks/:taskId/approvals/:approvalId/decide`;
  - the `task-approval` waiting item;
  - expired approval/question producer (`10ebbfa`, `df4fafa`, `86249ae`).
- **Remaining, each with its blocker:**
  - `unknown`-effect notice: there is no production writer for the effect ledger;
  - OAuth-expired notice: there is no `connections` writer (depends on #2);
  - reminders and automation due: need a scheduler (#197);
  - node-pairing request: #5.
- **External prerequisites:** indirect only (#2, #5).
- **Open PR:** none.

### #173 — Approval card keeps Approve/Deny after deny
- **Intent / type / size:** bug. Done.
- **State on main (verified):** `bf30c82`. `use-block-actions.ts:101-113` derives `deniedApprovals` from `args.decision === "denied"`. The plan marks unit and e2e tests done.
- **Remaining:** verify the e2e assertion in `approval.spec.ts`, then close. **Open PR:** none.

### #174 — "mo hop" opener swallows "mở hộp thư email của tôi"
- **Intent / type / size:** bug. Done.
- **State on main (verified):** `packages/core/test/app-intents.spec.ts:295` asserts the phrase is `undefined`, and the `composer.attach` opener is now "mo hop thoai". Fixed in #175 per the plan.
- **Remaining:** close. **Open PR:** none.

### #190 — Invariants fail on Windows (backslash paths)
- **Intent / type / size:** bug. S.
- **Open PR:** fixed by **#206** (`Fixes #190`), and the same fix is also in #207.
- **Remaining:** land one of them. Both are blocked by the ruleset deadlock described in section 0.
- **External prerequisites:** none.

### #191 — Windows runtime/browser test failures
- **State:** **CLOSED** by #208 (merged 2026-09-29). No action.

### #192 — Orb personalization (ShaderCN presets)
- **Intent / type / size:** feat. M.
- **State on main (verified):** a partial base exists. `orb.profile` is a preference with `clark|calm|jelly|glass|custom` (`a254dea`, #24).
- **Remaining:** ShaderCN-derived presets, preview in Settings, persistence per profile/agent, reduced-motion and WebGL fallback.
- **Downstream:** #201 needs it for Theme → Orb defaults.
- **External prerequisites:** check ShaderCN's licence and terms before copying shader code (an agent can read the licence; accepting it is a human decision).
- **Open decisions:**
  - which presets to ship;
  - "persist theo profile/agent" (per profile/agent) versus the current global preference.
- **Open PR:** none.

### #193 — Epic: first-class Omarchy compatibility
- **Intent / type / size:** Omarchy/Arch packaging, Hyprland window controller, Quickshell plugin, Omarchy pack, native Linux computer use. epic. XL.
- **Phases:**
  1. XDG paths, PKGBUILD/AUR, `.desktop`, `systemd --user`, native Wayland;
  2. `DesktopWindowController` with a Hyprland backend;
  3. Quickshell plugin and local protocol;
  4. `packs/omarchy`;
  5. `computer-linux-native`.
- **State on main:** no `DesktopWindowController` yet.
- **Dependencies:**
  - Phase 5 must stay separate from #3's `computer-linux-desktop`;
  - #209 wants a clean local-vs-portable split.
- **External prerequisites:**
  - Omarchy/Arch hardware or a VM running Hyprland (not available on this Windows host);
  - AUR maintainer account and publication;
  - possibly a separate `clarkcant-omarchy` repository;
  - a Wayland/Hyprland CI runner.
- **Autonomously feasible:** the XDG path audit, systemd unit files and the `DesktopWindowController` abstraction with its Electron backend and unit tests.
- **Open decisions:** repository split; AUR strategy.
- **Open PR:** none.

### #194 — Marketplace: npm-first distribution, separate discovery site
- **Intent / type / size:** epic. XL. The in-repo part is L; the separate site is its own project.
- **In-repo tasks:**
  - `DirectoryProvider` abstraction (not present yet; `CC_DIRECTORY_INDEX` is used);
  - remote marketplace client;
  - native browse UI;
  - install through the existing `/packages/install`;
  - agent discovery tools;
  - rework `clark widget publish`;
  - docs and tests.
- **Dependencies:** #201 (theme discovery) uses it. #209 uses it as a distribution input.
- **External prerequisites:**
  - creating the `digitopvn/clarkcant-marketplace` repository, its hosting and domain;
  - an npm account and token to publish reference packages;
  - a human definition of "Verified" and curation policy.
- **Open decisions:** the product decision is recorded (discovery / npm / runtime split). Open: whether `clark widget publish` wraps `npm publish` or stops at pack; the scope of "Verified".
- **Open PR:** none.

### #195 — Widget semantic state for the main agent (prompt-cache safe)
- **Intent / type / size:** feat, foundation. L.
- **Sub-deliverables:**
  - `WidgetSemanticState` contract and limits;
  - `widget_semantic_state` table (a new migration);
  - built-in semantic adapters;
  - normalised `semantic.publish`;
  - composition tree;
  - per-session cursor with suffix-only injection;
  - coalescing;
  - `inspect_ui` tool;
  - voice sharing the same truth.
- **State on main:** no `inspect_ui` or `semanticRevision` yet.
- **Dependencies / overlap:** #198 (composition graph "should align with #195"), #200 M6 ("complete #195"), #209 Phase F.
- **External prerequisites:** none. Token-budget targets need measurement with a real model provider, which is optional.
- **Open PR:** none.

### #196 — Actionable inbox notifications
- **Intent / type / size:** feat. L, in 5 phases.
- **Phases:**
  1. mark unread/read, undo dismiss, Ask Clark, Add to context;
  2. `NoticeSubject` plus a host action resolver;
  3. retry, update, skip-version, ask-again, peer reply;
  4. snooze and suppression;
  5. OS deep links, AppIntents, agent/voice, CLI/MCP.
- **Dependencies / overlap:**
  - its comment says the `notice-ref` must converge with #210's `ComposerReference`;
  - Phase 3 needs an update route (see #169) and peer messages (#170);
  - Phase 5 uses #129.
- **External prerequisites:** none. **Open PR:** none.

### #197 — Signal → Intent → Effect reactive automation
- **Intent / type / size:** epic. XL.
- **Phases:**
  1. intent provenance, task-scoped resources, brokered `run_command` for workers;
  2. Signal contract, delivery inbox, persistent intents, deterministic matcher;
  3. GitHub adapter;
  4. end-to-end issue-to-draft-PR journey;
  5. peer signals over NodeLink plus a second source.
- **Dependencies / overlap:**
  - Phase 1 overlaps #137;
  - Phase 5 needs #5;
  - it is the substrate for #199 and #209 hooks, and for #172 reminders.
- **External prerequisites:**
  - GitHub credentials (a token or GitHub App) in the Secret Broker;
  - a publicly reachable HTTPS webhook receiver, otherwise polling (the issue notes that desktop nodes cannot receive public webhooks);
  - a test repository.
- **Open decisions:** a new `signal-source` facet or not; GitHub App versus token.
- **Open PR:** none.

### #198 — Widgets v2: universal catalog plus multi-facet package model
- **Intent / type / size:** epic. XL.
- **Priorities:**
  - P0: Table contract, generic Action widget, layout primitives, input/search/form/list, composition state graph.
  - P1: status, artifact and diff widgets, charts, calendar views.
  - P2: map, diagram, media.
- **Architectural core:** unify `widget-package.ts`'s widget-only `manifestSchema` with the multi-facet `PackageManifest`. Verified still split: `kind: z.literal("widget")`, `isolation: "isolated-ui"`. Plus the service-facet runtime.
- **Dependencies:** **hard blocker for #201**. It is a package dependency of #209 Phase E and #210 skills. It overlaps #200 heavily (M3 and M5 duplicate §6, §11 and §12) and aligns with #195.
- **External prerequisites:** none. **Open PR:** none.

### #199 — Universal external messaging channels
- **Intent / type / size:** epic. XL.
- **Phases:**
  - A: substrate (`authorPrincipalId`, external link tables, attention router, renderer, offscreen widget snapshot);
  - B: Telegram;
  - C: Discord;
  - D: WhatsApp.
- **Dependencies:** "reuse the same durable external-delivery … infrastructure" from **#197**, so it effectively follows #197 Phase 2.
- **External prerequisites:**
  - a Telegram bot token (BotFather);
  - a Discord application and bot (plus gateway intents);
  - a WhatsApp Business / Meta account and approval;
  - test groups and humans for multi-speaker tests;
  - a public webhook endpoint for WhatsApp.
- **Open decisions:** keep the `driver` facet or add a `channel` facet ("only split … if real package ecosystem pressure").
- **Open PR:** none.

### #200 — Widget platform expansion (artifacts, service facets, executors, jobs)
- **Intent / type / size:** epic. XL.
- **Milestones:**
  - M1: ArtifactRef broker;
  - M2: invoke/agent/workflow executors;
  - M3: service facets;
  - M4: JobRef;
  - M5: composition graph;
  - M6: #195;
  - M7: resource profiles and token broker.
  - Plus 4 reference mini-apps.
- **Dependencies / overlap:** a roadmap tying together #195 and #198. M3, M5 and M6 duplicate those issues, so dedupe scope. #201 coordinates tooling with it.
- **External prerequisites:** the AI image generator reference app needs an image-generation provider key.
- **Open PR:** none.

### #201 — Theme platform
- **Intent / type / size:** epic. XL.
- **Milestones:**
  - M1: contracts, and splitting `experience.theme` into themeRef plus colorScheme (a migration);
  - M2: themes facet runtime;
  - M3: tokenisation, recipes, effects, desktop parity;
  - M4: `AppearanceSnapshot` in the widget bridge;
  - M5: Theme Lab and CLI;
  - M6: Marketplace;
  - M7: Pixel Arcade and Neo Brutalism.
- **Dependencies:**
  - "**Blocked by #198**" (hard);
  - phase dependencies: #194 (marketplace step), #192 (orb defaults), #129 (intents; now largely done), #200 (tooling).
- **External prerequisites:** the licence of any font packaged for Pixel Arcade.
- **Autonomously feasible before #198:** M1, M3 and M4 do not strictly need #198. M2 does.
- **Open PR:** none.

### #209 — Epic: one Clark, many nodes (continuity)
- **Intent / type / size:** epic. XL.
- **Phases:**
  - A: contracts and ADR;
  - B: preference and memory replication with tombstones;
  - C: cross-device work (needs #5);
  - D: work claims and portable continuation;
  - E: desired-state package reconciliation;
  - F: widget continuity;
  - G: runtime/Pi version convergence;
  - H: offline, encrypted relay, failover ADR.
- **Hard blockers:** "#5 … Hard blocker for real multi-host continuity proof", and "#137 … Blocker for autonomous remote execution".
- **Phase dependencies:** #170, #197, #198, #200, #195, #169, #201, #194, #93, #193, #190/#191.
- **External prerequisites:**
  - two or more physical or virtual hosts covering macOS, Windows and Linux/Omarchy;
  - network path (TLS or Tailscale);
  - human-owned device enrolment (a trust operation);
  - an optional future continuity service with hosting.
- **Autonomously feasible:** Phase A (ADR and contracts) and parts of Phase B locally.
- **Open decisions:** the ADR itself; automatic failover is explicitly deferred.
- **Open PR:** none.

### #210 — Composer `/` skill and `@` entity autocomplete
- **Intent / type / size:** feat. L.
- **Phases:**
  - A: `ComposerReference`, provider registry, popover UI and accessibility;
  - B: skills;
  - C: local entities (MCP, files, projects, conversations, sessions);
  - D: shared resolver with #196;
  - E: cross-node.
- **State on main:** no `ComposerReference` yet.
- **Dependencies:**
  - "#5 / #209 are hard blockers only for production-grade remote discovery" — Phases A–D are not blocked;
  - converges with #196;
  - skills should eventually come from #198's canonical model.
- **External prerequisites:** none for A–D. Phase E needs #5 hosts.
- **Open PR:** none.

## 3. Dependency graph

`A ──► B` means A blocks or feeds B. `(hard)` is a hard blocker stated in the issue text.

```
PR#207 (Windows CI job the ruleset already requires) ──► PR#205, PR#206, PR#188 can merge
PR#206 | PR#207 ──► #190 closed

#5 (two hosts, WS transport) ──(hard)──► #170
                             ──(hard)──► #209 Phase C+ (cross-host proof)
                             ──(hard)──► #210 Phase E only
                             ──────────► #197 Phase 5, #172 pairing notice
#137 ──(hard)──► #209 remote autonomous execution
#137 ◄──overlap──► #197 Phase 1 (task-scoped resources)
#2 ──► #172 OAuth-expired notice (connections writer); V11 calendar renderer
#4 ──► #129 voice speech-half proof
#3 ──(separation constraint)── #193 Phase 5

#198 ──(hard)──► #201
#198 ──► #200 M3/M5 (duplicate scope)
#198 ──► #209 Phase E
#198 ──► #210 (canonical skill source)
#195 ──► #200 M6 (== #195)
#195 ──► #198 composition graph
#195 ──► #209 Phase F
#200 ──► #209 Phase F; #201 tooling
#197 (Phase 2 delivery substrate) ──► #199
#197 ──► #209 automations
#197 ──► #172 reminders (scheduler)
#194 ──► #201 M6
#194 ──► #209 distribution input
#192 ──► #201 orb defaults
#129 (largely done) ──► #201 appearance intents; #196 Phase 5
#169 (done) ──► #196 Phase 3 update actions; #209 Phase G
#171 (done) ──► #196 Phase 5 deep links
#196 ◄──converge──► #210 (one ComposerReference / notice-ref)
#170 ──► #209 Phase C
#93 (done-ish) ──► #209 package propagation maturity
#193 ──► #209 Linux/Omarchy node realisation
```

## 4. Recommended priority

### Tier 0 — land open PRs and close already-done issues
1. **Rebase PR #207 onto main and merge it.**
   - Drop the terminal-gateway change that #208 already landed.
   - Resolve the `context.mjs` overlap with #206.
   - Rationale: it is the only branch that runs the Windows check the ruleset already requires. Every other PR is deadlocked until it lands.
2. **PR #206:** after #207, rebase it and keep only its `path.win32` tests and the `repoRelativePath` helper, or close it as superseded with the tests folded into #207. Either way, close #190.
3. **PR #205:** rebase after #207 so the Windows job runs, then merge. It is a real bug fix with green CI.
4. **PR #188 (draft):** decide whether to land the report. File an issue for its untracked "no Stop for a running turn" P0 after verifying it on main.
5. **Verify and close issues already implemented on main:**
   - #173, #174: quick check of the tests.
   - #169, #171: record the limitations in the closing comment.
   - #93: confirm the frame e2e is in the required suite and that #207 lands the P2 docs.
   - #129: audit the acceptance criteria. Split the voice speech-half into #4.
   - Rationale: these are free wins, and they cut the open count by about 6.

### Tier 1 — security and correctness
6. **#137 remainder:** make empty `projectRoots` fail closed in `real.ts` (or scope the probe), audit `model-turn.ts:788,904`, and add a regression test. Rationale: an unconfined read lane, and a hard blocker for #209.
7. **#172 unblocked remainder:** add a production effect-ledger writer for the `unknown`-effect notice, if that is in scope. Rationale: honest reporting of uncertain effects. The other producers stay blocked.

### Tier 2 — foundations others depend on
8. **#198 architecture core:** manifest unification and service-facet runtime, plus the P0 catalog items. Rationale: hard blocker for #201, and a feed for #200, #209 and #210.
9. **#195:** semantic state and `inspect_ui`. Rationale: required by #198, #200 and #209. It is self-contained.
10. **#197 Phase 1–2:** intent provenance, task-scoped resources, brokered worker commands, then the Signal/Intent core. Rationale: substrate for #199, #209 and #172. It also retires #137's node-wide roots.
11. **#210 Phase A–D together with #196 Phase 1–2**, sharing one `ComposerReference` / `NoticeSubject` contract. Rationale: the issues require convergence, so doing them apart creates rework.

### Tier 3 — features
12. **#196 Phase 3–5**, after the shared reference contract.
13. **#192:** ShaderCN presets on the existing `orb.profile`, after the licence check.
14. **#170:** re-assess now that HTTP pairing works (V04 PASS). A local two-node test is likely feasible.
15. **#194 in-repo part:** `DirectoryProvider`, native browse UI, publish rework.

### Tier 4 — epics (multi-PR, after their foundations)
16. **#200:** dedupe against #195 and #198 first; then M1 artifacts, M2 executors, M4 jobs, M7.
17. **#201:** after #198 (M1/M3/M4 can start earlier).
18. **#197 Phase 3–5** (GitHub adapter, end-to-end), then **#199** Telegram → Discord → WhatsApp.
19. **#209:** Phase A ADR and Phase B local first; the rest after #5 and #137.
20. **#193:** the autonomously feasible pieces (XDG, systemd unit, `DesktopWindowController` abstraction) first.

### Tier X — externally gated (cannot be closed without outside action)
- **#2:** Google Cloud project, OAuth client, test calendar.
- **#3:** Apple notarisation credentials, human TCC grants on a Mac, runner image registry.
- **#4:** realtime voice provider account, real microphone/speaker and a human speaker.
- **#5:** two independent hosts and a network path. The WebSocket transport itself can be built.
- **#193:** Omarchy/Hyprland hardware, AUR account, Wayland CI.
- **#194:** marketplace repository, hosting and domain, npm publishing, curation policy.
- **#199:** Telegram, Discord and WhatsApp business accounts, and human group testers.
- **#197 Phase 3–4:** GitHub credentials and a public webhook (or polling).
- **#209:** multi-OS hosts and device enrolment.

## 5. Closable by autonomous work vs not

| Closable by an agent (code, tests and PRs only) | Needs external action to close |
|---|---|
| #93, #129 (except real-audio voice), #137, #169, #171 (except a manual Electron click check), #173, #174, #190, #192 (after a human licence and preset decision), #195, #196, #198, #200 (except the AI-provider reference app), #201 (except marketplace distribution), #210 A–D | #2, #3, #4, #5, #170 (true cross-host proof), #172 (remaining producers blocked by #2, #5 and a scheduler), #193, #194, #197 (live GitHub journey), #199, #209, #210 Phase E |

Per AGENTS.md, any user-visible change also needs a `digitopvn/clarkcant-web` docs PR in English and Vietnamese, or a fallback `ai-handle` issue.

## 6. Unresolved questions
- Is `projectRoots: []` in `model-turn.ts:788,904` a lane that runs the SDK built-ins unconfined? I did not trace it.
- Does "namespaces on one Linux box" satisfy #5's "two genuinely independent hosts"?
- Does HTTP-only pairing (V04 PASS) unblock #170, or does it need the WebSocket transport?
- For #200 vs #198/#195: which issue owns the composition graph and service-facet scope? They duplicate each other today.
- The "no Stop for a running turn" P0 from PR #188 is unverified on main and untracked.

# Conformance traceability

Bảng bằng chứng được duy trì thủ công cho các scope item và acceptance test trong
[implementation-plan.md](implementation-plan.md). Mỗi trạng thái cần được đọc cùng
test và giới hạn tương ứng; việc có test không chứng minh lần chạy hiện tại đã đạt.

**Status vocabulary**

- **PASS** — exercised by a test that runs in this repository. The test name is given.
- **BLOCKED** — cannot be exercised without external infrastructure, credentials or hardware. The condition is named.
- **NOT-IMPLEMENTED** — belongs to a phase that this bootstrap did not build.
- **PARTIAL** (scope items only) — some layers are real and tested while others are absent; the split is stated.

This table is checked by `pnpm invariants`, which fails if any identifier is missing.
A status here is never upgraded without the corresponding test appearing alongside it.

## Acceptance tests

| ID | Status | Scenario | Evidence |
|---|---|---|---|
| T01 | PASS | A retried user command produces one logical task | storage.spec: "replays the original acknowledgement for a retry" |
| T02 | PASS | A resent delegation does not spawn a duplicate | node-link.spec: "returns the recorded outcome for a resent envelope" |
| T03 | PASS | Replayed/out-of-order delivery is deduplicated and gaps are reported | node-link.spec: "advances the peer cursor"; contracts.spec: "reports a sequence gap" |
| T04 | PASS | A second home authority for one conversation is rejected | storage.spec: "refuses a second home authority" |
| T05 | PASS | A node timeout after an external submit becomes unknown, not a rerun | core.spec: "moves the task to uncertain"; contracts.spec: "never resubmits a confirmed effect" |
| T06 | PASS | A revoked grant stops new delegations | storage.spec: "stops returning it after revocation" |
| T07 | PASS | A to B to C gains no rights without explicit grants | contracts.spec: "refuses re-delegation beyond the permitted depth"; core.spec: "stops a task from being forwarded" |
| T08 | PASS | A private network without application auth is rejected | node-link.spec: "rejects an envelope whose claimed sender is not the authenticated peer" |
| T09 | PASS | A wrong node-qualified resource is rejected before any effect | core.spec: "treats resource locality as a hard constraint" |
| T10 | PASS | An unapproved artifact transfer is refused with a reason | contracts.spec: "refuses an executable content type regardless of declared size" |
| T11 | PASS | An unsupported peer version negotiates a subset or reports unavailable | contracts.spec: version negotiation suite |
| T12 | BLOCKED | Closing the desktop leaves server jobs running | Needs two independent runtimes plus a client. |
| T13 | NOT-IMPLEMENTED | An offline home defers approval rather than self-approving | Belongs to P4 (node pairing and collaboration). |
| T14 | PASS | Two writers on one resource are serialized | storage.spec: "allows only one live lease per resource"; core.spec: "allocates a monotonically increasing epoch" |
| T15 | PASS | A changed Git common ref is caught by a repo lock | worktree.spec.ts: a lock records the shared git directory and the commit at HEAD against real repositories; a commit landing under a running task and a path re-pointed to another repository are both caught |
| T16 | PASS | A dirty working tree is never reset or stashed over | worktree.spec.ts: an uncommitted edit and an untracked file are both refused; the user text is byte-identical afterwards, HEAD has not moved, and git stash list is empty |
| T17 | PASS | A session file with a dead worker is not reported as running | core.spec: "refuses an illegal transition instead of ignoring it" |
| T18 | PASS | An idle worker with failing tests is not success | core.spec: success gating suite |
| T19 | PASS | An ambiguous project produces one clarifying question | core.spec: "asks one clarifying question when a project is ambiguous" |
| T20 | PASS | Two tasks needing one pack join a single install plan | core.spec: "lets two tasks needing the same pack join one plan" |
| T21 | PASS | A changed source/version/digest invalidates prior consent | core.spec: "invalidates consent when the artifact digest moved"; contracts.spec: "invalidates consent when the target node changes" |
| T22 | PASS | A malicious lifecycle script does not run in a credential-rich host | seams.spec: "never forwards a credential-bearing environment variable" |
| T23 | BLOCKED | An invalid OS/arch native extension is blocked, not ready | Needs a real native extension artifact. |
| T24 | PASS | A UI-only package update does not restart Pi or voice | contracts.spec: refresh scoping suite; capability-host test |
| T25 | PASS | A repeated reload leaves no stale handler or duplicate listener | pi-adapter.spec: "refuses to subscribe the same listener twice" |
| T26 | PASS | A failed activation leaves the prior generation serving | core.spec: "keeps the previous generation usable after a failed activation" |
| T27 | PASS | A changed original intent is revalidated before resuming | continuation.spec.ts: a changed goal refuses to resume and invalidates every prior approval, while a goal that differs only in whitespace and case resumes |
| T28 | PASS | A native extension asking for global secrets is refused or labelled | secrets.spec.ts: reading every secret is refused outright rather than labelled, while a connection-scoped request is granted only with a stated reason and a label naming the extension, the credential and the reason |
| T29 | PASS | A discovered but unauthenticated tool reports setup required | core.spec: "distinguishes 'needs a connection' from 'not installed'" |
| T30 | PASS | Denied/partial/expired OAuth produces an honest state | seams.spec: "reports partial consent instead of implying full access" |
| T31 | PASS | A callback after a cancelled setup does not activate anything | contracts.spec: pairing invite suite |
| T32 | BLOCKED | Google desktop OAuth uses the system browser | Needs a registered OAuth client. |
| T33 | PASS | A loopback callback on a headless server is caught as a mismatch | contracts.spec: checkRedirectReachable |
| T34 | PASS | An API key typed into ordinary chat is redirected to a secure route and redacted | seams.spec: credential vault suite and redaction test |
| T35 | PASS | A mismatched MCP token audience or redirect is rejected | seams.spec: "refuses to forward a token issued for a different resource" |
| T36 | PASS | A cached calendar is labelled with its last update, not as live | seams.spec: "labels cached data as cached rather than live"; e2e asserts the freshness badge in the DOM |
| T37 | PASS | A stale ETag conflict preserves the draft | consent.spec.ts: a write composed against a superseded version is refused, the newer content is untouched, and the caller text survives as a draft |
| T38 | PASS | A calendar create timeout inspects before duplicating | seams.spec: "treats a submit timeout as unknown rather than repeating the create" |
| T39 | PASS | An agent-generated new action binds a discovered capability | consent.spec.ts: a binding is created for a discovered capability and refused with a discover-first code for one that is not, and nothing is persisted when it refuses |
| T40 | PASS | An action naming a nonexistent tool is rejected | contracts.spec: "refuses to bind a capability the registry does not know"; core.spec: same |
| T41 | PASS | A widget cannot forge a host authorization card | seams.spec: "dropped a host card supplied by a non-host origin"; contracts.spec: surface provenance |
| T42 | PASS | A changed account or node rebinds and invalidates old consent | consent.spec.ts: pending approvals naming the previous account or node are expired rather than deleted, decided approvals are left alone, and rebinding to the same target is a no-op |
| T43 | PASS | A double click produces one accepted effect | core.spec: "refuses an invocation whose revision has moved"; storage dedup by invocation id; mini-app-actions.spec: "turns a double click into one effect and one pin" asserts one pin and one recorded invocation from two identical requests; mini-app-ownership.spec: the same invocation id with different input is refused rather than applied twice |
| T44 | PASS | An invalid or oversized widget spec falls back and chat stays usable | seams.spec: "falls back to the text alternative"; e2e/widget.spec: "a widget the client cannot render shows its text alternative instead of nothing" writes a real surface block for a definition no client ships and asserts the fallback text renders rather than a blank card; surface-composition.spec: an oversized bundle is refused rather than truncated; mini-app-compose.spec: a template that cannot compile returns a refusal instead of a half-built surface |
| T45 | PASS | A custom iframe cannot read host storage | seams.spec: "never grants a custom mini-app a same-origin luxury" |
| T46 | PASS | A user-authored note widget builds, previews, approves and persists a draft | widget-lifecycle.spec: a stale autosave is refused, the committed state is untouched and the draft survives; one draft per widget is held by the surface that opened it |
| T47 | PASS | Pinning an inline widget keeps one logical instance | core.spec: "refuses a second live owner for the same instance"; mini-app-ownership.spec: a second claim is refused with the holder named, a claim whose lease expired is recoverable, and an expired legacy claim does not lock the instance; mini-app-actions.spec: the live-owner route refuses the second surface and requires the token to release; e2e/mini-app.spec: a second browser surface renders read-only with a reason instead of taking the instance over |
| T48 | PASS | Restoring a pinned media widget does not autoplay or join | widget-lifecycle.spec: restorePinnedInstance returns the stored position with playing false and a stated reason; a second restore is also silent |
| T49 | PASS | Unpinning a note preserves its data | e2e/j1.spec.ts: "pinning and unpinning keeps the widget data" asserts the instance survives the unpin; mini-app-ownership.spec: "saves the view and pins the same instance in one step" asserts the instance, its state and its captured snapshot all survive an unpin, and that a pin points at the logical instance rather than creating a second one |
| T50 | PASS | A disabled pack still shows a safe history snapshot | widget-lifecycle.spec: disabling a package moves its instances offline, keeps the snapshot readable and reports actions unavailable; instances from other packages are untouched; mini-app-actions.spec: the snapshot presentation route answers with the captured bundle and `readOnly: true`, so history renders without any action binding; surface-snapshot.spec: a snapshot whose source was deleted keeps its text alternative and reports a tombstone instead of re-reading live data |
| T51 | PASS | A failed widget state migration recovers the old snapshot | widget-lifecycle.spec: a step that throws leaves the stored document and version at their original values, read back from storage rather than from the returned copy |
| T52 | PASS | An offscreen widget's background polling is rate-limited | consent.spec.ts: a manual subscription never polls, an on-open one only while on screen, and being offscreen cannot shorten the bounded interval |
| T53 | PASS | A stale browser locator re-observes instead of clicking | driver.spec.ts: a missing element reference and a moved target version are both refused against a real Chromium |
| T54 | PASS | A page prompt injection cannot alter rights, consent or secret scope | injection.spec.ts: a page instructing the agent to grant itself capabilities, skip approval, reveal secrets and exfiltrate is refused on every path; a differential case proves the refusal is about approval rather than a blanket refusal |
| T55 | PASS | A browser submit timeout does not trigger a second submit | submit-once.spec.ts: a click that fires its request then stops reporting returns unknown, resending the same action is refused and the server records exactly one submission, and observing lifts the block |
| T56 | PASS | Human login takeover pauses agent input and capture | driver.spec.ts: sensitive input is detected by focus and input is refused while it holds; takeover refuses input too |
| T57 | PASS | A denied or revoked macOS permission reports unavailable without bypass | seams.spec: "keeps capture and input permissions separate on macOS" |
| T58 | PASS | A foreground window or DPI change is validated before input | seams.spec: "revalidates the foreground target before sending input" |
| T59 | PASS | A local emergency stop outranks a remote command via lease fencing | core.spec: "fences out a holder whose epoch is behind"; "records a local emergency stop" |
| T60 | PASS | A headless Linux node makes no native-desktop claim | seams.spec: "reports a Linux host without a display as unable to run a virtual desktop" |
| T61 | NOT-IMPLEMENTED | Virtual desktop access without session auth is rejected | Belongs to P8; needs the preview transport. |
| T62 | PASS | Quick play without provider credentials is clearly a sample | e2e/j1.spec.ts: "a suggestion produces a labelled sample with a real widget" asserts the host-owned label in a real browser |
| T63 | PASS | Skipped or restarted onboarding resumes without reinstalling | onboarding.spec.ts: a completed step is not asked again, checkpoints are scoped per node so one machine setup does not mark another done, and progress is counted against the whole catalogue |
| T64 | PASS | A spoken interruption changes audio only and does not cancel the job | contracts.spec and seams.spec: barge-in routing |
| T65 | PASS | A mid-sentence correction is one task revision, not two effects | seams.spec: "emits one intent per completed utterance" |
| T66 | PASS | Voice and click reach the same widget action state | Built on both sides and unit-tested: one shared `invokeWidgetAction` for a click and a sentence, a resolver with 10 tests (`apps/runtime/test/widget-voice-action.spec.ts`, which also carries the period argument a sentence implies), the `focus` frame carrying only an instance id, and the node's own revision and binding digest rather than a cursor from the page. The browser journey is green and in the suite: `apps/web/e2e/voice-widget-action.spec.ts`, "a spoken action and the same click reach the same state", which drives the same action twice with the state put back in between, plus the refusal journey. Fixed at its cause after measuring it, which the earlier note got wrong: the sentence does resolve and the action does run - the node reported `ok` and revision 7 to 8 - but the page had no handler for the node's `widget-action-result` frame, so the surface kept showing the old period. The spoken sentence must also carry the argument: this action takes a period, and a sentence naming only the action cannot choose one. Not counted: the invocation count, because `action_invocations` has no route, so the claim is what is observable - both paths land on the same state. |
| T67 | PASS | Competing microphone owners are resolved explicitly | seams.spec: "refuses a second exclusive microphone owner and names the holder" |
| T68 | PASS | Mute and end actually stop capture and playback on the real transport | The client is the side that holds the microphone, so it is where mute and end either stop the track or do not: mute disables every capture track and sends `{type:"mute", muted}`; end sends `{type:"end"}`, stops every track and closes the audio context ([voice-transport](../packages/conversation-client/test/voice-transport.spec.ts), three tests). The node's half - the frames arriving and the adapter being told - is covered by [voice-gateway](../apps/runtime/test/voice-gateway.spec.ts), and the same path against a real socket in a real browser by [voice](../apps/web/e2e/voice.spec.ts). |
| T69 | PASS | Backup restore with version drift migrates or blocks, never corrupts silently | storage.spec: consistent backup and restore suite |
| T70 | PASS | Reaching a disk or budget limit stops new work safely | hardening.spec.ts: the ceiling is checked at the door and an over-budget run is refused before it starts; windows reset so a limit is not permanent; usage accumulates per window rather than per run |
| T71 | PASS | Credentials are never copied between nodes implicitly | consent.spec.ts: the owning node is handed a handle and never a value, a different node is refused with a routing instruction, and a revoked connection is refused on its own node |
| T72 | BLOCKED | An unavailable vendor SDK yields a working fallback or an unsupported verdict | Needs a real vendor account. |
| T73 | PASS | A spoken app command and the same click reach the same Settings state | Both journeys are green in `apps/web/e2e/voice-control.spec.ts`: the gear and the sentence land on the same tab, and a **named** tab lands where clicking that tab lands. The named-tab journey was red for a measured reason, now fixed at its cause: PR #25 rebuilt the panel, and it carried two effects on the same trigger, the second of which reset the tab to `experience` whenever the panel opened - overwriting the tab a command had named in the same commit. `openAt` alone did not settle it; one effect that honours `openAt` and still defaults to `experience` does. |

## Scope items

| ID | Status | Feature | What is real and what is not |
|---|---|---|---|
| V01 | PASS | Conversation client | One timeline, one composer, pins and a shared React surface are implemented and verified in a real browser ([browser suite](../apps/web/e2e/)). Files can be attached: the composer uploads them, the stored message carries opaque `att_…` references, the timeline shows them, and the agent reads the content through a host tool with no path parameter ([attachments](../apps/web/e2e/attachments.spec.ts); the prompt itself is proven at the adapter seam by `FakePiAdapter.promptsFor()`). The voice surface and the desktop shell both exist now, with a named bridge for the window and the session ([voice](../apps/web/e2e/voice.spec.ts), [desktop](../apps/desktop/src/main.mjs)). The desktop window's own behaviour is proven by that smoke run on a machine with a display: `electron . --smoke-test` exited 0 with every check `true` and `failed: []`, including the bounds, the twenty-by-fifty floor and always-on-top read back from the real window (Electron 44.3.0, Chrome 152). CI runs it too, in the `desktop smoke (xvfb)` job added with the browser suite, so the claim is checked on every push rather than only on the machine where it was first run. |
| V02 | PARTIAL | Portable runtime | `apps/runtime` boots a node with its own identity and database on macOS and Linux, and the gateway refuses an unauthenticated request. The Unix-socket transport and OCI image are not built. |
| V03 | PARTIAL | Persistent task/session runtime | Task/run/effect có bằng chứng trong [core tests](../packages/core/test/); conductor đã nối với runtime qua [services.ts](../apps/runtime/src/services.ts) và có [routing tests](../apps/runtime/test/conductor-routing.spec.ts). Project-work capability vẫn được đăng ký ở trạng thái chưa loaded; đường model/background session không chứng minh worker pool thực thi capability đã hoàn chỉnh. |
| V04 | PARTIAL | Trusted node linking | Envelope validation, identity checking, invite single-use and revoke are implemented and tested. Pairing between two live hosts is not exercised. |
| V05 | PARTIAL | Remote collaboration | Delivery semantics, dedup and grant narrowing are implemented and tested. A live two-node delegation is not exercised. |
| V06 | PARTIAL | Workspace registry | Node-qualified resource references, locality routing and lease serialization are implemented and tested. Explicit file transfer is not built. |
| V07 | PARTIAL | Capability platform | Registry và readiness có bằng chứng trong [core tests](../packages/core/test/). MCP stdio có [test với tiến trình server thật](../packages/mcp-adapters/test/stdio.spec.ts); streamable-HTTP vẫn chưa được triển khai. |
| V08 | PARTIAL | Conversational install | Plan creation, join-or-create, digest-bound consent, generation activation and rollback are implemented and tested. Marketplace reuses that path rather than adding an installer: a source resolves to an exact artifact ([package-sources](../packages/core/test/package-sources.spec.ts)) and the install runs through the same lifecycle ([install-from-source](../packages/core/test/install-from-source.spec.ts)), with the branch/range/missing-digest refusals and a rollback that is reported as refused rather than claimed when it comes too late. Directory search reuses that same path rather than adding a second one: an index is read and refused whole when one entry is invalid ([directory-index](../packages/core/test/directory-index.spec.ts)), a result without a digest is dropped because the resolver would refuse it, and the card shows source/version/digest/risk while offering no install button of its own ([marketplace-search](../apps/web/e2e/marketplace-search.spec.ts)); `publish` prepares the entry with the packed artifact's own digest ([conformance](../packages/widget-cli/test/conformance.spec.ts)). Quarantine download and isolated build are not built. |
| V09 | PARTIAL | Credential/auth setup | An encrypted vault, redaction, PKCE generation, state comparison, scope verification and endpoint allowlisting are implemented and tested. A live token exchange is not built. |
| V10 | PARTIAL | Reference integration (Google Calendar) | Scope planning, time normalisation, agenda building, conflict detection, write-outcome classification and freshness labelling are implemented and tested. No live account is connected. |
| V11 | PARTIAL | Rich built-ins | Đối chiếu [catalog](../packs/data-canvas/src/index.ts) với [widget tests](../apps/web/e2e/widget.spec.ts) và [composition tests](../apps/web/e2e/mini-app.spec.ts); không suy ra toàn bộ catalog thiết kế đã hoàn thành từ các family có test. |
| V12 | PARTIAL | Custom widgets | Declarative composition có [browser tests](../apps/web/e2e/mini-app.spec.ts). Renderer runtime cho isolated-app giờ đã được chứng minh: handshake với nonce + đúng source window và mọi từ chối ([widget-sdk runtime](../packages/widget-sdk/test/runtime.spec.ts), [widget-host session](../packages/widget-host/test/session.spec.ts)), và bộ conformance chạy được các check đó trên một package thật ([widget-cli conformance](../packages/widget-cli/test/conformance.spec.ts)). Phần **chưa** được chứng minh: MCP Apps dùng chung đường này, các check cần frame đã render (keyboard, touch, layout, reduced motion) được `clark widget test` báo `requires-dev-host` chứ không phải pass, và script trong trang của dev host chỉ chạy được trong browser; xem [ranh giới widget](widgets-and-extensions.md). |
| V13 | PARTIAL | Pins | Pin persistence and single-live-owner enforcement are verified in a browser. Restore-without-autoplay returns the stored position and does not play, verified in core. The pinned media surface itself is a synthetic fixture, not a vendor player. |
| V14 | PARTIAL | Browser Use | Bằng chứng driver Chromium nằm trong [driver.spec.ts](../packs/browser-playwright/test/driver.spec.ts); prompt injection và submit không lặp có [injection.spec.ts](../packs/browser-playwright/test/injection.spec.ts) và [submit-once.spec.ts](../packs/browser-playwright/test/submit-once.spec.ts). Takeover preview UI vẫn chưa được triển khai. |
| V15 | PARTIAL | Computer Use | Permission gating, containment labelling, target validation and profile validation are implemented and tested. The native bindings need a signed bundle and a container engine. |
| V16 | PARTIAL | Onboarding/personalisation | Quick play works with no credentials and is labelled as sample in a host-owned card, verified in a browser. The first screen now offers what the node knows the person was doing - unfinished work, something pinned, the session itself, a directory used recently - each chip carrying why it is there, with the four written chips as the fallback when there is nothing (`GET /suggestions`, `apps/web/e2e/suggestions.spec.ts`). Needs-based setup and preference undo are not built. |
| V17 | PARTIAL | Live voice | Transcript assembly, intent routing, media-focus arbitration and mute/end semantics are implemented and tested. Commands reach the same execution path a click takes: nine app intents with a confirmation for quitting (`packages/contracts/src/app-intents.ts`, `packages/core/src/app-intents.ts`), and the window intents that actually move the desktop window (`packages/conversation-client/src/Conversation.tsx`). Parity between a sentence and a click is asserted in `apps/web/e2e/voice-control.spec.ts` and `apps/web/e2e/voice-bar.spec.ts`. The transport is a node-proxied WebSocket to Gemini Live (`packages/voice-adapters/src/gemini-live.ts`, `apps/runtime/src/voice-session.ts`), not browser-direct WebRTC, and the browser holds no provider credential (`docs/research/adr-001-gemini-live-provider.md`); the live-provider checks remain opt-in and need a provider account. |
| V18 | PARTIAL | Operations/security | Forward-only migrations (`packages/storage/src/migrate.ts`), verifiable consistent backup, restore compatibility checks, credential redaction and durable dedup are implemented and tested. Failure injection and soak testing belong to P10. |

## Summary

### Khoảng trống đã biết: performance của widget (Phase 14)

Ba mục performance của Phase 14 nằm ở đây thay vì trong bảng, vì chúng **chưa có gì để gắn vào**:

- **pointer Orb loop ngoài React state** — đã có và đã test (`apps/web/e2e/orb.spec.ts`, canvas không bị dựng
  lại khi pointer quét qua 20 lần).
- **không duplicate live subscription sau detach** — đã có và đã test từ trước
  (`core.spec.ts`: "holds the one-owner rule across a detached surface too (V20)"). Detach trình bày cùng một
  instance ở chỗ khác, không tạo instance thứ hai, và lease từ chối chủ thứ hai kèm tên surface đang giữ.
- **heavy widget lazy mount** và **offscreen suspend** — **BLOCKED**: conversation client không mount frame
  isolated nào cả (`mini-app-surface.tsx` vẽ `figure` từ snapshot đã chụp; không có `iframe` và không có
  `sandbox=` trong client). Điều kiện thiếu được nêu tên: một frame chỉ có thể lazy-mount và suspend khi nó
  tồn tại, và để nó tồn tại thì node phải phục vụ được entry của một package đã cài — phần đó chưa có. Viết
  wiring rồi tự test nó trong cùng một change là tự xác nhận, nên hai mục này được báo là thiếu.

Các bảng trên là nơi tra trạng thái từng yêu cầu; không scope item nào được tuyên bố
hoàn tất. Fixture chứng minh đường nối của ứng dụng, không thay thế kiểm chứng với
provider thật. Định hướng UX trong [DESIGN.md](../DESIGN.md) không tự nâng trạng thái
conformance khi chưa có bằng chứng triển khai.

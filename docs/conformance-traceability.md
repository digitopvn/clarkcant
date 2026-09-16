# Conformance traceability

Generated view of what is actually verified versus what is not. Every scope item and
every acceptance test from `docs/implementation-plan.md` appears here exactly once.

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
| T15 | NOT-IMPLEMENTED | A changed Git common ref is caught by a repo lock | Belongs to P3. |
| T16 | NOT-IMPLEMENTED | A dirty working tree is never reset or stashed over | Belongs to P3. |
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
| T27 | NOT-IMPLEMENTED | A changed original intent is revalidated before resuming | Belongs to P5 (continuation staleness). |
| T28 | NOT-IMPLEMENTED | A native extension asking for global secrets is refused or labelled | Belongs to P3. |
| T29 | PASS | A discovered but unauthenticated tool reports setup required | core.spec: "distinguishes 'needs a connection' from 'not installed'" |
| T30 | PASS | Denied/partial/expired OAuth produces an honest state | seams.spec: "reports partial consent instead of implying full access" |
| T31 | PASS | A callback after a cancelled setup does not activate anything | contracts.spec: pairing invite suite |
| T32 | BLOCKED | Google desktop OAuth uses the system browser | Needs a registered OAuth client. |
| T33 | PASS | A loopback callback on a headless server is caught as a mismatch | contracts.spec: checkRedirectReachable |
| T34 | PASS | An API key typed into ordinary chat is redirected to a secure route and redacted | seams.spec: credential vault suite and redaction test |
| T35 | PASS | A mismatched MCP token audience or redirect is rejected | seams.spec: "refuses to forward a token issued for a different resource" |
| T36 | PASS | A cached calendar is labelled with its last update, not as live | seams.spec: "labels cached data as cached rather than live"; e2e asserts the freshness badge in the DOM |
| T37 | NOT-IMPLEMENTED | A stale ETag conflict preserves the draft | Belongs to P7. |
| T38 | PASS | A calendar create timeout inspects before duplicating | seams.spec: "treats a submit timeout as unknown rather than repeating the create" |
| T39 | NOT-IMPLEMENTED | An agent-generated new action binds a discovered capability | Belongs to P2/P6. |
| T40 | PASS | An action naming a nonexistent tool is rejected | contracts.spec: "refuses to bind a capability the registry does not know"; core.spec: same |
| T41 | PASS | A widget cannot forge a host authorization card | seams.spec: "dropped a host card supplied by a non-host origin"; contracts.spec: surface provenance |
| T42 | NOT-IMPLEMENTED | A changed account or node rebinds and invalidates old consent | Belongs to P6. |
| T43 | PASS | A double click produces one accepted effect | core.spec: "refuses an invocation whose revision has moved"; storage dedup by invocation id |
| T44 | PASS | An invalid or oversized widget spec falls back and chat stays usable | seams.spec: "falls back to the text alternative"; e2e asserts the text fallback renders |
| T45 | PASS | A custom iframe cannot read host storage | seams.spec: "never grants a custom mini-app a same-origin luxury" |
| T46 | NOT-IMPLEMENTED | A user-authored note widget builds, previews, approves and persists a draft | Belongs to P6. |
| T47 | PASS | Pinning an inline widget keeps one logical instance | core.spec: "refuses a second live owner for the same instance" |
| T48 | NOT-IMPLEMENTED | Restoring a pinned media widget does not autoplay or join | Belongs to P6. |
| T49 | PASS | Unpinning a note preserves its data | e2e/j1.spec.ts: "pinning and unpinning keeps the widget data" asserts the instance survives the unpin |
| T50 | NOT-IMPLEMENTED | A disabled pack still shows a safe history snapshot | Belongs to P6. |
| T51 | NOT-IMPLEMENTED | A failed widget state migration recovers the old snapshot | Belongs to P6. |
| T52 | NOT-IMPLEMENTED | An offscreen widget's background polling is rate-limited | Belongs to P6. |
| T53 | PASS | A stale browser locator re-observes instead of clicking | seams.spec: "asks for re-observation rather than clicking a stale reference" |
| T54 | NOT-IMPLEMENTED | A page prompt injection cannot alter rights, consent or secret scope | Belongs to P8; needs an injection fixture. |
| T55 | NOT-IMPLEMENTED | A browser submit timeout does not trigger a second submit | Belongs to P8; the contract exists in automation.ts. |
| T56 | NOT-IMPLEMENTED | Human login takeover pauses agent input and capture | Belongs to P8. |
| T57 | PASS | A denied or revoked macOS permission reports unavailable without bypass | seams.spec: "keeps capture and input permissions separate on macOS" |
| T58 | PASS | A foreground window or DPI change is validated before input | seams.spec: "revalidates the foreground target before sending input" |
| T59 | PASS | A local emergency stop outranks a remote command via lease fencing | core.spec: "fences out a holder whose epoch is behind"; "records a local emergency stop" |
| T60 | PASS | A headless Linux node makes no native-desktop claim | seams.spec: "reports a Linux host without a display as unable to run a virtual desktop" |
| T61 | NOT-IMPLEMENTED | Virtual desktop access without session auth is rejected | Belongs to P8; needs the preview transport. |
| T62 | PASS | Quick play without provider credentials is clearly a sample | e2e/j1.spec.ts: "a suggestion produces a labelled sample with a real widget" asserts the host-owned label in a real browser |
| T63 | NOT-IMPLEMENTED | Skipped or restarted onboarding resumes without reinstalling | Belongs to P7. |
| T64 | PASS | A spoken interruption changes audio only and does not cancel the job | contracts.spec and seams.spec: barge-in routing |
| T65 | PASS | A mid-sentence correction is one task revision, not two effects | seams.spec: "emits one intent per completed utterance" |
| T66 | NOT-IMPLEMENTED | Voice and click reach the same widget action state | Belongs to P9; the semantic view contract exists. |
| T67 | PASS | Competing microphone owners are resolved explicitly | seams.spec: "refuses a second exclusive microphone owner and names the holder" |
| T68 | NOT-IMPLEMENTED | Mute and end actually stop capture and playback on the real transport | The local state machine is tested; the live transport belongs to P9. |
| T69 | PASS | Backup restore with version drift migrates or blocks, never corrupts silently | storage.spec: consistent backup and restore suite |
| T70 | NOT-IMPLEMENTED | Reaching a disk or budget limit stops new work safely | Belongs to P10. |
| T71 | NOT-IMPLEMENTED | Credentials are never copied between nodes implicitly | Connection ownership is modelled in the schema; enforcement belongs to P7. |
| T72 | BLOCKED | An unavailable vendor SDK yields a working fallback or an unsupported verdict | Needs a real vendor account. |

## Scope items

| ID | Status | Feature | What is real and what is not |
|---|---|---|---|
| V01 | PARTIAL | Conversation client | One timeline, one composer, pins and a shared React surface are implemented and verified in a real browser (8 Playwright tests). Voice and the desktop host are not built. |
| V02 | PARTIAL | Portable runtime | `apps/runtime` boots a node with its own identity and database on macOS and Linux, and the gateway refuses an unauthenticated request. The Unix-socket transport and OCI image are not built. |
| V03 | PARTIAL | Persistent task/session runtime | The full task/run/effect state machine, outbox/inbox durability and success gating are implemented and tested. The conductor and real worker pool are not wired. |
| V04 | PARTIAL | Trusted node linking | Envelope validation, identity checking, invite single-use and revoke are implemented and tested. Pairing between two live hosts is not exercised. |
| V05 | PARTIAL | Remote collaboration | Delivery semantics, dedup and grant narrowing are implemented and tested. A live two-node delegation is not exercised. |
| V06 | PARTIAL | Workspace registry | Node-qualified resource references, locality routing and lease serialization are implemented and tested. Explicit file transfer is not built. |
| V07 | PARTIAL | Capability platform | The registry with independent readiness facets, lazy schema loading and node resolution is implemented and tested. Live MCP transport is not built. |
| V08 | PARTIAL | Conversational install | Plan creation, join-or-create, digest-bound consent, generation activation and rollback are implemented and tested. Quarantine download and isolated build are not built. |
| V09 | PARTIAL | Credential/auth setup | An encrypted vault, redaction, PKCE generation, state comparison, scope verification and endpoint allowlisting are implemented and tested. A live token exchange is not built. |
| V10 | PARTIAL | Reference integration (Google Calendar) | Scope planning, time normalisation, agenda building, conflict detection, write-outcome classification and freshness labelling are implemented and tested. No live account is connected. |
| V11 | PARTIAL | Rich built-ins | Line and bar charts, a sortable table and a local note render from descriptors and are verified in a browser. Most of the 18 catalog families are not built. |
| V12 | PARTIAL | Custom widgets | The bridge codec, nonce validation, sandbox/CSP policy and props validation are implemented and tested. The mini-app runtime is not built. |
| V13 | PARTIAL | Pins | Pin persistence, single-live-owner enforcement and the pin shelf work and are verified in a browser. Restore-without-autoplay and duplicate-media cases are not built. |
| V14 | PARTIAL | Browser Use | Target description, locator staleness, operation support and the shared safety review are implemented and tested. The Playwright binding and browser engine are not installed. |
| V15 | PARTIAL | Computer Use | Permission gating, containment labelling, target validation and profile validation are implemented and tested. The native bindings need a signed bundle and a container engine. |
| V16 | PARTIAL | Onboarding/personalisation | Quick play works with no credentials and is labelled as sample in a host-owned card, verified in a browser. Needs-based setup and preference undo are not built. |
| V17 | PARTIAL | Live voice | Transcript assembly, intent routing, media-focus arbitration and mute/end semantics are implemented and tested. The WebRTC transport needs a provider account. |
| V18 | PARTIAL | Operations/security | Seven forward-only migrations, verifiable consistent backup, restore compatibility checks, credential redaction and durable dedup are implemented and tested. Failure injection and soak testing belong to P10. |

## Summary

Acceptance tests: 46 pass, 4 blocked, 22 not implemented (of 72).
Scope items: 18 partial, 0 not implemented (of 18).

No scope item is claimed as complete. The layers that are implemented are tested; the
layers that are not are named individually rather than hidden behind a percentage.


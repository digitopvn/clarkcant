# Research & Architecture Decisions

> English (default) · [Tiếng Việt](research-and-decisions.vi.md)

**Verified:** 16/09/2026, official upstream documentation. **Not yet done:** running the codebase, installing the packages into the product, live OAuth/voice/desktop-driver benchmarks or certifying vendor integrations. `latest` URLs/`main` branches can change; P0 must pin the exact versions/commits that were tried.

## 1. Research results that directly affect scope

| Upstream finding | Design impact |
|---|---|
| Pi supports SDK embedding, resources and extensibility; code extensions have process-level permissions [R01–R04] | Keep the Pi adapter; do not put untrusted native extensions into the privileged core |
| Pi has resource reload through the command context and dynamic tool registration [R03] | Reload targets the correct facet/worker; do not restart the whole app for every integration |
| Chord has facets/services/state but does not define the whole app transport [R05] | Candidate composition runtime, not a shortcut for federation/security |
| MCP Apps has isolated UI + host messaging [R06–R08] | Add a standard lane for third-party mini-apps, not only a fixed catalog |
| MCP auth depends on capability/metadata; registry identity is not a code audit [R09,R30] | Discover and validate for real; install/readiness has consent and probes |
| A2A targets task/message/artifact interoperability [R10] | Use an external-agent adapter later; native NodeLink keeps app semantics |
| Playwright MCP relies on structured accessibility and is not a security boundary [R11] | DOM-first browser driver, isolation/policy owned by the host |
| Browser Use is a stack with SDK/CLI/hosted options [R12] | Optional implementation; do not force every runtime to add another planner/backend |
| Computer-use examples need a desktop/browser environment and controls [R13–R16] | Native macOS and Linux virtual desktop are two different targets |
| Google installed-app OAuth uses the system browser, client registration and supported redirects [R18] | The conversation guides auth but does not embed consent arbitrarily |
| Google native and web auth differ in scopes/flow [R18–R20] | Request least scopes; reauth correctly for the client type, do not assume universal incremental auth |
| Vendor player/call/message/editor have account/platform/SDK limits [R22–R25] | A rich SDK ≠ every vendor app working immediately on every client |
| Electron privileged renderer/IPC needs hardening; node:vm is not security [R26–R27] | Custom UI runs on an isolated origin; tool code isolation at the OS/service boundary |
| Existing private-network connectivity already handles direct/relay paths [R28] | Optional adapter; do not build a custom internet relay in the first release |
| Voice separates frontend and delegated backend [R29] | Voice does not own task state; a Pi reload does not cancel the media session. The provider is now Gemini Live, not GPT-Live: [ADR-001](research/adr-001-gemini-live-provider.md) |

## 2. ADR v2

### ADR 2026-09-17 — optional native deps for semantic search, and the decision to stay FTS-only

`node:sqlite` needs no build step, so storage has no compiled dependency to audit. Semantic
retrieval, however, needs two native pieces: `sqlite-vec` (a loadable extension, prebuilt per platform) and an ONNX
runtime for the embedding model. Decision: declare them as **`optionalDependencies`**, and turn "missing" into
a state with a reason instead of an install error.

- `pnpm install` and `pnpm verify` must pass without either of them. Search is then pure FTS5, and the node
  prints the reason (`sqlite-vec is not installed`, `the local embedding runtime is not installed`).
- The vector table (`history_vec`) is **not** created in a migration: `vec0` can only be created on a connection that has loaded
  the extension, and migrations run on every machine. The migration only creates `history_embeddings_meta` (plain SQL);
  the vector table is created lazily when the extension is present. If it lived in a migration, a database created on a machine
  without the extension would permanently lack the vector table.
- Model changes → **reindex**; do not mix vectors from different models: the index records `model`/`dims`/`digest` on each
  vector and refuses when the current model differs.
- `onnxruntime-node` is added to `allowBuilds` (postinstall downloads the platform runtime). This is a deliberate
  exception to the supply-chain policy, not a loosening of the general policy.

**Measured on the Phase 8 corpus (34 queries, 15 history rows, quantized E5-small, sqlite-vec v0.1.9):** pure FTS
gets top-1 right 31/34; hybrid is also 31/34 with a cosine ceiling = 0.1, and drops to 25/34 with a ceiling ≥ 0.2 because
KNN always returns the nearest neighbour even when the question has no correct result. The "semantic-only" subset (12
queries with no vocabulary overlap) does not improve: 9/12 on both paths. **Conclusion: hybrid does not improve results on
this corpus, so `CLARKCANT_SEARCH_SEMANTIC` is off by default**; the hybrid code stays behind the flag to be measured again when
there is a larger corpus or a better model.

### ADR 2026-09-19 — autonomous execution by default, and authority sits in the host, not in the approval card

In the state before this decision, `run_command` used the approval card as its main security boundary: `guardCommand()` in `apps/runtime/src/run-command.ts` had already dropped the directory restriction and stated the reason itself ("the node no longer restricts directories, so this approval card is where you decide"). Removing approval and then handing the decision to Jev would make Jev the only security boundary — a model doing that job is a rejected architecture.

Decision: switch the default to autonomous, and authority stays in the host.

- **Host preflight is a hard invariant.** Schema, capability existence, resource existence, budget (timeout, output cap, number of targets) and the secret boundary run before any model decision; no model can override them. **Containment by resource ownership** belongs to this layer: an effect must stay within resources that the conversation/node owns, and anything outside is rejected at preflight.
- **Jev may only narrow.** It returns `allow`/`deny`/`constrain`/`clarify` on an operation that preflight has already determined to be technically valid; it does not grant permissions, does not widen scope, does not read secret values.
- **`ExecutionPolicy` replaces the approval boolean:** `auto | guarded | confirm | deny`, default `guarded` — does not ask the user, Jev may block/constrain. `confirm` reproduces the old approval behavior exactly as a policy mode, so the approval infrastructure is not deleted in the first phase; change the default first, keep the old path for regression, and only then demote it to optional.
- **Fail-open when Jev is absent** is the default and can be changed in settings. Fail-open drops the judgment layer, never preflight or containment.
- **`clarify` is not asking for permission.** A clarifying question between several possibilities that are all valid goes through the Interaction Manager (§7.5 system-architecture); “do you allow this?” is not clarify.

Trade-off: autonomous by default reduces friction but increases the blast radius when the model is wrong. This is offset by containment, budget, secret isolation, emergency stop and audit trail — not by confirmation dialogs.


|---|---|---|
| B01 | Portable Node runtime + shared web UI + optional Electron | Drops desktop-only coupling; adds a package/platform matrix |
| B02 | One home/conversation, autonomous execution peers | No multi-master/automatic offline failover; clear authority |
| B03 | Native NodeLink for the same app; MCP/MCP Apps interoperability | Do not force A2A into being the protocol carrying all UI/state |
| B04 | HTTPS/private-network reachability, app pairing/grants | Do not build our own NAT/crypto/relay right away; the operator needs a suitable endpoint/network |
| B05 | Core owns permissions/state/lifecycle; domain/OS features are packs | Core does not contain every integration but keeps the trust invariants |
| B06 | Agent-defined actions: view/invoke/agent/workflow | Drops the fixed business-button limitation of v1; keeps server authorization |
| B07 | Rich catalog + isolated custom apps/MCP Apps | Adds SDK/sandbox/conformance cost to genuinely open the ecosystem |
| B08 | Pinned instances independent of task/session | State migrations/media ownership/refresh policies are first-class |
| B09 | Research/install/test/activate/reload/resume through chat | Adds a supply-chain/executable-code boundary, not “npm install and done” |
| B10 | Browser Playwright + optional driver alternatives | Keep the Pi planner; do not require cloud/Python/another agent loop |
| B11 | macOS native + Linux virtual desktop drivers | Computer Use is in scope, platform permissions are a release gate |
| B12 | Auth broker and reference Calendar connector | Do not claim every SaaS connects automatically when app registration/auth is missing |
| B13 | Guided onboarding or clearly labeled quick play | No key required to see the sample; real AI still needs a valid provider |
| B14 | Version-pinned optional Chord spike | Do not reimplement the toolkit if it fits; also do not lock in a framework that has not been tried |
| B15 | Native mobile/marketplace/cross-owner federation later | The foundation release is still large but does not build every business layer |
| B16 | Autonomous execution by default; approval demoted to the `confirm` policy mode | Drops the approval card as a security boundary, so containment + budget + stop/audit must replace it |
| B17 | Host preflight keeps authority; Jev may only narrow | The model does not decide permissions; when Jev is absent, judgment is lost but control is not |

## 3. What still has to be measured/verified before code lock

Exact Pi SDK/resource loader version; pack compatibility on macOS/Linux x64/arm64; Chord failure/reload semantics; provider account/model access; Electron isolation/media/DRM support; Google OAuth app registration/verification; native driver signing/TCC; rootless sandbox support per host; actual remote reconnect/failure behavior.

These are **implementation gates**, not a denial of scope. A failure requires fixing the adapter, replacing a dependency or a clear ADR; do not quietly delete a feature while still reporting it as complete.

## 4. Official sources

Each Rxx confirms the corresponding upstream information; it does not confirm that the blueprint's own named APIs already exist. Many Rxx entries list two pages from the same documentation set to make detailed checking easier.

### R01 — Pi repository / permission philosophy

https://github.com/earendil-works/pi

SDK/resource extension model and the process-level trust warning. Do not treat Pi as a ready-made permission sandbox.

### R02 — Pi SDK

https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sdk.md

Custom application embedding, session/resources/tools. Pin the API contract with integration tests before implementation.

### R03 — Pi extensions

https://pi.dev/docs/latest/extensions

Command-context `ctx.reload()`, lifecycle, registerTool and active tools. Dynamic registration and resource reload are two different things.

### R04 — Pi packages

https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/packages.md

Package/resource discovery, source formats and trust implications. The app install supervisor adds its own controls.

### R05 — Chord

https://raw.githubusercontent.com/earendil-works/pi/main/packages/chord/README.md

Facet/service/state/reload toolkit; the app supplies the transport envelope. A bundler/loader does not replace package installation or OS isolation.

### R06 — MCP Apps overview

https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html

https://apps.extensions.modelcontextprotocol.io/api/

Tool-linked UI resources and the interactive host bridge. App-defined pins/state ownership are extension product behavior; this does not claim MCP Apps provides them out of the box.

### R07 — MCP Apps permissions / CSP

https://apps.extensions.modelcontextprotocol.io/api/interfaces/app.McpUiResourcePermissions.html

https://apps.extensions.modelcontextprotocol.io/api/interfaces/app.McpUiResourceCsp.html

Requested browser capabilities/CSP constraints; the host must implement them and may refuse unsupported permissions.

### R08 — MCP Apps authorization

https://apps.extensions.modelcontextprotocol.io/api/documents/authorization.html

Auth/data resource audience and host responsibility.

### R09 — MCP authorization specification

https://modelcontextprotocol.io/specification/latest/basic/authorization

Latest as checked on the date above; client/server must negotiate a supported discovery/registration flow, do not assume auto-DCR on every server.

### R10 — A2A specification

https://a2a-protocol.org/latest/specification/

Agent task/message/artifact interoperability. Not used as the primary NodeLink in this baseline.

### R11 — Playwright MCP

https://github.com/microsoft/playwright-mcp

https://playwright.dev/mcp/introduction

Structured accessibility/tools; security boundary disclaimer. A direct Playwright adapter is the app's decision, not a default Pi feature.

### R12 — Browser Use

https://github.com/browser-use/browser-use

https://docs.browser-use.com/open-source/introduction

https://docs.browser-use.com/open-source/quickstart

Browser automation project and available integration routes. Verify the selected backend/dependencies instead of inferring from the capability name.

### R13 — OpenAI computer use

https://developers.openai.com/api/docs/guides/tools-computer-use

https://github.com/openai/openai-cua-sample-app

Isolated environments, untrusted screen content and tool integration. Do not assume the native computer-tool protocol is automatically compatible with Pi.

### R14 — Anthropic computer use / reference desktop

https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool

https://github.com/anthropics/anthropic-quickstarts/blob/main/computer-use-demo/README.md

Computer actions and the reference desktop environment. A virtual desktop has its own deployment/lifecycle.

### R15 — Peekaboo

https://github.com/openclaw/peekaboo

https://peekaboo.sh/

macOS screenshots/UI automation candidate. Version/signing/permissions/host behavior need a spike; not a guaranteed drop-in.

### R16 — Apple Accessibility consent

https://support.apple.com/guide/mac-help/allow-accessibility-apps-to-access-your-mac-mh43185/mac

User-controlled permission workflow; the app does not turn on permissions on the user's behalf.

### R17 — Docker rootless

https://docs.docker.com/engine/security/rootless/

Rootless daemon/containers have prerequisites; a non-root image does not by itself mean the whole engine is rootless. Do not treat a container as a universal VM security guarantee.

### R18 — Google OAuth native apps

https://developers.google.com/identity/protocols/oauth2/native-app

System-browser flow, PKCE, supported redirects, client prerequisites, scope/embedded-browser limitations.

### R19 — Google OAuth web server

https://developers.google.com/identity/protocols/oauth2/web-server

Server-side callback/token custody and client registration. A headless-server deployment does not implicitly reuse the laptop loopback.

### R20 — Google Calendar authorization

https://developers.google.com/workspace/calendar/api/auth

Calendar-specific scopes and authorization requirements.

### R21 — Google Calendar sync / push

https://developers.google.com/workspace/calendar/api/guides/sync

https://developers.google.com/workspace/calendar/api/guides/push

Incremental sync, watch/channel/receiver requirements; a snapshot pin differs from a live subscription.

### R22 — Notion authorization

https://developers.notion.com/guides/get-started/authorization

Integration/page access and authorization; not an automatic permission to read/edit every workspace.

### R23 — Spotify Web Playback SDK

https://developer.spotify.com/documentation/web-playback-sdk

https://developer.spotify.com/documentation/web-playback-sdk/tutorials/getting-started

Playback SDK/browser/account requirements; iframe media policy and commercial-use restrictions must be evaluated separately.

### R24 — Telegram bot / user application distinction

https://core.telegram.org/bots/faq

https://core.telegram.org/api/obtaining_api_id

Bot capabilities differ from user-client APIs/auth. A bot token is not access to the user's entire inbox.

### R25 — Zoom Meeting SDK web

https://developers.zoom.us/docs/meeting-sdk/web/

https://developers.zoom.us/docs/meeting-sdk/web/component-view/

Embedded human meeting UI; supported views/platforms and the difference from AI notetaker/realtime-media integrations.

### R26 — Electron security

https://www.electronjs.org/docs/latest/tutorial/security

Isolation/sandbox/CSP/IPC boundary for the desktop shell and remote content.

### R27 — Node VM

https://nodejs.org/api/vm.html

`node:vm` is not a security mechanism for untrusted code.

### R28 — Tailscale connections

https://tailscale.com/docs/reference/connection-types

https://tailscale.com/docs/features/peer-relay

Direct and relay connectivity. Application-level grants are still needed even on a private network.

### R29 — GPT-Live

https://developers.openai.com/api/docs/guides/live

https://developers.openai.com/api/docs/guides/live-delegation

Voice frontend, delegated backend and app responsibilities for context/cancellation. Account/model/version access needs real testing.

The frontend/backend separation principle above still holds, but **the provider choice has been replaced**: voice runs on Gemini Live with a node-side proxy ([ADR-001](research/adr-001-gemini-live-provider.md), 2026-09-17).

### R30 — MCP Registry

https://modelcontextprotocol.io/registry/about

Discovery metadata and namespace trust; no registry table replaces the app's source/code/security review.

## 5. How to update the research set

P0 stores the tested version/commit/model IDs, access date, selected dependencies/license and compatibility cases in the real repo. When upstream changes an API, update the adapter and recorded contracts. Do not copy `latest`/`main` into the runtime dependencies as a production lock.

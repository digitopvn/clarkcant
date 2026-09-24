# Scope Lock v2 — Conversation-first, runtime-anywhere

> English (default) · [Tiếng Việt](scope-lock.vi.md)

**Date:** 16/09/2026 · **Target release:** v0.2 foundation beta. “v2” is the blueprint version, not a released software version.

## 1. North star

The user assigns work, customizes the app, connects services, installs extensions and creates/pins mini-apps through conversation. They do not need to learn sessions, MCP config, processes, node topology or multi-level settings pages. Chat, voice and widgets are three ways to interact with the same system, not three products.

Minimalism means **reducing decision effort**, not forcing every operation into words. A play button, a secure sign-in form, a date picker, a stop button and pin are valid; a session sidebar, a mandatory file tree and a permanent admin dashboard are not.

## 2. Product boundary

The app consists of **Agent Runtime + Conversation Client + Capability Packs + optional Connectivity Adapter**. Electron is only the desktop shell. An install on a VPS does not install Electron and does not run a virtual desktop just to get a chat frame.

Each runtime install is an **autonomous node** with its own state, credentials and resource scope. The desktop can use a local node, attach a server node, or use a home node to coordinate paired nodes. The home role is per conversation; there is no fixed “master” machine for the whole network.

Initial audience: one owner with one or more machines/VPSes. The architecture has owner/principal/scopes but is not yet an adversarial multi-tenant SaaS or a complete enterprise internal sharing tool.

## 3. Locked decisions

| Issue | v2 decision |
|---|---|
| Stack | TypeScript across client/runtime; Node LTS + Pi SDK; React; Electron only for desktop |
| VPS | Non-root OCI image, persistent volume; native headless package/service is the second path; web chat uses the same UI |
| Persistence | SQLite + outbox/inbox on each node; no syncing SQLite via shared volume or multi-master |
| Peer communication | Native versioned command/event/delegation protocol, TLS and app-level pairing; A2A is a later interoperability adapter |
| Connectivity | Reachable HTTPS endpoint or Tailscale private-network adapter; do not build NAT traversal/crypto from scratch |
| Rich UI | Fast declarative catalog + sandboxed mini-app runtime; MCP Apps are brought into scope |
| Widget actions | The agent defines actions from discovered capabilities, agent intent, workflows or local view actions; core validates/authorizes |
| Pin | Pin instance/state to a small area in the conversation; does not open a separate dashboard or a new agent |
| Extensions | Research → proposal → consent → staged install → test → activate/reload → resume; user-authored packages are supported |
| Browser Use | First-party pack based on Playwright; API/DOM-first, screenshots when needed; binary downloaded on demand |
| Computer Use | Optional first-party driver packs: macOS desktop + Linux virtual desktop; core keeps lease, permissions, cancellation |
| Auth | Guided flow in chat, but OAuth/OS consent may open the system browser/settings and then return |
| Onboarding | Two paths: quick play with a clearly labeled sample, or needs-based setup; no long questionnaire |
| Voice | Gemini Live (`gemini-3.8-live`) behind a node-side WebSocket proxy on a verified account; same command gateway; voice does not restart when Pi reloads. Provider changed away from GPT-Live per [ADR-001](research/adr-001-gemini-live-provider.md) |
| Personalization | Preferences/skills/recipes/widgets/extensions; scope/source/undo; no hidden memory |

## 4. IN — complete in v0.2 foundation beta

| ID | Feature | Acceptance boundary |
|---|---|---|
| V01 | Conversation client | One timeline/composer; text/voice/actions; shared React UI desktop/web; no session picker needed |
| V02 | Portable runtime | macOS helper and Linux headless; server runs without GUI/global Pi; version/health reporting |
| V03 | Persistent task/session runtime | Conductor responsive, worker budgets; task≠session; resume/steer/cancel/evidence |
| V04 | Trusted node linking | Pair/revoke/inspect via chat; local + two VPS test topology; scoped capability discovery |
| V05 | Remote collaboration | Delegate/subtask/status/artifacts/input requests; stable IDs, retry dedup, reconnect; no blind failover write |
| V06 | Workspace registry | Node-qualified paths/resources, aliases, roots; one writer/resource; explicit file transfer |
| V07 | Capability platform | API/MCP/Pi/native/UI facets; lazy discovery; install plan, exact versions, dependency lifecycle |
| V08 | Conversational install | Source research → consent → sandboxed staging or explicit trusted-host path → healthcheck → activate → resume |
| V09 | Credential/auth setup | Secure input, browser OAuth, scopes, connection test, revoke/reauth; secrets do not enter the chat transcript |
| V10 | Reference integration | Google Calendar: connect, choose calendar, read agenda, create/edit event with preview/consent; refresh/reconnect |
| V11 | Rich built-ins | Rich catalog in widgets-and-extensions; interactive actions, source/freshness and accessibility |
| V12 | Custom widgets | Chat-authored catalog compositions; user/third-party executable UI in isolated mini-app host; MCP Apps bridge |
| V13 | Pins | Persistent logical instance, compact/expanded mode; no duplicate player/call; pin does not grant background privileges |
| V14 | Browser Use | Managed profile, DOM tools + screenshot, browser preview/takeover, capability & outcome checks |
| V15 | Computer Use | One macOS driver and one Linux virtual-desktop profile; app/window scope where enforceable; explicit foreground consent |
| V16 | Onboarding/personalization | Quick play, needs-based setup, skip/resume, minimal useful install plan; preference undo |
| V17 | Live voice | Natural interruption/correction; same surface/action/task state; text fallback; media focus coordination |
| V18 | Operations/security | Upgrade/drain, backups, rollback of package activation, telemetry redaction, resource budgets, failure injection |

“Reference integration” does not forbid installing other connectors. It names the integration the product itself must prove works end-to-end for release; other services run through the extension protocol subject to actual compatibility and permissions.

## 5. OUT — still deliberately not done

Native mobile client, Windows desktop release, realtime/CRDT multi-user collaboration, multi-master timeline, automatic failover of side effects to another node during a partition, syncing all sessions/secrets between machines, public unauthenticated agent endpoint, custom internet-wide peer discovery, marketplace/payment/review social network, self-patching the core app, unbounded swarm spawning.

No commitment that the product has full Spotify/Telegram/Zoom/Notion integrations on day one. The SDK and host must be able to express those use cases; examples and conformance tests prove the capability. Vendor policy, OAuth approval, SDK/browser support and account permissions remain separate gates.

Rewriting a browser engine, media conferencing server or native automation engine is not required. Reuse proven drivers/SDKs through adapters. An arbitrarily iframeable webpage is not treated as a “third-party integration”.

## 6. Minimal but not weak core

Core: identity/policy/consent; commands/events; task/effects; capabilities/install supervisor; integration/auth vault; surface/state/pin/action host; node transport; resource leases/cancel; retention/budget. This is shared infrastructure so extensions do not build a second system of their own.

Pack: domain tools, API adapter, MCP server config, Pi skills/extensions, widgets, browser/computer drivers, onboarding recipes. A driver may not be installed, but its contract and corresponding permissions already exist in core.

## 7. Golden journeys

**J1 — curious:** open the app → choose try now → interact with a sample chart/map/note → pin → understand how to chat; no API key needed for the scripted sample. To chat with real AI, set up a provider in the same flow; do not disguise the demo as real inference.

**J2 — personal calendar:** “Show my calendar this week” → the app chooses a suitable integration → asks for consent → auth in a trusted browser → probe → real calendar → pin → say “move this event” → mutation preview → confirm → verify.

**J3 — install what is missing:** the task recognizes it needs a capability → the app researches → proposes one option with source/version/permissions → user agrees → stage/test → activate on the right node → reload the right worker when needed → continue on the right task revision.

**J4 — multiple machines:** the desktop asks VPS A to build, VPS B checks another environment per permissions → results/artifacts come back to the same chat; when the desktop closes, remote jobs do not die. Network loss does not turn into fake progress or a duplicate run.

**J5 — custom mini-app:** “Create a checklist note widget and pin it” → composition or isolated bundle → preview/test/approve → pin; restart still keeps the draft, does not auto-grant filesystem/network.

**J6 — browser/computer:** the API lacks an operation → the app proposes a managed browser; if a desktop app is needed, choose the right device, ask for foreground/capture/input → preview/takeover → stop via host control; never click consent with the computer tool.

## 8. Definition of done

V01–V18 trace to milestones/tests. J1–J6 run on clean environments, with at least one real provider/connector and evidence of two VPSes coordinating. The whole UI can be operated through chat together with the required system/native consent. Prototype videos do not replace fault/recovery tests.

Features that have not passed an API/account/signing/driver gate must be recorded as blocked, not renamed “supported” to make the release. The expanded scope is deliberate; implementation order follows dependencies, not forcing everything into one PR.

# Changelog — constraints v1 superseded in v2

> **Note on provenance.** This file is listed in `docs/manifest.json` and linked from
> `docs/README.md` as required reading, but it was absent from the document set as
> delivered. The content below was **reconstructed** from the ADR table in
> [`research-and-decisions.md`](research-and-decisions.md) §2 and the scope changes recorded
> in [`scope-lock.md`](scope-lock.md) §3. It is grounded in those documents rather than
> newly invented, but it is a reconstruction and not the original file. The
> `docs/manifest.json` entry for this path was updated to match the reconstructed content,
> and the substitution is recorded in the manifest's `reconstructed` field.

v1 constrained the product to a desktop application with a helper process. v2 makes the
runtime the product and the desktop shell one client of it. The entries below are the
constraints v2 removes, and the decision that removes each one.

## Constraints that no longer apply

| v1 constraint | v2 decision | ADR |
|---|---|---|
| Desktop-only; a server would be a later port of the helper | Portable Node runtime with a shared web UI and an optional Electron shell | B01 |
| A cloud account of the application developer was required to run more than one node | Nodes pair directly; two nodes do not require a vendor account | B01, B04 |
| One writable authority implied a shared database | Each node owns its own database; continuity comes from delegation and presentation | B02 |
| A generic agent protocol was expected to carry UI, state and permissions | Native NodeLink for the application; MCP and MCP Apps for interoperability | B03 |
| NAT traversal, relay and cryptography were to be built in-house | Reachability is HTTPS or an existing private-network adapter; app-level pairing and grants are the part that is built | B04 |
| Integrations lived inside the core application | Core keeps authority, state and lifecycle; domain and OS features are packs | B05 |
| Each button needed application-authored business logic | Agent-defined actions: view, invoke, agent intent, and bounded workflow | B06 |
| Widgets were a fixed, application-shipped catalog | Rich catalog plus isolated custom mini-apps and MCP Apps | B07 |
| Pins were a view over the active task or session | Pinned instances have their own lifecycle, independent of tasks and sessions | B08 |
| `npm install` was considered an adequate installation story | Research, consent, staged install, test, activate, reload and resume through chat | B09 |
| Browser automation required a second agent loop or a hosted backend | Playwright primitives with Pi remaining the planner | B10 |
| Computer Use could be researched later | One macOS driver and one Linux virtual-desktop driver are release scope | B11 |
| Integrations were assumed to connect without an application identity | An auth broker and a reference Calendar connector, with registration and verification as explicit gates | B12 |
| Onboarding was a questionnaire | Guided setup or clearly labelled quick play | B13 |
| A composition toolkit would be adopted wholesale, or rejected outright | A version-pinned optional Chord spike behind `FacetHost` | B14 |
| Native mobile, a marketplace and cross-owner federation were in scope | Deferred; the foundation release is still large without building every business layer | B15 |

## Constraints v1 got right and v2 keeps

These were **not** relaxed. They are restated here because the entries above change so much
that it would otherwise be easy to read them as removed:

- Authority comes from the authenticated transport, never from a field inside a payload.
- A model, a website, a package README, an MCP description or a screenshot never grants a
  permission, changes an OAuth endpoint, or approves its own effect.
- Long-lived credentials do not reach the model, the transcript, or an ordinary renderer.
- A worker going idle, an LLM finishing a turn, or a socket closing is not success. Only
  recorded evidence is.
- An external effect whose outcome is unknown is never silently retried.
- Custom UI code does not run in the privileged application origin.
- Browser and computer control never completes an OS consent, an OAuth authorization, a
  CAPTCHA or a second factor on the user's behalf.
- Claims about supported platforms and integrations carry version, platform and account
  evidence, or they are reported as blocked.

## Superseding the plan itself

v1's milestone plan is replaced by the P0–P10 dependency graph in
[`implementation-plan.md`](implementation-plan.md) §2. The order is by dependency rather
than by screen, so no milestone waits on a finished UI.

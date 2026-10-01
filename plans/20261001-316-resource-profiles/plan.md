---
title: "#316 Resource profiles, service egress broker and browser token broker"
status: in-progress
created: 2026-10-01
issues: [316]
related: [200, 221, 231, 313, 314, 315, 319, 320, 332]
---

# #316 Resource profiles, service egress broker and browser token broker

## Outcome

A package asks for a host-defined resource profile, and the node decides what it grants from consent, policy and its
own capacity. The granted profile sets the container envelope, the call and job deadlines, job concurrency, the
artifact ceiling, offscreen behaviour and the network (always none). A profile the node cannot grant degrades with a
reason a person can read, and never runs smaller in silence.

A service reaches the outside world only through the host. It declares the secrets and egress origins it needs, the
person consents at install, and the host makes each outbound request on the service's behalf, adding the credential
itself. The service never holds the secret, and a missing or revoked secret shows its capabilities as needing auth.

An isolated widget can be issued a short-lived, scoped browser token only when a host provider adapter says the
provider supports one. The token is bound to the consented instance and frame session, travels over a versioned bridge
message, expires, and is never put in props, state, logs or model context.

## Egress design decision (record for the PR)

The host makes the outbound request on the service's behalf over the existing stdio MCP channel, as a versioned
server-to-client request (`clarkcant/egress.fetch`, `version: 1`). The container keeps `--network none`. The
proxy-only network fallback is not built: no fixture or planned package needs raw sockets, and adding a network to a
container would weaken an isolation default, which needs the person's decision first.

## Constraints and non-goals

- `interactive-light` equals today's envelope exactly (256m, 1 CPU, 128 pids, 16 MB noexec `/tmp`, 60 s call,
  30 min job), so existing packages are unchanged. Larger profiles use reviewable defaults listed in the PR.
- No long-lived key or refresh token in a widget or container. No GPU passthrough (reported unavailable), no VM
  isolation, no real provider account (a local fake provider on a loopback origin), no reference apps.
- Jev/policy owns grants: no ad-hoc prompts. Consent covers the declaration; anything undeclared is refused.
- Every credential use is audited by name only, never by value or length.
- Applied migrations are immutable. This plan adds no migration: grants are derived, tokens live in memory.

## Dependencies

- #315 (job host, `maxActiveJobs`) and #314 (executor deadlines) are merged on `main`.
- #313 artifact broker supplies the artifact ceiling; an artifact must stay attachable, so no profile raises it.
- Unblocks #319, #320 and #332.

## Phases

| Phase | Status | Detail |
| --- | --- | --- |
| A Resource profiles | in-progress | [phase-01-resource-profiles.md](phase-01-resource-profiles.md) |
| B Service egress broker and real `needs_auth` | pending | [phase-02-service-egress-and-auth.md](phase-02-service-egress-and-auth.md) |
| C Browser token broker and dev-host simulation | pending | [phase-03-browser-token-and-dev-host.md](phase-03-browser-token-and-dev-host.md) |
| D E2E fixture with a fake provider, then docs | pending | [phase-04-e2e-and-docs.md](phase-04-e2e-and-docs.md) |

Phases run in order; each later phase builds on the manifest fields and host wiring of the earlier ones.

## Acceptance

- Unit: each profile maps to the expected container arguments; a refused or unavailable profile degrades with a
  reason; a manifest cannot grant itself a larger profile.
- Unit with a real engine: a service's memory and CPU limits follow its granted profile.
- Unit: the egress broker refuses an undeclared origin, adds the credential header only for the declared origin, and
  the secret never appears in the container's environment, filesystem, logs or the call's response; a missing secret
  shows `needs_auth`.
- Unit: a browser token is issued only to the bound instance and session, expires, is refused for a provider that does
  not support scoping, and never appears in state, logs or the prompt.
- E2E: a fixture package with a granted profile reaches a fake provider on a local origin through the egress broker;
  the frame never sees the key (DOM, bridge traffic and storage).
- `pnpm verify`, `pnpm verify:full`, `pnpm invariants` pass; CI green including Windows.
- Docs EN/VI (`widget-development` §14, `widgets-and-extensions` §9 and §12, `open-interfaces` for the new route and
  bridge message) and ledger rows V07 and V12. Official docs follow-up after merge.

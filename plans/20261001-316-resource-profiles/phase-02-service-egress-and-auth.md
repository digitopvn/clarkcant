# Phase 02 — Service egress broker and real `needs_auth`

## Context

- Issue: [#316](https://github.com/digitopvn/clarkcant/issues/316), scope B. #221 deferred a credential broker inside
  a service on purpose; this phase delivers it without giving the service the secret.
- `apps/runtime/src/secret-broker.ts` already has the `http-header` exposure, consumer allowlist and name-only audit.
- `packages/mcp-adapters/src/stdio.ts` treats every message with an id as a response; a server-to-client request must
  be told apart by its `method`.

## Requirements

- A tools facet declares `egress: { version: 1, secrets: [{ name, purpose }], origins: [{ origin, purpose,
  credential? }] }`. The manifest reader checks that a credential names a declared secret and a safe header.
- The stdio transport answers server requests through an injected handler and advertises the host request in
  `initialize` only when a handler exists. Unknown methods get JSON-RPC `-32601`.
- `clarkcant/egress.fetch` (`version: 1`): only a declared origin, only while a host call to that service is in
  flight, bounded body sizes, no redirects followed, no userinfo, forbidden headers stripped, the declared credential
  header added from `secret-broker` (`http-header`, consumer `package:<id>`, which the secret must list explicitly),
  the secret value redacted from anything returned, audited by origin and secret name only.
- `authenticated` becomes real: a declared secret that is missing, not stored for this package, or not allowed as a
  header marks every capability of the facet `authenticated: false` with the reason; the capability reads as
  `CAPABILITY_NOT_AUTHENTICATED` with that reason. Rechecked on every call, on each health ping and when credentials
  change.
- Stop: closing a service or the call's cancellation aborts its in-flight egress.

## Files to modify/create

- `packages/contracts/src/install.ts` (+ tests), `packages/mcp-adapters/src/stdio.ts` (+ tests).
- `apps/runtime/src/service-egress.ts` (new), `secret-broker.ts`, `service-host.ts`, `application/credential-vault.ts`,
  `routes/credentials.ts`, `bootstrap/runtime-bootstrap.ts`, `packages/core/src/capability-registry.ts`.
- Tests: `apps/runtime/test/service-egress.spec.ts` (new), `secret-broker.spec.ts`, `service-host.spec.ts`,
  `service-container-engine.spec.ts` (secret absent from the real container).

## Steps

1. Manifest schema and coherence rules with tests.
2. Transport server-request handling with tests (id collision with a pending request, unknown method, oversize).
3. Egress broker with a local HTTP server in tests: undeclared origin refused, header only for the declared origin,
   secret redacted, audit by name.
4. Service host wiring, readiness and credential-change refresh; real-engine check that the container's environment,
   filesystem and logs never hold the secret.

## Validation

- `corepack pnpm exec vitest run packages/contracts/test/install.spec.ts packages/mcp-adapters/test/stdio.spec.ts apps/runtime/test/service-egress.spec.ts apps/runtime/test/secret-broker.spec.ts apps/runtime/test/service-host.spec.ts apps/runtime/test/service-container-engine.spec.ts`

## Risks and rollback

- A provider echoing the credential would hand it to the service: the broker redacts the value from headers and body.
- A redirect to another origin would carry the header: redirects are returned, never followed.
- Roll back by reverting; services without an `egress` declaration behave exactly as before.

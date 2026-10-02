# Phase 03 — Browser-scoped token broker and dev-host simulation

## Context

- Issue: [#316](https://github.com/digitopvn/clarkcant/issues/316), scope C. The exception is documented in
  `docs/widgets-and-extensions.md` §9 and `docs/widget-development.md` §14 but not built.
- Follow the `jobs@1` bridge pattern (`packages/widget-sdk`, `packages/widget-host/src/session.ts`,
  `packages/conversation-client/src/WidgetFrame.tsx`, `DesktopSurfaces.tsx`, a node route).

## Requirements

- `packages/integration-sdk` records what a provider supports for browser tokens (scoped or not, maximum TTL, scopes,
  revocation). A request broader than that is refused; an unscoped provider is refused.
- A UI facet declares `browserTokens: { version: 1, providers: [{ provider, scopes, purpose }] }`; consent covers it.
- The node broker issues a token only to an instance whose active package declares the provider, bound to that
  instance and its frame session, with the TTL enforced. It keeps the provider's token id, never the value, and logs by
  provider and instance only. Uninstall, revoke and frame disposal stop refresh and revoke where supported.
- Bridge extension `tokens@1`: `token.request` and `token-result`, budgeted per frame. The host session refuses a
  state update or semantic publish carrying an issued token, so it cannot reach persisted state or the model.
- `clark widget dev` simulates the granted profile, a refused profile, and a token grant or refusal, labelled simulated.

## Files to modify/create

- `packages/integration-sdk/src/browser-token.ts` (new) and its index export.
- `packages/contracts/src/install.ts` (UI facet field).
- `apps/runtime/src/browser-token-broker.ts` (new), `routes/browser-tokens.ts` (new), `gateway.ts`, `services.ts`,
  bootstrap wiring, `application/package-lifecycle.ts` (revoke on uninstall), a loopback fake adapter in
  `test-support` behind a fixture flag.
- `packages/widget-sdk/src/index.ts`, `runtime.ts`; `packages/widget-host/src/session.ts`;
  `packages/conversation-client/src/WidgetFrame.tsx`, `DesktopSurfaces.tsx`, `api.ts`.
- `packages/widget-cli/src/dev-host.ts`, `dev-shell.ts`, new `dev-resources.ts`, tests.

## Steps

1. Adapter support contract and request check with tests.
2. Node broker and route with tests: bound instance and session, expiry, unscoped refusal, revoke, value absent from
   audit, state and prompt.
3. Bridge, SDK and host session with tests.
4. Dev-host controls and simulation with tests.

## Validation

- `corepack pnpm exec vitest run packages/integration-sdk apps/runtime/test/browser-token-broker.spec.ts packages/widget-sdk packages/widget-host packages/widget-cli/test`

## Risks and rollback

- The token reaches the frame by design; the risk is it spreading further. The session guard and the SDK both refuse
  it in state and semantic output, and the broker never stores the value.
- Roll back by reverting; the extension is only offered when the host wires it.

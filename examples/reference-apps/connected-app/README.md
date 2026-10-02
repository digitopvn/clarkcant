# Connected tasks (reference app)

A package that works on a person's account at a provider without ever holding it: a widget that lists tasks and
renames one, a service that calls the provider, and skills that tell Clark how. It is the shape
`clark widget init --template connected-app` starts from.

The provider here is a **fake connector** (`dev/fake-connector.mjs`): a test and development fixture with a tiny
OAuth server and a tiny task API on loopback. It has no real account and no client secret, and every code and token it
issues is a random test value kept only in its memory. A real provider replaces it (tracked in
[digitopvn/clarkcant#333](https://github.com/digitopvn/clarkcant/issues/333)).

- **One connection, declared.** The tools facet declares `connection`: the provider, the public client id, the
  authorization, token and revocation endpoints, the scopes with what each is for, the endpoints the service may reach
  with the account, and a probe. Each capability names the scopes it needs (`requiredScopes`).
- **The host connects.** A person presses *Connect* in Settings. The node starts a PKCE authorization with a single-use
  state and the client opens the provider in the system browser, never in the widget. The provider redirects to the
  node's loopback callback; the node exchanges the code, checks the granted scopes and the probe, and keeps the tokens
  in its own table.
- **The node signs.** The service runs with no network and no token. It asks the node with `clarkcant/egress.fetch`
  for a URL on a declared endpoint; the node adds `authorization: Bearer …` itself, only while one of the service's
  calls runs, refreshes a token about to lapse, and treats a provider's 401 as a revoked connection after one refused
  refresh. It never retries a request.
- **Readiness says why.** A capability is not ready while the connection is missing, expired or revoked, or did not
  grant a scope it needs, and the reason names it — for example
  "the Fake Tasks (test fixture) account did not grant tasks.write; reconnect it in Settings and allow it". The widget
  shows that reason; it sees only status.
- **One capability path.** The widget's buttons, Clark's `invoke_capability` and a spoken action call the same
  capabilities, through the same policy and the same audit trail. `update-task` is `external-write`: the person's
  execution policy decides it, and a rename whose answer never came back is recorded as unknown and not retried.

## Files

- `clarkcant.json` — the manifest: the UI facet first, the service with its connection, the skills.
- `widgets/main/` — the frame: `main.js` (DOM and SDK calls), `tasks-core.js` (what it reads from the service's
  answers, as pure functions), `widget.json`, `main.css`.
- `service/server.mjs` — the MCP server over standard streams. No dependencies.
- `skills/tasks/SKILL.md` — how Clark uses the two capabilities.
- `dev/fake-connector.mjs` — the fake provider (port 8880) and its admin listener (port 8881, for tests only).
- `dev/service-harness.mjs` — a stand-in for the node, to test the service on its own.
- `test/service.test.mjs` — the service against the fake connector; portable, so a scaffolded copy keeps it.
- `fixtures/` — the four prop sets the conformance suite requires.

Only the repository's scripted fixture model places the widget with its two bindings (`listBinding`,
`updateBinding`) today, as with the text editor; see
[digitopvn/clarkcant#382](https://github.com/digitopvn/clarkcant/issues/382).

## Check it

```sh
node packages/widget-cli/src/cli.ts widget test examples/reference-apps/connected-app
node packages/widget-cli/src/cli.ts widget pack examples/reference-apps/connected-app
node --test examples/reference-apps/connected-app/test/service.test.mjs
corepack pnpm exec vitest run examples/reference-apps/connected-app
```

To try it on a node, start the fake connector (`node examples/reference-apps/connected-app/dev/fake-connector.mjs`)
and run the node with `CC_EGRESS_ALLOW_PRIVATE_NETWORK=1`, since its endpoints are loopback. The browser journey —
connect, read and write from the widget, the same capability from Clark and from voice, revoke, reconnect, a partial
grant, a write that times out, and no token anywhere a widget, the model or a log can see — is
`apps/web/e2e/connected-app.spec.ts`.

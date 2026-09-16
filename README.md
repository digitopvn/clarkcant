# clarkcant

Conversation-first agent platform: a portable runtime that anyone can install on their
own machine or VPS, plus paired execution nodes, rich widgets in the conversation, and
capability packs that install through chat.

The conversation is the only interface a user has to learn. Desktop and web are clients
of a runtime that also runs headless; paired runtimes can hand work to each other and
return results into the same conversation.

## Status

**This is a bootstrap, not a release.** It is the P1 foundation plus the verifiable parts
of P2–P9: contracts, durability, the core invariants, the security primitives, and the
adapters for everything that needs an external account.

[`docs/conformance-traceability.md`](docs/conformance-traceability.md) is the honest
ledger: every scope item (V01–V18) and every acceptance test (T01–T72) from
[`docs/implementation-plan.md`](docs/implementation-plan.md) with a status of PASS,
BLOCKED or NOT-IMPLEMENTED, and the evidence for each. Nothing there is marked complete.

Of the 72 acceptance tests in the blueprint: **44 pass**, 4 are blocked on external
infrastructure or credentials, and 24 belong to phases this bootstrap did not build. The
184 tests in this repository are unit and integration tests of individual layers; passing
them is not the same as passing a journey, and no journey runs end to end yet.

## What actually works

These are exercised by tests in this repository, not described in prose:

- **Durable command handling.** A retried command with the same idempotency key returns
  its original acknowledgement instead of creating a second task. Reusing that key for a
  different payload is refused. (`packages/storage`)
- **Task lifecycle.** A complete, total state machine where success is reachable only
  through verification with recorded evidence, and an unsettled external effect blocks a
  success report. (`packages/contracts/src/tasks.ts`, `packages/core`)
- **Effect reconciliation.** A submit whose acknowledgement was lost becomes `unknown`
  and is never silently re-sent. (`packages/contracts/src/effects.ts`)
- **Authority.** Grants intersect rather than compose, so A→B→C cannot widen trust, and
  only a user principal can approve an operation. (`packages/contracts/src/grants.ts`)
- **Resource leases with fencing.** One live lease per resource, enforced by a partial
  unique index, with an epoch that fences out a superseded holder. (`packages/core`)
- **Install lifecycle.** One plan per capability and node, consent bound to a plan digest,
  immutable generations, and rollback that leaves the previous generation serving.
  (`packages/core/src/install-lifecycle.ts`)
- **Security primitives.** An AES-256-GCM credential vault with no plaintext getter,
  credential redaction, PKCE, constant-time state comparison, scope-subset verification,
  MCP token-audience checks, and an environment allowlist that drops `SSH_AUTH_SOCK`,
  `AWS_*`, `GITHUB_TOKEN` and provider keys before spawning a child. (`packages/host-adapters`,
  `packages/integration-sdk`, `packages/mcp-adapters`, `packages/execution-supervisor`)
- **Real Pi SDK integration.** `packages/pi-adapter` is typed against the installed SDK
  and the P0.1 probe records which lifecycle steps actually ran.
  (`docs/research/compatibility-lock.md`)
- **A headless node that boots.** `node apps/runtime/src/main.ts` runs a node with its own
  identity and database, and refuses any command without its bearer token.
- **Verifiable backups.** SQLite `VACUUM INTO`, integrity and foreign-key checks, row-count
  comparison, and a refusal to restore a backup taken by a newer schema.

## What does not work yet

Stated plainly, because a bootstrap that hides this is worse than useless:

- The **React conversation client** and therefore the web and desktop clients.
- The **conductor** and a live worker pool; the state machine exists but nothing drives it
  end to end.
- Live **OAuth**, **Google Calendar**, **MCP transport**, **voice transport**, the
  **Playwright** binding, and the **macOS/Linux native drivers**. Their contracts, state
  machines and refusals are implemented and tested; the transports are not.
- **Quarantine download and isolated build** for installs.
- Everything downstream of those: onboarding, the widget catalog renderers, pins in the UI.

## Requirements

- Node.js 22.19 or newer (24 recommended; the runtime executes TypeScript directly)
- pnpm 12 via Corepack

No native modules are required: SQLite comes from Node's built-in `node:sqlite`.

## Getting started

```bash
corepack enable
pnpm install
pnpm verify                 # invariants, typecheck, lint and the full test suite
node apps/runtime/src/main.ts --data-dir ./.data --label dev
```

The node prints its identity on startup. Commands require the bearer token in
`./.data/identity.json`.

```bash
# Health is the only unauthenticated route; everything else needs the token.
curl -s -H "authorization: Bearer $(node -e 'console.log(require("./.data/identity.json").localToken)')" \
  http://127.0.0.1:8765/health
```

Run the P0.1 SDK lifecycle probe:

```bash
node packages/pi-adapter/src/probe-cli.ts            # report to stderr
node packages/pi-adapter/src/probe-cli.ts --json     # machine-readable
node packages/pi-adapter/src/probe-cli.ts --write    # refresh docs/research/compatibility-lock.md
```

## Layout

```text
apps/        runtime (headless node), web, desktop, worker
packages/    contracts, storage, core, pi-adapter, node-link, capability-host,
             integration-sdk, widget-sdk, widget-host, mcp-adapters, host-adapters,
             execution-supervisor, voice-adapters, conversation-client, design-tokens
packs/       project-work, data-canvas, browser-playwright, computer-macos,
             computer-linux-desktop, google-calendar
examples/    note-widget, media-widget-contract, mcp-app-fixture
docs/        the blueprint, the compatibility lock, and the conformance ledger
```

Every workspace package declares `clarkcant.phase` and `clarkcant.status` in its
`package.json`, so any file can be traced back to the milestone that owns it. `pnpm
invariants` enforces that, along with the documentation manifest hashes, the absence of
committed credentials, pinned dependency specifiers, and the TypeScript syntax that Node's
type-stripping loader cannot execute.

## Design decisions worth knowing

- **Contracts are runtime-validated, not just typed.** They cross process, node and
  release boundaries, where a compile-time type stops being evidence.
- **Zero-dependency SQLite.** `node:sqlite` avoids a compiled dependency in the storage
  layer, which matters for the supply-chain story.
- **Supply-chain policy lives in `pnpm-workspace.yaml`.** pnpm 12 reads security settings
  there, not from `.npmrc`: a 24-hour minimum release age, exotic sub-dependency blocking,
  and an explicit `allowBuilds` list so no package runs a lifecycle script unreviewed.
- **The step from "installed" to "usable" is explicit.** `installed`, `loaded`,
  `authenticated`, `authorized` and `healthy` are separate facts, because "the package
  installed" and "the integration works" are different claims.
- **Uncertainty is a resting state.** `unknown` is never retried into `failed` or
  `succeeded`; it waits for observation.

## Documentation

Read in this order: [`docs/scope-lock.md`](docs/scope-lock.md),
[`docs/system-architecture.md`](docs/system-architecture.md),
[`docs/conformance-traceability.md`](docs/conformance-traceability.md). The blueprint as a
whole starts at [`docs/README.md`](docs/README.md).

## Licence

Apache-2.0. See [`LICENSE`](LICENSE).

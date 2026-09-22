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

Tra trạng thái và điều kiện còn thiếu tại [bảng conformance](docs/conformance-traceability.md).
Test từng lớp không thay thế kiểm chứng hành trình; các hành trình trình duyệt nằm
trong [apps/web/e2e](apps/web/e2e). Fixture không chứng minh provider thật hoạt động.

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
- **A conversation client.** A reply streams in as the model writes it, markdown and fenced
  code render with their language highlighted, a tool the turn calls appears as a widget the
  reader can open, and the composer grows to five lines before it scrolls. The message frame
  — a bubble for the user, the agent's own mark for a reply — follows the design reference in
  `docs/demo-ui`. Exercised end to end by `apps/web/e2e/`, which drives a production build
  against a real node. (`packages/conversation-client`)
- **Tool calls as widgets.** Every tool a turn calls is recorded with the arguments it was
  given and the result it returned, reported on the stream while it runs, and drawn as a
  disclosure that is open while it works and closed once it is done. Reasoning is its own
  collapsed widget, because it is not what the model said to the user.
  (`apps/runtime/src/model-turn.ts`, `packages/contracts/src/surfaces.ts`)
- **Machine-wide search, read-only.** A bounded walk of the filesystem that builds no index,
  skips dependency and system trees, reports what it scanned and why it stopped, and sends
  only the matching lines to the model. (`apps/runtime/src/fs-search.ts`)
- **A headless node that boots.** `node apps/runtime/src/main.ts` runs a node with its own
  identity and database, and refuses any command without its bearer token.
- **Verifiable backups.** SQLite `VACUUM INTO`, integrity and foreign-key checks, row-count
  comparison, and a refusal to restore a backup taken by a newer schema.

## Autonomy

The default is autonomous: an agent acts on the intent it is given, and what makes that defensible is not a dialog
but the host. Every effect goes through a deterministic preflight that confines it to the folders this node owns,
checks that the resource exists, and attaches a deadline and an output ceiling. A policy layer may then deny, narrow
or ask a clarifying question — and it can only narrow, never widen.

- **Execution policy.** `guarded` is the default: nobody is asked, and the guardrail may still refuse. `confirm`
  keeps the approval card whole for anyone who wants to be asked; `auto` and `deny` switch the layers off and on.
- **Questions, not permission dialogs.** `ask_user_question` ends the turn that asked, and the answer arrives as a
  new turn — which is why a question costs nothing while it waits. Voice and a click post the same answer to the same
  route.
- **Secrets as metadata.** The agent learns that `github_token` exists, what it is for and who may use it. The value
  goes from a backend into one invocation — a tool call, a child process's environment, a request header — and is
  never returned to a model.
- **A pool of models.** Several profiles with roles and priorities; `Cmd/Ctrl+]` moves to the next one, and the
  change becomes a new generation at the next turn boundary, because Pi resolves a model when a session is created.
- **Stop and audit.** `POST /stop` kills running commands, interrupts turns and stops background workers. Every
  effect is written to an append-only trail by name and outcome, never by value.

## What does not work yet

Stated plainly, because a bootstrap that hides this is worse than useless:

- The **desktop shell** beyond the surface its typed IPC bridge exposes: the browser suite
  proves the client's branch when a directory dialog is present, not an Electron build.
- The **conductor's task dispatch** and a live worker pool: the conductor is wired and the
  task state machine runs, but no worker loads a capability on this node, so a dispatched
  task has nothing to execute it. `apps/worker` is a CLI the runtime does not spawn.
- Live **OAuth**, **Google Calendar**, the **MCP streamable-HTTP transport** (stdio is built
  and tested), and the **macOS/Linux native drivers**. Their contracts, state machines and
  refusals are implemented and tested; those transports are not.
- **Quarantine download and isolated build** for installs.
- The **install and capability lifecycle** in the interface: the cards render and the
  refusals are honest, and no install has been run end to end from the browser.

## Requirements

- Node.js 22.19 or newer (24 recommended; the runtime executes TypeScript directly)
- pnpm 12 via Corepack

Core features need no native modules: SQLite comes from Node's built-in `node:sqlite`.

Semantic search is the one exception, and it is optional. When `sqlite-vec` and the local embedding
runtime are installed, history can be indexed as vectors and fused with the lexical results by
reciprocal rank fusion; when they are not, the node searches lexically and reports why. Neither is
required to install, boot, or pass the test suite — see "Turning semantic search on, and when not
to" in `docs/mini-app/jev-configuration.md`.

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
`package.json`, so any file can be traced back to the milestone that owns it. `phase` is the
milestone that owns the package; `status` is the package-level claim about the package's own
code, and it is one of three words. `implemented` — that code is written and exercised by
tests in this repository. `stub` — the package still owes its own code, and nothing outside
this repository is what holds that work back. `external-blocked` — the package still owes work
that cannot be finished or validated here, because it waits on something outside this
repository: an account, a signing identity, a service or device this machine does not have, or
a second host — the gate the registry entry carrying the gap names in `externalGate` (#2, #3,
#4 and #5 are the gates this program keeps open). The word is coarser than a capability's
status in [`IMPLEMENTATION_STATUS`](packages/contracts/src/implementation-status.ts): one
package can carry several entries at different statuses, and the entries are where the split
lives. `pnpm invariants` enforces the field's presence and vocabulary, along with the
documentation manifest hashes, the absence of committed credentials, pinned dependency
specifiers, and the TypeScript syntax that Node's type-stripping loader cannot execute.

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

Định hướng UI/UX nằm trong [DESIGN.md](DESIGN.md), quy trình dành cho agent nằm trong
[AGENTS.md](AGENTS.md). Attachments có bằng chứng tại [browser tests](apps/web/e2e/attachments.spec.ts)
và [runtime tests](apps/runtime/test/attachment-in-turn.spec.ts); không suy ra các giai đoạn
voice/action parity hay compact desktop đã hoàn tất từ phần attachments.

Read in this order: [`docs/scope-lock.md`](docs/scope-lock.md),
[`docs/system-architecture.md`](docs/system-architecture.md),
[`docs/conformance-traceability.md`](docs/conformance-traceability.md). The blueprint as a
whole starts at [`docs/README.md`](docs/README.md).

## Licence

Apache-2.0. See [`LICENSE`](LICENSE).

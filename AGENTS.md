# AGENTS.md

Hard rules for agents working in this repository.

This file is ClarkCant's operating constitution: product philosophy, mandatory
workflow, and repository-wide invariants. Keep it small. Detailed architecture,
UX, domain behavior, and runbooks belong in their dedicated docs and should be
loaded only when relevant.

Primary sources:

- Product intent and architecture: `README.md`, `docs/README.md`,
  `docs/system-architecture.md`
- UI/UX and interaction invariants: `DESIGN.md`
- Review policy: `REVIEW.md`
- Widget developer UX: `docs/widget-development.md`
- Widgets/extensions architecture: `docs/widgets-and-extensions.md`
- Open interfaces: `docs/open-interfaces.md`
- Distributed runtime: `docs/distributed-runtime.md`
- Browser/computer use: `docs/browser-computer-use.md`
- Installation/platform behavior: `docs/installation.md`,
  `docs/platform-smoke.md`
- Conformance status: `docs/conformance-traceability.md`

`CLAUDE.md` includes this file and must remain aligned with it.

If `docs/system-architecture.md` and `docs/system-architecture.png` disagree,
the PNG is current and the prose must be fixed.

## Product philosophy

Treat these as architecture constraints, not branding.

### Open by default

ClarkCant should remain extensible by its users and community.

A person should be able to build private extensions for their own setup without
forking ClarkCant, and use the same extension model to publish reusable work to
the marketplace.

Prefer:

- stable, documented, versioned contracts over internal-only hooks;
- reusable extension primitives over one-off privileged integrations;
- composable UI/tool/skill/theme/recipe/package facets;
- local, git, registry, and self-hosted usage in addition to marketplace
  distribution;
- a small trusted core with explicit capability and isolation boundaries.

When a built-in feature can reasonably become a reusable extension primitive,
prefer the primitive plus a built-in implementation.

### Cross-platform by default

Architecture and features must account for macOS, Windows, and Linux-based
systems, especially Omarchy OS.

Keep portable logic above platform adapters. Isolate OS-specific filesystem,
shell, process, windowing, permission, packaging, update, shortcut, voice, and
device behavior behind typed capabilities or adapters.

Do not silently treat one OS as the reference platform. If parity is impossible,
define explicit degraded or unsupported behavior while keeping the rest of the
product usable.

### Radical simplicity outside, autonomy inside

The user-facing mental model is intentionally tiny:

1. one Clark;
2. one conversation.

Pi sessions, workers, Jev, memory, models, routing, nodes, package generations,
and tools are implementation details unless progressive disclosure genuinely
helps the user.

UX and useful autonomy outrank exposing technical machinery.

Simple outside does not mean hidden. Everything the user may need is
summonable from the conversation and arrives as an **agent message with widget
UIs (a mini app)**: past and background sessions, provider sign-in and
sign-out, model and thinking, settings, diagnostics, results. Asking in words,
by voice, or with a slash command (`/sessions`, `/login`, `/thinking`, ...)
returns the same typed result in the same place.

Answers follow the same rule. When structure helps, Clark composes the reply as
a mini app rather than a wall of text: "compare the benchmarks of model A and
B" comes back researched, with tables, charts and diagrams wired into one
coherent surface.

What stays out of the default view is permanent chrome — dashboards, sidebars,
pickers — not capability.

Autonomous execution is the default direction. Jev/policy is the escalation
decision layer. Ask the user only when a meaningful human decision is required,
such as detected material risk, destructive or difficult-to-reverse effects,
configured policy, or unavoidable OS/OAuth/browser/vendor consent.

Do not add confirmation merely because an action is technical or effectful.

Preserve Stop, audit/provenance, recovery, and Undo/rollback where supported.
Permission/trust decisions should support flexible memory: session-scoped,
durable preference, or learned repeated behavior where appropriate.

Prefer architecture that supports long-running autonomous work through durable
state, resumability, checkpoints, bounded retries, and safe recovery.

Autonomy never overrides hard security boundaries, isolation, credentials,
external consent, or explicit user policy.

### Philosophy-change gate

If a requested feature or architectural decision materially conflicts with these
principles, do not silently create an exception.

Surface the conflict immediately and ask the user to choose among the relevant
paths:

1. intentionally update the product philosophy;
2. reject or stop the conflicting work;
3. adopt a philosophy-compatible alternative.

Propose the best compatible alternative when one exists.

## Mandatory workflow

### Before brainstorming, planning, or implementation

For any non-trivial feature or bug fix:

1. Re-read the relevant product philosophy and domain docs.
2. Search related GitHub issues, PRs, plans, and recent relevant work.
3. Identify duplicates, dependencies, blockers, and adjacent work.
4. Determine the safest implementation order.
5. Reference related issues explicitly.
6. Comment on affected issues when new findings, blockers, dependencies, or
   changed assumptions would help future work.

Do not design or implement tracked work in isolation when existing work already
constrains it. Make dependency order explicit. Avoid duplicate issues; create one
when durable coordination is needed and no suitable issue exists.

### While working

Solve the user's intent end-to-end rather than exposing internal multi-step
complexity.

When new information changes architectural assumptions, reassess related issues
and blockers, update durable tracking where useful, and revisit the product
philosophy before committing to the new direction.

Never invent progress, evidence, permission, live state, or success.

### Before completion or permanent stop

Before declaring work complete, or before stopping because the task cannot
continue, decide whether the change makes official ClarkCant documentation stale.

For user-visible behavior, APIs, setup, commands, extension surfaces, or
architecture that belongs in official docs:

1. update `digitopvn/clarkcant-web` proactively;
2. preserve its English/Vietnamese documentation expectations;
3. create the appropriate branch and PR;
4. verify it;
5. merge it when repository policy and checks permit.

Do not leave documentation follow-up to the user when it can be completed
autonomously.

If updating or merging official docs is genuinely blocked, create an issue in
`digitopvn/clarkcant-web` before finishing. Add `ai-handle` plus relevant
labels, link the implementation issue/PR, and state exactly what remains.

A task that requires official documentation is not fully closed until the docs
change is landed or this fallback tracking issue exists.

## Progressive disclosure

Load detailed guidance only when the task touches that domain:

- Visible UI, interaction, motion, settings, conversation, voice:
  read `DESIGN.md`.
- Widgets, marketplace, package facets, trust lanes:
  read `docs/widget-development.md` and `docs/widgets-and-extensions.md`.
- REST/SSE/MCP/WebSocket/CLI or public contracts:
  read `docs/open-interfaces.md`.
- Multi-node, presence, handoff, synchronization:
  read `docs/distributed-runtime.md`.
- Browser/computer control:
  read `docs/browser-computer-use.md`.
- Installation, packaging, updates, platform smoke:
  read `docs/installation.md` and `docs/platform-smoke.md`.
- Creating or reviewing a PR:
  read `REVIEW.md`.
- Changing claimed implementation/conformance status:
  read `docs/conformance-traceability.md`.

Do not preload every linked document for every task.

## Product and UX invariants

Before changing a visible flow, read `DESIGN.md`.

- Conversation remains the primary surface; do not make dashboards, permanent
  sidebars, session pickers, or runtime topology the default mental model.
- Anything the user can do or inspect must be summonable in the conversation as
  an agent message carrying widgets (chat, voice, or slash command), never only
  reachable by hunting through a hidden screen.
- Settings, marketplace, widget details, and diagnostics are secondary surfaces
  and must preserve conversation state.
- Important actions should be reachable through conversation and, where
  supported, voice.
- The animated Orb is ClarkCant's signature default identity. Do not remove it.
  Personalization may change bounded palette/effects/physics; reduced motion wins.
- Prefer progressive disclosure for technical details.
- Never ship fake controls, fake progress, invented permission/success state, or
  stale/sample data presented as live.
- Errors should explain what failed, what was preserved, and what happens next.
- Voice is another interaction mode for the same Clark. Text and voice should
  converge on the same typed action semantics.
- Pointer, keyboard, touch, and voice must remain independently usable; visible
  focus and reduced-motion behavior are required.

## Trust and architecture invariants

- Jev/policy owns configurable escalation decisions; do not scatter ad-hoc
  confirmation policy across features.
- Untrusted widgets/extensions do not receive raw secrets, generic Electron IPC,
  privileged host cookies, arbitrary host tool execution, or authoritative
  host-owned approval UI.
- Keep host-owned privileged UI, trusted built-ins, declarative compositions, and
  isolated executable widgets as distinct trust lanes.
- An AI client, widget, or remote machine surface must never approve its own
  privileged action.
- Prefer one canonical business-logic/capability path. Voice, CLI, MCP,
  WebSocket, widgets, and UI should dispatch to shared typed capabilities rather
  than create parallel implementations.
- Prefer existing standards over bespoke protocols; version new wire formats.

## Engineering invariants

- Use pnpm via Corepack. Never npm or yarn.
- Dependencies are exact-pinned and subject to repository supply-chain policy.
- Supported Node versions are defined by repository tooling/CI; currently Node
  22.19+ with Node 24 also exercised in CI.
- Node executes TypeScript via type stripping. Do not introduce enums,
  namespaces (including `declare global`), or constructor parameter properties.
- Workspace packages resolve to source, not `dist`; do not add unnecessary build
  steps for internal imports.
- New `.tsx` files must belong to a typechecked config; follow the existing
  `tsconfig.json` / `tsconfig.web.json` split.
- Only `packages/pi-adapter` may import the Pi SDK.
- Never commit credentials.
- Applied storage migrations are immutable: add a migration; never edit one.
  Back up data before applying risky migrations.
- Do not force-add generated evidence under `plans/reports/evidence/`.

## Verification

Run focused tests first when practical.

- Non-journey code: `pnpm verify` is the normal definition of done.
- UI/user journeys: run relevant browser E2E and `pnpm verify:full`.
- Repository constraints: run `pnpm invariants` when they may be affected.

A verification result only describes the exact tree it ran against. Re-run
relevant checks after rebasing or changing files.

Fix causes, not assertions. Do not silently skip blocked verification; name the
missing condition.

Do not treat an invariant checker as evidence for things it does not verify.

## Git, issues, and collaboration

- Use conventional commits in English with no AI attribution.
- Code changes go through a branch and PR. Plans/docs may follow repository
  policy unless the user explicitly requests a branch/PR.
- Plan directories follow `plans/{date}-{issue}-{slug}/`; validate edited plans
  with the repository plan validator.
- Use GitHub issues as durable coordination state, not merely tickets to close.
  Record blockers, dependency order, and changed assumptions when they matter
  beyond the current session.
- Avoid shell interpolation bugs when sending Markdown through CLI commands.
  Prefer body files for complex content and read important created artifacts back
  after mutation.

### Issue status labels and ownership

Keep each issue's assignee and status label current, so parallel work does not
collide.

- Before starting, read the assignee, status label, claim comments and linked
  PRs. If someone else owns the issue or an open PR addresses it, coordinate
  instead of starting parallel work.
- When starting, assign the GitHub account doing the work and post a claim
  comment naming the branch (and the agent session or worktree). Agents often
  share one account, so the claim comment is what identifies the owner.
- Replace the status label rather than adding another; an issue carries one:

| Label | Meaning |
| --- | --- |
| `in progress` | being implemented |
| `blocked` | cannot continue; a comment names the blocking issue or external gate |
| `in review` | implementation finished; isolated review before the PR opens |
| `done` | PR opened; final-head attestation, CI and merge pending |
| `shipped` | the issue's full scope is merged into `main` |

- `external-gate` is not a status; keep it beside the status when part of the
  work needs credentials, hardware or a second host.
- Use a closing keyword only when the PR delivers the issue's full scope. A
  partial merge returns the issue to `in progress` (or `blocked`) with a comment
  saying what landed and what remains; epics stay `in progress` while child
  issues carry their own status. After an auto-merge, the next contributor who
  touches the issue sets `shipped`.

## Documentation and language

Internal and official documentation are bilingual unless explicitly exempted:
English is canonical/default and Vietnamese is the paired translation with full
diacritics.

`docs/conformance-traceability.md` remains English-only because it is the
canonical checked status ledger.

`AGENTS.md` (with `CLAUDE.md`, which includes it) and `REVIEW.md` are
English-only: they are the operating rules agents load into context, and a
second copy would double the surface that can drift.

Do not document target behavior as already shipped.

Use English for code, identifiers, commit messages, and protocol/schema names.
Plans may remain Vietnamese-only when appropriate.

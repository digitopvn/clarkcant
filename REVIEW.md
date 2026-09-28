# REVIEW.md

Compact review policy for ClarkCant.

Read `AGENTS.md` first. It defines the product philosophy and repository-wide
invariants. This file defines the minimum gates for reviewing and merging changes.

Do not preload every domain document. Use the routing section below only when the
diff touches that area.

## Review goal

A review protects the product, not just the diff.

A change is not ready merely because it compiles, tests pass, or matches the
issue literally. Review whether it solves the user problem while preserving:

- ClarkCant's product philosophy;
- radical UX simplicity and useful autonomy;
- open/community extensibility;
- cross-platform behavior;
- architecture and trust boundaries;
- correctness and recoverability;
- durable issue/documentation state.

Prefer identifying root causes and architectural drift over cosmetic comments.

## Progressive review routing

Load additional guidance only when relevant:

| Change touches | Read |
| --- | --- |
| visible UI, motion, conversation, voice, settings | `DESIGN.md` |
| widgets, marketplace, extensions, package trust | `docs/widget-development.md`, `docs/widgets-and-extensions.md` |
| REST/SSE/MCP/WebSocket/CLI/public contracts | `docs/open-interfaces.md` |
| multi-node, presence, handoff, sync | `docs/distributed-runtime.md` |
| browser/computer control | `docs/browser-computer-use.md` |
| packaging, installation, updates, platform behavior | `docs/installation.md`, `docs/platform-smoke.md` |
| implementation/conformance claims | `docs/conformance-traceability.md` |

Also inspect related issues, PRs, plans, and blockers for non-trivial changes.

## Review gates

Review in this order.

### 1. Product fit

Check the change against `AGENTS.md`.

Watch especially for:

- unnecessary user-facing concepts or technical machinery;
- ad-hoc confirmation instead of Jev/policy escalation;
- first-party-only special cases where an extension primitive is reasonable;
- silent platform assumptions;
- architectural exceptions that conflict with product philosophy.

A material philosophy conflict is a blocker until the user explicitly chooses a
different direction.

### 2. Related work and dependency order

Check relevant issues/PRs/plans.

Flag duplicates, unresolved blockers, invalid dependency order, or assumptions
that make other tracked work stale.

When a finding matters beyond this PR, update or comment on the relevant issue;
do not leave durable project knowledge only in a review thread.

### 3. Correctness and architecture

Check that:

- the actual user problem is solved end-to-end;
- there is one clear source of truth/owner for important state;
- retries, concurrency, restart/resume, and failure paths are safe where relevant;
- public surfaces converge on shared typed capabilities rather than parallel
  business logic;
- platform-specific behavior is isolated behind explicit boundaries;
- migrations, persistence, and destructive effects are recoverable where
  practical.

### 4. Trust and autonomy

Check that the change preserves Stop, audit/provenance, and recovery where
relevant.

Reject privilege leaks, self-approval paths, raw secret exposure, or untrusted
code gaining host-level capabilities.

Do not require extra approval merely because an action is effectful; escalation
belongs in policy/Jev unless a hard external consent boundary requires it.

### 5. UX truthfulness

For visible changes, verify relevant `DESIGN.md` invariants.

Block fake controls, invented progress/success/permission state, stale data shown
as live, broken keyboard/focus/reduced-motion paths, or unnecessary navigation
concepts.

### 6. Evidence

Tests should prove behavior, not implementation trivia.

Expect:

- relevant focused tests;
- `pnpm verify` for non-journey changes;
- relevant browser E2E + `pnpm verify:full` for user journeys;
- `pnpm invariants` when repository constraints may be affected.

Evidence applies only to the tree/commit it ran on.

Do not fix failing tests by weakening assertions unless product behavior
intentionally changed.

### 7. Documentation closure

Before approval/merge, decide whether official docs are affected.

If yes, prefer the documentation update in `digitopvn/clarkcant-web` to be
implemented, reviewed, and merged proactively.

If that is genuinely blocked, require a durable `digitopvn/clarkcant-web` issue
with `ai-handle`, relevant labels, implementation links, and a clear remaining
scope.

Documentation debt must not exist only as a PR comment.

## Severity

Use severity for impact, not tone.

- **Blocker** — must resolve before merge: correctness/data-loss/security/trust
  failure, broken core flow, material philosophy conflict, irreversible migration
  risk, invalid source of truth, or supported-platform breakage.
- **Major** — normally resolve before merge: incomplete journey, substantial UX
  regression, missing recovery path, significant architectural coupling, missing
  important evidence, or stale required docs.
- **Minor** — worthwhile but non-blocking improvement.
- **Nit** — optional polish; never block approval.

Do not split one root cause into many repetitive comments.

## Approval and merge

Approve when:

- no Blocker or unresolved Major remains;
- product philosophy is preserved or intentionally changed;
- relevant dependencies/issues are accurate;
- architecture/trust/platform concerns are addressed;
- verification provides credible evidence;
- required documentation is landed or durably tracked.

Do not withhold approval for optional polish.

Before merge:

1. confirm the reviewed commit is still the PR head;
2. confirm required checks apply to that commit;
3. inspect unresolved review threads;
4. confirm blockers/dependencies are reflected in durable tracking;
5. confirm documentation closure;
6. merge using repository policy.

After merge, do not leave promised follow-up work untracked.

## Review comments

Comments should be specific, actionable, evidence-based, and proportional.

Name the violated invariant or failure mode, then suggest the smallest reasonable
fix when one is clear.

Prefer one architectural comment describing a root cause over many comments on
its symptoms.

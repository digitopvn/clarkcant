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

1. attest the review of the final head (below); a push makes it stale;
2. inspect unresolved review threads;
3. confirm blockers/dependencies are reflected in durable tracking;
4. confirm documentation closure;
5. merge using repository policy.

To attest, run `node tools/attest-review.mjs <pr> --result ready|changes-required
--reviewer agent:<name>|human:<login> [--commit HEAD]` as an account with write
access. It reads the PR's head SHA itself (`--commit` refuses if your reviewed
checkout is not that head) and posts a comment with only SHA, result and reviewer.

The merge gate is `.github/required-checks.json`, enforced by the
`main: required CI` ruleset. In short:

- every job in `.github/workflows/ci.yml` must pass, including both
  `service container (rootless …)` jobs and `widget tooling smoke`, unless the
  file lists it as non-gating with a reason (none today);
- `review attestation` must pass: a status set by
  `.github/workflows/review-attestation.yml` when the newest attestation by a
  writer is `ready` for the exact head; PRs that change only Markdown under
  `docs/` and `plans/` pass without one (`AGENTS.md`, `DESIGN.md`, `README.md`
  and this file are rules, and are reviewed like code);
- strict: the PR must be up to date with `main`, so checks ran on the combined
  tree. Use `gh pr update-branch <pr>` (or the button), then re-attest the new
  head;
- a check counts only on the head SHA it ran on; cancelled is never passing;
- force-push and deletion of `main` are blocked; admins may bypass only for
  direct docs/plans commits, never to merge a PR with red or pending checks.
  The drift check cannot read bypass actors with its read-only token, so a
  change to them is not detected automatically; review them whenever the
  ruleset is edited.

No human approval is required; an agent's attestation counts the same The
attesting reviewer must not have authored the change: a separate subagent
context or a different person. A review done before the PR opened does not
replace attesting the PR's final head.

Prefer squash auto-merge (`gh pr merge --auto --squash`). Merged branches are
deleted automatically, which retargets a stacked PR onto `main`; rebase it with
`git rebase --onto main <old-base>` before it merges.

When a CI job is added or renamed, change `.github/required-checks.json` in the
same PR; `pnpm invariants` fails until you do. After it merges, an admin applies
the ruleset with `node tools/check-ruleset-drift.mjs --print-ruleset-payload` and
the `gh api --method PUT` it prints. `.github/workflows/merge-gate-drift.yml`
fails on every push to `main` and daily while ruleset and file disagree.

To show a required job really blocks merge (do not merge the probe): on a
throwaway branch make `service container (rootless podman)` fail (add a first
step `run: exit 1`), open a draft PR, and attest it `ready`. Once CI finishes,
`gh pr view <pr> --json mergeStateStatus` reports `BLOCKED` and
`gh pr checks <pr> --required` lists the failing job. Close the PR and delete
the branch.

After merge, do not leave promised follow-up work untracked.

## Review comments

Comments should be specific, actionable, evidence-based, and proportional.

Name the violated invariant or failure mode, then suggest the smallest reasonable
fix when one is clear.

Prefer one architectural comment describing a root cause over many comments on
its symptoms.

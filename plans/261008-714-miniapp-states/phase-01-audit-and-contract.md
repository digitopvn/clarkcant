---
phase: 1
title: audit, shared status contract, and card changes
status: in-review
---

# Phase 01 — audit, shared status contract, and card changes

Line numbers marked `main:` are on `origin/main` at `68b86b4a`, before this change.

## Audit matrix (before)

Columns: L loading, E empty, P pending/progress, S success, W warning/partial, X error, U disabled/unavailable,
C cancelled, St stale (live only). `ok` handled, `gap` missing or wrong, `n/a` cannot exist for a snapshot.

| Surface | L | E | P | S | W | X | U | C | St | Evidence and gaps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| System card | n/a | n/a | ok | ok | ok | ok | gap | n/a | n/a | main:blocks.tsx:341 `CARD_TONE`; `blocked` drawn danger like a failure |
| Approval card | n/a | n/a | gap | ok | n/a | ok | ok | ok | n/a | main:blocks.tsx:983; deciding only in button text, decision not announced |
| Connection card | n/a | gap | ok | ok | gap | gap | ok | ok | n/a | main:blocks.tsx:1131 raw wire status untranslated; `failed` drawn warn; no last probe, no next step for re-auth |
| Credential card | n/a | n/a | gap | ok | n/a | gap | n/a | n/a | n/a | main:blocks.tsx:1268 status paragraph not in a live region; save failure looks like a note |
| Task progress | n/a | ok | ok | n/a | n/a | gap | gap | gap | n/a | main:blocks.tsx:1301 `TASK_STATUS_TONE` (`blocked` = danger); main:blocks.tsx:1459 stop outcome not announced |
| Task summary | n/a | n/a | n/a | gap | gap | gap | n/a | ok | n/a | main:blocks.tsx:1496 missing duration shown as `0 ms`; badge tone from outcome only, so succeeded + contradicted is green |
| Task overview | n/a | gap | ok | ok | n/a | ok | ok | ok | n/a | main:blocks.tsx:1537 empty list says "nothing running" instead of "no tasks" |
| Reconnect card | n/a | n/a | ok | n/a | n/a | ok | ok | n/a | ok | main:blocks.tsx:1774 raw status in English in every locale |
| Browser/computer session | n/a | n/a | gap | ok | n/a | gap | ok | ok | n/a | main:blocks.tsx:2728 takeover/stop/error notices not announced; pending only in button text |
| Metrics widget | ok | ok | n/a | ok | n/a | ok | ok | n/a | ok | main:renderers.tsx:1642 missing value is a bare `—`, read aloud as a dash |
| Status card progress | ok | n/a | ok | ok | ok | ok | n/a | n/a | n/a | main:renderers.tsx:5389 `value ?? 0` is safe: `readStatusCard` requires value and max |
| Command card rows | n/a | ok | gap | ok | n/a | gap | ok | gap | n/a | main:command-card.tsx:121,125 region mounted with its text; failures polite |
| Provider sign-in | n/a | n/a | ok | gap | n/a | gap | n/a | gap | n/a | main:command-card.tsx:315 cancelled marked `data-result="failed"`; no signed-in receipt |
| Question, form, diff, artifact, feedback, marketplace | — | ok | ok | ok | ok | ok | ok | n/a | n/a | covered by `card-state-matrix.spec.ts`; feedback `unknown` already distinct |

## Contract

`packages/contracts/src/surface-status.ts`:

- Phases: `loading`, `empty`, `pending`, `needs-action`, `success`, `partial`, `error`, `unavailable`, `cancelled`,
  with one tone and one text mark each.
- Freshness: `snapshot` (never stale) or `live` (`observedAt`, `staleAfterMs`); unreadable time is stale.
- Next action (`retry`, `check-again`, `sign-in`, `decide`, `grant-permission`, `open-settings`, `none`); `canRetry`
  only for `error`/`partial` with `retry`/`check-again`.
- `settleSurfaceStatus`: drops earlier attempts, never reopens an outcome within an attempt, drops older live
  observations.
- `surfaceAnnouncement`: restored, same phase or `loading` is off; `error` assertive; otherwise polite.
- `reportedValueSchema`: `reported` (value, unit, source `official`/`inferred`, `asOf`, optional stale window),
  `unknown`, `unavailable` (reason required), `unsupported`. Text helpers never print a missing value as zero.
- Domain tables typed against their schemas: system card, connection, task progress/overview, task summary
  (outcome + evidence), approval, question, reconnect, tool activity, session preview, provider sign-in, feedback
  publication, widget lifecycle, marketplace.

Rendering (`packages/conversation-client/src/surface-status.tsx`): `PhaseBadge` (tone + `data-surface-phase`; mark
drawn by CSS with empty alt text) and `LiveNote` (both regions always mounted; content at mount placed outside them).

## Applied (after)

- System, task progress/overview badges: phase tones; `blocked` reads `unavailable`.
- Task summary: phase from outcome and evidence; contradicted/unverified lines; no duration when unreported.
- Task overview: empty statement.
- Connection: translated status, last probe with time, sign-in next step for `needs_reauth`/`expired`.
- Reconnect: translated status.
- Approval, credential, task stop, session takeover/stop: outcome notes in `LiveNote`.
- Metrics: missing value said as "unknown" to screen readers.

## Follow-ups for command cards (owned by #711/#715)

1. `command-card.tsx:121,125`: render the row status through `LiveNote` so the region exists before the answer and a
   failure is assertive; map `settled.status` to a phase (`refused`/`failed` error, `stale`/`unknown` partial).
2. `command-card.tsx:315`: a cancelled sign-in is marked `data-result="failed"`; map via `SIGN_IN_PHASE` so cancel
   reads `cancelled`, and add a signed-in receipt after `done`.
3. `use-block-actions.ts:275`: carry a phase and an attempt in `credentialStatus` instead of a message string; the
   credential card currently infers the error by comparing to the save-failed message.
4. Settle late action answers with `settleSurfaceStatus` keyed by an attempt counter per row.
5. Row badges: use `PhaseBadge` with a domain table instead of ad-hoc tones.

## Validation

- `pnpm exec vitest run packages/contracts packages/conversation-client` — all pass.
- `pnpm run typecheck`, `pnpm run invariants`, eslint on changed files.
- Playwright `miniapp-states.spec.ts` (VI + 375x812 + reduced motion; EN approval; reload announces nothing) with the
  existing approval, task-stop, takeover, computer-session, secret-input and EN timeline journeys.
- On `main` sources the new unit spec fails 13/19 (the 6 passing are pure helpers of the new module) and both e2e
  journeys fail at the phase assertions.

## Risk and rollback

Read-side only: no wire or storage change. Revert the commit to roll back.

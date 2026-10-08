---
phase: 2
title: command cards, sign-in, credential card and terminal adopt the contract
status: in-review
---

# Phase 02 — command cards, sign-in, credential card and terminal

Branch `feat/714-miniapp-states-adoption`, on `origin/main` at `73507588` (after #735 and #743). Closes follow-ups
1–5 and 7 of phase 01, and the #743 review finding on the `/logout` card.

## Audit matrix (before → after)

Columns as in phase 01: L loading, E empty, P pending, S success, W partial, X error, U unavailable, C cancelled,
St stale.

| Surface | P | S | W | X | C | Before (main) | After |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Command card rows | gap → ok | ok | gap → ok | gap → ok | n/a | `command-card.tsx:138-146` status `<p role=status>` mounted with its text, failures polite, `unknown` drawn like any note; row showed the first button's outcome, not the latest press | `LiveNote` mounted with the row (regions empty before a press), `COMMAND_ACTION_PHASE` (`unknown` → `partial`), failure assertive, latest press shown (`latestCommandAction`) |
| Command card late answers | gap → ok | — | — | — | — | `use-block-actions.ts:540-614` every answer overwrote the key | per-press attempt; `settleCommandAction` over `settleSurfaceStatus`; clearing only the attempt that set it |
| Command row badge | — | ok | ok | ok | — | ad-hoc `BADGE_TONE`, no mark | `PhaseBadge` via `COMMAND_BADGE_PHASE` (contracts); `neutral` drawn plain |
| `/logout` failure | — | ok | — | gap → ok | — | `use-block-actions.ts:573` shows `CODE: message`; `signedOut: false` said as "signed out" | `signOutRefused`/`signOutSettled`, shared with Settings (`signInFailureReason`) |
| Provider sign-in panel | ok | ok | — | gap → ok | gap → ok | `provider-sign-in-panel.tsx:160` cancel marked `data-result="failed"`; status line moved between two elements, so the outcome was a region created with its text | one `LiveNote` for the sign-in's life via `SIGN_IN_PHASE`; `data-result="cancelled"` |
| Credential card | gap → ok | ok | — | gap → ok | — | `blocks.tsx:1327` failure inferred by comparing words (a locale change read a failure as success); no reset on submit, so a second identical failure said nothing | `credentialStatus` carries phase and attempt; submit settles `pending` ("Saving…") first |
| Terminal badge | gap → ok | gap → ok | — | — | ok | running drawn `warn`, idle `ok`, no mark | `PhaseBadge` via `TERMINAL_SHELL_PHASE` |
| Terminal status line | ok | — | — | gap → ok | — | one polite region; disconnect/load-failed/kill errors never assertive; Reconnect inside the note | `LiveNote` via `TERMINAL_NOTICE_PHASE` and `terminalNotice`; kill error its own `LiveNote`, cleared before each kill; Reconnect beside the note |
| Terminal panel stop | — | — | — | gap → ok | — | `role=status` created with its text | `LiveNote` mounted with the button |

Not changed: Settings provider rows keep their own `role=status` line (a settings surface, not a miniapp), and the
credential manager section (#580).

## Tests

- `packages/conversation-client/test/command-card-states.spec.ts` (22): regions before a press, phases, reload says
  nothing, latest press, late answers, badge marks, `/logout` refusal text EN/VI, sign-in cancel, credential phase
  across a locale change, credential late answers, terminal notices.
- `apps/web/e2e/miniapp-states.spec.ts`: `/thinking` press heard from a pre-existing region and a cancelled `/login`
  sign-in, in Vietnamese at 375×812 with reduced motion, then a reload announcing nothing; the same press in English.
- Existing selectors moved to `[data-sign-in-status]` (`model-picker.spec.ts`), and the Settings cancel assertion now
  checks `data-result="cancelled"`.
- On `main` sources (`73507588`) the unit spec fails 20/22 (the two passing: a record draws no regions, a pending
  press says it is working) and both new e2e journeys fail: the row has no regions before the press, and the English
  answer has no phase.

## Risk and rollback

Client-side only, plus one read-side table in contracts. No wire or storage change. Revert the commit.

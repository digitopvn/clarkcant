---
phase: 3
title: Try again where a failure is retryable, and an unreadable feedback answer read as not known
status: in-review
---

# Phase 03 — Try again and the unreadable feedback answer

Branch `feat/714-retry-and-feedback-states`, from `origin/main` (after #747). This phase covers items 2 and 3 of the
remaining list on #714. The credential manager section and cross-host staleness stay open.

## Decisions

- **Retryable** (`retryableFailure` in `node-view-refusal.ts`) means the press did not reach the node or got no answer
  in time:
  - a `fetch` `TypeError`;
  - `NODE_NOT_ANSWERING`;
  - 408, 429, 502, 503 and 504, except this app's own parse codes.
- **Not retryable**:
  - every other 4xx (policy, conflict, not accepted);
  - 500;
  - `NodeViewUnreadable`, because sending the same request again brings the same answer back.
- **Safe to send again**: each press offering Try again is one the node answers safely a second time.
  - A sign-in start returns the sign-in that is already running.
  - A dev-session start for the same folder picks that session up again.
  - Feedback publish with `send` on a report that is publishing or unknown only reconciles it.
  - Feedback publish with `check` only looks.
- **Terminal load failure**: Chromium keeps a failed dynamic `import()` for the page's life. A second import rejects
  without a request; this was measured with a dropped `xterm` chunk. An in-page Try again would be a fake control, so
  none is offered. The notice now says that reloading the app loads the view again, and the e2e proves that a reload
  attaches the same card.

## Audit matrix (before → after)

| Surface | Before (main) | After |
| --- | --- | --- |
| Command card rows (`/thinking`, `/login`, `/logout`, `/develop`, Forget) | A failed press said its reason with nothing beside it, whether it was offline or refused. | A failed state carries `next: "retry"` only when retryable (`commandActionRetryable` over `canRetry`). **Try again** (`data-command-retry`) is drawn beside the outcome and repeats the latest press through `onCommandAction`. A typed `/develop` folder goes through `onFolderEntrySubmit` with the kept `root`. Focus returns to the row's own button. |
| Provider sign-in start and sign-out | `signInStartRefused` and `signOutRefused` gave no hint. | Both carry `next: "retry"` when retryable. They are shared with Settings, which ignores it. |
| Feedback card press (preview, Create issue, Check again) | Every failure was "failed: {reason}". An unreadable answer threw a `ZodError`, whose text was the schema dump. | `feedbackPressFailed` handles three cases: an unreadable publish becomes `unknown` (`partial`) with `feedback.unread` plus the version sentence and **Check again** (`data-feedback-check-unread`); an unreadable preparation is a whole sentence (`shell.nodeView.read`) with nothing to repeat; a retryable failure offers **Try again** (`data-feedback-retry`) with the same intent and report. The press note is a `LiveNote` (`FEEDBACK_PRESS_PHASE`). `prepareFeedback` and `publishFeedback` throw `NodeViewUnreadable` instead of the schema's error. |
| Terminal load failure | "Could not load the terminal view: {reason}. The shell on the node is not affected." | The same notice, plus "reload the app to load the view again" (EN and VI). No Try again. |

## Tests

- `packages/conversation-client/test/retry-and-unread-states.spec.ts` (18) covers:
  - the retryable matrix;
  - the Try again markup and `commandActionRetryable`;
  - `/thinking`, `/develop` (keeps `root`) and sign-in presses settling with `next`;
  - refusal helpers;
  - `feedbackPressFailed` in EN and VI with no schema text;
  - `feedbackReportToReuse` on `unknown`;
  - the gateway client throwing `NodeViewUnreadable`;
  - the press-note callbacks (Try again sends the same report, Check again only checks);
  - the terminal load notice wording.
- E2E tests:
  - `apps/web/e2e/miniapp-states.spec.ts`: a refused `/thinking` press offers nothing to repeat. An aborted one shows the error in the alert region with Try again. Try again from the keyboard sets the level, and focus is back on the row's button.
  - `apps/web/e2e/feedback-report.spec.ts`: Create issue answered in a shape this app does not read becomes `partial` in the polite region, with the VI sentence, no schema words and Check again. Check again asks the node, which says nothing was sent. Create issue then files it once.
  - `apps/web/e2e/terminal.spec.ts`: a dropped `xterm` chunk shows the load notice with the reload advice and no Try again. After a reload the same card attaches.
- On `main` sources (the files `git diff` lists, checked out from `origin/main`), the unit spec fails 17 of 18; the passing test is the refusal guard ("nothing to repeat beside a refusal"), which holds on `main` too. All three new e2e tests failed.

## Risk and rollback

These are client-side changes only: no wire, storage or contract change. Try again reuses the existing press handlers.
To roll back, revert the commit.

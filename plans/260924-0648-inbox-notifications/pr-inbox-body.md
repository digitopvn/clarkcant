## Outcome

ClarkCant now has an inbox. It answers two questions the open conversation cannot answer while the user is elsewhere:

- **What is waiting for me?** Command approvals, extension capability requests and agent questions, in any conversation.
- **What happened while I was away?** Background work and Pi task workers finishing or failing.

It is a host-owned secondary surface, not a sidebar or a session picker. A mark appears in the header only when something is waiting or unread. Opening an item's conversation points to where the work happened; it is not a conversation list.

## What changed

- **Waiting items are derived, never stored.** `apps/runtime/src/inbox.ts` reads them from where they already live on every read:
  - pending command approvals from `approvals` and their `approval-card` block in the transcript;
  - capability requests from `listPendingCapabilityApprovals`;
  - open questions from `pendingForConversation`.

  No status row can disagree with the timeline, and a waiting item cannot be "dismissed", only answered or left to expire.
- **Notices are durable and bounded.** Migration 24 adds `notifications`. The name `inbox` already belongs to NodeLink's dedup table.
  - Every producer sends a `dedupKey`; unique `(principal_id, dedup_key)` makes at-least-once producers idempotent. That covers a peer node redelivering, or a repeated update check.
  - `originNodeId` is carried so NodeLink delivery can land later without a schema change.
  - Titles and bodies are redacted and clipped before they are stored.
  - At most 200 undismissed notices are kept per owner, oldest first; dismissed ones go only after 30 days, so dismissing never pushes an unread notice out. Pruning runs on write.
- **Routes.**
  - `GET /inbox` and `GET /inbox/summary`. The header mark polls the summary every 5 s, as the background-task mark does.
  - `POST /inbox/read` and `POST /inbox/notices/:id/dismiss`.
  - Deciding from the inbox uses the same routes the card and Settings already use, with the digest the row carries. There is no second approval path.
- **Producers.** Every producer writes through `recordNodeNotice` in `apps/runtime/src/notices.ts`, which assigns the owner, mints the id and redacts.
  - `startBackgroundWork` records a success or failure notice linked to its conversation.
  - The task-worker `onSettled` hook records one per settled task through `workerSettledNotice`: succeeded, failed, uncertain (a warning, since the effect may or may not have happened) or cancelled (information), keyed by task so a repeated report replaces it.
- **Surface.**
  - `packages/conversation-client/src/inbox/*`: the header mark, and a modal with "Waiting for you" first, then notices newest first.
  - Unread is shown with a dot and a word, not colour alone.
  - The panel says when it read the inbox, and marks read exactly the notices it drew.
  - Decisions report in a focused status line. Escape closes the panel and returns focus.
  - "Open conversation" switches `App.tsx` to that conversation.
- **Same action from text, voice and the agent.**
  - `inbox.open` is an app intent: typed "mở hộp thư" or "open inbox", or voice.
  - `control_app` can open the inbox.
  - The new read-only `read_inbox` tool lets the agent answer "is anything waiting?". It marks nothing read and cannot approve anything, because the model is not the person.
- **Bug found by e2e and fixed.** The message that holds an approval card is stamped *before* the approval's `requested_at`. A scan starting at `requested_at` missed exactly the card it looked for. The scan now reads the newest 2000 messages by `rowid`, with a regression test that fails without the fix.
- **Review fixes.** A review before merge found, and this PR fixes:
  - the decide route looked for the card in the first timeline page while the inbox read the newest messages, so in a conversation over 200 messages the inbox offered an approval the route could not find, and a grant was spent on nothing. Both now read the newest 2000 messages (`latestMessages`), the payload is looked up before the decision is written, and a missing payload leaves the approval pending (409 `APPROVAL_PAYLOAD_MISSING`);
  - the question scan is bounded the same way as the approval scan;
  - a dedup key longer than the stored limit is cut once, so lookup and insert agree;
  - `read_inbox` redacts commands and prompts and no longer passes storage errors to the model;
  - the `composer.attach` opener "mo hop" caught "mở hộp thư email của tôi" (the fix for #174, pulled in because the inbox phrases made it reachable).
- **Docs.** DESIGN.md gains §6.7 "Hộp thư" (shipped, target, forbidden) and the header-mark note in §6.1. `docs/system-architecture.md` gains §7.5.1. The manifest is refreshed.

## Verification

Both runs are on this branch with `main` merged in.

- `pnpm verify`: pass. That covers invariants, both typechecks, lint, and 2735 unit tests, 7 of them opt-in live-provider tests that were skipped.
  - `apps/runtime/test/inbox.spec.ts` covers derivation across conversations, the routes, `read_inbox`, answered and expired questions, task approvals not being offered, a conversation longer than a timeline page (found and decided), a missing payload, and the worker notices. It includes the regression for the card stamped before its approval.
  - `packages/storage/test/notifications.spec.ts` covers dedup (including an over-long key), the cap and the 30-day rule, redaction and owner isolation.
  - `apps/runtime/test/package-install-capability-approval.spec.ts` covers a capability request appearing in `/inbox` and leaving once answered; `node-tools.spec.ts` covers `read_inbox` registration.
  - `packages/core` covers the `inbox.open` phrases.
  - `packages/conversation-client/test/inbox-model.spec.ts` covers the mark and panel decisions.
- `pnpm test:e2e`: 159 passed, 3 skipped, 0 failed. The skips are the opt-in live voice provider checks and the orb canvas check.
  - `apps/web/e2e/inbox.spec.ts` covers:
    - deny and approve from the inbox, through the card's route;
    - opening by click, keyboard and "mở hộp thư", with focus returned on Escape;
    - 390 px width with reduced motion;
    - a background run that leaves an unread notice and leads back to its conversation, then read (the mark stops counting it) and dismiss;
    - an approval from another conversation decided from the inbox, with the receipt landing in the conversation that asked.
  - Provider key variables were unset for this run. `credentials.spec` expects no key before one is stored, and `readiness.ts` counts `OPENROUTER_API_KEY` as the typesafe key.

## Not in this PR

Each of these has its own issue. #169–#172 need backend work that does not exist yet; #173 is a pre-existing bug found along the way. `docs/system-architecture.png` does not show the inbox yet; the prose in §7.5.1 describes it.

- #169: update checks for Pi, npm/git packages and widgets. There is no upstream version source yet.
- #170: notices and cross-node approvals over NodeLink.
- #171: OS notifications, per-kind preferences and quiet hours.
- #172: more producers (unknown effects, expired OAuth, automations, pairing, expired items) and a decide route for task-dispatch approvals.
- #173: an approval card keeps its buttons after a deny. This is pre-existing, and happens on the card too.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01GwDsQT1Tk2afRLcc8LagXi

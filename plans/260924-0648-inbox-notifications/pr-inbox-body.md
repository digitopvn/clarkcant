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
  - At most 200 notices are kept, and dismissed ones go after 30 days, pruned on write.
- **Routes.**
  - `GET /inbox` and `GET /inbox/summary`. The header mark polls the summary every 5 s, as the background-task mark does.
  - `POST /inbox/read` and `POST /inbox/notices/:id/dismiss`.
  - Deciding from the inbox uses the same routes the card and Settings already use, with the digest the row carries. There is no second approval path.
- **Producers.** Every producer writes through `recordNodeNotice` in `apps/runtime/src/notices.ts`, which assigns the owner, mints the id and redacts.
  - `startBackgroundWork` records a success or failure notice linked to its conversation.
  - The task-worker `onSettled` hook records one per settled task: succeeded, failed, uncertain (a warning, since the effect may or may not have happened) or cancelled (information).
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
- **Docs.** DESIGN.md gains §6.7 "Hộp thư" (shipped, target, forbidden) and the header-mark note in §6.1. `docs/system-architecture.md` gains §7.5.1. The manifest is refreshed.

## Verification

VERIFICATION

## Not in this PR

These need backend work that does not exist yet. Each has an issue:

- #169: update checks for Pi, npm/git packages and widgets. There is no upstream version source yet.
- #170: notices and cross-node approvals over NodeLink.
- #171: OS notifications, per-kind preferences and quiet hours.
- #172: more producers (unknown effects, expired OAuth, automations, pairing, expired items) and a decide route for task-dispatch approvals.
- #173: an approval card keeps its buttons after a deny. This is pre-existing, and happens on the card too.
- #174: the `composer.attach` opener "mo hop" catches "mở hộp thư email của tôi" and refuses it instead of leaving it to the model. This is pre-existing.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01GwDsQT1Tk2afRLcc8LagXi

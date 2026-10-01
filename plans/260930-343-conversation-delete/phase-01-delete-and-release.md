# Implement and deliver

Status: completed. Worktree: D:/wt343. Evidence: [closure](../reports/closure-260930-1641-343.md), PR #365, web PR #59; required CI and website deploy green.

Read AGENTS.md, DESIGN.md, REVIEW.md, open interfaces, widgets and extensions, widget development and issue comments before edits.

Storage: add migration 39 for scoped deletion permits and durable file cleanup; delete dependent rows explicitly with foreign keys enabled. Authority, pins and messages are conversation-owned; tasks and their approvals, effects, runs and evidence must be removed only when quiescent. Saved global resources and bytes still referenced elsewhere remain. Join existing cleanup repositories to an outer transaction without changing generic nested-transaction rejection. Collect physical cleanup until after commit.

Runtime: canonical typed deletion capability checks home ownership, policy and activity; confirmation permits are principal/target/expiry bound and spent atomically with deletion. App intents resolve exact EN/VI commands and preserve voice confirmation semantics. REST and host executor use the same capability. Machine route guards and agent app-intent guards deny deletion and its approval.

Client: execute only after command reply settles; policy questions expose accessible actions; success starts a fresh conversation and says what was removed/kept; errors preserve the current conversation. No timeout-based success or fake controls.

Verify: focused migration/repository/runtime/intent/client tests; fault injection after each cleanup proves rollback; shared-byte and unattached-finalized-artifact tests; person-only contract tests; E2E ports 9176/4573/9178, 1280/390 light/dark plus keyboard and reduced motion; verify/full and relevant invariants. Validate this plan, review before shipping, merge only all CI green.

Docs: update retention sections EN/VI and official clarkcant-web; closure comment maps every acceptance to evidence. Rollback: restore backup before deleting data; downgrade does not restore erased conversations. Never apply migration to user data during local verification.

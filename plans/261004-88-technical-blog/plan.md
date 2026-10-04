---
title: Technical blog delivery — clarkcant-web#88
status: in-progress
---

# Technical blog delivery — clarkcant-web#88

Status: in progress. Accepted outcome: interactive articles composed from versioned blocks; shared Clark widgets; visual and AI editing; EN/VI published together; scoped small-team access; real surveys; REST, MCP, CLI; semantic HTML and Markdown.

Implementation is deployed at https://clarkcant.cc/blog/ (website PR #89).
Remaining: product branch integration/checks, and external GitHub OAuth App
configuration plus real ChatGPT/Claude consent verification. The user confirmed
on 2026-10-04 that no dedicated OAuth App exists. Do not mark those checks passed.
See [delivery evidence](reports/delivery-evidence.md).

Non-goals: marketplace installation and reader accounts. Preserve landing/docs routes. Do not claim live deployment or client consent without evidence.

## Phases

1. [Contracts and storage](phase-01-delivery.md): schema, immutable revisions, optimistic concurrency, auth, media, surveys.
2. Shared widget adapter and article/editor rendering, mobile and reduced motion.
3. REST/OpenAPI, MCP OAuth, CLI and content discovery.
4. Verification, review, EN/VI documentation, PRs and deployment where credentials permit.

Dependencies: widget catalog/renderer in clarkcant; marketplace issue #194 is adjacent, not a prerequisite. Website issue: https://github.com/digitopvn/clarkcant-web/issues/88. Worktree: D:/www/codex-worktrees/364a/clarkcant-blog.

## Acceptance

- Create via AI/CLI, edit visually, preview, publish EN/VI, revise and restore.
- Insufficient scopes cannot publish; stale revisions cannot overwrite newer edits.
- Drafts never leak into public HTML, Markdown, discovery or caches.
- Charts, diagrams, media, sandbox, carousel and survey work; core content survives unavailable JavaScript.
- Real provider and deployment checks remain explicitly blocked until performed.

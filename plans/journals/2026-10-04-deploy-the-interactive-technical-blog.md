---
title: Deploy the interactive technical blog
date: 2026-10-04
summary: Blog deployed; widget host verified locally; provider OAuth acceptance remains external.
---

# Deploy the interactive technical blog

## What happened

Implemented and deployed the bilingual technical blog through clarkcant-web PRs #89 and #90. Dynamic blocks share Clark's canonical widget renderer through a restricted public host. The editor, immutable revisions, scope-separated publication, media privacy, surveys, MCP/REST/CLI, semantic HTML and Markdown now have local and CI evidence. Production has no invented articles.

## Failures and evidence

Pages deployment initially failed because wrangler-action selected pnpm without Corepack activation; #90 corrected the workflow and deployment succeeded. The first visual check found small touch targets and a local font failure; the final three viewport reports have zero errors and warnings.

After integrating main, three Windows Git-worktree tests timed out and produced EPERM cleanup errors. Their source was unchanged from main. Serial retries passed 26 tests; the complete unit suite at four workers passed 6137 tests with 35 skips, followed by 55 specialized widget tests. No assertions or deadlines were weakened. Concurrency sensitivity is supported; the exact file-lock owner is unproven. Full pre-integration verification passed 421 browser tests, and the integrated-head full browser suite remains a required GitHub PR check.

## Decision and next steps

Keep product PR #453 draft until final-head CI succeeds. Keep website issue #88 open: the user has no dedicated GitHub OAuth App, so actual GitHub login and ChatGPT/Claude consent tests are pending. Callback is https://clarkcant.cc/auth/callback. Secrets belong in Cloudflare, never chat. Official English/Vietnamese docs already landed with #89. Marketplace installation remains the explicitly accepted future scope.

AgentWiki publish skipped.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.

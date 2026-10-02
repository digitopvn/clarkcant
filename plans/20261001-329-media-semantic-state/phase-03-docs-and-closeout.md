# Phase 3 — Official docs and closeout

## Context

- Issue: https://github.com/digitopvn/clarkcant/issues/329
- Must follow the merged feature PR.
- Official site instructions: `digitopvn/clarkcant-web/README.md` (English landing, paired English/Vietnamese docs).

## Requirements and steps

1. Check current official-site `main` and existing open issues/PRs for duplicate media documentation.
2. Add the smallest accurate English/Vietnamese docs page update and an English-only landing status-card update if the feature belongs there; link to the canonical widget-development section.
3. Create a focused PR after the feature PR merges. Merge only when its required checks pass.
4. Verify the deployment and live content in both docs languages.
5. Comment on #329 with every acceptance item, source PR/merge commit, local checks, CI including Windows and official docs/deploy evidence; then close the issue.

## Validation

The docs PR is merged, deploy run succeeded, live English/Vietnamese pages return the new content, and the issue is closed with its acceptance checklist.

## Risk and rollback

Do not publish claims beyond the merged feature behavior. Revert the docs PR if the live implementation or canonical contract changes before publishing.
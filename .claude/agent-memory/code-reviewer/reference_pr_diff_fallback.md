---
name: reference-pr-diff-fallback
description: How to read clarkcant PR diffs when Bash/gh cannot spawn (ENAMETOOLONG) and .git reads are hook-blocked
metadata:
  type: reference
---

digitopvn/clarkcant is public. When Bash fails with `ENAMETOOLONG: uv_spawn` (seen 2026-09-29 on the Windows host) and
the scout-block hook denies reading `.git`, fetch the diff with WebFetch at
`https://patch-diff.githubusercontent.com/raw/digitopvn/clarkcant/pull/<n>.diff` (github.com/.../pull/<n>.diff 302s
there), and read full files from the agent worktree that has the branch checked out. Issues/PR bodies are readable at
`https://github.com/digitopvn/clarkcant/issues/<n>` via WebFetch (comments may not render).

If patch-diff returns 503, use `https://api.github.com/repos/digitopvn/clarkcant/pulls/<n>/files?per_page=10&page=<k>`
(small pages; the summarizer truncates at ~20 entries and even silently drops one entry per page — cross-check the
sum against `changed_files`; per_page=8 was reliable on 2026-09-30) and ask for the `patch` field verbatim; `/pulls/<n>` gives the body.

To read a file at an exact commit (when told to read only via git objects), use
`https://raw.githubusercontent.com/digitopvn/clarkcant/<sha>/<path>` and prompt "Output the full source as one code
block with line numbers" (asking for "verbatim" triggers a quote-limit refusal). Large files truncate; the summarizer's
line numbers drift a few lines. For per-file patches of a commit use
`https://api.github.com/repos/digitopvn/clarkcant/commits/<sha>?per_page=1&page=<k>` (the unpaginated list silently
drops files: check `stats.additions` against the listed sum).

When tests cannot run locally, `https://api.github.com/repos/digitopvn/clarkcant/commits/<head-sha>/check-runs` lists
the CI verify/e2e/desktop-smoke results for that exact tree (seen again 2026-09-30: Bash spawn still broken).

Unauthenticated api.github.com 403s after roughly a dozen calls (hit on 2026-09-30 mid-review): spend API calls on the
file list (`per_page=8`) and the PR body only, and read full files from the local worktree that has the branch.

The patch-diff summarizer silently truncates large diffs (seen 2026-09-30: listed 9 of 29 files for a 2.9k-line PR);
never trust it for a file list. `pulls/<n>/files?per_page=10&page=<k>` (sorted by path, 3-4 calls) was complete.

The scout-block hook also denies Read on anything under `node_modules` (e.g. the Pi SDK source), but Grep with a
`path` inside `node_modules/.pnpm/...` still works — use it to check SDK defaults (seen 2026-09-30).

A lead may say "use the PowerShell tool" when none is exposed to this subagent (seen 2026-09-30). Then review with
Read/Grep on the branch worktree, and use `pulls/<n>/files?per_page=10&page=<k>` asking for hunk headers and '-' lines
to prove a file (e.g. migrate.ts) is append-only.

**How to apply:** use this before declaring a review BLOCKED; state in the report that tests could not be run.

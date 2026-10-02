# Phase 01 — TSV in the artifact primitive

## Context

- The #313 broker accepts the attachment allowlist only. `text/csv` was there; `text/tab-separated-values` was not.
- The desktop shell keeps its own copy of the type list (`PICKABLE_TYPES`), held equal to contracts by a test.

## Requirements

- Accept `text/tab-separated-values` (extensions `tsv`, `tab`; alias `text/tsv`) with the same sniffing, size and trust rules as CSV.
- A declared TSV is accepted on pick, a TSV is saved as `.tsv`, and a binary file declared as TSV is still refused.

## Files to modify

- `packages/contracts/src/{artifacts,attachments}.ts`
- `apps/runtime/src/{blobs,artifact-broker,delegated-artifacts}.ts`
- `apps/desktop/src/file-bridge.mjs`
- `packages/conversation-client/src/{artifact-messages,attachments}.ts`, `i18n/messages-timeline.ts`
- `packages/widget-cli/src/dev-artifacts.ts`
- Tests: `apps/runtime/test/artifact-broker.spec.ts`, `apps/desktop/test/file-bridge.spec.ts`
- Docs: `docs/widget-development{,.vi}.md` §10.1

## Steps

1. Add the type to every list next to `text/csv`.
2. Add broker and desktop tests for pick, alias, generic type, export name and binary refusal.
3. Mention the type in the artifact docs, EN and VI; refresh the docs manifest.

## Validation

- `corepack pnpm exec vitest run apps/runtime/test/artifact-broker.spec.ts apps/desktop/test/file-bridge.spec.ts packages/contracts/test`
- `pnpm typecheck`

## Risks and rollback

- A text type widens what a widget can pick; it is plain text under the same size and sniffing rules, so no new trust is granted. Revert the single commit to roll back.

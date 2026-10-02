# Phase 01 — Package, editor core and unit tests

## Context

- Issue: [#317](https://github.com/digitopvn/clarkcant/issues/317). Parent epic #200.
- Bridge and SDK: `packages/widget-sdk/src/index.ts` (`artifacts@1`, `actions.invoke`, `semantic.publish`, `state.update`).
- Precedents: `apps/web/e2e/fixtures/artifact-widget` (plain-JS frame code using `window.clarkcantWidget`), `examples/note-widget` (draft and conflict rules).
- Limits that shape the design: widget state 16 KiB (`WIDGET_STATE_MAX_BYTES`), semantic string values 200 characters (`SEMANTIC_LIMITS`), artifact chunk 256 KiB, agent reply output 2000 characters.

## Requirements

- Manifest v2 with one `ui` facet, `isolated-ui`, no permissions, no service, all four platforms plus web.
- `widgets/main/editor-core.js`: pure functions for the document model, line count, dirty state, persisted state shape and its bound, draft reconciliation between surfaces, the semantic proposal, reply extraction and bounded UTF-8 chunking.
- `widgets/main/main.js`: open (picker), chunked read, edit with the draft in widget state, save (finalize then host export), attach, ask Clark through the binding named in props, review-then-apply of the reply, keyboard shortcuts, host appearance tokens with a media-query fallback, reduced motion.
- Fixtures `default`, `empty`, `error`, `compact`.

## Files to modify/create

- `examples/reference-apps/text-editor/{clarkcant.json,README.md}`
- `examples/reference-apps/text-editor/widgets/main/{widget.json,index.html,main.css,main.js,editor-core.js}`
- `examples/reference-apps/text-editor/fixtures/*.json`
- `examples/reference-apps/text-editor/test/editor-core.spec.ts`
- `vitest.config.ts`, `tsconfig.json` (one include glob each)

## Steps

1. Write the core module and its unit tests first.
2. Write the frame code against the core module and the SDK surface.
3. Run `clark widget test` and `clark widget pack` on the package.

## Validation

- `corepack pnpm exec vitest run examples/reference-apps/text-editor`
- `node packages/widget-cli/src/cli.ts widget test examples/reference-apps/text-editor` and `... widget pack ...`
- `corepack pnpm typecheck`

## Risks and rollback

- A selection published less than the host's 250 ms settle before a press would let Clark read an older selection; the widget publishes first and waits past the settle before pressing.
- A reply is untrusted text: bounded, control characters removed, shown for review, applied only to an unchanged range.
- Rollback: delete the package directory and the two include globs.

## Status

Completed on 2026-10-02.

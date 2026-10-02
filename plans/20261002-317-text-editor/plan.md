---
title: "#317 Reference app A: text editor that opens and saves a real file"
status: completed
created: 2026-10-02
issues: [317]
related: [200, 313, 314, 318, 382]
---

# #317 Reference app A: text editor that opens and saves a real file

Pull request: [#383](https://github.com/digitopvn/clarkcant/pull/383).

## Outcome

`examples/reference-apps/text-editor/` is a first-party isolated-UI package (manifest v2, one `ui` facet, no service) that opens a person-picked text file as an ArtifactRef, edits it with the draft kept in widget state, saves it back (Replace original on desktop, Save As download on web) and attaches a copy to the conversation, all through `artifacts@1`. It publishes a bounded semantic document (name, line count, dirty flag, selection range and excerpt) and asks Clark to rewrite the selection through its own `agent` binding whose `contextRefs` read the selection; the reply arrives as the binding's output and is applied only when the person accepts it. Its shape is the `pure-ui` template of `clark widget init --template`.

## Constraints and non-goals

- Shipped #313 and #314 APIs only. No new dependency, route, migration, bridge message or SDK method.
- The frame never sees a path, a file handle or a secret; picker, Save As and Replace original stay host chrome. The model never writes into the frame and never approves a save.
- Widget state is limited to 16 KiB, so a draft larger than the persisted bound is kept only in the open frame and the widget says so.
- Clark sees the selection through the host-normalized semantic document: at most 200 characters, whitespace folded. The widget refuses to ask for a longer selection rather than sending a cut one.
- Non-goals: syntax highlighting, multi-file projects, collaboration, binary formats, any file access other than ArtifactRefs. Typing in the composer cannot change the frame; that gap is tracked by #382.

## Dependencies

- #313 (ArtifactRef broker) and #314 (agent bindings with context refs) are merged on `main`.
- #318 (spreadsheet) runs in parallel in another worktree; shared files are touched append-only (`vitest.config.ts`, `tsconfig.json`, e2e `directory.json`, `fixture-model.ts`, `widget-cli/src/cli.ts`, docs anchors).

## Phases

1. [Package, editor core and unit tests](phase-01-package-and-editor-core.md)
2. [pure-ui template, fixture wiring and browser journeys](phase-02-template-and-browser-journeys.md)
3. [Docs, verification and PR body](phase-03-docs-and-verification.md)

## Acceptance

- Unit tests cover editor state, the semantic document, dirty and conflict handling, and reply extraction.
- E2E: open a fixture file, edit, save, reopen and see the saved text on the desktop path (simulated preload bridge, Replace original) and the web path (Save As download); select text, ask Clark, see the host-read selection in the reply and the change applied after acceptance; no host path in any bridge message.
- Keyboard only, light and dark themes, 390 px and reduced motion are exercised.
- `clark widget test` and `pack` pass for the package; `init --template pure-ui` produces a copy that passes `test`.
- `pnpm verify` and `pnpm verify:full` pass; EN/VI docs updated; official docs follow after merge.

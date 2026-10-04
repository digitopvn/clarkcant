# Text editor (reference app)

A widget that opens a text file the person picks, edits it, and saves it back — on the desktop over the original
file, on the web as a download — without ever seeing where the file lives. It is the shape `clark widget init
--template pure-ui` starts from.

- **One isolated UI facet, no service, no permissions.** Every file operation goes through `api.artifacts`.
- **Open:** `artifacts.pick({ accept })` shows the host's own prompt; the editor receives an `ArtifactRef` (an opaque
  id, a name, a type and a size) and reads the bytes in 256 KiB chunks. Files over 1 MiB, and bytes that are not
  UTF-8, are refused with the reason.
- **Edit:** the unsaved draft lives in widget state, so a reload, another window or another device shows it. A draft
  larger than the state can hold is not cut; the editor says it will not survive a reload. The editor recognizes its
  own write when the host commits it, even after the person has typed on, so that is never shown as a conflict. If
  the saved copy cannot be read back after a reload and there is no draft, no document is shown and Save stays off.
- **Save:** the editor writes a finalized copy and calls `artifacts.export`. The host decides where it goes: the
  desktop offers *Replace original* for the file picked in this frame until it reloads, the web starts a download. The
  editor learns only whether the host took the copy, and says no more than that.
- **Attach:** a finalized copy is put in the composer with `artifacts.attachToConversation`.
- **Conflicts:** when another view of the same editor changes the draft while this one has unsent edits, the editor
  shows both choices and throws neither away.
- **Ask Clark:** select text on one line, up to 200 UTF-16 units, with nothing the host would hide or redact, and
  press *Nhờ Clark viết lại đoạn chọn*. The editor presses its own `agent` action binding (named in props as
  `rewriteBinding`) and holds the selection read-only until the answer. The host sends the editor's latest semantic
  document before it runs the press, reads the selection through the binding's `contextRefs`, runs one turn, and
  returns Clark's reply as the press's output. Only a reply with exactly one closed fenced block is a proposal. The
  editor shows it with the text it would replace, and changes the text only when the person accepts it and the range
  still holds the text Clark read; Ctrl+Z undoes it.

The `place_widget` tool binds `rewriteBinding` when Clark places the editor with that button; without it the button is
disabled with its reason shown. The editor also offers Clark a `replaceSelection` action (`{text, expected?}`) through
`actions.perform@1`, so a request typed in the composer, such as "uppercase the selection", can replace the selected
text: the editor refuses when it is busy, when nothing usable is selected or when the selection no longer holds
`expected`, and Ctrl+Z undoes the change. See
[widget development §10.3](../../../docs/widget-development.md#103-actions-clark-performs-actionsperform1).

## Files

- `clarkcant.json` — the manifest (schema version 2).
- `widgets/main/widget.json` — props (`title`, `rewriteBinding`), the state schema, sizing and the text fallback.
- `widgets/main/editor-core.js` — the editor's rules as pure functions, tested in `test/editor-core.spec.ts`.
- `widgets/main/main.js` — the frame code: the DOM, the SDK calls and the keyboard shortcuts (Ctrl/Cmd+S saves,
  Escape closes whichever panel is open).
- `fixtures/` — the four prop sets the conformance suite requires.

## Check it

```sh
node packages/widget-cli/src/cli.ts widget test examples/reference-apps/text-editor
node packages/widget-cli/src/cli.ts widget pack examples/reference-apps/text-editor
corepack pnpm exec vitest run examples/reference-apps/text-editor
```

The browser journeys (open, edit, save on the web and, against a simulated shell, on the desktop; typing on while a
draft write is held; ask Clark; keyboard only; light and dark; 390 px; reduced motion) are in
`apps/web/e2e/text-editor.spec.ts`.

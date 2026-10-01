# Text editor (reference app)

A widget that opens a text file the person picks, edits it, and saves it back — on the desktop over the original
file, on the web as a download — without ever seeing where the file lives. It is the shape `clark widget init
--template pure-ui` starts from.

- **One isolated UI facet, no service, no permissions.** Every file operation goes through `api.artifacts`.
- **Open:** `artifacts.pick({ accept })` shows the host's own prompt; the editor receives an `ArtifactRef` (an opaque
  id, a name, a type and a size) and reads the bytes in 256 KiB chunks. Files over 1 MiB, and bytes that are not
  UTF-8, are refused with the reason.
- **Edit:** the unsaved draft lives in widget state, so a reload, another window or another device shows it. A draft
  larger than the state can hold is not cut; the editor says it will not survive a reload.
- **Save:** the editor writes a finalized copy and calls `artifacts.export`. The host decides where it goes: the
  desktop offers *Replace original* for the file that was opened, the web downloads it. The editor learns only
  whether it was saved.
- **Attach:** a finalized copy is put in the composer with `artifacts.attachToConversation`.
- **Conflicts:** when another view of the same editor changes the draft while this one has unsent edits, the editor
  shows both choices and throws neither away.
- **Ask Clark:** select up to 200 characters and press *Nhờ Clark viết lại đoạn chọn*. The editor presses its own
  `agent` action binding (named in props as `rewriteBinding`). The host reads the selection from the editor's
  semantic document through the binding's `contextRefs`, runs one turn, and returns Clark's reply as the press's
  output. The editor shows the proposed replacement and changes the text only when the person accepts it, and only if
  the selected text is still what Clark was shown.

Typing a request in the composer cannot change the editor's text today: no agent tool can perform an isolated
widget's own action. That gap is tracked in
[digitopvn/clarkcant#382](https://github.com/digitopvn/clarkcant/issues/382).

## Files

- `clarkcant.json` — the manifest (schema version 2).
- `widgets/main/widget.json` — props (`title`, `rewriteBinding`), the state schema, sizing and the text fallback.
- `widgets/main/editor-core.js` — the editor's rules as pure functions, tested in `test/editor-core.spec.ts`.
- `widgets/main/main.js` — the frame code: the DOM, the SDK calls and the keyboard shortcuts (Ctrl/Cmd+S saves,
  Escape dismisses a proposal).
- `fixtures/` — the four prop sets the conformance suite requires.

## Check it

```sh
node packages/widget-cli/src/cli.ts widget test examples/reference-apps/text-editor
node packages/widget-cli/src/cli.ts widget pack examples/reference-apps/text-editor
corepack pnpm exec vitest run examples/reference-apps/text-editor
```

The browser journeys (open, edit, save on the web and on the desktop, ask Clark, keyboard only, light and dark,
390 px, reduced motion) are in `apps/web/e2e/text-editor.spec.ts`.

# Review of PR #345: ArtifactRef broker (issue #313), head 40219e69

This review is based on reading the source, the PR body, web PR #46, and the screenshots. Tests were not run here; CI is green on this head.

Verdict: not ready to merge.

## What holds up

- A single access decision (`decideArtifactAccess`) is re-checked on every use.
- Pick and export are refused on machine surfaces with `PERSON_ONLY`.
- Staging names are pattern-checked and kept inside the staging folder.
- Each blob has one writer.
- Migration 38 only adds; migrations 1–37 are unchanged.
- The retention gap in #343 is stated honestly.

## Blockers

### B1. Host paths leak into the widget through desktop bridge errors

In `apps/desktop/src/main.mjs`, `stat`/`readFile` (lines 462-465) and `writeFile` (line 501) run without try/catch. In `widget-artifacts.tsx`, lines 184-194 and 217-223 (via `artifactRefusal`, lines 41-48) forward `cause.message` to the frame.

Failure: an `EBUSY` from a file open in Excel (`… 'C:\Users\Duy\Documents\bao-cao.csv'`), or an `EPERM`/`EACCES` from Controlled Folder Access, reaches the widget with the user name and full path.

Fix:
- Wrap these calls in try/catch in `main.mjs` and return a fixed, localized refusal carrying at most the error code.
- In `widget-artifacts.tsx`, never forward the message of a non-`GatewayError` error to the frame. Send a fixed code (`ARTIFACT_PICK_FAILED` / `ARTIFACT_SAVE_FAILED`) with a fixed sentence.
- Add a test that injects an Error whose message contains `C:\Users\x\f.csv` and asserts the posted result does not contain it.

### B2. Non-Latin-1 file names make Open and Save As hang forever

`routes/artifacts.ts` (lines 93-95, 136, 164) and `routes/attachments.ts:169` write a raw `content-disposition` header. `writeHead` then throws `ERR_INVALID_CHAR`, and because `writeResult` in `server.ts` (lines 176, 246) runs outside the try/catch, no response is ever sent.

Effect:
- `Kế hoạch tổng hợp.md` never opens or saves.
- The Save As panel stays busy with Cancel and Esc disabled.
- Every later request from that frame gets `ARTIFACT_BUSY`.
- The file card shows "Đang mở…" forever.

Fix:
- Send an RFC 6266 header of the form `attachment; filename="<ascii fallback>"; filename*=UTF-8''<pct-encoded>`, from one helper shared by artifacts and attachments.
- Guard `writeResult` so that a failed header write ends the response with a 500.
- Add server-level tests (through `createNodeServer`) with `Kế hoạch.md` for `/artifacts/:id/content`, `/export` and `/attachments/:id/content`.

### B3. Widget artifacts can permanently exhaust the shared 1 GiB quota

- Artifacts and attachments share one quota (`artifact-broker.ts:101-104`, `routes/attachments.ts:91`).
- Finalized and external artifacts never expire (`artifact-broker.ts:201`, `artifact-refs.ts:128`).
- Nothing can delete an artifact.

Failure: an editor widget that saves by create/write/finalize at 5 MiB per save fills the quota after about 200 saves. From then on, every composer attachment and every widget file operation is refused permanently. A hostile widget can do this with no gesture from the person.

Fix:
- Add `artifacts.discard(ref)`, backed by `DELETE …/artifacts/{id}`, for working or finalized artifacts whose `instance_id` is the calling instance.
- Add a per-instance cap inside the principal quota (100–200 MiB).
- Record in #343 that cleanup of sealed artifacts that are not attached and not exported must ship with conversation deletion.

## Should-fix

### S1. The widget chooses the saved file's extension

A `text/plain` artifact can be exported as `invoice.bat`, `.hta`, `.ps1` or `.lnk`. See `routes/artifacts.ts:146-152`, `file-bridge.mjs:83-95` and `main.mjs:497`, which passes no `filters`.

Fix: derive the extension from `record.mimeType` (via `PICKABLE_TYPES` / `extensionForText`), replacing or appending as needed, and pass matching `filters` to `showSaveDialog`.

### S2. The instance is not checked against the conversation in the path

`routes/artifacts.ts:182-189` never checks `instance.conversationId === conversationId`.

Fix: return 404 `RESOURCE_NOT_FOUND` on a mismatch, and add a test.

### S3. The frame session does not bound artifact messages

In `widget-host/src/session.ts` (lines 527-538, 462-474) and `WidgetFrame.tsx:334-335`:
- a message claiming `artifact.request` skips the `maxMessages` count;
- messages that fail the schema or are turned away are never counted;
- `refusals` grows without bound.

Also, the SDK does not queue requests, so a `Promise.all` of 5 or more reads gets `ARTIFACT_BUSY`, and that flips the frame to "refused". The 2,000-request budget is a lifetime cap, so an autosaving widget is refused after about an hour.

Fix:
- Count every message that claims to be an artifact request before validating it.
- Cap `refusals` with a ring buffer.
- Queue requests in the SDK up to the in-flight limit.
- Do not flip the frame's status for artifact turn-aways.
- Replace the lifetime budget with a token-bucket rate.

### S4. The creator's grant expires 24 hours after its last write

After that the widget cannot read its own file, and the refusal message wrongly tells it to ask the person to pick the file again.

Fix: renew the grant on read or describe for the creating instance, or do not expire the creator's grant on a sealed artifact. Correct the message.

### S5. Web pick sends `application/octet-stream` when `file.type` is empty

`.md` and `.log` files are then refused with `ARTIFACT_TYPE_MISMATCH` (`widget-artifacts.tsx:172`, `blobs.ts:437-446`).

Fix: send `file.type` as given; an empty type sniffs as text/plain.

### S6. Focus jumps to the primary button

A keystroke meant for the widget can approve its export (`widget-artifacts.tsx:291-295`).

Fix: focus the panel or its title instead, or ignore activation for about 500 ms after the prompt appears.

### S7. Desktop "Replace original" is unsafe

- `writeFile` truncates the original before writing. Write to a temporary file in the same folder and rename it over the original.
- The replacement's type is not checked against the original's.
- The dialogs are English only. Pass localized strings from the renderer.

### S8. Docs overclaim

- "The pick prompt names the widget". It does not; add the widget title to the prompt.
- The person-only rationale in `open-interfaces` needs rewording: the rule is about the act of saving, not about access to data.
- PR body: "expired … grants are swept" is inaccurate, and so is "Save As first checked through the widget-scoped describe" for the file card.
- Web #46:
  - The route table is clipped at 1280 px in both EN and VI, so the description column cannot be seen.
  - Say "24 hours after its last write".

### S9. "Saved" is reported on the web when only a download was started

Fix: say "Đã bắt đầu tải xuống" / "Download started", with a separate outcome value (`download.ts:79-81`, `widget-artifacts.tsx:215`, `renderers.tsx:2664`).

## Nits

- Nothing reconciles orphaned staging files or blobs after a crash between seal and insert; add a boot sweep of `blobs/staging/`.
- `blobStillReferenced` ignores session previews, mini-app data and delegated task outputs. Fix this before #343 wires release.
- An empty (0-byte) working artifact cannot be finalized.
- English node reasons appear inside VI/EN templates.
- `use-surface-renderer.tsx:164` puts a statement and a block comment on one line.
- The wording "the handle this window was given" is wrong: handles are process-wide.
- The fixture evidence is clipped.

## Controller UX notes (screenshots)

- The pick prompt shows the raw MIME type ("Loại tệp: text/*"). Humanize it ("tệp văn bản", "ảnh PNG", …).
- The fixture widget's status line is clipped at 390 px.

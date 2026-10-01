# Re-review of PR #345: ArtifactRef broker (issue #313), head 3df74c2a

This round checks the fixes against `review-345.md` and looks for defects the fixes introduced. I read the source in `D:\wt313`, and the PR file list and patch hunks through the GitHub API.

I could not run tests locally. This session has no PowerShell tool, and Bash fails with `ENAMETOOLONG: uv_spawn`. CI on this exact head is green: all 17 check runs passed, including verify on ubuntu, macOS and Windows, e2e, desktop smoke and the secret scan. Passing CI does not cover any finding below. Each one is a case no test exercises.

**Verdict: not ready to merge.**

- **One blocker remains.** B3's quota exhaustion is still reachable through `attach`.
- **One claimed fix has a bypass.** A long name defeats S1's extension rule on the web download path.
- **The fixes introduced three new should-fix defects:**
  - picked files permanently lock a widget out of its own share;
  - a sibling frame can drain another frame's file-request rate;
  - the atomic replace loses file permissions.

## Checklist status

| Item | Status | Evidence |
|---|---|---|
| B1 host paths leak through bridge errors | **FIXED** | See B1 below. |
| B2 non-Latin-1 names hang Open/Save | **FIXED** (new defect in the helper, see S1) | See B2 below. |
| B3 widgets exhaust the shared quota | **NOT FIXED** | See N-B1 below. |
| S1 widget chooses the saved extension | **PARTIAL** | See N-S1 below. |
| S2 instance not checked against the path's conversation | **FIXED** | `routes/artifacts.ts:192-194` (`instanceIsInConversation`, same 404 as a missing instance); `storage/.../widgets.ts:62-76`; test `artifact-broker.spec.ts:419`. |
| S3 frame session does not bound artifact messages | **FIXED as asked**, with two new defects (N-S3, N-S4) | See S3 below. |
| S4 creator's grant expires | **FIXED** | `contracts/src/artifacts.ts:243-252` (the creator of a sealed `finalized` artifact keeps read access). The external-expiry message is now correct. Test `artifact-broker.spec.ts:384`. |
| S5 web pick sends octet-stream for an empty type | **FIXED for the empty-type case**; residual in N-S5 | `widget-artifacts.tsx:65-72` |
| S6 focus jumps to the primary button | **FIXED** | `widget-artifacts.tsx:326-342` focuses the title (`tabIndex=-1`), never a button. A new focus-theft nit is below. |
| S7 Desktop "Replace original" unsafe | **FIXED as asked**; new defect in N-S6 | See S7 below. |
| S8 docs overclaim | **FIXED in this repo**; web #46 not verified here | `docs/open-interfaces.md:310-364` now says "what is held back is the act, not the data"; the pick prompt names the widget (`widget-artifacts.tsx:282-285`). The PR body now says grants are "refused immediately". |
| S9 "Saved" on a web download | **FIXED** | `download.ts:69,112`, `widget-artifacts.tsx:251`, `renderers.tsx:2668`, VI and EN strings in `messages-timeline.ts:380,465,1087,1168`. Test `widget-artifacts.spec.ts:219`. |
| Nit: boot sweep of staging | **FIXED** | `artifact-broker.ts:648-662,692-698`; test `:673`. A blob sealed or written before its row is inserted can still be orphaned on a crash. That is minor. |
| Nit: `blobStillReferenced` misses previews, mini-app data, task outputs | **FIXED** | See the nits row below. |
| Nit: empty working artifact cannot be finalized | **FIXED for text types** | `artifact-broker.ts:476-479`; test `:656`. |
| Nit: English node reasons in VI/EN templates | **FIXED** | `artifact-messages.ts:58-101` words every reason by its code. |
| Nit: `use-surface-renderer.tsx:164` formatting | **FIXED** | |
| Nit: "handle this window was given" wording | **FIXED** | The string no longer appears. |
| Nit: fixture evidence clipped / status line clipped at 390 px | **Not verified** | These are visual; I did not check them here. |
| UX: raw MIME in the pick prompt | **FIXED** | `artifact-messages.ts:32-56` |
| Migration 38 additive, 1–37 untouched | **VERIFIED** | See the migration row below. |

Evidence for the longer rows:

**B1: FIXED**
- `main.mjs:466-474` and `516-520` wrap stat/read/write and return `fileRefusal(code, cause)`.
- `file-bridge.mjs:57-63` passes on at most `E[A-Z]+`.
- `widget-artifacts.tsx:51-56` sends the widget only the `GatewayError` reason or a fixed sentence. `:219` swallows a bridge throw.
- `session.ts:526-533` sends a fixed sentence if the broker throws.
- The server's 500 body is `{error:{…}}`, which `api.ts:729-736` maps to `UNKNOWN` / "the request failed", so a thrown fs message never reaches `GatewayError.reason`.
- Test: `widget-artifacts.spec.ts:137`.

**B2: FIXED**, with a new defect in the helper (see S1)
- `routes/content-disposition.ts` is shared by `routes/artifacts.ts:134,164` and `routes/attachments.ts:147`.
- `server.ts:195-208` guards `writeResult`, and `server.ts:283-286` validates every header before the first `writeHead`.
- Server-level tests: `artifact-server.spec.ts:100-193`.

**S3: FIXED as asked**, with two new defects (N-S3, N-S4)
- A token bucket charged before parsing: `session.ts:228-243,580-586`.
- Refusals kept in a ring of 64: `:296-299`.
- Answered turn-aways no longer flip the frame's status: `WidgetFrame.tsx:331`.
- The SDK queues past 4 requests in flight: `widget-sdk/src/runtime.ts:104-121`.

**S7: FIXED as asked**, with a new defect (N-S6)
- Temp file plus rename: `file-bridge.mjs:207-216`.
- Type kept on replace: `:196-198`, `main.mjs:501`.
- Localized labels: `file-bridge.mjs:173-187`, `artifact-messages.ts:104-118`.

**Nit on `blobStillReferenced`: FIXED**
- `artifact-refs.ts:295-326` covers attachments, artifacts, `local_images` (mini-app images), `task_artifacts`, `evidence` and `messages.document` (previews).
- This broadened check has a new cost; see N-S7.

**Migration 38: VERIFIED**
- The `migrate.ts` patch is `+48 -0`, in one hunk `@@ -1522,6 +1522,54 @@` that only appends version 38.
- `migrate.ts:1525-1572` is `ALTER TABLE … ADD COLUMN`, `CREATE INDEX` and `CREATE TABLE artifact_grants`.
- The only other change to storage tests is the schema version bump in `audit.spec.ts:58`.

## Blockers

### N-B1. B3 is still reachable: `attach` bypasses the per-instance cap, and it can fill the principal quota with no person gesture

**Where:**
- `apps/runtime/src/artifact-broker.ts:530-565` (`attachArtifact`) checks the principal quota but never calls `checkInstanceQuota`.
- It inserts a new attachment row on every call (`:551-563`), with no idempotency per artifact.
- `packages/storage/src/repositories/attachments.ts:99-106` sums `size_bytes` per row. Rows sharing one content-addressed blob are counted once each.
- `widget-artifacts.tsx:151-156` runs `attach` straight against the node. There is no prompt.
- Nothing ever deletes an unsent attachment. There is no sweep, no UI, and conversation deletion (#343) is not built.

**Failure scenario:**
1. A widget creates a `text/plain` artifact and writes 25 MiB (100 chunks).
2. It finalizes the artifact and then calls `attach` 40 times. The whole run is about 140 requests, inside the 300-request burst, so it takes a few seconds.
3. Each attach adds a 25 MiB attachment row, which puts about 1 GiB of attachment rows against the principal.
4. From then on, every composer attachment and every widget file operation for this person is refused with `ARTIFACT_QUOTA_EXCEEDED` / `ATTACHMENT_QUOTA_EXCEEDED`.

This is permanent: `discard` removes only the artifact row (`:612`), and nothing can remove the attachment rows. It is the same outcome B3 described, reached by a different operation. The composer also receives 40 chips through `onAttach`.

**Fix (all three):**
1. Make `attach` idempotent per artifact and conversation, returning the existing attachment row for the same `artifactId` and not inserting another. This needs a column or a lookup by `sha256` + `conversationId` + source artifact.
2. Count attachment rows that came from a widget's artifact against that instance's share.
   - Record the source instance on the row, or keep the artifact row alive while an attachment points at it.
   - Make `discard` not release the share while an attachment exists.
3. Add a broker test showing that repeated attach of one artifact does not grow `storedBytesForPrincipal`, and that attach counts toward `ARTIFACT_INSTANCE_QUOTA_EXCEEDED`.

## Should-fix

### N-S1. S1 bypass: the 120-code-point clip in `contentDisposition` can cut the forced extension off, and the web download then uses the clipped name

**Where:**
- `routes/content-disposition.ts:13,46` clips the name to 120 code points.
- Names may be up to 200 characters:
  - `contracts/src/artifacts.ts:66,82` (`nameMaxChars` = 200);
  - `widget-sdk/src/index.ts:50,55` (the bridge's `suggestedName` max is 200).
- `artifactFileName` (`contracts/src/artifacts.ts:345`) returns a name that already ends in an allowed extension unchanged, at any length up to 200.
- `routes/artifacts.ts:154,164` builds the header from that name.
- The web client takes the name from `filename*` (`api.ts:584-592, 1802`) and downloads under it (`download.ts:111`).

**Failure scenario:**
1. A widget holds a finalized `text/plain` artifact whose bytes are a script.
2. It asks to export it with `suggestedName = "a".repeat(116) + ".bat.txt"` (124 characters).
3. `artifactFileName` keeps the name, because `.txt` is allowed.
4. `contentDisposition` clips it to `"a…a.bat"`.
5. On the web the person presses Save As, and the browser downloads `a…a.bat`. The prompt showed a name ending in `.txt`.
6. `.hta`, `.cmd`, `.ps1` and `.vbs` work the same way.

The desktop is not affected, because `saveNameForType` (`file-bridge.mjs:105-115`) re-applies the rule.

**Fix (all four):**
1. Clip the stem, not the whole name, and keep the extension. The simplest way is to make `artifactFileName` cap its result at the header's limit, or to raise `NAME_MAX_CHARS` to `nameMaxChars`.
2. Have `contentDisposition` preserve the last `.ext` when it clips.
3. Have the web path run the downloaded name through the same `artifactFileName(name, mimeType)` before `downloadBlob`.
4. Add a server test that exports a 124-character `….bat.txt` name and asserts the `filename*` value ends in `.txt`.

### N-S2. Picked files lock a widget out of its own share permanently

**Where:**
- `artifactUsageForInstance` (`storage/.../artifact-refs.ts:206-213`) counts `external` (picked) rows.
- `storePickedArtifact` checks the instance cap (`artifact-broker.ts:216-217`).
- `discardArtifact` refuses `external` (`:600-607`).
- External rows are never swept: the sweep takes only `working` rows (`artifact-refs.ts:226-233`), and nothing removes an expired external row.
- The refusal tells the widget to "discard files it no longer needs with artifacts.discard" (`:126-129`), which is impossible for these rows.

**Failure scenario:**
1. The person uses a photo or PDF viewer widget and picks about thirteen 10 MiB files over a week, or picks one 25 MiB file six times. Every pick is a new row.
2. The widget's share reaches 128 MiB.
3. Every later pick (the person's own act) and every create is refused with `ARTIFACT_INSTANCE_QUOTA_EXCEEDED`, forever.
4. Neither the widget nor the person can free anything, because no person-facing delete exists.

**Fix (any one):**
- Do not count `external` rows in the instance share. They are the person's choice, and they still count in the principal quota.
- Or let the widget "let go" of an external ref: drop its grant and remove the row, releasing the blob if nothing else references it.
- Or dedupe picks by digest per instance.

Add a test that fills the share by picking and then picks again.

### N-S3. A sibling frame can drain another frame's file-request rate

**Where:**
- `session.ts:572-586` spends a token for every message whose `kind` is `artifact.request` before looking at `sourceMatchesExpectedWindow`.
- Every `WidgetFrame` listens on the host `window` and hands every message to its own session (`WidgetFrame.tsx:314-316`).
- The test `session.spec.ts:674-683` codifies spending on wrong-window messages.

**Failure scenario:**
1. Widget B runs `setInterval(() => parent.postMessage({kind: "artifact.request"}, "*"), 5)`.
2. Every other frame session on the page spends its bucket on B's messages. A's own requests are then answered `ARTIFACT_RATE_LIMITED` for as long as B keeps posting.
3. The refusal for a foreign message is not `answered` (`:583`), so A's frame is also flipped to "refused" with a notice (`WidgetFrame.tsx:336-337`).

A hostile widget can therefore deny file access to every other widget on the page.

**Fix:**
- Before the token and message counting, return early (no spend, no status flip) when `!event.sourceMatchesExpectedWindow`. Better still, filter in `WidgetFrame.onMessage` before calling `accept`.
- Invert the test: wrong-window messages must not spend this frame's bucket.

The same pre-existing issue affects the ordinary `maxMessages` counter (`:590-595`). Fix both.

### N-S4. The artifact transcript grows without bound

**Where:** `session.ts:522` pushes one transcript entry per accepted artifact request. Artifact requests are no longer bounded by `maxMessages` (`:590`), and the bucket refills at 10 per second, indefinitely.

**Failure scenario:** a pinned autosaving or streaming widget left open for a day holds hundreds of thousands of entries in the host page's memory. A hostile widget can do the same deliberately.

**Fix:** keep the transcript in a ring buffer, as `refusals` now is, or record artifact requests as a counter per op.

### N-S5. Pick still refuses common real files whose browser or desktop type claim is wrong (S5 residual)

**Where:**
- `widget-artifacts.tsx:65-66` returns any non-empty `file.type` unchanged.
- `file-bridge.mjs:74-78` declares `application/octet-stream` for an unknown extension.
- `blobs.ts:437-446` refuses text whose declared type is not in `TEXT_MIMES`.

**Failure scenario:**
- On Windows with Office installed, browsers report `.csv` as `application/vnd.ms-excel`, so a CSV picked for a `text/csv` widget is refused with `ARTIFACT_TYPE_MISMATCH`.
- Some Linux setups report `.md` as `text/x-markdown`, with the same result.
- On the desktop, a text file with no or an unlisted extension, typed into the dialog, is declared octet-stream and refused.

**Fix:** when the claimed type is not in the allowlist, fall back to the extension mapping, else `""`, and let the node sniff. Do this in both `pickedFileType` and `mimeForFileName`.

### N-S6. "Replace original" loses the file's permissions and identity, and fails on transient Windows locks

**Where:** `file-bridge.mjs:207-216`.

**Failure scenarios:**
- **Permissions (macOS/Linux):** a `0600` private note becomes `0644` after Replace, because `writeFile` creates the temp file with the umask default. This is a privacy regression.
- **Links:** a symlinked target is replaced by a regular file, and a hard link is split.
- **Windows metadata:** explicit ACLs and alternate data streams on the file are dropped.
- **Windows transient locks:** `rename` over a file that the Search indexer, antivirus or OneDrive briefly holds fails with `EPERM`/`EACCES`/`EBUSY`, and Node does not retry. The person sees "not saved" on a file that is only momentarily locked.
- **Long names:** a 250-character target name overflows `NAME_MAX` in the temp name `.<name>.<12 hex>.tmp`. The replace then fails where a plain write would work.

**Fix:**
- `stat` the target first and `chmod` the temp file to its mode (plus `chown` where permitted).
- Resolve a symlinked target with `realpath` before choosing the temp folder.
- On win32, retry `rename` a few times with short backoff on `EPERM`/`EACCES`/`EBUSY`, as graceful-fs does.
- Use a short temp name, for example `.cc-<12 hex>.tmp`.
- Test: mode preserved, cleanup on a failed rename.

### N-S7. `discard` and the sweep make a full scan of `messages.document` for every finalized blob

**Where:** `artifact-refs.ts:311-325`. `instr(document, ?)` over every message row is a full table scan, run synchronously on the node thread. `discardArtifact` (`artifact-broker.ts:613`) and conversation release reach it for every finalized blob.

**Failure scenario:** a widget loops create → write 1 byte → finalize → discard, at about 2.5 finalized discards per second within the rate. On a node with a large timeline, each discard blocks the event loop for the length of a full scan, which stalls every other conversation and stream.

**Fix:**
- Check the cheap tables first (already done), and keep previews' digests in an indexed column or table instead of substring-searching message JSON.
- At minimum, skip the digest scan for a blob whose file name only this artifact row could have produced.

## Nits

- **`apps/desktop/src/index.ts:34-47`:** the declared `pickFile`/`saveFile` types are stale.
  - `saveFile` is missing the required `mimeType`, and also `labels`.
  - `pickFile` is missing `filterName`, and neither type declares `errorCode`.
  - A caller following this type gets `INVALID_REQUEST`.
- **`widget-artifacts.tsx:428-432`:** "Replace original" is offered for any export after any pick in this frame, even when the exported artifact has nothing to do with the picked file. It is two person gestures, but the label implies a relationship that does not exist. Offer it only when the export derives from that pick, or name both files.
- **`widget-artifacts.tsx:334-338` (focus theft):** a widget can re-ask `pick` immediately after each cancel, and focus jumps to the prompt every time, so the person cannot type in the composer. Take focus only when focus was in the frame or its surface; otherwise announce the prompt.
- **`action-context.ts:107-110, 181-185`:** these distinguish "no such file" from "belongs to someone else" (`CONTEXT_REF_UNKNOWN` vs `CONTEXT_REF_FORBIDDEN`). That is an existence oracle across principals, and it contradicts the one-answer rule in `routes/artifacts.ts:111`. Map `ARTIFACT_CROSS_PRINCIPAL` to the same answer as not-found.
- **`action-context.ts:261`:** `inertContextText` normalizes CR, NEL, LS and PS, but not `\v`, `\f` or `\x1c`–`\x1e`, which some tokenizers and renderers treat as line breaks. A file line after `\f` could appear unindented. Fold these into `\n` as well.
- **`contracts/src/attachments.ts:171` → `artifact-broker.ts:215,424,550`:** the quota refusal tells the widget how many bytes the person stores across all conversations. Give the widget a message without the principal's usage figure.
- **`routes/artifacts.ts:289-292`:** `DELETE …/grant` is described as "the person's act", but no UI calls it and it is not person-only, so only raw HTTP, relays and MCP reach it. Either wire it to host chrome and make it person-only, or drop it until #343.
- **`use-surface-renderer.tsx:158`:** the file card's Save As passes the card's `ref.mimeType` to the desktop instead of the type the node returned in the export response's `content-type`. A card whose ref claims a different allowlisted type saves PDF bytes as `.txt`. This is not executable, but it is mislabelled.
- **`content-disposition.ts:26-36`:** the ASCII fallback keeps `%`, which some old readers percent-decode. Replacing `%` with `_` in the fallback only is cheap.
- **Bidi controls:** U+202E and similar survive in names (`content-disposition.ts:40-44`, and the prompt title at `widget-artifacts.tsx:406-407`). This allows visual extension spoofing in the prompt. Strip bidi controls from display and file names.
- **Unrecorded blobs after a crash:** a blob written by `storePickedArtifact`, or sealed by `finalizeArtifact`, before its row is written or updated is not reconciled at boot. Only staging is. This is low priority, but it should be recorded in #343.

## Verified non-issues

These were probed and hold. No change is needed.

- **Widget A discarding widget B's artifact:** refused `ARTIFACT_NOT_CREATOR`, because the host builds the path from its own `instanceId` (`artifact-broker.ts:600-607`; test `artifact-broker.spec.ts:574`).
- **Discarding picked or attached files:** discarding a picked file is refused. Discarding an attached file keeps the attachment and its blob (`:563`).
- **Machine surfaces:** `POST /artifacts/:id/export` and `…/artifacts/pick` are person-only (`contracts/src/machine-surfaces.ts:38-39,53-55`). Other widget-instance routes stay reachable by the principal's own token, as documented.
- **Quota races (concurrent writes, discard then write):** none are possible in one process. Every broker function is synchronous (the SQLite calls and fs `*Sync` calls do not yield), and the offset check at `artifact-broker.ts:407-412` refuses a stale writer.
- **RFC 6266 header:**
  - quotes, backslashes, C0 and C1 characters are removed before either form is built;
  - `filename*` percent-encodes everything outside RFC 8187 `attr-char`;
  - clipping is by code point;
  - the output is printable ASCII, so `validateHeaderValue` cannot throw.
  - The only defect is the length clip (N-S1).
- **`artifact:` context ref, access:** it uses the same `authorize` decision plus an equality check on `record.conversationId` and `instanceIsInConversation` (`artifact-broker.ts:340-352`). A button therefore cannot read another conversation's or another principal's file.
- **`artifact:` context ref, excerpt:** it reads a fixed 3000 bytes, decodes as a stream so a split UTF-8 sequence is dropped rather than replaced, clips to 4000 code points (`action-context.ts:140-144`), and counts toward the token budget (`widget-actions.ts:632`).
- **`artifact:` context ref, rendering:** the text goes only into the data section, with brackets and line breaks made inert (`action-context.ts:257-279`, `widget-actions.ts:630,655`).
- **Refusal messages:** they carry the broker's fixed sentences, never paths.

## Recommended order

1. N-B1: attach idempotency and instance accounting, with tests.
2. N-S1: extension-preserving clip, with a server test.
3. N-S3: ignore wrong-window messages before rate and message accounting, and invert the test.
4. N-S2: stop external picks from counting against the widget's share (or make them discardable).
5. N-S6: preserve mode, add a Windows rename retry, use a short temp name.
6. N-S4, N-S5, N-S7, then the nits.

## Unresolved questions

- Should the widget-instance route family (create, write, finalize, attach, discard, revoke) be reachable from relays and MCP at all? Today it is, and the docs say reads are intentionally open. Write-side operations by an AI client under a widget's identity were not discussed.
- Is the web #46 route-table clipping at 1280 px fixed? It was not verified in this round.

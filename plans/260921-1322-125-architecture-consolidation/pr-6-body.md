## Outcome

The internal paths this program claimed are now proved with real bytes rather than a stand-in, and the one pack that had no tests at all now has real ones.

Phase 6 of #125, the final phase. **Does not close this or any related issue.**

## (a) The preview journey is real, end to end

`BrowserDriver.capturePreview()` → `captureSessionPreview()` → blob store → authenticated `GET /previews/<digest>` → takeover card labelled with its captured-at time.

- `apps/runtime/src/session-preview.ts` gains `captureSessionPreview({ dataDir, driver, at, maxBytes })`, reusing the existing store for the size guard, the sniffed type and the content address.
- `apps/runtime/src/test-support/browser-frame.ts` (new) opens the pack's own `createDriver`, navigates through the real `act({ operation: "navigate" })` so the profile's origin rule applies, captures, and closes the browser.
- **The 29-byte fixed PNG is gone** from `test-support/fixture-model.ts`, and `capturedAt` now comes from the capture rather than from `new Date()` at card-compose time.
- `apps/runtime/test/session-preview-real.spec.ts` (new, 3 tests, real Chromium, two real pages, the node's own HTTP server): served bytes hash to the card's digest, the frame is a complete PNG (IEND) at the captured viewport, two pages are two digests and both stay addressable, and no token → 401 while an unknown or malformed digest → 404.

### Why a fixture can no longer satisfy it

The digest is `sha256:` + SHA-256 of the bytes, so it binds to content. A demonstration run through two real Chromium captures:

| | Digest | Bytes |
| --- | --- | --- |
| Page one | `sha256:114c73cd083510c0c1f22c21dcb971be6b92f70d7615194f43eedd7ea2fd0674` | 19,466 |
| Page two | `sha256:30f99e5dff58e56dda1bbce0b34e4a0849ee7d9cd599142729ba0609e9907377` | 19,155 |
| The old constant | `sha256:9c5c5b6bbd8d5d89cd6b5400ee2c0ad1e0ce12d7971b1c681ae7a63cae00a695` | 29 |

The e2e journey was also changed to assert bytes rather than element presence: it asks the node for the frame the card names, hashes the response against `data-control-preview-digest`, checks the `<img>` decoded to the size it was captured at, and checks the caption's instant falls inside the run. **The old assertion passed on a 29-byte prefix that decodes to 0×0** — which is precisely the kind of proof this phase exists to replace.

### Two real defects found by building that evidence

- The preview route sniffed its own bytes against a placeholder type, so **every frame was served as `application/octet-stream`**.
- The transport owns `cache-control` and was **silently replacing the route's `no-store` with `private, max-age=300`** — a caching bug in which the route's intent never reached the wire. Routes now ask through `binary.cache`, and the widget runtime bundle had the same silent override.

## (b) Google Calendar through the SDK seams

`packs/google-calendar` had **no test directory at all** before this change, so `vitest run packs/google-calendar` ran zero tests.

- `packs/google-calendar/src/index.ts`: `connectionFromGrant` takes a grant the SDK's authorization-code exchange produced and refuses to open a connection on a token alone (scopes must cover the read, the capability probe must have passed, via the SDK's own `connectionUsable`); `readAgendaThroughConnector` / `createEventThroughConnector` call the SDK's Calendar client and return the pack's time contract, agenda order and four write-outcome words. The token is a parameter and travels in the `authorization` header. All-day writes are refused, because the seam sends `dateTime` only.
- `packages/integration-sdk/src/index.ts` now exports the Calendar client, which had no caller. `calendar-api.ts` carries the event's own `status` and `etag`, because inventing them would put a cancelled instance on someone's agenda.
- `packs/google-calendar/test/connector.spec.ts` (new, 6 tests): a loopback token endpoint that verifies PKCE with the SDK's own `s256`, plus a Google-shaped calendar endpoint. The SDK seam is exercised, not re-implemented, and nothing claims a live Google account was reached.

## External gates

**#2, #3, #4 and #5 remain OPEN and unproven.** No gate was marked satisfied, and no issue number outside that set is pinned. `V14` stayed `partial`, and its old reason — "the node's preview path stores a fixture PNG" — became false as a result of this work, so it now names the real gap: no third-party site behind a login has ever been driven. #93 is closed, and nothing in this branch claims this work closed it or presents it as an open gate.

## Verification

`pnpm invariants` all 10 checks pass · `pnpm typecheck` clean · `pnpm lint` clean · `pnpm verify` **exit 0** — 188 files passed / 1 skipped, 2300 tests passed / 7 skipped · `pnpm test:e2e` **127 passed / 1 skipped** (4.8m), with ports 8876 and 4273 freed first.

## Scope guard

This PR **completes no external gate**. Issues #125, #2, #3, #4 and #5 stay as they were and are not proven by fixture, and this body carries no closing keyword for any of them. The four Phase 3 and three Phase 4 MINORs recorded in the plan's `evidence.md` were deliberately left untouched, because bundling them would violate this program's no-unrelated-cleanup criterion.

---
title: "#329: semantic state for media widgets"
status: in-progress
created: 2026-10-01
issues: [329, 374]
related: [195, 198, 226, 282, 283, 324]
---

# Media widget state and semantics

## Outcome

The existing image, gallery, carousel, local-video and YouTube widgets expose one bounded semantic document to text, voice, `inspect_ui` and the next turn. Gallery/carousel selection and local-video playback state persist through remount, pinning and a reload; restoring a video never autoplays. A shared playback coalescer is available for #324.

## Constraints and non-goals

- Keep old snapshots renderable and migrate newly versioned state with the declarative widget-state migration contract; no storage-schema migration.
- Semantic data comes only from validated props and bounded host-held widget state. Preserve the existing host-only media fetch path. The page CSP changes only as decided in #374 (option 2): `media-src 'self' blob:` for app-created object URLs, no remote media origin.
- Do not read YouTube playback state or add its iframe API. Do not autoplay, add media types, perform image analysis, or begin #324 audio/document work.
- Preserve keyboard, visible focus, reduced motion, both themes, and narrow-layout behavior.

## Phases

1. [State, semantic readers and playback coalescing](phase-01-media-state-and-coalescer.md) — define bounded/versioned media state, host view-operation bindings and state validation, pure semantic readers, and the shared interval/transition coalescer with tests.
2. [Renderers, host semantics and user journeys](phase-02-renderers-and-verification.md) — wire state into gallery/carousel/video; add the `media.select` composition event; build host semantic documents for all five definitions; test inspect/next turn and state after pinning and a reload; update internal bilingual docs and the English-only conformance ledger.
3. [Official docs and closeout](phase-03-docs-and-closeout.md) — after the feature PR merges, publish a bilingual official-web update, verify deployment, and close #329 with acceptance evidence.

## Acceptance

Every acceptance item in [issue #329](https://github.com/digitopvn/clarkcant/issues/329) is satisfied: old snapshots render; state versions migrate; all five semantic cases remain within `SEMANTIC_LIMITS`; video writes are coalesced and restore without autoplay; `inspect_ui` and the next turn identify the viewed item/playback state; relevant client/runtime/catalog/contract tests and E2E journeys pass; `pnpm verify`, `pnpm verify:full`, `pnpm invariants`, and required CI including Windows pass; internal and official docs are current in both languages.

## Dependencies and order

#282 and #283 are closed; #195 supplies the shared semantic reader path. Complete this issue before #324, which reuses the playback coalescer. No other issue edits the media renderers in parallel.

## Execution status

- Phase 1 and phase 2 are implemented on branch `codex/329-media-semantic-state` (rebased onto main after #375/#376), together with #374.
- #374 was decided as option 2: the web page CSP and the desktop window policy now allow `media-src 'self' blob:` and no remote media origin; the authenticated host fetch path is unchanged. A unit test covers the desktop policy and the browser journey asserts the loaded page policy.
- Browser evidence: gallery selection through `inspect_ui`; carousel selection through the next-turn note; a refused selection undrawn and explained in both; both themes at 390 px with keyboard focus; the carousel's view state after pinning and a reload; a local WebM clip played in Chromium with its writes counted against clock ticks, refused once, paused, its position read back by `inspect_ui`, and the one conversation player restored paused at that position after pinning and a reload. Pinning a catalog widget keeps a compact shelf chip, as for the tree and the timeline; there is no separate live pinned player. With the media directive removed, the same journey fails with `MEDIA_ERR_SRC_NOT_SUPPORTED` (code 4), which is the original #374 failure.
- The node cannot import video yet (`/images` accepts only pictures), so a local video plays only from a reference a host already serves; the video journey answers its one fixture reference's authenticated fetch with a committed WebM clip, and everything after the bytes is the production path.
- PR #378 review follow-up: a player flushes a settled state when it is removed or the page is left (and its current state when the page is hidden), and the semantic document reads a "playing" older than `MEDIA_PLAYING_FRESH_MS` as paused; gallery, carousel and video show refusals like the other view widgets; the semantic document names the 1-based item `selectedNumber`; the composition `echo` for `media.select` was removed. Two findings are left for a decision: a lighter state-only write path (every playback write is a full view action) and placing gallery/carousel in composed layouts.
- Phase 3 (official docs, CI including Windows, closing #329/#374) follows the feature PR merge and is not done.

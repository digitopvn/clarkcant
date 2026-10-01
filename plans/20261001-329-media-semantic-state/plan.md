---
title: "#329: semantic state for media widgets"
status: in-progress
created: 2026-10-01
issues: [329]
related: [195, 198, 226, 282, 283, 324]
---

# Media widget state and semantics

## Outcome

The existing image, gallery, carousel, local-video and YouTube widgets expose one bounded semantic document to text, voice, `inspect_ui` and the next turn. Gallery/carousel selection and local-video playback state persist through remount and pin restore; restoring a video never autoplays. A shared playback coalescer is available for #324.

## Constraints and non-goals

- Keep old snapshots renderable and migrate newly versioned state with the declarative widget-state migration contract; no storage-schema migration.
- Semantic data comes only from validated props and bounded host-held widget state. Preserve the existing host-only media fetch path and CSP.
- Do not read YouTube playback state or add its iframe API. Do not autoplay, add media types, perform image analysis, or begin #324 audio/document work.
- Preserve keyboard, visible focus, reduced motion, both themes, and narrow-layout behavior.

## Phases

1. [State, semantic readers and playback coalescing](phase-01-media-state-and-coalescer.md) — define bounded/versioned media state, host view-operation bindings and state validation, pure semantic readers, and the shared interval/transition coalescer with tests.
2. [Renderers, host semantics and user journeys](phase-02-renderers-and-verification.md) — wire state into gallery/carousel/video; add the `media.select` composition event; build host semantic documents for all five definitions; test inspect/next turn and pin restore; update internal bilingual docs and the English-only conformance ledger.
3. [Official docs and closeout](phase-03-docs-and-closeout.md) — after the feature PR merges, publish a bilingual official-web update, verify deployment, and close #329 with acceptance evidence.

## Acceptance

Every acceptance item in [issue #329](https://github.com/digitopvn/clarkcant/issues/329) is satisfied: old snapshots render; state versions migrate; all five semantic cases remain within `SEMANTIC_LIMITS`; video writes are coalesced and restore without autoplay; `inspect_ui` and the next turn identify the viewed item/playback state; relevant client/runtime/catalog/contract tests and E2E journeys pass; `pnpm verify`, `pnpm verify:full`, `pnpm invariants`, and required CI including Windows pass; internal and official docs are current in both languages.

## Dependencies and order

#282 and #283 are closed; #195 supplies the shared semantic reader path. Complete this issue before #324, which reuses the playback coalescer. No other issue edits the media renderers in parallel.

## Execution status

Gallery selection/`inspect_ui` and carousel selection/pin restore have browser evidence. `pnpm verify` and `pnpm verify:full` pass on the current branch, and the plan validator and `git diff --check` pass. The local-video pause journey is blocked by the unchanged page CSP: Chromium rejects the renderer's host-fetched `blob:` media URL. Decision and evidence are tracked in [#374](https://github.com/digitopvn/clarkcant/issues/374); do not mark this plan complete or claim the video journey passed until the constraint is resolved.

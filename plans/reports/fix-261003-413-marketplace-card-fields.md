# Fix #413: marketplace-results card fields

Branch `codex/413-marketplace-card-fields`, from origin/main 710bdca.

## Cause

`search_directory` (`apps/runtime/src/node-tools.ts`) puts `declaredReach` and `widgetAppearance` on each row. `marketplaceResultSchema` (`packages/contracts/src/surfaces.ts`) is strict and declared neither. The conductor (`packages/core/src/conductor.ts`, `modelSegmentsToBlocks`) dropped any host card that failed `messageBlockSchema`, without a word.

## Decision

The keys are declared rather than stopped. The client draws both keys (`blocks.tsx`: `PackageReach` and the fixed-look note), and #316 / #381 made "reach shown before install" part of install consent. The schemas are reused, not duplicated:

- `declaredReachSchema`;
- `widgetAppearanceClaimsSchema`, newly exported from `directory.ts` and used by both the directory entry and the card row.

The tool also fits the other values that could break the card: facets and platforms are de-duplicated, the query is cut to 200 characters, and a directory path over 300 characters keeps its end.

## Silent drop

The new optional `ConductorDeps.reportRejectedHostCard` receives a diagnostic. It carries the conversation and message ids, the card type (or `unknown`), and up to 10 issues with path, code and unrecognised key names. It never carries a value or a zod message. The runtime writes it to stderr as `host card dropped: ...`. The person still sees the model's text and no internals.

## Tests

- `apps/runtime/test/search-directory-card.spec.ts` (new): the real tool builds the card, and `messageBlockSchema` parses it.
- `packages/contracts/test/declared-reach.spec.ts`: the card row accepts the reach and appearance claims and enforces their bounds.
- `packages/core/test/core.spec.ts`: a failing card is reported without its values, and a valid card is not reported.

## Verification (Windows 11)

- The focused specs passed.
- `pnpm invariants` passed (12/12).
- `pnpm verify` passed: 5767 tests passed and 34 skipped.
- Marketplace e2e on ports 18961, 18962 and 18963: 21 passed.
- No Windows resource failures.

## Docs

- `docs/widget-development{,.vi}.md`, "Directory search".
- `docs/open-interfaces{,.vi}.md`, appearance paragraph.
- Manifest refreshed.
- Official `clarkcant-web` (`docs/api.html` and `vi/docs/api.html`, line 506) already claims the directory card shows the reach. That is now true, so no wording change is needed.

## Follow-up

Other host card producers can still be dropped when model input exceeds their card bounds: `ask_user`, `request_secret`, `run_command` and capability approval. That is now logged. A per-producer contract test would be a separate issue.

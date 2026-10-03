Addresses #413.

## Problem

`search_directory` puts `declaredReach` and, for a widget listing, `widgetAppearance` on each `marketplace-results` row, and the conversation card draws both (the reach list and the "fixed look" note). `marketplaceResultSchema` is a strict object that declared neither key. The conductor strict-parses every host card a tool returns and dropped one that failed without a word, so a real-model search for a listing with a reach or appearance claim showed the model's text and no results or Install button. The e2e fixture model writes its card straight to the transcript, so the browser suites never saw it.

## Decision: declare the keys, reusing the existing schemas

The client renders both keys, and #316 / #381 made "reach shown before install" part of informed install consent (`docs/widget-development.md`, "What install consent shows"). Dropping them from the tool would remove that consent surface, so the card contract declares them instead:

- `declaredReach: declaredReachSchema.optional()`: the same schema the directory entry and the inbox install question use.
- `widgetAppearance: widgetAppearanceClaimsSchema.optional()`: the directory entry's inline schema is now exported as `widgetAppearanceClaimsSchema` and used by both, so the card can never be stricter than the listing it repeats.

Both keep their existing bounds (64 entries each, no secret values, known appearance modes only). The row stays a strict object.

## Other ways the same card could fail

While making sure every card `search_directory` builds parses, I fitted the other values a valid listing or a model could push past the card's bounds:

- facets and platforms are de-duplicated. A directory entry allows up to 64 facets and any number of platforms, while the card allows 10 of each, and there are only 8 facet kinds and 7 platforms.
- the echoed query is cut to 200 characters. The search itself still uses the full query.
- a directory path longer than 300 characters keeps its end behind an ellipsis.

## The silent drop

A host card that fails its own contract is a node bug. It is still left out of the reply, and the person still sees the model's words and no schema internals. The conductor now reports it through a new optional `ConductorDeps.reportRejectedHostCard`. The runtime writes it to stderr as `host card dropped: it does not match its contract {json}`. The diagnostic carries:

- the conversation and message ids;
- the card `type`, or `unknown` when the type is not a plain short name;
- up to 10 issues, each with its path, its zod code, and for unrecognised keys the key names (bounded, with control characters removed);
- the total issue count.

It never carries a value or a zod message, because a message can quote a value.

## Tests

- `apps/runtime/test/search-directory-card.spec.ts` (new): the real `search_directory` tool builds a card from a listing with both `declaredReach` and `widgetAppearance`, and `messageBlockSchema` parses it. It also parses the card for every listing in `apps/web/e2e/fixtures/directory.json`, the de-duplicated facets and platforms, and an over-long query and directory path. A reach with a secret value is still refused at the directory.
- `packages/contracts/test/declared-reach.spec.ts`: a card row accepts the reach and appearance claims, and refuses a reach with a value, an unknown appearance mode, more than 64 claims, or an undeclared key.
- `packages/core/test/core.spec.ts`: a failing host card is left out and reported once, by path, code and key, without the value. An untrusted type reads as `unknown`, the issue list is bounded, and a valid card reports nothing.

## Docs

- `docs/widget-development{,.vi}.md`, "Directory search": the row repeats `declaredReach` and `widgetAppearance` under the directory schemas, and the node logs a dropped card.
- `docs/open-interfaces{,.vi}.md`, appearance: the card row repeats the appearance claims under the same schema.
- Official docs (`clarkcant-web`, `docs/api.html` and `vi/docs/api.html`, around line 506) already say the directory card shows the reach before install. This PR makes that true on the real-model path, so no change is needed there.

## Follow-up worth considering

Other host card producers (`ask_user` question and form cards, `request_secret`, `run_command`, the capability approval card) take model input that could still exceed their card bounds. Those failures are now logged instead of silent, but they are not fitted to the bounds here. A contract test per producer would be a separate change.

## Validation

All runs were on Windows 11, on this branch's tree.

- Focused: `search-directory-card.spec.ts` (5), `declared-reach.spec.ts` (10), `core.spec.ts` (52) and `directory-appearance.spec.ts` (1) all passed. The first card test covers the reported bug: on main the strict row has no `declaredReach` or `widgetAppearance`, so that card cannot parse there. I did not re-run it against main.
- `pnpm invariants`: all 12 checks passed. `docs/manifest.json` was refreshed with `--fix-manifest`.
- `pnpm verify` passed. Vitest ran 449 files (1 skipped), with 5767 tests passed and 34 skipped.
- Marketplace e2e (`marketplace-search`, `marketplace-local-install`, `resource-egress`, `install-approval`, `widget-appearance`, one worker): 21 passed. These suites use the fixture model, which writes the card straight to the transcript, so the new unit tests cover the real-model path.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

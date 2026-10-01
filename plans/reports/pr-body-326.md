Addresses #326.

Part of the Widgets v2 epic #198, following the order in `plans/260930-0200-widget-platform-expansion/plan.md`. It builds on the shared text rules from #280/#281, the view-operation pattern from #282 (`chart.view`) and #283 (`calendar.view`), and the composition graph from #226.

## What changes

`canvas.timeline@1` shows dated entries a model states, sorted by time and grouped by day.

- **One rule set, node and page.** [`packages/contracts/src/activity-timeline.ts`](packages/contracts/src/activity-timeline.ts) checks props, reads each entry's day in the timeline's timezone, checks a selection, and writes the text alternative and the semantic document. The node uses `STRICT`, which refuses hidden characters. The page uses `keepHidden`, which draws them as markers.
- **Placement** ([`view-catalog.ts`](apps/runtime/src/view-catalog.ts) `timelineView`):
  - `show_view` checks the props against the JSON Schema and then against `timelineProblems`, and throws the reasons before an instance exists.
  - When the props name no timezone, the node writes its display timezone into them, or `UTC` if it cannot name a known one.
  - Placement binds one `timeline.select` view operation.
- **Selection** ([`widget-service.ts`](packages/core/src/widget-service.ts) `timelineSelectPatch`):
  - The state is `{ selectedId? }`, and an empty id clears it.
  - An id that is not on the timeline, an extra key, or a different shape is refused with `INVALID_INPUT`, and the stored state and revision are left unchanged.
- **Semantic document** ([`widget-semantic.ts`](apps/runtime/src/widget-semantic.ts)):
  - It holds the entry count, the order, the timezone, the first and last day, `truncated`, the count for each tone, and the selected entry with its time and tone.
  - It is normalized to SEMANTIC_LIMITS.
- **Composition**:
  - `timeline` is a layout slot and leaf.
  - `timeline.select {selectedId}` is in `GRAPH_EVENTS`.
  - When the event is not wired, the selection stays on the surface (`VIEW_EVENTS`).
- **Page** (`ActivityTimeline` in [`renderers.tsx`](packages/conversation-client/src/renderers.tsx), [`timeline-layout.ts`](packages/conversation-client/src/timeline-layout.ts)):
  - Days are headings, and each entry is a button with `aria-pressed`.
  - There is one roving tab stop. Arrows, Home and End move focus, Enter and Space select, and Escape clears. Focus is visible and changes are announced in a polite live region.
  - A tone is shown as a symbol and a word as well as a colour. An all-day entry has a double edge.
  - Long descriptions fold. The list is paged, and a text list is available.
  - A refusal is said in the reader's language. Hidden characters are shown as markers.
  - Every string exists in VI and EN. The widget adds no motion of its own, and follows the light and dark themes.
- **Library**: there are fixtures for a normal timeline, oldest-first, truncated and empty. A test checks that the JSON Schema and the checks agree on all of them.

Non-goals, as the issue says: no durations, Gantt view or live feed. Props carry no HTML, URLs or callbacks, and an unknown key is refused.

## Acceptance → evidence

| Acceptance item | Evidence |
| --- | --- |
| Placement refuses, with a reason: invalid or missing times, duplicate ids, unknown tones, oversized entries or text, hidden characters | `apps/runtime/test/activity-timeline.spec.ts`: 14 refusal cases, each asserting the reason and that no instance row remains; the U+202E case names the code point. `packages/contracts/test/activity-timeline.spec.ts` covers the rules. E2E: "a timeline with a repeated id or a hidden character is refused with the host's reason, and none is drawn" |
| Day grouping is correct across timezones and DST | Contracts spec: an Asia/Saigon day boundary, an all-day entry as a date, and "follows daylight saving time: the hour that repeats and the hour that is skipped" (America/New_York). Runtime spec: the node writes the timezone at placement, with a UTC fallback. Client spec: paging by Saigon day. E2E: a New York browser over a Saigon timeline puts the 17:40Z alert on the 30th |
| The semantic document is built within SEMANTIC_LIMITS | Runtime spec: "keeps a conversation readable with the largest timeline in it" (200 entries at max text: the snapshot is readable and shortened, and the semantic doc fits the byte limit). The selection test checks the full semantic doc |
| Selection is held in bounded widget state through a checked view operation; a selection that doesn't fit is refused and the state is kept | Runtime spec: accept, reload, clear with `""`, 4 refusals keeping `{selectedId:"tests"}` and the revision, and NOT_AUTHORIZED. E2E: "a selection the node refuses is undrawn, the reason is said in the person's language, and the kept one stays" |
| `timeline.select` composition event | Runtime spec: the layout section text, graph wiring accepted, `row.select` refused, and duplicate leaf ids refused. `input-primitives.spec.ts` covers `VIEW_EVENTS` |
| Text alternative and a list fallback | Runtime spec: the exact text alternative. E2E: the `<details>` text list has 7 entries |
| Keyboard, visible focus, live region | Client spec: the focus, tab stop, toggle and source checks. E2E: End/Home/arrows stay on the page, Enter selects, Escape clears, the outline is drawn, and the live region text is checked |
| Tones never told by colour alone | E2E: a word badge for each tone. The client spec source check covers `TONE_MARK` plus `widgets.status.tone.*` |
| Reduced motion; light and dark; 390 px with 0 horizontal overflow | E2E: reduced motion (no animation or transition), 390 px with touch in light and then dark with `scrollWidth - clientWidth <= 0`, and a 1280 dark run |
| Unit tests and E2E (Library preview plus the render in conversation) | E2E [`apps/web/e2e/activity-timeline.spec.ts`](apps/web/e2e/activity-timeline.spec.ts): 7 tests, including the Library preview (the selection works there too, and the truncated and empty fixtures) and the conversation render with a reload |
| A Library fixture the node would accept, and a JSON Schema that agrees with the checks | [`timeline-schemas.spec.ts`](packages/widget-catalog/test/timeline-schemas.spec.ts) |
| Docs in EN and VI, and the ledger row | `docs/widget-development{,.vi}.md` §8.8, `docs/widgets-and-extensions{,.vi}.md` §4.1, and the `docs/conformance-traceability.md` V11 row (now 29 definitions). The manifest was refreshed |
| Web docs only to a report | The proposed `clarkcant-web` landing text is in a local report and was not applied. The follow-up is to land it there |

## Verification

- **A fix for main's typecheck, outside #326.** After #347 and #351 landed together, `main` (`2a0127b3`) no longer typechecked: `apps/runtime/src/node-tools.ts` passed `nodeId` and `newId` to `preferredAppIntentLocale`, whose first argument #351 had narrowed to `db` and `now`. The separate commit `fix(runtime): pass only what the app-intent locale reads` passes just those two. It is the only change outside the timeline. If main is fixed first, this commit drops out on rebase.
- `pnpm verify` (invariants, typecheck, lint, test) passes on the tree rebased onto `2a0127b3`: 367 files and 4878 tests passed.
- `pnpm invariants`: all 12 checks pass.
- The full Playwright suite (`verify:full`'s E2E half) ran locally on Windows on an earlier base, `86123db7`: 294 passed, 3 skipped (the suite's own conditional skips), and 0 failed, in 13.1 min. CI's e2e job on that head also passed.
- Rebases onto `97420ca8` (#345, #351) and `2a0127b3` (#347) conflicted only on an import line in the fixture model, the adjacent V12 ledger row (main's text kept) and `docs/manifest.json` (main's version taken, then `--fix-manifest`). On the `2a0127b3` tree, the timeline, calendar, status-card and appearance journeys pass locally: 43 of 43.
- **Mutation checks.** Each guard was removed in turn and the unit tests were run. Every mutation was killed, and the files were restored byte for byte:
  - The duplicate-id check → 5 tests fail.
  - The timezone validation and UTC fallback → 1 fails.
  - The selection-existence check → 2 fail.
  - The `timelineProblems` call at placement → 4 fail.
  - The hidden-character refusal in one-line text → 2 fail, including the JSON Schema agreement test.
- **Screenshots** (1280 light and dark, 390 light and dark, Library) were reviewed locally and are not committed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

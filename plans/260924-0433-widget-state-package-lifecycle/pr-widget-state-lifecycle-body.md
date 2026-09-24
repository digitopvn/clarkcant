## Outcome

Third-party widgets now have a real lifecycle on the node: their durable state is stored by the node, migrated by the host between declared versions, and it survives uninstall, restore and rollback of the package that shipped them.

## What changed

- **Durable state for frame widgets.** An isolated widget saves state through the bridge; the node stores it in `widget_state` with its own revision, separate from the instance revision, so a state write never races a props update.
- **Declarative, host-run migrations.** A widget declares `stateVersion` and pure JSON migration steps; the host runs them on open. No step, or a newer stored version than the definition understands, opens the widget read-only and says why. Conformance runs the migrations for real.
- **Uninstall / restore / rollback.** `POST /packages/:id/{uninstall,restore,rollback}`, with buttons on the installed row in Settings → Extensions & Widgets and a `manage_package` model tool for chat and voice that calls the same `changePackage`.
  - Uninstall retires the active generation and takes instances offline; state, snapshots and the generation row are kept.
  - Restore revives the same generation only when the directory still lists the same version and digest.
  - Rollback reactivates the most recently replaced other version. There is no down-migration: newer state opens read-only.
  - Execution policy applies: `deny` refuses; `ask` sends a spoken/typed request to the Settings control, whose click is the confirmation.
  - Native Pi packages report that the change takes effect after Pi restarts, rather than claiming it already has.
- **Pending capability questions in Settings.** `GET /packages/approvals` lists only questions that can still be answered (unexpired, and the digest's generation is still active). Settings → Extensions & Widgets shows each with its package and version, and answers it with exactly the digest the row showed. `manage_package` in chat and voice says what is waiting and where to answer it, but cannot approve: the model is not the person.
- **Only ready capabilities are brokered.** A frame gets requested ∩ granted ∩ `invocationPreflight`-ready. The rest come back as `unavailableCapabilities` with a reason, and the surface says so. They are brokered on the next mount once ready, with no new approval.
- **Publish enforces the versioning rules.** `clark widget publish` compares definitions with the ones it prepared last time (`dist/published-definitions.json`) and refuses, naming each problem:
  - a changed `stateSchema` without a higher `stateVersion` and migration steps from the published one;
  - a lower `stateVersion`;
  - an edited or removed published migration step;
  - changed `ephemeralStateKeys` or `effectCategories`, or an added capability, without a major definition version;
  - a removed definition without a major package version.
- **Offline widgets stay readable.** The live route returns `frame: null` with the text alternative and stored state for an offline instance, and serves the active version when the directory lists several.

## Verification

- `pnpm verify` (invariants, both typechecks, lint, 2594 unit tests): pass.
- `apps/web/e2e/package-lifecycle.spec.ts`, `capability-approvals.spec.ts`, `installed-packages`, `package-install`, `widget-frame`: pass.
- `packages/widget-cli/test/detach-real-browser.e2e.spec.ts` needs a local Chromium; it passes with one.

## Not in this PR

A remote registry, MCP Apps, deleting widget data, down-migrations, and detaching isolated frames are out of scope. A granted widget capability is still not registered as a task executor, on purpose: the grant lets the frame ask the host, and it does not run anything.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DyKs4EANtSaLrFqaugaiov

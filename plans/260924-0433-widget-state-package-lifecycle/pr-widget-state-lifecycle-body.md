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
- **Offline widgets stay readable.** The live route returns `frame: null` with the text alternative and stored state for an offline instance, and serves the active version when the directory lists several.

## Verification

- `pnpm exec vitest run apps/runtime/test packages/core/test`: all pass except `session-preview-real`, which launches a real browser and fails before this change too in an environment without a matching one.
- `apps/web/e2e/package-lifecycle.spec.ts`, `installed-packages`, `package-install`, `widget-frame`: pass.
- `pnpm invariants`, both typechecks, lint on changed files: pass.

## Not in this PR yet

Pending capability approvals UI with preflight-filtered brokering, and publish-time version rules, follow on this branch. A remote registry and MCP Apps are out of scope.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DyKs4EANtSaLrFqaugaiov

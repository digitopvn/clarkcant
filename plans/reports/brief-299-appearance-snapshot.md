# Brief: implement digitopvn/clarkcant#299 up to an open PR

Worktree: `D:/wt299` (branch `feat/299-appearance-snapshot`, from origin/main ac507906). Windows 11. Code, commits and PR text in English. Do not commit this brief.

## Context

- Read issue #299 and its parent epic #201 in full (`gh issue view 299 --repo digitopvn/clarkcant --comments`, same for 201).
- M1–M3 are merged. Build on them; do not create a parallel theme model.
  - #296 / PR #304: theme split into themeRef + colorScheme, appearance compiler.
  - #297 / PR #305: themes facet runtime, Theme Registry, restyle page in place.
  - #298 / PR #347: host-owned look beyond colour (tokenisation, recipes, effects, desktop parity).
  - Read those diffs (`gh pr diff 304 --repo digitopvn/clarkcant`, etc.).
- Widget bridge/SDK: read `docs/widget-development.md`, `docs/widgets-and-extensions.md`, `docs/open-interfaces.md`. Find the host→iframe bridge `init` message, `packages/widget-sdk`, detached widget windows and their host relay, Widget Lab and Marketplace widget detail.
- Another agent is implementing #343 (conversation delete) in another worktree. Avoid unrelated refactors.

## Scope (from the issue)

- Host→widget bridge carries the normalized public `AppearanceSnapshot` in `init`, and `appearance.changed { revision, appearance }` on change. Never raw theme package files. Version the wire change per open-interfaces rules.
- Widget SDK: `clark.appearance.current()` and `clark.appearance.subscribe(cb)` (returns unsubscribe). Core runtime is DOM-independent; an optional DOM adapter on a separate subpath maps the snapshot to `--cc-*` variables.
- Built-in catalog widgets and declarative Mini Apps adapt through semantic tokens/recipes. Composition specs stay semantic (`tone`, `emphasis`).
- Detached widget windows get the same appearance revision through their existing host relay. No separate theme query path, no credentials.
- Widget appearance modes `adaptive` (default) and `fixed`, declared in the manifest. A fixed widget is disclosed in Widget Lab / Marketplace detail and still cannot alter host chrome.
- Historical presentations resolve appearance at render time. Content, captured props/state, provenance and fallback text stay immutable. Theme changes cause no semantic-state or model-turn churn.
- An untrusted widget receives only a read-only snapshot, never host access.
- Map every acceptance criterion in the issue to a test.

## Philosophy (mandatory)

Read `AGENTS.md` and `DESIGN.md` first. Trust lanes stay distinct. No fake controls or sample data shown as live. Reduced motion wins. If something materially conflicts with the philosophy, STOP and report `NEEDS_CONTEXT` with the conflict and the best compatible alternative.

## Repo rules

- pnpm via Corepack only; start with `pnpm install --frozen-lockfile --prefer-offline`.
- No enums, namespaces, `declare global`, or constructor parameter properties. Only `packages/pi-adapter` imports the Pi SDK. New `.tsx` files must be in a typechecked config. Avoid new deps (exact-pinned if unavoidable).
- Avoid a storage migration. If one is unavoidable it is 39, but #343 also claims 39, so say so in the report.
- Internal docs are bilingual EN + VI with full diacritics. `docs/conformance-traceability.md` is English-only. Don't document target behaviour as shipped. After editing docs run `node tools/check-invariants.mjs --fix-manifest`.
- Conventional commits in English, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Use `git commit -F <absolute path to UTF-8 file>`.
- Never `--no-verify`, never `git stash`, never weaken tests. No plan IDs in code comments.
- Use absolute paths under `D:/wt299` for any file writes from shell scripts.

## Verification (before PR)

- Focused vitest first, then `pnpm verify` (exit 0) and `node tools/check-invariants.mjs`.
- Playwright E2E with env `CC_E2E_NODE_PORT=9276`, `CC_E2E_WEB_PORT=4673`, `CC_E2E_NPM_REGISTRY_PORT=9278`, then `pnpm exec playwright test <patterns>`:
  - switching theme changes host, built-in widget, declarative Mini App and isolated iframe widget, with no iframe remount (assert same frame identity);
  - the iframe gets the initial snapshot;
  - a fixed widget is labelled;
  - an untrusted widget gets only the snapshot;
  - 1280 and 390 px, light and dark, reduced motion.
- Run related existing specs (widget lab, widget artifacts, themes, detached windows) for regressions.
- Mutation checks on the key guards (snapshot in init, `appearance.changed` dispatch, fixed-mode disclosure, read-only snapshot): remove, see a test fail, restore byte-for-byte.
- Screenshots go to `D:/wt299/plans/reports/evidence/299/`. Do NOT commit evidence.

## Deliverable

- Push and open a PR to `main` with `gh pr create --repo digitopvn/clarkcant --body-file <abs file>`.
  - The body says "Addresses #299." and uses no closing keywords.
  - It includes a Requirement → evidence table for every acceptance criterion, the mutation table, verification results and the screenshot list.
  - It ends with the line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Write the proposed official-docs text for digitopvn/clarkcant-web to `D:/wt299/plans/reports/web-docs-299.md`: an English landing capability line if any, and an EN + VI widget developer guide section on `clark.appearance`, the appearance modes and the bridge messages. Do not edit that repo.
- Do not merge and do not close the issue.

End with:

```
Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
Summary: one or two sentences (PR URL and head SHA)
Concerns/Blockers: optional
```

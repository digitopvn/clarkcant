# #450 publishable widget tooling — implementation report

## Outcome

`pnpm build:widget-tooling` generates publishable `@clarkcant/widget-cli` (bin `clark`) and `@clarkcant/widget-sdk`
packages under `dist/widget-tooling/` and packs them with `pnpm pack`. `pnpm smoke:widget-tooling` installs those
archives into an empty project outside the repository and uses them. Source packages stay `private: true` and keep
resolving to TypeScript source in the monorepo.

## Verification (Windows 11, Node 24.20.0)

- `pnpm verify`: invariants 12/12, typecheck, lint, 488 test files passed (1 skipped), exit 0.
- Smoke, run three times including with `--archives`, about 36 s each, with no leftover processes:

```
widget tooling smoke on win32-x64, node v24.20.0
  installed both archives into an empty project outside the repository
  blank-widget: init, test and pack passed
  pure-widget: init, test and pack passed
  my-theme: theme init and test passed
  dev (package): served the shell, the frame and its runtime
  dev (package): stopped (terminated)
  dev (catalog canvas.line@1): served the frame and its bundled runtime
  theme dev: served the Theme Lab and its bundled runtime
  SDK: both entry points import from the project and its declarations type-check
widget tooling smoke passed
```

## Not verified here

- macOS and Linux, and the graceful exit on SIGTERM there, are covered only by the CI job and the release matrix.
- Nothing has been published: npm scope ownership and the `NPM_TOKEN` secret are still missing.
- The official docs in `digitopvn/clarkcant-web` should change once a version is on npm.

## Review follow-up

[code-review-450.md](code-review-450.md) found no critical issue. Its important and minor findings are addressed in a
second commit, except M5 (the smoke's `pnpm add` does not apply `minimumReleaseAge`), which was not in scope:

- **I1:** before publishing anything, the publish step compares each version's archive integrity with npm. A new
  version is published, identical bytes are skipped, and different contents fail the run before either package goes
  out. The tag check runs for every run from a tag. Tested locally with `npm publish` stubbed, for the new, identical
  (`zod`, `left-pad`) and conflicting (re-gzipped `left-pad`) cases.
- **I2:** only `refs/tags/widget-tooling-v*` may publish, in the `npm-release` environment, which must be restricted to
  those tags with required reviewers. Trusted publishing (OIDC, npm >= 11.5.1) comes first, and `NPM_TOKEN` is a fallback
  referenced from a config outside the repository. Other runs dry-run.
- **I3:** the CI smoke steps run only when `tools/ci-test-scope.mjs` reports a change under `WIDGET_TOOLING_PATHS`, or
  when the diff cannot be read, and the job has `timeout-minutes: 20`. A build test checks that list against the
  workspace packages the bundles really inline. Push and PR runs are not deduplicated, matching the other jobs.
- **M1:** installed dev hosts serve `runtime/*.js` from disk (612 KB / 2.3 MB, down from 3.4 / 12.7 / 13 MB), and the
  Theme Lab starts no Vite server when installed.
- **M2:** Vite and the React plugin load only when a dev host starts a module server.
- **M3:** `package-assets.ts` holds the template, runtime and skip lists, and the build imports them. The smoke runs
  `init` and `test` for every template the installed CLI lists, and `pack` for two.
- **M4:** the smoke has SIGINT/SIGTERM cleanup, keeps the original error when stopping a process also fails, and
  signals the process group on POSIX. `clark widget pack` inspects in its own `mkdtemp` directory and removes it.
- **M6:** the release smoke legs no longer install the workspace.
- **M7:** the SDK has no `engines` and gains `typesVersions` for `./dom`, which the smoke type-checks under `node10`. The
  CLI ships `THIRD_PARTY_NOTICES.md` (react, react-dom, scheduler, highlight.js, marked, xterm, zod), and
  `clark --version` prints the version.

Windows smoke after the follow-up (Node 24.20.0, about 44 s):

```
  init and test passed for every template: blank, form, dashboard, pure-ui, ai-generator, ui-with-service, media-tool, connected-app
  blank-widget: pack passed
  pure-ui-widget: pack passed
  my-theme: theme init and test passed
  dev (package): served the shell, the frame and its runtime (612138 bytes)
  dev (catalog canvas.line@1): served the frame and its bundled runtime (2308924 bytes)
  theme dev: served the Theme Lab and its bundled runtime (2356874 bytes)
  SDK: both entry points import from the project and its declarations type-check (NodeNext and node10)
widget tooling smoke passed
```

Still unverified: the SIGINT/SIGTERM handler of the smoke itself, which Windows cannot deliver from this shell, and the
workflows until they run on GitHub.

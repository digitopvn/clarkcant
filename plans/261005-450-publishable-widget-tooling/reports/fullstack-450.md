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

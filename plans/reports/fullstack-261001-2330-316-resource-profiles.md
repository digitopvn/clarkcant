# #316 Resource profiles, service egress and browser tokens: implementation report

Branch `codex/316-resource-profiles` was pushed to origin. Verification and CI ran on `ec8c7383`; this report and the
updated PR body were added in one more commit, a docs-only change. No PR was opened. The PR body is in
[pr-body-316.md](pr-body-316.md), and the plan is in
[plans/20261001-316-resource-profiles/](../20261001-316-resource-profiles/plan.md); its status is now `in-review`.

## Commits (on top of origin/main 67bf537c and 248b9a90)

| Commit | Subject |
|---|---|
| 63c050d6 | docs(plans): plan resource profiles, service egress and browser tokens |
| a377e041 | feat(contracts): define host resource profiles and the profile request |
| 11722cc4 | feat(runtime): size service containers from the granted resource profile |
| a71d9111 | feat(runtime): grant each package service its resource profile |
| 9f2456c4 | feat(runtime): report each package resource grant and frame offscreen mode |
| 2d844a69 | feat(client): show package resources and keep authorized playback running offscreen |
| 0d836ac4 | feat(mcp-adapters): answer requests a stdio server sends to the host |
| 1e204b23 | feat(contracts): declare the origins and secrets a service reaches through the host |
| 0fbcc70b | feat(runtime): broker service egress so the secret stays in the host |
| 7d5bf6ba | feat(runtime): sign a package service in only when its declared secrets are usable |
| 1d61413e | feat(contracts): declare browser tokens a widget may hold and check them against the provider |
| 1a0d4691 | feat(runtime): issue scoped browser tokens bound to one widget frame |
| ed7a5bb0 | feat(widget-sdk): offer a declared browser token to its frame and keep it there |
| 3164ef45 | feat(widget-cli): simulate a granted or refused profile and browser tokens in the dev host |
| c1eb8f0c | test(e2e): reach a fake provider through the egress broker and keep a browser token in its frame |
| babf7b94 | feat(runtime): describe the browser-token routes in the OpenAPI document |
| 107727a8 | docs: describe resource profiles, service egress and browser tokens |
| ec8c7383 | docs(plans): mark the resource profile plan in review and add its PR body |

`pnpm run typecheck` passed before every commit.

## Acceptance items

1. **A profile maps to container arguments; a refused or unavailable profile degrades with a reason; a manifest cannot
   grant itself more.**
   - `packages/contracts/src/resource-profiles.ts` defines the four profiles and `decideResourceProfile`. The decision
     order is: a GPU is never granted, light is always granted, a policy refusal wins, then the CPU check and the 0.5
     memory share. A degraded profile is never swapped for a smaller one.
   - `serviceRunArgs` takes the granted profile.
   - The manifest names a profile only, never numbers.
   - Tests: `resource-profiles.spec.ts` (11) and the profile cases in `service-container.spec.ts`, `job-host.spec.ts`
     and `package-lifecycle-route.spec.ts`. `package-resources.spec.ts` covers the readable reason in Settings.
2. **Real engine: memory and CPU limits follow the granted profile.** `service-container-engine.spec.ts` ran on
   Docker 29.8.0.
   - The kernel reports the memory, CPU, pids and `/tmp` values of `interactive-light` and `interactive-heavy`.
   - A service holding 768 MiB is OOM-killed under light (exit 137) and runs under heavy.
   - These tests are gated on `enforcesLimits`, following the existing `engine.available` skip pattern.
3. **The egress broker refuses undeclared origins, adds the credential only for the declared origin, the secret never
   reaches the container, and a missing secret shows needs-auth.** This is `clarkcant/egress.fetch` v1 over stdio
   MCP.
   - Tests: `service-egress.spec.ts` (contracts 8, runtime 12), the egress cases in `service-host.spec.ts`,
     `stdio.spec.ts` and `credential-vault.spec.ts`.
   - The real-engine test shows a real container reaching a local provider with the key while the key is in none of its
     environment, files or output.
   - Readiness reports `authenticated: false` and calls fail with `CAPABILITY_NOT_AUTHENTICATED` until the key is
     stored.
4. **A browser token goes only to the bound instance and session, expires, is refused for an unscoped provider, and
   never reaches state, logs or the prompt.**
   - Tests: `browser-token.spec.ts` (contracts 5, integration-sdk 5) and `browser-token-broker.spec.ts` (15), plus the
     token cases in widget-host `session.spec.ts` and widget-sdk `runtime.spec.ts`.
   - The value is never stored by the node. Audit records the provider and outcome only. The state, publish and action
     paths refuse the token with `TOKEN_NOT_ALLOWED`.
5. **E2E: a granted profile reaches a fake provider through the egress broker, and the frame never sees the key.**
   `apps/web/e2e/resource-egress.spec.ts` has 2 tests against a real container.
   - Package details show the profile, and `docker inspect` shows 1 GiB, 2 CPUs and network none.
   - The provider received `Bearer <key>`.
   - The key is absent from the page and frame DOM, the bridge messages, storage, the container's Env and `docker exec
     env`, and stays absent after a reload.
   - The second test checks that a minted token stays in the frame, is refused when saved to state, and is revoked when
     the frame closes.
6. **`pnpm verify`, `pnpm verify:full` and `pnpm invariants` pass, and CI is green including Windows.** All three pass
   locally; counts are below. CI is green on the second attempt; see "CI result".
7. **Docs EN/VI and ledger.** These are done:
   - `widget-development{,.vi}.md`: §14.1–14.3, the §4 "not built" line, and the dev-host paragraph;
   - `widgets-and-extensions{,.vi}.md` §9 and §12;
   - `open-interfaces{,.vi}.md`: the browser-token routes, the `tokens@1` bridge, the service-side
     `clarkcant/egress.fetch` and the person-only listing;
   - ledger rows V07 (still PASS) and V12 (still PARTIAL; its only gap remains voice, #4);
   - `docs/manifest.json` was refreshed with `--fix-manifest`;
   - the OpenAPI document gained the two browser-token paths.

## Verification

All runs were on Windows 11 with Docker 29.8.0, against tree 107727a8. The later commit only adds the PR body and plan
status.

- `pnpm verify`:
  - 12/12 invariant checks passed; typecheck and lint were clean;
  - Vitest: 398 files passed and 1 skipped; 5104 tests passed and 34 skipped.
- `pnpm verify:full` passed:
  - `test:widget-dev-host`: 42 passed;
  - `test:widget-browser`: 4 passed in 3 files;
  - `test:reference-theme-browser`: 8 passed;
  - `test:e2e`: 356 passed and 3 skipped, out of 359, in 15.1 min.
- `resource-egress.spec.ts` passed both tests in the full run. It also passed alone earlier, 2 of 2, after a
  strict-mode locator fix in the spec.
- `ak plan validate` reports the plan as valid.
- No dev servers, E2E ports (8876, 4273, 8878, 8879) or containers were left running.
- **CI result.** Run 36906217265 on `ec8c7383` is green on attempt 2. Verify passed on windows-latest, macos-latest and
  ubuntu-latest (node 24 and 22.19). The rootless-Docker service-container job, reference-theme, desktop smoke and the
  secret scan all passed.
  - Attempt 1 failed one e2e test, `calendar-views.spec.ts:422` (week view at phone width), including Playwright's
    retry: the selected-event detail never appeared after the tap. That test and this change share no code; the only
    shared component is `PinnedLiveSurface`, whose behaviour is unchanged unless a frame has authorized playback.
  - Rerun alone locally, the spec passed 9 of 9.
  - The CI failed-job rerun passed the e2e suite: 356 passed and 3 skipped, and the calendar test passed.
  - I treat it as a flake, not a regression.

## Decisions and defaults to review

- **Egress.** The host makes requests over stdio MCP, and the container keeps `--network none`. The proxied-network
  fallback was not built because it would weaken an isolation default.
- **Profile defaults.** The larger profiles are listed in the PR body as reviewable. `interactive-light` equals the
  previous envelope exactly.

## Open questions and follow-ups

- **Install screens.** They do not yet list the egress origins, secrets or browser-token providers. Consent is
  digest-bound, so these are covered but not shown.
- **Provider adapters.** None ships, so on a real node `tokens@1` answers `TOKEN_PROVIDER_UNAVAILABLE` until one is
  written.
- **Command secrets.** A secret stored only for a `command:` consumer is not usable for egress, so the package needs a
  separate secret. Should one secret serve both?
- **Podman parity gap.** Rootless Podman without cgroup delegation does not enforce memory or CPU limits. The node
  grants the profile with a note rather than refusing it. Only Docker was exercised here.
- **Offscreen toggle.** No automated test covers how the "Keep playing when scrolled away" toggle keeps the frame
  mounted. Tests cover only its label in both languages and the playback mode in package details.
- **Artifact maximum.** Every profile keeps it. Engine capacity is read once per engine per node run.
- **Official docs.** `digitopvn/clarkcant-web` goes stale on resource profiles, egress and `tokens@1`. The task forbade
  touching that repository, so neither the docs PR nor the fallback `ai-handle` issue was made. This remains for the
  controller.
- **Calendar flake.** The phone-width calendar test failed once in CI. It may deserve its own flake issue if it
  recurs.

Status: DONE_WITH_CONCERNS
Summary: Resource profiles, the service egress broker and the browser-token broker are implemented, tested on a real
Docker engine and in E2E, and documented in EN and VI. `pnpm verify` and `pnpm verify:full` pass locally, and the branch
is pushed without a PR.
Concerns/Blockers: The official clarkcant-web docs follow-up is left to the controller, because that repository was out
of bounds. No real token provider adapter ships. The Podman limit-enforcement gap is stated rather than closed. No
browser test covers the offscreen toggle. CI went green only after rerunning one unrelated calendar e2e test that
failed once.

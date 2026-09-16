# Verification — clarkcant P0–P10 bootstrap

**Date:** 2026-09-16 · **Repo:** https://github.com/digitopvn/clarkcant · **Scope chosen by operator:** scaffold all of P0–P10; contracts and tests real, remainder stubs with explicit phase mapping; full design system; real Pi SDK; external gates recorded as blocked.

## Outcome

`pnpm verify` passes end to end: **7 repository invariant checks, both TypeScript configs, ESLint clean, 184 tests across 7 packages**. The P0.1 Pi SDK lifecycle probe records **7 pass, 2 blocked, 0 fail**.

The deliverable is a foundation, not a product. Six scope items are partially implemented with
their implemented layers tested; twelve are not started. Nothing is claimed complete.

## What was verified, and how

| Gate | Command | Result |
|---|---|---|
| Repository invariants | `pnpm invariants` | 7/7 pass |
| Typecheck (node + web) | `pnpm typecheck` | pass |
| Lint | `pnpm lint` | 0 errors |
| Tests | `pnpm test` | 184 passed, 0 failed |
| P0.1 SDK lifecycle | `node packages/pi-adapter/src/probe-cli.ts` | 7 pass, 2 blocked, 0 fail |
| Docs manifest integrity | part of `pnpm invariants` | 16/16 entries match |

### Test distribution

| Package | Tests | Covers |
|---|---|---|
| `contracts` | 53 | version negotiation, task state machine totality, effect ledger, grant intersection, action compilation, install consent, peer validation, artifact acceptance, surface provenance, voice routing |
| `core` | 40 | task persistence, success gating, effect uncertainty, lease fencing, approvals, capability readiness, install lifecycle and rollback, widget ownership, routing |
| `widget-host` (+ seams) | 44 | execution profiles, credential vault and redaction, platform gating, locator staleness, OAuth/PKCE, scope verification, MCP normalization, voice media focus, capability host, Google Calendar logic, widget sandbox |
| `storage` | 18 | migrations, command idempotency, inbox dedup, conversation authority, single-writer leases, live-grant expiry/revoke, backup and restore |
| `design-tokens` | 11 | WCAG contrast maths and full palette AA audit in both themes |
| `pi-adapter` | 10 | fake-adapter lifecycle, duplicate-listener refusal, tool activation, refresh scoping, handoff, real SDK availability |
| `node-link` | 8 | inbound validation, sender mismatch, dedup replay, sequence gaps, outbox durability |

## What the documentation required, and what it got

The blueprint's own rule is that a blocked gate is recorded rather than renamed. That rule was
applied throughout:

- **Blocked, with the unblock condition named:** live model completion (needs a provider
  credential), command-context `ctx.reload()` (extension-only API), two-node J4 delegation,
  Google OAuth, Playwright engine, macOS TCC and signing, Linux virtual desktop, and one vendor
  SDK.
- **Not implemented, with the owning phase named:** everything downstream of the unbuilt
  conductor — onboarding, widget catalog renderers, the React conversation client, pins in the
  UI, quarantine download and isolated build, browser submit-timeout handling, and P10 hardening.

`docs/conformance-traceability.md` lists all 72 acceptance tests and all 18 scope items with
their status and evidence, one row each. `pnpm invariants` fails the build if any identifier is
missing from it, so the ledger cannot silently fall behind.

## Findings from the delivered documentation

1. **`docs/CHANGELOG.md` was missing.** The file is declared in `docs/manifest.json` (which pins
   its SHA-256) and linked from `docs/README.md` as required reading, but was absent from the
   document set. 15 of 16 manifest entries verified byte-for-byte; this was the only gap.
   **Action taken:** reconstructed the file from the ADR table in `research-and-decisions.md` §2
   and `scope-lock.md` §3, marked it as a reconstruction in the file itself, and updated the
   manifest entry with the real bytes and digest plus a `reconstructed` field. The original
   content was not recovered, so a reviewer should confirm the reconstruction matches intent.

2. **The blueprint's `node:vm` warning is enforceable, and it was.** Node's type-stripping
   loader refuses `enum`, `namespace` and constructor parameter properties. The invariant checker
   enforces that, and the eslint config bans the same syntax. This caught three real occurrences
   during the build that a compile-only check would have missed.

3. **pnpm 12 moved every non-auth setting out of `.npmrc`.** The hardening the blueprint asks for
   (`minimumReleaseAge`, `blockExoticSubdeps`, `verifyStoreIntegrity`, `allowBuilds`) now lives
   in `pnpm-workspace.yaml`, and `onlyBuiltDependencies` was renamed to `allowBuilds` (an object,
   not an array). The 24-hour release-age policy immediately rejected `electron@44.4.1` and
   `vitest@5.0.1` as too fresh; both were pinned to the previous qualifying version.

## Bugs the tests found in this bootstrap's own code

Recorded because each was a real defect, not a test artefact:

1. **`verifyBackup` threw on a corrupt backup** instead of reporting it — precisely the condition
   it exists to detect, and it would have aborted a restore decision.
2. **Replay handling was ordered wrongly in `receiveEnvelope`.** Semantic validation ran before
   inbox dedup, so a legitimate replay failed the monotonic-sequence check and was rejected,
   making a lost acknowledgement permanently unrecoverable under at-least-once delivery.
3. **`markEffectUnknown` nested a transaction.** The effect row and the task state would have
   been written in separate transactions, allowing the ledger and the task to disagree after a
   crash. Fixed by threading the extra write through the outer transaction, and the transaction
   guard was made real so this fails loudly in future.
4. **`rollbackGeneration` violated its own partial unique index** by reviving the previous
   generation before retiring the active one.
5. **The Pi adapter constructed the resource loader without `agentDir`**, which made `reload()`
   throw inside the SDK. Caught by the P0.1 probe, not by a user.
6. **`sdkVersion()` used CommonJS resolution** against an ESM-only package, so it silently
   reported `unknown`. Now uses `import.meta.resolve`.
7. **`assembleUtterance` required every fragment to be final**, so a completed utterance with a
   superseded partial fragment looked permanently incomplete and produced no intent.
8. **The JWT redaction pattern was too strict** to match short segments, leaving tokens in logs.

## Remaining risks and limits

- **No end-to-end journey runs.** The conductor that would drive the task state machine does not
  exist, so every passed acceptance test is a unit or integration test of a layer, not of a
  journey. J1–J6 are all unverified as journeys.
- **The Pi adapter's live path is untested.** `live-session-creation` passes without credentials,
  which is a weaker signal than it looks: a session object was constructed, but no prompt was ever
  sent and no model call completed. Treat the SDK integration as probe-verified, not
  production-verified.
- **The `as never` and one `as unknown as` cast in `real.ts`** exist because the SDK expects
  TypeBox parameter schemas while the adapter seam carries JSON Schema. Both are annotated and
  exercised by the probe, but they are the most likely place for a silent SDK-version break.
- **`apps/web`, `apps/desktop`, `apps/worker` and all three `examples/` have no source files.**
  Their `package.json` files, phase metadata and dependency declarations exist; the code does not.
  The desktop shell and the Electron dependency are not installed.
- **`pnpm build` does not build anything** because the only build target is the Vite web app,
  which has no sources.
- The dependency tree pulls the Pi SDK's transitive `@google/genai` and `protobufjs`, whose
  install scripts are blocked by policy. Nothing appears to need them at runtime, but that is an
  observation, not a verified fact.
- No soak, fuzz, or failure-injection testing was performed (P10).

## Recommended next steps

1. Build the conductor and a worker host against `FakePiAdapter` so one journey (J1 quick play)
   runs end to end. That converts many `NOT-IMPLEMENTED` rows into genuinely verified ones and is
   the highest-value single step.
2. Build the conversation client and web app, which unblocks the design system work already
   finished in `packages/design-tokens`.
3. Provide the external gates — one provider credential, a registered OAuth client, and two Linux
   hosts — and re-run the blocked acceptance tests.

# Smoke that can only run on macOS

> English (default) · [Tiếng Việt](platform-smoke.vi.md)

This document exists because three things in the project **cannot be checked on the Windows machine used for
development**, and the right way to handle that is to say so rather than silently skip them. Nothing here is recorded
as "passed".

**Missing condition: a macOS machine with a real display (and a person sitting in front of it to answer the operating
system's dialogs).** There is no macOS runner in this repo.

## Three things that cannot be checked elsewhere

1. **TCC (macOS privacy permissions).** Screen recording and microphone permissions are owned by the operating system,
   and the permission prompt only appears on macOS. On Windows, the node reports `needs-permission` — correct, but
   that is *the same state* produced by a different operating system, so it does not prove the macOS path.
2. **Window bounds on macOS.** `electron . --smoke-test` reads `getBounds()` and `getMinimumSize()` from the real
   window. Windows has its own tracking floor; macOS (NSWindow) has a different one, so the 20×50 figure in
   `COMPACT_MIN_SIZE` is only confirmed on Windows until someone runs it on macOS.
3. **Local wake-word detector.** The current shipped build **has no** detector, and the toggle in Settings is disabled
   with a reason (phase 8). If one day there is a detector using AVFoundation/on-device, it too would only run on
   macOS, so this is the place to check again — right now there is nothing to check, and that is why it is on this
   list rather than in a skipped test.

## Commands for the macOS operator

```bash
# 1. Install
corepack enable
pnpm install

# 2. Desktop shell smoke — expected: exit 0 and JSON with "failed": []
pnpm --filter @clarkcant/app-desktop run smoke

# 3. A real running node, to look at the window
node apps/runtime/src/main.ts --data-dir ./.data --label macos-smoke

# 4. The full e2e suite (needs free ports)
pnpm test:e2e

# 5. All verification gates
pnpm verify:full
```

Two steps need a human hand, because they are operating system dialogs:

```bash
# 6. Desktop session: open a screen-control session, then grant permission to ClarkCant
#    System Settings → Privacy & Security → Screen Recording → ClarkCant → on
#    Then re-run (2) and confirm the session moves from "needs-permission" to "available".
#    The card must state that the permission belongs to the operating system, and that the node cannot grant it itself.

# 7. Voice: enable the microphone for ClarkCant
#    System Settings → Privacy & Security → Microphone → ClarkCant → on
#    Then run: pnpm exec playwright test apps/web/e2e/voice.spec.ts
```

## When there are results

Record in the PR or in this section: the macOS version, the Electron version, the smoke's JSON output, and the bounds
that `getMinimumSize()` returns. If `COMPACT_MIN_SIZE` is wrong on macOS, that is a finding, and fixing it is the job
of a separate change — not adjusting the number to fit the machine.

## Why there is no skipped test

A `skip` test on this machine would make the test suite say "green" while the thing it was meant to check has never
run. The right thing is: no test exists for the three items above, and this document states the missing condition and
how to run them where they can run.

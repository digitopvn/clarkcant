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

## Windows: what a stop guarantees

This one is not a manual smoke. It runs on the Windows CI runner, and it is written down here because the guarantee
differs from macOS and Linux.

- **On macOS and Linux,** a stop signals the command's whole process group. That group includes a child the shell
  starts after the stop.
- **On Windows,** a stop runs `taskkill /T /F`, which ends the command's tree as it is at that moment. Once the shell has
  exited, the processes it left running are also found and ended. They are found by their parent pid and by a creation
  time inside the shell's lifetime. So when a `.cmd` shim (the `gh` and `pnpm` wrappers) starts its command just after
  the kill, the command is still stopped.
  - That lifetime runs from the shell's recorded start to its recorded exit, not to the stop. A process that later
    reuses the shell's pid, and anything it starts, is therefore never ended. When the exit was not recorded, nothing
    is searched for.
  - `apps/runtime/test/process-tree.spec.ts` checks this on Windows: "stopping a command a .cmd shim started, on
    Windows".
- **What Windows does not guarantee.** A process whose own parent had already exited before that search has no living
  link back to the command, and it is not found. An example is the grandchild of a shim whose child exited first. A Job
  Object would reach it, but Node cannot create one without a native addon.

## Service containers on macOS and Windows: covered by manual platform smoke

A package's service runs only inside a Linux container (`apps/runtime/src/service-container.ts`). CI checks that
boundary in real containers on Linux under three engines: rootful Docker (the `verify` job), rootless Docker
(`service container (rootless docker)`) and rootless Podman (`service container (rootless podman)`). The same suite runs
on the macOS and Windows CI runners too, but there it finds no engine and skips its real-container tests. So on those
two systems the engines are **covered by manual platform smoke**, not by CI.

**Why not in CI.** Docker Desktop and Podman machine both run Linux containers inside a Linux virtual machine. The
GitHub-hosted macOS runners run on Apple silicon without nested virtualization, so that virtual machine cannot start.
The GitHub-hosted Windows runner's Docker runs Windows containers only, and WSL 2, which both engines use on Windows,
needs nested virtualization the hosted runner does not provide. Self-hosted runners are not used for this.

**Missing condition: a macOS or Windows machine with Docker Desktop or Podman machine installed.**

Run the suite once per engine. Only one engine may answer at a time. The node tries Docker before Podman, so quit
Docker Desktop before the Podman run.

```bash
# Once: install
corepack enable
pnpm install

# Docker Desktop. On Windows, switch it to Linux containers first.
docker version --format '{{.Server.Os}}'     # expected: linux
pnpm exec vitest run --reporter=verbose apps/runtime/test/service-container-engine.spec.ts apps/runtime/test/service-container.spec.ts

# Podman machine, with Docker Desktop quit
podman machine init                          # once
podman machine start
podman info --format '{{.Host.Security.Rootless}}'   # expected: true
docker version                               # expected: fails, so the node finds Podman
CC_EXPECT_ROOTLESS_PODMAN=1 pnpm exec vitest run --reporter=verbose apps/runtime/test/service-container-engine.spec.ts apps/runtime/test/service-container.spec.ts
```

On Windows PowerShell, set the variable before the last command with `$env:CC_EXPECT_ROOTLESS_PODMAN = "1"`, and
remove it afterwards with `Remove-Item Env:CC_EXPECT_ROOTLESS_PODMAN`.

Expected: every test in "a service container on a real engine", "a service's provider key on a real engine" and "the
media render package's service on a real engine" passes, with none skipped. The two resource-limit tests run only when
the engine reports that it enforces limits. If they are skipped, record that too.

Record in the PR or in this section: the operating system and its version, the engine and its version, and the verbose
test output. A failure is a finding for its own change. Do not adjust the test to fit the machine.

## Why there is no skipped test

A `skip` test on this machine would make the test suite say "green" while the thing it was meant to check has never
run. The right thing is: no test exists for the three items above, and this document states the missing condition and
how to run them where they can run.

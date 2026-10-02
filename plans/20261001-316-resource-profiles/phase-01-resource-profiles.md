# Phase 01 — Resource profiles

## Context

- Issue: [#316](https://github.com/digitopvn/clarkcant/issues/316), scope A.
- Today's envelope is fixed in `serviceRunArgs` (`apps/runtime/src/service-container.ts`), the call ceiling in
  `CALL_TIMEOUT_MS`/`JOB_CALL_TIMEOUT_MS` (`apps/runtime/src/service-host.ts`), job concurrency in `MAX_ACTIVE_JOBS`
  (`apps/runtime/src/job-host.ts`) and the artifact ceiling in `ARTIFACT_LIMITS.maxBytes`.
- Offscreen frames already unmount (`PinnedLiveSurface` in `packages/conversation-client/src/DesktopSurfaces.tsx`).

## Requirements

- Host-defined profiles `interactive-light`, `interactive-heavy`, `media-workstation`, `background-compute`, each with
  container memory, CPU, pids and tmpfs, call and job deadlines, per-package job concurrency, artifact ceiling,
  background execution, offscreen behaviour and network (`none`).
- `interactive-light` equals today's envelope exactly and is what a manifest without a request gets.
- A versioned package-level manifest field `resources: { version: 1, profile, gpu? }`. Only named profiles; a manifest
  cannot state numbers.
- One pure decision: requested profile, engine capacity and policy in, `granted` or `degraded` with a reason out. GPU is
  always unavailable (no passthrough). Engine capacity comes from `docker info` / `podman info`.
- A degraded profile never starts the service; its capabilities read as blocked with the reason. The granted profile
  and any reason are shown in package details.
- Offscreen: light UI keeps unmounting. A profile allowing authorized playback lets the person keep the frame running
  offscreen from host chrome, with an indicator and a Stop; jobs and services keep running whether a frame is mounted.

## Files to modify/create

- `packages/contracts/src/resource-profiles.ts` (new), `install.ts`, `index.ts`, tests.
- `apps/runtime/src/service-container.ts`, `service-host.ts`, `job-host.ts`, `job-result-artifacts.ts`,
  `application/capability-invoke.ts`, `bootstrap/runtime-bootstrap.ts`, `routes/packages.ts`, `routes/conversations.ts`.
- `packages/conversation-client/src/settings/ExtensionsSettings.tsx`, `DesktopSurfaces.tsx`, `api.ts`, i18n messages.
- Tests: `packages/contracts/test/resource-profiles.spec.ts`, `apps/runtime/test/service-container.spec.ts`,
  `service-container-engine.spec.ts`, `service-host.spec.ts`, `job-host.spec.ts`.

## Steps

1. Contracts: profile table, request schema, `decideResourceProfile`, tests including "a manifest cannot grant itself a
   larger profile".
2. Engine capacity detection; `serviceRunArgs` takes the granted profile; argument tests per profile; real-engine test
   reading the applied memory and CPU limits.
3. Service host: decide per generation, refuse to start a degraded profile, use the profile's call/job deadlines,
   expose the grant. Job host: per-package concurrency under the node cap; artifact ceiling per profile.
4. Package details and the offscreen playback exception in host chrome.

## Validation

- `corepack pnpm exec vitest run packages/contracts/test/resource-profiles.spec.ts apps/runtime/test/service-container.spec.ts apps/runtime/test/service-container-engine.spec.ts apps/runtime/test/service-host.spec.ts apps/runtime/test/job-host.spec.ts`
- `corepack pnpm run typecheck`

## Risks and rollback

- Changing light's arguments would change every installed package: a test pins them byte for byte.
- An engine that cannot enforce cgroup limits (rootless on cgroup v1) runs a container without them; this is detected
  and stated in package details rather than hidden.
- Roll back by reverting the commits; nothing is persisted.

Addresses #316. Part of #200.

## Summary

- **Resource profiles.** A package names a host-defined profile (`resources: { version: 1, profile, gpu? }`), never numbers. The node owns the table and decides what it grants from policy and the container engine's capacity. The granted profile sets the container's memory, CPUs, processes and `/tmp`, the call and job deadlines, and the job host's concurrency. Every profile keeps `--network none`. A profile that cannot be granted degrades the package with a readable reason and is never swapped for a smaller one. A GPU is never granted. Settings → Extensions shows the grant or the reason. Only a `media-workstation` frame gets a host-chrome "Keep playing when scrolled away" toggle, which is off for each new mount.
- **Service egress broker.** A `tools` facet declares the `egress` secrets and origins it needs. The service never holds the key: the node makes each request itself and adds the credential header from the secret the person stored for `package:<id>`. Until that key is stored, the package's capabilities read as not signed in (`authenticated: false`, `CAPABILITY_NOT_AUTHENTICATED`).
- **Browser token broker (`tokens@1`).** A UI facet declares `browserTokens`. Host chrome asks for a token on behalf of one mount of the frame, and the route is person-only on every machine relay. The node issues a token only for a declared provider and scope, and only when the provider's adapter mints a scoped token for them within 30–3600 s. A request is refused, never narrowed. The node keeps only the provider's token id and withdraws the session's tokens when the frame goes. The SDK and the host session refuse any state write, semantic publish or action that carries the token.
- **Dev host.** `clark widget dev` can simulate a granted or refused profile, and a token provider that issues or is unavailable.
- **E2E fixture.** A lookup package with a fake provider on a loopback origin.
- **Docs.** EN and VI docs, OpenAPI entries and ledger rows V07 and V12.

## Egress design decision

The host makes the outbound request on the service's behalf over the existing stdio MCP channel. It does this as a versioned server-to-client request, `clarkcant/egress.fetch` (`version: 1`), advertised in `initialize` as `capabilities.experimental["clarkcant/egress"]`. The container keeps `--network none`. The broker applies these rules:

- It allows only declared origins, matched exactly, and refuses URLs with credentials in them.
- It allows requests only while a host call to that service is in flight.
- It drops any header the service sets with the credential's name.
- It strips cookie, proxy, forwarding and framing headers.
- It limits each request to 1 MiB sent, 2 MiB returned and 30 s.
- It follows no redirects.
- It removes the secret from the headers and body that come back.
- It audits each request as `egress` by secret name only, never by value or length.

Refusals are JSON-RPC errors `-32010` to `-32015`.

The proxy-only network fallback is **not built**. No fixture or planned package needs raw sockets. Giving a container a network would weaken an isolation default, so that needs a person's decision first.

## Profile defaults (reviewable)

`interactive-light` matches today's envelope exactly: 256 MiB, 1 CPU, 128 pids, a 16 MiB noexec `/tmp`, 60 s per call, 30 min per job and 4 jobs at once. Existing packages are unchanged.

The three larger profiles are engineering defaults, set in `packages/contracts/src/resource-profiles.ts`, and are open for review:

| Profile | Memory | CPUs | pids | `/tmp` | Per call | Per job | Jobs at once | Offscreen |
|---|---|---|---|---|---|---|---|---|
| `interactive-heavy` | 1024 MiB | 2 | 256 | 64 MiB | 120 s | 30 min | 2 | suspend |
| `media-workstation` | 4096 MiB | 4 | 512 | 512 MiB | 300 s | 2 h | 1 | authorized playback |
| `background-compute` | 2048 MiB | 2 | 256 | 256 MiB | 60 s | 4 h | 2 | suspend |

Two other values are also open for review:

- **Grant rule.** A non-light profile is refused when it needs more CPUs than the engine reports, or more than half of the engine's memory.
- **Artifact ceiling.** Every profile keeps the current artifact maximum, because a returned file must stay attachable to a conversation.

## Cross-platform

- **Podman gap.** Rootless Podman without delegated cgroup v2 controllers accepts `--memory` and `--cpus` but does not enforce them. The node still grants the profile there, with the note "the container engine does not enforce memory and CPU limits here", and package details show that note. The real-engine kernel checks run only where the engine enforces limits.
- **Docker Desktop.** Capacity is that of its Linux VM.
- **Verified engine.** The real-engine tests ran on Docker 29.8.0 on Windows 11.

## Validation

All runs were on Windows 11 with Docker 29.8.0, against commit 107727a8 (the docs commit). That tree differs from the pushed head only by this file and the plan status.

- `pnpm verify` (invariants, typecheck, lint, test) passed:
  - all 12 invariant checks passed;
  - Vitest: 398 test files passed and 1 skipped; 5104 tests passed and 34 skipped.
- The real-engine container tests in `apps/runtime/test/service-container-engine.spec.ts` passed. They show:
  - the memory, CPU, pids and `/tmp` limits of `interactive-light` and `interactive-heavy`, read back from the kernel;
  - a service holding 768 MiB is killed under light (exit 137) and runs under heavy;
  - the provider key reaches the provider but is absent from the container's environment, files and output.
- `pnpm verify:full` passed:
  - `test:widget-dev-host`: 42 passed;
  - `test:widget-browser`: 4 passed in 3 files;
  - `test:reference-theme-browser`: 8 passed;
  - `test:e2e`: 356 passed and 3 skipped, out of 359, in 15.1 min.
- `apps/web/e2e/resource-egress.spec.ts` passed both of its tests inside that run.

## Not in this PR

- **Provider adapters.** No real provider adapter ships. A node without one answers `503 TOKEN_PROVIDER_UNAVAILABLE`, and the browser suite uses in-process fixture providers (`CC_BROWSER_TOKEN_FIXTURE=1`).
- **Install screens.** Install consent is bound to the package digest, so it already covers the declared egress origins, secrets and browser-token providers. The install screens do not list them yet.
- **Command secrets.** A secret stored only for a `command:` consumer is not usable for egress; the package needs its own.
- **Offscreen toggle.** No automated test covers how the toggle keeps the frame mounted. Tests do cover its label in both languages and the playback mode that package details show.
- **Proxied network.** Not built for services that need raw sockets, and no GPU passthrough.
- **Official docs.** The docs site `digitopvn/clarkcant-web` needs a follow-up after merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

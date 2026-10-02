Addresses #316. Part of #200.

## Summary

- **Resource profiles.** A package names a host-defined profile (`resources: { version: 1, profile, gpu? }`), never numbers. The node owns the table and decides what it grants from policy and the container engine's capacity. The granted profile sets the container's memory, CPUs, processes and `/tmp`, the call and job deadlines, and the job host's concurrency. Every profile keeps `--network none`. A profile that cannot be granted degrades the package with a readable reason and is never swapped for a smaller one. A GPU is never granted. Settings → Extensions shows the grant or the reason. Only a `media-workstation` frame gets a host-chrome "Keep playing when scrolled away" toggle, which is off for each new mount. A unit test of the decision and a browser journey (`offscreen-playback.spec.ts`) show that a frame with the toggle on keeps running out of view until Stop, and that a light frame is offered no toggle and is unmounted.
- **Service egress broker.** A `tools` facet declares the `egress` secrets and origins it needs. The service never holds the key: the node makes each request itself and adds the credential header from the secret the person stored for `package:<id>`. Until that key is stored, the package's capabilities read as not signed in (`authenticated: false`, `CAPABILITY_NOT_AUTHENTICATED`). This is how the issue's `needs_auth` is expressed: readiness carries `authenticated: false` with a `blockedReason`, and a call is refused with `CAPABILITY_NOT_AUTHENTICATED`. The widget lifecycle state `needs_auth` is not set.
- **Informed install consent.** A directory entry states the package's reach in `declaredReach` (`{ origins, secrets, browserTokens }`). The directory card in the conversation, the inbox install question and package details list each origin with its purpose, each key by name with its purpose (never a value), and each browser-token provider with its scopes, before anything is granted. An artifact whose manifest declares a different reach than its listing shows is refused with `409 DECLARED_REACH_MISMATCH` before anything is recorded.
- **Browser token broker (`tokens@1`).** A UI facet declares `browserTokens`. Host chrome asks for a token on behalf of one mount of the frame, and the route is person-only on every machine relay. The node issues a token only for a declared provider and scope, and only when the provider's adapter mints a scoped token for them within 30–3600 s. A request is refused, never narrowed. The node keeps only the provider's token id and withdraws the session's tokens when the frame goes, and on uninstall, rollback or an update to new code. A token minted while that happens is withdrawn, not handed out. The SDK and the host session refuse any state write, semantic publish, action, artifact write or external link that carries the token as issued. That guard is best effort: it does not stop a widget that encodes or splits the token.
- **Dev host.** `clark widget dev` can simulate a granted or refused profile, and a token provider that issues or is unavailable.
- **E2E fixture.** A lookup package with a fake provider on a loopback origin.
- **Docs.** EN and VI docs, OpenAPI entries and ledger rows V07 and V12.

## Egress design decision

The host makes the outbound request on the service's behalf over the existing stdio MCP channel. It does this as a versioned server-to-client request, `clarkcant/egress.fetch` (`version: 1`), advertised in `initialize` as `capabilities.experimental["clarkcant/egress"]`. The container keeps `--network none`. The broker applies these rules:

- It allows only declared origins, matched exactly, and refuses URLs with credentials in them.
- It refuses loopback, private and link-local origins, even declared ones, unless the node was started with `CC_EGRESS_ALLOW_PRIVATE_NETWORK=1`. That is a node setting, off by default, and no manifest field turns it on. The e2e harness turns it on for its loopback fake provider.
- It allows requests only while a host call to that service is in flight.
- It allows only `GET` and `HEAD` unless a call in flight was decided as `external-write`, `destructive`, `financial` or `communication`. A request cannot name the call it serves, so the effects of all calls in flight together bound it. `local-write` does not allow a write, because the policy's risk gate does not ask about it.
- It rate-limits each running service to a burst of 30 requests, refilled at 10 a second.
- It drops any header the service sets with the credential's name, and sets `accept-encoding: identity` itself.
- It strips cookie, proxy, forwarding and framing headers.
- It limits each request to 1 MiB sent, 2 MiB returned and 30 s.
- It follows no redirects.
- It replaces the secret with `[redacted]` in the headers and body that come back, as sent, JSON-escaped, URL-encoded and base64 or base64url encoded. This is a best-effort guard against a provider that echoes the key, not a guarantee.
- It audits each request as `egress` by secret name only, never by value or length. A refusal of a kind already written in the last 60 s is gathered and written as one row with its count, so a service cannot flood the audit.

Refusals are JSON-RPC errors `-32010` to `-32018`.

## Security review follow-up

Each finding of the review was checked in the code first, and each fix has a regression test that fails without it.

- **H1 (writes during a read call).** The decided effect now reaches the service host, and egress enforces the method rule above. Tests: `service-egress.spec.ts` ("what a call lets egress do") and `service-host.spec.ts`, where a POST during a call decided as `read` is refused and the same request during an `external-write` call is made. The e2e fixture's capability is `read` and only sends GET, so it is unchanged.
- **H2 (audit flood).** Per-service token bucket and coalesced refusal audits, flushed when the service stops. Test: 10 000 refused requests leave two rows, the second with `count: 9999`.
- **M1 (echo redaction).** The host sets `accept-encoding: identity`, and redaction covers the encoded forms. Test: a provider that echoes the key JSON-escaped with `\/`, URL-encoded and inside base64 and base64url. The docs call this a best-effort guard.
- **M2 (token guard).** The guard now also covers artifact writes (name and decoded content) and open-external, in the SDK and the host session. The docs no longer say the value stays in the frame.
- **M3 (loopback and private origins).** Refused by default with `-32018`, allowed only by `CC_EGRESS_ALLOW_PRIVATE_NETWORK=1`. Documented in EN and VI.
- **L1.** A per-package epoch is checked after the provider mints, so a token minted while its package was removed is withdrawn.
- **L2.** Held tokens are keyed by provider and token id, so two providers that both answer `tok_1` are revoked separately.
- **L3.** An install that activates new code ends the tokens given under the old code.
- **L4.** A failed or empty engine capacity read is asked again at the next start instead of being kept.
- **L5.** The `needs_auth` mapping is stated above, in the docs and in the ledger.
- **L6.** `GET /packages` reads the directory index once and passes it to each manifest read.

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

All runs were on Windows 11 with Docker 29.8.0, against commit 75a892dd. That tree differs from the pushed head only by this file.

- Focused tests, all passing:
  - `service-egress.spec.ts` (22), `service-host.spec.ts` (39), `browser-token-broker.spec.ts` (16), `install-approval.spec.ts` (16), `package-resources.spec.ts` (2), and the widget-host `session.spec.ts` and widget-sdk `runtime.spec.ts` token-guard cases;
  - `package-reach.spec.ts` (5) and `offscreen-playback.spec.ts` (5) in conversation-client.
  - Each security fix's regression test was also run with the fix reverted, and failed.
- `pnpm verify` (invariants, typecheck, lint, test) passed: all 12 invariant checks; Vitest 402 test files passed and 1 skipped, 5146 tests passed and 34 skipped.
- `pnpm verify:full` failed twice at its Vitest stage, on one test this branch does not touch:
  - `apps/runtime/test/worktree-sweep.spec.ts`, "tidies each repository's worktree of a finished task…", timed out at 20 s under the full parallel load. Windows then raised EPERM while removing its temp folder.
  - Rerun alone, that spec passed 6 of 6. It also passed inside the `pnpm verify` run above on the same tree.
  - Because `verify:full` stops at its first failed stage, its remaining stages were then run directly, in order:
    - `test:widget-dev-host`: 42 passed;
    - `test:widget-browser`: 4 passed in 3 files;
    - `test:reference-theme-browser`: 8 passed;
    - `test:e2e`: 359 passed and 3 skipped, in 16.4 min.
  - In that e2e run, `resource-egress.spec.ts` passed its 3 tests, including the new reach-before-install journey, and `offscreen-playback.spec.ts` passed its 2.
- The earlier real-engine container tests in `apps/runtime/test/service-container-engine.spec.ts` still pass. They show:
  - the memory, CPU, pids and `/tmp` limits of `interactive-light` and `interactive-heavy`, read back from the kernel;
  - a service holding 768 MiB is killed under light (exit 137) and runs under heavy;
  - the provider key reaches the provider but is absent from the container's environment, files and output.

## Not in this PR

- **Provider adapters.** No real provider adapter ships. A node without one answers `503 TOKEN_PROVIDER_UNAVAILABLE`, and the browser suite uses in-process fixture providers (`CC_BROWSER_TOKEN_FIXTURE=1`).
- **Update notice.** The update notice does not list the reach. An update is still refused when the new artifact declares a different reach than its listing.
- **Command secrets.** A secret stored only for a `command:` consumer is not usable for egress; the package needs its own.
- **Proxied network.** Not built for services that need raw sockets, and no GPU passthrough.
- **Official docs.** The docs site `digitopvn/clarkcant-web` needs a follow-up after merge.

## Residual risk

- **DNS.** The private-origin check reads the URL's host. It does not check what a public name resolves to, so a declared public name that resolves to a private address is reached.
- **Best-effort guards.** Echo redaction and the token guard catch the common forms. A provider or widget that splits, hashes, encrypts or otherwise re-encodes a value is not caught.

## Open questions

- **Shared key.** A secret stored for a `command:` consumer is not used for egress, so the person stores the same key again for `package:<id>`. Should one stored key be shareable between a command and a package, and with what consent?
- **Profile on "ask".** When the policy answers "ask", installing grants every profile the package requests, including `media-workstation` (4 GiB, 4 CPUs, 2 h jobs), on install consent alone. Only "deny" refuses. Is that the intended Jev decision? It is left as is.
- **Per-request egress policy.** Egress requests do not go through `decideExecution` themselves. With H1 fixed, the per-call decision bounds what egress can do: a call the policy decided as a read can only read, and a write needs a call the risk gate asked about. That seems enough for now. A per-origin rule the person can set would be a separate feature.
- **Reach on update.** Should the update notice list a new version's reach, especially when it differs from the installed version's?
- **Approving local listings from the inbox.** The inbox approval path does not pass `localDigest` for a local-path listing, so approving one fails with "a local package must be hashed before it can be planned". This predates this PR. The e2e journey therefore denies the question after checking the reach, and installs through the API.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

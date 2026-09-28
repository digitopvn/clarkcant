# Kongming counsel: #198 service-facet runtime and manifest unification

Date: 2026-09-29 (Asia/Saigon). Advisory only. Runtime: Claude Fable 5.1.

## TL;DR

Make a `tools` facet with `isolation: "service"` an MCP stdio server started by the host, declared up front in the manifest (`provides[]`), verified against `tools/list` at activation, registered in the capability registry under `svc.<slug>.<tool>@<major>`, and invoked only through one application-layer `invokeCapability` that widgets (via ActionBinding), the model's tools and voice all call. Containment on Node 22/24 is honestly "process + Node permission seat belt, network not confined"; gate it on the existing service-lane consent (`destructive` category → execute or host-owned approval), show that sentence at consent, and defer containers. Unify manifests as `schemaVersion: 2` in `@clarkcant/contracts`, normalising v1 on read (never on disk, because artifacts are digest-bound).

## Reframed problem

The decision is not "which process protocol" but "what is the one host path from a consented package to an invocable, readiness-tracked capability that UI, agent and voice share, and how honest is the containment claim behind it". Requirements from #198 and AGENTS.md: UI never reaches a sibling service directly; credentials brokered by Clark; failure leaves UI readable; Jev/policy is the only escalation layer; existing standards over bespoke protocols; parity across macOS/Windows/Linux. Non-goals for this slice: container/VM adapters, remote-node routing, external-connector credential broker, `agent`/`workflow` executors.

## 1. Protocol, namespace, declaration

**Yes: a service facet IS an MCP stdio server.** Reuse `StdioMcpTransport` (`packages/mcp-adapters/src/stdio.ts`) and `normalizeMcpTool` (`packages/mcp-adapters/src/index.ts:54`). stdio is the right transport precisely because there is no listening socket: nothing for a widget's `connect-src` to reach, which enforces "UI never calls a sibling localhost service" structurally instead of by policy. Do not add a bespoke JSON-RPC dialect.

**Namespace: `svc.<slug>.<tool>@<major>`, not `mcp.*` and not raw `<packageId>`.** Verified constraints: `capabilityRefSchema` (`packages/contracts/src/grants.ts:54`) forbids hyphens in the first segment, a local install records its *path* as `packageId` (`apps/runtime/src/application/package-lifecycle.ts:75`), and `sanitize()` slices to 60 chars (`index.ts:81-87`), so two packages can collide. The registry upsert on `(capability_ref, execution_node_id)` (`packages/core/src/capability-registry.ts:44`) would silently overwrite the loser. Therefore: `slug` is a manifest-declared `[a-z][a-z0-9-]*` field (widget-cli validates it), and activation refuses to register a ref already `providedBy` a different `packageId`. Keep `mcp.*` for operator-configured external MCP servers (a different trust story, later).

**Declare inline, verify at activation.** Add to the facet: `protocol: "mcp-stdio"`, `slug`, `provides: [{ tool, major, summary, effectCategory, inputSchema?, requiresConnection }]`. Consent shows `provides` before any code runs; `deriveGrantedCapabilities` (`packages/core/src/install-consent.ts:59`) already decides per ref. At activation: handshake → `tools/list` → for each declared tool: missing → register `loaded:false, blockedReason:"the server does not offer <tool>"`; undeclared extra tools are never registered; effect category = the stronger of declared vs `normalizeMcpTool` (annotations only raise caution, `index.ts:58-66`); record `toolSetDigest` on the generation so a schema change after consent flips `healthy:false` until re-consent.

## 2. Containment, gating, network honesty

**Per-OS containment with only Node available (identical on all three):** spawn `process.execPath --permission --allow-fs-read=<pkgRoot> --allow-fs-read=<dataDir/services/<pkg>> --allow-fs-write=<dataDir/services/<pkg>> <entry>` with no `--allow-child-process`, `--allow-worker`, `--allow-addons`; env from a new `service` profile allowlist (`PATH`, `LANG`, `TZ` only). Verified against Node docs: `--permission` stable since 22.13; `--allow-net` was **added in v25.0.0 (stability 1.1)** and is absent from the 22.x and 24.x CLI docs; Node calls the model a "seat belt" that "does not provide security guarantees in the presence of malicious code"; symlinks are followed (quarantine already refuses symlink entries — keep that). Windows note: `--permission` works there, but `stopTree` (`apps/runtime/src/process-tree.ts:40-52`) is what actually ends the tree; the transport's `child.kill()` (`stdio.ts:174-184`) is not enough on Windows.

**Gating rule (honest):** a service facet starts only when (a) the consented plan's `isolationPlan` marks it `service` (this is what `listInstalledPackages` derives the lane from, `packages/core/src/installed-packages.ts:82-98`), (b) the policy executed or the person approved the `destructive`-category grant the service lane already maps to (`install-consent.ts:24-31`, `package-install.ts:460-477`), and (c) the consent card carried the containment sentence: "runs code on this node as a separate process; files limited to its package and a private folder; cannot start other programs; **network is not restricted on this Node version**; declared origins: …". Do not route through `runUnderProfile` — it is run-to-completion with `timeoutMs` and refuses untrusted code by design (`packages/execution-supervisor/src/index.ts:130-136`). Add a `startService` in the same package with `containment: "process-only"`, `acceptsUntrustedCode: false`, and a required `consent: { planDigest, approvedContainment }` argument, so the refusal stays and consent is the only key. When Node ≥ 25 is detected, add `--allow-net=<declared origins>` and upgrade the sentence.

**Philosophy check — surface this fork to the user.** `docs/system-architecture.md:83` states "untrusted tool services run in a suitable container/VM". Shipping process-only service facets is a documented-architecture change, not a hidden exception. Recommended default: amend that line to "container/VM when an engine is present (`apps/runtime/src/container-engine.ts` already probes); otherwise process + Node permission model, always named at consent, never silently" — this keeps "open by default" and "autonomy never overrides hard boundaries" because consent is explicit and bound to the plan digest. Alternative (stricter): refuse service facets without an engine; cost is that Windows/macOS users without Docker get no service facets at all. Evidence that flips the default: a marketplace policy decision to admit only curated service packages.

## 3. Lifecycle

- **Start on activation and on boot for active generations**, not lazily: readiness must be observed, not guessed (`pack-load.ts` already follows this rule). Idle-stop is a later optimisation.
- **Restart:** bounded backoff 1s→60s, max 5 crashes per 10 min, then `loaded:false, healthy:false, blockedReason:"crashed N times; restart from Settings → Extensions"`. A crash immediately calls `updateReadiness` (monotonic on failure, `capability-registry.ts:147-172`) and rejects in-flight calls (transport already does).
- **Readiness mapping:** `installed` = active generation; `loaded` = handshake + `tools/list` matched; `authenticated` = `requiresConnection ? connection exists : true`; `authorized` = ref ∈ `generation.grantedCapabilities`; `healthy` = MCP `ping` within TTL (30s) and process alive.
- **Degraded UX:** nothing new to build — `readyCapabilities` (`packages/core/src/widget-frame.ts:84-96`) already withholds non-ready refs with a reason, and bound CTAs already render disabled-with-reason. The widget stays readable; only its `invoke` bindings degrade.
- **Shutdown/ownership:** spawn like `worker-process.ts:119-125` (`detached` off Windows, `windowsHide`), stop via `stopTree`, add `serviceHost.closeAll()` to `killChildrenNow` and before `performEmergencyStop` in `main.ts:448-493`. Persist `pid, startTime, bootId` per service; the boot sweep kills only when `isSameProcess` proves identity (Linux), otherwise relies on the MCP rule that a stdio server exits on stdin EOF — document that requirement for authors. Uninstall/supersede: stop the old generation's process before activating the new one (drain state exists: `install.ts:487-489`).

## 4. Invocation path (one host path)

Build `apps/runtime/src/application/capability-invoke.ts` `invokeCapability(services, { ref, args, principalId, source, operationDigest, explicitUserIntent })`: `invocationPreflight` → `decideExecution` on the stronger of descriptor and binding `effectCategory` → `deny` refuses; `ask` → `requestApproval` and return `APPROVAL_REQUIRED` with `approvalId` (the widget route maps it to 202, exactly as `package-install.ts:371-380`) → `recordEffectExecution` → `serviceHost.call(ref, args)` → audit. Three callers, no second implementation:

1. **Widget:** `invokeMiniAppAction` (`packages/core/src/widget-service.ts:1180-1214`) already runs `decideExecution` for non-view kinds and returns `UNSUPPORTED_ACTION`. Split it: keep the sync core (owner, binding, idempotency, revision/digest, `INVOCATION_KEY_REUSED`) as `prepareInvokeAction` + `recordInvokeOutcome`; `invokeWidgetAction` (`apps/runtime/src/application/widget-actions.ts:68`) becomes async and calls `invokeCapability` for `invoke` bindings. Voice already enters here (`voice-bootstrap.ts:380`).
2. **Main agent:** register each usable `svc.*` capability as a model tool from `listCapabilitySummaries(usableOnly)` (the list `conductor.ts:555` already reads) in `node-tools.ts`; its `execute` calls `invokeCapability` with `source: channel()`. That closes the "tool-call loop at the agent layer" gap named in `docs/conformance-traceability.md:130`.
3. **Voice:** free via 1 and 2 (`channel: "voice"`).

**Refuse:** `agent`/`workflow` (unchanged); `fixedConstraints.nodeId` ≠ this node (`CAPABILITY_NOT_LOCAL`, remote routing deferred); binding `packageGeneration` ≠ active generation (`bindingStillValid` already); args failing the descriptor `inputSchema` (verify `z.fromJSONSchema` exists in the pinned zod 4.6.5 before relying on it); any `capability.request` from a frame turning into a call — `packages/widget-host/src/session.ts:329-338` must stay an acknowledgement, and `action.invoke` stays keyed by accepted binding id (`session.ts:289-291`); connection secrets in args or results.

## 5. Manifest unification

**Canonical: `schemaVersion: 2` = `packageManifestSchema` in contracts, extended, with facets as a discriminated union on `kind`.** Add `displayName`, `description` (v1 has them; contracts lacks them); `widget` facet keeps `id/entry/definition/isolation:"isolated-ui"`; `tools` facet adds `protocol/slug/provides`; keep `facets` as an array (both code schemas agree; `docs/widgets-and-extensions.md:308-322` shows an object and `"hostApi": ">=1 <2"` — fix the doc, do not add a range parser). Keep `hostApi` as the object; keep `HOST_API_VERSION = 1` unless the frame bridge changes — manifest evolution is `schemaVersion`'s job.

**Normalise on read, never on disk.** Consent, generations and the files route are bound to the artifact digest (`consentStillValid`, `install.ts:427-454`); rewriting `clarkcant.json` would change bytes under a consented digest. So `readPackage` (`packages/core/src/widget-package.ts:98`) parses `{1: manifestSchema, 2: packageManifestV2}` and returns v2 via a pure `upgradeManifestV1` in contracts, with a test on the conversion. Consumers that want widgets filter `facets.filter(f => f.kind === "widget")` (`installed-widgets.ts:57`, `widget-frame.ts:119`, `package-install.ts:447,934`, `routes/packages.ts:395`, `widget-serving.ts:68`, widget-cli). Yes, `packageManifestSchema` becomes canonical; it has only test consumers and `validateManifest` (`packages/capability-host/src/index.ts:60`), so widening it is cheap. Map v1 `filesystem: string[]` → `{path, access:"read"}`; v1 `publisher` (no signature) fits v2's optional shape.

## What to avoid

- An HTTP/loopback service facet: it creates exactly the sibling-localhost hole `networkOriginSchema` permits for `http://localhost` (`install.ts:78`).
- Lazy start "to save resources": readiness becomes a claim, which AGENTS.md forbids.
- Calling process-only "sandboxed" anywhere in UI or docs; the supervisor's own refusal text is the standard.
- Widening `runUnderProfile` to accept untrusted code.
- Registering discovered tools that the manifest did not declare.
- A second approval surface: reuse `requestApproval` + host-owned cards.
- Bumping `HOST_API_VERSION` for a manifest schema change.

## Alternatives and trade-offs

- **Worker-thread or `node:vm` isolation instead of a process:** cheaper, but Node's model does not inherit to workers and `vm` is not a boundary; also loses crash isolation. Rejected.
- **Discovered-only capabilities (no `provides`):** simpler manifests, but consent would show nothing before code runs, violating the issue's own requirement.
- **Require a container engine for every service facet:** strongest honesty, but excludes most Windows/macOS users; keep as the stricter fork for the user to choose.

## Work checklist (PR order, one sub-issue each)

1. **Manifest v2 + normalise-on-read** (contracts, core `readPackage`, widget-cli, docs §4/§11 EN+VI). Tests: v1 package still installs, serves and renders; v2 with a `tools` facet validates.
2. **Transport hardening** (`stdio.ts`): env is a full replacement (no `process.env` merge, `stdio.ts:86`), spawn options (`detached`, `windowsHide`, `argv` for `--permission`), stop via injected `stopTree`, `ping` support. No production caller today, so the contract change is free.
3. **Service host** (`execution-supervisor` `startService` + `apps/runtime/src/service-host.ts`): consent-keyed start, backoff, readiness updates, boot start, shutdown hooks, pid persistence.
4. **Activation wiring**: `provides` verification, registry registration with `providedBy`, collision refusal, tool-set digest on the generation, consent sentence in the plan card.
5. **`invokeCapability` + widget `invoke` + agent tool**: E2E proving click, `invoke_capability` tool call and a spoken command hit one path with one audit row each; degraded widget when the service is killed.
6. **Docs/ledger**: `system-architecture.md:83` amendment (after the user's fork decision), `conformance-traceability.md` V07/V08 rows, `widgets-and-extensions.md` §4.1 and §11, and `clarkcant-web`.

**Explicitly deferred, with wording:** "Credential brokering for service facets (`connection.withSecret`) is not built; a `tools` facet that declares `requiresConnection` registers as `authenticated: false` and is not invocable." "Container and VM adapters are not built; when a container engine is detected the node still runs service facets as processes and says so at consent." "Remote-node invocation of a service capability is refused (`CAPABILITY_NOT_LOCAL`)."

## Success metrics

- One consented example package (a small MCP stdio server) shows its tools at consent, reaches `usable` in the registry within 5s of activation, and is invoked from a widget, from the model and by voice with identical audit rows.
- Killing the service process flips readiness within one probe TTL; the widget remains readable with disabled-with-reason CTAs; a restart recovers without re-consent.
- Node shutdown on Windows and Linux leaves no orphan (`tasklist`/`ps` check in the platform smoke).
- Every v1 package in the repo's fixtures and E2E passes unchanged.

## Assumptions

- Zod 4.6.5 exposes `z.fromJSONSchema` (medium). If not, enforce `type/required/additionalProperties` structurally rather than adding a validator dependency.
- MCP stdio servers written for this facet will be Node scripts run by ClarkCant's own Node (high); non-Node entries get no permission model and must be refused for the service lane.
- The user prefers process-only-with-consent over "no service facets without Docker" (medium); stated as a fork above.
- Idle-stop and remote routing are acceptable follow-ups (high).

Status: DONE_WITH_CONCERNS
Summary: Service facets should be host-started MCP stdio servers declared in a v2 manifest, gated by the existing service-lane consent with an honest containment sentence, and reached only through one `invokeCapability` path; the one concern is a documented-architecture fork (process-only vs container-required) that the user must decide, with process-only-plus-consent as the recommended default.

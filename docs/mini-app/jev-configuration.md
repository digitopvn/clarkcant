# Jev selector: configuration and privacy

Jev (TypeSafe System One) is the node's *selector*. It chooses among options the host has already
authorized — a presentation template, a renderer for one region, a runtime to dispatch to — and it
may answer `none`. It never receives data, never grants permission, and never decides a side
effect. Everything that turns its answer into something the user sees is host code.

This document is the operator's half: what to set, what leaves the machine, what is recorded, and
what happens when the provider is unavailable.

## Configuration

All settings are read from the environment of the runtime process. `TYPESAFE_API_KEY` is the only
credential, and it is never read by a renderer, written into props, stored in a snapshot, or
logged.

| Variable | Default | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | *(none)* | Provider credential. No key means the selector is disabled. |
| `CLARKCANT_JEV_ENABLED` | derived | Explicit override. Defaults to "a key is present and the node is not local-only". |
| `CLARKCANT_JEV_LOCAL_ONLY` | off | `1`/`true` forbids sending any intent to a third party. Outranks a key being present. |
| `CLARKCANT_JEV_MODEL` | `jev-1.13.0` | Exact model id. `jev-latest` resolves to the same id today but drifts by definition. |
| `CLARKCANT_JEV_ENDPOINT` | `https://api.typesafe.ai/v1/systemone` | Must be `https`, with no embedded credentials, and must not point at a loopback or private address. |
| `CLARKCANT_JEV_TIMEOUT_MS` | `4000` | Budget for **all** selector calls made while composing one turn. |
| `CLARKCANT_JEV_POLICY_VERSION` | `2026-09-17` | Stamped into telemetry and composition provenance so a decision can be traced to a policy. |
| `CLARKCANT_SEARCH_DECIDER` | `rank` | `rank` uses BM25 alone; `jev` asks the selector to choose between results that are close. Any other value falls back to `rank`. |
| `CLARKCANT_SEARCH_SEMANTIC` | off | `1`/`true` turns on vector retrieval (sqlite-vec + local E5-small), fused with the lexical results by RRF. Off because it was measured: on the Phase 8 corpus it did not improve top-1 and cost precision when the cosine ceiling was loose. |

The key belongs in the runtime's environment or its local, gitignored `.env`. It does not belong in
a `VITE_`/`NEXT_PUBLIC_` variable, a URL query, a fixture, or another repository's `.env` path
referenced from code.

### The exact-model gate

`jev-1.13.0` was verified against the live endpoint on 2026-09-17: HTTP 200 in 999 ms with the
response naming `jev-1.13.0`, and the alias `jev-latest` resolving to the same id in 673 ms. The
adapter re-checks this on every call. If the response names a different model, the call is reported
as unavailable with `model_drift` in telemetry rather than accepted. A policy calibrated against
one model is not a policy calibrated against whatever answers next.

## What is sent

One request, containing:

- the user's intent, **sanitized**: control characters collapsed, token-shaped strings, JWTs,
  long base64/hex runs, email addresses and phone-like digit runs replaced with `[redacted]`, and
  the whole string truncated to 1000 characters;
- the locale;
- candidate **ids and kinds** — `overview@1`, `canvas.line@1@1.0.0` — plus the field *names* of a
  definition's props schema (`datasetRef:string!`);
- data references as `{ref, kind, scale, freshness}`, where `scale` is a bucket (`empty`, `small`,
  `medium`, `large`) rather than a count.

It never contains row values, private titles, file paths, message history, image bytes, the API
key, or any host-owned card. The assembled state is capped at 16 KiB and is refused before the call
rather than sent and rejected. A second check re-scans the serialized state for secret-shaped
values and refuses to send it at all if one survives.

`CLARKCANT_JEV_LOCAL_ONLY=1` disables outbound calls entirely. The composition step then uses the
deterministic path and the default-model fallback, exactly as it does when the provider is down.

## Policy

| Setting | Default | Behaviour |
|---|---|---|
| Choice floor | 0.85 | The winner's probability must reach it, read from the distribution. |
| Margin floor | 0.20 | The winner must lead the runner-up by at least this much. |
| Noul on | 0.85 | Probability at or above this is a yes. |
| Noul off | 0.15 | Probability at or below this is a no. |
| Noul middle band | 0.15–0.85 | **Uncertain.** The smoke test returned 0.58 for a general calendar question; this band exists so that answer is not rounded into a decision. |

The floors and the margin are applied together. A 0.90 winner beside a 0.85 runner-up passes the
floor and fails the margin, and is treated as a coin toss rather than a choice.

These numbers are proposed, not calibrated. Calibration against a labelled corpus happens in
Phase 6, and the numbers are recorded in the release evidence rather than tuned to taste.

## Failure behaviour

| Condition | Outcome |
|---|---|
| No key, disabled, or local-only | `unavailable`; no network call. |
| Budget exhausted before a call | `unavailable`; no network call. |
| 401 | `unavailable`, reason names the credential, not the request. |
| 422 | `unavailable`; the provider's error body is read and discarded. |
| 429 / 529 / 5xx | `unavailable`; **no retry**. A retry inside a four-second budget only makes a slow answer a late one. |
| Deadline exceeded | The call is aborted through its `AbortSignal`, and the reason names the budget. |
| Malformed or drifted response | `abstained` or `unavailable`; a missing field is never read as a default. |
| Low confidence, tie, or `none` | `abstained`, with the reason recorded. |

An abstention is not a failure. It is the answer that says "no offered option fits", and the
caller's job is then to fall back — a deterministic template compile, the configured model, or a
clarifying question — and to record that the composition was a fallback.

## Telemetry

One line per call, printed through the injected sink and kept to the last 200 in memory. It holds:
request id, event (`call`, `refusal`, `policy`, `model_drift`, `error`, `oversized_state`), model id,
policy version, duration, question count, token counts, the selected enum, and a reason.

It holds **no** request body, no prompt, no headers, no key, and no full URL with a query. The
provider's error bodies are discarded for the same reason — they routinely echo the request.

`NodeServices.jev.providerCallCount()` exposes the count of provider calls made by the process.
It exists so that "rendering history does not call the provider" is an assertion rather than a
claim.

## Operator runbook

**The selector is one flag and one credential.** At startup the node prints one line about it:

```
selector: jev-1.13.0 pinned, 4000 ms per turn
selector: disabled (no credential or local-only); composed surfaces use the deterministic path
```

If that line says disabled, everything still works: composed surfaces compile through the
deterministic path, search ranks with BM25, and the finder resolves by ranking or by asking one
question. Nothing in the product depends on the provider being reachable, which is the point of the
fallback.

**Turning it off in a hurry.** Set `CLARKCANT_JEV_LOCAL_ONLY=1` and restart. That outranks a key
being present, so it cannot be undone by an environment that still has one.

**Deciding whether to turn the search decider on.** `rank` is the default because it is the measured
one, and it has now been measured both ways. Deterministically, the labelled corpus answered 96.8% of
lexical queries with BM25 alone. Live, with `jev-1.13.0` on the same corpus, the selector tied it:
31/34 (91.2%) either way, and 8/16 on the routing corpus. Nothing beat the ranking, so nothing bought
the extra call per search. `CLARKCANT_SEARCH_DECIDER=jev` is opt-in, and the comparison harness is
`CLARKCANT_JEV_LIVE=1 pnpm exec vitest run apps/runtime/test/jev-calibration-live.spec.ts`. It prints
a per-case line and a total for both paths; the numbers belong in a report before the default
changes — see `plans/reports/verification-260917-1815-jev-live-integration-and-calibration.md`.

**Turning semantic search on, and when not to.** It needs two optional native pieces on the machine:
`sqlite-vec` (the vector index) and the local embedding runtime with E5-small (`@huggingface/transformers`
plus `onnxruntime-node`). Both are `optionalDependencies` of the runtime, so a checkout without them
installs, boots and passes `pnpm verify` — search is simply lexical and `GET /health`-style status says
which reason applies: the extension is missing, the model could not be loaded, or the index holds
vectors from a different model and needs a reindex.

It is off by default for a measured reason, not a cautious one. On the 34-query labelled corpus the
lexical path answered 31 top-1 correctly; the hybrid path also answered 31 when the cosine ceiling was
0.1, and only 25 when the ceiling was 0.2 or higher — because a KNN query always returns its nearest
neighbours, so a question whose honest answer is "nothing in your history" came back with a near-miss.
The semantic-only subset (queries that share no vocabulary with the target) stayed at 9/12 either way.
Turn it on with `CLARKCANT_SEARCH_SEMANTIC=1` when the history is large enough that a near-miss beats
nothing, and re-measure with
`CLARKCANT_EMBEDDINGS_LIVE=1 pnpm exec vitest run apps/runtime/test/hybrid-calibration-live.spec.ts`,
which prints a per-ceiling sweep. The numbers belong in a report before the default changes.

**What a composed surface costs.** One selector batch per composition when no template was named (two
at most, if the template changes the candidate set), and zero when the model names a template. Search
costs one call only when `decider = jev`, at least two results are close, and the ranking did not
already separate them.

**Project finder.** `workspace.roots` and `workspace.ignore` are preferences on the node (default:
the home directory, and the system ignore list). Changing them needs no restart. What the selector
sees from the finder is a name, a path relative to the root, a kind and marker names — never an
absolute path and never a file's contents. The scan is bounded (depth 5, 20 000 entries), skips
symlinks and dependency directories, and stops descending as soon as it finds a project marker.

When the finder finds nothing, it asks the user for a directory, and the answer is a path. Three
rules make that question answerable and safe:

- **A path is read from the user's own words, before redaction.** The redactor replaces absolute
  paths with a placeholder — a home path is what it exists to remove — so reading it afterwards would
  have discarded the answer and asked again. The path is used locally to open a directory; the
  redacted text is what any search or selector call sees.
- **A directory the user names is indexed even when nothing marks it**, because naming it is the
  signal. It still has to be inside an approved root: a path is not a way to reach outside what the
  user approved, and a path that is missing, outside the roots, or not a directory is refused with
  that reason rather than met with the question again.
- **The directory used last is offered, not opened.** A query that matches nothing but has a recent
  project produces a question ("did you mean …?"); silently opening the last one is how asking for a
  project that does not exist opens the wrong one.

Paths travel relative to the approved root that contains them, so a workspace on another volume does
not disclose the home directory's layout as a relative path.

**Fixture turns.** `CC_MODEL_FIXTURE=1` replaces the model turn with a scripted one that composes an
overview through the production pipeline. `CC_SESSION_FIXTURE=1` does the same for starting a worker
session in a chosen directory: it reports a session id and spawns nothing. Both exist so the browser
suite can exercise real paths without a provider, both print a line saying they are loaded, and
neither belongs on a node a person uses: the reply says a fixture produced it and the node says so at
startup.

**Fixture turns.** `CC_MODEL_FIXTURE=1` replaces the model turn with a scripted one that composes an
overview through the production pipeline. It exists so the browser suite can exercise the render path
without a provider, it prints a line saying it is loaded, and it must never be set on a node a person
uses: the reply it produces says a fixture produced it, and the node says so at startup.

## Running the checks

```bash
# Unit and boundary tests: no credentials, no network.
pnpm exec vitest run apps/runtime/test/jev-selector.spec.ts

# Live smoke: opt-in, needs a real key, sends only synthetic state.
CLARKCANT_JEV_LIVE=1 pnpm exec vitest run apps/runtime/test/jev-live.spec.ts
```

The live file reports `BLOCKED` with the missing variable when it cannot run. It deliberately
never passes silently: "no live evidence" and "live evidence is fine" must not look the same in a
test report.

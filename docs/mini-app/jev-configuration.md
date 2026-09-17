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

# Jev selector: configuration and privacy

> English (default) · [Tiếng Việt](jev-configuration.vi.md)

Jev (TypeSafe System One) is the node's *selector*. It chooses among options the host has already
authorized — a presentation template, a renderer for one region, a runtime to dispatch to — and it
may answer `none`. It never receives data, never grants permission, and never decides a side
effect. Everything that turns its answer into something the user sees is host code.

This document is the operator's half: what to set, what leaves the machine, what is recorded, and
what happens when the provider is unavailable.

The selector is a role, and Jev is the provider that fills it by default. It is separate from the
conversation model: Pi answers the conversation, and the decision provider answers only the small
typed questions below. An operator can select Cloudflare Clef on Workers AI or OpenRouter's decisions
API instead, and the person can choose one in Settings (see
[Choosing a decision provider](#choosing-a-decision-provider)).
Clark's policy — what is offered, what is redacted, the floors, the budget and every fallback — is
the same whichever provider answers; only the endpoint, the credential and the pinned model differ.
Unless a section says otherwise, "the provider" below means the selected one.

## Configuration

All settings are read from the environment of the runtime process, except that the person's choice
in Settings (below) replaces the provider, its model and Cloudflare's account id. The selected
provider's credential (`TYPESAFE_API_KEY`, `CLOUDFLARE_API_TOKEN` or `OPENROUTER_API_KEY`, or the key
saved in that provider's card) is the only one used, and it is never read by a renderer, written into
props, stored in a snapshot, or logged.
The `CLARKCANT_JEV_*` settings other than the model and the endpoint apply to whichever provider is
selected, and `jev` as a value of `CLARKCANT_SEARCH_DECIDER` or `CLARKCANT_CONTEXT_DECIDER` means
"ask the selected decision provider".

| Variable | Default | Meaning |
|---|---|---|
| `CLARKCANT_DECISION_PROVIDER` | `typesafe` | `typesafe` (Jev), `cloudflare` (Clef) or `openrouter` (OpenRouter's decisions API). Any other value refuses every decision call rather than falling back to TypeSafe. A choice made in Settings wins over this. |
| `CLARKCANT_DECISION_MODEL` | *(see meaning)* | Exact model id for the selected provider. With TypeSafe it wins over `CLARKCANT_JEV_MODEL`, and unset leaves that setting in charge. With Cloudflare it is required and must be `clef` or `clef-flash`. With OpenRouter it is required and must be a pinned slug (`vendor/model`, lower case, no `~` alias, and not one of OpenRouter's own routers such as `openrouter/auto`), such as `cloudflare/clef-flash` or `typesafe/jev-1.13`. |
| `TYPESAFE_API_KEY` | *(none)* | TypeSafe credential. With TypeSafe selected, no key means the selector is disabled. |
| `CLOUDFLARE_ACCOUNT_ID` | *(none)* | Cloudflare only. 32 hexadecimal characters; anything else refuses every call. An account id chosen in Settings wins over this. |
| `CLOUDFLARE_API_TOKEN` | *(none)* | Cloudflare only. A token allowed to run Workers AI. A token saved in the decision provider's Cloudflare card wins over this. With Cloudflare selected and no token in either place, the selector is disabled; the TypeSafe key is never used instead. |
| `OPENROUTER_API_KEY` | *(none)* | OpenRouter only, for decisions. A key saved in the decision provider's OpenRouter card wins over this. With OpenRouter selected and no key in either place, the selector is disabled. This is the same variable Pi may use for conversation models; selecting OpenRouter as the decision provider is what makes decisions use it. |
| `CLARKCANT_JEV_ENABLED` | derived | Explicit override. Defaults to "a key is present and the node is not local-only". |
| `CLARKCANT_JEV_LOCAL_ONLY` | off | `1`/`true` forbids sending any intent to a third party. Outranks a key being present. |
| `CLARKCANT_JEV_MODEL` | `jev-1.13.0` | TypeSafe only. Exact model id. `jev-latest` resolves to the same id today but drifts by definition. |
| `CLARKCANT_JEV_ENDPOINT` | `https://api.typesafe.ai/v1/systemone` | TypeSafe only. Must be `https`, with no embedded credentials, and must not point at a loopback or private address. |
| `CLARKCANT_JEV_TIMEOUT_MS` | `4000` | Budget for **all** selector calls made while composing one turn. |
| `CLARKCANT_JEV_SEARCH_TIMEOUT_MS` | `2000` | Budget for **one decision** rather than a whole composition: the selector choosing between close search results, or between usable capabilities. A value that is not a positive number falls back to the default. |
| `CLARKCANT_JEV_POLICY_VERSION` | `2026-09-17` | Stamped into telemetry and composition provenance so a decision can be traced to a policy. |
| `CLARKCANT_SEARCH_DECIDER` | `rank` | `rank` uses BM25 alone; `jev` asks the selector to choose between results that are close. Any other value falls back to `rank`. |
| `CLARKCANT_SEARCH_SEMANTIC` | off | `1`/`true` turns on vector retrieval (sqlite-vec + local E5-small), fused with the lexical results by RRF. Off because it was measured: on the Phase 8 corpus it did not improve top-1 and cost precision when the cosine ceiling was loose. |
| `CLARKCANT_CONTEXT_PLANNER` | on | `off` restores the fixed recap (newest 12 messages) and the fixed memory brief (newest 12 notes), and stops background runs and dispatched task workers from receiving retrieved context. Two improvements stay in both modes: a memory brief that cannot be read gives a turn without it rather than a failed turn, and a turn can be stopped while its context is being read. The recap also reads the newest 40 messages in both modes. On, both are focused on the message being answered, and fall back to the fixed form when nothing matches. `off` also turns off data-class withholding in the recap, the memory brief, retrieved bundles, project instructions and `search_history`; background routing by data class still applies (see [system-architecture.md §7.2](../system-architecture.md)). |
| `CLARKCANT_CONTEXT_DECIDER` | `rank` | `jev` lets the selector reorder the top 8 matches for the recap and memory brief when their ranking is close, and pick one tool family for a message that names none under progressive disclosure. It is asked only when its answer could change what is sent. When it is asked, text leaves the node for the Jev provider: the message being answered (redacted, at most 300 characters; 400 for a tool-family choice) and each candidate memory note or earlier message that is `public` or `internal` as a whole (redacted, at most 200 characters; a more sensitive one is not offered). A failure or timeout keeps the deterministic order. Any other value is `rank`. |
| `CLARKCANT_TOOL_DISCLOSURE` | `all` | `progressive` offers a conversation the core tools plus the tool families its messages name, growing within a session. Off because it was measured: in the offline estimate it saved schema tokens but cost more once prompt-cache rewrites were counted (see [system-architecture.md §7.3](../system-architecture.md)). Any other value is `all`. |
| `CLARKCANT_CONDITIONAL_INSTRUCTIONS` | on | `off` stops reading a project's `.clarkcant/instructions.json`, so no conditional instruction is stated to a conversation or a task worker (see [system-architecture.md §7.2](../system-architecture.md)). Any other value is on. |
| `CLARKCANT_SESSION_POLICY` | `off` | `observe` reports, per turn, whether a conversation's session would be kept or rebuilt and why, as counts on stderr; `rebuild` also rebuilds it, only when the cache is cold, the context large and the subject new (see [system-architecture.md §7.3](../system-architecture.md)). With `CLARKCANT_CONTEXT_DECIDER=jev`, Jev is asked in the unclear band and shown counts only. Any other value is `off`. |

The key belongs in the runtime's environment or its local, gitignored `.env`. It does not belong in
a `VITE_`/`NEXT_PUBLIC_` variable, a URL query, a fixture, or another repository's `.env` path
referenced from code. The TypeSafe key can also be saved in Settings, in one place: the Credentials list on AI & Routing, under the `typesafe` name. The decision provider's TypeSafe card says where the key comes from and offers Go to Credentials rather than a second field. When both hold one,
the key saved in Settings wins, the rule every provider credential follows; the environment's key is
used when Settings holds none. Saving or removing the key there takes effect from the next decision, without a restart; with no key left in either place the selector is disabled. The node's readiness answer (`GET /readiness`, field `sources`) says which of the two is in effect, never the value.

The Cloudflare and OpenRouter keys follow the same rule, but are stored under host-owned vault names
(`decision:cloudflare`, `decision:openrouter`) that only the decision provider's own card writes
(`PUT /decision-provider/credential`). The generic credential store refuses those names, so a secret
somebody stored for another purpose (a `cloudflare` token for a deploy command, say) never becomes the
decision provider's credential, and a decision key cannot be replaced from a form. Each provider reads
only its own name: a TypeSafe key is never sent to Cloudflare or OpenRouter, or the other way round.

### Choosing a decision provider

TypeSafe Jev stays the default. There are two ways to choose another provider, and the first wins:

1. **In Settings → AI & Routing → Decision provider**, beside Provider sign-in and separate from the
   conversation model. The section shows the provider and model in effect, a badge saying what chose
   them (Settings, the environment, or the default), the status with its reason and what to do about
   it (for example "enter the Cloudflare account id below"), and the last call since the node started.
   The node sends each reason as a code (`reasonCode`, beside its English `reason` for logs and machine
   clients), and the card words the code in the interface language, so a Vietnamese card never shows the
   node's English sentence; a refused save is worded the same way.
   The person picks "Follow environment", TypeSafe Jev, Cloudflare Clef or OpenRouter; Cloudflare offers
   its two models and an account-id field, and OpenRouter a model-slug field, which is saved only once a
   slug is entered. Each provider has a key card that says where its key comes from (saved on its card,
   saved in Credentials for TypeSafe, the environment, or none). Cloudflare's and OpenRouter's cards have a
   password field with Save and Remove; a typed key is cleared once saved and never shown again. TypeSafe's
   card has no field of its own: its key is the `typesafe` credential, so the card points to the Credentials
   list, the one place to save, replace or remove it, with a Go to Credentials button that moves focus to
   that row's key field (or to the list's heading if the row is missing). Saving or removing the key there
   updates the card at once, without a reload. A reason code newer than
   the client knows is worded as a generic "no reason this app can show", never as a raw code.
   Every change says it applies from the next decision. The choice is stored as the preference `ai.decisionProvider`,
   so it has a revision and an undo. Choosing "follow the environment" stores `null` and hands the
   choice back to the variables below. The same choice is available over the node's API:
   `PUT /decision-provider` with a body such as
   `{"selection": {"provider": "cloudflare", "model": "clef", "accountId": "<32 hex>"}}`,
   `{"selection": {"provider": "openrouter", "model": "cloudflare/clef-flash"}}`,
   `{"selection": {"provider": "typesafe"}}` or `{"selection": null}`. Keys go to
   `PUT /decision-provider/credential` with `{provider, value}` and are removed with
   `DELETE /decision-provider/credential/<provider>`. Every one of these writes is person-only: an AI
   client or another machine surface cannot choose which third party receives a decision. The generic
   credential routes that also store the `typesafe` key (`POST /credentials`, `DELETE /credentials/<name>`)
   are person-only as well, so they are no way around it.
2. **In the environment**, for an operator who configures the node without Settings:

```bash
CLARKCANT_DECISION_PROVIDER=cloudflare
CLARKCANT_DECISION_MODEL=clef        # or clef-flash
CLOUDFLARE_ACCOUNT_ID=<32 hexadecimal characters>
CLOUDFLARE_API_TOKEN=<a token allowed to run Workers AI>

# or
CLARKCANT_DECISION_PROVIDER=openrouter
CLARKCANT_DECISION_MODEL=cloudflare/clef-flash   # a pinned slug
OPENROUTER_API_KEY=<an OpenRouter key>
```

| | TypeSafe Jev | Cloudflare Clef | OpenRouter |
|---|---|---|---|
| Receives the request | `https://api.typesafe.ai/v1/systemone`, or `CLARKCANT_JEV_ENDPOINT` | `https://api.cloudflare.com/client/v4/accounts/<account>/ai/run/@cf/cloudflare/<model>`, built from the two validated values; there is no endpoint override | `https://openrouter.ai/api/alpha/decisions`; there is no endpoint override. OpenRouter forwards the request to the company that serves the chosen model. |
| Model | `jev-1.13.0` unless overridden | `clef` or `clef-flash`, always named explicitly | A pinned slug such as `cloudflare/clef-flash` or `typesafe/jev-1.13`, always named explicitly; `~` aliases and OpenRouter's routers (`openrouter/auto`, anything under `openrouter/`) are refused, because a router never answers as one pinned model |
| Credential | The key from the settings card, else `TYPESAFE_API_KEY` | The decision provider's Cloudflare card, else `CLOUDFLARE_API_TOKEN` | The decision provider's OpenRouter card, else `OPENROUTER_API_KEY` |
| Request body | System One: `{state, model, questions}` | The same body | The same body |
| Response | System One answer | The same answer inside Cloudflare's REST envelope; only `success: true` is unwrapped | The System One answer plus OpenRouter's `id`, `provider` and `usage.cost`, which are dropped. The model comes back as a dated snapshot of the pinned slug (`typesafe/jev-1.13-20260917`), which is accepted; any other model is drift. |

What leaves the node is identical for every provider: the same redacted, size-capped state and the
same offered options, built before the provider is known. Local-only refuses all of them, and every
failure falls back exactly as described under [Failure behaviour](#failure-behaviour). Changing
provider changes who receives the decision payload, so it is a data-sharing decision as well as a
technical one. With OpenRouter, two parties receive it: OpenRouter and the company serving the model.

OpenRouter marks its decisions API as alpha. Its API reference shows the path
`/api/v1/api/alpha/decisions` while its guides use `/api/alpha/decisions`; the node calls the second,
which is the one that answered live (below).

Cloudflare publishes benchmarks for Clef against Jev. They are the vendor's numbers on the vendor's
workload, not evidence about this node's decisions, which is why the default has not changed.

**When a change applies.** A change of provider, model, Cloudflare account id or key, made in
Settings or through the API, applies from the next decision. The node does not restart, and a
decision call already in flight finishes with the configuration it started with: one call never pairs
one provider's key with another provider's endpoint. The start-up line (see the runbook) still
describes the node as it started. Changes to environment variables, `CLARKCANT_JEV_LOCAL_ONLY` and
`CLARKCANT_JEV_ENABLED` included, still need a restart; neither Settings nor the API can lift
local-only.

**Seeing what is in effect.** `GET /decision-provider` answers with the effective provider and model,
what chose them (`settings`, `environment` or `default`), the host decisions go to, where the key
comes from (`vault`, `environment` or `none`, never the value), for Cloudflare where the account id
comes from, a `status` (`ready`, `local-only`, `misconfigured`, `no-credential` or `disabled`) with
its reason, the outcome of the last call since the node started, and the credential source of every
provider, so a selector can show which ones are ready to use.

**Switching back to TypeSafe.** Choose TypeSafe (or "follow the environment") in Settings, or unset
`CLARKCANT_DECISION_PROVIDER` (or set it to `typesafe`) and restart. A surface another provider chose
stays readable: a replayed turn returns the stored surface without asking any provider, and its
provenance still names that provider and model, because it records who decided rather than what is
configured now. New decisions are recorded as a default node records them, with no `provider` field.
Rolling the node itself back to an older release is different: a release whose stored-surface schema
does not know `provider: "cloudflare"` (or, before OpenRouter support, `provider: "openrouter"`)
refuses to read such a surface (a replay or refresh of it fails). Switch the provider back first and
keep a release that reads the field for as long as such surfaces matter.

**Live evidence (2026-10-08).** Run with real keys and synthetic state only, using the opt-in checks
under [Running the checks](#running-the-checks):

| Provider and model | Template choice | Yes/no question |
|---|---|---|
| Cloudflare `clef` | passed | passed |
| Cloudflare `clef-flash` | passed | passed |
| OpenRouter `cloudflare/clef` | passed | passed |
| OpenRouter `cloudflare/clef-flash` | passed | passed |
| OpenRouter `typesafe/jev-1.13` | blocked: one HTTP 529 (provider overloaded), then timeouts | blocked |
| TypeSafe `jev-1.13.0` direct | blocked: timeouts at 4 s and 20 s | blocked |

The passing runs went through the same model check and response parsing as production, so the Clef
envelope and model id the adapter expects are confirmed live. The two blocked rows are availability
on that day, not a compatibility finding: TypeSafe still answered the wrong-model refusal check as
expected.

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
rather than sent and rejected. A second check re-scans the serialized state for a credential
and refuses to send it at all if one survives.

**The data-class ceiling.** In every decision call, whichever decision it makes and whichever
provider receives it, the content a person, a file or a record supplied is limited to the classes the
selector may be shown: `public` and `internal` (`SELECTOR_DATA_CLASSES`, the same limit the context
planner applies). Content above that is removed before the request is built, never sent and filtered
afterwards:

- a candidate that stands for a record of the person's data (a search result, a memory note or an
  earlier message) is offered only when the whole record is within the ceiling. A search result is
  judged on its whole stored entry, not on the 200-character snippet cut from it, because a value
  split at the cut no longer looks like what it is. A result left out keeps its ranked place; with
  fewer than two results left, the provider is not asked at all;
- free text (the person's words, a directory name, a candidate's description, the person's own
  guardrail rules) is redacted on the whole text before it is cut, and checked again after the cut.
  A cut that leaves a shape (ten digits that ran on into letters now end the text) is redacted
  again, and text still above the ceiling is not sent.

What the host writes itself is exempt from this ceiling, because a dated model id reads as a phone
number to the shape classifier:

- identifiers: option ids, refs, candidate ids and kinds, the locale, and counts;
- the host's fixed instructions and option sentences;
- catalogue descriptions: a model route's `alias (provider/modelId)`, a presentation template's
  label, a guardrail narrowing's description, and a tool family's `about` line.

These are still covered by the credential check below. Which fields of each decision's request fall
on which side is listed, field by field, in `apps/runtime/test/decision-request-fields.spec.ts`; a
new field fails that test until it is placed on one side.

The last step before any provider is called, whichever one is selected, first measures the
serialized request: one over 64 KiB is not sent, and nothing reads it further. It then scans the whole
request (state and questions, including option descriptions) for a credential, with the classifier
the send boundary uses for a model's input. Ids and names that only resemble a token do not count; an
HTTP Basic header written as a key and its value (`{"Authorization": "Basic …"}`), as an assignment
(`headers["Authorization"] = "Basic …"`) or in backticks does. A hit means
the request is not sent at all; the call falls back as any provider failure does, and the reason and
telemetry carry no part of the value.

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

These numbers are proposed, not calibrated: the live calibration against the labelled corpus on
2026-09-17 left them unchanged for want of cases in the middle band, and its outcome is recorded in
the release evidence rather than tuned to taste.

## Failure behaviour

| Condition | Outcome |
|---|---|
| No key, disabled, or local-only | `unavailable`; no network call. |
| Unknown provider name, a Cloudflare model or account id that is missing or malformed, or an OpenRouter model that is missing, an alias, a router (`openrouter/auto`), or not a pinned slug | `unavailable`; no network call, and the reason names the setting. |
| TypeSafe selected with a Cloudflare model id (`clef`, `clef-flash`, or any `@cf/` id) or an OpenRouter slug (anything with a `/`) | `unavailable`; no network call, and the reason says to select the provider that serves it or unset `CLARKCANT_DECISION_MODEL`. |
| A selection in Settings that is not one of the three shapes (an OpenRouter router slug included), or a key that is empty or over 4096 characters | Refused when it is saved, with the field named and never the value; the configuration in effect does not change. |
| A credential left anywhere in the request | `unavailable`; no network call, and the reason carries no part of the value. |
| A request over 64 KiB serialized | `unavailable`; no network call, and the request is not scanned. |
| Fewer than two search results within the selector's ceiling | The ranking stands; no network call. |
| Budget exhausted before a call | `unavailable`; no network call. |
| 401 | `unavailable`, reason names the credential, not the request. |
| 422 | `unavailable`; the provider's error body is cancelled unread, and never returned, logged or stored. |
| 429 / 529 / 5xx | `unavailable`; **no retry**. A retry inside a four-second budget only makes a slow answer a late one. |
| Deadline exceeded | The call is aborted through its `AbortSignal`, and the reason names the budget. |
| A redirect | The call fails rather than follows it, so the credential never reaches a host the endpoint check did not approve. Applies to every provider. |
| A response over 256 KiB | Not read past the limit (by its declared length, or by counting the stream), and treated as malformed. The shared call path holds the same limit whatever transport delivered the answer. Applies to every provider. |
| Malformed or drifted response | `abstained` or `unavailable`; a missing field is never read as a default. For Cloudflare, an envelope without `success: true` or without a System One `result` is malformed. For OpenRouter, a model other than the pinned slug or its dated snapshot (`<slug>-YYYYMMDD`) is drift. |
| Low confidence, tie, or `none` | `abstained`, with the reason recorded. |

An abstention is not a failure. It is the answer that says "no offered option fits", and the
caller's job is then to fall back — a deterministic template compile, the configured model, or a
clarifying question — and to record that the composition was a fallback.

## Telemetry

One line per call, printed through the injected sink and kept to the last 200 in memory. It holds:
request id, event (`call`, `refusal`, `policy`, `model_drift`, `error`, `oversized_state`), model id,
policy version, duration, question count, token counts, the selected enum, and a reason. When a
provider other than TypeSafe is selected, each line also names it (`provider: "cloudflare"` or
`provider: "openrouter"`); a line from a default node has no `provider` field, exactly as before. The
model id is the one the provider answered with, so an OpenRouter line records the dated snapshot that
served the call. A model id the provider returns is cut to 64 characters before it is recorded or
repeated in a reason. `GET /decision-provider` shows the most recent line's event, status, model,
duration and reason.

The same rule applies to what is stored with a decision: a composition's selector provenance and a
search result's decider record carry `provider` only when it is not TypeSafe.

It holds **no** request body, no prompt, no headers, no key, and no full URL with a query. The
provider's error bodies are discarded for the same reason — they routinely echo the request.

`NodeServices.jev.providerCallCount()` exposes the count of provider calls made by the process.
It exists so that "rendering history does not call the provider" is an assertion rather than a
claim.

## Operator runbook

**The selector is one flag and one credential.** At startup the node prints one line about it:

```
selector: jev-1.13.0 pinned, 4000 ms per turn
selector: clef-flash pinned on cloudflare, 4000 ms per turn
selector: disabled (no credential or local-only); composed surfaces use the deterministic path
```

The second form appears only when another provider is selected (`on cloudflare`, `on openrouter`).
The line describes the node at start-up: a provider chosen, or a key saved or removed, in Settings
later changes what the selector does without changing that line. `GET /decision-provider` is the
current answer.

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
installs, boots and passes `pnpm verify` — search is simply lexical, and the search answer says which
reason applies (a `semantic.reason` on a `/search/sessions` response, and
`NodeServices.vectors.status()` in process): the extension is missing, the model could not be loaded,
or the index holds vectors from a different model and needs a reindex.

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
costs one call only when `decider = jev`, at least two results are close, the ranking did not
already separate them, and at least two results are within the selector's data-class ceiling.
Judging a result's class costs the search at most one extra read: a lexical result is judged on the
text the search already returned, results only the vector side found are read back together in one
query, and only the results about to be offered to the selector are judged.

**Project finder.** `workspace.roots` and `workspace.ignore` are preferences on the node (default:
the home directory, and the system ignore list). Changing them needs no restart. What the selector
sees from the finder is a name, a path relative to the root, a kind and marker names — never an
absolute path and never a file's contents. The scan is bounded (depth 5, 20 000 entries), skips
symlinks and dependency directories, and stops descending as soon as it finds a project marker.

When the finder finds nothing, it asks the user for a directory, and the answer is a path. On the
desktop build the client also offers the OS directory dialog for that answer (`pickDirectory()` on
the shell's bridge, channel `desktop:pickDirectory`), and the path it returns is submitted through
the same route as a typed one; the web build has no bridge, so the text field is the whole answer
there. Three rules make that question answerable and safe:

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

## Running the checks

```bash
# Unit and boundary tests: no credentials, no network.
pnpm exec vitest run apps/runtime/test/jev-selector.spec.ts
pnpm exec vitest run apps/runtime/test/cloudflare-decision-provider.spec.ts apps/runtime/test/decision-provider-parity.spec.ts
pnpm exec vitest run apps/runtime/test/openrouter-decision-provider.spec.ts apps/runtime/test/decision-provider-settings.spec.ts

# Live smoke: opt-in, needs a real key, sends only synthetic state.
CLARKCANT_JEV_LIVE=1 pnpm exec vitest run apps/runtime/test/jev-live.spec.ts

# Live Clef smoke: opt-in, needs the Cloudflare settings above, sends only synthetic state.
CLARKCANT_CLEF_LIVE=1 pnpm exec vitest run apps/runtime/test/clef-live.spec.ts

# Live OpenRouter smoke: opt-in, needs OPENROUTER_API_KEY and CLARKCANT_DECISION_MODEL (a pinned slug).
CLARKCANT_OPENROUTER_DECISION_LIVE=1 pnpm exec vitest run apps/runtime/test/openrouter-decision-live.spec.ts
```

Each live file reports `BLOCKED` with the missing variable when it cannot run. It deliberately
never passes silently: "no live evidence" and "live evidence is fine" must not look the same in a
test report.

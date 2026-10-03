---
title: "#382 Let Clark perform an action an isolated widget offers"
status: completed
created: 2026-10-03
issues: [382]
related: [317, 318, 319, 392, 380, 195, 200, 314]
---

# #382 Perform an offered widget action

Source: issue [#382](https://github.com/digitopvn/clarkcant/issues/382) and its two comments (the real placement path,
and folding `invoke_capability`'s widget press from #319 / PR #392 into the generic tool).

## Outcome

A person who selects something in an isolated widget and types (or says) what they want gets it done by Clark, through
an action the widget declared, with the same gate, ledger and policy a press has. A real install can place a package
widget with its offered actions and its Clark buttons bound, so the text editor (#317) and spreadsheet (#318) work
outside the e2e fixture.

## Design

- **Declaration.** A widget definition may declare `offeredActions`: `{ name, label, description, inputSchema }`
  (at most 16). It is part of the reviewed package manifest, never something a frame says at runtime.
- **Binding.** A new proposal kind `perform { action }`. The host compiles one binding per offered action when it
  places the widget. The binding records the declared input schema and the effect category `local-write`.
- **One dispatch.** `invokeWidgetAction` gains the `perform` kind. It runs the same gate (owner, conversation, binding,
  revision, digest, one outcome per invocation id), validates the input against the binding's schema, asks
  `decideExecution` (effect `local-write`, interactive intent), opens and settles the effect ledger, and records the
  source. Only Clark (`agent`, or `voice` through Clark) may perform; a frame or a click naming a `perform` binding is
  refused.
- **Transport.** The node asks the page that streams the current turn (SSE, or the voice socket) with a
  `widget-perform` event. The page finds the mounted frame session for the instance and sends the bridge message
  `action.perform` (extension `actions.perform@1`). The frame answers with `action.performed`. The page reports the
  answer to `POST /app-intents/widget-perform/:performId` (person-only). The node waits for at most 8 s:
  - no live surface, no mounted frame, or a frame without the extension or handler is a clear refusal, and nothing is
    queued;
  - no answer within the bound is reported as uncertain (the frame may have applied it), never retried.
- **Policy.** Autonomous and guarded run `local-write` unless a rule asks or denies. When the policy asks (the "ask"
  mode, or a rule), the tool refuses with an explicit sentence. An approval card cannot reach the frame after the
  turn ends, so this is a documented degraded path rather than a fake approval. A deny is refused.
- **Tools.**
  - `perform_widget_action` (`list` | `perform`): `list` reads the conversation's widget bindings as data; `perform`
    goes through `invokeWidgetAction(..., "agent")`.
  - `invoke_capability`'s job-through-widget press uses the same dispatch helper.
  - `place_widget` places an installed, active package widget. It compiles its offered actions, and binds the `agent`
    buttons the model asks for to the props the widget names (the intent is the model's own words, as with
    `show_view`).
- **Voice.** The voice answer forwards `widget-perform` events over the voice socket the same way it forwards
  `host-control`. The page answers the same way.

## Non-goals

- No approval card for a frame-performed action (see Policy).
- No new isolation lane: a perform grants the frame nothing. Anything privileged the frame does next passes its own
  gate.
- No migration.

## Phases

| Phase | Status | Details |
| --- | --- | --- |
| 01 Contracts, bridge, session | in progress | [phase-01-contracts-bridge.md](phase-01-contracts-bridge.md) |
| 02 Node dispatch, transport, tools, voice | pending | [phase-02-node-dispatch-tools.md](phase-02-node-dispatch-tools.md) |
| 03 Page forwarding, reference apps, fixture, e2e | pending | [phase-03-page-apps-e2e.md](phase-03-page-apps-e2e.md) |
| 04 Docs EN/VI | pending | [phase-04-docs.md](phase-04-docs.md) |

## Acceptance

- Unit tests: an undeclared action is refused, an input that does not match the schema is refused, and an unmounted
  frame is refused clearly with nothing queued.
- E2E: with a spreadsheet range selected, typing "format this as a percentage" changes the range. With a text editor
  selection, typing an edit request changes the selection.
- Docs in EN and VI, including `docs/open-interfaces{,.vi}.md`.
- `pnpm verify`, `pnpm invariants`, and the relevant Playwright specs pass.

## Risks and rollback

There is one PR, and reverting it removes everything. The definition field and proposal kind are additive and
optional, so existing packages and stored bindings parse unchanged.

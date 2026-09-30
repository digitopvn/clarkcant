# ClarkCant Widget Developer Standard

> English (default) · [Tiếng Việt](widget-development.vi.md)

> Status: canonical authoring target for the widget ecosystem.
> Updated: 2026-09-19.
> Applies to the built-in catalog, declarative compositions, isolated widgets and MCP Apps.

## 1. Goals

A newcomer must be able to go from an idea to a widget running locally with a template, test every important state, and then publish to the directory without having to understand ClarkCant's runtime internals.

The developer mental model consists only of:

1. **Definition** — what this widget is, which props/state/events/capabilities it has.
2. **View** — how the UI is displayed.
3. **Actions** — local state or an effect through the host.
4. **Semantic view** — what Clark/voice understands the widget currently holds and can do.
5. **Package** — how to preview, test, version and publish.

The host is responsible for identity, secrets, action authorization, live ownership, sandbox, pin/detach, lifecycle and provenance.

---

## 2. Trust lanes

### Built-in catalog

Trusted code shipped with the client. Use it when the component is a shared product primitive.

### Declarative composition

No executable payload. Combines built-ins through a spec. This is the default choice when the UI can be expressed with the existing catalog.

### Isolated widget

Executable third-party/user UI. Runs in an isolated origin/frame and communicates only through the Widget SDK.

### MCP App

Use the MCP Apps adapter when the package already exists in that ecosystem; it must still follow ClarkCant's host isolation, lifecycle and action semantics.

Do not turn an isolated widget into a native Pi extension just to get permissions more easily.

---

## 3. Package layout

Target convention:

    my-widget/
      package.json
      clarkcant.json
      README.md
      LICENSE
      widgets/
        main/
          index.html
          widget.json
      fixtures/
        default.json
        empty.json
        error.json
        compact.json
      previews/
        cover.webp
        demo.mp4
      test/
        widget.spec.ts

A package can have several facets:

- widgets;
- compositions;
- tools/services;
- skills;
- recipes;
- themes.

A UI facet must update/activate independently of the Pi worker when no Pi facet has changed.

---

## 4. Package manifest

A package has one root manifest, `clarkcant.json`, for every facet it carries. The contract is
`packageManifestSchema` in `packages/contracts/src/install.ts`, and `clark widget init` writes it:

    {
      "schemaVersion": 2,
      "id": "com.example.calendar",
      "version": "1.2.0",
      "displayName": "Calendar Plus",
      "description": "A compact agenda and week view.",
      "hostApi": { "min": 1, "max": 1 },
      "facets": [
        {
          "kind": "ui",
          "id": "com.example.calendar.week@1",
          "entry": "widgets/main/index.html",
          "definition": "widgets/main/widget.json",
          "isolation": "isolated-ui"
        },
        {
          "kind": "tools",
          "id": "com.example.calendar.service",
          "entry": "service/server.mjs",
          "isolation": "service",
          "protocol": "mcp-stdio",
          "capabilities": [
            {
              "tool": "list_events",
              "ref": "com.example.calendar.events.list@1",
              "summary": "List the events in a date range",
              "effectCategory": "read"
            }
          ]
        }
      ],
      "requestedCapabilities": [],
      "permissions": {
        "networkOrigins": [],
        "filesystem": [{ "path": "cache", "access": "write" }],
        "microphone": false,
        "camera": false,
        "lifecycleScripts": []
      },
      "platforms": ["darwin-arm64", "linux-x64", "win32-x64"],
      "publisher": {
        "id": "example",
        "sourceUrl": "https://github.com/example/calendar-plus",
        "license": "MIT"
      },
      "dependencies": []
    }

Each facet kind runs in exactly one lane, and the schema refuses any other pairing:

| `kind` | `isolation` | What it is |
|---|---|---|
| `ui` | `isolated-ui` | A widget drawn in its own frame. `id` must equal the id inside `definition`. |
| `tools` | `service` | A service the node runs in a container, speaking MCP over stdio, that declares every capability it provides. |
| `skills`, `prompts`, `themes`, `setup` | `declarative` | Data a host reads and never runs. |
| `driver`, `voice` | `service` or `trusted-native` | Part of the vocabulary, so a listing can show the lane. No host runs one from a package yet. |

The reader also refuses a manifest when:

- two facets share an `id`, or an `id` is not one plain name (letters, digits, `.`, `_`, `@`, `-`, starting and ending
  with a letter or digit), since it also names the service's data folder and container;
- a package with a `tools` facet has an `id` that is not a reverse-DNS name of at least two lowercase segments, such as
  `com.example.notes`, or is under a namespace the node's own capabilities use (`canvas`, `clarkcant`, `dev`, `mcp`,
  `project`);
- a facet's `entry` or `definition` is outside the package (`..`, an absolute path, a drive letter) or is a URL;
- a `tools` capability `ref` is not named under the package id (`<package id>.<name>@<major>`), or a tool or
  capability is declared twice.

A `tools` facet declares its capabilities in the manifest, so consent can show them before any of the package's code
runs. Installing the package is the consent to what it declares; each call is still decided by the execution policy.

**How the node reads a theme facet.** A `themes` facet's `entry` is a JSON theme document in the package, such as
`{ "kind": "themes", "id": "dusk", "entry": "themes/dusk.json", "isolation": "declarative" }`. The document is a patch
over Clark Default: `appearanceApi` (`{ "min": 1, "max": 1 }`), an `id` equal to the facet's `id`, a `displayName`, an
optional `description`, optional `colors.dark` / `colors.light` (six-digit hex values for the colour tokens named in
`packages/contracts/src/themes.ts`), and optional `radius` (rem from 0 to 2 for `badge`, `button`, `card`, `response`,
`modal`). Nothing else: no CSS, no selectors, no fonts. The node reads it from the installed bytes through the same containment as a widget's files, refuses
one over 64 KiB, and validates it (`packages/core/src/installed-themes.ts`); a theme that fails is listed with its
reason, and the package's other themes still load. A valid theme is also held to the contrast audit Clark Default is
held to, in both schemes (`requiredPairs` in `packages/design-tokens/src/contrast.ts`); one that fails is listed with
the pairs that fail and cannot be chosen, so check both schemes before publishing. It is selected as `package:<package id>#<theme id>`, and a
theme-only package is a UI refresh, never a Pi restart. Installed themes appear under Settings → Experience → Theme.
**How the node runs a service facet.** The node runs one container for each `tools` facet of every active package
generation, and stops it when the generation stops being active (`apps/runtime/src/service-host.ts`). A service is
third-party code and a separate process is not a sandbox, so the container is the boundary. `serviceRunArgs` in
`apps/runtime/src/service-container.ts` defines it: no network, a read-only root, every Linux capability dropped, no
privilege escalation, a non-root user, the package mounted read-only at `/pkg`, one private writable folder at `/data`,
and only the environment variables it names, never the node's own. The host speaks MCP over the container's stdio, so
no port is opened. The engine is Docker running Linux containers, or Podman. Under rootless Docker, which the node
detects from what `docker info` reports, the service runs as the container's id 0: rootless Docker maps that id, and
only that id, back to the account that runs the daemon, so the private folder stays the person's own. It holds no
privilege there, since every capability is dropped and escalation is refused. A node with neither engine does not run the
service. There is no process-only fallback. The capabilities are still registered, as not loaded, with the reason
"needs Docker or Podman to run; this node has neither running".

What the registry reports is what the host observed, not what the manifest hoped:

- a tool the service lists but the manifest does not declare is never registered;
- a declared tool the service does not list stays not loaded, and the reason says so;
- a declared tool whose input schema has a `pattern` or `patternProperties` that could make a check take unbounded time
  stays not loaded, its schema is not stored, and the reason names the pattern, where it is and what to write instead
  (`packages/contracts/src/schema-patterns.ts`). Refused are a repetition whose body can match more than one way,
  such as `(a+)+`; a repeated choice between options that start with the same character, such as `(a|ab)+`; two
  unbounded repetitions in a row over the same characters, such as `\d+\d+`; a backreference; a quantifier inside a
  lookahead or lookbehind; and a pattern longer than 512 characters. A value or key the schema checks against a pattern
  may be at most 1,000 characters;
- a service that stops is restarted with backoff and left stopped if it keeps crashing, and the reason says which;
- a ref the node or another package already registered is left as it is and not served by this package, and the node's
  log says so; once that other package is no longer active on the node, the next reconcile gives the ref to this
  package, without restarting its service;
- a node that finds no engine asks again after a minute, so starting Docker later does not need a node restart.

The reason is what a person reads beside a disabled action. A widget's `invoke` binding, the agent's
`invoke_capability` tool and a spoken command reach one host path, `invokeCapability`
(`apps/runtime/src/application/capability-invoke.ts`). The registry decides whether the capability can run. The
input schema the service listed for the tool decides whether the input is accepted. The execution policy decides whether it may run, and a
policy that asks puts a host-owned approval card in the conversation. The refusals are the `CapabilityInvokeRefusal`
codes in that file.

Not built: a credential broker for services, VM isolation, and calling a service on another node. A model reaches a
package service from the conversation by placing the generic action button with an `invoke` action (§8.1). The browser
journey [`service-facet.spec.ts`](../apps/web/e2e/service-facet.spec.ts) still creates a package's own widget with
`invoke` bindings through a fixture model.

`publisher` is optional in the manifest. `clark widget publish` requires it, because a directory entry has to say who
a package comes from. `dependencies` defaults to `[]`.

**Version 1.** Before version 2, `clark widget init` wrote a widget-only manifest with `"schemaVersion": 1`. It used
`"kind": "widget"` facets, and `filesystem` was a list of paths. ClarkCant still reads that format, but only in memory:

- a `widget` facet becomes a `ui` facet;
- each filesystem path becomes `{ "path": …, "access": "read" }`.

The file is never rewritten, because consent is bound to the digest of the package's bytes. Nothing is repaired either.
If a version 1 value is not valid in the canonical manifest (a version that is not semver, or an unknown platform),
the reader reports it.

The manifest is request metadata; it does not grant permissions by itself.

The version, source artifact and digest the host installs must be immutable within a generation.

---
## 5. Widget definition

Every widget definition must declare:

- stable id + semantic version;
- renderer lane;
- props JSON Schema;
- event schemas;
- state schema + stateVersion if it has durable state;
- `ephemeralStateKeys` — keys that are only view state (filter, zoom, selection): the host drops them before writing to
  the node. Undeclared keys are durable state; forgetting to declare one does not lose data;
- `stateMigrations` — declared `{from, to, ops}` steps (ops: `rename`, `default`, `remove`, `map`) from each
  older `stateVersion` to the next one, run by the host;
- semanticDescription;
- requested capabilities;
- compact/expanded support and minimum height;
- text fallback;
- effect categories;
- dataset refs;
- entry artifact for executable UI.

Do not use props as a channel for code, callbacks, arbitrary HTML, secrets or arbitrary URLs.

The node checks props against the props schema on its main thread, so the schema's `pattern` and `patternProperties`
are held to the same rules as a service's input schema (§4, `packages/contracts/src/schema-patterns.ts`). A definition
whose props schema holds a pattern that could make a check take unbounded time is not loaded:

- `clark widget test` fails "the package can be read" and names the pattern, where it is and what to write instead;
- the Widget Library shows the same reason as a note on the package, and the package's other widgets still load;
- props checked against such a schema anywhere, in the node or in the Widget Lab, are refused with the text fallback.

A string the props schema checks against a pattern may be at most 1,000 characters.

---

## 6. Sizing contract

Every widget must test at least:

- narrow: 320 px;
- conversation: about 720–840 px;
- compact pin;
- expanded;
- detached host window if supported.

Do not assume the viewport height.

Do not force the parent page to scroll horizontally. Horizontal scrolling may only be used inside a data region where reflow would destroy meaning, for example a table/diff.

A widget resize sends a **request** through the host; it does not resize the Electron window itself.

---

## 7. Required UI states

Every widget must have explicit fixtures for:

- loading;
- empty;
- live;
- cached;
- offline;
- partial/unavailable;
- error;
- read-only snapshot;
- action pending;
- action refused/failed;
- compact;
- expanded.

Do not use a blank frame as loading or error.

Do not keep stale rows under a live label when a refresh fails.

---

## 8. Actions, input and read-only cards

This section covers what a widget does (§8.1), what a person gives Clark through one (§8.2), how widgets on one
surface affect one another (§8.3), and the read-only cards that do nothing at all: status, progress and details
(§8.4), and code, diffs and files (§8.5). The first three rest on one
hard distinction:

### Local view action

No external side effect:

- select;
- filter;
- sort;
- zoom;
- expand;
- tab;
- playhead.

Goes through local state/state.update.

### Effect action

Can change host/external state:

- capability invoke;
- agent intent;
- workflow;
- install/connect;
- write.

Goes through a host action binding. A widget does not call a tool by a name it made up.

Every effect invocation needs:

- actionBindingId;
- expected revision;
- validated input;
- unique invocationId;
- pending/settled UI;
- double-click dedup.

The label must describe the real operation. Do not use “Continue” for a destructive effect.

### 8.1 The generic action button (`canvas.action@1`)

One button for every kind of effect. A model places it with `show_view`; its props say what it shows (`label`,
optional `description`, `emphasis` `primary|secondary`, and `icon` from a fixed set), and `props.action` says what it
does. The host compiles `action` into an action binding before anything is stored and strips it from the props, so the
renderer learns the label and nothing about the action. A proposal the host refuses is a sentence the model reads in the
same turn, and no button is left behind.

| `action.kind` | What a press does | Compiled from |
| --- | --- | --- |
| `view` (`view.save`) | Pins this button to the conversation. | Effect category `local-write`. |
| `agent` | Starts a turn in the same conversation whose message is exactly the label; the `intent` goes to the model beside it, with the context its `contextRefs` name, read by the host. The reply is the press's outcome. With `background: true` the request goes to the node's background lane instead, and its result arrives in the conversation and the inbox. | Starting a turn changes nothing by itself; what the turn then does passes the policy on its own. `contextRefs` are checked against the closed grammar and the person placing the button. |
| `invoke` | Calls a package service capability through `invokeCapability`, the same path as the agent's `invoke_capability` tool and voice, within the binding's deadline. | The capability's own effect category and the package generation serving it now; the arguments are checked against its input schema. |
| `workflow` | Runs its steps in `dependsOn` order within one total deadline, and stops at the first step that does not complete. | The most severe category among its steps; each `invoke` step must be served by a running service. Every `invoke` step must call a capability of one package, whose generation the binding pins; a workflow that spans packages is refused when it is compiled, so make one button per package. |

The binding digest covers the proposal, the package generation, the effect category, the label and the limits. A package
update makes the binding stale (`BINDING_STALE`) instead of retargeting it. Whether a press needs approval is the
execution policy's decision at the press, not a flag frozen at compile time. A click and a spoken request for the same
button take the same path (`invokeWidgetAction`) and get the same policy decision and the same outcome.

Every surface reads availability from one function (`bindingAvailability` in
`apps/runtime/src/application/action-bindings.ts`), and the timeline carries it beside the instance. A service that
stopped, a capability that is not a service, or a stale binding is a disabled button with the reason in words, not a
live one that fails. A workflow is available only when every `invoke` step's capability is ready, and the reason names
the step that is not. The press is still checked again when it arrives. A press shows pending, then the outcome in a
`role="status"` line. The outcome is the service's output, the agent's reply, the workflow's last output, "pinned",
"started in the background", "waiting for your approval", or the refusal reason. A second press while the first is
pending sends nothing. A foreground agent press while Clark is still answering is refused with `TURN_IN_PROGRESS`
rather than interrupting.

**Limits.** A proposal may ask for tighter `limits` than the defaults. What it asks for is clamped to the ceilings when
the binding is compiled, and a binding stored without limits runs under the defaults, so no binding runs unbounded
(`apps/runtime/src/application/action-limits.ts`).

| Kind | `deadlineMs` | `maxTokens` | `maxCallsPerMinute` |
| --- | --- | --- | --- |
| `invoke` | 60 s by default, 1–60 s; the service host's own call ceiling still applies. | — | 30 by default, 1–120. |
| `agent` | — (the node's turn and background deadlines apply) | 4000 by default, 256–16000. | 10 by default, 1–30. |
| `workflow` | 120 s by default, 1–300 s, for the whole run. | — | 10 by default, 1–60. |

The per-minute count is per binding and on this node. A press counts once it passes the binding, revision and input
checks, before the policy decides, so a press the policy then refuses or sends for approval still uses one. A press over
the limit is refused with `RATE_LIMITED` (429), carrying `retryAfterMs` and `limit`, and nothing runs. The count is
held in memory for the bindings pressed in the last minute, at most 1000 of them.

**Context for an agent button.** `contextRefs` form a closed grammar: `widget` / `widget:<instanceId>` (what a widget
means now, from the same semantic document `inspect_ui` reads), `selection` / `selection:<instanceId>`, and
`state:<key>` / `state:<instanceId>/<key>` (one value of a composed view's state). A reference without an instance id
means the button's own widget. Anything else is refused when the binding is compiled, as is a widget this node does not
hold or one another person owns. `artifact:<id>` is refused until the node has the artifact broker (#313). At the press
the host reads each reference again for the person who pressed and bounds each to 4000 characters, cut at a character
boundary. What it reads can be text a widget wrote, so it is data, never guidance: it is not placed in the turn's
guidance note, nor in a background worker's request text. It goes in a separate section after the person's words and
the guidance, under a heading that marks it as data, not instructions. The host also makes it inert there: square
brackets become full-width ones, line and paragraph separators become plain line breaks, and every line is indented
under its entry, so widget text cannot close the guidance marker or start an entry of its own. The button itself adds
nothing: it sends no input, and anything it sends is refused. A reference that no longer resolves refuses the press with
`CONTEXT_REF_UNKNOWN` (404) or `CONTEXT_REF_FORBIDDEN` (403) before any model is called. The request and its context
are then measured against `maxTokens` with a conservative estimate (UTF-8 bytes / 3). One that does not fit is refused
whole with `TOKEN_BUDGET_EXCEEDED`, and nothing is sent to the model. A background request hands the budget to its
worker as the brief's `maxTokens`. The model adapter does not yet cap a worker's own output with it.

**A call whose answer never came.** Stop, Escape or "dừng lại" in the conversation also stops a button's service call or
workflow still running there. While one runs, the composer shows Stop. A foreground agent press is a turn, and the same
Stop ends it as a turn. It is not counted a second time as a button's run.

Every call that is not a `read` goes through the effect ledger (#273), the way a browser action does
(`apps/runtime/src/application/action-effects.ts`). After the registry, the schema and the policy have allowed it, and
before anything is sent, the call is written as `submitted` under a task of its own, in one transaction. A ledger that
cannot be written refuses the press with `LEDGER_UNAVAILABLE` (503), and nothing is sent. What comes back settles it:

- an answer confirms it;
- a call that never left the node (the service was not running, or the call was withdrawn before it was written) marks
  it failed, and nothing happened;
- any other ending marks it unknown: it ran out of time, was stopped, the service exited mid-call
  (`SERVICE_UNREACHABLE`), or the service answered with an error after it may have done part of the work
  (`SERVICE_TOOL_FAILED`).

An unknown call may have taken effect. The press answers `outcome: "uncertain"` with `mayHaveRun: true` and
`recorded`, which says whether the ledger now holds the question. Only then is there an inbox notice asking the person
whether it took effect, and only then do the words the person reads or hears mention the inbox; otherwise they ask the
person to say so in the conversation. If the node dies mid-call, the `submitted` row is still there, and boot recovery
turns it into an unknown effect with the same inbox notice. The call is recorded against the invocation id and never
retried: the same id gets the uncertain answer back and sends nothing.

A `read` opens no ledger entry. One that did not finish is refused with `readOnly: true`, since nothing changed and
pressing again is safe. A service over MCP stdio is sent `notifications/cancelled` for a withdrawn or timed-out
request. A service that honours it can stop, but the host never assumes it did.

**One outcome per invocation id, across a restart.** Before anything is sent, the node writes a `started` record for
the invocation id, and replaces it with the outcome when the press ends. The same id arriving again gets that outcome
back and runs nothing. While the first is still running the answer is `INVOCATION_IN_PROGRESS`. After a restart
interrupted it, the answer is `ACTION_INTERRUPTED` with `outcome: "uncertain"`, and it is not run again. A press refused
before anything was sent is not recorded, so the same press can run once whatever refused it changes. The press is
also refused with `INSTANCE_UNKNOWN` (404) when the widget is not in the conversation the request names, so Stop, the
approval card, the background run and the ledger task all belong to the widget's own conversation.

**Workflows.** The step vocabulary is closed and holds no code:

- `invoke` calls a capability through `invokeCapability`, with its own registry check, schema check, policy decision
  and, when the policy asks, its own approval card;
- `transform` reshapes the output of the step it depends on with one of five pure functions: `select-field`,
  `filter-equals`, `map-field`, `take` or `count`;
- `condition` tests that output (`equals`, `not-equals`, `exists`, `greater-than` or `less-than`), and the steps
  depending on a false condition are skipped.

An `invoke` step's argument may be `{"$step": "<id>"}` (a step it depends on, optionally with `"field"`) or
`{"$input": "<key>"}` (a value the press sent). The run stops at the first step that is refused, fails, asks for
approval, or does not answer in time. A step is not sent with less than 250 ms of the deadline left; the run stops
before it instead, with nothing sent. Its message names that step and the steps that did not run. The steps before it
stay done, because a workflow has no rollback and never claims one. The response says `outcome: "partial"` when some
step reached a service before the stop, `"uncertain"` when the stopped step may have run, and `"refused"` otherwise, and
it carries a `workflow` report of every step. Every step the run reached, a skipped one included, is written to the
audit log. An approval a step asked for is a host card in the conversation. Approving it runs that step on its own and
does not resume the workflow. An approved call runs under the service host's own ceiling (60 s), not the button's
deadline or per-minute count, and the conversation's Stop does not reach it.

Response bodies say what happened in `outcome`: `done` (200), `approval-required` (202) or `background` (202). A
refusal's body carries `code`, `message` and, when relevant, `outcome`, `mayHaveRun`, `recorded`, `readOnly`,
`taskId` (the ledger entry, only when `recorded`), `retryAfterMs`, `limit` and `workflow`. The `message` is English, for
logs and agents. The conversation and voice say the outcome in the person's language from the code and the details
(`packages/conversation-client/src/action-messages.ts`, `apps/runtime/src/application/action-speech.ts`). They never show
a raw code, and a call that may have run is never said as a failure.

`canvas.cta@1` is kept so history renders. A model can no longer place it, because it had no action behind it.

Tests: `apps/runtime/test/action-widget.spec.ts`, `apps/runtime/test/workflow-executor.spec.ts`,
`apps/runtime/test/action-speech.spec.ts`, the bounded-call cases in `apps/runtime/test/service-host.spec.ts`,
`packages/conversation-client/test/action-button.spec.ts`, `packages/conversation-client/test/action-messages.spec.ts`, and the
browser journey `apps/web/e2e/action-widget.spec.ts`, which runs each kind against a real notes service in a container,
including a workflow, an agent button with a context reference and Stop during a slow call.

### 8.2 Forms, lists, search and fields

Five definitions let a person give Clark something rather than only read it. One field model, in
[form-fields.ts](../packages/contracts/src/form-fields.ts), describes a field and checks its value. The page and the
node both use it, so the page shows the same problem the node would refuse.

| Definition | What it is | How a model places it |
| --- | --- | --- |
| `canvas.form@1` | Fields plus one send button, bound to one action. | `show_view` with `props.fields` (1–20), `props.submitLabel` and `props.action`, an `agent` or `invoke` action. |
| `canvas.list@1` | Items with stable ids, with optional single or multi selection, paging (5–50 per page) and an empty text. | `show_view` with `props.items` (up to 200). `props.itemActionLabel` together with `props.action` gives each item a button for that action. It can also be a layout leaf, which has no item button. |
| `canvas.search@1` | A search box. | Only as a layout leaf. With no declared state it narrows every table in the same surface, on the page; with state it writes a key through an `on` rule (§8.3). |
| `canvas.choice@1` | One choice: `chips`, `select`, `multiselect`, `radio`, `checkbox` or `toggle`. | A form's field, or a layout leaf with an `on` rule that writes the surface's state (§8.3). Never alone with nowhere for its value to go. |
| `canvas.input@1` | One input: `text`, `number`, `date`, `date-range`, `time` or `slider`. | As a choice. |

What the node guarantees:

- **No secret fields.** A field whose name or label asks for a password, token, key, PIN or similar is refused before
  anything is stored. The model reads the reason in the same turn. Credentials go through the host's connection flow.
- **The binding knows what it accepts.** A form's binding records its field names and a JSON Schema built from its
  fields. A list's binding records its item ids. Every submission is checked again on the node. A missing required
  value, a value outside its options or range, an unknown field, or an item that is not in the list is answered with
  `400 INVALID_INPUT` and the reason, and nothing runs.
- **Same route as a button.** A form's `submit` sends its values as the action input. A list item's button sends
  `{ itemId }`, or the argument an `invoke` binding names. Both go through `POST …/widgets/{instanceId}/actions` with
  the same revision, digest and invocation-id checks as §8.1. An `agent` form starts a turn whose message is the send
  label followed by each field as `label: value`. An `invoke` form passes each field as the capability argument of the
  same name.
- **View state stays on the page.** A form's draft, a list's selection and page, and a search query are view state.
  None of them is sent anywhere until the person submits or presses. A refused submission keeps the draft.

What the page does:

- Each field has a real label, its help and its error linked through `aria-describedby`, and `aria-invalid` when it is
  wrong. A problem shows once the field has been left, or when the person tries to send. A send with problems sends
  nothing, says how many fields to fix, and moves focus to the first one.
- A slider nobody moved has no value and says "Not set", rather than sending wherever its thumb rests.
- Chips show a check mark as well as a colour. A toggle is a `role="switch"`. Every field is at least 44 px tall, and
  buttons grow to 44 px on a touch screen.
- A list's item button is live only when the host says its binding can run. Otherwise the list says it is view-only,
  rather than drawing buttons that do nothing. A list has loading, empty and error states.
- The search box settles 250 ms after typing pauses, at once on Enter, and Escape or the clear button empties it. A
  query that matches nothing shows the table's own "no matching rows" state.

Tests: [form-fields.spec.ts](../packages/contracts/test/form-fields.spec.ts),
[input-primitives.spec.ts](../apps/runtime/test/input-primitives.spec.ts) for the node,
[input-primitives.spec.ts](../packages/conversation-client/test/input-primitives.spec.ts) for the page, and the
browser journey [input-primitives.spec.ts](../apps/web/e2e/input-primitives.spec.ts), which runs at 1440 px and at
375 px with touch.

### 8.3 Connecting widgets on one surface

A layout tree ([widgets and extensions §4.1](widgets-and-extensions.md#41-implementation-status-2026-09-17)) places
widgets. A state graph says how
they affect one another: a choice picks the series a chart plots, a search box narrows a table, a table's selection
counts into a number. The graph is data the host owns and checks, built from three closed parts, in
[composition-graph.ts](../packages/contracts/src/composition-graph.ts):

- **State**: `props.state` on `canvas.overview@1`, at most 16 keys, each `{ "type": "string" | "number" | "boolean" |
  "string-list", "initial": … }`.
- **On**: a leaf's `on` list. Each entry names an event its definition emits and the steps that write state:
  `set`, `toggle`, `copy`, `append`, `remove`, `select-field`, `map-field`, `take` and `count`.
- **Feed**: a leaf's `feed` list. `{ "op": "query", "key" }` for a table or a list, `{ "op": "filter-equals",
  "field", "key" }` for a table column, a list's `title`, `subtitle` or `meta`, or a chart's `series`.

| Definition | Event it emits | Carries |
| --- | --- | --- |
| `canvas.search@1` | `query.change` | `query` |
| `canvas.choice@1` | `choice.change` | `value` |
| `canvas.input@1` | `input.change` | `value` |
| `canvas.list@1` | `selection.change` | `selected` |
| `canvas.table@1` | `row.select` | `rowIds` |
| `canvas.calendar@1` | `date.select` | `date` |

```json
{
  "state": { "metric": { "type": "string", "initial": "completed" } },
  "layout": { "kind": "stack", "children": [
    { "kind": "widget", "widget": "canvas.choice@1",
      "props": { "label": "Metric", "kind": "radio", "options": [
        { "value": "completed", "label": "Done" }, { "value": "created", "label": "Created" }] },
      "on": [{ "event": "choice.change", "steps": [{ "op": "select-field", "key": "metric", "field": "value" }] }] },
    { "kind": "widget", "widget": "canvas.line@1",
      "feed": [{ "op": "filter-equals", "field": "series", "key": "metric" }] }
  ] }
}
```

What the host guarantees:

- **A leaf never names another leaf.** It says which key it writes and which key it reads, so two widgets are
  connected only through a value the host holds and can check.
- **Checked before anything is stored.** An undeclared key, an unknown operation, an event the definition does not
  emit, an input it does not read, and a step that writes a type its key cannot hold are refused with the reason, in the
  same turn. There is no callback and no code.
- **The node keeps what the rules say.** Each leaf with an `on` rule gets its own view binding, operation
  `state.event`. The page applies an event at once so the person sees it, then sends `{ "event", "payload" }` through
  `POST …/widgets/{instanceId}/actions` under the surface's revision. The node applies the same rules again to the
  value it stored and keeps the result; a page cannot write a value directly. An event its rules do not allow is
  answered with `400 INVALID_INPUT`, and nothing of it is kept.
- **Live and history differ on purpose.** The live surface reads its values back after a reload. The transcript's
  copy draws the graph as it was captured, with its starting values, and can still be explored on the page without
  sending anything.
- **An agent reads the values, not the page.** The live read returns `semanticState`: the current values, bounded and
  typed, with a one-line summary. It is data about the view, never instructions.
- **A search box without a graph behaves as before.** It narrows every table in the surface on the page, and nothing
  is stored or sent for it.
- A chart fed by a choice says which series it shows, named by the option the person picked. A series the data does
  not have is named too, and the chart keeps its own.

Tests: [composition-graph.spec.ts](../packages/contracts/test/composition-graph.spec.ts) for the rules,
[composition-graph.spec.ts](../apps/runtime/test/composition-graph.spec.ts) for the compiler and the node,
[surface-graph.spec.ts](../packages/conversation-client/test/surface-graph.spec.ts) for the page, and the browser
journey [composition-graph.spec.ts](../apps/web/e2e/composition-graph.spec.ts), which also runs at 375 px.

### 8.4 Status, progress and details cards

Three read-only definitions show what a model knows about one thing: a status, how far along it is, or a few labelled
facts. They are the "Text / status" row of [widgets and extensions §4](widgets-and-extensions.md#4-rich-built-in-catalog)
for content the model states. They are not the host's task, connection or install cards, which stay host-owned. One
set of functions, in [status-cards.ts](../packages/contracts/src/status-cards.ts), checks the props and writes the
text. The node and the page both use it, so the page never draws a card the node would refuse.

| Definition | What it is | Props |
| --- | --- | --- |
| `canvas.status@1` | One status with a tone. | `label` (1–120), `tone` (`neutral`, `info`, `success`, `warning`, `danger`), optional `title` (up to 200), `detail` (up to 500) and `asOf`. |
| `canvas.progress@1` | The progress of one thing: a value of a maximum, or a list of steps. | Either `value` (0 or more) with `max` (above 0) and an optional `unit` (up to 20), or `steps` (1–12), each `{ label (1–120), status, detail? (up to 200) }` with status `done`, `current`, `pending`, `failed` or `skipped`. Optional `title` and `label` (each up to 200) and `asOf`. |
| `canvas.details@1` | Labelled facts. | `items` (1–24), each `{ label (1–80), value (1–300) }`, with no label repeated. Optional `title` (up to 200) and `asOf`. |

Every text prop is one line. This node counts a length in UTF-16 code units, so a character outside the Basic
Multilingual Plane, such as most emoji, counts as two. JSON Schema's `maxLength` counts code points, so the node is
the stricter of the two: a label of 120 emoji fits the schema as a standard validator reads it, and this node refuses
it.

A model places each card with `show_view`, or as a leaf of a layout tree
([widgets and extensions §4.1](widgets-and-extensions.md#41-implementation-status-2026-09-17)), where the three take
the `status` region.

What the node guarantees:

- **Nothing spins with nothing behind it.** A progress card needs a value and a maximum, or steps. A card with
  neither, with both, with a value above its maximum, with a unit on steps, or with more than one current step is
  refused with the reason in the same turn, and no instance is stored.
- **What is drawn is what is read.** A text prop may not hold a line break, a control character, a bidi control
  (U+202A–U+202E, U+2066–U+2069, U+200E, U+200F, U+061C), an invisible character (U+200B, U+FEFF, U+00AD, U+180E,
  U+2060–U+2064, U+FFF9–U+FFFB), a tag character (U+E0000–U+E007F) or a Hangul filler (U+115F, U+1160, U+3164,
  U+FFA0). Each would make what a screen reader, a transcript or the next turn reads differ from what the page draws.
  The refusal names the character, for example
  `property "label": contains U+202E, a control that changes text direction …; remove it`. ZWJ, ZWNJ and the variation
  selectors stay allowed, since scripts and emoji need them. The definition's JSON Schema carries the same rule as a
  `pattern`, so a model can read it before it tries. The pattern is written for the way this node compiles it, without
  the `u` flag, where a tag character is a pair of UTF-16 units; a validator that adds the `u` flag lets tag characters
  through the pattern, and the node's own check still refuses them. The pattern decides any line in time linear in its
  length. Text is trimmed and put in NFC before a label is checked for being empty or repeated.
- **An "as of" time is never ambiguous.** `asOf` is a day (`2026-09-30`) or an instant with `Z` or an offset
  (`2026-09-30T07:30:00+07:00`). A local time with no offset, or a date that does not exist, is refused.
- **The text alternative is the card's own words.** It is built from the props, for example
  `Build: Flaky (warning). 2 retries (as of 2026-09-30)` or `Photos: 42 of 120 photos (35%)`, and the caption does not
  replace it. A layout section that holds a card uses the same words.
- **The text is bounded.** A snapshot the conversation cannot read back would stop the whole conversation from
  opening, so the node checks every snapshot before it stores it. A card's text keeps whole facts or steps up to 4000
  characters, and ends with `…and N more facts` (or steps) when some did not fit. A layout section keeps up to 2000,
  and a whole layout's text ends with `… (shortened)` past 4000. Any other widget's own words, such as a list's titles,
  are shortened the same way. Only a caption the model wrote over 4000 characters is refused, since only the model can
  say it in fewer words. The instance, its action binding and its snapshot are written in one transaction, so a refusal
  leaves none of them behind.
- **One unreadable snapshot does not close the conversation.** A snapshot stored before these checks existed may be
  one this node cannot read back. The conversation still opens: that block says it could not be read and that the rest
  of the conversation is kept, the others are drawn as usual, and the node logs which snapshot failed.
- **A figure never overstates.** The percentage is rounded, and shows 99% rather than 100% while the value is still
  below its maximum.
- **Voice and `inspect_ui` read what was stated, not a live reading.** The semantic document (§9) is built from the
  props. Its summary says "as stated when shown", and its freshness is `unknown` rather than `live`. The card has no
  actions and no state.

What the page does:

- The tone is a word in a badge, next to a mark, so a colour is never the only signal. Each step shows its status in
  words, and the current step carries `aria-current="step"`.
- A value of a maximum is a `role="progressbar"` with `aria-valuemin`, `aria-valuemax`, `aria-valuenow` and an
  `aria-valuetext` that matches the figure on screen.
- An `asOf` day is shown as that day. An instant is shown in the reader's own time zone and locale, after "As of".
- A card that looks like a reading says whose words it shows. A progress card always ends with "As Clark stated at
  09:30", and a status card does when it has no `asOf`. The time is when the message was kept, in the reader's locale,
  with the date when it was not today. A model is told not to use a status or progress card for the node's own tasks
  and runs, which already have live cards. In the Widget Library a fixture says "Sample" there instead, since nobody
  stated it.
- The card shows no freshness badge, since what it shows is what the model wrote. It has no control, and it adds no
  motion of its own.
- Details line up as two columns, the labels taking at most 40% of the card. When the card itself is narrower than
  360 px, on a phone or as one tile of a grid, each value goes under its label. Long values wrap rather than widen the
  page.
- Props the page cannot read, such as a label an older node stored with a line break in it, show an error state rather
  than a guessed card.

Tests: [status-cards.spec.ts](../packages/contracts/test/status-cards.spec.ts) for the rules,
[status-cards.spec.ts](../apps/runtime/test/status-cards.spec.ts) for the node,
[status-cards.spec.ts](../packages/conversation-client/test/status-cards.spec.ts) for the page, and the browser
journey [status-cards.spec.ts](../apps/web/e2e/status-cards.spec.ts), which runs at 1280 px in dark and light themes,
at 390 px with touch, as tiles of a grid asked for three columns (drawn as two in the conversation column at 1280 px,
since a grid never makes a column narrower than 220 px, and as one on a phone), and in the Widget Library. The rules for hidden characters are
in [text-rules.ts](../packages/contracts/src/text-rules.ts), tested by
[text-rules.spec.ts](../packages/contracts/test/text-rules.spec.ts), and
[status-card-schemas.spec.ts](../packages/widget-catalog/test/status-card-schemas.spec.ts) checks that the JSON Schema
and the card's own checks accept and refuse the same props.

### 8.5 Code, diffs and files

Three definitions show a piece of work: a block of code, a unified diff and a file. Everything on them is what the
model wrote into their props, checked against one description in
[artifact-viewers.ts](../packages/contracts/src/artifact-viewers.ts) that the node and the page share. None of them
fetches, opens or links anything. The node's own artifact and diff cards stay host-owned and are built from its
records. These three are catalog cards a model places beside them.

| Definition | What it is | How a model places it |
| --- | --- | --- |
| `canvas.code@1` | A block of code with line numbers, highlighted, and a copy button. | `show_view` with `props.code` (at most 20,000 characters and 400 lines), and optionally `path`, `language`, `startLine` (the number of the first line, for an excerpt) and `truncated`. With no `language`, the card takes it from the path's extension. |
| `canvas.diff@1` | A unified diff: each file's hunks, each line with its old and new number and a sign. | `show_view` with `props.files` (1–20). Each file has a `path`, an optional `oldPath` for a rename, and hunks (1–20 per file) of `oldStart`, `newStart`, an optional `section`, and `lines` of `{ kind: "add" \| "remove" \| "context", text }`. At most 600 lines and 40,000 characters in all, and 1,000 characters a line. |
| `canvas.file@1` | A file, named and described. | `show_view` with `props.name`, and optionally `mediaType` (`type/subtype`), `sizeBytes`, `source` (in words), `path` (as text) and `summary`. |

What the node guarantees:

- **Refused before anything is stored.** Props that do not fit are refused with the reason, in the same turn, and no
  instance is left behind. Code or a diff over a limit is refused with a reason that names the limit and where it was
  passed (the code's length or line count, a file's hunks, one line of one hunk, or the diff's total) and asks the
  model to cut it and set `truncated`. A diff is also refused for a hunk that changes nothing, a hunk at old line 0
  that keeps or removes lines, a hunk at new line 0 that keeps or adds lines, hunks that overlap or are out of order,
  and a file given twice. A file card is refused for a name that includes its folder, and for a `path` that is a URL
  (anything that starts with a scheme such as `https:` or `file:`; a Windows drive such as `C:\` is a path and is
  kept). An unknown property, such as `url` or `href`, is refused too.
- **Hunks agree with each other.** Each hunk after the first must start where the ones above it leave the file: if
  they move old line 30 to new line 32, the next hunk that starts at old line 40 starts at new line 42. The check is
  skipped when `truncated` is set, because part of the change may be left out, and for a hunk with a count of 0 on
  either side, because unified diffs number an add-only or remove-only hunk from the line before it.
- **One-line text stays on one line and shows what it holds.** Paths, names, titles, sections, sources and media types
  are refused if they hold a line break, a bidi control (U+202A–U+202E, U+2066–U+2069) or an invisible character that
  can make text read differently from how it looks (U+200B, U+200E, U+200F, U+2028, U+2029, U+0085, U+FEFF). The reason
  names the character. The zero-width joiner and non-joiner (U+200D, U+200C) are allowed, because emoji and several
  scripts need them. A file's `summary` may run over several lines but is refused for the same hidden characters.
- **Line breaks in code are lines.** `\r\n`, `\r`, U+2028, U+2029 and U+0085 in code each count as a line break and
  are stored as `\n`, so the line numbers match the lines a person sees and the 400-line limit counts them. One line of
  a diff is refused if it holds any line break: each line of the diff is given as a line of its own.
- **Counts come from the lines.** Each hunk's `@@ -a,b +c,d @@` header and every count of lines added and removed are
  worked out from the lines themselves, so a diff cannot claim more or fewer changes than it shows.
- **The text is the content.** Without the renderer, a reader gets the code, the diff with its headers, or the file's
  name, type, size and source. It is cut at 4,000 characters with a note of how much more is on the card, never in
  the middle of a character. The caption is not used in its place. A hidden character in code or a diff line is
  written there as `⟨U+202E⟩` rather than applied, with a line that says how many there are.
- **What voice and the next turn read has no body.** The semantic document names the path, the language and the line
  range of code, the files and counts of a diff, and a file's name, type and size. It never carries the code or the
  lines themselves. It does say how many hidden characters the code or diff holds. Its freshness is `unknown`: the
  card shows what the model wrote when it placed it, and nothing is read again.
- **Not layout leaves.** They belong to the `artifact` family, which no layout region reads. A model places each one
  on its own.

What the page does:

- Code and diffs are shown as text. The highlighter only splits the text into tokens and escapes it. Its output is
  built as React elements, so code that looks like markup, `<script>` included, is shown as the characters it is.
- A bidi control, an invisible character, a tag character or a Hangul filler in code or a diff line (the set a
  one-line field refuses, in §8.4) is drawn as a visible marker, such as `⟨U+202E⟩`, whose tooltip says what kind of
  character it is, instead of being applied. A tag character is two UTF-16 units and is drawn as one marker. The card then carries one line warning
  that it holds hidden characters that could make it read differently from how it looks. This is the "Trojan Source"
  case, where a bidi control makes code run differently from how it reads.
- A long block scrolls inside a bounded area (at most `min(24rem, 60vh)`) and does not wrap or widen the page. That
  area is a named region a keyboard can reach and scroll, with a focus ring drawn inside it so the card's rounded
  edge cannot clip it.
- Copy puts the code itself on the clipboard. The button is named after what it copies ("Copy code:
  src/auth/role.ts"), starting with the word it shows. It says in words whether the copy worked, and if it did not,
  asks the person to select the code and copy it. That message sits in a status region that is on the card from the
  start and takes no room while empty, and each result replaces the last, so the same words are announced again on a
  second try.
- In a diff, a line is told apart by its sign and background, not by colour alone. A screen reader hears each line's
  kind and number in words ("Added, new line 41:") before its text; the signs and numbers it would otherwise read one
  character at a time are hidden from it. A rename says what the file was called before.
- A file card has no link, no open and no download. It says so in words, rather than drawing a button that does
  nothing.
- With `truncated`, the card says that it is not the whole of the code or the diff.

Tests: [artifact-viewers.spec.ts](../packages/contracts/test/artifact-viewers.spec.ts) for the rules,
[artifact-viewers.spec.ts](../apps/runtime/test/artifact-viewers.spec.ts) for the node,
[artifact-viewers.spec.ts](../packages/conversation-client/test/artifact-viewers.spec.ts) for the page, and the
browser journey [artifact-viewers.spec.ts](../apps/web/e2e/artifact-viewers.spec.ts). It runs in both themes, with
reduced motion, at 390 px with touch, and in the library. It also covers hidden characters drawn as markers with
their warning, a line separator in code that keeps the numbers beside their lines, a line break inside a diff line
that is refused, a copy the browser refuses, and a focus ring that must be painted inside the scroll.

### 8.6 Area and scatter charts

Two definitions draw numbers from a dataset over named fields: an area chart of one or more series along an x axis,
optionally stacked, and a scatter plot of points by two numbers. They reuse the line and bar charts' axes, number
formatting, tones and table fallback. One set of functions, in [xy-charts.ts](../packages/contracts/src/xy-charts.ts),
reads the props and the rows, checks a view, and writes the text. The node and the page both use it, so the page never
draws a chart the node would refuse.

| Definition | What it is | Props |
| --- | --- | --- |
| `canvas.area@1` | An area chart: each series filled down to zero, or stacked. | `datasetRef`, `x` (a field name), `y` (1–8 field names), optional `labels` (a name for each plotted field, up to 60), `unit` (up to 20), `title` (up to 200) and `stacked`. |
| `canvas.scatter@1` | A scatter plot: one point per row and series, at its x and y. | `datasetRef`, `x`, `y` (1–8), optional `labels`, `unit`, `xUnit` (up to 20), `title` and `pointLabel` (a field that names each point). |

A field name is 1–64 characters on one line, not only spaces, with none of the hidden characters of §8.4. The fields
are named, never guessed: a chart with no `x` or no `y` is refused, and so is a field named twice, `x` repeated in `y`,
or a label for a field the chart does not plot. `stacked` belongs to an area chart and `pointLabel` to a scatter plot.

A model places each one with `show_view`. They are in the `chart` family, which no layout region reads, so a model
places each on its own.

What the node guarantees:

- **The rows are read before anything is stored.** The node reads the dataset the chart names, as the person placing
  it, and refuses in the same turn, with the reason, when the dataset is not on this node or is not theirs, when a
  named field is not in it (the reason lists the fields it has), or when a row does not fit: a missing value, a value
  that is not a number (a numeric string such as `"12"` is not one), an x that is not a number on a scatter plot, an
  area chart's x that mixes numbers and text or whose numbers do not rise row by row, or a negative value in a stacked
  area. Up to five problems are named, then `and N more problem(s) in the same rows`. No instance is left behind.
- **The points are bounded.** A chart draws the first 500 rows. Only those rows are checked, and the chart, its text
  and its semantic document say how many of how many it draws.
- **What a person changes is a view the node keeps.** Hiding a series and selecting a point are the chart's view,
  `{ hiddenSeries, selected? }`, sent through the chart's own `chart.view` binding, which reads and changes nothing
  else. The node checks each view against the chart and against the rows it holds now: at least one series stays
  shown, a selected point is on a shown series, and its index is one of the points drawn. A view that does not fit is
  refused with `the chart view was refused: …`, and the state is left as it was. A view replaces the last one whole.
- **The text alternative is the chart's own words.** It names the series, the x span, the number of points and each
  series' range. A scatter plot also names what each axis measures, from the field's label (or its name) and unit,
  for example `(x axis: Load (%); y axis: Latency (ms))`. An area chart's text reads, for example `Runs by week: Area chart of Runs, Failures by week, 5 point(s); W36 to W40. Runs: 128 to
  164 runs; Failures: 3 to 9 runs.`
- **Voice and `inspect_ui` read the chart as it is now.** The semantic document (§9) gives the series shown and
  hidden, whether the area is stacked, the number of points and any truncation, each shown series' range, the x range
  and the selected point, with the point in `selectedIds` as `field#index`. A scatter plot adds `xAxis` and `yAxis`,
  the same axis titles the page draws. It is built from the state and the rows the
  node holds now. A selected point that is no longer in the rows is said to be gone rather than described, and a
  dataset that is gone is said to be not available. Its freshness is the dataset's own.

What the page does:

- Each series has its own tone, line pattern and point shape, shown together in the legend, so a colour is never the
  only signal. The legend is a row of buttons with `aria-pressed`; a hidden series says "(hidden)" in words. The last
  shown series cannot be hidden, and the chart says why.
- Every point is a button with a name that says its series, x and value, and its name when `pointLabel` gives one.
  One point is in the tab order. The arrow keys move along x, in the order of x for a scatter plot, and up and down
  change series; Home and End go to the first and last point; Enter or Space selects, and Escape clears. The selected
  point is described beside the chart in a live region, with a button that clears it.
- A change is drawn at once and sent to the node, one request at a time per chart; a change made meanwhile is sent
  after it, and only the latest one. When the node refuses a view, the chart says so in the person's language, draws the view
  the node holds, and reads the dataset again, since the rows the node checked against may not be the ones the page
  was given.
- A scatter plot titles its axes: the y axis above the plot and the x axis under it, each with its label and unit.
- A table of the rows drawn, with the chart's names for its fields, is under the chart. A field is read only from the
  row itself, so a field named `constructor` or `toString` is plotted and named like any other.
- Everything the chart says is in the person's language. Rows that no longer fit are described from the row, field
  and value the shared checks found, not from the node's English sentence, and a refused view is said as a sentence
  of the page's own. The node's English reasons are for the model and the logs.
- The axes never do unbounded work. Ticks are counted before they are made, at most 50, and each is its index times a
  round step. Values so close that no round step separates them, such as `0.3` and `0.1 + 0.2`, are drawn as one
  value with room either side. Labels past a billion or finer than a millionth are written with an exponent and as
  many significant digits as the step needs, so a `1e-12` scale is not labelled `0` throughout.
- Above 60 points an area chart draws only the point that has focus and the one selected, so the line stays readable;
  every point can still be reached with the keyboard.
- The chart adds no motion of its own, fits its width down to 390 px, and follows the light and dark themes. In the
  Widget Library the fixtures are usable without a node: the view is held on the page.

Tests: [xy-charts.spec.ts](../packages/contracts/test/xy-charts.spec.ts) for the rules,
[xy-charts.spec.ts](../apps/runtime/test/xy-charts.spec.ts) for the node,
[chart-layout.spec.ts](../packages/conversation-client/test/chart-layout.spec.ts) for the scales (including values one
float apart, `1e17` next to `1e17 + 16`, a single point, all-equal values and a `1e-12` scale), point shapes and
keyboard order, [xy-chart-schemas.spec.ts](../packages/widget-catalog/test/xy-chart-schemas.spec.ts), which checks that
the JSON Schema and the chart's own checks accept and refuse the same props and that every library fixture is one the
node would place, and the browser journey [xy-charts.spec.ts](../apps/web/e2e/xy-charts.spec.ts). It covers the legend,
keyboard selection, the view kept after a reload, a stacked area, 640 rows drawn as 500 with the label that says so,
the scatter plot's axis titles, refusals for a missing field and a value that is not a number, the refusal of a point
the node no longer holds said in Vietnamese, reduced
motion, 390 px with touch in the light theme, and the library.

---

## 9. Semantic contract for voice and the next turn

What a widget shows now reaches Clark in two ways, both built from one document per widget:

- **Voice** reads the focused widget's summary, selection and values before it decides what a sentence means.
- **The next typed or spoken turn** ends with a short note about the widgets the person changed in this conversation.
  A person picking, searching or saving on a widget starts no turn and writes no message: the node only records that
  the widget was touched, and works out what the change meant when the next turn starts.

The document holds a summary, a few named values (a period, a chosen series, a query, a page), the selected IDs and the
actions the widget offers. It is canonical and bounded: at most 16 values, lists of 12 short entries, 20 selected IDs,
12 actions and 4 KB in all. Control and direction-changing characters are removed and anything secret-shaped is
redacted. Its revision moves only when the document changes, so saving the same value, a view-only save or ten edits
between two turns count as one change or none.

The note is appended after everything else in the new turn and never rewrites earlier context, so a provider's cached
prefix is unchanged. A session that has not seen a widget is told the whole document; a continuing session is told only
what moved (`query: "" → "acme"`); a session that has seen the current revision is told nothing. The note names at most
three widgets in about 2,400 characters and says when it left something out. The model can read the rest, for this
conversation only, with the read-only `inspect_ui` tool. The note is marked as data from the screen, never
instructions.

Who writes the document:

- **Built-in and composed surfaces** are described by the host from the state it stores: period, selected day and the
  declared graph values.
- **A widget in its own frame** proposes a summary, selected IDs and values with
  `semantic.publish(summary, selectedIds, values?)`. The host sends the last of a burst after 250 ms, validates it
  against a strict schema (`POST …/widgets/{instanceId}/semantic`), cleans it and marks it as the widget's own words. A
  frame cannot name actions: the actions always come from the instance's bindings, so a frame cannot advertise an
  action it was not bound to.

Voice and click must call the same action binding/state path.

Do not publish raw DOM, hidden text, the full dataset or secrets just so voice can “understand the screen”.

Example, from a frame:

    semantic.publish(
      "Calendar for September 2026; September 20 selected.",
      ["2026-09-20"],
      { view: "month", month: "2026-09" }
    )

Tests: [widget-semantic.spec.ts](../packages/contracts/test/widget-semantic.spec.ts) for the document and the note,
[widget-semantic.spec.ts](../apps/runtime/test/widget-semantic.spec.ts) for the prompt, the routes and `inspect_ui`, and
the browser journey [widget-semantic.spec.ts](../apps/web/e2e/widget-semantic.spec.ts).

---

## 10. Widget SDK surface

Author-facing target:

    props.read()
    props.subscribe()

    state.get()
    state.update(expectedRevision, patch)

    events.emit(name, payload)

    actions.invoke(bindingId, input, invocationId)
    actions.availability()
    actions.subscribe(handler)

    capabilities.request(ref, justification)

    host.focus()
    host.resize({ height })
    host.requestPin()
    host.requestDetach()
    host.openExternal(approvedUrl)

    semantic.publish(summary, selectedIds, values?)

    lifecycle.onMount()
    lifecycle.onSuspend()
    lifecycle.onResume()
    lifecycle.onDispose()

The shipped types are `WidgetAuthorApi` in `packages/widget-sdk/src/index.ts`. What the host does with them:

- `actions.invoke` resolves with the service's text output when the binding calls a package service
  (see [§4](#4-package-manifest)), and with `undefined` otherwise. It rejects with the host's reason, including when
  the action waits on an approval card. Each call is answered by its own `invocationId`, so two calls of one binding
  settle independently. When the reason says the request reached the service, the service may have done part of it.
- `actions.availability()` returns what the host last said about each service-backed binding: `available`, and the
  reason when it is not. `actions.subscribe(handler)` is called when that changes. The host sends it only for
  service-backed bindings, and only when the answer changed. Disable that control and show the reason; the rest of the
  widget keeps working.
- `host.resize({ height })` is honoured: the host sizes the frame to the request, clamped to 80–1200 px. A frame opens
  at 200 px until the widget asks.
- Messages the host sends before the SDK runtime has loaded are buffered and replayed in order, so an early
  availability message is not lost.

Do not expose:

- readAllSecrets;
- shell;
- generic IPC;
- queryCoreDb;
- disableCSP;
- approve;
- grant;
- installAnything;
- registerSidebar;
- arbitrary host window access.

---

## 11. Pin / detach lifecycle

Pin and detach point to the **same logical instance**.

An instance has only one live effect owner.

The remaining surfaces are:

- a historical inline snapshot; or
- a read-only preview.

Detach does not reset state/subscriptions/media.

Closing a detached window only moves presentation ownership; it does not delete the instance.

Audio/call/player must not duplicate playback when moving between surfaces.

---

## 12. Motion

Widgets use host design tokens instead of creating a conflicting motion language of their own.

Rules:

- press feedback under 100 ms;
- transition targeted properties, not transition: all;
- mild bounce only on settle/end-state;
- prefers-reduced-motion must have a static equivalent;
- no infinite decorative animation offscreen;
- hover is not the only way to see an action;
- a widget must not make the Orb/global chrome change effects unless the user has granted a theme/personalization scope.

Executable widgets must not inject global CSS.

---

## 13. Accessibility

Release gate:

- semantic HTML;
- keyboard-only path;
- visible focus;
- 40–44 px targets for primary touch actions;
- state not conveyed by color alone;
- text alternative for rich visuals;
- bounded aria-live, no token-stream spam;
- focus restore when a sub-surface closes;
- chart/table selection usable without a pointer;
- reduced motion;
- contrast per host tokens.

---

## 14. Data & network

Large datasets go through opaque refs.

Do not put:

- file:// paths;
- DB queries;
- bearer tokens;
- host cookies;
- long-lived secrets

into props/state/history.

An executable widget only connects to origins in the installed manifest/CSP.

Each entry in `permissions.networkOrigins` must be exactly one origin in canonical form,
`scheme://host[:port]`: `https` or `wss`, with `http`/`ws` allowed only for `localhost`,
`127.0.0.1` and `[::1]`. Wildcards, paths, queries, credentials, whitespace, `;` or `,`, and
non-canonical forms (`https://API.example.com`, `https://example.com:443`) are refused when the
manifest is read, because the value becomes the widget document's `connect-src` verbatim. An
empty list means `connect-src 'none'`.

The widget document is served with `sandbox allow-scripts` in its CSP as well as on the frame,
so it stays on an opaque origin even when opened directly. Only the node that serves it may frame
it (`frame-ancestors 'self'`), plus the interface's origin when that is somewhere else:
`CC_APP_ORIGIN` names it (for example `http://127.0.0.1:5173` for `pnpm dev:web`; local setup
writes this). The node checks `CC_APP_ORIGIN` at startup and refuses to start when it is not a
bare `http(s)` origin. The request's `Host` header is never used.

If an auth SDK needs a browser token, the host broker issues a short-lived/scoped token if the provider actually supports it; the token is not persisted in widget state.

---

## 15. State & migration

State has:

- stateVersion;
- optimistic revision;
- deterministic migration.

The durable state of an isolated widget lives in the node's SQLite, not in the frame. The widget writes with
`state.update(expectedStateRevision, patch)`; the host drops `ephemeralStateKeys`, checks `stateSchema` and size,
checks the optimistic revision, and only reports success once the node has committed. A conflict returns `STALE` and the widget keeps its draft.
The state revision is different from the instance revision; do not mix them up.

An upgrade must not silently drop a draft.

Migration is declarative and run by the host: when opening an instance whose `stateVersion` is older than the definition, the host runs the
`stateMigrations` steps in one transaction and then checks the result against `stateSchema`. Widget code never
touches state that has not been checked. There is no downward migration: state newer than the definition (after rolling back to a previous version)
opens in read-only mode with a reason.

If a migration fails:

- keep the snapshot;
- disable mutation;
- offer a recovery choice.

Uninstalling a presentation facet does not automatically delete the user's domain data. Removing a package only deactivates the running
generation: instances go offline with a text fallback, and state and snapshots are kept. That reaches every widget the manifest
declares, including one whose definition this node could not load, and one whose package files are no longer on this node: the ids
come from the manifest's `ui` facets and from the list the node recorded when the package was installed. **Restore** reactivates exactly the
generation that was just removed; **Roll back** activates the most recently replaced generation. All three go through the same action from
Settings, chat and voice.

---

## 16. Developer CLI target

    clark widget init
    clark widget dev
    clark widget test
    clark widget pack
    clark widget publish

### init

Templates:

- blank;
- dashboard;
- form;
- editor;
- media;
- MCP App adapter.

### dev

A local isolated host with:

- hot reload;
- fixtures;
- viewport switcher;
- dark/light/system;
- reduced-motion;
- online/offline;
- read-only/live;
- semantic inspector;
- action log;
- capability simulator;
- accessibility checks.

`clark widget dev [dir] [--port N] [--builtin <id>]`: without `[dir]` it uses the current directory, and
`--builtin <id>` views a catalog widget in the **same** host instead of a package on disk — details in 23.5.

### test

Runs the conformance suite.

### pack

Validates the manifest, builds an immutable artifact, generates digest + metadata.

### publish

Publishes the package source/artifact and then submits directory metadata. The directory is not the only place a package can run: a local/git source is still a first-class development path.

Before writing the entry, publish compares the definitions with the previous preparation (`dist/published-definitions.json`) and
refuses a version that violates the rules in §20. This file is the comparison baseline, so it should be committed with the source; if
`dist/directory-entry.json` exists but this file is missing (fresh clone, cleaned `dist`), publish warns that the version has not been checked.

---

## 17. Conformance suite

A widget is not publish-ready if any of the following tests are missing:

### Schema

- malformed props reject;
- additional props reject when the schema forbids them;
- state version valid;
- unknown event/action reject.

### Security

- forged nonce/source reject;
- secret unavailable;
- generic host API unavailable;
- undeclared network blocked;
- untrusted host-owned card impossible.

### Lifecycle

- mount;
- suspend/resume;
- dispose cleanup;
- reopen;
- update;
- state migration.

### Interaction

- keyboard;
- touch-size;
- double-click dedup;
- stale revision refused;
- voice/click parity;
- pin/unpin;
- detach/attach if supported.

### Rendering

- narrow;
- compact;
- expanded;
- loading;
- empty;
- error;
- cached;
- read-only;
- reduced motion;
- text fallback.

---

## 18. Directory metadata

A directory entry needs:

- package id;
- current version;
- display name;
- one-line description;
- author/publisher;
- source repo;
- license;
- preview image/video;
- widget/facet types;
- supported platforms;

`platforms` values come from **one** vocabulary shared by both packages and hosts: `darwin-arm64`, `darwin-x64`,
`linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`, `web`. Names follow the `<node platform>-<arch>` form, so Windows
is `win32-*`, not `windows-*`. A host declares itself with `platformForHost(process.platform, process.arch)`; for a host
the vocabulary cannot describe, the function returns `undefined`, and the refusal names the platform of **both** sides — instead
of guessing `web` and handing a native package to something that cannot run it.
- host API compatibility;
- requested permissions summary;
- risk tier;
- package size;
- release date;
- changelog link.

Signals such as downloads/reviews may be added later; do not use popularity in place of security/trust facts.

The Pi package catalog is a good reference for discovery: packages have manifest resources and a preview image/video, are shared via npm/git and indexed in the catalog. ClarkCant should keep those ergonomics, but executable widgets default to isolation instead of full-process trust.

---

## 19. Publish flow

Developer:

    clark widget test
      ↓
    clark widget pack
      ↓
    artifact + digest
      ↓
    publish npm/git/release
      ↓
    clark widget publish
      ↓
    directory validation
      ↓
    searchable

Directory validation does not claim “safe”. It verifies:

- manifest;
- schema;
- artifact digest;
- preview metadata;
- conformance report;
- source/license;
- declared permissions;
- compatibility.

---

## 20. Versioning

Definition breaking change → new definition major/id version.

A package patch/minor must not change the semantic meaning of a persisted action binding.

Action target/account/tool generation change → new binding.

Old snapshots must keep rendering fallback/text even when the current package has changed.

`clark widget publish` applies the following rules, compared against the definitions of the previous preparation, and refuses with the name of each
violation:

- `stateSchema` changed ⇒ `stateVersion` must increase and there must be a migration step from every released `stateVersion` upward.
  The comparison is by content; key order does not count;
- `stateVersion` never decreases;
- a released migration step is history: do not edit it, do not delete it, only add — a node may already have migrated with it;
- changing `ephemeralStateKeys`, changing `effectCategories` or requesting additional `requestedCapabilities` ⇒ bump the definition's
  major (or a new id). Dropping a capability does not require this;
- a definition disappearing from the package ⇒ bump the package major, because existing instances refer to it by name.

---

## 21. Review checklist

Before merge/publish:

1. Does the widget really need executable code, or is a composition enough?
2. Is there a loading/empty/error/read-only fixture?
3. Is it usable by keyboard?
4. Is it usable with reduced motion?
5. Is the text fallback useful?
6. Is the semantic view enough for voice without dumping data?
7. Are local and effect actions clearly separated?
8. Do actions have a dedup/revision guard?
9. Does pin/detach keep one live owner?
10. Do secrets/paths stay out of props/state/logs?
11. Are network origins bounded?
12. Is the state migration tested?
13. Does it hold up at 320 px?
14. Does uninstall/update avoid losing user data?
15. Does the package detail tell the truth about the risk/trust lane?

If question 1 shows a composition is enough, prefer the composition.

---

## 22. Source of truth

- Runtime contract: packages/contracts/src/widgets.ts.
- Bridge/author API: packages/widget-sdk.
- Host registry/isolation: packages/widget-host.
- Built-in descriptors: packs/data-canvas and future catalog packs.
- Built-in React renderers: packages/conversation-client.
- Product UX: DESIGN.md.
- This standard defines the target developer experience/release gate; implementation status must be recorded truthfully in code/conformance.

---

## 19. Implementation status

This section states which parts of the document already have code, so that nobody reads §16–§17 as if everything already runs.

**Implemented and tested:**

- `clark widget init` — scaffolds `blank`, `form`, `dashboard` following the layout in §3, and the package it creates must
  pass its own conformance suite (a template that fails on its first run teaches the wrong thing).
- `clark widget test` — the conformance suite in §17. Checks that can run in Node run for real: schema, bridge
  security (forged nonce, wrong source window, a message not in the codec), lifecycle, dedup, stale revision,
  pin, state migration, text fallback, effect action. Checks that need a rendered frame (keyboard, touch size,
  narrow/compact/expanded, reduced motion, voice/click parity) are reported as `requires-dev-host` — they are **not**
  reported as passing just because a fixture exists.
- `clark widget pack` — validates the manifest, computes the digest over identity + content, and refuses to re-pack a
  version that was already packed with a different digest (a version whose bytes changed is a different package carrying the same number).
- `clark widget dev` — the dev host in §16: hot reload via SSE, fixtures, viewport switcher (320px is a real
  option), dark/light/system, reduced motion, offline, read-only, semantic inspector, action log, capability
  simulator, and accessibility audit. The frame uses the host's actual sandbox (`allow-scripts`, no
  `allow-same-origin`), and the server refuses any path outside the package.
- Durable state for isolated widgets, declarative host-run migrations, and `ephemeralStateKeys` (§15).
- Remove / restore / roll back a package from Settings and via `manage_package` in the conversation; data is kept.
- Pending capability questions are answered in Settings (host-owned; the model cannot approve them). The frame only
  receives capabilities that are granted **and** ready; the rest are stated with a reason.

**Not yet implemented:**

- `clark widget publish` — **implemented, at the "prepare" level**, and applies the version rules in §20: it validates, packs, then writes `dist/directory-entry.json`
  with every field §18 requires and the digest of the packed artifact (read from `dist/artifact.json`, not recomputed —
  computing the same thing twice is how a listing ends up referring to an artifact nobody can produce). It does **not** submit on the
  user's behalf: submitting needs a directory account, and a command that looks like it has already submitted is a control whose action does not exist.
  The local/git/npm path is still first-class, so no account is needed to run your own widget.
- **Directory search** — implemented at the level of reading an index: `CC_DIRECTORY_INDEX` points to a JSON file of entries per
  §18, and `search_directory` returns a `marketplace-results` card showing **source, version, digest and risk lane**,
  along with the name of the directory the results came from. An unconfigured index is a *state* that is stated, distinct from "nothing
  found". The card **has no install button**: installation goes through the one install path where the digest is checked and consent
  is recorded; a button here would be a second entry point for installing, and the only place a listing could turn into
  authorization. There is no remote registry — search only reads what exists on the machine or at a URL the user specifies.
- The dev host's in-page script: it collects facts and forwards actions, while every decision lives in a tested function —
  but the script itself needs a browser to run, and that is stated instead of implying that the whole dev host is covered.
- Detach/attach: the desktop's detached host window **really exists** (`apps/desktop/src/main.mjs` opens it via
  `detachedWindowOptions`, `apps/web/src/App.tsx` serves `?detached=1`), and it is covered by
  `apps/desktop/test/detached-window.spec.ts` together with `apps/web/e2e/detach.spec.ts` — **not** by the
  conformance suite's `detach` check: the harness only runs on the in-browser dev host, and the dev host has no
  detached window to drive. The ownership half (`detached` on the live-owner claim) is implemented.
- Runtime for MCP Apps: the isolated-app path is implemented; MCP Apps have not yet been proven on that same path.

---

## 23. Widget Library and Widget Lab

This section describes two surfaces that already have code: the library for **viewing** the catalog, and the Lab for **developing** widgets. Both
share one surface and differ by mode.

### 23.1 One canonical catalog

`packages/widget-catalog` is the only discovery layer: `CATALOG_DEFINITIONS` = `WIDGETS` from `packs/data-canvas`
plus `NOTE`. Note is **not** in `WIDGETS` because that list is the view vocabulary the model is allowed to call
(`apps/runtime/src/services.ts`), so adding to it is a change to the model surface, not a metadata refactor.
Note is exported from the pack's barrel, **not** from `sample.ts`: `sample.ts` imports `@clarkcant/core`, and going through
it would pull `packages/storage` (`node:sqlite`, `node:crypto`) into the browser bundle — exactly what the invariant
`browser-entries-avoid-node-builtins` catches.

Display metadata (name, description, family, tags) lives in `widget-catalog`, and tests assert that no entry falls
back to a raw id, and that no metadata entry points to a definition that does not exist.

### 23.2 Fixture contract

`widgetFixtureSchema` in `packages/contracts/src/widgets.ts` is the shared contract: a `strictObject` with
`{id, label, props, state?, dataset?, mode?}`. Strict means a fixture carrying an unknown extra key — for example an effect
binding — fails instead of being rendered as if it were harmless. That is how "a fixture is data, not code" becomes
something that can be checked.

Two different artifacts, not two copies of one thing:

- **a catalog fixture** — `WidgetFixture`, with `dataset` and `mode`, provided by `widget-catalog`;
- **a package's `fixtures/*.json`** — bare props; `readPackage` reads them and `conformance.ts` checks them against
  that widget's own props schema.

A package fixture can carry extra data: a `fixtures/<name>.dataset.json` file alongside
`fixtures/<name>.json`. The node reads this pair as **one** `WidgetFixture` — props from the first file, `dataset` from
the second — and validates the dataset with the same `fixtureDatasetSchema` the catalog uses. A dataset that fails the schema is
named in `problems` and is **not** attached to the fixture, rather than being rendered as if it were valid.

Why a separate file instead of putting the dataset in props: the renderer reads the dataset from the **fixture**, not from props
(`WidgetPreview.tsx`), so a widget with data would forever draw the "no data yet" path if the dataset only lived in
props.

### 23.3 Preview with the real renderer

The preview calls `resolveRenderer` in `packages/conversation-client/src/renderers.tsx` — the same renderer the
conversation uses. There is no second renderer, no screenshot, no mock: a preview made of images would say nothing
about the running widget. A definition without a renderer shows `data-widget-preview-missing` with a reason, rather than staying
silent.

Media widgets (`canvas.youtube@1`, `video`, `image`, `carousel`, `gallery`) only mount in the detail view; in the grid
they only have a text alternative. As a result, browsing the catalog does not call third parties.

### 23.4 Widget Lab

The Lab is the **same surface** in `mode="develop"`, opened from Settings → Developer. It adds:

- a props form built from the props schema, so the controls reflect the schema exactly rather than a hand-written list;
- an 8-panel inspector, exactly as in `inspectorPanels` in `widget-lab.ts`: props, state, events, actions,
  semantic, sizing, capabilities, fallback. The names in this document are panel **ids**, not display labels
  (`Props`, `State`, …), so readers can match them against the code;
- fixture, viewport, theme and reduced motion apply within the **preview scope** (`data-cc-theme`,
  `data-cc-reduced-motion` on the frame), so viewing a widget in dark mode does not change the user's preferences;
- on a narrow screen the panes advance (preview ↔ inspector) instead of showing two columns.

### 23.5 Convergence with the dev host

`clark widget dev` and the Lab share the same **preview semantics**: the theme vocabulary (`PREVIEW_THEMES`) and the three transition rules for
`fixture`/`theme`/`reduced-motion` (the dev shell delegates to `applyPreviewAction`). The test
`packages/widget-cli/test/dev-shell-convergence.spec.ts` compares the two implementations directly, so divergence fails
there rather than waiting for someone to open two windows and compare by eye.

A deliberate difference: the dev host uses its own set of viewports (up to 1024px) because it views a standalone package, while the Lab views at
conversation width.

`clark widget dev --builtin <definitionId>` runs the **same** shell for a catalog widget: the same sandbox frame,
the same state machine, the same controls. The only difference is the source — no package on disk is read, and the frame is
served by Vite from `packages/widget-cli/src/catalog-runtime.tsx`, an entry that mounts `WidgetPreview`, i.e. the **very same**
`resolveRenderer` the conversation and the library use. As a result the preview cannot drift from what the user will see, and
there is no build step to forget and no artifact to commit. An id the catalog does not have is refused
**at startup and by name**, not in the browser. The frame is generated per request, so it carries
exactly the fixture the shell is showing: changing the fixture control changes what is drawn, not just what the shell says.

A known difference: this mode does **not** reload automatically when the source changes. Package mode watches the package directory and
reports via `/dev/events`; the catalog frame is not yet wired into that mechanism, so it has to be **refreshed manually**.

Because that entry is browser code emitted by a Node CLI, it is in the entry list of the invariant
`browser-entries-avoid-node-builtins` (115 modules, 3 entries), and `tsconfig.web.json` covers
`packages/widget-cli/src/**/*.tsx`. That config line is required: the Node config only includes `**/*.ts` and does not set
`jsx`, so without it the file is **silently** typechecked nowhere.

### 23.6 Provenance of installed packages

The library lists installed packages as **provenance**, in a separate list: `packageId@version`, source tier,
digest (shortened, the full one in `title`) and trust lane; the lane wording lives in one place in
`packages/conversation-client/src/package-provenance.ts` so that a native Pi extension and an isolated widget never
read the same. Three states are kept apart: reading, unreadable (with a retry button), and nothing installed yet. Widgets that a
package declares are real cards, in section 23.8.

### 23.7 Entry points

The button in Settings, a typed command and voice all go through **one** app-intent path: `widgets.open` (opens the library) and
`widgets.show` (shows one widget, with a target). The matcher only accepts a target when the sentence is in imperative form, and a sentence mentioning
a widget whose target cannot be resolved opens the library instead of guessing — this is a view-only action, it never guesses
an effect.

### 23.8 Package-declared widgets

A package can declare widgets, and such a widget becomes a real card in the library. The read path:

1. the client calls `GET /packages/widgets` **when the library is opened**, not on mount — a library nobody opens
   asks the node nothing;
2. the node looks up the package in the directory index (`CC_DIRECTORY_INDEX`) and reads the definitions from disk
   (`installedWidgets` in `packages/core/src/installed-widgets.ts`);
3. a card is only created if the **client** has a renderer for that definition id (`resolveRenderer`). The gate is on the client because
   the renderer is on the client; a second opinion on the node would drift from this one.

**Card ids are namespaced.** Every definition id the current renderers can draw is already a catalog entry, so a
package that used the definition id itself as the card identity would never be shown: the catalog entry wins that id
every time. So the card id is `<packageId>/<definitionId>` — a fact about origin, not a nicer
name. Drawing still resolves from `definition.id`, so there is still exactly **one** renderer per id, and the catalog card for
the same definition still appears next to it (labelled `Built-in` versus `Local development package`).

**The limitation, and it is stated.** Only packages that are **local** and **in the directory index** can be read: a generation
in the DB carries no path, and the artifact of a git/npm source is not on this machine. Other sources get
`NOT_LOCAL`/`NOT_IN_DIRECTORY` and are **named** in the section "Installed packages: not shown" — a shorter
list would say "this package declares no widgets" when the truth is that the node could not read it.

The identity of a local package is the **identity of its directory entry**, not its path. An install from disk
used to record `packageId` as that path itself, but a path is where the bytes live, not the package's name — so
the same package had two names: the listing said `com.example.chart-widget` while the installed row said
`apps/web/e2e/fixtures/chart-widget`. The local branch of `resolvePackageSource` now takes the name from the entry that matches **by
path** in the directory index. A path that is **not** listed can still be installed as before and keeps the path
as its name, because it has no better name. `digest` is still the hash of the bytes on disk as computed by the caller, **not**
the published digest: the two describe two different things.

`package_generations` rows that **already** recorded a path are still in the DB, so the `/packages/widgets` route still
keeps the fallback that looks up the entry by `source.path`. If it were removed, those old rows would report `NOT_IN_DIRECTORY` forever.

**git/npm sources are now actually fetched, not just trusted by listing digest.** `packages/core/src/package-fetch.ts` is
where that happens: `fetchGitArtifact` shallow-clones exactly one pinned commit (`git fetch --depth 1 -- <url> <sha40>`,
refusing any ref that is not a full commit id) into a cache directory owned by the node; `fetchNpmArtifact` reads the packument,
downloads the tarball for exactly that version, checks `dist.integrity`/`dist.shasum` against the downloaded bytes themselves, then extracts it. The digest recorded
in the plan is `digestOfDirectory` computed over the fetched bytes — not the digest the publisher declared — and a mismatch
is refused (`DIGEST_MISMATCH`) before the plan is proposed. `installPackage`
(`apps/runtime/src/application/package-install.ts`) calls this fetch and then changes the entry's `source` to `local` pointing
at the cache directory, so the rest of the install (plan, consent, generation) is **exactly one** path — there is no
second installer for remote packages.

The directory index is treated as **untrusted input**: `url`, `ref`, `name`, `version` in a git/npm entry can
come from any source that serves that index, so `fetchGitArtifact` blocks each layer before spawning `git`. A url that starts
with `-` is refused immediately (against argument injection such as `--upload-pack=...`); the scheme must be `https://`, or
a bare path/`file://` when the caller explicitly enables `allowLocalPaths` (tests only, or a future "install from local path" flow
— the production install route does not enable this flag unless the environment variable `CC_ALLOW_LOCAL_GIT_SOURCES=1` is
set, which only the test harness does). Every `git` command runs with `--` before the url/ref, `-c protocol.allow=never` plus an explicit
allow for exactly the scheme in use, `core.hooksPath=/dev/null`, LFS smudge disabled, and a timeout (switched from
`spawnSync` to asynchronous `spawn` so a hanging remote no longer blocks the node's entire event loop).

The cache is content-addressed: the cache path of a git source is a pure function of `url`+`ref`
(`cachedGitPath`), and of an npm source a pure function of `name`+`version` (`cachedNpmPath`) — no mapping table needs
to be stored separately. This solves two things at once: refetching the same `url`+`ref` is a cache hit (no refetch,
never an `rmSync` of an artifact that may be live), and any other place holding the same entry — the file-serving route,
`findIsolatedFrame` — recomputes exactly that path to serve a fetched git/npm package the same way as a local package
(`resolveLocalSource`).

`digestOfDirectory` uses `lstatSync`, not `statSync`: a symlink or hard link in the artifact is refused
by name (`ARTIFACT_SYMLINK_ESCAPE`) rather than being followed or silently skipped, and the function never throws
`ELOOP` outward — because `lstatSync` does not follow the last component of the path, a symlink pointing at itself does not
cause a loop during traversal. `.git` is only excluded at the root of the artifact, not everywhere in the tree, so a valid
package with a nested `.git` directory (a vendored checkout) is still hashed in full. Each file's relative path is
hashed and sorted with `/` separators on every OS, so a package has one digest on Windows, macOS and Linux: a digest a
directory published from a POSIX machine still matches when the package is installed on Windows.

`fetchNpmArtifact` no longer shells out to `tar`: it reads the ustar format (gzip + tar) itself and checks the typeflag of each entry
before writing any byte to disk — only regular files and directories are accepted; symlinks, hard links, devices, or
an entry name containing `..`/an absolute path are all refused by name (`NPM_TARBALL_UNSAFE_ENTRY`). The tarball has a
size cap (`content-length` is rejected before download if it exceeds the cap, and the bytes actually downloaded are checked again),
`gunzipSync` has `maxOutputLength` to block gzip bombs, and every fetch (packument and tarball) has a timeout via
`AbortSignal.timeout`.

**`grantedCapabilities` is now derived, no longer always empty — and it is derived from the fetched manifest, not
from the request body.** `deriveGrantedCapabilities` (`packages/core/src/install-consent.ts`) asks exactly the
same execution policy that guards every other effect on the node, per capability, at the risk category set by the package's strongest
lane (`declarative`/`isolated-ui` → `local-write`, `service`/`trusted-native` → `destructive`). What
counts as "requested" is `manifest.requestedCapabilities` read from the very artifact that was just fetched and digest-verified
(`readPackage(resolvedEntry.source.path)`), **not** the `requestedCapabilityRefs` field in the HTTP request
body — a client sending a request can write anything into its own body, so trusting it as authority would turn a
forged body into the very set of capabilities that gets granted. The risk tier used for the decision is also computed from the entry's facet
isolations (`riskLaneFor(entry.isolations)`), combined with the `entry.riskTier` the directory declares itself — on the
principle that a claim can only **raise** the computed tier, never lower it.

There is no separate dialog: a capability the policy would ask about goes through the existing approval path (`requestApproval`,
with exactly the risk category decided by `deriveGrantedCapabilities`) and is returned in the install response
under `pendingCapabilities` (with an `approvalId` for the follow-up action); a capability the policy refuses is returned in
`deniedCapabilities`. No capability in either group automatically becomes granted. The granted set is recorded in
`PackageGeneration.grantedCapabilities`, and the widget frame is brokered exactly the **intersection of requested and granted**
(`brokeredCapabilities`, `widget-frame.ts`) — it no longer passes the manifest's `requestedCapabilities` straight to the frame
as before.

A generation activated before `grantedCapabilities` existed on the schema has no such key in its
stored document. Migration 22 (`packages/storage/src/migrate.ts`, `backfill_generation_granted_capabilities`)
backfills each such row with the `requestedCapabilityRefs` of the very install plan it was resolved through — the most
honest way to answer "what was this generation actually consented for" under the old semantics, instead of re-running today's
policy on yesterday's install. A generation that no longer has a matching plan (superseded and cleaned up, or never
had one) is backfilled to `[]` rather than guessed — an empty grant that under-serves is better than one that over-grants.

**A package that is only *listed* in the directory, never installed, has no files to serve.**
`GET /packages/:packageId/:version/files/*` (`apps/runtime/src/routes/packages.ts`) requires a generation that is
active on this very node, matching both `version` and `digest` with the directory entry being served, before reading any
byte — it no longer treats "is in the directory index" as enough to serve, as it did before. An entry that is listed but has never
gone through `POST /packages/install` (or was installed and then superseded by a different digest) returns `409 NOT_INSTALLED`
instead of serving bytes from a source for which the node never finished verifying an install. This is a product decision that is
kept as is, not a defect to fix: a package that is "known by name" but not installed should not look like
a package that is ready to use. No real dev flow depends on the old behavior ("listed is enough") — `widget-cli dev`
uses its own dev host and does not go through this route. An old dev DB that sees its generation disappear from this
route after upgrading should re-run `POST /packages/install` for that package, or `node
tools/check-invariants.mjs --fix-manifest` if it only needs to resync `docs/manifest.json` after editing this file.

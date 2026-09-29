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
surface affect one another (§8.3), and the read-only cards that do nothing at all (§8.4). The first three rest on one
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
| `agent` | Starts a turn in the same conversation whose message is exactly the label; the `intent` goes to the model beside it. The reply is the press's outcome. | Starting a turn changes nothing by itself; what the turn then does passes the policy on its own. |
| `invoke` | Calls a package service capability through `invokeCapability`, the same path as the agent's `invoke_capability` tool and voice. | The capability's own effect category and the package generation serving it now; the arguments are checked against its input schema. |
| `workflow` | Nothing yet: this node cannot run a workflow, so the button is drawn disabled with that reason. | The most severe category among its steps. |

The binding digest covers the proposal, the package generation, the effect category and the label. A package update
makes the binding stale (`BINDING_STALE`) instead of retargeting it. Whether a press needs approval is the execution
policy's decision at the press, not a flag frozen at compile time.

Every surface reads availability from one function (`bindingAvailability` in
`apps/runtime/src/application/action-bindings.ts`), and the timeline carries it beside the instance. A service that
stopped, a capability that is not a service, a stale binding or a workflow is a disabled button with the reason in
words, not a live one that fails. The press is still checked again when it arrives. A press shows pending, then the
outcome in a `role="status"` line. The outcome is the service's output, the agent's reply, "pinned", "waiting for your
approval", or the refusal reason. A second press while the first is pending sends nothing. An agent press while Clark is
still answering is refused with `TURN_IN_PROGRESS` rather than interrupting.

`canvas.cta@1` is kept so history renders. A model can no longer place it, because it had no action behind it.

Tests: `apps/runtime/test/action-widget.spec.ts`, `packages/conversation-client/test/action-button.spec.ts`, and the
browser journey `apps/web/e2e/action-widget.spec.ts`, which runs each kind against a real notes service in a container.

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

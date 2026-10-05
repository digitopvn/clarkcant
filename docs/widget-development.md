# ClarkCant Widget Developer Standard

> English (default) · [Tiếng Việt](widget-development.vi.md)

Public websites can reuse the [public document widget host](public-widget-host.md)
without granting runtime capabilities.

> Status: canonical authoring target for the widget ecosystem.
> Updated: 2026-10-01.
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
`modal`). A document that declares `appearanceApi.min` 2 (`{ "min": 2, "max": 2 }`) may also set the rest of the
look, each by a name or a bounded number the host turns into CSS itself: `typography` (`body` and `display` from
`clark`, `system`, `serif`, `rounded`, `mono`; `mono` from `clark`, `typewriter`; `headingWeight` 400–800 in hundreds), `border`
(`width` 1–3, `style` `solid` or `dashed`), `shadow` (`style` `soft`, `hard` or `none`; a hard shadow's `offset` 1–8 and
`color` `text`, `border` or `accent`), `motion` (`speed` 0.5–2, `easing` `standard`, `snappy`, `linear` or `stepped`),
`icons.stroke` (1–2.5), `radius.field`, `recipes` (one per component: `button` `quiet`/`outlined`/`solid`/`raised`/`beveled`,
`card` `flat`/`outlined`/`raised`, `input` `quiet`/`filled`/`outlined`/`underlined`, `modal` `floating`/`framed`, `badge`
`pill`/`rounded`/`square`, `composer` `floating`/`integrated`/`framed`), `effects` (`backdrop.kind` `dot-grid`,
`hard-grid`, `scanlines`, `grain` or `paper` with `intensity` 0–1 and `scale` 8–48 px; `surface.kind` `glass`,
`soft-glow`, `paper` or `grain` with `intensity` 0–1; glass tints widget cards and the composer opaquely and is
translucent and blurred only on the modal, and the backdrop's pointer light is as strong as the backdrop) and `orb`
(`profile`, one of the shipped Orb presets, and an optional `palette` of 0–1 colour triples for every Orb channel but
`canvas`, which the page supplies; it applies only while the person has never chosen an Orb). The bounds are
the constants in `packages/contracts/src/themes.ts`. A document using any of these with `appearanceApi.min` 1 is
refused, since a version 1 build could not draw it. Nothing else: no CSS, no selectors, no font files, no images. The node reads it from the installed bytes through the same containment as a widget's files, refuses
one over 64 KiB, and validates it (`packages/core/src/installed-themes.ts`); a theme that fails is listed with its
reason, and the package's other themes still load. A valid theme is also held to the contrast audit Clark Default is
held to, in both schemes (`requiredPairs` in `packages/design-tokens/src/contrast.ts`), and to the protected-state
audit (`packages/design-tokens/src/protected.ts`): danger, warning, success and the accent must stay apart, a status
apart from text, the focus ring apart from edges, disabled text apart from enabled text, an edge visible on its card
and the page, text, status colours, the accent and the focus ring readable on a surface an effect finishes and on the
page under the backdrop and its pointer light (the modal over the brightest and darkest page its scrim can cover, so
strong glass or a dense lit pattern is refused), and the Orb's light visible against the page. One that fails either
audit is listed with what fails and cannot be chosen, so check both schemes before publishing. The focus ring,
disabled controls, the host's own cards (their edge, plain surface and buttons: a button recipe never reaches an
approval's Approve and Deny, the inbox's answers or Stop) and reduced motion, from the system or from
Settings, are the host's whatever a theme says. It is selected as `package:<package id>#<theme id>`, and a
theme-only package is a UI refresh, never a Pi restart. Installed themes appear under Settings → Experience → Theme.

**Reference packages.** [Pixel Arcade](../examples/themes/pixel-arcade/README.md) and
[Neo Brutalism](../examples/themes/neo-brutalism/README.md) are generalized data-only packages, installed through
the existing package lifecycle and selected in Settings → Experience. Pixel Arcade uses square frames, beveled
controls, a bounded scanline backdrop, stepped motion and a Plasma Orb default; Neo Brutalism uses heavy borders,
hard offset shadows, strong headings, raised controls and a Glass Orb default. Both use host-owned font-family
profiles with system fallbacks, without bundled font files or external styling resources. Their source/license
metadata is in each manifest; original theme data is Apache-2.0. Personal Orb choices and reduced motion retain
precedence. Clark Default is unchanged. These checkout examples are not marketplace publication claims.

**Theme authoring and Theme Lab.** The existing package CLI has `clark theme init <dir>`, `dev [dir] [--port <port>]`,
`test [dir]` and `pack [dir]`. From a checkout, invoke `node packages/widget-cli/src/cli.ts theme <command>`.
Init writes a generalized manifest and `themes/main.json`, refusing a nonempty directory. Dev binds to loopback
port 4319 by default, serves checked theme data and the shared production preview, reloads edits while retaining the
preview draft, and closes watchers on Ctrl-C. It accepts only its own origin and never writes runtime preferences.
The preview reuses production transcript, composer, controls, cards/widgets, Settings, modal, approval/error/status
and Orb components, with clearly labelled local examples. Scheme, normal/phone/compact viewport, reduced motion,
compiled tokens, recipes and audit results are inspectable.

Test uses the installed-theme reader, compiler and both audits on arbitrary theme documents: manifest, contained
regular files, bounded typography, reduced durations/easings and no executable styling or remote resources. Package
symlinks are refused. Pure theme packages require no privileged permissions and cannot contain script, CSS, HTML or
executable payloads; other declared facets retain their trust lanes. Browser layout/keyboard is explicitly
`requires-dev-host`, not an automatic pass. Pack uses the same immutable package artifact and file hashes as widgets,
adds theme-document digests and records unverified checks. Changed bytes under an already packed version are refused.

Settings → Experience → Browse themes opens the same Lab without losing the real conversation or focus. Preview is
read-only; Use this theme writes the canonical preference. The registered writer records six distinct recent choices.
Personal accent and density use the shared compiler/snapshot, including widgets and detached surfaces. Accent is a
checked dark/light hex pair or `null` for the theme; contrast and protected-state audits must pass before it is stored.
If an update makes a saved accent unsafe, the theme's accent is drawn with an explicit fallback and the saved choice
is retained. Compact spacing preserves typography, layout minima and small padding. Reset customization resets
accent, density, motion and Orb while keeping theme, scheme and language; platform reduced motion always wins.

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

**Structured results.** A tool may list an `outputSchema` and return `structuredContent` beside its text, as MCP
2025-06-18 describes. The node keeps the schema on the capability's descriptor when it is a JSON object schema of
`type: "object"`, at most 16,384 characters, with no pattern refused above; any other schema is dropped, the log says
why, and the tool still loads. A tool's `title`, `_meta` and annotation hints other than the ones Clark reads are
accepted and ignored. Nothing a service lists, its schemas, description, title or annotations included, lowers what the
execution policy decides: a capability's effect category is the one its manifest declares, and what the service lists
can only raise it (`serviceEffectCategory` in `apps/runtime/src/service-host.ts`).

A result's `structuredContent` is kept as a copy only when it is a plain JSON object at most 32 levels deep with at
most 16,384 values and no `__proto__`, `constructor` or `prototype` key, its JSON is at most 65,536 characters, and it matches the
`outputSchema` the tool declared. Otherwise it is dropped, the service's text is kept, and the text says why. The
service's text is still what the model reads. A kept value goes to a widget's `invoke` binding as `structuredContent`
([open interfaces](open-interfaces.md)). The agent's `invoke_capability` tool also carries it, in a result shaped as an
MCP `CallToolResult`, for a program that calls the tool; ClarkCant does not run such programs yet, so today no model
or script reads it there. It is classified with the text, as JSON and string by string, and is withheld with the text. It is data: it never becomes an instruction, an approval card or a widget. A
file is still returned as a resource and stored as an `ArtifactRef` (§10.1), not put in `structuredContent`.

What a service runs with, and how it reaches a provider without holding the key, is §14.1 and §14.2. Not built: VM
isolation, and calling a service on another node. A model reaches a
package service from the conversation by placing the generic action button with an `invoke` action (§8.1). The browser
journey [`service-facet.spec.ts`](../apps/web/e2e/service-facet.spec.ts) still creates a package's own widget with
`invoke` bindings through a fixture model.

**An account connection.** A `tools` facet may declare `connection` when its service works on a person's account at a
provider ([service-connection.ts](../packages/contracts/src/service-connection.ts)):

```json
"connection": {
  "version": 1,
  "provider": "fake.tasks",
  "displayName": "Fake Tasks (test fixture)",
  "flow": "oauth-pkce",
  "authorization": {
    "authorizationEndpoint": "http://127.0.0.1:8880/oauth/authorize",
    "tokenEndpoint": "http://127.0.0.1:8880/oauth/token",
    "revocationEndpoint": "http://127.0.0.1:8880/oauth/revoke",
    "clientId": "connected-app-dev"
  },
  "scopes": [
    { "scope": "tasks.read", "purpose": "Lists your tasks." },
    { "scope": "tasks.write", "purpose": "Renames a task when you ask." }
  ],
  "endpoints": ["http://127.0.0.1:8880"],
  "probe": { "url": "http://127.0.0.1:8880/api/me" }
}
```

The only flow is authorization code with PKCE, so a package never carries a client secret, and the client id is public.
Every URL must be HTTPS unless it is a loopback address. The probe must be on a declared endpoint. A package declares at
most one connection, and an endpoint cannot also be an `egress` origin, so each origin has one credential. A capability
names the scopes it needs in `requiredScopes`; each must be a scope the connection asks for. How the host connects the
account and signs the service's requests is §14.6.

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
- entry artifact for executable UI;
- `offeredActions` — at most 16 actions an isolated widget lets Clark perform, each `{name, label, description,
  inputSchema}` with an object input schema. They are bound like any other action and performed through
  `actions.perform@1` ([§10.3](#103-actions-clark-performs-actionsperform1)).

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
hold or one another person owns. `artifact:<id>` names a file held through the artifact broker (§10.1); when the
binding is compiled it is refused for a file this node does not hold or one another person owns. At the press the host
reads each reference again for the person who pressed and bounds each to 4000 characters, cut at a character boundary.
A file is read as the pressed widget, under the same decision as that widget's own reads: its grant, the principal, and
the conversation the press happened in, which must be the file's. What the model gets is the file's name, type and
size and, for a text type (plain text, Markdown, CSV, TSV, JSON), the start of its contents — at most 3000 bytes, said to be
partial when it is. A picture or a PDF is described and never quoted. An unknown, expired or missing file refuses the
press with `CONTEXT_REF_UNKNOWN`; another principal's file, one the widget was never granted, or a grant that has
expired or been revoked refuses it with `CONTEXT_REF_FORBIDDEN`. What it reads can be text a widget wrote, so it is data, never guidance: it is not placed in the turn's
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
| `canvas.gallery@1`, `canvas.carousel@1` | `media.select` | `selectedIndex` |

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

For local authoring, `clark widget dev` lists each definition's declared graph inputs and events. Its event simulator
validates and applies a sample to scratch graph state using the same composition contracts, then shows the resulting
values. This checks one declared event at a time; it does not build a composition or invoke a capability.

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
| `canvas.file@1` | A file, named and described. | `show_view` with `props.name`, and optionally `mediaType` (`type/subtype`), `sizeBytes`, `source` (in words), `path` (as text), `summary` and `artifactRef`, the whole `ArtifactRef` of a file the node holds (§10.1). |

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
- A file card without `artifactRef` has no link, no open and no download. It says so in words, rather than drawing a
  button that does nothing.
- A file card with `artifactRef` offers **Open** and **Save As**. Open fetches the bytes from the node as the person
  and previews them in place: text and JSON up to 64 KB, with a note when there is more, and pictures. Any other type
  says it has no preview. The preview trusts the type recorded by the node, never the card's words. Save As is the
  host's own (§10.1). The node checks the ref again on every open and every save. It refuses an artifact that belongs
  to another principal, or one still being written, and the card shows the reason. Where the card cannot reach the
  node as the person, such as a library preview or a detached window, it says it cannot open the file there.
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
a label for a field the chart does not plot, or a `pointLabel` that is `x` or one of the series (a point is named by a
field it is not placed by, so the table under the chart never has the same column twice). `stacked` belongs to an area
chart and `pointLabel` to a scatter plot.

A model places each one with `show_view`. They are in the `chart` family, which no layout region reads, so a model
places each on its own.

What the node guarantees:

- **The rows are read before anything is stored.** The node reads the dataset the chart names, as the person placing
  it, and refuses in the same turn, with the reason, when the dataset is not on this node or is not theirs, when a
  named field is not in it (the reason lists the fields it has), or when a row does not fit: a missing value, a value
  that is not a number (a numeric string such as `"12"` is not one), an x that is not a number on a scatter plot, an
  area chart's x that mixes numbers and text or whose numbers do not rise row by row, a negative value in a stacked
  area, or a stacked row whose series add up to more than a number can hold (each value fits, but the stack drawn is
  their sum). Up to five problems are named, then `and N more problem(s) in the same rows`. No instance is left behind.
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
  only signal. There are six tones, so from the seventh series the colours repeat; each of the eight series still has a
  line pattern and a point shape no other series has, and those tell them apart. The legend is a row of buttons with `aria-pressed`; a hidden series says "(hidden)" in words. The last
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
- A hidden character of §8.4 in the rows' text, such as a bidi control in an x category or a point's name, is shown as a
  marker such as `⟨U+202E⟩` wherever the chart says that text: on the axis, in a point's name, in the selected point,
  the text alternative and the semantic document. In the table it is the same marker the code viewer draws, with a
  title that says what the character is. It never reorders the text around it.
- Everything the chart says is in the person's language. Rows that no longer fit are described from the row, field
  and value the shared checks found, not from the node's English sentence, and a refused view is said as a sentence
  of the page's own. The node's English reasons are for the model and the logs.
- The axes never do unbounded work. Ticks are counted before they are made, at most 50, and each is its index times a
  round step. Values so close that no round step separates them, such as `0.3` and `0.1 + 0.2`, are drawn as one
  value with room either side. Labels use `k`, `M`, `B` and `T` up to a thousand trillion, and past that, or when the
  step is finer than a millionth of the unit, an exponent and as many significant digits as the step needs, so a
  `1e-12` scale is not labelled `0` throughout. The plot starts far enough right for the widest label to be drawn
  whole, up to two fifths of the chart's width.
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

### 8.7 Calendar views

`canvas.calendar@1` shows the events of a dataset in three views: a month, a week (Monday to Sunday) and an agenda,
which lists the month's days that have events. The view, the day selected and the event selected are the calendar's
widget state. One set of functions, in [calendar-view.ts](../packages/contracts/src/calendar-view.ts), reads the
events, places them on their days, checks a view and writes the text. The node and the page both use it.

| Prop | What it is |
| --- | --- |
| `datasetRef` | A dataset on this node whose rows are events. |
| `month` | The month drawn, `YYYY-MM`. |
| `timezone` | The IANA timezone the events are shown in; `UTC` when it is left out. |
| `view` | Optional: `month`, `week` or `agenda`, the view it opens in. `month` when it is left out. |
| `title` | Optional, up to 200 characters. |

A row is read in one of three shapes. Anything else, a row with no title and a row that ends before it starts are
counted as not readable, and the calendar says how many:

- **Timed**: `title`, `startsAt` and `endsAt`. A time with `Z` or an offset such as `+07:00` is that instant. A time
  with no offset, such as `2026-10-09T14:00`, is that time in the calendar's timezone, read the same way by the node
  and by every page whatever timezone they run in. Anything else, such as `+0700` without the colon or a date alone, is
  not readable. The event is on every day from the one it starts on to the one it is still running on, in the
  calendar's timezone. An event from 22:00 to 02:00 is on both days, marked "from
  22:00" on the first and "until 02:00" on the second. An event that ends at midnight is not on the day that midnight
  begins.
- **All day**: `title`, `allDay: true`, `startDate` and an optional `endDate`, the day after the last day, as iCalendar
  and Google Calendar write it. With no `endDate` it is one day, and `date` can stand for `startDate`. An all-day event
  is on its own dates wherever it is seen: it is never read as midnight in some timezone, which is how an all-day event
  drifts onto the day before.
- **Dated**: `title` and `date`, on that day with no time.

`eventId` (or `id`) names the row, and a row without one is named by its position (`row-3`). An event is named by its
key: the row's name and where it starts, such as `evt_deploy@2026-10-06T15:00:00.000Z` or `evt_offsite@2026-10-07`.
Two rows with the same name and start, such as a recurring event exported twice, get `#2`, `#3` in row order, so each
row is its own event to select. `timezone` is the timezone the event was written in; it is shown beside the
calendar's time and does not change how a time without an offset is read. The calendar reads the first 500 rows and says when there are more.

A model places the calendar with `show_view`. Before an instance exists, the node refuses, with the reason, a month
that is not a real `YYYY-MM`, a timezone it does not know, and a dataset that is not on this node or is not the
person's.

What the node guarantees:

- **What a person changes is a view the node keeps.** The view switcher, the days and the events write through the
  calendar's one `calendar.view` binding: `{ view, selectedDate?, selectedEventId? }`, where `selectedEventId` is the
  event's key. It is a view operation: it reads
  and changes nothing else, and never adds, moves or removes an event. The node checks each view against the calendar
  and the rows it holds now. The view is one of the three, a selected day is one the month draws, and a selected event
  is one of its events, on the selected day when a day is selected too. A view that does not fit is refused with the
  reason, such as `"evt_deploy@2026-10-06T15:00:00.000Z" is not an event on this calendar now`, and the state is left
  as it was. A bare row name is not a key and is refused the same way. A view replaces the last one whole.
- **A calendar saved before there were views opens as a month.** The calendar's state is version 2. Version 1 held only
  `selectedDate`, and its declared migration step gives it `view: "month"`. The timeline and the semantic document read
  an older state in the current shape, and the row itself is written as version 2 only when the view next changes.
- **A calendar placed before there were views gains its binding.** Such a calendar was placed with no binding. The
  first time the node builds the conversation's timeline, it gives each calendar it owns over a dataset the same
  `calendar.view` binding placement gives a new one, once, in one transaction; no database migration is involved. From
  then on its view is kept, read back after a reload, and described by voice and `inspect_ui` as it is.
- **The text alternative is the calendar's own words**: each event of the month and when it is, in the calendar's
  timezone, for example `Deploy (2026-10-06 at 22:00 to 2026-10-07 at 02:00)`.
- **Voice and `inspect_ui` read the calendar as it is now.** The semantic document (§9) gives the view, the month, the
  timezone, the number of events that month, the selected day with the titles of its events, and the selected event
  with when it is and, when it was written in another timezone, that timezone. The event is also given in
  `selectedIds`. It is built from the state and the rows the node holds now. A selected event that is no longer in the
  rows is said to be gone, and a dataset that is gone is said to be not available.
- **Local events can be all day.** The node's own events (`POST /calendar/events`) take `allDay: true`
  with `startDate` and an optional `endDate`, and refuse a date that is not real or an `endDate` that is not after
  `startDate` (`INVALID_DATE`, `INVALID_RANGE`). A change keeps an all-day event all day, on its dates, unless it says
  `allDay: false`. A query for a range of days finds an all-day event by its dates, even when the event was written
  at the other end of the world's timezones (UTC+14 against UTC-11), and a timed event by its instants.

What the page does:

- The views are a row of buttons with `aria-pressed`. The day selected is kept when the view changes, and the week view
  shows that day's week, with buttons for the weeks before and after.
- Today is the day in the calendar's timezone, not the browser's. It is ringed, underlined and named "today". A line
  under the view switcher says the time now, and a "now" marker sits among today's events in the week and agenda views,
  after the ones that have started. It moves each minute.
- An all-day event is labelled "All day" and drawn with a stripe and a double edge, and an event that covers several
  days says "day 2 of 3", so neither is told by colour alone.
- Days and events are buttons. In the month, one day is in the tab order and the arrow keys move a day or a week; Home
  and End go to the ends of the week. In the week view, Left and Right move between the day headings. Up and Down move
  between events, Home and End go to the first and last, Enter or Space selects, and Escape clears the selected event.
- The selected event is described under the view in a live region: when it is in the calendar's timezone, how long
  it lasts when that runs past a day, when it is in its own timezone when that is another one, and a button that
  clears it. An all-day event over several days lasts "3 days"; a timed one lasts its real length, so 22:00 to 02:00
  lasts "4 hours", not two days.
- In the week view a day is narrow, so the "now" marker shows the time beside its line on one line; the whole label is
  read out and shown on hover.
- When the node refuses a view, the calendar says so in the person's language, draws the view the node holds, and
  reads the events again. The node's English reason is for the model and the logs.
- In a composed surface the view is held on the surface and `date.select` still feeds the layout (§8.3).
- The calendar adds no motion of its own. Below 560 px the week's days and the agenda stack in one column, so the week
  is usable at 390 px. It follows the light and dark themes. In the Widget Library the month, week and agenda fixtures
  are usable without a node.

Tests: [calendar-view.spec.ts](../packages/contracts/test/calendar-view.spec.ts) for the rules,
[calendar-views.spec.ts](../apps/runtime/test/calendar-views.spec.ts) for the node and a calendar placed before
there were views,
[mini-app-data.spec.ts](../apps/runtime/test/mini-app-data.spec.ts) for all-day local events and the range query,
[calendar-layout.spec.ts](../packages/conversation-client/test/calendar-layout.spec.ts) for the keyboard, the week and
the "now" marker, [calendar-schemas.spec.ts](../packages/widget-catalog/test/calendar-schemas.spec.ts), which checks the
state version, its migration and that every library fixture is a view the node would keep, and the browser journey
[calendar-views.spec.ts](../apps/web/e2e/calendar-views.spec.ts). The journey runs in a browser in New York over a
calendar in Ho Chi Minh City. It covers each view, the keyboard, a selected event kept after a reload, today and "now"
by the calendar's timezone, all-day and overnight events, a time without an offset read in the calendar's timezone by
a browser in Los Angeles, the refusal of an event the node no longer holds, a month that does not exist, reduced motion, 390 px with touch in the light theme, and the library.

### 8.8 Activity timeline

`canvas.timeline@1` shows what happened and when: dated entries the model states, sorted by time and grouped by day.
Everything it shows is in its props. It reads no feed and never says it is live; newer entries arrive as new props.
The entry selected is the timeline's widget state. One set of functions, in
[activity-timeline.ts](../packages/contracts/src/activity-timeline.ts), checks the props, places each entry on its day,
checks a selection and writes the text. The node and the page both use it.

| Prop | What it is |
| --- | --- |
| `entries` | Required, at most 200. Each is `{ id, at, title, description?, actor?, tone? }`. |
| `title` | Optional, up to 200 characters. |
| `order` | Optional: `newest` (the default) or `oldest` first. |
| `pageSize` | Optional: entries on a page, 5 to 50; 10 when it is left out. |
| `timezone` | Optional: the IANA timezone the days are read in. |
| `truncated` | Optional: `true` when the model left entries out, and the timeline says so. |

An entry's `id` is up to 120 characters and unique on the timeline. `title` is one line of up to 200 characters,
`actor` one line of up to 80, and `description` up to 1,000 characters and may hold line breaks. `tone` is one of
`neutral` (the default), `info`, `success`, `warning` and `danger`. `at` is one of two things:

- **An instant with its offset**: `2026-09-30T21:05:00+07:00` or `2026-09-30T14:05:00Z`. A time with no offset is
  refused, because it names a different moment in every timezone.
- **A date** (`2026-09-30`) for an all-day entry. It is on that date wherever it is read, never midnight in some
  timezone.

Text is plain: no HTML, no links and no callbacks, and no key other than those above. A model places the timeline with
`show_view`. Before an instance exists, the node refuses, with the reason: a time that is missing, has no offset or does
not exist (`2026-02-30`, an hour past 23), an id used twice, a tone it does not have, too many entries, text that is too
long, a hidden or bidirectional control character (named by its code point, such as `U+202E`), and a timezone it does
not know. A refused timeline leaves nothing behind.

What the node guarantees:

- **The node and the page read the same days.** When the props name no timezone, the node writes one into them as it
  places the timeline: the node's display timezone, or `UTC` when it cannot name a known one. An entry is on its
  day in that timezone, for example 17:40 UTC on the 29th is on the 30th in `Asia/Saigon`. Daylight saving time is
  followed, including the hour that repeats and the hour that is skipped. Within a day an all-day entry comes first, then
  the timed entries in the timeline's order.
- **What a person selects is state the node keeps.** The entries write through the timeline's one `timeline.select`
  binding: `{ selectedId }`, where an empty `selectedId` clears the selection. It is a view operation: it reads and
  changes nothing else. The node checks each selection against the entries it holds. An id that is not one of them, a
  key other than `selectedId`, or another shape is refused with the reason, such as
  `"gone" is not an entry on this timeline now`, and the state is left as it was.
- **The text alternative is the timeline's own words**: each day once, then its entries with their time, tone and actor,
  for example `2026-09-30: all day Release freeze [info]; 23:30 Deploy started [info] by Lan`. It is shortened with a
  marker to fit the snapshot.
- **Voice and `inspect_ui` read the timeline as it is now.** The semantic document (§9) gives the number of entries, the
  order, the timezone, the first and last day, whether entries were left out, how many entries have each tone, and the
  selected entry with when it is and its tone. The entry is also given in `selectedIds`. The document is kept within the
  semantic limits for the largest timeline.
- **In a composed surface** the timeline is a `timeline` leaf, and `timeline.select` `{ selectedId }` can feed the layout
  (§8.3). When it is not wired, the selection is held on the surface.

What the page does:

- Each day is a heading with the full date in the person's language, and its entries are a list. An entry shows its
  time, or "All day" with a double edge, its tone as a symbol and a word beside the colour, its title and its actor. A
  long description opens folded, with a button to show the rest.
- Entries are buttons with `aria-pressed`. One entry on the page is in the tab order. The arrow keys move between the
  entries of the page, Home and End go to the first and the last, Enter or Space selects or clears an entry, and Escape
  clears the selection. Focus is always drawn. A live region says what was selected or that the selection was cleared.
- The selected entry is described under the list, with a button that clears it. A longer timeline has pages, with
  previous and next buttons, and opens on the page of its selected entry.
- A text list of every entry is one click away, and the timeline says when entries were left out.
- When the node refuses a selection, the timeline says so in the person's language and draws the selection the node
  holds. A timezone the page does not know is read as UTC, and the timeline says so.
- Text is drawn as text. A hidden character in a timeline stored before the rules tightened is shown as a marker, and
  the timeline says how many there are.
- The timeline adds no motion of its own. When the timeline is narrower than 480 px, an entry's title and actor wrap under its time, so it is usable
  at 390 px. It follows the light and dark themes. In the Widget Library the fixtures are usable without a node, and a
  selection works there too.

Not part of the timeline: durations, a Gantt view and a live feed.

Tests: [activity-timeline.spec.ts](../packages/contracts/test/activity-timeline.spec.ts) for the rules, days across
timezones and daylight saving time, the text and the semantic document;
[activity-timeline.spec.ts](../apps/runtime/test/activity-timeline.spec.ts) for placement, refusals, the timezone the
node writes down, the selection and the layout leaf;
[activity-timeline.spec.ts](../packages/conversation-client/test/activity-timeline.spec.ts) for the keyboard, paging
and folding; [timeline-schemas.spec.ts](../packages/widget-catalog/test/timeline-schemas.spec.ts), which checks that
the JSON Schema and the rules accept and refuse the same props and that every library fixture is one the node would
place; and the browser journey [activity-timeline.spec.ts](../apps/web/e2e/activity-timeline.spec.ts). The journey
runs in a browser in New York over a timeline in Saigon. It covers the days, the keyboard, a selection kept after a
reload and cleared with Escape, a selection the node refuses, a repeated id and a hidden character refused at
placement, paging, reduced motion, the library, and 390 px with touch in the light and dark themes.

---

## 8.9 Tree and hierarchy

`canvas.tree@1` is a host-rendered outline for bounded, already-known data. A tree holds at most 200 nodes and 12
levels. IDs are at most 120 characters, labels 200, and secondary text 300. Placement refuses repeated node or
expanded IDs, references to missing expanded nodes, cycles, over-depth or over-count trees, unknown icons, extra
fields, and hidden characters. Text is rendered as text; the widget does not load children or edit the source.

`initiallyExpanded` names branches open at placement. `tree.select` carries `{ selectedId }`; `tree.toggle` carries
`{ nodeId, expanded }`. The node checks and persists both operations in widget state. A restored state ignores IDs
that no longer occur in the current props. The renderer provides the WAI-ARIA tree roles and level/position/set-size,
selected and expanded state; Arrow keys move and open or close branches, Home/End move to the ends, type-ahead finds a
label, and Enter/Space selects. Focus remains visible. Selection and expansion also survive pin and conversation
restoration.

The semantic document reports bounded node count and depth, expanded count, and the selected node and its path. The
text fallback is an indented outline. The tree has no motion of its own, follows both themes and reduced-motion
preferences, and wraps within narrow viewports.

Tests: [tree-view.spec.ts](../packages/contracts/test/tree-view.spec.ts) checks bounds, malformed trees, state and
semantics; [tree-view.spec.ts](../apps/runtime/test/tree-view.spec.ts) checks placement, events and semantic output;
[tree-view.spec.ts](../packages/conversation-client/test/tree-view.spec.ts) checks visible keyboard order, Home/End and
locale-aware type-ahead; [tree-schemas.spec.ts](../packages/widget-catalog/test/tree-schemas.spec.ts) checks fixtures
and schema agreement; the browser journey [tree-view.spec.ts](../apps/web/e2e/tree-view.spec.ts) covers the
conversation, keyboard, persisted state across pin restoration, responsive layout, reduced motion and the Widget
Library preview.

---

## 8.10 Kanban boards

`canvas.board@1` is a host-rendered board for bounded, already-known work. It has 1–12 columns and at most 120 cards;
column and card IDs share one unique namespace. Titles are one line (at most 160 characters), descriptions at most
500, assignees at most 100, and each card has at most 8 plain-text labels. A column may set a card limit. Unknown
fields, missing columns, duplicate IDs, over-limit columns and hidden control characters are refused before placement.
The board fetches nothing and does not edit card details.

The node holds the card order and selected card as view state. Without an action binding, moving a card changes only
that board's saved view. An optional `props.action` must be an `invoke` binding; the node derives whether the board is
bound from that stored host binding, checks the card and destination against its current props and order, and sends
only `{ cardId, fromColumnId, toColumnId, position }` through the normal capability path. A bound move remains
pending until the host reports its result. Success confirms the displayed order; refusal restores the last order and
shows its reason; a lost answer stays marked uncertain until the person acknowledges it. The board never writes to a
provider from the page.

Space picks up or drops the focused card, arrows move the pickup preview between positions, and Escape cancels it.
The drag handle also works with pointer and touch input; keyboard operation does not depend on dragging. Focus stays
on the card when a preview moves it between columns, a live region announces pickup, position and drop, and the handle
has a 44 px touch target. Label tone is accompanied by a word, focus is visible, narrow viewports do not overflow, and
the board follows reduced-motion preferences. The semantic document reports bounded column/card counts, selection
and pending status; its text alternative lists cards beneath column headings.

Tests: [kanban-board.spec.ts](../packages/contracts/test/kanban-board.spec.ts) checks the bounds, order, refusal and
semantic/text output; [board-view.spec.ts](../apps/runtime/test/board-view.spec.ts) checks host bindings, persistence,
the invoke result, approval matching and refusal rollback; the browser journey
[kanban-board.spec.ts](../apps/web/e2e/kanban-board.spec.ts) exercises keyboard, mouse and touch moves in conversation,
responsive light/dark and reduced motion, plus the read-only Widget Library preview.

### 8.11 Media widgets and semantic state

`canvas.image@1` describes the supplied alt text and includes dimensions only when the owning node has them. Gallery and
carousel state stores a bounded `selectedIndex`, counted from 0 (state version 2); an old version-1 state migrates to
the first item, and an index is normalized against the current props. Gallery/carousel selection is written through
the host's `media.view` binding. When the node refuses a write, the widget draws the item the node holds again and says
why beside it, like the other view widgets. Their semantic document counts the way a person does, under a different
name: `selectedNumber` is the selected item counted from 1, next to `itemCount` and the item's alt text, and the summary
reads "showing picture 2 of 3". A gallery or carousel placed before this binding existed has no `media.view` binding;
it still renders and its selection still works on the page, but that selection is not stored, so its document reports
the first item.

A composed layout lists a widget only when the node has a real source for it. For media that means an imported image,
and now a gallery or carousel too: a `canvas.gallery@1` or `canvas.carousel@1` leaf shows the person's own imported
pictures, newest first, the same references `/images` serves, cut to what the widget holds (48 for a gallery, 24 for a
carousel). The set is the pictures present when the layout is composed: a picture imported later appears only in a
newly composed layout, and one removed since is no longer drawn. The node fills `imageRefs` and `alts`; a model names only the widget, its title and its wiring, and any
pictures it names are ignored. A layout that asks for one when the node holds no picture is refused with the reason,
and a placed set whose pictures were all removed is shown as missing rather than as broken images. A video or a YouTube
embed still has no source and is refused. Choosing a picture in a composed gallery or carousel emits `media.select`
with `{ "selectedIndex" }`, the same field the widget stores, so a graph rule such as `select-field` into a declared
number key keeps the choice on the node. A leaf that picks the same key gets that value back as its own selection: two
media leaves wired to one key follow each other, and the surface's `semanticState` and `inspect_ui` report it. That
value is the stored index, counted from 0: the second picture is held and reported as `1`. Only a media widget's own
semantic summary counts from 1 (`selectedNumber`, "showing picture 2 of 3"); a graph key fed by `media.select` does
not, so a model reading one must add 1 to name the picture as a person counts it. An unwired gallery or carousel in a
composed surface keeps its choice on the page only.

`canvas.video@1` stores `status`, `position` and `duration` through the same host binding (state version 2; an old
version-1 state migrates to paused at 0). Position writes go through one shared playback coalescer
([playback-coalescer.ts](../packages/conversation-client/src/playback-coalescer.ts)), which the audio player (§8.14) reuses:
pause, seek and end flush immediately, while continuous playback writes at most once per
`MEDIA_PLAYBACK_WRITE_INTERVAL_MS` (three seconds). An hour of play is still about 1,200 writes, so the player sends them
as the state-only variant of the action call (`variant: "view-state"` on `POST …/widgets/{instanceId}/actions`,
[#380](https://github.com/digitopvn/clarkcant/issues/380)). The node checks it exactly as it checks the view action —
owner, binding, revision, binding digest, input — stores the bounded state, and answers with
`{ variant, duplicate, instanceId, revision, stateRevision, state }` only. It does not move the instance revision, mark
history snapshots superseded or rebuild the timeline, and the page re-renders nothing for it. The binding keeps one
invocation record under the node's own key, `view-state:<bindingId>`, replaced by each new write, and an hour of play
leaves one row in `action_invocations` instead of 1,200. No client invocation id may start with `view-state:` on any
action path (`400 INVALID_SCHEMA` at the route), and the write only ever replaces a record it wrote itself, so it cannot
overwrite another action's ledger row. Each write also carries the player's `sequence`, which the page stamps when the
player makes the write as `max(now in milliseconds, previous + 1)`, so it grows across page loads too. The record keeps
the newest sequence accepted, and a write whose sequence is not newer writes nothing: a retry of the latest write, an
older write that arrives late, or a replayed older id is answered `duplicate: true` (`stale: true` for an older one)
with the state and revision the node holds now, and an id reused with other input is refused with
`INVOCATION_KEY_REUSED`. A sequence more than a day past the node's clock is refused, so one broken clock cannot freeze
the player's state. The variant is taken only for `canvas.video@1` and `canvas.audio@1` playback state: any other binding,
including a gallery selection, is refused with `UNSUPPORTED_ACTION`, an unknown variant with `400 INVALID_SCHEMA`, and
effectful actions keep their ledger, provenance and records unchanged. An isolated frame cannot send it: the frame bridge
builds the ordinary call, and a frame's own state goes through `…/state`. When the page is hidden, the player writes
where it is; when the page is left or the player is removed, it writes itself paused where it stopped. The page keeps
one state-only write per player in flight and sends only the latest one waiting
([state-only-writes.ts](../packages/conversation-client/src/state-only-writes.ts)). The write made as the page is left is
sent at once with `keepalive`, not behind a write still in flight, and it drops the write that was waiting, so nothing
older is sent after it; if the write in flight reaches the node after it, its older sequence writes nothing. A
state-only write does not move the revision, so it is checked at the one the page holds. All of these writes are
best-effort: an unloading page may
still not finish the request. So the node also stops believing a stored "playing" once it is older than `MEDIA_PLAYING_FRESH_MS` (two
intervals plus two seconds of slack, from the state row's `updated_at`): the semantic document then reports the video
paused at the last stored position. A refused playback write is said beside the player, which is not moved, and the
next write is sent even if the player has not moved since. A restored player
seeks to the stored position once its metadata loads and stays paused; restoring never starts playback, and the restore
seek is not written back. The semantic document reports the position and duration in
tenths of a second. YouTube semantics use only its validated video id and title; no
third-party playback messages are read. Image, gallery/carousel, local-video and YouTube semantics use the same bounded
document for voice, the next-turn note and `inspect_ui`.

Pinning a media widget works as it does for the tree and the timeline: the pin is a compact chip on the shelf, and the
pin record and the widget's view state both survive a reload. There is no second, live pinned player; after a reload the
one widget in the conversation reopens with the stored state.

The unit coverage is in [media-view.spec.ts](../packages/contracts/test/media-view.spec.ts) (including the freshness
window),
[playback-coalescer.spec.ts](../packages/conversation-client/test/playback-coalescer.spec.ts) (including the write count over a
minute of continuous play and the writes when the page is hidden, left, or the player removed, and the state-only
variant the client sends),
[view-state-writes.spec.ts](../apps/runtime/test/view-state-writes.spec.ts) (no timeline built and no snapshot marked
superseded by continuous playback, one invocation record after an hour of simulated play, and the same gate),
[media-renderers.spec.ts](../packages/conversation-client/test/media-renderers.spec.ts) (including the refusal message),
[widget-semantic.spec.ts](../apps/runtime/test/widget-semantic.spec.ts) (including a stale "playing", a gallery placed
without a binding, and the bounds at the largest accepted props) and
[security.spec.ts](../apps/desktop/test/security.spec.ts) for the desktop media policy. The browser journeys in
[widget.spec.ts](../apps/web/e2e/widget.spec.ts) verify a gallery selection through `inspect_ui`, a carousel selection
through the next-turn note, a refused selection in both, and the carousel's state after pinning and a reload, with
keyboard focus and both themes at 390 px. A gallery and a carousel placed in a composed layout are covered by
[compose-layout.spec.ts](../apps/runtime/test/compose-layout.spec.ts) (the node's own pictures, the per-widget limit, a
refusal with no picture), [composition-graph.spec.ts](../apps/runtime/test/composition-graph.spec.ts) (a pick kept,
read back, refused when malformed, and missing once the pictures are removed) and the browser journey in
[composition-graph.spec.ts](../apps/web/e2e/composition-graph.spec.ts), which picks a picture from the keyboard, sees the
carousel follow, reads the value through the live surface and `inspect_ui`, reloads, and checks both themes at 390 px.
[widget.spec.ts](../apps/web/e2e/widget.spec.ts) also plays a real local WebM clip in Chromium for about five seconds
and counts the writes against the clock ticks, refuses one write, reads the paused position through `inspect_ui`, and
reloads after pinning to check that the player reopens at that position without playing.

The node cannot import video yet: `/images` accepts only pictures. A local video therefore plays only from a reference a
host already serves, and the browser journey answers its clip's one reference itself; the authenticated fetch, the
object URL, the page policy, the player and the node-held state are the production path. That video plays from an
object URL the client creates from bytes it fetched with the node's token, exactly like an
imported picture. The page policy therefore allows `media-src 'self' blob:` in both
[apps/web/index.html](../apps/web/index.html) and the desktop window policy
([security.mjs](../apps/desktop/src/security.mjs)), and nothing more: no remote media origin and no `data:` media
([#374](https://github.com/digitopvn/clarkcant/issues/374)). A YouTube embed is a frame, governed by `frame-src`, not
by this directive.

**When a player's bytes are read.** Pictures, a video's poster included, are read as soon as the conversation lists
them: a poster is a still picture under the same import limit as any other, and it is what stands in for the player. A
video's or an audio file's bytes are read through the same authenticated client, as an object URL, but only when they
are needed ([#403](https://github.com/digitopvn/clarkcant/issues/403)): when the player comes within half a screen of
the visible transcript (an `IntersectionObserver` rooted at the transcript's own scroll area), or when the person
presses the host's Play button that stands in for the player until then. Pressing it says the bytes are loading, with no
invented progress, and keeps the focus on the button. Once the bytes arrive, the native player takes its place and the
focus, restores the stored position, and plays because the person asked, but only if that press is still current: if
another player started meanwhile, or the person moved the focus elsewhere, it stays paused. Starting any host player
pauses the one that was playing, so there is one active playback owner. Without an observer nothing is read until Play
is pressed. A source that cannot be read says so in a status that takes the focus the Play button had: what failed,
that the conversation is unchanged, and that opening it again tries again. The object URLs follow the
picture rules in [use-object-urls.ts](../packages/conversation-client/src/use-object-urls.ts): one fetch and one owner
per reference, released when the reference leaves the conversation, and a late arrival released rather than stored.
Tests: [object-urls.spec.ts](../packages/conversation-client/test/object-urls.spec.ts),
[near-viewport.spec.ts](../packages/conversation-client/test/near-viewport.spec.ts),
[playback-owner.spec.ts](../packages/conversation-client/test/playback-owner.spec.ts),
[media-renderers.spec.ts](../packages/conversation-client/test/media-renderers.spec.ts) and the browser journey
[lazy-media.spec.ts](../apps/web/e2e/lazy-media.spec.ts). The journey counts every media read: none when a conversation
with three videos and an audio player opens; one when a player comes within the margin, before it is visible; one for
the audio player scrolled to; and one when a player is played with no observer. It also checks that the paused position
comes back after a reload and that Play starts from it, that a stale press does not start a player, that starting one
pauses another, and that a refused source is said and takes the focus.

**When an attached file's bytes are read.** An attached picture is read when the conversation lists it, like any
picture. Any other attached file (text, PDF, audio) is listed on request in the same object-URL set and is read only when
the person presses its card's Download button ([#417](https://github.com/digitopvn/clarkcant/issues/417)): opening a
conversation reads none of its files, and pressing Download reads that one file once through the authenticated client.
The page never holds the node's attachment route as a link, only the object URL the client made. Pressing it again
downloads the bytes already read, with no second read. The card keeps its download behaviour: once the bytes land they
go to the browser's download flow under the file's name, which opens no window, so a popup blocker does not apply after
the awaited read. The desktop shell leaves it to Electron's default download flow, which asks where to save the file; no
test exercises the desktop or WebKit download yet. While the file is read, a polite status says the download is being
prepared, with no invented progress, and the button keeps the focus (`aria-disabled`, not `disabled`). If the node does
not give the bytes, the status says, in the error tone, what failed, that nothing was downloaded and the conversation is
unchanged, and the same focused button becomes Try again, which reads that file once more. A node that accepts the read
but does not start answering within 30 seconds (`FIRST_RESPONSE_TIMEOUT_MS` in
[api.ts](../packages/conversation-client/src/api.ts)) fails it the same way, so a stalled read never leaves the card
preparing forever. Only the wait for the first response is bounded, so a large file that arrives slowly is never cut
off. Pictures and players read through the same bounded path and show their own failure states, and a read still in
flight is aborted when the view that wanted it goes away. Tests:
[attachment-open.spec.ts](../packages/conversation-client/test/attachment-open.spec.ts),
[object-urls.spec.ts](../packages/conversation-client/test/object-urls.spec.ts),
[node-read-timeout.spec.ts](../packages/conversation-client/test/node-read-timeout.spec.ts) and the browser journey
[lazy-attachments.spec.ts](../apps/web/e2e/lazy-attachments.spec.ts), which counts every attachment read: none when a
conversation with three attached files opens, one for the card downloaded, none for a second download, and one more
only when a refused file, or one whose read stalled past the bound, is tried again.

### 8.12 Diagrams and graphs

`canvas.diagram@1` draws a bounded node-and-edge graph (a flowchart, a dependency graph, a small tree) as SVG the
host renders itself. Nothing in it executes: labels are text nodes, shapes and paths are numbers from a shared layout,
and there is no HTML, `foreignObject`, link, image, style or handler a label could name. A diagram holds at most 60
nodes and 120 edges. Node IDs are at most 64 characters of ASCII letters, digits, `_` and `-`; labels are one line
of at most 80 characters, edge labels 40, groups 40 and the title 200. A node's shape is `box`, `round`, `diamond` or
`circle`; an edge's direction is `forward`, `both` or `none`. Placement refuses repeated node IDs, an edge naming a
node that is not there, an edge from a node to itself, the same edge twice, over-count graphs, unknown fields and
hidden characters, each with the host's own sentence.

`layout` is `layered` (the default) or `tree`, and `direction` is `TB` or `LR`. The layered layout breaks cycles at
the edge the props close them with, layers by longest path, bends long edges through the layers they cross and orders
each layer with a fixed number of barycenter passes; the tree layout centres children under their parent and refuses a
graph that is not a forest. A gap an edge label sits in is widened to hold the label, and edges joining the same two
nodes (one each way, say) are drawn apart. Both are deterministic: the same props always give the same drawing, in the node and in
every client, and the largest accepted graph is laid out in bounded time
([diagram-layout.ts](../packages/contracts/src/diagram-layout.ts)).

A model can also hand `show_view` a Mermaid flowchart: `{ "mermaid": "flowchart LR ...", "title"?, "layout"? }`. The
node reads a documented subset of the flowchart syntax on the host and stores only the resulting diagram model; the
Mermaid source is never stored and Mermaid's renderer is never loaded. The subset is `flowchart`/`graph` with `TB`, `TD`
or `LR`; nodes as `id`, `id[box]`, `id(round)`, `id{diamond}` and `id((circle))`; links `-->`, `---`, `<-->`,
`-->|label|` and `-- label -->`; one level of `subgraph` as the node's group (a node named outside first joins the
subgraph that names it later, as in Mermaid, and one named in two subgraphs is refused); `accTitle` as the title. `%%`
comments and a one-line `accDescr` are passed over, since neither draws anything. A source naming more than 60 nodes or
120 links is refused as soon as it passes the limit.
Everything that configures or extends Mermaid's renderer is refused by line with the reason: `click`, `href`, `call`,
`style`, `classDef`, `class`, `:::`, `linkStyle`, `%%{init}%%` directives, front matter, HTML or entity codes in
labels, Markdown strings, `fa:` icons, other node shapes, other link styles, `&` chains, nested subgraphs and other
diagram types ([diagram-mermaid.ts](../packages/contracts/src/diagram-mermaid.ts)).

`diagram.select` carries `{ selectedId }`; the node checks it against the current props and keeps it in widget state,
so the selection survives a reload, and a restored state ignores an ID the props no longer hold. Each node is a button
whose accessible name says its label, shape, group and the nodes it leads to, comes from and is linked with, each with
the label of the edge joining them ("leads to Ship (yes)"), so a decision's branches are heard as well as seen. One node
is in the tab order; the key along the flow (Down for `TB`, Right for `LR`) follows an edge forward, the opposite key
follows one back, the cross keys step within a layer, Home/End go to the first and last node, Enter/Space select the
focused node or, on the selected one, clear it, and Escape clears. The selected node lights its edges and neighbours with stroke width and dashes as well as colour, and a
live region announces the change. A wide drawing keeps its size and scrolls inside its card, so the page never
scrolls sideways; the diagram has no motion of its own and follows both themes. The semantic document reports the node
and edge counts, the layout and direction, and the selected node with its in/out/linked counts and neighbours, each
with its edge label; the text alternative,
also shown under the drawing, lists every node with its outgoing edges.

Tests: [diagram-view.spec.ts](../packages/contracts/test/diagram-view.spec.ts) checks bounds, malformed graphs, state,
text and semantics; [diagram-mermaid.spec.ts](../packages/contracts/test/diagram-mermaid.spec.ts) checks the subset and
every refused construct; [diagram-layout.spec.ts](../packages/contracts/test/diagram-layout.spec.ts) checks
determinism, layering, no overlap in both directions and the time bound;
[diagram-view.spec.ts](../apps/runtime/test/diagram-view.spec.ts) checks placement, the Mermaid input, refusals,
selection and semantic output; [diagram-view.spec.ts](../packages/conversation-client/test/diagram-view.spec.ts) checks
keyboard movement, accessible names and markup-shaped labels drawn as text; the browser journey
[diagram-view.spec.ts](../apps/web/e2e/diagram-view.spec.ts) covers the conversation, keyboard movement with visible
focus, persisted selection across a reload, a DOM with nothing that runs or loads, the Mermaid input, refusals, both
themes at 390 px, reduced motion and the Widget Library preview.

### 8.13 Maps

`canvas.map@1` draws a bounded set of points, lines and areas over an offline basemap
([#322](https://github.com/digitopvn/clarkcant/issues/322)). Positions are WGS84 `[longitude, latitude]` in a strict
subset of GeoJSON geometry: `Point`, `LineString` and `Polygon` (an outline plus up to 15 holes, each ring closed). A
map holds at most 200 features and 5,000 positions in total. IDs are at most 120 characters, labels 120, descriptions
300 and the title 200. An optional `view` of `{ center, zoom }` (a whole zoom from 0 to 18) replaces the fitted view.
Placement refuses, with the reason: coordinates outside the globe, an unknown geometry type, too many features or
positions, over-long or repeated text, hidden characters, and **any URL**. A key that names a link (`url`, `href`,
`src`, `tile`, `endpoint`, …) or a value that is one (`https://`, `//`, `data:`, `javascript:`, `blob:`) is refused, so
props can never name a host. Geocoding, routing, geolocation, vector tiles, 3D, clustering and editing are not part of
this widget.

The basemap is Natural Earth 1:110m land, version 5.1.2, which is in the public domain. It is generated into
[map-basemap.ts](../packages/conversation-client/src/map-basemap.ts) by
[build-map-basemap.mjs](../tools/build-map-basemap.mjs), which pins the source file's SHA-256, and the map credits it
under every drawing. It ships with the client, so a map with no tile policy makes no request beyond the node.

Raster tiles appear only under the node's tile policy, the registered preference `maps.tilePolicy`. It is `null` by
default. A person writes it in Settings, and Clark writes it through its tool under the execution policy; an AI client
over the socket or MCP cannot write or undo it directly (`isPersonOnlyRoute`). A policy names one provider:

```json
{
  "origin": "https://tiles.example.com",
  "template": "/styles/basic/{z}/{x}/{y}.png",
  "attribution": "© Example contributors",
  "maxZoom": 17,
  "credential": { "secret": "maps:tiles", "header": "x-api-key" }
}
```

`origin` is exactly `scheme://host[:port]`: https, or http only for a loopback address. `template` is a path on that
origin with `{z}`, `{x}` and `{y}` once each. Its query may not carry a key, token, secret or signature. `credential`
is optional. When present, `secret` is always `maps:tiles`, the host's own tile key, and a policy naming any other
secret is refused. `header` or `query` says where the key goes. The page never fetches the provider. It asks the node
for `GET /map-tiles/:z/:x/:y`, and the node:

- builds the address from the policy;
- checks z, x and y against `maxZoom` (at most 19) and the grid;
- does not follow redirects;
- serves only PNG or WebP, checked by both the provider's content type and the bytes, at most 512 KiB, with `nosniff`;
- rate-limits to 12 requests a second with a burst of 48;
- caches up to 256 tiles or 24 MiB, for an hour.

`GET /map-tiles` tells the page the provider's origin, attribution and maximum zoom, never its template or key. With no
policy, every tile request is refused with `MAP_TILES_OFF` and nobody is asked. When the maps are offline-only, the
answer says why in `offline`:

- `no-provider`: no policy is set;
- `key-unavailable`: the policy needs a key and none is saved;
- `key-origin-mismatch`: the saved key was entered for another origin.

In either key case the provider is not handed to the page, so it asks for no tile that would fail, and a tile request
gets `503 MAP_TILE_KEY_UNAVAILABLE` with the same `offline` reason. The map's attribution line states the reason and
where to fix it. The page draws tiles from `blob:` URLs, so the page policy is unchanged.

**The key is bound to its origin.** A person enters the key in **Settings → Extensions → Map tiles**, which stores it
through the person-only `PUT /map-tiles/key` as the node secret `maps:tiles`. The secret's only consumer is
`maps:tiles@<origin>`, the origin the key was entered for. The proxy asks the secret broker for the consumer of the
policy's origin, so the key is sent to that exact origin and nowhere else. `GET /map-tiles/key` answers `{ key: { origin } }`
or `{ key: null }`, never the value, and `DELETE /map-tiles/key` removes the key. The generic credential form
(`POST /credentials`) refuses the name `maps:tiles` and any `maps:tiles` consumer. Nothing but a person entering the key
in Settings binds it, so Clark cannot move it.

A person sets and clears the policy in the same Settings section: provider origin, tile path, attribution, maximum zoom,
and an optional key with the header or query parameter it goes in. The section never shows the key again. It says
"Checking…" until the node answers, then whether a key is saved and which origin it goes to, and it shows an error if
the node cannot say. **Turn tiles off** writes `null`. **Remove key** drops the key from the policy and deletes it.
**Undo last change** restores the previous policy, whoever wrote it.

Clark does the same through its `set_map_tiles` tool, which uses the same `writeMapTilePolicy`
([map-tile-policy.ts](../apps/runtime/src/application/map-tile-policy.ts)). Setting or clearing the policy is an effect
like any other, and the execution policy decides it. In Autonomous mode it runs, with an activity record and the
Settings Undo. In Ask mode it is a host-owned approval card that only the person's decision, on the person-only decide
route, writes. A refusal to run any effect refuses it, including at the moment a card is granted. The preference
records who wrote it: `user` for Settings, `agent` for Clark.

The tool takes only the header or query name, never the key or a secret name. The card and the result say where the
key goes: to the policy's origin, or, for a provider Clark sets at another origin than the key's, nowhere. Such a
provider runs offline-only until the person enters the key again for it. A widget reaches none of this.

The key never reaches the page, props, state, logs, the cache key, an error message or the model. The attribution line
under the map names the tile origin and its attribution, and the map shows no "live" badge.
`map.select` carries `{ selectedId }` (empty to clear) and `map.view` carries `{ center, zoom }`. The node checks both
against the current props and keeps them as widget state. A pan is written 400 ms after it settles, so a run of key
presses is one write. `map.select` is also a composition-graph event with a `selectedId` field.

The map region is focusable and works by keyboard:

- arrows pan, and Shift pans further;
- `+` and `-` zoom, and `0` resets the view;
- `N` and `P` step through the features, and Escape clears the selection.

Pointer drag pans too. On a touch screen, a swipe over a map that has not been tapped scrolls the conversation; once
the map is tapped, a drag pans it. The map is one world that does not repeat: the view stops at the antimeridian, and
the basemap, features and tiles are each drawn once. Zoom-in, zoom-out and reset buttons are 44 px. A live region
states the view once it settles, and the selection. Tiles are asked for once the view settles; one that failed for a
passing reason is asked for again after a pause. Below the map, a table lists every feature with its kind and position. Its Select button selects the
feature on the map and brings it into view, and selecting on the map highlights its row. A pan slides only when motion
is allowed; under reduced motion the view moves at once. Every colour is a theme token. A narrow map moves its controls
under the picture and draws its labels larger, and nothing overflows at 390 px.

The semantic document reports:

- the feature count and the count of each kind;
- the visible bounds and zoom;
- the selected feature's label and coordinates;
- whether tiles are offline or from the policy's origin.

The text fallback lists every feature with its kind and position. Both stay within `SEMANTIC_LIMITS`.

Tests: [map-view.spec.ts](../packages/contracts/test/map-view.spec.ts) checks bounds, URL refusal, projection,
semantics, the tile policy schema and the person-only route;
[map-view.spec.ts](../apps/runtime/test/map-view.spec.ts) checks placement, refusals, state and semantics with and
without a policy; [map-tiles.spec.ts](../apps/runtime/test/map-tiles.spec.ts) checks the proxy's allowlist, content
type, size and zoom bounds, cache, rate, redirect refusal, that the key goes only to its bound origin, and that it is never returned;
[map-tile-policy.spec.ts](../apps/runtime/test/map-tile-policy.spec.ts) checks Settings and Clark setting and clearing
the policy under each execution mode, who is recorded as its author, the card, its digest, denial, the key's origin
binding, the refusal of a policy naming another secret, and that the key is never answered back;
[open-interfaces.spec.ts](../apps/runtime/test/open-interfaces.spec.ts) checks that the relay refuses the policy write,
its undo and the key routes; [map-tile-settings.spec.ts](../apps/web/e2e/map-tile-settings.spec.ts) turns tiles on from
Settings against a local fake provider that refuses requests without the key, sees them on a map, turns them off and
undoes it. It also has Clark set and clear the provider in Autonomous mode and through an approved card in Ask mode, and
shows a provider Clark sets at another origin than the key's running offline with `key-origin-mismatch`;
[map-layout.spec.ts](../packages/conversation-client/test/map-layout.spec.ts) checks the basemap's provenance, the
projection and the tile grid; [map-schemas.spec.ts](../packages/widget-catalog/test/map-schemas.spec.ts) checks the
fixtures and the agreement between schema and runtime. The browser journey
[map-view.spec.ts](../apps/web/e2e/map-view.spec.ts) covers:

- keyboard and table selection, persisted across a reload;
- no requests beyond the node without a policy;
- fixture tiles fetched through the node with their attribution;
- the refusals;
- both themes, reduced motion and 390 px;
- the Widget Library preview.

### 8.14 Audio player and document preview

`canvas.audio@1` plays one audio file and `canvas.document@1` previews the text of a PDF or text file
([#324](https://github.com/digitopvn/clarkcant/issues/324)). Both are host-rendered catalog widgets that a model places
with `show_view`. Neither takes anything the page would have to fetch: a model names a source, and the node reads it,
checks it under the media content policy (§14.5) and stores only what it checked.

**Audio.** A model names exactly one source and a `title`, with an optional `transcript` (at most 4,000 characters):

- `artifactId` or `attachmentId`: a file the person holds in this conversation, such as a WAV they sent (the `audio`
  attachment kind) or a WAV a package service rendered (§14.4);
- `url`: an `https` URL on an origin the node's media policy allows. The node fetches it, checks it, and keeps it as a
  sealed artifact of the conversation, granted to the player, in the same transaction that places the player. That
  artifact can be placed again later by its id, without fetching again.

The node fills in `audioRef` (`artifact:<id>` or `attachment:<id>`, never a URL), `mimeType`, `durationSeconds`,
`sizeBytes` and, for a fetched file, `sourceOrigin`. A model that supplies any of these is refused, so a player never
claims a type or a length nobody checked. The page plays the file from the node through the same authenticated object
URL as a picture, read only once the player is needed (§8.11), with the browser's own controls (keyboard included) and
`preload="metadata"`. It never plays by
itself, on first draw or on restore. The transcript is drawn as text in a disclosure, with any hidden character shown
as a marker. Playback state is the video's: `status`, `position` and `duration` through the `media.view` binding
(state version 2), written through the shared playback coalescer and restored paused at the stored position. Its
semantic document reports the status, the position and the duration in tenths of a second, the title and whether it
has a transcript; until a player reports a duration, the length the node read from the file stands in.

**Document.** A model names exactly one source, `artifactId` or `attachmentId`, a PDF or a text file (`text/plain`,
`text/markdown`, `text/csv`, `text/tab-separated-values`, `application/json`) in this conversation, with an optional
`title`. The node reads the text (a PDF's text through the node's own reader, without a dependency), splits it into at
most 10 pages of at most 2,000 characters, breaking at a line end or a space near the end of a page and never inside a
character, and keeps at most 20,000 characters. It stores the pages, the PDF's own page count when it can read one,
`totalChars` and `truncated`. The preview is text only: pictures and layout are not shown, and nothing in the file is
parsed as markup or run. The page shows a page at a time in a scroll region a keyboard can reach. It has Previous and
Next buttons, the position is announced politely, and a notice says when the preview was cut short and how much of it
is shown. Hidden characters are drawn as markers with a warning. The page a person is on is state
(`{ "page" }`, counted from 0, state version 2; an older state migrates to the first page), written through
`media.view` and checked against the pages the widget holds. The semantic document counts from 1: `currentPage` of
`pageCount`, with `sourcePages` and `truncated`.

Both widgets stay out of composed layouts: each is placed with its own `show_view`, where the node checks its source.
Library cards use sample props with no file on the node; the audio card says it cannot be played rather than pretend,
and the gallery grid never mounts a player.

Tests: [media-content.spec.ts](../packages/contracts/test/media-content.spec.ts) (the policy's URL rules, pagination,
the page state), [media-content.spec.ts](../apps/runtime/test/media-content.spec.ts) (reading each audio type and its
length from its bytes, and the bounded fetch against a real local https origin),
[media-views.spec.ts](../apps/runtime/test/media-views.spec.ts) (placement, refusals, stored artifacts, state and
semantic bounds), [pdf-text.spec.ts](../apps/runtime/test/pdf-text.spec.ts) (the page count),
[media-renderers.spec.ts](../packages/conversation-client/test/media-renderers.spec.ts) and the browser journey
[audio-document.spec.ts](../apps/web/e2e/audio-document.spec.ts). The journey fetches audio from a local https origin
named in the policy and from its stored ArtifactRef. It checks the origin heard only the node and the page asked only
its own origins, plays and pauses from the keyboard, and reloads to the paused position. It pages a document from the
keyboard and keeps the page over a reload, and covers both themes, 390 px, reduced motion and the Library previews.

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
  declared graph values. Media widgets are described from validated props and their bounded view state only: an
  image's alt text and known dimensions, a gallery's or carousel's selected item (`selectedNumber`, counted from
  1), a local video's playback status and position (a "playing" the player stopped renewing is read as paused), and a YouTube video's validated id and title ([§8.11](#811-media-widgets-and-semantic-state)).
- **A widget in its own frame** proposes a summary, selected IDs and values with
  `semantic.publish(summary, selectedIds, values?)`. The host sends the last of a burst after 250 ms, validates it
  against a strict schema (`POST …/widgets/{instanceId}/semantic`), cleans it and marks it as the widget's own words. A
  frame cannot name actions: the actions always come from the instance's bindings, so a frame cannot advertise an
  action it was not bound to.

  A press can read what the frame published: an `agent` binding's `contextRefs` (`selection:…`, `widget:…`). Before
  such a press runs, the host sends any publish still settling and waits until the node holds the description published
  before the press, or a newer one, so the press never reads an older description. Publishes made after the press are
  sent as usual but not waited for, so a widget that keeps publishing cannot hold a press. Any other press
  waits only for a publish still settling, or for one the node refused last. The wait is bounded: each send is given
  up after 5 seconds and the whole wait after 8. A description the node refused is sent once more; if that fails too,
  or the wait runs out, `actions.invoke` rejects with the host's refusal ("What the widget shows did not reach Clark in
  time, so this action did not run…"). Nothing in the frame changes, and the person can press again. A widget should
  show that refusal where the press was made.

While developing a package, the semantic inspector shows the document after the same normalization, its delta, the
next-turn context note and `inspect_ui`. It marks proposed fields the normalizer clipped or dropped and warns above
four publishes per second. These diagnostics do not run a model turn or change the runtime's limits.

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
    actions.offer(name, handler)

    capabilities.request(ref, justification)

    host.focus()
    host.resize({ height })
    host.requestPin()
    host.requestDetach()
    host.openExternal(approvedUrl)

    semantic.publish(summary, selectedIds, values?)

    artifacts.available()
    artifacts.pick({ accept? })
    artifacts.read(ref, { offset, length })
    artifacts.create({ mimeType, name? })
    artifacts.write(ref, chunk)
    artifacts.finalize(ref)
    artifacts.export(ref, { suggestedName })
    artifacts.attachToConversation(ref, { name? })
    artifacts.discard(ref)

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

### Appearance (`appearance@1`)

`appearance.current()` returns the checked, deeply frozen `AppearanceSnapshot` used to draw this widget, or `undefined`
when the host did not offer the extension. `appearance.subscribe(handler)` follows changed revisions and returns an
unsubscribe function. The initial snapshot is available before `lifecycle.onMount`; changes do not remount the frame,
write state, publish semantic content, or start a model turn. The snapshot resolves the actual light/dark scope and
reduced motion. It contains bounded public tokens and a revision, never a raw theme, credentials or host access.

The SDK core has no DOM dependency. For a DOM widget, import `bindAppearance` from `@clarkcant/widget-sdk/dom`, then
call `const unbind = bindAppearance(document.documentElement, api.appearance)` and call `unbind()` on disposal.
`applyAppearanceToElement(element, snapshot)` applies a single checked snapshot. These helpers write only the canonical
token variables and appearance attributes on the supplied element; unrelated author variables remain. The host-served
`/widget-runtime.js` also exports these helpers.

Widget definitions may declare `"appearanceMode": "fixed"` for their own visual system; absent or `"adaptive"` means
adaptive. Widget Lab and detail cards disclose fixed mode. Directory entries may carry optional `widgetAppearance`
claims (`[{ "id": "…", "mode": "fixed" }]`) for marketplace disclosure; the installed, digest-checked definition
remains authoritative. A fixed widget still receives appearance and must respect reduced motion.

Bridge version 2 carries an optional initial `appearance` and advertises `appearance@1`; live messages are
`{ kind: "appearance.changed", nonce, revision, appearance }`, with matching revisions and the existing source/nonce
checks. The new SDK accepts version-1 hosts without this extension. A bundled old version-1 SDK must be upgraded for
a version-2 host; use the host-provided runtime or rebuild with the current SDK. A detached composition receives the
same resolved revision through the desktop's read-only bootstrap/event relay, without fetching a theme or receiving
credentials. Appearance changes leave saved presentations, props, state, provenance and fallback text intact.

### 10.1 Files by reference (`artifacts@1`)

A widget in its own frame can work with files without ever holding one. It holds an `ArtifactRef`:

    { "v": 1, "artifactId": "art_…", "kind": "external", "mimeType": "text/plain",
      "sizeBytes": 302420, "name": "bao-cao.txt", "digest": "sha256:…" }

A ref says what a file is: its kind, type, size, display name and, once the bytes are fixed, their digest. It never
says where the file is. No ref, bridge message, prop, state, log line or prompt carries a path, a staging name or the
folder a picked file came from. **A ref is a pointer, not a permission.** The node re-checks every use against the
owner, this instance's grant, the grant's expiry and revocation, and the artifact's own state. A ref copied into
another widget or another principal's request is refused there with a reason. The contract is
[artifacts.ts](../packages/contracts/src/artifacts.ts).

The extension is offered in the bridge's `init.extensions`. `artifacts.available()` says whether this host offered
it, and every call rejects locally when it did not. The host offers it to every isolated frame in a conversation.

| Kind | What it is | What may be done with it |
| --- | --- | --- |
| `external` | A snapshot of a file the person picked in host chrome. | Read. Sealed, with a digest. |
| `working` | Bytes this instance is writing. | Written by the instance that created it, in order. Expires 24 hours after its last write unless finalized. |
| `finalized` | A working artifact whose bytes are now fixed. | Read, exported, attached. Kept as long as its conversation. |
| `attachment` | Reserved for a file the person attached, handed to a widget. No host flow produces one yet. | – |

What each call does:

- `pick({ accept })` asks the person to choose a file. The widget does not open a dialog; the host draws its own
  prompt outside the frame. It names the widget by its title, says the widget learns only the chosen file and never
  its location, and lists the accepted types in words ("text files", "PNG image"). The prompt takes the keyboard at its
  title, not at a button, so a key the person pressed for the widget cannot answer it. It does so only when the
  keyboard was in the frame or the host chrome around it; while the person is typing elsewhere, such as in the
  composer, the prompt is announced and waits beside the frame. Escape or Cancel resolves
  `undefined`. On the desktop the prompt opens the operating
  system's file dialog; on the web it opens the browser's file input. The node decides the type from the bytes, checks
  it against `accept`, and applies the attachment rules: allowlisted types, 25 MiB a file, and the principal's quota.
  The type a system gives is only a claim, read under the name the node uses: `application/vnd.ms-excel` for a
  `.csv` on Windows is CSV, and `image/jpg` is JPEG. A missing or generic type (`application/octet-stream`) is
  taken from the extension for Markdown, CSV, TSV and JSON, and otherwise read from the bytes. Tab-separated values
  (`text/tab-separated-values`, saved as `.tsv`, also named `text/tsv` or `.tab`) follow the same rules as CSV.
  Characters that reverse how a name reads (bidi controls) are dropped from the file's name.
- `read(ref, { offset, length })` reads one range of at most 256 KiB and says whether it reached the end. A larger
  file takes several reads.
- `create({ mimeType, name? })` starts a working artifact of a type the attachment pipeline accepts.
  `write(ref, chunk)` appends at most 256 KiB. Each write must start where the artifact ends, so a chunk sent twice or
  out of order is refused (`ARTIFACT_OFFSET_MISMATCH`) instead of stored twice. A write extends the artifact's life and
  the writer's grant.
- `finalize(ref)` fixes the bytes. The node sniffs them against the declared type. If they disagree it refuses with
  `ARTIFACT_TYPE_MISMATCH` and leaves the artifact writable, so the widget can correct it.
- `export(ref, { suggestedName })` asks the person to save a copy, in the host's own Save As prompt, which names the
  widget. It resolves `true` when the file was saved or, on the web, when the download started, and `false` when the
  person declined. The saved name keeps the suggestion but takes the extension of the bytes' type, so a `text/plain`
  file suggested as `invoice.bat` is saved as `invoice.txt`. The desktop uses the operating system's save dialog,
  offering only that type's extensions. When the person picked a file on the desktop in this frame and the widget exports
  a file of the same type, the prompt also offers "Replace “original” with “new”". It names both files, because
  nothing proves the widget's file was made from the one picked. The path behind it stays in the desktop's main
  process, and the operating system asks before overwriting. The new bytes are written beside the original and renamed
  over it, so a failed write leaves the original as it was. The original keeps its permissions, a link is followed to
  the file it names, and on Windows the rename is retried briefly while another program, such as an indexer or
  antivirus, holds the file. The web hands the file to the browser's download and says
  "Download started", because the browser, not the page, decides where it goes; it also says that replacing the
  original is a desktop feature.
- `attachToConversation(ref)` hands a finalized artifact to the attachment pipeline. The bytes are sniffed again and
  the allowlist, size and quota are checked. The result is a ready chip in the composer, which the person sends with
  their next message like any file they attached. The model then reads it the same way. A file is attached once:
  asking again returns the same attachment.
  The optional `name` proposes the attachment's file name. It is reduced, never refused: the runtime leaves out an
  empty name and cuts a long one to the bridge's 200 characters before it sends it. The node then keeps the last part
  of anything that looks like a path, and drops control, format, direction and invisible (default-ignorable)
  characters. It turns every character other than letters, digits, space and `. _ - ( )` into a dash, collapses `..`,
  trims dots, dashes and spaces from both ends, and shortens the name to 100 characters. It also forces the extension
  of the bytes' type: a PNG proposed as `anh.exe` is attached as `anh.png`, and one proposed as `kite-v2.1` as
  `kite-v2.1.png`. When nothing usable is left, the node uses the type's default name, such as `untitled.png`.
  Without `name`, the attachment takes the artifact's own name, sanitized the same way. The first attach decides the
  name: attaching the same file again returns that attachment, whatever name the later call proposes.
- `discard(ref)` lets go of a file this instance made, working or finalized: its record and grants go, and its bytes
  go too unless an attachment or another record still points at them. It waits for the ref's pending writes first. A
  file the person picked, or one another widget made, is refused with `ARTIFACT_NOT_CREATOR`.

Refusals reject with the host's code first (`ARTIFACT_GRANT_EXPIRED: …`). The codes are listed in
`ARTIFACT_REFUSAL_CODES`. The host tells the person why a pick or a save did not happen in their language, chosen by
the refusal's code; the widget gets the code and a fixed sentence, and nothing from the desktop's file system beyond
its own error code (`EBUSY`), never a path. Picking and saving are the person's acts: the node refuses them on machine
surfaces ([open-interfaces.md](open-interfaces.md)), and a widget cannot perform either without the host's prompt.

A widget's own writes (`create`, `write`, `finalize`, `attach`, `discard`) reach the node through its host and run
as before. The same routes carried by a machine surface (MCP, the WebSocket relay or `clarkcant api`) are an AI client
or a remote machine writing as the widget. The node decides each such write with the person's execution policy, as a
`local-write` effect, or `destructive` for discarding a file that is not an unfinished one the same relay connection (or, for MCP and `clarkcant api`, the same surface) started: it
runs, it waits for the person on an approval card (one per file, never with bytes), or it is refused. Every such write
is audited with the surface, the instance, the artifact and the decision, never the bytes
([open-interfaces.md](open-interfaces.md)). A widget does not need to handle this: its own calls are never asked about.

A frame's file requests are rate-limited: a burst of 300, then 10 a second, counted before a request is checked, and at
most 4 wait for an answer at once. A message from another window is refused before it is counted, so one widget
cannot spend another's rate. The SDK queues the rest, so a widget that reads a large file in a loop is paced
rather than refused. A request over the rate is answered with `ARTIFACT_RATE_LIMITED`, and the frame keeps working.

What the node keeps:

- **One store and one quota.** An artifact's bytes are stored in the node's blob store, the same one attachments use.
  They count against the principal's attachment quota (1 GiB). An attached artifact counts once as an artifact and
  once as an attachment. Inside that quota one widget instance may hold at most 128 MiB
  (`ARTIFACT_INSTANCE_QUOTA_EXCEEDED`). The share counts the files the widget made and the attachments it made from
  them, for as long as those attachments are kept. It does not count files the person picked for it, since only the
  person can add one and the widget cannot let go of it; those count against the person's quota alone. `discard`
  gives a file's room back; an attachment made from it keeps its own until it goes. A widget refused because the
  person's quota is full is told only that, never how much the person stores.
- **Grants belong to one instance.** A grant lasts 24 hours from the pick or from the instance's last write, and a
  write renews it. A widget keeps reading a file it wrote and finalized for as long as that file is there; a file the
  person picked must be picked again after 24 hours. Grants are checked on every use; nothing sweeps them. A revoked
  grant stops the next call, but no surface lets the person revoke one yet. Deleting its conversation releases the
  artifact and its grants together; this does not add a separate stop-sharing control.
- **Retention.** Working artifacts that time out are removed every 10 minutes, and before a new artifact is stored.
  When the node starts, it removes staged bytes a previous process left behind that no working artifact still writes.
  Finalized artifacts last as long as their conversation, including files finalized but never attached. The person's
  [conversation deletion](open-interfaces.md#conversation-deletion) releases them, their grants and attachments in one
  transaction. After commit, bytes no retained attachment, artifact, image, task evidence or message shares are removed.
  Failed file removals stay in a durable queue, retried at startup and on the 10-minute sweep; the result reports pending
  cleanup. There is no Undo copy, so the quota is released immediately. Saved memory, independent resources, session logs
  and audit history remain; this is not an erase-everything operation. Unfinished or uncertain work must be settled first.

Tests: [artifacts.spec.ts](../packages/contracts/test/artifacts.spec.ts) for the rules,
[artifact-refs.spec.ts](../packages/storage/test/artifact-refs.spec.ts) for storage,
[artifact-broker.spec.ts](../apps/runtime/test/artifact-broker.spec.ts) for the node and its routes,
[artifact-server.spec.ts](../apps/runtime/test/artifact-server.spec.ts) for Vietnamese file names over a real socket,
[action-widget.spec.ts](../apps/runtime/test/action-widget.spec.ts) for `artifact:<id>` context references,
[runtime.spec.ts](../packages/widget-sdk/test/runtime.spec.ts) and
[session.spec.ts](../packages/widget-host/test/session.spec.ts) for the bridge,
[widget-artifacts.spec.ts](../packages/conversation-client/test/widget-artifacts.spec.ts) for the page,
[file-bridge.spec.ts](../apps/desktop/test/file-bridge.spec.ts) for the desktop's dialogs, and the browser journey
[widget-artifacts.spec.ts](../apps/web/e2e/widget-artifacts.spec.ts). The journey picks a file larger than one
chunk, reads it in two ranges, writes and saves a copy, attaches it, and opens it again from a file card. It runs in
both themes and at 390 px.

### 10.2 Long-running jobs (`jobs@1`)

A package capability whose work outlasts one press declares it in its tools facet:

    { "ref": "com.example.notes.export@1", "tool": "export_notes", "effectCategory": "read",
      "execution": { "kind": "job", "version": 1 } }

A press on a binding to that capability does not wait for the service to finish. `actions.invoke` resolves with a
**JobRef**, an opaque `job_…` id, and the node runs the call in the background. The widget keeps the JobRef in its own
state, so a remounted frame can follow the same job:

    const jobId = await api.actions.invoke("binding_notes_export", { steps: 12, stepMs: 1500 }, invocationId);
    await api.state.update((state) => ({ ...state, exportJob: jobId }), { exportJob: jobId });
    const stop = api.jobs.subscribe(jobId, (job) => render(job));

`jobs.available()` says whether the host offered `jobs@1` in `init.extensions`; every call rejects locally when it did
not. `jobs.get(ref)` reads one snapshot: status (`queued`, `running`, `waiting`, `completed`, `failed`, `cancelled`),
progress, output, error, result files and times. `jobs.subscribe(ref, handler)` starts from that snapshot, polls once a
second, hands the handler only snapshots that changed, and stops by itself at an ending, on `JOB_NOT_FOUND` or
`EXTENSION_NOT_OFFERED`, or after 30 refused reads in a row. `jobs.cancel(ref)` asks the node to stop the job; one that
already ended is refused with `JOB_NOT_RUNNING`. `jobs.list()` returns the jobs this widget's own bindings started,
newest first and at most 20, including ones started by voice or by Clark for this widget, so a widget can show work it
did not start from a click. The contract is [jobs.ts](../packages/contracts/src/jobs.ts).

**Listing is its own extension, `jobs.list@1`.** It came after `jobs@1`, and a host that offers only `jobs@1` would
refuse `{ op: "list" }` as outside its schema and never answer it. So a host that answers it also offers `jobs.list@1`
in `init.extensions`, and `jobs.canList()` says whether it did; `jobs.list()` rejects locally, without sending anything,
when it did not. A widget that lists checks first and degrades: without a list, it shows the jobs started while it is
open (the JobRefs `actions.invoke` returned, followed with `jobs.subscribe`) and says that earlier ones are not shown.
The SDK constant is `JOBS_LIST_EXTENSION`. A listed job has the same fields as one read with `jobs.get`.

**A failed job's `error` may carry the service's own words.** When the service's tool reports an error, the node keeps
its text, quoted, inside a sentence of its own: `The package service reported an error: “…”. Its effect may have
happened; review before retrying.` The quoted part is the service's, which may be the provider's: control and
invisible formatting characters (bidi overrides included) are removed and it is cut at 400 characters, but it is not
otherwise vouched for. Show it as what the service said, inside text of your own, not as the widget's or the host's
sentence. The node removes a provider key from what the provider sends back before the service reads it, so a
provider that echoes the key leaves `[redacted]` in its place.

**A JobRef is a pointer, not a permission.** The node re-checks every read and cancel against the job's owner: the
principal, the widget instance, its binding and the package generation that binding was authorized under, and the
capability. Any mismatch, including a ref copied into another widget, is answered `JOB_NOT_FOUND`, the same as a ref
that never existed.

What a job reports is the service's own: progress comes only from MCP `notifications/progress` the service sends for
the call, and files it returns become `ArtifactRef`s the widget can read through `artifacts@1`. Job reads have their
own budget per frame session (a burst of 60, then 5 a second, at most 4 waiting at once), separate from the message
budget, so a widget following a job does not starve its other bridge calls.

A job may run for up to 30 minutes instead of the 60-second press deadline; past that it ends as failed. While it
runs it is listed with the node's running work (`GET /work`), and stopping it there (`POST /work/{id}/cancel`),
emergency Stop and node shutdown cancel it. The conversation's Stop ends the reply and a press still waiting, not a
job that is already running, the same as other background work. A cancel tells the service
through MCP cancellation; because the service may have finished its effect before it heard, the ending says the job
"may already have completed its effect" rather than claiming nothing happened. A job still open when the node
restarts is marked failed with that explanation; it is never run again by itself.

When a job ends, the conversation gets a note naming the capability, up to three result files and what to do next,
and the inbox records the same ending. If the execution policy asks before the capability runs, the press shows the
host's approval card first, and the job starts only after a person approves it there; the widget never approves its
own job. A conversation with an open job cannot be deleted until the job ends or is cancelled.

Tests: [jobs.spec.ts](../packages/contracts/test/jobs.spec.ts) for the rules,
[job-host.spec.ts](../apps/runtime/test/job-host.spec.ts) for the node's job host, Stop and restart,
[action-widget.spec.ts](../apps/runtime/test/action-widget.spec.ts) for presses, approvals and the bridge routes,
[runtime.spec.ts](../packages/widget-sdk/test/runtime.spec.ts) for the SDK, and the browser journey
[package-job.spec.ts](../apps/web/e2e/package-job.spec.ts). The journey follows a real service's progress across a
reload, refuses a forged JobRef, cancels from the widget, completes with a file and ends a job with emergency Stop.

### 10.3 Actions Clark performs (`actions.perform@1`)

An isolated widget can let Clark do something inside it, such as format the selected cells or replace the selected
text. The widget declares what it offers; Clark asks; the frame does it and says what happened. Clark never writes
into the frame and never approves the action itself.

**Declaring.** The definition lists `offeredActions` (at most 16). Each has a `name`, a `label`, a `description` and an
object `inputSchema`. A name starts with a lowercase letter and holds at most 64 letters, digits, `.`, `_` or `-`. An
offered action is a `perform {action}` proposal. It compiles like any action binding, with the effect category
`local-write` and the declared input schema. An action the definition does not offer is refused when it is compiled.

**Placing.** The agent tool `place_widget` places a widget from an installed, active package whose renderer is
`isolated-app`. `list` shows each installed widget's id, props and state schemas, offered actions, and its own
package's service capabilities with their effect category, readiness and input schema. `place` binds every offered
action, plus up to 4 optional buttons. Each button is bound into a string prop the widget reads, and names the prop and
the label. It then either asks Clark, with an intent and optional `contextRefs`, or calls a capability, with
`capabilityRef`, `inputs` and `stateInputs` ([#445](https://github.com/digitopvn/clarkcant/issues/445)):

- `inputs` are the arguments the widget sends with a press. `stateInputs` are read from the widget's own state when it
  is pressed, and a value the press sends under the same key wins.
- The capability must be served by the active generation of the package the widget's definition is read from: the
  package the node loads the widget's frame from, matched by package id and version. Widget ids are not namespaced, so
  another package that declares the same widget id grants nothing. A widget is never bound to another package's
  service. `list` shows a widget only under its own package's capabilities. A package with widgets that was recorded
  before the node kept its widget ids is named, after the widgets, as one to reinstall or update to list them; its
  widgets still place by id.
- The host compiles the button as an `invoke` binding. The effect category comes from the registry, the binding is
  pinned to the serving generation, and the recorded input schema is the capability's own, cut down to `inputs`. If the
  service has not listed its tools yet, only the names are recorded; every call is still checked against the
  capability's own schema when it runs. Definitions the schema's properties refer to (`$defs`, `definitions`) are
  carried with it.
- A capability whose input schema does not set `additionalProperties: false` takes any argument name. The model can
  then name any argument in `inputs`, and the press accepts any value for a name the schema does not describe.
  Declare `additionalProperties: false` and a schema for every argument a widget may send.
- A capability that is not ready yet, for example one still missing its key or connection, is still bound. The frame's
  live view lists the binding as unavailable with the node's reason until it is ready. A capability the node has not
  registered at all yet is refused with a sentence that says to try again. This happens on a service's first start,
  before it has written its rows.

Every press then goes through the same `invokeCapability` path, the execution policy and the effect ledger as any other
`invoke`. Placing is all or nothing. Two buttons on one prop, a prop given both as a value and as a button, a state key
the widget's state schema does not hold, or a binding the host refuses leaves nothing created. This is the product path
that gives a package widget its bindings in a real installation.

**Performing.** The agent tool `perform_widget_action` has two actions. `list` shows the actions offered by widgets in
this conversation, with their binding ids and input schemas. `perform` runs one by its binding id. It takes the same
path as a press:

- the binding's gate;
- the input checked against the declared schema (`INVALID_INPUT`);
- the execution policy;
- the effect ledger;
- the audit line "Clark asked widget … to perform …".

The policy is told who asked for the turn (`TurnOrigin`). A perform is a `local-write`, which is not a risky effect, so
`machineTurns: "ask"` alone does not ask about it; a rule or mode that asks does. Who asked is written on the approval
card and on the audit lines, also after the person approves.

The result is marked as Clark's (`performedBy: "clark"`). What the widget said is given to the model as data, never as
instructions. A person's click on a perform binding is refused (`NOT_AUTHORIZED`): the frame's own buttons do the work
directly. Perform bindings are not listed among the widget's presses, so neither the frame nor a spoken command can
press one.

**The policy decides, and the person approves.** A policy that denies refuses with `POLICY_REFUSED`. A policy that asks
puts a host-owned approval card in the conversation, and nothing is sent until the person approves it. The card shows
the whole input: its description carries it for the inbox and a spoken question, and the card lays it out in full. An
input longer than 1,200 characters as JSON is refused with `PERFORM_INPUT_TOO_LONG` instead of being shown in part.
Asking again for the same action with the same input while its card waits returns that card's approval, not a second
card, and a conversation holds at most 8 waiting perform cards (`PERFORM_CARDS_WAITING` after that). Approving asks
the frame then, but only if the screen you approve on still shows the widget; approving from the inbox, or from a page
without the widget, is answered "approved, not performed", with nothing sent. The approval re-checks the card's payload
against the decided digest (which covers the conversation, the widget, the binding, the action and the input), the
binding, the input, the policy and the ledger. Neither the widget nor the model can approve.

**The frame does it.** The node sends a versioned `widget-perform` event (`v: 1`) only to a caller that said it can run
one:

- a page stream request carrying the `x-clarkcant-widget-perform: 1` header;
- a voice session whose `auth` frame carries `widgetPerform: 1`.

The page hands the event to the mounted frame as `action.perform`. It then reports the frame's `action.performed`
answer at `POST /app-intents/widget-perform/{performId}` ([open interfaces](open-interfaces.md)). In the frame:

```js
const stop = api.actions.offer("format", async (input) => {
  if (busy) throw api.actions.refuse("SHEET_BUSY", "the sheet is busy; try again in a moment.");
  applyFormat(input.format);
  return `Formatted ${selection} as ${input.format}.`; // what Clark is told, at most 4,000 characters
});
```

The handler gets a frozen copy of the checked input. A returned string is the tool's result. An error made by
`api.actions.refuse(code, message)` is the widget's deliberate refusal: the node answers `WIDGET_REFUSED` with the
widget's own code in `widgetCode`, kept apart from the host's codes. Only throw it before changing anything. Any other
error is reported as `failed`, which Clark treats as an uncertain outcome, because the handler may already have changed
something. That includes an error whose message merely looks coded, and the SDK's own rejections, such as a refused
state write (`STATE_REVISION_STALE: …`) or artifact request, even though they carry a code. An action
with no handler is refused with `ACTION_NOT_OFFERED`. Output that carries a token is dropped, and the outcome becomes
uncertain.

**Not open means not performed.** A perform is refused with `FRAME_NOT_MOUNTED` in these cases:

- no page is showing the widget;
- the caller running the turn cannot reach a frame (the CLI, a relay, an older page, or a detached desktop window);
- the frame is not mounted.

A page whose conversation changed before it could ask answers `SURFACE_GONE`. A page that cannot read the event
answers `PERFORM_UNREADABLE`, or `PERFORM_VERSION_UNSUPPORTED` for another version. Nothing is queued for later and
nothing reaches the widget.

A frame has 6 seconds to answer; the node waits at most 8. The outcome is uncertain (`WIDGET_NO_ANSWER`,
`WIDGET_PERFORM_STOPPED`) in these cases:

- the frame does not answer;
- the frame fails while performing;
- a Stop arrives during the wait.

The ledger records an uncertain outcome as unknown. Until the person settles it, the same action with the same input on
the same widget is refused with `PERFORM_OUTCOME_UNKNOWN`. A refusal frees the invocation, so the action can be tried
again.

**Voice.** A spoken request reaches the same tool through Clark's turn in the voice session. A spoken press of an
offered action, matched by its label on the focused widget, goes through the same `invokeWidgetAction` path as the tool:
the same declared schema, execution policy, ledger, and origin (`voice`, asked by the person). The ledger and the audit
log record that the person asked by voice. Voice does not ask for a spoken yes first; the execution policy decides
once. When the policy asks, the host card and its approval are written together, before voice says so. The person
answers the card there by click, or by the spoken yes or no that voice then asks for. The spoken answer goes through the
same decision a click makes, and the press never approves itself. A sentence decides it only when every word in it is
a yes word ("yes", "ok", "go ahead", "đồng ý", "được"), or every word is a no word ("no", "cancel", "don't", "không",
"thôi"), with nothing else but fillers such as "please" or "nhé". Any other word, a question, or a mix of yes and no
decides nothing, and voice asks again: "not ok", "is it ok", "yes, don't", "chưa được" and "từ từ đã" all get the
question again. Once the card is decided by a
click or has expired, the next sentence is no longer taken as its answer. After a spoken yes, voice says what the
decision came to: whether the widget did it, and what the widget answered as the widget's own words, never "running it
now". Saying the same action again while that card waits points to it and asks again; no second card is drawn. The
request reaches the frame through the voice session's own page, and only when that page sent `widgetPerform: 1` in its
auth frame. Otherwise the press is refused before anything is sent, and the person is told to ask Clark instead. A press
whose session closed before the request went out is recorded as not sent, not as an unknown outcome. What the widget
answers, after a direct press or a spoken yes, is read out as the widget's words ("The widget says: …"), on one line, in
the person's language, with its quotes neutralised and bidi or zero-width controls removed. A press that fails on the
node is said as failed, in the person's language, and the session goes on. The voice resolver matches labels, so a
sentence that implies the arguments without naming the label, such as `format this as a percentage`, is not matched
yet ([#444](https://github.com/digitopvn/clarkcant/issues/444)).

Tests:

- [widget-perform.spec.ts](../apps/runtime/test/widget-perform.spec.ts): the undeclared action, schema mismatch,
  unmounted frame, a caller that cannot perform, page and widget refusals, failure, timeout, Stop, the
  uncertain-outcome guard, policy and the approval card, voice, the press lists, the tools and placement.
- [app-intents.spec.ts](../apps/runtime/test/app-intents.spec.ts): the page's report.
- [frame-performs.spec.ts](../packages/conversation-client/test/frame-performs.spec.ts): the page's frame lookup and
  answers.
- [session.spec.ts](../packages/widget-host/test/session.spec.ts) and
  [runtime.spec.ts](../packages/widget-sdk/test/runtime.spec.ts): the bridge.
- The browser journey [widget-perform.spec.ts](../apps/web/e2e/widget-perform.spec.ts): formats a spreadsheet range
  and replaces an editor's selection from what the person types in the composer. It also checks that a plain HTTP
  stream and a closed widget are both refused with `FRAME_NOT_MOUNTED`.

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

A short-lived, scoped browser token is the one exception to "a widget never holds a provider credential", and only
where a package declares it (§14.3). Long-lived keys stay in the node: a service reaches its provider through the
node, which adds the key itself (§14.2).

### 14.1 Resource profiles

A package asks for what its code runs with by naming a profile, never with numbers:

    "resources": { "version": 1, "profile": "interactive-heavy" }

The node owns the table ([resource-profiles.ts](../packages/contracts/src/resource-profiles.ts)) and decides what it
grants. A package that names nothing runs as `interactive-light`, which is the envelope every service ran in before
profiles existed, value for value, so an existing package runs exactly as it did.

| Profile | Memory / CPUs / processes / `/tmp` | Per call | Per job | Jobs at once | Out of view |
|---|---|---|---|---|---|
| `interactive-light` | 256 MiB / 1 / 128 / 16 MiB | 60 s | 30 min | 4 | unmounted |
| `interactive-heavy` | 1 GiB / 2 / 256 / 64 MiB | 120 s | 30 min | 2 | unmounted |
| `media-workstation` | 4 GiB / 4 / 512 / 512 MiB | 300 s | 2 h | 1 | may keep playing |
| `background-compute` | 2 GiB / 2 / 256 / 256 MiB | 60 s | 4 h | 2 | unmounted |

Every profile has no network of its own (`--network none`; a service reaches a provider only through the node, §14.2)
and a `noexec` `/tmp` as its only scratch space: the rest of the root, `/run`, `/var/tmp` and `/dev` included, is
read-only under both Docker and Podman. There is no writable `/dev/shm`: Docker mounts none, and Podman's is read-only,
so a dependency that needs POSIX shared memory (`shm_open`, some native addons, headless Chromium) does not work in a
service. Neither engine keeps a copy of what a service writes to its standard output (`--log-driver none`). CI checks
this on Linux; Docker Desktop and Podman machine on macOS and Windows are checked by hand
([platform-smoke.md](platform-smoke.md)). Services and jobs keep running whether or not a
frame is mounted. The largest result file stays the attachment maximum, because a file a service returns must stay
attachable to a conversation. The three larger profiles are engineering defaults a reviewer can change in that file.
The bounds reach the container's `--memory`, `--cpus`, `--pids-limit` and `/tmp` size, the call and job deadlines, and
the job host's concurrency.

The decision, `decideResourceProfile`, takes these steps in order:

1. A GPU is never granted: the node does not pass one through to a container.
2. `interactive-light` is always granted.
3. A refusal from the execution policy wins.
4. A profile is not granted when it needs more CPUs than the container engine reports, or more than half its memory.

A profile that cannot be granted is never swapped for a smaller one. The package is degraded: its services are not
started, and each capability shows the reason. Settings → Extensions shows the profile beside each installed package:
its bounds when granted, or "Asked for …, not granted: …" when not. The capacity is what the engine reports, kept
once the engine answers. An engine that did not answer is asked again at the next start. Under Docker Desktop the
capacity is its Linux VM's.

Podman parity gap: rootless Podman without delegated cgroup v2 controllers accepts `--memory` and `--cpus` and does not
apply them. The node grants the profile there with the note "the container engine does not enforce memory and CPU
limits here", which package details show. The real-engine test
[`service-container-engine.spec.ts`](../apps/runtime/test/service-container-engine.spec.ts) checks the limits a
running container gets.

**Out of view.** A frame unmounts when it scrolls out of view. A frame whose package was granted `media-workstation`
gets a host-chrome toggle, "Keep playing when scrolled away". While it is on, the frame stays mounted out of view, and
the host says "<title> is still running out of view". It is off for each new mount, and the widget cannot turn it on.
A frame of any other profile is offered no toggle and unmounts out of view. Stop still ends a frame that plays out of
view. Tests: [offscreen-playback.spec.ts](../packages/conversation-client/test/offscreen-playback.spec.ts) for the
decision, and the browser journey [offscreen-playback.spec.ts](../apps/web/e2e/offscreen-playback.spec.ts).

### 14.2 Reaching a provider from a service

A `tools` facet declares the secrets it needs and the origins it may reach:

    "egress": {
      "version": 1,
      "secrets": [{ "name": "LOOKUP_API_KEY", "purpose": "Signs the lookups in with the provider." }],
      "origins": [{
        "origin": "https://api.example.com",
        "purpose": "Looks up the words you ask about.",
        "credential": { "secret": "LOOKUP_API_KEY", "header": "authorization", "scheme": "bearer" }
      }]
    }

The container still has no network, and the service never holds the key. The node offers egress in MCP `initialize`
(`capabilities.experimental["clarkcant/egress"]`, `version: 1`). The service then sends the node the request
`clarkcant/egress.fetch` with `{ version: 1, url, method?, headers?, body? }` over the same stdio connection, and the
node makes the HTTP request itself
([service-egress.ts](../packages/contracts/src/service-egress.ts), [the broker](../apps/runtime/src/service-egress.ts)):

- only to a declared origin, compared exactly, and never to a URL with credentials in it;
- not to a loopback, private or link-local origin (`localhost`, `127.0.0.0/8`, `0.0.0.0/8`, `10.0.0.0/8`,
  `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `::`, `fc00::/7`, `fe80::/10` and their IPv4-mapped
  forms), even a declared one, unless the person started the node with `CC_EGRESS_ALLOW_PRIVATE_NETWORK=1`. The default
  is off. This is a node setting, and no manifest field turns it on. The check reads the URL's host. It does not check
  what a public name resolves to;
- only while a host call to that service is in flight. Its requests stop when the last call ends, is cancelled, or the
  service is stopped;
- only with a method the calls in flight allow. While each call was decided as `read` or `local-write`, a request may
  only `GET` or `HEAD`. Any other method changes something at the provider and needs a call decided as
  `external-write`, `destructive`, `financial` or `communication`, which the execution policy's risk gate asks about. A
  request does not say which call it serves, so the effects of all calls in flight together bound it;
- not at all while a call in flight holds a person's file (§14.4), unless each such call was decided as
  `external-write`, `communication`, `destructive` or `financial`. A request could carry the file's bytes, a `GET` as
  well as a `POST`, so a call decided as `read` or `local-write` that holds a file gets `-32019` until it ends;
- at most a burst of 30 requests per running service, refilled at 10 a second;
- with the declared header added by the node from the secret the person stored for the consumer `package:<id>`. A
  header of that name the service sets is dropped;
- with cookie, proxy, forwarding and framing headers stripped, at most 1 MiB sent and 2 MiB returned, and 30 s per
  request. The node asks for an uncompressed answer itself (`accept-encoding: identity`), and drops the service's own
  `accept-encoding`;
- without following redirects, so a key never travels to another origin;
- with the key replaced by `[redacted]` in every header and in the body of what comes back, as sent, JSON-escaped,
  URL-encoded, and base64 or base64url encoded. This is a best-effort guard against a provider that echoes the key. It
  is not a guarantee: a key the provider returns in another form, such as split, hashed, encrypted or inside another
  encoding, reaches the service.

A refusal is a JSON-RPC error: `-32010` origin not declared, `-32011` no call in flight, `-32012` credential
unavailable, `-32013` too large, `-32014` the provider could not be reached, `-32015` stopped, `-32016` a method the
calls in flight do not allow, `-32017` too many requests, `-32018` an origin this node does not reach. Each request is
audited as `egress` with the package, method, origin, secret name, status and outcome. The audit never records a path,
a body, a value or a length. A refusal of a kind already written in the last 60 s is not written again at once: the
rest are written as one row with their count when the window closes or the service stops, so a service cannot flood
the audit.

Until the declared secret is usable, the package's capabilities read as not signed in (`authenticated: false`) with
the reason, for example "the secret LOOKUP_API_KEY has not been provided on this node". A press, the agent and voice
are refused with `CAPABILITY_NOT_AUTHENTICATED`. This is the "needs auth" state for a service: it is not the widget
lifecycle state `needs_auth`, which stays unset. Storing the key (`POST /credentials` with
`"consumer": "package:<id>"`) signs the service in without restarting it, and removing the key signs it out. A secret
also stored for a `command:` consumer is given to that command as an environment variable. Egress does not use such a
secret, so store a separate one for the package.

**What install consent shows.** A directory entry states the package's reach in `declaredReach`
(`{ origins, secrets, browserTokens, connections }`, [declared-reach.ts](../packages/contracts/src/declared-reach.ts)); a listing
without it says the package reaches nothing. The directory card in the conversation, the install question in the inbox,
and package details in Settings → Extensions list each origin with its purpose, each key by name with its purpose
(never a value), each browser-token provider with its scopes and purpose, and each account connection with its
provider, scopes and endpoints (§14.6), before anything is granted. An artifact
whose manifest declares a different reach than its listing shows is refused with `409 DECLARED_REACH_MISMATCH` before
anything is recorded, so consent covers what was shown.

A directory entry may also state the resource profile the package requests in `resources` (`{ version: 1, profile, gpu? }`,
the same shape as the manifest's); a listing without it means `interactive-light` and no GPU, and `clark widget publish`
writes it from the manifest only when the request is not that default. It binds the same way: an artifact that requests
another profile is refused with `409 DECLARED_REACH_MISMATCH`. A node released before this field and before the
tolerant reading in §18 refuses a whole directory index that holds an entry field it does not know, so an index that
lists a non-default `resources` needs nodes at least as new as this field to be read by all of them. A node with the
tolerant reading reads such an entry without the field and says so on the card, the install question and the update
notice (§18).

**What an update shows.** A package update notice, and the install question an update raises when the execution mode
asks first, carry `reachChange` ([reach-change.ts](../packages/contracts/src/reach-change.ts)): the new version's listing
compared with the installed version's manifest. It lists each origin, key, browser-token scope, account scope and account
endpoint the new version adds or drops; each origin a key is now sent to or no longer sent to, so moving a key to
another origin, or sending it to one more, is wider even when the origins and keys are the same; a GPU request, which
this node never grants, so asking for one means the version will not run here; and, when the profile changes, each
bounded limit that changes (memory, CPUs, processes, `/tmp`, call and job deadlines, concurrent jobs, result and input
sizes, input media length) with both values,
and the offscreen behaviour when it changes. Profiles are not ranked: each limit is compared on its own. The verdict is
`wider` when anything is added or any limit goes up, even if something else goes down; `narrower` when something is only
dropped or lowered; `unchanged` otherwise, including a changed purpose sentence. It is computed when the inbox is read,
so it always compares against what is installed then. It is absent when the package is not installed, and is
`{ verdict: "unknown" }`, shown as "Could not compare with the installed version", when the installed manifest or the
new version's listing cannot be read. Each list holds at most 32 items and counts the rest, which the notice shows as
"…and N more". It informs the decision and decides nothing: an update is decided by the execution policy like any install.

Not built: a proxied network for services that need raw sockets. Giving a container a network would weaken an isolation
default, so it waits for that decision.

### 14.3 Browser tokens (`tokens@1`)

Some vendor SDKs only work with a token in the browser. A `ui` facet may declare the providers its frame needs one
from (at most 8 providers, 16 scopes each):

    "browserTokens": {
      "version": 1,
      "providers": [{ "provider": "example.maps", "scopes": ["tiles:read"], "purpose": "Draws the map tiles." }]
    }

The host offers `tokens@1` in `init.extensions` only to a frame whose package declared browser tokens:

    if (api.tokens.available()) {
      const token = await api.tokens.request({ provider: "example.maps", scopes: ["tiles:read"], ttlSeconds: 300 });
      sdk.setAccessToken(token.value); // { provider, value, scopes, expiresAt }
    }

Each mount of the frame is its own session, a random id the host chrome keeps. The node issues a token for that
instance and session only (`POST /conversations/{id}/widgets/{instanceId}/browser-tokens`, person-only). It revokes
what the session was given when the frame goes (`DELETE …/browser-tokens/{session}`), when the package is uninstalled,
rolled back or updated to new code, at the token's expiry when the provider gave more time than was asked, and when the node stops.

A token is issued only when every one of these holds:

- the provider and every scope are in the declaration;
- the node has an adapter for the provider (`BrowserTokenAdapter` in
  [`@clarkcant/integration-sdk`](../packages/integration-sdk/src/browser-token.ts)), and the adapter says it mints a
  scoped token with those scopes;
- the lifetime is within 30–3600 s and the provider's own maximum. A request that names none gets 900 s, capped the
  same way.

A token minted while its frame closed, or while its package's code ended, is withdrawn and refused with
`TOKEN_SESSION_ENDED` rather than handed out. A request is refused, never narrowed. The codes are `TOKEN_PROVIDER_NOT_DECLARED`, `TOKEN_SCOPE_NOT_DECLARED`,
`TOKEN_PROVIDER_UNAVAILABLE`, `TOKEN_PROVIDER_UNSCOPED`, `TOKEN_SCOPE_NOT_SUPPORTED`, `TOKEN_TTL_TOO_LONG`,
`TOKEN_SESSION_ENDED` and `TOKEN_ISSUE_FAILED`. A provider that hands back a longer token than asked, and cannot
revoke it, is refused. A session holds at most 8 tokens; a ninth withdraws the oldest.

The node and the host keep the value out of what they store and pass on:

- the node keeps only the provider's token id;
- the audit (`browser-token`) records the provider, instance and outcome, never the value;
- the SDK and the host's frame session both refuse, with `TOKEN_NOT_ALLOWED`, a `state.update`, `semantic.publish`,
  `actions.invoke`, artifact write (its name or content) or external link that carries an issued token. The state
  write is answered with the committed state and `STATE_HOLDS_TOKEN`.

This guard is best effort. It catches a token passed on as it was issued, which is the common mistake. It does not stop
a widget that encodes or splits the token, or that sends it somewhere through its own network requests. The widget's
code has the value, so what bounds a leak is that the token is scoped, short-lived and revoked when the frame goes.

Token requests have their own budget per frame session: a burst of 10, then one every 5 s, at most 2 waiting.

Limits: ClarkCant ships no provider adapter yet, so on a node without one every request is
`503 TOKEN_PROVIDER_UNAVAILABLE`. The browser suite registers in-process fixture providers with
`CC_BROWSER_TOKEN_FIXTURE=1`. An `expiry-only` provider's token cannot be withdrawn early; it lapses at its expiry.

Tests: [browser-token.spec.ts](../packages/contracts/test/browser-token.spec.ts) and
[the request check](../packages/integration-sdk/test/browser-token.spec.ts) for the rules,
[browser-token-broker.spec.ts](../apps/runtime/test/browser-token-broker.spec.ts) for the node,
[session.spec.ts](../packages/widget-host/test/session.spec.ts) and
[runtime.spec.ts](../packages/widget-sdk/test/runtime.spec.ts) for the bridge, and the browser journey
[resource-egress.spec.ts](../apps/web/e2e/resource-egress.spec.ts). The journey shows the granted profile in package
details and on the running container. It reaches a fake provider with a key the page, the frame, the bridge, storage
and the container never hold. It then keeps a minted token inside its frame and revokes it when the frame closes.

### 14.4 Files a service reads

A service never gets a path or a handle to a person's file. It reads the bytes from the node a range at a time, only
during a call it was given the file for. Its container has no network of its own, and while such a call is in flight
the node also refuses the service's egress (§14.2), unless that call was decided as `external-write`, `communication`,
`destructive` or `financial`. Those are the effects the execution policy's risk gate asks about. A `GET` can carry
bytes in its URL as well as a `POST` can in its body, so a call decided as `read` or `local-write` that holds a file
gets no egress at all until it ends. The refusal is `-32019` (`EGRESS_ERROR_CODES.inputHeld`) and says why. A
capability that both reads a person's file and sends it to a provider declares `external-write` (or higher), so the
person's policy decides that send.

A capability that works on a file a widget holds names the argument fields that carry artifact ids:

    { "tool": "render_audio", "ref": "com.example.media.render@1", "effectCategory": "read",
      "execution": { "kind": "job", "version": 1 },
      "inputArtifacts": { "version": 1, "fields": ["source"] } }

A call that names a file in one of those fields can only come from the button of the widget instance that holds the
file. The same call from Clark, voice, MCP or the CLI is refused with `ARTIFACT_INPUT_REFUSED`, because none of them
holds the widget's grant. Before the call is sent the node
checks each named id ([capability-invoke.ts](../apps/runtime/src/application/capability-invoke.ts)):

- the pressing widget instance holds a grant on the file, and the file is finalized, not still being written
  (`403 ARTIFACT_INPUT_REFUSED`);
- the file belongs to the conversation the press happened in, and that conversation still holds the widget, the same
  check an agent button's `artifact:` context read makes (`403 ARTIFACT_INPUT_REFUSED`);
- the node can name the profile the package was granted; a node that cannot is refused rather than trusted with no
  cap (`403 ARTIFACT_INPUT_REFUSED`);
- the file fits the input cap of that profile (`413 ARTIFACT_INPUT_TOO_LARGE`).

A refused call sends nothing to the service.

When the execution policy asks before such a call, the approval card names the press it came from (the widget instance
and its action binding), and the digest the person approves covers it. Approving runs the call as that press: the node
checks again that the conversation still holds the widget and the binding still invokes this capability, and then
makes every check above. A card whose widget is gone is refused with `APPROVAL_STALE`. This holds for a capability
that answers at once as much as for a job.

The node offers file reads in MCP `initialize` (`capabilities.experimental["clarkcant/artifacts"]`,
[service-artifacts.ts](../packages/contracts/src/service-artifacts.ts)):

    { "version": 1, "methods": ["clarkcant/artifacts.read"], "chunkBytes": 262144,
      "maxInputBytes": …, "maxMediaSeconds": …, "maxResultBytes": … }

During the call, and only then, the service sends `clarkcant/artifacts.read` with
`{ version: 1, artifactId, offset, length }`, at most one chunk (256 KiB) at a time. The answer is
`{ artifactId, offset, bytes (base64), eof, sizeBytes, mimeType }`. The node checks the grant again on every read, and
reads the disk off its main thread. A longer range is refused with `-32602`. An id the call did not name in a declared
field is refused with `-32020`, and so is a read whose answer arrives after the call has ended: its bytes are not
handed over. A read the node refuses for another reason is refused with `-32021`: the grant was revoked, the file is
gone, or the call has spent its read budget.

The read budget bounds what one call reads in all: four passes over its files (`passes × size` bytes), in at most four
reads per 256 KiB chunk plus 16 more for headers and seeks
([`serviceArtifactReadBudget`](../packages/contracts/src/service-artifacts.ts)). A service that streams its input once
or twice stays well inside it; one that loops on the same bytes is refused once it is spent.

The caps come from the granted profile, never from the manifest. A manifest names fields, not sizes, so it cannot raise
either cap:

| Profile | Input file | Media length |
|---|---|---|
| `interactive-light` | 8 MiB | 2 min |
| `interactive-heavy` | 16 MiB | 10 min |
| `media-workstation` | 25 MiB | 2 h |
| `background-compute` | 25 MiB | 1 h |

Only the service can read a clip's length, so `maxMediaSeconds` is the service's to enforce. It refuses a longer clip
before it renders anything. `maxResultBytes` is the largest file one result may carry (about 2.95 MiB, the stdio
message limit after base64). A file the service returns becomes an artifact only when the job completes, so a
cancelled or failed job leaves no file presented as finished.

Tests: [service-artifact-input.spec.ts](../apps/runtime/test/service-artifact-input.spec.ts) for the node with a real
service process: the egress refusal, Clark and voice refused, a read after the call, a grant revoked mid-call, an
over-long read, a file still being written, the read budget, a node with no profile, another conversation's file, and
the approval replay. The reference app is in §24.4.

### 14.5 Media content policy

The audio player can play a file from the web, but the page never fetches it: the node does, under a policy in
[media-content.ts](../packages/contracts/src/media-content.ts) and [media-fetch.ts](../apps/runtime/src/media-fetch.ts).
Each refusal names the rule it broke, as `(media policy rule: <rule>)` at the end of the message a model reads.

| Rule | What is refused |
| --- | --- |
| `origin-not-allowed` | an origin the operator did not list in `CC_MEDIA_ORIGINS`. The list is empty by default, so a node fetches nothing until an operator names an origin |
| `https-only` | any scheme but `https`, in the URL or in a redirect |
| `credentials-in-url` | a user name or password in the URL or in a redirect |
| `private-address` | a name that resolves to a loopback, private or link-local address. The check runs on the address actually dialled, so a name that changes its answer cannot slip past. An origin the operator wrote as an address (`https://127.0.0.1:8443`) names that address and is allowed |
| `redirect-off-origin`, `too-many-redirects` | a redirect to another origin, or more than 3 |
| `type-not-allowed` | a declared type that is not `audio/mpeg`, `audio/ogg`, `audio/wav` or `audio/webm` |
| `type-mismatch` | bytes that are not the declared type, checked by sniffing the container, or a compressed transfer |
| `too-large` | more than 25 MiB, refused from the declared length or as soon as the body crosses it |
| `too-long`, `duration-unknown` | more than an hour, or a container that does not state its length (a bound that cannot be checked is not a bound) |
| `timeout`, `not-found`, `fetch-failed` | a fetch that took longer than 30 s, a missing file, or one that could not be reached |
| `source` | not exactly one source, or an id the node does not issue |

The request carries no cookie, authorization or referrer, and uses a fresh connection. A file that passes is stored
against the person's storage quota. The same checks of type, size and length apply to an audio file the person already
holds. `CC_MEDIA_ORIGINS` is a comma-separated list of bare `https` origins, at most 32. A list with an entry that is
not one is ignored as a whole, the node allows nothing, and it says why once at startup. The page policy is unchanged:
`media-src 'self' blob:`.

The browser suite runs a real https origin on loopback with a certificate it makes at run time and never commits
([media-fixtures.ts](../apps/runtime/src/test-support/media-fixtures.ts)), trusted by the node it starts through
`NODE_EXTRA_CA_CERTS`.

### 14.6 Connecting an account

A service that works on a person's account at a provider, such as their tasks or calendar, declares one `connection`
on its tools facet (§4). The host does everything that touches the account's credential
([package-connections.ts](../apps/runtime/src/package-connections.ts)); the service sees the provider's answers and
the widget sees a status. Neither ever holds an access token, a refresh token or an authorization code.

1. **Connect.** The person presses *Connect* on the package in Settings → Extensions. This is host UI, not the widget.
   `POST /packages/:id/connection` makes a PKCE pair (S256) and a single-use `state`, kept in memory for ten minutes,
   and answers the provider's authorization URL. The client opens it in the system browser. The route is person-only:
   a request through MCP or the relay is refused with `403 PERSON_ONLY`, so an AI client cannot start a connection for
   itself. It answers `409 CONNECT_ON_THIS_MACHINE` unless the request reached the node over loopback, because the
   provider redirects the browser back to `http://127.0.0.1:<port>/connections/callback/<package id>`. Each package
   has its own callback path, so a code sent back to one package's path is never exchanged for another's (the OAuth
   mix-up attack).
2. **Come back.** `GET /connections/callback/:id` is public, because a browser following a redirect carries no gateway
   token: the single-use `state` authenticates it. The node checks the state, and that it was issued for the package
   the path names, before sending the code anywhere. It exchanges the code at the declared token endpoint, compares the granted scopes with the declared ones, and calls the
   declared probe. Only then does it keep the connection. Tokens live in their own table on the node
   (`package_connection_tokens`). The page the browser lands on never repeats the code or the state, sends no referrer,
   and a replayed or forged callback is refused.
3. **Sign.** The service runs with no network, as before (§14.2). When it asks for a URL on one of the connection's
   endpoints with `clarkcant/egress.fetch`, the node adds `authorization: Bearer …` itself, only while one of the
   service's calls runs, and redacts it from any answer it hands back to the service. A token about to lapse is
   refreshed first; a renewal keeps the scopes granted at consent unless the provider says otherwise. A provider's
   `401` to the token in use gets one refresh; if the token endpoint refuses that with `400` or `401`, the connection
   is revoked, while a `408`, `429` or `5xx` leaves it as it is. A request is never retried.
4. **Readiness.** `GET /packages/:id/connection` answers the `ConnectionStatus`: `not-connected`, `connected`,
   `partial`, `expired` or `revoked`, the requested, granted and missing scopes, and a reason. A capability is not ready
   while the connection is missing, expired or revoked, or did not grant one of its `requiredScopes`, and the reason
   says which, for example "the Fake Tasks (test fixture) account did not grant tasks.write; reconnect it in Settings
   and allow it". A widget reads it from `actions.availability()` (§10); a press, the agent and voice are refused with
   `CAPABILITY_NOT_AUTHENTICATED` and the same reason. A capability whose scopes were granted keeps working on a partial
   connection.
5. **Revoke.** *Revoke* in Settings calls `POST /packages/:id/connection/revoke`. The node calls the provider's
   revocation endpoint when one is declared, deletes the tokens, and the status reads `revoked` before the request
   answers, even when a renewal was in flight. *Reconnect* runs step 1 again. Uninstalling the package, from Settings
   or by asking Clark (`manage_package`), forgets the connection the same way, and an authorization still waiting for
   its callback can no longer finish.
6. **A new version.** The node keeps a fingerprint of where the declaration let the account's tokens go: the provider,
   client id, authorization, token and revocation endpoints, the endpoints and the probe. If an update or a rollback
   changes any of them, the connection reads `revoked`, its tokens are deleted without being sent to the new
   addresses, and the person connects again under the new declaration.

A connection changes nothing about how a capability runs: the widget's binding, Clark's `invoke_capability` and a
spoken command still reach `invokeCapability`, the person's execution policy, the host-owned approval card and the
same audit trail (§4). A write whose answer never came back before its deadline is recorded as unknown and not retried.

The desktop shell opens only HTTPS addresses in the system browser, so a provider on a loopback `http` address (the fake
connector below) is connected from the browser client. Real providers use HTTPS. Only the authorization-code flow with
PKCE is built. Several accounts for one package, and a connection shared between packages, are not.

**Reference app and template.** [examples/reference-apps/connected-app](../examples/reference-apps/connected-app/)
lists and renames tasks through such a connection, and `clark widget init --template connected-app` copies it (§16).
Its provider is a **fake connector**, `dev/fake-connector.mjs`: a test and development fixture with a tiny OAuth
server and task API on loopback, no real account, and random test values kept only in memory. A node reaches its
loopback endpoints only with `CC_EGRESS_ALLOW_PRIVATE_NETWORK=1`. A live provider follows
[#333](https://github.com/digitopvn/clarkcant/issues/333). The tests are
[package-connections.spec.ts](../apps/runtime/test/package-connections.spec.ts) for the broker,
[package-connection-routes.spec.ts](../apps/runtime/test/package-connection-routes.spec.ts) for the routes, and the
browser journey [connected-app.spec.ts](../apps/web/e2e/connected-app.spec.ts). The journey connects, reads and
renames from the widget, calls the same capability from Clark and by voice with one audit trail, revokes and
reconnects, grants only part of the scopes, lets a rename time out, and checks that no token, code or secret reaches the
frame, the page, the node's records, its files or the service container.

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
Settings, chat and voice. Installing the package again after removing it, in the same version or another, also brings its offline instances back
with their state, as Restore would, and there is then nothing left to restore.

---

## 16. Developer CLI target

    clark widget init
    clark widget dev
    clark widget test
    clark widget pack
    clark widget publish

### Quickstart outside this repository

`@clarkcant/widget-cli` (the `clark` command) and `@clarkcant/widget-sdk` are built from this repository as npm
packages that need no ClarkCant checkout. **Status: no version is on npm yet.** The release workflow below exists, but
until it has run, installing from the registry fails; install the archives built from a checkout instead (see
[Before a release](#before-a-release)).

On a clean machine with Node 22.19 or later and pnpm (`corepack enable pnpm`), on macOS, Windows or Linux:

    mkdir my-widgets && cd my-widgets
    pnpm init
    pnpm add -D @clarkcant/widget-cli
    pnpm exec clark widget init quick-notes --template pure-ui
    pnpm exec clark widget test quick-notes
    pnpm exec clark widget dev quick-notes      # prints the dev host's URL; Ctrl-C stops it
    pnpm exec clark widget pack quick-notes
    npm publish quick-notes/dist/quick-notes-0.1.0.tgz

- **Template.** `blank`, `form` and `dashboard` are a minimal isolated widget. `pure-ui` (a text editor), `media-tool`,
  `ai-generator`, `ui-with-service` and `connected-app` copy a reference app that this repository's own tests keep
  working ([init](#init)). The directory name becomes the last segment of the package id (`com.example.quick-notes`)
  and the npm name (`quick-notes`); rename it, or use a scope you own, before publishing.
- **SDK.** `pnpm add -D @clarkcant/widget-sdk` gives browser-safe ES modules with type declarations: `.` holds the
  contracts and the bridge runtime (`createWidgetRuntime`, `MessageEndpoint`, …) and `./dom` binds the host's
  appearance to an element (`bindAppearance`):

      import { createWidgetRuntime } from "@clarkcant/widget-sdk";
      import { bindAppearance } from "@clarkcant/widget-sdk/dom";

  The dev host and a node already give a package frame the runtime as `window.clarkcantWidget`, so the templates need
  no import. A widget package may not declare npm `dependencies` ([pack](#pack)): a frame that imports the SDK bundles
  it into the files it ships, and keeps the SDK a development dependency of the project that builds it.
- **Test, dev, pack.** `test` runs the conformance suite; `dev` serves the package in the local isolated host on
  `127.0.0.1`; `pack` writes `dist/<name>-<version>.tgz` with `pnpm pack` and refuses an archive that would not pass
  the suite on its own.
- **npm publication is not Marketplace indexing.** `npm publish` puts the archive on the npm registry and nothing more.
  A Marketplace indexes npm packages carrying the `clarkcant` keyword, or takes a submission; `clark widget publish`
  only prepares that directory entry ([publish](#publish)). Neither is needed to develop or use a private widget: a
  local path needs no account.

#### Before a release

From a checkout, `pnpm install` then `pnpm build:widget-tooling` writes
`dist/widget-tooling/archives/clarkcant-widget-cli-<version>.tgz` and `clarkcant-widget-sdk-<version>.tgz`. Install
them in the project instead of the registry versions:

    pnpm add -D /path/to/clarkcant-widget-cli-<version>.tgz /path/to/clarkcant-widget-sdk-<version>.tgz

`pnpm smoke:widget-tooling` does all of this on the current OS: it packs both packages, installs them into an empty
project outside the repository, runs `init` (blank and `pure-ui`), `test`, `pack`, the widget, catalog and theme dev
hosts over HTTP, and imports and type-checks the SDK.

#### How the packages are built and released

Inside this repository both packages stay `private` and resolve to their TypeScript source, like every workspace
package. `tools/build-widget-tooling.mjs` generates a separate package directory for each under
`dist/widget-tooling/`: the code bundled with esbuild, the workspace packages inlined and every third-party import
declared at the exact version the repository pins; the SDK's declarations; the CLI's templates (`templates/`) and the
dev hosts' browser modules as self-contained bundles (`runtime/`), which the installed dev hosts serve from disk as they
are. The CLI's `THIRD_PARTY_NOTICES.md` lists the third-party code those bundles inline, with each licence. The
generated `package.json` holds no `workspace:` specifier and no lifecycle script. `clark --version` prints the installed
CLI's version.

`.github/workflows/release-widget-tooling.yml` releases them. Every run packs the archives once and runs the smoke
against those archives on Ubuntu, Windows and macOS with Node 22.19 and 24. Only a run from a `widget-tooling-v<version>`
tag naming `@clarkcant/widget-cli`'s version publishes: the tag push itself, or a manual run from that tag with
`publish` checked. Any other run, including a manual run from a branch with `publish` checked, stops at
`npm publish --dry-run`.

Before publishing anything, the workflow compares each package's version with npm. A version npm does not have is
published with `npm publish --provenance --access public`. A version npm already has with the same archive integrity is
skipped, so a rerun publishes only what is missing. A version npm already has with different contents fails the run
before either package is published, so a changed package always needs a new version.

The publish job runs in the `npm-release` GitHub environment. Its maintainers must restrict that environment's
deployments to `widget-tooling-v*` tags and require a reviewer. npm trusted publishing (OIDC) is the intended
credential: once each package's trusted publisher on npmjs.com names this repository and workflow, no npm secret is
needed. A package's first version, published before a trusted publisher can be set on it, needs the environment's
`NPM_TOKEN` secret, which reaches only the publish step.

### init

Templates:

- blank;
- dashboard;
- form;
- pure-ui: a copy of the reference text editor ([§24.1](#241-text-editor)), under the new
  package's own id, facet id and name, without the editor's tests;
- media-tool: a copy of the reference media render tool ([§24.4](#244-media-render)), a widget and a service
  under the new package's own id, without the tool's tests;
- connected-app: a copy of the reference connected app ([§14.6](#146-connecting-an-account)) under the new package's
  own ids and name: a widget, a service whose capabilities name the scopes they need on one declared connection,
  skills, the fake connector it is tested against, and the service's portable `dev/service.test.mjs`. Replace the
  provider, client id, scopes and endpoints with your provider's before publishing;
- editor;
- media;
- MCP App adapter;
- `ai-generator` and `ui-with-service`, copied from the reference image generator
  ([§24.3](#243-image-generator)); `ai-generator` starts with a placeholder provider origin to replace.

`clark widget init --template` accepts `blank`, `form`, `dashboard`, `pure-ui`, `ai-generator`, `ui-with-service`,
`media-tool` and `connected-app` today. `editor`, `media` and the MCP
App adapter are not implemented yet.

A reference template leaves the app's own `package.json`, `LICENSE` and READMEs behind, since they name the reference's
npm identity (such as `@clarkcant/quick-notes`, §24.1): the copy gets a `package.json` named after its own id, an MIT
`LICENSE` and its own README.

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

For a package, the dev host performs the bridge's real `init` handshake. It sends the selected fixture's props and
offers `artifacts@1` (§10.1). Its **File picker** control simulates the person's choice. It lists the files in the
package's `fixtures/files/` and adds Cancel, and the next `pick` returns whichever is selected. It lists only files
a node would take: an allowlisted type, a plain file name, at most 25 MiB, and at most 32 files. It lists anything it
skipped, with the reason. It answers `read`, `create`, `write`, `finalize`, `export` and `attach` with the same
refusal codes and 256 KiB bounds as the node. The widget gets a file's bare name, type, size and digest, never where
it is. The simulation holds everything in memory and forgets it when the dev host stops. It does not sniff bytes,
and it writes nothing to disk. An export or an attach is only recorded in the shell's log, so a real host's Save As
and composer are still what a release is tested against.

For each `tools` capability, the shell can set service readiness to `loading`, `ready`, `blocked` or `unhealthy`, with
a reason for blocked and unhealthy states. Offline takes precedence over readiness; a ready capability remains usable
when a different one is unhealthy, and the shell labels that mixed state degraded. **Simulate service restart** shows
loading, then returns the declared capabilities to ready. These controls send the bridge's `actions` availability and
`action-result` messages to the frame. They never start the service facet or contact a provider.

Optional data-only fixture `fixtures/dev-host-services.json` maps each `actionBindingId` to a capability `ref` from a
declared tools facet and a bounded bridge outcome, for example:

    { "bindings": [{ "actionBindingId": "notes.list", "capabilityRef": "com.example.notes.list@1",
      "outcome": { "status": "accepted", "message": "Loaded", "output": "One sample note" } }] }

The file is limited to 32 KiB and 64 bindings. Unknown capability refs and duplicate binding IDs are refused. The host
validates every outcome against the widget bridge schema; malformed outcomes become a valid refusal. This fixture tests
widget rendering and bridge handling only. It does not prove the service implementation works. The package frame gets
the same widget SDK runtime used by the bridge, stays in an opaque-origin sandbox, and can load package modules only
through the dev host.

A binding to a capability declared with `"execution": { "kind": "job", "version": 1 }` takes a `job` fixture instead
of an `outcome`, and every such binding needs one:

    { "actionBindingId": "binding_notes_export", "capabilityRef": "com.example.notes.export@1",
      "job": { "steps": [{ "current": 1, "total": 3, "message": "exported step 1 of 3" }],
               "output": "Exported 1 note(s).", "error": "the export could not be written" } }

A press then answers with a simulated JobRef, and the shell's **Simulated jobs** list shows each job with **Next step**,
**Complete** and **Fail**. Next step moves a queued job to running and then through the fixture's progress steps; the
widget's own `jobs.cancel` ends it as cancelled. Every ending says "(simulated by clark widget dev)". The host keeps at
most 32 jobs in memory, making room from ended ones, and forgets them when it stops. It never calls the service, so
a real job still has to be tested on a node.

The semantic inspector accepts the frame's `semantic.publish` proposal through the shared runtime normalizer. It
shows the normalized document, fields clipped or dropped, the delta from the previous publish, the next-turn context
note and `inspect_ui` text. Frame-proposed text is untrusted, and more than four publishes in one second raises a churn
warning. The composition simulator lists declared graph events and package `eventSchemas`; it validates a payload
against the corresponding shared graph contract or package schema, then shows the simulated graph values or validated
payload and records it in the action log. Malformed and undeclared events are refused. Simulation never invokes a real
capability or grants authority. The real-browser proof is
[`semantic-composition-real-browser.e2e.spec.ts`](../packages/widget-cli/test/semantic-composition-real-browser.e2e.spec.ts).

For a package, the **Resource profile · simulated** panel shows the profile the package asked for, decided by the
node's own `decideResourceProfile`. **Policy refuses** answers as a node whose execution policy refused it: every
service action becomes unavailable with the node's sentence. `interactive-light` and a GPU request answer as they would
on a node, whichever button is chosen. The engine's capacity is not simulated. A package whose UI facet declares
`browserTokens` is offered `tokens@1`, checked against the declaration with the node's own check and codes.
**Provider issues** answers with a random `dev-simulated-…` value that opens nothing, and **Provider unavailable**
answers `TOKEN_PROVIDER_UNAVAILABLE`. Every answer says it was simulated, and the log names the provider and outcome,
never a value ([dev-resources.spec.ts](../packages/widget-cli/test/dev-resources.spec.ts)).

### test

Runs the conformance suite.

### pack

Runs the conformance suite, then builds the artifact and its digests. When the package has a `package.json`, pack also
builds the npm archive with `pnpm pack` into `dist/<name>-<version>.tgz`, extracts it with the runtime's own reader,
and refuses it unless the extracted archive passes the conformance suite on its own, holds the same `clarkcant.json`
and contains nothing credential-shaped (`.npmrc`, `.env*`, `.dev.vars`, `.git-credentials`, `.pypirc`, private keys, `node_modules`, `.git`). A
`files` list that leaves out a runtime asset is therefore caught by pack, not on someone else's machine. Without a
`package.json` the package stays a local/git package and pack writes no archive.

`dist/artifact.json` (`schemaVersion: 2`) records three digests, each answering a different question:

| Field | Covers | Checked by |
| --- | --- | --- |
| `npm.integrity` | sha512 SRI of the `.tgz` bytes | the npm registry and the node's fetch |
| `npm.contentDigest` | the runtime digest of the extracted archive's files | the node, after extracting the exact npm version; it is the npm directory entry's `digest` |
| `authorDigest` | identity, version, definitions, theme documents and file hashes of the source | pack, so a packed version whose bytes changed is refused; it is a local entry's `digest` |

`pnpm pack` is reproducible: packing unchanged files again writes byte-identical archives. Repacking a version whose
author digest or archive content digest changed is refused; bump the version.

`package.json` rules, checked before packing and named one by one when they fail:

- `name` is a valid npm package name, and `version` equals `clarkcant.json`'s `version`;
- `license`, when the manifest has a `publisher`, equals `publisher.license`;
- `keywords` include `clarkcant` and one keyword per facet kind (`clarkcant-widget`, `clarkcant-service`,
  `clarkcant-skill`, `clarkcant-prompt`, `clarkcant-theme`, `clarkcant-setup`, `clarkcant-driver`,
  `clarkcant-voice`), which is how a Marketplace finds the package;
- an explicit, non-empty `files` list;
- no `dependencies`, `optionalDependencies` or `bundle(d)Dependencies`: a package ships what it runs;
- no `preinstall`, `install` or `postinstall` script, and no `prepack`, `prepare` or `postpack` script: pack runs no
  package code, and an archive a script generated could not be rebuilt from the source. Ship the generated files.

`clark widget init` writes a `package.json` that meets these rules for every template, named after the last segment of
the package id. That name may already be taken on npm: rename it, or use a scope you own (`@you/quick-notes`), before
publishing. Pack needs `pnpm` (`corepack enable pnpm`). Adding a `package.json` to an already packed package changes
its author digest, because the file becomes part of the package; bump the version when you add it.

### publish

Prepares the directory entry; it never uploads anything. `dist/directory-entry.json` names the exact npm version
(`source: { kind: "npm", name, version }`) and the archive's `contentDigest` when pack built an archive, or the
package's own directory and its `authorDigest` otherwise. `--source npm|local` picks one explicitly. The output states
three outcomes separately — prepared: yes; published to npm: no; Marketplace submission: no — and prints the
command that publishes the exact archive that was checked:

    npm publish dist/<name>-<version>.tgz

Publish that file rather than running `npm publish` in the package directory, so the registry serves the bytes whose
integrity and content digest the entry already names. npm makes a scoped package (`@scope/name`) restricted by
default, so a scoped package meant to be public declares `"publishConfig": { "access": "public" }` in `package.json`,
as the reference apps do (§24); `npm publish <tarball>` reads it from the archive. A Marketplace then indexes npm
packages carrying the `clarkcant` keyword, or takes a submission. A local/git source is still a first-class development path.

Before writing the entry, publish compares the definitions with the previous preparation (`dist/published-definitions.json`) and
refuses a version that violates the rules in §20. This file is the comparison baseline, so it should be committed with the source; if
`dist/directory-entry.json` exists but this file is missing (fresh clone, cleaned `dist`), publish warns that the version has not been checked.

---

## 17. Conformance suite

A widget is not publish-ready if any of the following tests are missing:

### Schema

- malformed props reject;
- additional props reject when the schema forbids them;
- fixture-derived semantic documents stay within `SEMANTIC_LIMITS`, and declared event schemas can be parsed and
  validated;
- state version valid;
- unknown event/action reject.
- `fixtures/dev-host-services.json`, when present, names only declared capabilities and gives a `job` fixture to
  exactly the bindings whose capability runs as a job.

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
- blocked service;
- offline;
- reduced motion;
- text fallback.

---

## 18. Directory metadata

A directory entry needs:

- package id;
- current version: a semantic version of at most 80 characters, because the marketplace card shows it and Install
  sends it back unchanged; an index with a longer one is refused when it is read, with the reason;
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

**Reading an index a newer directory wrote.** An index is a JSON array of entries with no format version, and nodes of
different ages share one. A node reads each entry with `readDirectoryEntry`
([directory.ts](../packages/contracts/src/directory.ts)): a field it does not know, at the top of the entry or inside
`publisher`, `preview` or `hostApi`, is dropped and never passed on, so its value reaches no card, question or install.
Every field the node knows is still checked with all its bounds, and `source`, `isolations`, `declaredReach`,
`resources` and `widgetAppearance` stay strict inside: a known field with a bad value, or an unknown field inside one of
those, still makes the node refuse the whole index as unreadable, with the reason. What was dropped is said, never
hidden: the `marketplace-results` row, the inbox install question and the package update notice carry `unreadFields`
(`{ count, names }`, never values), shown as "This listing has N details this version of Clark cannot read… Update Clark
to see all of it", because a field this node does not know may be one a newer node treats as binding. `count` counts
every field left out. `names` holds at most 8 of them, in the order the entry lists them, and only plain identifier paths
(`UNREAD_FIELD_PATH_PATTERN`: one or two dot-joined segments matching `[A-Za-z_$][A-Za-z0-9_$-]{0,63}`); a key with any
other text (a bidi control, a line break, a space, an over-long name) is counted without being named. Each name is shown
apart from the sentence, as code. The install still refuses an artifact that does not match what this node does read.
Publishing stays strict: the entry `clark widget publish` writes is checked against the strict `directoryEntrySchema`,
where an unknown field is a mistake rather than a newer format.

The Pi package catalog is a good reference for discovery: packages have manifest resources and a preview image/video, are shared via npm/git and indexed in the catalog. ClarkCant should keep those ergonomics, but executable widgets default to isolation instead of full-process trust.

---

## 19. Publish flow

Developer:

    clark widget test
      ↓
    clark widget pack
      ↓
    npm archive + integrity + content digest
      ↓
    clark widget publish        (prepares the entry; uploads nothing)
      ↓
    npm publish dist/<name>-<version>.tgz
      ↓
    Marketplace indexes the "clarkcant" keyword, or a submission
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
- `clark widget pack` — validates the manifest, computes the author digest over identity + content, builds the npm
  archive when the package has a `package.json` (§16), records its integrity and runtime content digest, and refuses to
  re-pack a version that was already packed with a different digest (a version whose bytes changed is a different package
  carrying the same number). A node fetching that exact npm version computes the same content digest.
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
  With an npm archive, the entry names the exact npm version and the archive's content digest, and the output prints the
  `npm publish` command for that archive; npm publication itself is the author's step.
  The local/git/npm path is still first-class, so no account is needed to run your own widget.
- **Directory search** — implemented at the level of reading an index: `CC_DIRECTORY_INDEX` points to a JSON file of entries per
  §18, and `search_directory` returns a `marketplace-results` card showing **source, version, digest and risk lane**,
  along with the name of the directory the results came from. An unconfigured index is a *state* that is stated, distinct from "nothing
  found". Each row's Install button calls the one install path (`POST /packages/install`), where the digest is checked and
  the execution policy decides; the card installs nothing itself, so a listing never turns into authorization. A listing by a
  path on this machine also carries `contentDigest`, the digest of its files when they were listed, which the button sends
  back so the install is refused if the files changed since; the row then shows that they changed and offers a new
  search instead of the same Install. The install copies the files into the package cache and the package runs from that
  copy, so later edits to the path change nothing until it is installed again; the live editing loop is `clark widget dev`.
  A row also repeats the listing's `declaredReach` (what installing lets the package reach) and `widgetAppearance` claims, under the
  same schemas as the directory entry, so the row shows them before the Install press. A card that does not match its
  contract is left out of the reply and the node logs `host card dropped` with the card type and the failing field
  paths, never a value. There is no remote registry — search only reads what exists on the machine or at a URL the user specifies.
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

A package listed by a path on this machine is cached the same way, by content: `snapshotLocalPackage` copies the path
into `local/<sha256>` under the cache (`cachedLocalSnapshotPath`), and the install runs from that copy as it runs a
git or npm package from its fetched folder. The copy is asynchronous, so the node keeps serving while it runs. The path
is listed first, with the same bounds as the listing digest (5,000 files, 5,000 folders, 64 levels deep, 64 MiB) and
the same refusals as `digestOfDirectory` (a symbolic link, a junction, a hard link, a root `.git` left out in any letter
case). Each file is then opened (with `O_NOFOLLOW` where the platform has it; Windows has none), and the opened handle
must be the same file, by device and file id, as the one listed, so a name replaced by a link or another file in between
is refused on every platform; its own size is checked against the remaining byte bound before it is read, and it is read
no further than that size. The bytes are written to a `.tmp-*` folder and hashed as they are written, in digest order,
so the digest is of the copy without reading it again; it is compared with the digest the person was shown, and only
then is the folder renamed into place; a mismatch discards the staged copy. With no digest to compare (a notice's
`update`, an older card), the path is listed again after the copy, and a file or folder whose size, modification time or
identity changed refuses the snapshot (`LOCAL_SOURCE_CHANGED`, answered as `409 DIGEST_MISMATCH`). A failure writing the
cache (creating, writing, renaming or removing there, including a rename Windows still refuses after about three seconds
of retries) is `PACKAGE_CACHE_UNAVAILABLE` (`503`), never `LOCAL_SOURCE_UNREADABLE`. Every file is written
owner-writable whatever its source mode, so a read-only source does not leave a copy the cache cannot remove, and a name
a case-insensitive filesystem cannot hold apart from another is refused rather than overwritten. The generation records
the copy as `snapshotDigest`, and every reader of an installed local package (the file and frame routes, the
conversation's frame lookup, the widget list, the theme registry, services, capability grants, and the widget ids an
uninstall or restore reaches) resolves it through `resolveLocalSource(entry, cacheRoot, generation)` or
`installedDirectoryEntries`, which never fall back to the path: a snapshot gone from the cache is a package whose files
are gone. `installedDirectoryEntries` withholds a local listing whose package runs from a snapshot but which no longer
names exactly that generation's version and digest (the same version re-packed, or another version), and readers answer
it `409 NOT_INSTALLED`. Installing the path again after an edit makes a new copy, and its different `artifactUrl` makes a
new plan and generation rather than joining the old one; a finished plan is joined only while the running generation's
snapshot is that plan's artifact. A generation installed from a path before snapshots has no `snapshotDigest` and keeps
reading its path until it is installed again. A snapshot sweeps `.tmp-*` and `.stale-*` folders older than an hour from
the cache; nothing else collects unused cache entries yet, for snapshots as for git and npm artifacts.

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

---

## 24. Reference apps

Reference apps are complete packages that show how the platform's pieces fit together in one real widget. They live
in `examples/reference-apps/` and are tested like any other package, plus a browser journey through a real node.

### 24.1 Text editor

[`examples/reference-apps/text-editor`](../examples/reference-apps/text-editor) is a whole app built only on the
contracts in [§10](#10-widget-sdk-surface). It is one isolated UI facet with no service, no permissions and no requested capabilities. A person
opens a text file, edits it, saves it and asks Clark to rewrite a selection, and the frame never sees where the file
lives. `clark widget init --template pure-ui` starts a new package from a copy of it ([§16](#16-developer-cli-target)).

**npm package.** It is packaged as **Quick Notes**, `@clarkcant/quick-notes` 1.0.0, with its own `package.json`,
Apache-2.0 `LICENSE` and README. `clark widget pack` builds `dist/clarkcant-quick-notes-1.0.0.tgz`, and `publish`
prepares the npm directory entry ([§16](#16-developer-cli-target)). It is **not published to npm yet**: the publishing
account has to own the `@clarkcant` scope first.
[reference-packages-npm-install.spec.ts](../apps/runtime/test/reference-packages-npm-install.spec.ts) packs a copy
with the CLI, installs that archive through `POST /packages/install` from a local registry answering like npm's, and
refuses a tampered archive.

**The package.** `clarkcant.json` is a schema-version-2 manifest for every platform and the web. `widget.json` takes
two props: `title`, and `rewriteBinding`, the id of the `agent` binding the editor may press. Its `stateSchema` admits
only `file`, `base` (two `ArtifactRef`s), `draft` and `draftTooLarge`, with `additionalProperties: false`. The rules
are pure functions in [`editor-core.js`](../examples/reference-apps/text-editor/widgets/main/editor-core.js), tested
without a browser; `main.js` is the DOM and the SDK calls.

**Opening.** `artifacts.pick({ accept: ["text/plain", "text/markdown", "text/csv", "application/json"] })` asks the
host, which draws the prompt outside the frame. The editor refuses a file over 1 MiB before reading a byte. It reads
the rest in 256 KiB ranges and decodes them as strict UTF-8: bytes that are not text are refused with the reason
rather than shown with replacement characters a save would write back.

**Editing and keeping the draft.** The unsaved draft is written to widget state 400 ms after typing pauses, one write
at a time. The editor remembers the write it has not had answered, with the revision it was written against, so when
the host's commit of that write arrives after the person has typed on, it is recognized as the editor's own and not
shown as a change from another window. A refused write is answered by the host's committed state. A reload, a pinned
copy or another device therefore shows the same draft. Widget state holds 16 KiB, so a draft whose JSON is over
12 KiB is not kept and is never cut. The editor says it will not survive a reload, and the flag survives so the next
load says so too. On load the editor reads the saved bytes again through `base`. If they cannot be read (a picked
file's grant lasts 24 hours), an unsaved draft is still shown, marked unsaved, with the reason. Without a draft there
is nothing to show: the editor opens no document, says why and offers *Open*, so an empty text area is never
presented, or saved, as the file.

**Two views of one editor.** When committed state arrives from another view, the editor takes it if it has nothing
unsent. If both changed, it shows *Keep mine* and *Use theirs* and throws neither away. The question does not take the
keyboard from someone typing; the status line announces it. A view with no document open, such as one that could not
read the saved copy back, has no draft of its own: it always takes committed state, never asks, and never writes
state until the person opens a file, so it cannot erase another view's draft. A view still reopening the file after a
reload is not such a view: state committed meanwhile is held and taken once the reopening has finished, and a read
of the saved copy that a newer one overtook is dropped, so older text never replaces newer.

**Saving.** The editor writes a `working` artifact of the opened file's type and name, in chunks, finalizes it and
calls `export(ref, { suggestedName })`. The host decides what that means. On the desktop it offers *Replace original*
for the file picked in this frame, because the type matches; on the web it starts a download and says replacing the
original is a desktop feature. The editor learns only `true` or `false`, so on `true` it says it handed the copy to
the app and leaves where it went to the host's own notice: on the web a download has only started. On `true` the copy
becomes the new `base` and the previous copy the editor made is discarded; on `false` the unused copy is discarded.
The editor never discards the file the person picked. Ctrl+S (Cmd+S on macOS) saves. *Attach* finalizes a copy and
calls `attachToConversation`.

*Replace original* is offered only in the frame where the file was picked, and only until it is reloaded: the host
keeps the desktop's handle for the picked file in memory beside that one frame and never persists it. After a reload,
in a pinned copy or in a detached window, the desktop offers Save As.

**What Clark is shown.** The editor publishes a summary ("Editing notes.txt: 3 lines, with unsaved changes.") and the
values `open`, `file`, `lines`, `dirty`, `selectionStart`, `selectionEnd`, `selectedChars` and `selectedText`. The
excerpt is cut at 200 UTF-16 units, the host's limit for one value, and the cut is marked. The selected range is also
a selected id (`chars:6-11`). The host bounds, redacts and marks all of it as the widget's own words.

**Asking Clark to change the selection.** The editor presses an `agent` binding whose `contextRefs` are
`["selection", "widget"]`, named by its `rewriteBinding` prop. `place_widget` ([§10.3](#103-actions-clark-performs-actionsperform1))
binds it when Clark places the editor with that button; without a binding the button stays disabled, with its reason
shown ("Clark chưa được gắn vào trình soạn thảo này…"). When the binding is there and the person presses *Nhờ Clark
viết lại đoạn chọn*:

1. The editor asks only about a selection the host passes to Clark unchanged. The host flattens line breaks, tabs and
   runs of spaces, removes invisible characters, redacts secret-shaped text and cuts a value at 200 UTF-16 units, so a
   selection it would change is refused in the editor with the reason: too long; more than one line; hidden characters
   or unusual spaces such as a no-break space; or text the host redacts as possibly private, such as an e-mail
   address, a long number, a home-folder path or key-like text. Text the host passes on unchanged is never refused.
   Spaces at the ends are left out of the range, because the host trims them. The editor's copy of the host's
   cleaning is checked against the host's own in the package's tests.
2. The editor publishes its semantic document, makes the text area read-only and holds the published selection until
   the answer. Because the binding reads the selection, the host sends any publish still settling and waits until
   the node holds the description published before the press, or a newer one, before it runs the press. The wait is
   bounded (8 seconds); when the description
   cannot be delivered in that time, the press is refused, nothing is asked, the text area is editable again and the
   status line says to try again in a moment.
3. `actions.invoke(rewriteBinding, {}, invocationId)` starts one turn. The host reads the selection and the widget's
   document into the turn's data section, which is marked as data and not instructions.
4. The reply comes back as the press's output, at most 2,000 characters. The editor treats it as untrusted text and
   takes it as a proposal only when it holds exactly one closed fenced (```) block within that bound; the block is the
   replacement, with control and invisible characters other than line breaks and tabs removed. Any other reply is
   shown as Clark's message, with nothing to apply.
5. The proposal shows the replacement and the text it would replace, and takes the keyboard at its title. *Thay đoạn
   đã chọn* applies it only if the selected range still holds the text Clark read; Escape or *Bỏ qua* dismisses it.
   The change goes in through the browser's editing, so Ctrl+Z undoes it like anything typed; where the browser
   refuses that, the text is set directly and the editor does not offer Undo. The applied change is an unsaved edit
   like any other.

Clark never writes into the frame, and no model approves a save: export stays the person's act in the host's prompt.

**Asking in the composer.** The editor offers `replaceSelection` (`{text, expected?}`, text at most 4,000 characters)
through `actions.perform@1` ([§10.3](#103-actions-clark-performs-actionsperform1)). When the person types a request
such as "uppercase the selection", Clark can call `perform_widget_action` with the replacement and the text it read as
`expected`. The editor refuses while it is busy (`EDITOR_BUSY`), when nothing usable is selected
(`NO_USABLE_SELECTION`) or when the selection no longer holds `expected` (`SELECTION_CHANGED`); otherwise it removes
control characters, replaces the selection through the browser's editing so Ctrl+Z undoes it, and says "Clark đã thay
đoạn đã chọn. Thay đổi chưa được lưu vào tệp; Ctrl+Z để hoàn tác." The change is an unsaved edit; saving stays the
person's act.

**Accessibility.** Every control is a native button or the text area, in a fixed tab order, with a visible focus ring.
The host's prompts and the editor's panels take the keyboard at their titles, except that the two-views question
leaves it with someone typing. Escape closes whichever panel is open: it dismisses a proposal, cancels opening
another file, and keeps this view's draft in the two-views question. Colours come from the host's appearance tokens
(`appearance@1`), falling back to the system's light or dark preference. Reduced motion removes every transition. The
toolbar wraps at 390 px, and the frame asks the host for its content's height.

Tests: [editor-core.spec.ts](../examples/reference-apps/text-editor/test/editor-core.spec.ts) for the rules,
[package.spec.ts](../examples/reference-apps/text-editor/test/package.spec.ts) for conformance, the manifest and the
copy of the host's cleaning, [pure-ui-template.spec.ts](../packages/widget-cli/test/pure-ui-template.spec.ts) for the
template, [semantic-settle.spec.ts](../packages/conversation-client/test/semantic-settle.spec.ts) for sending a
settling publish before a press, and the browser journey
[text-editor.spec.ts](../apps/web/e2e/text-editor.spec.ts). The journey opens, edits, reloads, saves as a download
and reopens on the web. It keeps typing while a draft write is held on its way to the node and checks that no conflict
appears and nothing typed is lost. Its desktop test is the page's half only: it replaces the original and reopens it
against a simulated preload with the shell's contract. The shell's helpers (handle to path, keeping the type, the
atomic write) are unit-tested in [file-bridge.spec.ts](../apps/desktop/test/file-bridge.spec.ts); the shell's IPC
handler and its confirm dialog are not exercised by either, and a real-shell journey is still to come. The journey
asks Clark through the scripted model, which quotes the selection from the data section, shows the text it would
replace, applies the reply and undoes it, refuses a multi-line selection, and refuses a reply whose range changed. It
runs by keyboard alone, at 390 px in both themes under reduced motion, and checks, with messages recorded in both
directions, that no place on disk or file handle crosses the bridge.

### 24.2 Spreadsheet

`examples/reference-apps/spreadsheet` ([#318](https://github.com/digitopvn/clarkcant/issues/318), part of [#200](https://github.com/digitopvn/clarkcant/issues/200)) is a manifest v2 package with one
isolated UI facet and no service. It shows a widget that works on a file, keeps a large document within bounds,
describes itself to Clark and applies a change Clark chose.

**npm package.** It is packaged as **CSV Explorer**, `@clarkcant/csv-explorer` 1.0.0, with its own `package.json`
and READMEs; its package id stays `com.example.spreadsheet`. `clark widget pack` builds
`dist/clarkcant-csv-explorer-1.0.0.tgz`, and `publish` prepares the npm directory entry. It is **not published to npm
yet**: the publishing account has to own the `@clarkcant` scope first, and its licence is pending the maintainer's
decision (the manifests declare Apache-2.0 while the `LICENSE` file holds MIT text). The same
[install test](../apps/runtime/test/reference-packages-npm-install.spec.ts) as §24.1 covers it.

- **Files.** CSV and TSV come in through `api.artifacts.pick` ([§10.1](#101-files-by-reference-artifacts1)) and are
  read in 256 KiB chunks; the widget never sees a path. An export is a new file written through `create`, `write`,
  `finalize` and `export`, with a byte-order mark as the host's table export writes. XLSX is not supported: there is
  no vetted parser in the tree and the host's file broker does not accept the type.
- **Bounds.** At most 25,000 cells, 64 columns and 5,000 rows are loaded, and no file is read past 8 MiB. The cell
  bound is on the rectangle the rows make (rows times the widest row), the same rule the sheet applies to an edit, so a
  ragged file is cut where its rectangle stops fitting instead of loading a sheet that then refuses every edit. Reading
  stops at the bound and a notice says how much is shown and that an export writes only that part. A read stopped by
  the 8 MiB limit drops the line it stopped in rather than show a fragment as a row, and is flagged as cut even when the
  limit falls on a line end. Blank lines at the end of a file
  are not counted, so they never make a file that fits look cut. Rows and columns are virtualized, so a large sheet
  keeps only the cells in view in the document.
- **State.** The widget state holds the source file's reference, the edits since and the formats, never the sheet
  itself. The active cell and the selection are declared in `ephemeralStateKeys` ([§5](#5-widget-definition)): the
  host keeps them for the frame and never writes them to the node, and moving the cursor sends at most one update per
  pause. Straight after an import the widget writes the sheet to a file of its own, which becomes the source. The
  widget's read grant on a picked file lasts 24 hours from the pick, while a finalized file the widget wrote itself
  does not expire. If that write fails, the status line says so and the next edit tries again; until then the sheet
  still depends on the picked file. When the edits outgrow 10 KiB of the host's 16 KiB, the widget writes the whole
  sheet to a file of its own in the same way and starts again from it. One such checkpoint runs at a time, with at
  most one more queued. Edits made while one is written stay and are saved after it, and only the edits the file
  holds are cleared. Once a checkpoint is committed the widget asks the host to discard the checkpoint it replaced, and
  a checkpoint written for a sheet an import replaced meanwhile is discarded too. A discard the host refuses leaves
  that file in the widget's storage. A checkpoint that does not load whole after a reload says so in the notice.
  Clearing a selection is one batched edit, so clearing the whole sheet takes a moment rather than minutes.
- **Loading.** On mount the sheet is read again from its source. Until it has loaded, the grid takes no edits,
  Import, Export and "Ask Clark" wait, and the status line says the sheet is opening. When the source cannot be read,
  the status line says so, the grid shows only the edits made since and takes none, and nothing is saved, so the
  saved sheet is still there on the next mount. Importing a file starts over from that file.
- **Formulas.** A closed set: arithmetic, cell and range references, and `SUM`, `AVERAGE`, `MIN`, `MAX` and
  `COUNT`. A parser builds a tree that the widget walks; no text is ever run as code. Errors are values (`#DIV/0!`,
  `#VALUE!`, `#REF!`, `#NAME?`, `#PARSE!`, `#NUM!`, `#LIMIT!`), and a circular reference is `#CIRC!` with
  the cells on it named in the notice. One recalculation reads at most 5,000,000 cells through ranges and follows at
  most 2,000,000 links between formulas. `#LIMIT!` marks only a formula past either bound, and the formulas that read
  it; a formula with no range, such as `=1+1`, is always worked out. A running total such as `=SUM($A$1:A3000)` down
  3,000 rows fits.
- **CSV injection.** An export carries computed values, never formulas. Text that starts with `=`, `+`, `-`,
  `@`, a tab or a carriage return is written behind a `'`, the same rule as `toCsv`. Text this sheet would read
  back as something else, such as `007`, `1e3` or text that itself starts with `'`, is written behind a `'` too.
  A leading `'` reads back as text, so an exported file imports into this sheet to the same values. Another
  spreadsheet application shows that `'` as part of the text, as it does for the formula rule.
- **Semantic document.** The selected A1 range, an excerpt of at most 12 rows by 8 columns, the active cell's formula
  and value, and the sheet's size, sized to fit the host's semantic limits so nothing is cut.
- **Formatting through Clark.** The widget's "format as percent" button presses an `agent` binding whose id arrives
  as the `formatBinding` prop and whose context is `selection` and `widget`. The press sends nothing: the host reads
  the range from the widget's semantic document and asks for exactly one line, `format: percent <range>`. The widget
  treats the reply as untrusted. It accepts a closed set of lines, `format: percent|number|plain <range>`, and
  applies one only when the range is the one selected at the press; otherwise it says so and changes nothing. The
  selection is locked until the reply arrives. The sheet keeps at most 32 formats. When a new one pushes out the
  oldest, the status line names the range that lost its format. "Undo format", or Ctrl+Z in the grid, restores the
  formats from before Clark's change. The widget offers no other undo.
- **Keyboard.** The grid is a single tab stop. Arrow keys move, Shift extends the selection, Home/End and
  Ctrl+Home/End jump, and Page Up/Down page. Enter or F2 edits, typing starts an edit, and Enter commits and moves
  down. Escape cancels an edit or collapses a range to its active cell. Delete clears the selection, and Ctrl+Z
  undoes the last format. Tab and Shift+Tab leave the grid, so Import, Export, "Ask Clark" and the rest of the page
  stay reachable. Only while editing does Tab commit and move right.
- **Pointer and touch.** A mouse selects by click, Shift+click or drag. On touch, a tap selects a cell and a swipe
  scrolls the grid. "Select range" makes the following taps extend the selection from the cell tapped before; tap it
  again to stop. Buttons are at least 40 px high.
- **Formatting from the composer.** The sheet offers `format` (`{format: percent|number|plain, range?}`) through
  `actions.perform@1` ([§10.3](#103-actions-clark-performs-actionsperform1)). When the person types "format this as
  a percentage", Clark can call `perform_widget_action`; the sheet formats the given range, or the selection when no
  range is given, and says so in its status line ("Clark đã định dạng B2:C3 thành phần trăm."). It refuses while busy
  or read-only (`SHEET_BUSY`), for an unknown format (`FORMAT_UNKNOWN`) and for a range it cannot read or that is past
  the sheet's bounds (`RANGE_INVALID`). "Undo format" steps back Clark's format like any other.

`place_widget` places the sheet and binds both the offered `format` action and, when asked, the "format as percent"
button's `formatBinding`. Before it runs a press, the host sends the widget's pending semantic document and waits until
the node holds it ([§24.1](#241-text-editor)), so Clark reads the range selected at the press. A reply that names
another range is still refused, and nothing changes.

Tests: unit tests for the parser, formulas, bounds and semantic document in
[test/](../examples/reference-apps/spreadsheet/test/) (56 tests), including checkpoints against a fake host: edits made
while one is written surviving a reload, one at a time, superseded files discarded, a refused one kept in memory, a
sheet replaced mid-write or mid-commit, an import written to the widget's own file, and nothing saved before the sheet
has loaded or after its source could not be read. `clark widget test` passes 22 checks, with 12 needing the dev host. The browser journey
[spreadsheet.spec.ts](../apps/web/e2e/spreadsheet.spec.ts) (4 tests) covers:

- import, edit, export and reimport in CSV and TSV to the same values;
- a selected range Clark formats as percent, with the selection locked while Clark answers, and Undo;
- a file past the bounds that loads its first part, says so, stays responsive, and clears all 25,000 cells at once;
- no path in bridge or frame traffic;
- the grid from the keyboard (Tab and Shift+Tab leave it), by touch with "Select range", and by mouse drag;
- both themes, 40 px buttons, and 390 px with the grid scrolling inside its card;
- a sheet still loading or whose source cannot be read taking no edits and keeping the saved sheet, and a failed
  checkpoint saying what was kept and saving with the next edit.

### 24.3 Image generator

[`examples/reference-apps/image-generator`](../examples/reference-apps/image-generator)
([#319](https://github.com/digitopvn/clarkcant/issues/319), part of
[#200](https://github.com/digitopvn/clarkcant/issues/200)) is a manifest v2 package with an isolated UI facet and a
service facet. It shows a widget that starts long work on a service, follows it, and gets a file back, while the
service reaches a provider with a key it never holds.

- **Capability.** The service offers `com.clarkcant.reference.image-generator.image.generate@1` (a capability ref is
  named under its package's id), with `effectCategory: "external-write"` and `execution: { kind: "job", version: 1 }`.
  A press answers at once with a JobRef ([§10.2](#102-long-running-jobs-jobs1)).
- **Why `external-write`.** Asking a provider to draw is a write to someone else's service: it does work there and
  spends the person's quota. It is also what lets the service start the image with a POST whose prompt is in a JSON
  body: the node sends a service's request with any method but GET or HEAD only for a capability decided as
  `external-write` or above ([§14.2](#142-reaching-a-provider-from-a-service)), and a prompt in a URL ends up in more
  logs than a body does. Under the default autonomous policy a press just runs; a person whose policy asks before
  external writes sees the host's approval card first, and the widget is told the press is waiting.
- **Provider.** The tools facet declares one origin and one secret, `IMAGE_PROVIDER_KEY`. The service starts an image
  with a POST, reads its status once per step and fetches the PNG with GET, all through `clarkcant/egress.fetch`; the
  node adds the key as a bearer header. Until the person stores the key, the button is off with the node's reason. The
  provider in this repository is a fake one in the package's tests: it answers only requests carrying the key, refuses
  a prompt in the URL, and returns a deterministic image. A real provider is
  [#321](https://github.com/digitopvn/clarkcant/issues/321).
- **Progress and result.** Each finished step is MCP progress, which the job records and the widget shows; the widget
  estimates nothing. The PNG comes back as an image part, which the node stores as the job's result artifact. A
  service error is kept on the failed job in the service's words ([§10.2](#102-long-running-jobs-jobs1)), and the
  widget shows them quoted as the service's, inside its own sentence. Every running job has its own panel with its
  progress and its own Stop, which cancels that job; the service stops reading the provider.
- **Gallery.** When the host offers `jobs.list@1`, the widget lists its own jobs, follows the open ones, and reads
  finished images as `ArtifactRef`s in 256 KiB chunks; a reload or another device shows the same jobs, because they
  are the node's. On a host without it, the gallery holds the jobs started while the widget is open and says so. Each
  image can be attached to the conversation or exported through the host ([§10.1](#101-files-by-reference-artifacts1)).
  Attach proposes a name made from a slug of the prompt and the end of the job's id, such as
  `a-red-kite-over-a-green-sea-3f9a1c.png`, so two attached images get two names; the node sanitizes it.
- **Widget, Clark and voice.** The button is an `invoke` action binding named in props as `generateBinding`. It fills
  `prompt` from the draft in widget state, and from the press's input when there is one. Saying the button's label
  with the widget open presses it with the draft, and the reply says the job started. Clark's `invoke_capability` tool
  starts a job capability through the conversation's widget that has a binding to it, so that widget follows the job.
  With none, nothing runs and Clark says so; with several, Clark is told the `instanceId` and `actionBindingId` of each
  and names one. Clark is refused a binding that asks Clark itself, because that press would be sent as the person's
  own message.
- **Language.** Like the text editor ([§24.1](#241-text-editor)), the frame's own text is Vietnamese
  only: DESIGN §11.1 translates the host's default chrome, not a widget's text.
- **Templates.** `clark widget init --template ai-generator` copies this app under the new package's ids, provider
  and all, with the placeholder origin `https://images.example.com` in place of the test provider's: replace it, and
  the paths in `service/server.mjs`, with your provider's before you publish. `--template ui-with-service` copies the
  same widget and job with a service that draws the image itself, declares no provider, and so only reads. Both pass
  `clark widget test` and `pack` as created. `pure-ui` and both of these go through one copier in the CLI.

`place_widget` ([§10.3](#103-actions-clark-performs-actionsperform1)) places the widget in a real installation, with
`generateBinding` bound to the package's `image.generate@1` capability. `prompt` is listed in both `inputs` and
`stateInputs`: a press sends the prompt, and a spoken "tạo ảnh" runs the draft the frame keeps in its state. Until the
person stores the provider key, the button is placed but disabled, with the node's reason.

Tests: [service-job.spec.ts](../examples/reference-apps/image-generator/test/service-job.spec.ts) for the service
against the fake provider through the job host, the egress broker and the artifact broker (completion, progress,
the POST that starts an image, failure, a refused key, cancel, a provider error that echoes the key, and the key absent
from the service's launch, the job, the database, logs, audit, notices and files);
[package.spec.ts](../examples/reference-apps/image-generator/test/package.spec.ts) for conformance and the manifest;
[reference-templates.spec.ts](../packages/widget-cli/test/reference-templates.spec.ts) for the templates and the
shared copier; and the browser journey [image-generator.spec.ts](../apps/web/e2e/image-generator.spec.ts). The
journey covers the key-less refusal, progress across a reload, the gallery, two jobs each with its own Stop, a provider
failure that echoes the key, attach and export, Clark, voice, an approval on the host's card, a host without
`jobs.list@1`, keyboard, both themes, 390 px and reduced motion. After each journey it searches for the key in the
page, the bridge, the node's files and tables, and the service's container.

### 24.4 Media render

`examples/reference-apps/media-render` ([#320](https://github.com/digitopvn/clarkcant/issues/320), part of
[#200](https://github.com/digitopvn/clarkcant/issues/200)) is a manifest v2 package with an isolated UI facet and a
service. It renders a WAV clip the person picks, with a gain change and a trim, as a job the widget follows and can
stop. `clark widget init --template media-tool` starts a new package from it.

**npm package.** It is packaged as **Media Converter**, `@clarkcant/media-converter` 1.0.0, with its own
`package.json`, Apache-2.0 `LICENSE` and READMEs. `clark widget pack` builds
`dist/clarkcant-media-converter-1.0.0.tgz`, and `publish` prepares the npm directory entry. It is **not published to
npm yet**: the publishing account has to own the `@clarkcant` scope first. Installing it needs no container engine,
and the same [install test](../apps/runtime/test/reference-packages-npm-install.spec.ts) as §24.1 installs it;
rendering needs a container engine that runs Linux containers.

- **Files by reference.** The widget picks the clip through `api.artifacts.pick` ([§10.1](#101-files-by-reference-artifacts1))
  and keeps only its `ArtifactRef`. Its `render` binding sends the service the clip's artifact id, and the service
  reads the bytes from the node a chunk at a time ([§14.4](#144-files-a-service-reads)). The widget never sees a path,
  and the service gets no path or handle. The service declares no egress, and a `read` call that holds a file could
  not use any.
- **Profile.** The package asks for `background-compute` by name ([§14.1](#141-resource-profiles)). The node refuses a
  clip over the profile's 25 MiB input cap before the call is sent. The service refuses a clip longer than the
  profile's hour before it renders anything, and a render larger than one result may carry.
- **Job.** The press answers with a JobRef ([§10.2](#102-long-running-jobs-jobs1)), which the widget keeps in its state.
  Progress is the service's own MCP progress, in bytes rendered. Stop, or Escape, cancels the job; the service stops
  reading and does not answer, so no partial file is kept. A stop the node refuses says so and offers Stop and Escape
  again. A reloaded frame follows the same job from its state. A new press replaces the shown render only once the node
  accepts it, so a refused press keeps the earlier file with Attach and Save. A render that completed but whose file the
  node could not keep says what failed and that the source file is still there.
- **Touch.** The gain field asks for a text keyboard (`inputmode="text"`), because a decimal keypad on iOS has no minus
  key and most of the range is a cut. It accepts a typographic minus and a decimal comma. Every button and field is at
  least 44 px tall.
- **Preview.** The finished file is a finalized `ArtifactRef`. The widget reads it back and draws a waveform on a
  canvas, with the duration, the format and the node's sha256 digest. The frame policy has no media source, so there is
  no audio player. Attach puts the file in the composer; Save goes through the host's export prompt.
- **Unavailable profile.** When the node cannot grant `background-compute`, because a policy rule refuses it or the
  container engine is too small, the service is not started. Render is disabled, and the host's reason is shown in its
  place.
- **Fixture pacing.** A node started with `CC_MODEL_FIXTURE=1` holds each answer to a service's file read back 700 ms
  (`timings.artifactReadDelayMs` on the service host), so the journey can watch progress and stop a render mid-way. The
  service's tool has no pacing argument, and neither does the `media-tool` template.
- **Placement.** `place_widget` ([§10.3](#103-actions-clark-performs-actionsperform1)) places the widget in a real
  installation, with `renderBinding` bound to the package's `render@1` capability and `source`, `gainDb`, `trimStartMs`
  and `trimEndMs` as its `inputs`.

Tests: [wav.spec.ts](../examples/reference-apps/media-render/test/wav.spec.ts) for the transform and its pinned digest,
[service.spec.ts](../examples/reference-apps/media-render/test/service.spec.ts) for the service process (progress,
cancel, the caps, a refused read), [package.spec.ts](../examples/reference-apps/media-render/test/package.spec.ts) for
conformance and the manifest,
[media-tool-template.spec.ts](../packages/widget-cli/test/media-tool-template.spec.ts) for the template, and the
browser journey [media-render.spec.ts](../apps/web/e2e/media-render.spec.ts). The journey renders a clip of twelve
chunks with progress and a preview, keeps that preview through a refused press, stops one mid-way after a refused stop,
follows one across a reload, shows the refused profile's reason, and runs keyboard-only at 390 px in dark with reduced
motion, with 44 px controls and a negative gain. It needs a container engine that runs Linux containers.

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

Target root manifest:

    {
      "schemaVersion": 1,
      "id": "com.example.calendar",
      "version": "1.2.0",
      "displayName": "Calendar Plus",
      "description": "A compact agenda and week view.",
      "hostApi": { "min": 1, "max": 1 },
      "facets": [
        {
          "kind": "widget",
          "id": "com.example.calendar.week@1",
          "entry": "widgets/main/index.html",
          "definition": "widgets/main/widget.json",
          "isolation": "isolated-ui"
        }
      ],
      "requestedCapabilities": [],
      "permissions": {
        "networkOrigins": [],
        "filesystem": [],
        "microphone": false,
        "camera": false,
        "lifecycleScripts": []
      },
      "platforms": ["darwin-arm64", "linux-x64", "win32-x64"],
      "publisher": {
        "id": "example",
        "sourceUrl": "https://github.com/example/calendar-plus",
        "license": "MIT"
      }
    }

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

## 8. Actions

A hard distinction:

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

---

## 9. Semantic contract for voice

A widget must publish a semantic view when its actionable state changes:

- summary;
- selected IDs;
- available actions;
- concise text representation.

Voice and click must call the same action binding/state path.

Do not publish raw DOM, hidden text, the full dataset or secrets just so voice can “understand the screen”.

Example:

    semantic.publish({
      summary: "Calendar for September 2026; September 20 selected.",
      selectedIds: ["2026-09-20"],
      availableActions: [
        { actionBindingId: "act_create_event", label: "Create event" }
      ]
    })

---

## 10. Widget SDK surface

Author-facing target:

    props.read()
    props.subscribe()

    state.get()
    state.update(expectedRevision, patch)

    events.emit(name, payload)

    actions.invoke(bindingId, input, invocationId)

    capabilities.request(ref, justification)

    host.focus()
    host.resize({ height })
    host.requestPin()
    host.requestDetach()
    host.openExternal(approvedUrl)

    semantic.publish(summary, selectedIds, availableActions)

    lifecycle.onMount()
    lifecycle.onSuspend()
    lifecycle.onResume()
    lifecycle.onDispose()

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
generation: instances go offline with a text fallback, and state and snapshots are kept. **Restore** reactivates exactly the
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
package with a nested `.git` directory (a vendored checkout) is still hashed in full.

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

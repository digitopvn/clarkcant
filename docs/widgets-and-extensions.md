# Widgets, Mini-apps, Pins & Extension SDK v2

> English (default) · [Tiếng Việt](widgets-and-extensions.vi.md)

**Date:** 16/09/2026. This is the app's proposed contract, not the upstream Pi/MCP wire schema.

## 1. Redefining the widget

A widget is a UI implementation that receives **props + data bindings + agent-defined actions**. The agent does not need to write a webapp for every response, and the app developer does not have to hardcode business logic for every button the agent might come up with.

There are two paths at the same time:

1. **Catalog widgets:** installed components that render quickly from schema-backed JSON. The agent picks the component, passes params and wires up actions. They can be composed into a mini-app with layout/state primitives.
2. **Custom mini-apps:** the user or a third party writes a real UI and packages it as an approved package. It runs in an isolated host, with an SDK to receive props/context, store state, send events and call approved capabilities. MCP Apps is the supported integration protocol for this path [R06–R08].

A widget can be just a static chart. It can also be a note editor, a player, a conversation view or a video call. A rich SDK does not mean every vendor integration is already packaged.

## 2. Mental model

```text
Capability / tool / user prompt
          ↓
Agent selects widget + props + actions
          ↓
Host validates, resolves references, binds grants and versions
          ↓
Render trusted catalog OR isolated mini-app
          ↓
User clicks / types / speaks
          ↓
View update OR capability invocation OR new agent intent/workflow
          ↓
Verified state/result → update widget and conversation
```

"The agent defines the action" is real: the agent may choose the tool and arguments within the scope of the available capabilities, or create an intent for a new agent turn. The core only checks and executes according to permissions; it does not narrow this down to a fixed list of business buttons.

## 3. Widget definition and instance

### 3.1 Definition registered by a package

```typescript
interface WidgetDefinition {
  id: string;                 // Namespaced, e.g. example.notes.editor
  version: string;
  renderer: 'catalog' | 'isolated-app' | 'mcp-app';
  propsSchema: object;        // Runtime JSON Schema
  eventSchemas: Record<string, object>;
  stateSchema?: object;
  stateVersion?: number;
  semanticDescription: string;
  requestedCapabilities: string[];
  sizing: { compact: boolean; expanded: boolean; minHeight?: number };
  textFallback: string;
  entryArtifact?: string;     // Installed, integrity-checked bundle; not arbitrary URL
}
```

A definition is discovered like a capability, with preview/examples/prop docs. The whole widget catalog is not stuffed into the model context. An unknown component/version has a fallback; JavaScript is never fetched from a URL the model supplied itself.

### 3.2 Instance and snapshot

```typescript
interface WidgetInstance {
  instanceId: string;
  definitionRef: { id: string; version: string; packageDigest: string };
  ownerNodeId: string;
  ownerPrincipalId: string;
  revision: number;
  props: unknown;
  stateRef?: string;
  dataRefs: string[];
  connectionRefs: string[];
  actionBindingIds: string[];
  lifecycle: 'ready' | 'active' | 'suspended' | 'needs_auth' | 'offline' | 'error';
}
interface WidgetSnapshot {
  snapshotId: string;
  instanceId?: string;
  messageId: string;
  capturedRevision: number;
  capturedAt: string;
  textAlternative: string;
  presentationRef: string;
}
interface Pin {
  pinId: string;
  conversationId: string;
  instanceId: string;
  displayMode: 'compact' | 'expanded';
  position: number;
}
```

Schemas must validate the `unknown` fields against the definition; nothing is passed through to the DOM. History keeps snapshots with their update date. A pin holds the current instance; history is not rewritten into current data without a clear indication.

## 4. Rich built-in catalog

The core owns only the renderer/registry/action/state primitives. Heavy implementations can be shipped/lazy-loaded as first-party UI packs; the user still sees one unified app.

| Group | Main components and interactions | Practical gate |
|---|---|---|
| Layout | Stack, Row, Grid, Card, Tabs, Divider, collapsible group | Responsive, bounded layout, does not create its own global navigation |
| Text / status | Rich text, Markdown, code, badge, metric, progress | Sanitization, evidence/state from a real source |
| Choice | Chips, select, multiselect, command choice | Stable IDs, keyboard, no hidden expanded permissions |
| Form | Text, number, date/time, slider, checkbox, file request | Client+server validation, no raw secrets in ordinary form |
| Lists | Result list, checklist, tree subset, contacts | Filter/select, not session sidebar by default |
| Tables | Sort/filter/page/select, totals, CSV export | Dataset/view coherence, formula injection protection |
| Charts | Line/bar/area/donut/scatter, series toggles | Units/source/missing values, no arbitrary JS callback |
| Diagram / graph | Flow/sequence/node-edge, zoom/fit | Bounded parser/layout, sanitize output |
| Map | Pins, clusters, GeoJSON, feature selection | Attribution, provider policy, geolocation only consent |
| Calendar | Agenda/month/week, date selection, event preview | Timezone/date-only/recurrence display correctness |
| Timeline / board | Activity timeline, simple kanban cards | Updates are actions, not optimistic external success |
| Files / artifacts | Image, download, code diff, document preview | MIME/ownership/content validation, no arbitrary file:// |
| Notes / editor | Plain/rich text, checklist, autosave status | Draft/version/conflict preservation, no silent overwrite |
| Media | Audio/video player, playlist, now-playing controls | One active playback owner, browser policy/licensing gates |
| Conversation | Thread/messages, composer, delivery status | Sender/account scope, clear draft/send distinction |
| Call surface | Join/leave, participant state, mic/camera controls | Real SDK + host permissions, no silent recording |
| Browser / computer | Screenshot/live preview, target, takeover, stop | Session lease, authenticated media, never privileged app browser |
| Operational cards | Connection status, install plan, device/task state | Host-owned trust indicators, typed underlying state |

"A rich editor" does not mean copying all of Notion. "Conversation widget" does not mean every service has the same inbox permissions. Domain behavior comes from the existing adapter/extension.

Host-only approval/credential/device consent cards are not part of the ordinary third-party catalog. The model can ask the host to open a flow, but it cannot define a "permission granted" state itself.

### 4.1 Implementation status (2026-09-17)

This records which parts of §4 are already in the repo and which are still design, so the table above is not read as an inventory of finished features.

**Present, with tests:**

- Catalog + family definitions in `packs/data-canvas`: `canvas.line/bar/donut/table`, `canvas.metrics`, `canvas.filter`, `canvas.calendar`, `canvas.image`, `canvas.cta` (kept so history renders), the generic action button `canvas.action@1`, the input primitives `canvas.choice@1`, `canvas.input@1`, `canvas.search@1`, `canvas.form@1` and `canvas.list@1` ([widget development §8.2](widget-development.md#82-forms-lists-search-and-fields)), the read-only cards `canvas.status@1`, `canvas.progress@1` and `canvas.details@1` ([widget development §8.4](widget-development.md#84-status-progress-and-details-cards)), and the container `canvas.overview@1`.
- Leaf renderers in `packages/conversation-client` (a real donut, month grid, KPI tile, image, CTA) together with a text alternative for every region.
- Cards that show a piece of work: `canvas.code@1` (a block of code with line numbers and a copy button), `canvas.diff@1` (a unified diff whose headers and counts are worked out from its lines) and `canvas.file@1` (a file named and described, with no link, open or download). They show only what the model wrote, as text, and fetch nothing. The node refuses props that do not fit before an instance exists, and they are not layout leaves ([widget development §8.5](widget-development.md#85-code-diffs-and-files)).
- The sketch's **image** region now actually reaches the user: `publishMiniAppData` returns the most recently imported image, the `overview` template has an `image` slot (fixed, optional depending on the data), and the region's text alternative carries the **alt text the user entered**. Images go through a `blob:` URL because the token cannot sit in `<img src>`, so the CSP in `apps/web/index.html` must allow `img-src ... blob:` — without it, every imported image renders as "Could not load the image" even though the node returns the correct bytes.
- **Declarative composition** (the second trust tier in the table above) is the tier currently used for mini-apps: the spec is versioned, each section pins `definitionRef.digest`, there is no executable payload, and an action is only a reference to a server-compiled binding.
- A snapshot is an **immutable bundle** in its own table (`presentation_bundles`), not a `catalog:id` pointing at current data; deleting the data source → tombstone, it is not re-read live.
- Pin = the same logical instance, one live owner with a lease (`widget_live_owners.lease_expires_at`), the remaining locations are read-only.
- **Read-only blocks actions only, not view state**: a historical snapshot and a surface owned by another tab can still change the selected date / viewed period (that is presentation), but they have no `onAction`, so there is no path to the server; the CTA button shows a disabled state with a reason instead of pretending to be clickable.
- A snapshot points at the message that contains it: `messageId` is issued **once** and then used for both the composer call and the recorded message, so there are no orphaned snapshots (the test `apps/web/e2e/mini-app.spec.ts` covers this history path).
- Mini-app actions are `period.change`, `date.select` and `view.save` (`view` kind) and go through `invokeMiniAppAction`. The host dispatches any other bound action by its binding, never by what the widget says: an `invoke` binding goes to `invokeCapability` and runs only when it names a package service capability on this node ([widget development §4](widget-development.md#4-package-manifest)); an `agent` binding starts a turn whose message is the button's label, with the context its `contextRefs` name read by the host; a `workflow` binding runs its closed steps in order, each `invoke` step through `invokeCapability` with its own policy decision ([widget development §8.1](widget-development.md#81-the-generic-action-button-canvasaction1)).
- The deterministic composer `CC_MODEL_FIXTURE=1` exists only so the browser suite can run the composed-surface path without calling a provider; the node prints a warning at startup and the answer states that it is a fixture.
- **An isolated widget frame outlives its URL's grant** (#233). A frame's URL carries a grant in its path that works for five minutes (`FRAME_GRANT_LIFETIME_MS` in [frame-grant.ts](../packages/core/src/frame-grant.ts)), so a copied URL stops working; the frame showing it can stay open much longer. `GET …/widgets/{instanceId}/live` says how long the URL lasts as `frame.urlExpiresInMs`, and the client counts that from when it sent the read, so its deadline is never later than the node's. A frame that has to load its document again after that deadline — mounted again from a kept answer, or reloaded by the browser — reads the instance once for a fresh URL instead of showing the node's refusal, and the widget gets its committed state again. If that one read fails too, the frame says what failed, that what the widget saved is kept on the node, and offers **Try again**; it does not retry on its own. The frame receives nothing new: the fresh URL is the same kind of grant for the same document.
  - `CC_FRAME_GRANT_FIXTURE=1` lets the browser suite shorten the lifetime of the grants minted next through `POST /frame-grant-fixture/lifetime` (behind the bearer token), so a lapse takes seconds. It can only shorten it, a node started without it answers that route with 404, and the node prints a line at startup when it is loaded.
  - Tests: [frame-grant-lifetime.spec.ts](../apps/runtime/test/frame-grant-lifetime.spec.ts), [frame-grant-renewal.spec.ts](../packages/conversation-client/test/frame-grant-renewal.spec.ts), and the browser journey [widget-frame-grant.spec.ts](../apps/web/e2e/widget-frame-grant.spec.ts).
- **A layout tree** lets a model arrange a composed surface without a new template (#224). `show_view` with `canvas.overview@1` and `props.layout` takes a tree of `stack`, `row`, `grid` (1–4 columns), `card`, `tabs`, `split` (exactly two), `collapsible` and `divider` nodes whose leaves are `{ kind: "widget", widget: "<catalog id>", props?, label? }`. Without `props.layout` the `overview`, `focused` and `agenda` templates still run as recipes.
  - The node compiles the tree ([compose-layout.ts](../apps/runtime/src/compose-layout.ts)): each leaf must be a leaf widget this node's catalog holds (not the container, not `canvas.action@1` or `canvas.form@1`, which are placed with their own `show_view`, and a `canvas.choice@1` or `canvas.input@1` only with an `on` rule that writes the surface's state, since otherwise its value would go nowhere), its props are checked against the definition's full JSON Schema, its data is bound by the host (a `datasetRef` from the model is overridden), and its definition digest is pinned. The stored tree names sections by id only, so it carries no widget ids, props or code.
  - Bounds come from [composition-layout.ts](../packages/contracts/src/composition-layout.ts): at most 5 levels, 40 nodes, 12 children per container, 8 tabs and 12 widgets. A tree past a bound, with a field a node does not have, or with a widget the catalog does not hold is refused with the reason, and nothing is written.
  - A spec with a tree is `schemaVersion` 2 and is stored in the immutable presentation bundle, so a reloaded conversation draws the same tree from history. Every node has a text alternative built from its labels and its sections.
  - The client draws the tree in [mini-app-surface.tsx](../packages/conversation-client/src/mini-app-surface.tsx): a grid never draws more columns than the tree asks for, nor a column narrower than 220px, a split stacks when the surface is narrow, tabs follow the WAI-ARIA tab pattern (arrows, Home and End), and a collapsible is a native `<details>`.
  - Tests: [composition-layout.spec.ts](../packages/contracts/test/composition-layout.spec.ts), [compose-layout.spec.ts](../apps/runtime/test/compose-layout.spec.ts), and the browser journey [layout-tree.spec.ts](../apps/web/e2e/layout-tree.spec.ts), which also runs at 375px.
  - A `canvas.search@1` leaf narrows every table in the same surface, on the page: a "Card(Search, Table)" is a card holding a search leaf above a table leaf (#225). A `canvas.list@1` leaf shows items but carries no item button, because a leaf binds no action.
- **A state graph** connects the widgets of one composed surface (#226). `props.state` declares at most 16 typed keys; a leaf's `on` rules turn an event its definition emits (`query.change`, `choice.change`, `input.change`, `selection.change`, `row.select`, `date.select`) into closed steps that write those keys, and its `feed` reads a key as a table or list query or as an exact-match filter on a table column, a list field or a chart's series. A leaf never names another leaf ([widget development §8.3](widget-development.md#83-connecting-widgets-on-one-surface)).
  - The rules are data in [composition-graph.ts](../packages/contracts/src/composition-graph.ts), checked by the node before anything is stored. An undeclared key, an event the definition does not emit, a feed the definition does not read, or a step that writes the wrong type is refused with the reason.
  - Each wired leaf gets a `state.event` view binding. The page applies an event at once and sends it; the node applies the same rules to the value it stored in `widget_state` and keeps the result, so the live surface shows the same values after a reload. The transcript's copy keeps its captured starting values and can be explored on the page without sending anything.
  - `GET …/widgets/{instanceId}/live` returns the values as `semanticState` for an agent to read, bounded and typed. A surface with no declared state stores no graph and binds nothing: its search box narrows tables on the page, as before.
  - Tests: [composition-graph.spec.ts](../packages/contracts/test/composition-graph.spec.ts), [composition-graph.spec.ts](../apps/runtime/test/composition-graph.spec.ts), [surface-graph.spec.ts](../packages/conversation-client/test/surface-graph.spec.ts), and the browser journey [composition-graph.spec.ts](../apps/web/e2e/composition-graph.spec.ts).
- **The next turn knows what the person changed on screen** (#195). A pick, a search or a save on a widget starts no turn and writes no message; the node marks the widget as touched in `widget_semantic_state` (migration 27). When the next turn starts it rebuilds each touched widget's bounded, redacted document ([widget-semantic.ts](../packages/contracts/src/widget-semantic.ts)), moves its revision only when the document changed, and appends a short note after everything else in the prompt: the whole document for a session that has not seen it, the delta for one that has, nothing when nothing changed. At most three widgets in about 2,400 characters; the read-only `inspect_ui` tool reads the rest for this conversation only. Voice reads the focused widget from the same document. A frame proposes its own summary, selection and values through `POST …/widgets/{instanceId}/semantic`, which a strict schema checks; it cannot name actions ([widget development §9](widget-development.md#9-semantic-contract-for-voice-and-the-next-turn)).
  - Tests: [widget-semantic.spec.ts](../packages/contracts/test/widget-semantic.spec.ts), [widget-semantic.spec.ts](../packages/storage/test/widget-semantic.spec.ts), [widget-semantic.spec.ts](../apps/runtime/test/widget-semantic.spec.ts), and the browser journey [widget-semantic.spec.ts](../apps/web/e2e/widget-semantic.spec.ts).
- **Status, progress and details cards** (#280, part of #198). `canvas.status@1` shows one status with a tone said in words, `canvas.progress@1` shows a value of a maximum as a real progress bar or a list of steps with the current one marked, and `canvas.details@1` shows labelled facts. A model places them with `show_view` or as layout leaves in the `status` region. The node refuses props that do not fit, such as a value above its maximum, progress with neither a value nor steps, or an `asOf` time without an offset, and text with a line break, a bidi control or an invisible character. The text alternative is the card's own words. Voice and `inspect_ui` read the card as stated when shown, with freshness `unknown`. No card shows a freshness badge or a control; a progress card, and a status card with no `asOf`, says "As Clark stated at" the time its message was kept ([widget development §8.4](widget-development.md#84-status-progress-and-details-cards)).
  - Tests: [status-cards.spec.ts](../packages/contracts/test/status-cards.spec.ts), [status-cards.spec.ts](../apps/runtime/test/status-cards.spec.ts), [status-cards.spec.ts](../packages/conversation-client/test/status-cards.spec.ts), and the browser journey [status-cards.spec.ts](../apps/web/e2e/status-cards.spec.ts).
- **Area and scatter charts** (#282, part of #198). `canvas.area@1` draws one or more series along an x axis, filled down to zero or stacked, and `canvas.scatter@1` draws a point per row and series at its x and y, optionally named by a field. The fields are named in the props, never guessed. A model places them with `show_view`; they are not layout leaves. The node reads the named dataset as the person placing the chart and refuses, with the reason and before an instance exists, a field the rows lack, a value that is not a number, and a dataset that is not theirs. A chart draws the first 500 rows and says when there are more. Series have a tone, a line pattern and a point shape each, the legend hides and shows them, every point is reachable with the keyboard, and a table of the rows is under the chart. The series hidden and the point selected are a `chart.view` the node checks against the rows it holds and keeps in widget state, so a reload, voice and `inspect_ui` see the same view ([widget development §8.6](widget-development.md#86-area-and-scatter-charts)).
  - Tests: [xy-charts.spec.ts](../packages/contracts/test/xy-charts.spec.ts), [xy-charts.spec.ts](../apps/runtime/test/xy-charts.spec.ts), [chart-layout.spec.ts](../packages/conversation-client/test/chart-layout.spec.ts), [xy-chart-schemas.spec.ts](../packages/widget-catalog/test/xy-chart-schemas.spec.ts), and the browser journey [xy-charts.spec.ts](../apps/web/e2e/xy-charts.spec.ts).

- **File attachments reach the agent**: the composer uploads, the bytes live in the shared blob store (`dataDir/blobs`, content-addressed, `mode: 0o600`), the quota is counted per principal, and the file type is decided by **magic bytes**, not by the file extension. The prompt carries only an opaque `att_…` and **never** a path; the agent reads the content through the host tool `read_attachment(attachmentId)`, which takes no path parameter, so there is no way to open another file. The stored message is the single source — the timeline and the prompt are two readings of the same row (`apps/web/e2e/attachments.spec.ts`; the prompt part is proven at the adapter boundary with `FakePiAdapter.promptsFor()`).
- **Memory** (`memory_records`, migration 18) is **not** a second search index. Deleting a memory deletes the **injection path** into the next turn — the brief is re-read every turn rather than cached in the process — while the user's original message stays in the conversation history and remains visible. So this is not hidden memory: everything remembered can be read and deleted in the Memory tab (`apps/web/e2e/memory.spec.ts`).
- The **desktop window** reaches the real client: `electron . -- --renderer-url <url> --data-dir <dir>`, a CSP derived from the origin, and a named bridge `getSession()` that returns `{ baseUrl, token }` read from `identity.json`. The token does **not** go into argv or the URL, where it would sit in the process list and in the browser history.
- `?cc-compact=1` is a **test-only path** so the browser suite can reach the minimal voice bar; it is not a feature. The real path into that state is the minimized window.
- **Widget Library and Widget Lab**: the built-in widget catalog can now be browsed from Settings → Extensions (library) and Settings → Developer (Lab). The preview calls the same `resolveRenderer` the conversation uses, so it is the running renderer rather than a screenshot, and a definition without a renderer shows a reason instead of staying silent. The surface sits **beside** the conversation: opening it does not unmount the composer. Installed packages are listed as **provenance** on a separate list (version, source tier, digest, trust lane) rather than as cards in the catalog, because no route exposes a package's widget definitions. Details in [widget-development.md](./widget-development.md) §23.
- **`canvas.table@1` honours its whole contract** (still `@1` with state version 1, because the new props are optional). Columns can be declared with a label, a type (`text`, `number`, `date`, `datetime`, `boolean`), a format (decimals, unit, percent) and an alignment. The table also accepts `pageSize` (5–200, default 25), `rowIdField`, `selection` (`none`, `single` or `multi`), `totals` (`sum`, `avg`, `min`, `max`, `count`) and `searchable`.
  - One set of pure functions in `packages/contracts/src/table-view.ts` (`tableView`, `tableSemanticState`, `toCsv`) sorts, searches, filters, pages and totals the rows. The page and the node both use them, so an exported file holds exactly the rows the person was looking at.
  - The renderer has sortable headers that work by pointer and by Enter/Space and carry `aria-sort`, a labelled search box, labelled pagination ("Page 2 of 7 · 153 rows"), checkboxes for multi-select, a totals row and locale-aware number and date formatting. It draws at most one page of rows at a time. The checkbox column and the first column stay pinned at the start edge while the rest scroll sideways, and a shadow marks the side with more columns. A multi-selection holds at most 64 rows: at that limit the remaining checkboxes are disabled and the status says why. A selected row that the search hides is still counted, and **Clear selection** empties the selection without having to find that row again.
  - `row.select` carries only `{ rowIds }`. When the rows have no `rowIdField` (and no `id`), the table falls back to the dataset index, which moves when the dataset changes. `tableSemanticState` reports that as `stableIds: false`; it is not yet wired into the node's semantic view (see below).
  - **CSV export** goes through `POST /conversations/{id}/widgets/{instanceId}/export`, which is authenticated and person-only. The node reads the rows from the instance's own `props.datasetRef`; the request carries only the view (sort, search, filters, columns), never rows or a dataset id. Rows are chosen over every column the table shows, just as on screen. `columns` only narrows which of those columns the file carries. A refusal the node would repeat, such as a dataset that is gone, disables the button and shows the reason instead of inviting a retry. Any cell a spreadsheet would run as a formula (`=`, `+`, `-`, `@`, tab, CR) is prefixed with `'`. A read-only snapshot, and a table inside a combined view, show export disabled together with the reason.
  - Tests: `packages/contracts/test/table-view.spec.ts`, `packages/conversation-client/test/table-model.spec.ts`, `apps/runtime/test/table-export-route.spec.ts`, and the browser journey `apps/web/e2e/table-contract.spec.ts`.
  - **Not yet:** the sort, page, search and selection are held by the client (per instance, for the life of the page) and are **not persisted on the node**. What a surface needs to keep, such as the rows a person selected, is kept by wiring `row.select` into the surface's state graph (above). The node's semantic view of a table does not yet use `tableSemanticState`.

**Not present (deferred, must not be claimed as done):**

- `isolated-app` and `mcp-app`: the sandbox policy/registry has code and tests, but **the renderer runtime for isolated apps is not proven**. There is no app runtime in the repo.
- The Google Calendar connector and custom iframe mini-apps are outside M1. An agent button cannot yet name an `artifact:` context reference (#313), and approving a workflow step runs that step alone rather than resuming the workflow.
- The family coverage table in §4 is still the release-gate target: the repo currently has tests for the families the composed surface needs (`metrics`, `filter`, `trend`, `calendar`, `media`, `cta`, `tables`, `layout`), not for the whole list.

- **File content reaches the agent**: text files go into the turn's prompt (`attachmentBrief` inserts the content, `read_attachment` re-reads it by id), **PDFs have their text extracted** with `apps/runtime/src/pdf-text.ts` (no added dependency), and two journeys prove the answer **uses** that content — one for a text file, one for a PDF ([attachments](../apps/web/e2e/attachments.spec.ts)). **An image is delivered as an image**: `read_attachment` returns `{ type: "image", data, mimeType }` and `toSdkTool` passes that block unchanged to the SDK, so the model receives the image itself rather than a sentence describing it. Two tests hold this: one at the adapter seam (`packages/pi-adapter/test/pi-adapter.spec.ts`, "hands the image to the SDK as an image block, not as a sentence about one") and one at the tool (`apps/runtime/test/read-attachment-tool.spec.ts`, "hands a picture over as a picture rather than describing it").
- **No conversation delete route yet**: retention is currently `releaseConversationAttachments`. Four tables reference `conversations` without `ON DELETE CASCADE`, and `PRAGMA foreign_keys = ON`, so deleting a conversation needs a migration that handles those references first.

Both of these gates run in CI: the `e2e` job runs the browser suite, and the `desktop smoke (xvfb)` job runs
`electron . --smoke-test` under `xvfb-run` (added in PR #44). The window evidence therefore no longer depends on a
run by an operator. The first run of those two jobs found two real bugs, and both were fixed at the root: Electron
could not start because the SUID sandbox could not be configured on the runner, and a keyboard journey took focus while
the panel was still appearing, so `focus()` was dropped.

## 5. Agent-defined actions

### 5.1 Four kinds of action

```typescript
type ActionProposal =
  | { kind: 'view'; operation: string; args: object }
  | { kind: 'invoke'; capabilityRef: string; args: object; bindings?: FieldBinding[] }
  | { kind: 'agent'; intent: string; contextRefs: string[]; inputSchema?: object }
  | { kind: 'workflow'; steps: WorkflowStep[]; inputSchema?: object };
```

- **view:** a client-local transient gesture or canonical view state. Filter/zoom/playhead UI does not call the model every time.
- **invoke:** the agent picks a discovered tool/API/MCP capability, target node/account and arguments, and lets the user provide bound fields. The app does not need to write a dedicated "PlaySpotifyButton".
- **agent:** a click becomes a new intent with defined context, for example "find another time slot for this event". The intent may be written by the model; the host presents the label exactly and does not treat that text as permission.
- **workflow:** a chain of bounded steps from known capabilities, with a controlled enum of conditions/transforms. No arbitrary JS, shell interpolation or infinite loops.

View operations have a registry, but domain actions are not limited to a fixed registry of core business handlers. The capability registry from installed extensions is the extension point. A capability that does not exist yet must go through an install/connect flow; a tool name invented by the model is not treated as executable.

### 5.2 Calendar example

```json
{
  "widget": "agent.calendar.agenda@1",
  "props": { "title": "This week", "eventsRef": "dataset_events_demo", "timezone": "Asia/Ho_Chi_Minh" },
  "actions": {
    "refresh": {
      "kind": "invoke",
      "capabilityRef": "google.calendar.events.list@1",
      "args": { "connectionRef": "conn_demo", "calendarRef": "cal_demo", "rangeRef": "range_this_week" }
    },
    "findAnotherTime": {
      "kind": "agent",
      "intent": "Suggest another time for the selected event; the calendar has not been updated.",
      "contextRefs": ["selectedEvent", "conn_demo"]
    }
  }
}
```

This is illustrative data, not a connected integration. The host resolves refs, verifies ownership, binds the real account/node, whitelists user-controlled fields and verifies requested scopes. A "View calendar" label must not hide an event-delete action: the host classifies the effect from the capability and shows the real operation when asking for permission.

### 5.3 Binding and execute

The host issues an action ID with the instance/definition/package generation, input schema, allowed data refs, fixed connection/resource constraints, policy requirement and action spec digest. The action ID is not a bearer authorization token.

The client sends `instanceId + actionId + expectedRevision + input + commandId`. The backend authenticates, dedups, validates inputs/schema/refs, checks the current generation/connection/grants, then commits the intent. Token/rate/deadline limits apply before calling the conductor from an agent-intent action.

Versioning distinguishes presentation-only revision, data revision and action-binding revision; it does not invalidate every button just because a tooltip changed. But a change in target/account/tool generation/meaning must create a new binding, and the old approval does not carry over.

A task may already be complete while the instance action is still valid, because a new invocation creates a new operation/task. An old task approval does not become permanent for a pinned widget.

**What the node runs today** (#314): each binding carries limits clamped to ceilings when it is compiled (deadlineMs, maxTokens, maxCallsPerMinute); an agent binding's context is read by the host, measured against its token budget before any model call, and given to the model only as a separate, neutralised data section, never as guidance; a call that is not a read is written to the effect ledger before it is sent, and one sent without a trustworthy answer is reported as uncertain, becomes an unknown effect (with an inbox question only when the ledger recorded it, a node crash mid-call included) and is never retried; and an invocation id keeps one outcome across a restart. A workflow calls capabilities of one package only, stops at the first step that does not complete, names it, and claims no rollback for the steps before it. The details, limits and response shapes are in [widget development §8.1](widget-development.md#81-the-generic-action-button-canvasaction1).

## 6. Pin UX and state ownership

**A pin is a gesture that keeps a mini-app in the conversation, not the opening of an extra dashboard product.** The user can say "pin this calendar", press pin, "minimize the player", "unpin".

By default there are no pins. When there are, the compact area sits next to the chat/composer or header, not a session/sidebar. Only one expanded surface by default; other pins are compact chips/cards; overflow does not take over the whole screen. All operations remain callable through chat. No auto-pin at the agent's discretion when the user has not asked for it.

A pin points at the same logical instance. The timeline can show its snapshot and a focus button. **A player/call must not mount two live effect owners** when it is both inline and pinned. The renderer moves the location/ownership; the other copy is only a read-only preview. Reordering pins does not restart audio.

### 6.1 Lifecycle

- Unpin removes the presentation preference; it does not delete the note or cancel a remote job by itself.
- Closing a mini-app is different from unpinning; an active call needs an explicit "leave call".
- Restart restores snapshot/draft/pin order. It does not auto-play media, join a call or turn on the mic.
- A read subscription resumes only when the user has granted a standing refresh grant, with the correct visibility/budget. Without one, show "updates when opened".
- A pin does not create a periodic LLM task by itself. Data refresh uses a deterministic adapter, with TTL/backoff and last-updated.
- Offline keeps the cached read view and field drafts; mutations are not sent automatically when the network returns unless there is a policy queue the user understands/accepted. A sensitive mutation needs revalidation before sending.
- An unavailable widget/server/package still shows text/snapshot; it does not "disappear from history".

### 6.2 Drafts and conflicts

The note editor, forms and the messaging composer have a draft store separate from external committed state. Remote autosave happens only after a grant covering the content; show saving/saved/conflict. If the API supports ETag/version, use it; if not, fetch-compare or warn of a best-effort merge, and do not pretend editing is conflict-free.

A schema change does not automatically send a draft into different fields. State migrations have version/test/backup; a failing upgrade keeps the snapshot and recovery choices. No multi-user CRDT in the first release.

## 7. Custom widget development

The user has three options, all discoverable from chat:

1. Compose existing components and action descriptors; no code build needed.
2. Ask the agent to create a UI package from the SDK template in an isolated build workspace; preview, test, approve capabilities, install into user scope.
3. Install an existing vendor package or MCP App; exact source/version and permissions like any other extension.

The agent is not allowed to hot-evaluate generated JSX in the app renderer. Writing your own widget is not forbidden; it goes through the same build/install boundary as a third party. A full-power developer mode is not needed just to have a note widget without network.

### SDK functions

```text
props.read / props.subscribe
state.get / state.update(expectedRevision)
events.emit(typedEvent)
actions.invoke(boundActionId, validatedInput)  # resolves with a service's output
actions.availability / actions.subscribe(handler)  # which service-backed actions can run, and why not
capabilities.request(requestedCapability)  # opens host consent, not grants itself
host.focus / host.resize(request) / host.requestPin
host.openExternal(approvedUrl)
semantic.publish(summary, selectedIds, values?)  # a proposal; actions come from the instance's bindings
lifecycle.onMount / onSuspend / onResume / onDispose
```

`requestPin` is a proposal unless it originated directly from a clear user gesture. The SDK has no `readAllSecrets`, `shell`, `queryCoreDb`, `disableCSP`, `approve`, `installAnything` or `registerSidebar`.

### Trust tiers

| Type | Execution | Default permissions |
|---|---|---|
| Built-in catalog | Trusted client code | Render props; actions via host |
| Declarative composition | No executable payload | Existing components + bound actions |
| User/third-party UI | Isolated origin/iframe | No Node/fs/host cookies; explicit network/media/actions |
| Tool/API/MCP service | Separate executor/service | Granted resources; OS isolation when code is untrusted |
| Native Pi extension | Full Pi process code | Trusted mode or sandbox entire worker; never privileged core by default |

## 8. Mini-app isolation

MCP Apps provides host/UI communication primitives, but the app still has to implement sandbox/CSP/origin checks and consent correctly [R06–R08]. Using the SDK does not by itself make all code safe.

A default custom iframe gets `allow-scripts`, with no top navigation/download/popups/camera/mic/geolocation. Opaque-origin messaging needs exact source-window + negotiated MessagePort/nonce validation, not just `origin == null`. When the SDK needs storage/origin, it can run on a separate per-app origin with an approved sandbox policy; **never the same origin as the main chat**.

The CSP defines connect/resource/frame domains according to the consented package manifest. Network egress from the renderer and from the backend are different, and both need budget/policy. No remote script updates bypass the pinned bundle; a vendor SDK remote URL is allowed only for an approved version/origin under the declared policy and platform constraints.

Host-owned frame chrome shows app/source/account, permission controls and close/stop outside the iframe's control. Embedded UI can draw a fake approval, but it cannot mint a record; the user must be able to tell host consent apart by consistent chrome/placement.

Unsafe HTML/SVG/Markdown is sanitized; Mermaid gets a strict wrapper and a worker timeout; no script callbacks from agent props. Datasets/attachments go through opaque refs, with no arbitrary paths, executable URLs, SQL or CSS property injection.

## 9. Frontend credentials: an exception that must be designed correctly

"Do not send secrets to the renderer" needs to distinguish credential types. API secrets, refresh tokens and node private keys do not go into the renderer/model. Some playback/call SDKs need a **short-lived scoped access/session token in the browser**. In that case, the auth broker issues a suitable token only to the consented isolated widget origin/session, with a short TTL if the provider supports it, and never puts it into props, persisted state, logs or conductor context.

Do not assume every token can be scoped/expired as the app wishes: the adapter records exactly what the provider supports. If a token is too broad and the SDK requires the browser, state the risk/design a fallback. Uninstall/revoke stops refresh and revokes when the API supports it; do not promise that every access token has been revoked immediately when the vendor has no mechanism for it.

## 10. Third-party use cases — capabilities and limits

| Example | Reasonable widget/adapter | Must not be promised by default |
|---|---|---|
| Spotify | Player/playlist via approved SDK or device-control API | Embedded playback needs a suitable account/SDK/DRM/policy; Premium and commercial streaming restrictions must be checked [R23] |
| Telegram | Conversation view + composer; Bot API connector or a separate user-client adapter | A bot token does not open the whole personal inbox; user client auth/API ID is a different flow [R24] |
| Zoom | Meeting SDK call surface, explicit mic/camera, join/leave | Mobile support depends on the view; the human Meeting SDK does not become an AI meeting bot/recorder by itself [R25] |
| Notion | Note/block editor on the API and authorized pages | Not the whole Notion webapp embedded; capabilities/page access/sync conflict are the gate [R22] |
| Google Calendar | Agenda/week + event editor via reference connector | Rendering a calendar does not prove the OAuth scopes are sufficient to edit it [R20–R21] |

The release proves a custom editor and one conformance media fixture; it does not claim certification by every vendor. The fixture sample is clearly labeled; genuine vendor playback/call must be tested on exact Electron/browser/platform versions.

## 11. Multi-facet extension packages

```json
{
  "schemaVersion": 2,
  "id": "example.calendar-pack",
  "version": "0.2.0",
  "displayName": "Calendar pack",
  "description": "A week view with a calendar connector behind it.",
  "hostApi": { "min": 1, "max": 1 },
  "facets": [
    {
      "kind": "tools",
      "id": "example.calendar-pack.connector",
      "entry": "dist/connector.mjs",
      "isolation": "service",
      "protocol": "mcp-stdio",
      "capabilities": [
        {
          "tool": "list_events",
          "ref": "example.calendar-pack.events.list@1",
          "summary": "List events in a date range",
          "effectCategory": "read"
        }
      ]
    },
    {
      "kind": "ui",
      "id": "example.calendar-pack.week@1",
      "entry": "dist/widget/index.html",
      "definition": "dist/widget/widget.json",
      "isolation": "isolated-ui"
    },
    { "kind": "skills", "id": "example.calendar-pack.skills", "entry": "skills/", "isolation": "declarative" },
    { "kind": "setup", "id": "example.calendar-pack.setup", "entry": "setup/calendar.json", "isolation": "declarative" }
  ],
  "requestedCapabilities": ["widget.state.write@1"],
  "permissions": { "networkOrigins": [], "filesystem": [], "microphone": false, "camera": false, "lifecycleScripts": [] },
  "platforms": ["linux-x64", "linux-arm64", "darwin-arm64"]
}
```
The shape is `packageManifestSchema` (`packages/contracts/src/install.ts`); [widget development §4](widget-development.md#4-package-manifest) lists the lane each facet kind runs in and the rules the reader enforces. A service facet's capabilities are declared in the manifest, so consent can show them before any code runs. Installing the package is the consent to them, and each call is still decided by the execution policy. The node runs the service facet of each active generation in a Docker or Podman container, registers the declared capabilities with the readiness it observes, and reaches them through one host path shared by widgets, the agent and voice. A node without an engine does not run the service. There is no process-only fallback. [Widget development §4](widget-development.md#4-package-manifest) owns the boundary and what is not built yet.

The manifest is the package's proposal metadata; it does not by itself grant the host capabilities it requests. The install record adds resolved versions/digests, transitive dependencies, target node, auth/data recipients and approved grants. Fields have a strict schema, and no arbitrary lifecycle script auto-runs.

Pi-compatible facets can package extensions/skills/prompts/themes according to the upstream manifest, but the app's own lifecycle must not be called an official Pi API [R02–R04]. Independent facets let a UI update happen without restarting Pi; a skill update can reload resources; a connector tool service can restart on its own. Chord is a P0 candidate for the composition implementation, not a security/federation shortcut [R05].

## 12. Resource limits and accessibility

Initial targets (must be measured): ordinary catalog spec ≤256 KiB; lazy mount heavy widgets; per-app CPU/memory/frame budgets; bounded logs/network/API rate; large datasets get labeled pagination/downsampling. Do not auto-limit rich widgets into uselessness, but one chart must not freeze the composer.

Offscreen widgets suspend rendering/subscriptions depending on type; an active user-authorized player/call is an exception with a clear indicator. A stalled widget has a timeout/error boundary/text fallback and does not crash the chat. Text alternatives, keyboard controls, reduced motion, contrast, focus restore and no focus-stealing are release gates.

State is clearly split into client view, durable instance state and external service truth. An optimistic value is only pending; do not show "message sent" before provider ack/verification.

## 13. Conformance tests

Catalog/iframe must both pass: malformed props reject; unknown action reject; forged grants fail; stale account/version binding fail; voice/click same outcome; double click dedup; reopen no effect; pin no duplicate media; unpin preserve note; reinstall preserves compatible state; auth revoked disables protected actions; custom widget cannot read host storage/secret; microphone off actually ends capture.

The MCP App test uses a reference fixture and the exact negotiated spec. Features the SDK does not support, or that browser permissions do not allow, fall back visibly; do not silently pretend that mounted means functional.

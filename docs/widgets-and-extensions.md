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

- Catalog + family definitions in `packs/data-canvas`: `canvas.line/bar/donut/table`, `canvas.metrics`, `canvas.filter`, `canvas.calendar`, `canvas.image`, `canvas.cta`, and the container `canvas.overview@1`.
- Leaf renderers in `packages/conversation-client` (a real donut, month grid, KPI tile, image, CTA) together with a text alternative for every region.
- The sketch's **image** region now actually reaches the user: `publishMiniAppData` returns the most recently imported image, the `overview` template has an `image` slot (fixed, optional depending on the data), and the region's text alternative carries the **alt text the user entered**. Images go through a `blob:` URL because the token cannot sit in `<img src>`, so the CSP in `apps/web/index.html` must allow `img-src ... blob:` — without it, every imported image renders as "Could not load the image" even though the node returns the correct bytes.
- **Declarative composition** (the second trust tier in the table above) is the tier currently used for mini-apps: the spec is versioned, each section pins `definitionRef.digest`, there is no executable payload, and an action is only a reference to a server-compiled binding.
- A snapshot is an **immutable bundle** in its own table (`presentation_bundles`), not a `catalog:id` pointing at current data; deleting the data source → tombstone, it is not re-read live.
- Pin = the same logical instance, one live owner with a lease (`widget_live_owners.lease_expires_at`), the remaining locations are read-only.
- **Read-only blocks actions only, not view state**: a historical snapshot and a surface owned by another tab can still change the selected date / viewed period (that is presentation), but they have no `onAction`, so there is no path to the server; the CTA button shows a disabled state with a reason instead of pretending to be clickable.
- A snapshot points at the message that contains it: `messageId` is issued **once** and then used for both the composer call and the recorded message, so there are no orphaned snapshots (the test `apps/web/e2e/mini-app.spec.ts` covers this history path).
- M1 actions consist only of `period.change`, `date.select`, `view.save` (`view` kind). `invoke`/`agent`/`workflow` are rejected in `invokeMiniAppAction` and must go through the approval path.
- The deterministic composer `CC_MODEL_FIXTURE=1` exists only so the browser suite can run the composed-surface path without calling a provider; the node prints a warning at startup and the answer states that it is a fixture.

- **File attachments reach the agent**: the composer uploads, the bytes live in the shared blob store (`dataDir/blobs`, content-addressed, `mode: 0o600`), the quota is counted per principal, and the file type is decided by **magic bytes**, not by the file extension. The prompt carries only an opaque `att_…` and **never** a path; the agent reads the content through the host tool `read_attachment(attachmentId)`, which takes no path parameter, so there is no way to open another file. The stored message is the single source — the timeline and the prompt are two readings of the same row (`apps/web/e2e/attachments.spec.ts`; the prompt part is proven at the adapter boundary with `FakePiAdapter.promptsFor()`).
- **Memory** (`memory_records`, migration 18) is **not** a second search index. Deleting a memory deletes the **injection path** into the next turn — the brief is re-read every turn rather than cached in the process — while the user's original message stays in the conversation history and remains visible. So this is not hidden memory: everything remembered can be read and deleted in the Memory tab (`apps/web/e2e/memory.spec.ts`).
- The **desktop window** reaches the real client: `electron . --renderer-url <url> --data-dir <dir>`, a CSP derived from the origin, and a named bridge `getSession()` that returns `{ baseUrl, token }` read from `identity.json`. The token does **not** go into argv or the URL, where it would sit in the process list and in the browser history.
- `?cc-compact=1` is a **test-only path** so the browser suite can reach the minimal voice bar; it is not a feature. The real path into that state is the minimized window.
- **Widget Library and Widget Lab**: the built-in widget catalog can now be browsed from Settings → Extensions (library) and Settings → Developer (Lab). The preview calls the same `resolveRenderer` the conversation uses, so it is the running renderer rather than a screenshot, and a definition without a renderer shows a reason instead of staying silent. The surface sits **beside** the conversation: opening it does not unmount the composer. Installed packages are listed as **provenance** on a separate list (version, source tier, digest, trust lane) rather than as cards in the catalog, because no route exposes a package's widget definitions. Details in [widget-development.md](./widget-development.md) §23.

**Not present (deferred, must not be claimed as done):**

- `isolated-app` and `mcp-app`: the sandbox policy/registry has code and tests, but **the renderer runtime for isolated apps is not proven**. There is no app runtime in the repo.
- The Google Calendar connector, custom iframe mini-apps and "agent does X" style CTAs are all outside M1.
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
actions.invoke(boundActionId, validatedInput)
capabilities.request(requestedCapability)  # opens host consent, not grants itself
host.focus / host.resize(request) / host.requestPin
host.openExternal(approvedUrl)
semantic.publish(summary, selectedIds, availableActions)
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
  "id": "example.calendar-pack",
  "version": "0.2.0",
  "hostApi": ">=1 <2",
  "facets": {
    "tools": { "entry": "dist/connector.js", "isolation": "service" },
    "ui": [{ "id": "example.calendar.week", "entry": "dist/widget/index.html" }],
    "skills": ["skills/calendar.md"],
    "setup": "setup/calendar.json"
  },
  "requestedCapabilities": ["connection.calendar.read", "widget.state.write"],
  "platforms": ["linux-x64", "linux-arm64", "darwin-arm64"]
}
```

The manifest is the package's proposal metadata; it does not grant the capabilities it declares. The install record adds resolved versions/digests, transitive dependencies, target node, auth/data recipients and approved grants. Fields have a strict schema, and no arbitrary lifecycle script auto-runs.

Pi-compatible facets can package extensions/skills/prompts/themes according to the upstream manifest, but the app's own lifecycle must not be called an official Pi API [R02–R04]. Independent facets let a UI update happen without restarting Pi; a skill update can reload resources; a connector tool service can restart on its own. Chord is a P0 candidate for the composition implementation, not a security/federation shortcut [R05].

## 12. Resource limits and accessibility

Initial targets (must be measured): ordinary catalog spec ≤256 KiB; lazy mount heavy widgets; per-app CPU/memory/frame budgets; bounded logs/network/API rate; large datasets get labeled pagination/downsampling. Do not auto-limit rich widgets into uselessness, but one chart must not freeze the composer.

Offscreen widgets suspend rendering/subscriptions depending on type; an active user-authorized player/call is an exception with a clear indicator. A stalled widget has a timeout/error boundary/text fallback and does not crash the chat. Text alternatives, keyboard controls, reduced motion, contrast, focus restore and no focus-stealing are release gates.

State is clearly split into client view, durable instance state and external service truth. An optimistic value is only pending; do not show "message sent" before provider ack/verification.

## 13. Conformance tests

Catalog/iframe must both pass: malformed props reject; unknown action reject; forged grants fail; stale account/version binding fail; voice/click same outcome; double click dedup; reopen no effect; pin no duplicate media; unpin preserve note; reinstall preserves compatible state; auth revoked disables protected actions; custom widget cannot read host storage/secret; microphone off actually ends capture.

The MCP App test uses a reference fixture and the exact negotiated spec. Features the SDK does not support, or that browser permissions do not allow, fall back visibly; do not silently pretend that mounted means functional.

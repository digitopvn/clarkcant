# ClarkCant Design System & UX Operating Model

> English (default) · [Tiếng Việt](DESIGN.vi.md)

> Status: canonical design direction for UI/UX.
> Updated: 2026-09-19.
> Scope: web, desktop, conversation client, voice, host-owned cards, built-in widgets, custom widgets and marketplace.

## 0. North Star

ClarkCant must feel **simpler than the system running underneath it**.

The user only needs to learn two things:

1. **One conversation frame** — where you hand off work, see results, operate widgets, change settings, manage integrations and control the app.
2. **One voice agent** — the same Clark, same context, same actions, not a separate product.

Pi sessions, Jev routing/decisions, memory, node topology, tool registry, capability host, workers, package generations and the policy engine are infrastructure. They must not turn into a navigation model the user has to learn.

The most important product rule:

> **Don't make me think. Don't make the user understand the architecture to get work done.**

If a task can be expressed in chat or voice, the user should not have to find the right tab, the right tool or the right node first.

---

## 1. Mandatory design principles

### 1.1 Conversation is the app

- Do not add a fixed sidebar just to hold navigation.
- Do not add a session picker to the main UI.
- Do not turn widgets into a parallel dashboard.
- Settings is a secondary surface, opened over the conversation and closed back to where it was.
- The marketplace may have a browser surface, but it must open from chat/settings and must not become a second home screen.
- Every important action must have an equivalent chat and voice path.

### 1.2 Progressive disclosure

The default UI only shows what's needed for the current step. Technical detail only appears when:

- the user asks;
- there is an error requiring action;
- the user opens Settings/Advanced;
- or a widget needs provenance/freshness so it doesn't mislead.

Do not put node IDs, digests, package generations, action bindings, token budgets or provider internals on the main surface if the user doesn't need them.

### 1.3 User-owned autonomy

The default execution policy is **Autonomous**.

Clark executes the task the user requested without asking back for every tool call or every side effect. The user is responsible for the policy they choose and can change mode at any time.

| Mode | Behavior |
| --- | --- |
| Autonomous | Default. No re-confirmation for a task the user already assigned. Jev + policy rules decide route/guardrail on their own. Shows activity, supports Stop/Undo where possible. |
| Guarded | Runs low-risk operations automatically; asks before irreversible, external-public, destructive or sensitive actions per policy. |
| Ask every time | Asks before every effectful action; local view actions do not ask. |

OS/provider boundaries that cannot be simulated as "already granted" — OAuth consent, macOS TCC, browser microphone/camera permissions, vendor confirmation and OS secure dialogs — must still go through platform-owned UI.

**Security must not be used as a reason to add a duplicate confirmation after the user has already expressed clear intent.** Use instead:

- policy mode;
- visible activity;
- provenance;
- bounded execution;
- Stop;
- Undo/rollback where possible;
- audit log;
- Jev configurable instructions.

### 1.4 Honest UI

- No button that looks usable but has no handler.
- No claiming "live" for a snapshot/cached/sample value.
- No claiming success if all we know is that the process stopped.
- No hiding a blocked reason inside a tooltip.
- No rendering approval/credential chrome from an untrusted widget.
- No faking a percentage progress if the backend has no such data.

### 1.5 Motion is feedback, not decoration

Every visible state change should transition smoothly, but the animation must explain cause and effect:

- press → immediate feedback;
- element created → appears from a sensible place;
- element removed → shrinks/fades away;
- panel opens → continuous with the control that opened it;
- agent state changes → ambient UI shifts slightly;
- voice listening/speaking → waveform/orb reflects real audio.

Don't run animation just to make the screen "feel alive."

### 1.6 Input modality aware

The UI responds differently depending on the interaction mode:

- **Pointer:** hover, proximity, subtle pointer-following glow.
- **Keyboard:** clear focus ring, shortcut hints, not dependent on hover.
- **Touch:** no hover-only affordance; large, clear press state.
- **Voice:** the focused element/widget has semantic context so Clark can act on it for the user.
- **Agent activity:** ambient state reflects thinking/tool/answering/error without overpowering content.

### 1.7 Orb is the signature

**The Orb is ClarkCant's mandatory visual identity and must not be removed from the product.**

The Orb must appear at the key identity points: onboarding, hero, header/avatar, voice mode and minimal/orb window mode. A redesign must not replace the Orb with a static logo, a spinner or another avatar as the default.

Users may personalize **how the Orb presents itself**, but not strip its semantic identity:

- palette / gradient / glow;
- exposure, chromatic fringe, sheen;
- idle animation speed;
- pointer response strength;
- spring preset or bounded stiffness/damping;
- agent-state reactions;
- reduced-effects preset.

Personalization must go through typed preferences and bounded ranges/presets. No arbitrary shader source, arbitrary GLSL, CSS injection or unbounded physics values from Settings/widget/theme packages.

Minimum built-in presets:

- Clark — default signature;
- Calm — less glow/chromatic fringe, higher damping;
- Jelly — softer spring with more pronounced but still bounded overshoot;
- Glass — more sheen/exposure, low motion;
- Custom — adjust advanced values within a safe range.

prefers-reduced-motion always wins over the animation preference: the Orb still appears but stays still, or only reacts to state without motion.

---

## 2. Application shape

### 2.1 Desktop window states

The desktop host needs to support four presentation modes, all controllable by click, keyboard, chat and voice:

1. normal — full conversation.
2. expanded — wider/taller conversation for content-heavy tasks.
3. compact — a small bar for composer/voice status/pinned widget controls.
4. orb — a minimal icon/orb always ready to summon Clark.

Example natural-language commands:

- "shrink the window"
- "make Clark bigger"
- "just show the icon"
- "reopen the window"
- "pin this calendar"
- "pop the chart out into its own window"

The desktop bridge should expose host-owned commands with a clear schema: window.setMode, window.resizePreset, window.restore, window.focus, widget.detach, widget.attach.

Widgets must not call generic Electron IPC themselves.

### 2.2 Pin vs detach

- **Pin:** keeps the widget inside the conversation space; it's a presentation preference.
- **Detach:** moves the same logical widget instance into a host-owned floating window.
- **Inline snapshot:** an immutable history.
- **One live owner:** inline/pin/detached must not create multiple effect owners for the same instance.
- Detach does not create a new session.
- Closing a detached window does not delete widget state.
- Voice can focus a pinned/detached widget by semantic ID and label.

**Shipped (phase 7 + 12).** The detached window receives **only** the widget host bootstrap and instance ref — no
token, no gateway URL, no conversation id — and that's achieved correctly by *constructing* the payload rather than
filtering it down: `detachedBootstrap` names every field it reads, so there's no path for a credential to tag along.
The consequence is that the window **cannot invoke an action itself**: intent goes through the host (`detached:intent`),
the host performs it with its own token and resolves the binding digest itself from the composition it handed out — so
the window can't hand back a digest that the node would accept for a different binding.

The lease **moves** rather than duplicates: the shell releases first, the host claims the `detached` surface, and when
the window closes the host releases and the shell claims it back — so there is never a moment with two owners. Closing
the window is itself the reattach path, even when the user just presses the OS close button.

### 2.3 Wake phrase

Target UX: local wake phrase **"Hey Clark"** opens voice mode.

Requirements:

- wake-word detection runs locally where the platform/provider allows;
- a clear indicator when the wake listener is on;
- toggle in Settings;
- the voice commands "turn off voice", "stop listening", "back to chat" must end the mode;
- local mute/end is a host action, not dependent on the model;
- do not send ambient audio to a remote provider just to detect the wake phrase;
- a wake listener does not mean active transcription.

---

## 3. Motion & micro-interaction system

### Shared motion helpers (shipped)

The four interface motions — `press`, `release`, `panel`, `popover` — live in
`packages/design-tokens/src/motion.ts` and are the **only** way to build motion. Three rules are encoded there
instead of being left to each component:

- animate only `transform` and `opacity` — the two properties that don't force the browser to relayout; there's no
  `font-size`, `color` or size in the set, so the helper can never be pointed at text;
- mild bounce is only used for `press`, `release`, `panel`. `popover` doesn't bounce, because overshoot makes content
  land somewhere other than where it settles;
- reduced motion pulls from the `reduced` token set, not a multiply-by-zero — multiplying by zero still leaves a
  transition that fires an event, and an infinite animation with duration 0 is a bug, not a reduced-motion
  implementation.

The existing tokens micro, normal, panel, orb, enter, exit, glow and bounce are a good foundation. Keep using tokens instead of hard-coding a duration.

### 3.1 Motion grammar

| Event | Motion |
| --- | --- |
| Hover | 120–180 ms, subtle border/background/opacity change |
| Press | scale 0.98–0.985 over 70–100 ms |
| Release | mild spring/bounce back to 1.0 |
| Chip/card enter | fade + translateY 4–8 px, 180–280 ms |
| Panel/modal | opacity + scale 0.985→1, 220–280 ms |
| Popover/menu | transform-origin from the trigger |
| Hero transition | existing staged exit; keep continuous orb motion |
| Widget pin | morph/fly from inline card to pin shelf |
| Widget detach | card lifts slightly then the host window appears with the same geometry |
| Success | one very small pulse, no confetti by default |
| Error | horizontal shake 2–4 px once; no loop |
| Agent thinking | ambient orb breathing, slow |
| Tool running | deterministic progress affordance; no spinner if a concrete state exists |
| Voice listening | orb/waveform follows RMS input |
| Voice speaking | orb/waveform follows playback level |

### 3.2 Bounce

Bounce must be subtle:

- only at the end-state of press/release, pin/drop, modal settle;
- small overshoot;
- never bounce body text;
- never bounce with reduced motion;
- never chain bounces on multiple elements at once.

### 3.3 Global transition rule

Do not use transition: all.

Each component should only transition the properties it intends: opacity, transform, background-color, border-color, box-shadow, filter.

Do not animate layout properties width/height/top/left every frame if transform/FLIP can be used instead.

### 3.4 Reduced motion

prefers-reduced-motion is a hard requirement:

- duration drops to 0 or near-0 per token;
- never keep an infinite spinner with duration 0;
- state feedback must still exist via icon/text/color/shape.

---

## 4. Ambient behavior by input and agent state

The root conversation surface should have a state machine expressed via data attributes instead of components guessing:

    data-input-modality = pointer | keyboard | touch | voice
    data-agent-state    = idle | listening | thinking | tooling | responding | success | error
    data-window-mode    = normal | expanded | compact | orb
    data-policy-mode    = autonomous | guarded | ask

On the Orb's own canvas, three more attributes publish the **resolved profile** rather than the raw preference:

    data-orb          = gl | fallback
    data-orb-profile  = clark | calm | jelly | glass | custom
    data-orb-motion   = full | reduced

`data-orb-motion` is the value **after** reduced-motion has already won, so a surface reads the resolved truth
instead of having to re-derive it from the preference and potentially get it wrong. The resolution (clamp, preset,
reduced-motion) lives in one pure function in `orb-profile.ts`; the renderer only receives an already-bounded value.

### 4.1 Pointer

- The Orb flares based on pointer proximity.
- Card hover lifts at most 1–2 px or changes border, no large shadows.
- Icon buttons only show a tooltip after a delay; important labels must be visible or have a clear accessible name.

### 4.2 Keyboard

- Keyboard navigation does not trigger hover-only decoration.
- Focus ring uses a dedicated token, not accent color as the only signal.
- Esc closes the nearest surface and restores focus.
- Cmd/Ctrl+K: focus composer / command intent.
- Cmd/Ctrl+.: cycle model in favorites.
- Cmd/Ctrl+Shift+V: toggle voice.
- Shortcuts must be configurable and must not capture while typing text if that would conflict.

### 4.3 Agent state

The app background only changes very subtly:

- idle: neutral;
- thinking: ambient gradient/orb movement increases slightly;
- tooling: a subtle directional trace/ring;
- responding: back to neutral once tokens start streaming;
- success: a soft settle;
- error: a very small danger accent near the status/orb, no full-screen flash.

Content always takes contrast priority over the ambient effect.

---

## 5. Onboarding redesign

Goal: the user is in the app and getting things done within seconds.

### 5.1 No long wizard

The new onboarding should have at most two moments.

**A. Welcome**
- ClarkCant + orb.
- One sentence: "Say what you want to do."
- CTA Get started.
- Small secondary text: "Clark executes what you ask by default. You can change this in Settings."

**B. First useful action**
- go straight into the conversation;
- if no model is configured yet, sample/local capabilities still work;
- when the user needs a real model, an inline setup card appears at the right time;
- when the user opens voice for the first time, inline/host voice setup appears at the right time;
- when a secret is needed, a host-owned credential prompt appears at the right time.

Do not ask about provider/model/TypeSafe key before the user knows why they need them.

### 5.2 Model setup

Provider + model is one control group:

- searchable combobox;
- recent/favorite models at the top;
- current model has a checkmark;
- context window/cost/speed only shown as secondary;
- saved immediately after selection, no Save button needed if the mutation is reversible;
- toast/status "Switched to …";
- the conversation command "switch to Claude/Gemini/…" does the same action.

### 5.3 Policy setup

Do not block onboarding with a permission questionnaire.

Default Autonomous, with a one-line disclosure linking to Change mode.

If a distributed build needs explicit legal acknowledgement, ask once with short copy, not per tool.

### 5.4 Resume

Onboarding/setup checkpoints must be resumable. Closing the app mid-OAuth/key setup must not send the user back to the start.

---

## 6. Main conversation UX

### 6.1 Header

The default header should only have:

- Clark mark/name — click returns to a fresh session;
- current model pill, small — click opens the quick model switcher;
- connection/activity indicator, only prominent when needed;
- settings icon;
- window-mode control, desktop only, when discoverability requires it.

Do not show tool count, node ID or Pi internals persistently.

The background task count only appears when >0. When work is waiting because a concurrency limit was hit, the mark states the number waiting ("2 waiting") instead of pretending everything is running.

Same for the inbox mark: it only appears when there's something waiting on the user or an unread notification, and it says so in words ("2 waiting on you · 1 new notification"), not with a colored dot. See §6.7.

### 6.2 Hero

Keep orb + prompt, but the suggestion chips should be **dynamic recent intents** rather than four permanently fixed sentences:

- recent work;
- contextual project suggestions;
- sample actions when there's no history yet.

Each chip must indicate if it's a demo/sample.

The hero disappears once the user starts working, but the logo/home lets them return to it.

### 6.3 Composer

The composer is the most important control.

Required:

- multiline auto-grow;
- attachment button;
- paste/drag-drop;
- mic/voice button;
- send/stop in the same location;
- file chip states;
- status/error near the relevant field;
- typewriter placeholder only when empty/idle;
- slash-command autocomplete is an optional enhancement, not the primary navigation.

While a turn is running:

- the send button morphs into Stop;
- the user is still allowed to type the next turn;
- if sent mid-task, Jev decides steer/interrupt/background per instruction;
- the UI briefly states the decision outcome when it has significant impact.

### 6.4 Selection actions

The text selection toolbar should have:

- Ask about this
- Explain
- Continue from here
- Run in background

The toolbar appears next to the selection, is keyboard accessible, and disappears when the selection is lost.

### 6.5 Streaming

Preserve chronology:

    text → reasoning → tool → text

Tool activity is compact by default. Expand when the user wants to see arguments/result.

The thinking state ends as soon as the first content/tool event appears.

### 6.6 Undo

A reversible action should create an ephemeral Undo affordance in the timeline/status:

- unpin/pin;
- theme/model switch;
- local note edit;
- file move when the underlying capability supports rollback.

Do not promise Undo for irreversible external actions.

### 6.7 Inbox

The inbox answers two questions: *what's waiting for my decision* and *how did work running while I wasn't looking
turn out*. It is not a second navigation surface. Every item points to its own conversation, and a decision made in
the inbox or on the card is one and the same.

Shipped:

- **A mark on the header** (§6.1), absent when empty. When something is waiting, the mark carries a warning edge;
  when there's only a new notification, it doesn't. Polled like the background-task mark, and re-read right after a
  decision or when the transcript changes.
- **Opened by click, keyboard, typed command or voice** ("open the inbox", "show notifications", "open my inbox") via
  the same `inbox.open` intent. When the mark is absent (nothing new), the command still opens the inbox to review
  already-read notifications.
- **Host-owned modal** (§12: it's a decision surface, no nested modals; opening Settings closes the inbox). Escape
  closes it and returns focus. Clearly states when the node read the inbox; never implies it's live.
- **"Waiting on you" first, "Notifications" second.** Waiting items include commands needing approval (showing the
  exact command line that will run, remaining time), permission requests from extension packages, an approval a running task
  is requesting (no card — the worker can't write a card, but it can still be Approved/Denied through its own route),
  and a question Clark is asking. Approving a running task's approval re-runs that task with the newly granted
  permission, without asking a second time; denying, or letting it expire, stops the work outright and the conversation
  reports it as such — no item is left hanging "waiting" forever. Waiting items are described in readable sentences, no
  internal codes. Approve/Deny in the inbox goes through the card's own route (or a dedicated route when there's no
  card); a question only offers "Open conversation", because the answer belongs to the conversation that asked it.
- **Waiting items are always derived at read time**, from cards and the approval record, so the inbox can never say an
  item is still waiting after it's already been decided on the card, or after it expired.
- **Clark can answer "is there anything waiting for me?"** via the read-only tool `read_inbox`, using the same data as
  the panel; the tool doesn't mark anything read and can't approve anything, and it can open the inbox for the user via
  `inbox.open`.
- **Notifications** have a source (background task, worker, extension package, Pi, another device, ClarkCant), a
  severity, a relative age, and an "unread" label in words next to the dot. Opening the inbox marks read exactly the
  notifications it displayed. "Dismiss" removes it from the list; "Open conversation" switches to the related
  conversation without opening an extra session.
- **Update notifications for the Pi SDK, installed packages and widgets** (`apps/runtime/src/update-checks.ts`), from a
  periodic job comparing the installed version against the directory index and the npm registry (a network error does
  not create an error notification). Content states current version → new version and risk lane, using the same
  naming as the marketplace. There's no "Update" button yet: the real update route through the install/rollback
  lifecycle isn't wired to this notification yet, so the inbox only says a new version exists but can't be clicked.
- **Out-of-app notifications when the window is unfocused or in minimized/orb mode** (#171): on desktop this is an OS
  notification via Electron `Notification`, host-owned, with only redacted title/body — never a command line or a
  secret; clicking restores the window from orb/compact to normal size, focuses it and opens the inbox via the same
  `inbox.open` intent. On the browser it's the Web Notification API, only enabled after the user presses the button in
  Settings → Control and the browser grants its own permission; the toggle reflects the browser's actual permission,
  states clearly when it's been denied or dismissed, and is hidden on desktop. On desktop, when the OS refuses or
  fails the latest notification, an inline status beside the OS toggle says why and that the item is still in the
  inbox, until a notification is shown again. Per-group options (approvals waiting,
  background results, updates) plus quiet hours, saved immediately without a Save button; no toggle appears before its
  saved value has finished loading. The "other devices" group appears but is disabled with the reason "no device paired
  yet" until a node pairing exists. A waiting item about to expire (≤ 1 minute left) is nudged exactly once, with a
  title clearly stating under 1 minute remains.
- **An approval or question that expires unanswered is reported, not silently dropped from the list.** A periodic scan
  on the node writes exactly one notification per expired item, pointing back to its own conversation; a package
  permission approval (which belongs to no conversation) has nothing to point back to, so it isn't reported through
  this path.

Not shipped (target):

- notifications and waiting items from another ClarkCant node (already has `originNodeId` and a dedup key so repeated
  receipt is safe);
- notification when an effect is recorded in an "unknown" state needing reconciliation: there's no production path
  that creates this data yet (effect ledger, §9 system-architecture.md, no place writes real rows yet);
- notification when an OAuth connection expires or is revoked: the `connections` table has no place writing real rows
  in production yet.

Not allowed: using the inbox as a default dashboard, a persistent "0" count, or showing a decision button whose real
route doesn't exist yet.

---

## 7. Voice agent UX

Voice is the same Clark, not a Settings tab or a sub-app.

### 7.1 Entry

- mic button in the composer;
- Hey Clark;
- configurable shortcut;
- chat command "turn on voice".

### 7.2 Surface

The voice surface has 3 levels:

1. **Expanded:** orb, live state, transcript, waveform, controls.
2. **Compact voice bar:** status + mute + end + expand.
3. **Orb mode:** just a visual listening/speaking indicator; transcript opens when the user asks.

### 7.3 App-control voice commands

Voice must have semantic commands for:

- open/close Settings;
- switch model/provider;
- change policy mode;
- resize/minimize/restore the window;
- pin/unpin/detach/focus a widget;
- scroll/focus the conversation;
- mute/end voice;
- open the marketplace and install a widget;
- ask the user a question / answer an open panel.

Do not implement this with raw voice strings in the frontend. Voice transcript goes through the same intent/action layer as text.

### 7.4 Voice + widgets

The focused widget publishes a semantic summary:

- title;
- selected item;
- available local actions;
- available effect actions.

Clark can say "select tomorrow on the calendar" and call a local view action, or "create an event tomorrow" and call a server effect action.

---

## 8. Widget UI architecture

### 8.1 Four trust lanes

1. **Host-owned UI**  
   Approval/policy/credential/device/OS/trust indicators. Third parties cannot impersonate this.

2. **Built-in catalog**  
   Trusted React components, JSON props + datasets.

3. **Declarative compositions**  
   No executable payload. Compose built-ins + bound actions.

4. **Custom isolated widgets / MCP Apps**  
   Iframe/origin sandbox, typed bridge, CSP, bounded capabilities.

All lanes share the same instance/state/action model at the host.

### 8.2 Widget chrome

Widget chrome stays minimal:

- title;
- freshness/provenance when needed;
- overflow menu;
- pin/detach action when valid;
- loading/error/missing states;
- optional compact action row.

Don't repeat the title if the widget is already inside a card that has one.

### 8.3 Interaction states

Every widget must define:

- loading;
- empty;
- partial;
- live;
- cached;
- offline;
- error;
- read-only snapshot;
- disabled action reason.

### 8.4 Local vs effect actions

Local view actions don't need to ask:

- filter;
- sort;
- zoom;
- select;
- playhead;
- tab;
- expand/collapse.

Effect actions go through the host:

- invoke tool;
- agent intent;
- workflow;
- external mutation.

The UI must look different enough for the user to tell "viewing" apart from "doing."

---

## 9. Default widget catalog: audit and proposal

The repo currently has: overview/layout, metrics, filter, line/bar/donut, table, calendar, image, carousel, gallery, YouTube/video, CTA and a note fixture.

This is a good foundation but not enough for "do everything inside the conversation."

### 9.1 P0 — must add

#### ui.question@1

Q&A / ask-user panel:

- single choice;
- multi choice;
- text;
- number;
- date/time;
- confirm;
- optional freeform other;
- keyboard first;
- the voice agent reads the question aloud and submits the answer through the same action schema;
- support multiple questions in one panel when sensible, but don't turn it into a long form.

#### ui.form@1

Schema-driven form:

- text/password/number/select/search-select/date/time/toggle;
- inline field validation;
- draft preservation;
- clear submit effect;
- secret fields route through the host credential flow when marked sensitive.

#### ui.task@1

One card unifying progress + steps + current operation + Stop.

Don't duplicate task progress/summary into multiple separate components if one component can morph across the lifecycle.

#### ui.artifact@1

Preview/download/open for:

- text;
- image;
- PDF;
- code;
- generated file.

Includes provenance + version.

#### ui.diff@1

Upgraded code diff:

- collapse unchanged;
- file navigator;
- copy hunk;
- optional apply/revert where a capability exists;
- keyboard navigation.

#### ui.browser@1 / ui.computer@1

Host-mediated screenshot/live preview:

- focus target;
- take over;
- stop;
- status;
- current action cue.

Do not embed a privileged browser origin.

### 9.2 P1 — high value

- ui.timeline@1
- ui.kanban@1
- ui.map@1
- ui.diagram@1
- ui.keyvalue@1
- ui.log@1
- ui.search-results@1
- ui.model-picker@1
- ui.package@1
- ui.marketplace-results@1
- ui.connection@1
- ui.audio@1
- ui.player@1
- ui.call@1

#### Terminal (host-owned, shipped)

The `terminal-session-card` is a real shell (PTY) inside the conversation, belonging to lane 1 because a shell has
the user's full authority: it's never an isolated widget, never in the marketplace, and only the host creates it.

- **Open:** through the conversation ("open a terminal in folder X") or voice; there's no permanent "new terminal"
  button.
- **The agent running a command** goes through the same preflight + execution policy + guardrail as `run_command`.
  When policy says *ask*, the command is **prefilled but not run**: the user pressing Enter on the exact line they
  see is itself the confirmation. The user typing it themselves is their own action, not subject to policy.
- **The agent does not type over the user:** when the user has already typed something on the command line, the
  agent neither prefills nor runs, and states why; a line the agent had prefilled earlier is replaced, not appended
  to. A command with control characters (tab, escape…) is rejected, because the line that actually runs would differ
  from the line that was reviewed. The command is evaluated against the directory the shell is currently in (as
  reported by the prompt), not the directory at open time; a shell without OSC 133 integration means the agent only
  ever prefills. Output sent to the model has credential-like strings redacted, and the agent only sees the terminal
  belonging to its own conversation.
- **One driver:** a terminal has at most one driver at a time; other cards are in observer mode with a "Drive here"
  button that transfers the lease (never duplicates it).
- **Keyboard:** every key, including Escape, belongs to the shell so TUIs (vim, htop, pi…) work; **F6** moves focus
  out of the terminal to the send button. The F6 hint is always shown at the bottom of the screen.
- **Send to main session:** one button, its label stating exactly what will be sent — the selection, else the last
  finished command's result (with exit code), else the screen. A still-running command is never sent as a result.
  Content goes in as a user message, output is fenced.
- **Progress panel:** a "Progress" panel lists other terminals (view-only), `run_command` invocations and background
  work (status only, since there's no stream behind it), and Pi sessions on the machine (followed live, read-only,
  redacted, updated per entry Pi writes). Escape closes the panel and returns focus to the button that opened it.
- **Stopping individual items:** a running command and a running or waiting background task each have their own
  "Stop" button, going through the same stop path as Clark's `stop_work` tool, so "stop reading that report" by
  voice and by button is one action. The button switches to "Stopping…" and locks while waiting; a failure is stated
  right next to that item. A background task's status is one of waiting / running / done / failed / stopped /
  interrupted — "stopped" and "interrupted" (node restarted) are two different events and are not merged into one.
- **Honest state:** connecting, disconnected (with a reconnect button), the terminal has ended (states the exit
  code, drops the close button), the terminal no longer exists on the node, the node has no PTY. A card in history
  with no live connection is a snapshot and states so.
- **A deliberate exception to "inline history is a snapshot":** a terminal card in history still connects live to
  the terminal while that terminal is still running on the node, because a terminal is a living process, not the
  result of one turn. The driver lease is still a single one, so this doesn't create a second effect owner; once the
  terminal no longer exists, the card states that clearly instead of showing the old screen as if it were live.
- Emergency stop and the close button send a hangup to the shell (the shell forwards it to its own jobs), then kill
  the whole terminal session, including background jobs the user left running.

### 9.3 Improve existing widgets

**Charts**
- hover/focus datum;
- legend toggles;
- selected point state;
- accessible summary;
- responsive labels;
- avoid SVG text collision.

**Table**
- sticky header;
- sort/filter;
- column visibility;
- horizontal scroll affordance;
- row selection;
- virtualization when large.

**Calendar**
- month/week/agenda;
- keyboard date navigation;
- event pills;
- timezone visible when different from local;
- selected date persists as local view state.

**Media**
- unified media controls;
- one active playback owner;
- poster/error/offline states;
- keyboard media shortcuts when the widget is focused.

**CTA**
- use correct button hierarchy;
- pending state;
- success/error;
- action label describes the operation, not a generic Continue.

**Note/editor**
- autosave status;
- conflict state;
- checklist;
- just enough markdown/rich text;
- don't try to clone Notion.

---

## 10. Widget Marketplace

### 10.1 Lessons from Pi

Pi keeps a small core and extends via packages with multiple resource facets: extension, skill, prompt, theme. Packages can come from npm, git or a local path; a catalog can index packages while the install mechanism stays simple and portable.

References:

- https://pi.dev/docs/latest/extensions
- https://pi.dev/docs/latest/packages
- https://pi.dev/packages

ClarkCant should learn from that **package ergonomics**, but not copy native Pi extension's trust model. A Pi extension has full process permissions; an executable ClarkCant widget must default to isolated.

### 10.2 The marketplace doesn't need a huge backend at V1

V1 can use:

- an npm package or git repo as distribution;
- a standard clarkcant manifest;
- a catalog index reading metadata;
- screenshots/video preview;
- version/digest;
- compatibility;
- facets;
- capability declarations;
- source/repository/license;
- install count/rating can be deferred.

No payment/review social network needed yet.

### 10.3 Package facets

A package can contain:

    {
      "clarkcant": {
        "widgets": ["dist/widgets/weather"],
        "compositions": ["compositions/dashboard.json"],
        "skills": ["skills/weather.md"],
        "tools": ["dist/service/index.js"],
        "themes": ["themes/cloud.json"],
        "recipes": ["recipes/setup.json"]
      }
    }

Facet activation is independent. A UI-only update doesn't restart Pi.

### 10.4 Marketplace UX

The user can say:

- "find a price-tracking widget"
- "install a nicer calendar widget"
- "is there a widget for Home Assistant?"

Clark returns ui.marketplace-results@1.

Each item:

- preview;
- name + one-line value proposition;
- author/source;
- facet chips;
- compatibility;
- capability/risk chips;
- install/update button;
- View source;
- Try if the package supports an ephemeral preview.

In Autonomous mode, explicit user intent "install X" is enough to install. No second confirmation. Jev/policy can still block per a user-configured rule or a hard platform boundary.

### 10.5 Risk levels

The marketplace shows risk without turning every install into a modal:

- **UI-only:** isolated, no network → low.
- **UI + declared network:** isolated, scoped origins → medium.
- **Tool/service:** separate executor, filesystem/network capabilities → elevated.
- **Native Pi extension:** trusted code with process-level access → high/trusted mode.

Autonomous mode can execute per user policy; visual activity/audit is mandatory.

### 10.6 Developer experience

Target CLI:

    clark widget init
    clark widget dev
    clark widget test
    clark widget pack
    clark widget publish

Template includes:

- manifest;
- schema;
- preview fixture;
- accessibility tests;
- bridge harness;
- example data;
- icon/preview image.

clark widget dev runs an isolated preview host with hot reload.

Publish gate:

- schema validation;
- package size;
- CSP;
- forbidden bridge calls;
- keyboard accessibility;
- reduced motion;
- text fallback;
- action dedup;
- state migration;
- snapshot/reopen behavior.

### 10.7 Personalization

Widget instances have:

- size preference;
- compact/expanded;
- pin position;
- limited theme token overrides;
- saved filters/view state;
- default actions;
- voice aliases.

A package must not change the global app theme or global shortcuts on its own without a clear user preference.

---

## 11. Settings redesign

Settings remains a modal/surface over the conversation. It doesn't turn into an admin console.

Six groups, named for what the user wants to do, not for the parts of the system:

1. Experience
2. AI & Routing
3. Control
4. Extensions & Widgets
5. Devices & Voice
6. Developer / Advanced

Credentials **don't** get their own tab: each key lives in the domain that explains it (Gemini in Devices & Voice,
TypeSafe in AI & Routing), per section 11.6.

A control only appears once the behavior behind it exists. A preference already declared in the registry that
nothing reads yet (density, background routing, voice picker) gets **no** control, and the reason is stated where the
user would look for it — silently skipping it is worse, because the user would think the app is broken.

### 11.1 Experience

Use segmented controls, toggles and swatches:

- Appearance: System / Light / Dark.
- Language: Tiếng Việt / English — segmented control, applies immediately (no save button), sets
  `<html lang>`, and persists across reload and devices through the preference registry
  (`experience.language`). Default is Vietnamese; there is no "follow system" option, because no
  cross-platform signal for "UI language" is reliable enough not to silently switch a Vietnamese
  speaker's product language away from Vietnamese. Only default chrome (composer, timeline chrome,
  settings, error copy, voice controls, marketplace headings) is translated; agent output is never
  translated.
- Accent.
- Motion: Full / Reduced / Follow system.
- Density: Comfortable / Compact.
- Window behavior: remember size, start mode.
- Wake phrase: on/off + local-listening status.
- Keyboard shortcuts: opens a subpanel.

Don't show contrast debugging to consumers; put it in the Developer section.

### 11.2 AI & Routing

- Current model as a searchable picker.
- Favorites/recent models.
- Shortcut order for model cycling.
- Automatic routing by Jev toggle.
- Main session model preference.
- Background-session routing preference: Auto / Same model / Cheap / Fast / Quality.
- Jev model/adapter settings in Advanced.
- Context/memory strategy uses user-friendly terms only.
- **Personal instructions:** a textarea/editor for the user's system instructions, appended to the product/system prompt by default; has Enable, Reset, character/token estimate and a preview of the injected section.
- Personal instructions are a ClarkCant preference, not a direct edit of Pi's SYSTEM.md file.
- Product/security/tool instructions have higher precedence than personal instructions; the UI must not call them a way to "bypass guardrails."

Provider/model switch should autosave after selection. Personal instructions apply from the nearest turn/session boundary Pi supports; the UI must clearly state if the next session needs to open rather than pretend it's a hot-swap.

### 11.3 Control

This is an important new tab.

**Execution policy**

- Autonomous (default)
- Guarded
- Ask every time

Each option has a 1–2 line concrete description.

**Jev guardrails**

- editable instruction text;
- presets;
- reset;
- test the policy with an example action that doesn't execute.

**Background work**

- segmented control 1 / 3 / 5 concurrent background tasks (default 3), saved immediately on selection and applied to
  the next request; running work is not stopped when the limit is lowered. The conversation's main turn is never
  counted against the limit.

**Safety controls**

- Emergency stop all active tasks;
- irreversible-action history;
- undoable recent actions;
- per-capability overrides.

Don't use a 50-permission checkbox matrix as the default view. Per-capability rules live in Advanced.

### 11.4 Extensions & Widgets

Consolidates what's currently scattered across Tools/Pi extensions:

- Marketplace button/search.
- Installed packages.
- Updates available.
- Enabled/disabled.
- Widget packages.
- Pi extensions.
- Tool/service packs.
- Capability status.
- per-package details.

Technical tool references live in expandable details, not the main list.

### 11.5 Devices & Voice

- microphone status/test;
- voice provider status;
- **voice picker when the provider supports it**; the client gets options/capability from the provider adapter, not a provider-specific list kept in the component;
- preview voice with a short sentence, only opening a provider session when needed and never writing the preview transcript into the conversation;
- wake phrase;
- input/output device;
- paired nodes/devices;
- current device label;
- voice credential status;
- device pairing.

Gemini Live currently supports choosing a preset voice via speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName; the implementation must keep the contract provider-neutral since another provider may not support voice selection.

Secret values are never displayed back.

### 11.6 Credentials

No dedicated top-level tab needed while credentials are few. Credential rows appear in the right domain, plus one Manage credentials subpanel to view the list of names/status.

Host-owned credential UI:

- name;
- purpose;
- connected/not connected;
- Replace;
- Remove.

Never renders the stored value.

### 11.7 Developer / Advanced

Hidden behind disclosure:

- node ID;
- raw Pi settings view;
- capability refs;
- package digests;
- token/time ceilings;
- connection diagnostics;
- contrast/debug specimens.

---

## 12. Elements & component standards

### Buttons

- Only one primary per local decision area.
- Icon-only needs an accessible label.
- Immediate press state.
- Destructive needs danger semantics, but Autonomous doesn't mean every destructive action must ask.

### Toggles

Used for an immediate boolean preference. Not for a one-time action.

### Segmented control

Used for 2–4 mutually exclusive modes: theme, policy, window mode, density.

### Search select

Used for long provider/model/package lists.

### Command palette

Just an accelerator; not a mandatory route.

### Toast

Only for reversible/lightweight success. Errors need to be near the object that caused them or in the timeline.

### Modal

Used for focused configuration/decision. No nested modals. Settings is a modal; package details can be an inner view within the same surface instead of a new modal.

### Context menu

Used for secondary widget operations: pin, detach, duplicate view, remove, package details.

### Tooltip

Only explains an icon/shortcut. Must not contain information the user needs to make a decision.

---

## 13. Memory UX

Memory must not become a database admin console the user has to maintain.

In conversation:

- Clark can briefly mention when a remembered preference materially affects behavior.
- The user can say "don't remember this," "change preference X."

Settings:

- Memory summary;
- types/sources;
- enable/disable categories;
- review recent memory-derived preferences;
- clear/manage route.

Don't show embeddings/vector internals.

---

## 14. Error & recovery UX

Error hierarchy:

1. recover silently if deterministic;
2. inline retry if a user action failed;
3. conversation message if a task was affected;
4. modal only when a host/device/security boundary demands focus.

The copy must state:

- what could not be done;
- what remains safe/preserved;
- what the user can do next.

Don't use a generic "Something went wrong" if the backend has a bounded reason.

---

## 15. Accessibility

- Minimum target should aim for 40–44 px for primary touch controls; the 24 px token is only for dense desktop affordances with enough spacing.
- Focus visible.
- Full keyboard path.
- Text alternatives for charts/images/complex widgets.
- State never communicated by color alone.
- Voice transcript accessible.
- Live regions don't spam screen readers token-by-token.
- Reduced motion.
- Contrast tests remain a release gate.

---

## 16. Performance

A smooth UX requires:

- composer interaction not blocked by widgets;
- heavy widgets lazy mount;
- offscreen widgets suspend;
- charts downsample with disclosure;
- image/video lazy load;
- animation uses transform/opacity;
- bounded ResizeObserver work;
- no global rerender per pointer move;
- a detached widget doesn't duplicate subscriptions if it isn't the owner.

Perceived targets:

- press feedback under 100 ms;
- local view action is immediate;
- first frame of a panel open isn't blank;
- streaming tokens don't cause scroll jank.

---

## 17. Implementation priority

### Phase A — polish core shell

- policy mode + Control settings;
- model quick switch + favorites;
- composer send/stop;
- window modes;
- unified motion primitives;
- input modality state;
- voice compact/orb mode;
- wake phrase contract.

### Phase B — widget UX foundation

- question/form/task/artifact/diff widgets;
- pin morph + detach;
- semantic widget focus for voice;
- unified widget chrome and empty/error states.

### Phase C — marketplace

- package manifest;
- catalog index;
- search/results/package detail widgets;
- install/update/remove;
- dev CLI + conformance;
- npm/git/local sources.

### Phase D — richer catalog

- map/diagram/timeline/kanban/browser/computer/call;
- package themes/personalization;
- marketplace discovery/ranking.

---

## 18. Design review checklist

A UI change is not complete if the answer to any of the following is "no":

1. Can the user accomplish it via chat or voice?
2. Is the main conversation still the primary surface?
3. Does it avoid adding an unnecessary new navigation concept?
4. Does the control give clear press/focus/loading/error feedback?
5. Is the transition smooth and purposeful?
6. Does reduced motion have an equivalent path?
7. Can the keyboard do everything important?
8. Does the widget have loading/empty/error/read-only states?
9. Is freshness/provenance honest?
10. Are local actions and external effects clearly distinguished?
11. Does Autonomous mode avoid repeated confirmation?
12. Does Guarded/Ask mode still enforce properly?
13. Is there reasonable Stop/Undo/recovery?
14. Can voice operate this surface via a semantic action?
15. Does the feature avoid exposing Pi/Jev/node internals unnecessarily?
16. Does it avoid adding a button/tab/card just because it's easier to code rather than better for UX?

If question 15 or 16 is "no," redesign before merging.

---

## 19. Source-of-truth rule

- DESIGN.md defines product interaction, visual behavior and UX invariants.
- AGENTS.md defines the rules agents must follow when editing the repo.
- Code + tests define behavior actually implemented.
- Architecture docs define trust/state/runtime boundaries.

If DESIGN.md describes a target that isn't implemented yet, code must not claim the feature already exists. If code intentionally changes UX direction, update DESIGN.md in the same change.

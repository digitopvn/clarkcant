# ClarkCant Design System & UX Operating Model

> English (default) · [Tiếng Việt](DESIGN.vi.md)

> Status: canonical design direction for UI/UX.
> Updated: 2026-10-05.
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

AI should make ClarkCant simpler over time, not more complex: simple enough that anyone can open it and use it without learning a single new concept or term. A feature that needs a new word to be understood is not finished. As models and tools get better, the surface should shrink, not grow.

---

## 1. Mandatory design principles

### 1.1 Conversation is the app

- Do not add a fixed sidebar just to hold navigation.
- Do not add a session picker to the main UI. Past and background sessions are summoned instead (`/sessions` or asking), and arrive as an agent message with a list widget.
- Do not turn widgets into a parallel dashboard.
- Hidden is not the goal; summonable is. Everything the user may need — sessions, provider sign-in/out, model and thinking, settings, diagnostics — can be called up in chat, by voice or with a slash command, and appears as an agent message with widget UIs (a mini app). Slash commands, words and voice converge on the same typed action.
- Answers that benefit from structure are composed as a mini app: asked to compare two models' benchmarks, Clark researches and replies with tables, charts and diagrams wired into one coherent surface, not a wall of text.
- Settings is a secondary surface, opened over the conversation and closed back to where it was. The gear, "open settings" typed or spoken, and `/settings` (`/settings <tab>` for one tab) all open that one dialog.
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

Built-in presets:

- Clark — default signature;
- Calm — cool blues, less glow/chromatic fringe, higher damping;
- Jelly — warm tones, softer spring with more pronounced but still bounded overshoot;
- Glass — icy tones, more sheen/exposure, low motion;
- Pearl — pastel mother-of-pearl contour layers inside the same glass shell, slow drift;
- Plasma — filaments from a lit core to the glass that reach toward the pointer;
- Custom — adjust advanced values within a safe range.

A preset may choose a palette, an interior style from a closed list (the spectral band, nacre contours, plasma filaments), optics, speed and physics. It may not change the Orb's size, silhouette, glass shell or rim: those are what make every preset recognisably the Orb. Custom is held to the same rule: the registry refuses a custom size, and a size stored before that rule is ignored. The Pearl and Plasma interiors are inspired by the orb catalogue at shadercn.run and are written from scratch, because that catalogue publishes no licence.

The preference is the global `orb.profile`. Settings → Experience shows one live preview, and a still swatch in each preset's own colours, and saves a choice as soon as it is made. The conversation reaches the same preference through the `orb.select` app intent, which the agent and the voice agent call through `control_app`, so "switch the Orb to Plasma" and a click on the Plasma swatch are one write, not two implementations. Clark reports the switch as done only once the Orb on screen has re-read the preference and shows the new preset; when the re-read fails, Clark says the choice is saved but not yet shown. Each swatch carries its preset's description as its accessible description, and an open Settings follows a switch made from the conversation.

prefers-reduced-motion always wins over the animation preference: the Orb still appears but stays still, or only reacts to state without motion. The stored reduced-motion preference and the platform setting are each enough on their own, and the platform setting is followed live in both directions: the Orb stops when it is switched on and moves again when it is switched off.

Without WebGL, the Orb stays visible as a still gradient in the chosen preset's colours (the shipped gradient for Clark), and Settings says that the machine cannot draw it and that the choice is still saved. The preview's status then reads as still rather than animating.

When WebGL is drawn by the CPU rather than a GPU (SwiftShader in Chromium and Electron, Mesa's llvmpipe on Linux, the Microsoft Basic Render Driver on Windows, the Apple Software Renderer on macOS), the Orb stays animated but draws on a reduced budget: at least 50 ms between frames, into a drawing buffer half the size it is shown at, which the browser scales up. A small Orb, such as the one in the header, keeps its full resolution. The renderer recognises this from the WebGL renderer's name, and a name it does not recognise is treated as a GPU, so a GPU-backed machine draws every display frame at full resolution exactly as before. Without this, the animated Orb alone took three to seven CPU cores of an idle page. There is no setting for it and nothing on screen announces it. Reduced motion still wins over it: a reduced-motion Orb draws one frame whatever renders it. The composer's glow follows the same signal: while the Orb reports `software`, or `none` when the browser has no WebGL at all and the Orb shows its still gradient, its light still travels round the composer but moves about fifteen times a second at the default speed instead of on every display frame, and reduced motion still stops it.

On a light surface the Orb keeps its own deep glass. The interior is light added to the glass body, so the body cannot be the page colour there: light added to a near-white page clips to a blank white disc. On the light theme the body is therefore the same dark, shell-tinted glass sphere the dark theme shows, and every preset's interior (the band, the nacre layers, the plasma filaments) reads as it does on dark. Towards the silhouette the glass takes on the page and shell colours, the way a glass ball's edge reflects a bright room, and the outer glow is a tinted aura rather than a grey ring. This matches the still gradient shown without WebGL, which is also a deep glass ball. The shader derives the surface's lightness from the page colour it is given, so the dark theme renders exactly as before, and a future theme gets the right body from its own canvas colour.

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

A widget in its own frame detaches the same way. The window mounts the same sandboxed frame the conversation does, and
every read, state write, semantic publish and press the frame makes is a bounded relay the host performs against the
instance it opened the window for. The frame is mounted afresh, so durable state carries over while view state and
playback position restart. While it is detached, the conversation shows a note in its place rather than a second frame,
and Clark's performs on it are refused with `FRAME_DETACHED` until it is reattached. Files, jobs and browser tokens work in
the window the same way they do in the conversation: each is a host relay for that one instance, so the window never
holds a token, and an attached file appears in the conversation. Clark's performs are not offered in the window yet
([#617](https://github.com/digitopvn/clarkcant/issues/617)).

The lease **moves** rather than duplicates: the shell releases first, the host claims the `detached` surface, and when
the window closes the host releases and the shell claims it back — so there is never a moment with two owners. Closing
the window is itself the reattach path, even when the user just presses the OS close button.

The host keeps that claim alive with the conversation's own numbers (refresh every 30 s, 90 s lease), and the node
records it as `detached`, so a competing claim is told the widget is open in its own window. While the window is open,
the conversation does not refresh a lease of its own. A refresh refused because another surface now holds the instance
closes the window. The window never outlives the conversation that opened it: closing that view (another conversation,
the pin closed), closing the conversation window or quitting closes the detached window, and its lease is given back
on the way.

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

On the Orb's own canvas, more attributes publish the **resolved profile** rather than the raw preference:

    data-orb          = gl | fallback
    data-orb-profile  = clark | calm | jelly | glass | pearl | plasma | custom
    data-orb-motion   = full | reduced
    data-orb-renderer = gpu | software | none   (gpu and software while data-orb = gl; none when there is no WebGL)

`data-orb-renderer` says which frame budget the Orb is drawn on; `software` is the reduced budget described in §1
for WebGL drawn by the CPU, and `none` is a fallback Orb on a browser with no WebGL context at all; a fallback for any other reason publishes no value. It does not change `data-orb-motion`: a budget is not reduced motion.

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

When the chosen model's provider refuses a turn (a stated error, nothing written), Clark answers the same message on the
next usable model — an enabled, credentialed pool profile, else the model the node's environment names — instead of
leaving the person with an error. It is never silent: the line under the reply reads "answered by a fallback model" in a
warning tone and names the chosen model and why it did not answer. The choice in Settings is not rewritten; the refusing
model is passed over for a few minutes and then tried again. When every model tried refuses, the failure names each one
with its reason, says the message is kept, and what to do next.

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

The inbox mark differs in one way: it stays on the header as a plain bell even at zero, because it is the pointer way back to notifications already read. It carries a count only when there's something waiting on the user or an unread notification, and it says so in words ("2 waiting on you · 1 new notification"), not with a colored dot. See §6.7.

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
- `/` names a skill and `@` names a project, file, folder, MCP service, conversation or background task, from a list
  the textarea drives as a combobox (arrows move, Enter adds, Tab opens a project or folder, Escape closes the list and
  keeps the draft; pointer and touch choose too). A choice writes its token into the draft and shows as a chip beside
  the file chips; deleting the token or the chip drops the reference, so a message never carries one the person cannot
  see. A skill whose name is also a slash command's is written `/skill:<name>`, in its row and in the draft, so choosing
  it always invokes the skill and a typed `/new` always runs the command. A reference is a pointer, not a permission:
  the node checks it again at send time and refuses the send by name, keeping the draft, when it has gone stale. While
  an input method is composing a word, its Enter finishes the word: it neither chooses a row nor sends. Shift+Enter
  starts a new line with the list open or closed. This is an enhancement, not the primary navigation.
- basic Markdown is marked while it is typed — strong, emphasis, strike, inline code, fenced code, headings, lists,
  quotes and links — with its syntax kept visible but quiet, so what is sent is what is seen and still edited as plain
  text. The field stays a native textarea (caret, selection, undo, spell-check and input methods unchanged) over a
  mirror that draws the same text; marks change only colour, a tint, a stroke or a line-through, never a glyph's width,
  so the caret never drifts. Under forced colours the mirror steps aside and the textarea draws its own text;
- focus is shown on the pill (accent edge and a soft halo), never as a second rectangle around the field inside it;
- the composer is as wide as the conversation column (720px), and scrolls past five lines with a hairline thumb.

While a turn is running:

- the send button morphs into Stop; Stop, Escape in the composer, and "dừng lại"/"stop" typed or spoken all reach the
  same per-conversation stop (`POST /conversations/{id}/stop`). It stops only this conversation's reply: what was
  already written stays, marked "stopped on request" rather than as an error, nothing arrives after it, and the stop is
  audited with where it came from. Stopping when nothing is running is a quiet no-op;
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

Tool activity is compact by default, including while a call runs; a failed call opens on its reason. Expand when the user wants to see arguments/result.

Three or more consecutive working steps (reasoning, tool calls and the checks under them) fold into one line that says how many steps were done and how many failed, and opens onto every step in order. While a reply is streaming, its newest step stays outside the fold.

The thinking state ends as soon as the first content/tool event appears.

A long conversation stays one continuous conversation:

- it opens on its newest messages; older history is read as the reader nears the top, with no button to press, and is put in front without moving the row being read;
- only the rows around the screen are in the document; the focused row, a row whose player is playing, the row of the embedded frame (a video, a map) last used, the rows a selection spans and the newest row always stay;
- a surface scrolled away and back keeps the view a person left it in for the session (an open fold, a draft, a search), never secrets typed into a credential card;
- while the reader is more than a screen above the bottom and something new arrives there, a "Jump to latest" button floats over the foot of the transcript; it is never permanent chrome and goes away at the bottom;
- a failed read of older history says so in place, keeps everything on screen and offers to try again;
- the browser's find-in-page sees only the rows in the document, which is every row of a conversation up to 60 messages. Searching further back is not shipped yet and is not done by keeping thousands of rows in the document.

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

- **A mark on the header** (§6.1), always present once the node answers: a plain bell with no count when empty, so
  already-read notifications can be reopened by pointer and keyboard. When something is waiting, the mark carries a warning edge;
  when there's only a new notification, it doesn't. Polled like the background-task mark, and re-read right after a
  decision or when the transcript changes.
- **Opened by click, keyboard, typed command or voice** ("open the inbox", "show notifications", "open my inbox") via
  the same `inbox.open` intent. When nothing is new, the bell and the command both still open the inbox to review
  already-read notifications.
- **Host-owned modal** (§12: it's a decision surface, no nested modals; opening Settings closes the inbox). Escape
  closes it and returns focus. Clearly states when the node read the inbox; never implies it's live.
- **"Waiting on you" first, "Notifications" second.** Waiting items include commands needing approval (showing the
  exact command line that will run, remaining time), permission requests from extension packages, an approval a running task
  is requesting (no card — the worker can't write a card, but it can still be Approved/Denied through its own route),
  an install the execution mode asked about (#341), and a question Clark is asking. An install item is titled "Install
  {name} {version}?" and says what the package asks for, in the listing's own words, and the lane it runs in; the
  package id sits behind Details. "Approve and install" installs exactly that version, with the same checks as any
  install, and says "Installed {name} {version}."; Deny says it was not installed and what is installed is unchanged.
  When the listing changed after the question, approving installs nothing and says to install it again to be asked
  about what it is now. Only the person decides it: the agents, MCP, the WebSocket relay and `clarkcant api` cannot
  install a package or decide an install. Approving a running task's approval re-runs that task with the newly granted
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
  notifications it displayed. "Open conversation" switches to the related conversation without opening an extra
  session.
- **Each notification carries the actions the node worked out for it** (#196), from what the notification is about
  (a task, background work, a conversation, a package, a Pi update) and how that thing is now — never from its text,
  and never an action a producer invented. At most two are buttons; the rest sit behind "More", an inline disclosure
  under the notification (not a floating menu) that Escape closes, returning focus to "More". Something that went well
  leads with "Open conversation"; something that failed or needs attention leads with "Ask Clark". A notification
  whose conversation was deleted says so in words instead of offering a button that fails.
  - **Ask Clark** closes the inbox and sends a message of its own carrying the notification as a composer reference
    (§6.3), checked like one chosen after `@`: the node reads the stored notification again and quotes its words to the
    model as data. Whatever the person was writing, and its chips, stay as they are. While Clark is still answering,
    the button is disabled with the reason written beside it. "Ask Clark about the latest notification" — typed or
    spoken — does the same for the newest notification through the `inbox.ask` intent.
  - **Add to context** puts the notification on the message being written as a chip and returns focus to the
    composer; it says so when the message already holds as many references as it can.
  - **Mark as read / Mark as unread** changes only that notification; the header mark comes back when something is unread.
  - **Dismiss** removes it from the list and offers **Undo** for five minutes; a notification brought back returns
    already read.
  - **Snooze**, under "More", offers four presets as a labelled group: "In 1 hour", "This evening (18:00)" (only
    before 17:00), "Tomorrow morning (8:00)" and "Next Monday (8:00)". A preset's time is worked out when it is
    pressed, on the device's clock. A snoozed notification leaves the list and the unread count and waits in a
    collapsed "Snoozed" list, where "Bring back now" returns it. Snoozing keeps whether it was read: Undo or "Bring
    back now" returns it exactly as it was, and only a snooze that runs out brings it back unread, at the top. A
    snoozed notification of a kind quieted since still comes back unread and may notify, because snoozing asked to be
    reminded of that notification.
  - **Stop notifying me about this kind**, under "More", is offered only for a kind narrow enough to mean what it
    says: one automation, one signal source such as one repository, one package, Pi, one paired device, or the
    person's own background and worker work. Anything wider would also silence reminders and every other automation,
    so it is not offered. Reminders are never quieted. Later notifications of a quieted kind are still listed but
    arrive read and raise no notification outside the app. A collapsed "Quieted kinds" list says in words what
    each one covers and at what level (e.g. "Automation “…” — warning level"), with an example title, and "Notify
    again" reverses it; Undo does too.
  - **Copy details**, last under "More" on every notification (#349), puts a plain-text summary on the clipboard for
    reporting it somewhere else: its title, its body, where it came from and what kind it is, its severity, its time,
    and what it is about by kind and id, each labelled in the reader's language. The summary is written by the screen
    from the notification's own fields and nothing else: no token, no path the notification does not show, no internal
    code. Every hidden or bidi character is written as a visible marker (`⟨U+202E⟩`), and a line break inside the title
    or an id is marked too, so a copied notification cannot pass for other lines. The result is said in the inbox's
    status line, which a screen reader hears without focus moving; focus stays on the button and "More" stays open.
    Because that line may be scrolled out of view, the button's own label also says "Copied" or "Couldn't copy" for
    about two seconds, then reads "Copy details" again. It keeps its width and its accessible name meanwhile, so the row
    does not reflow and the result is heard only once, and nothing animates. A
    clipboard the browser refuses, or a page without one, is said in words ("Could not copy: …") and the inbox stays
    open for selecting the text by hand.
  - **What can be done about the thing itself leads** when that thing can still take it. The node works this out on
    every read, like the rest.
    - **Run again** leads on background work that failed, was stopped or was interrupted, while its record and its
      conversation still exist. It starts the same request as new work in the same conversation, says so there, and
      removes the old notification; the new run reports with a notification of its own. Background work is read-only,
      so running it again needs no approval. Work already run again offers nothing; work whose record is gone says so
      under "More". A worker task that failed does not offer this, because a task's failure is final and what it
      already did has to be respected. "Ask Clark" leads instead.
    - **Update** and **Review in Settings** lead on an update notification while the package is still installed at an
      older version. Update goes through the same install route as the marketplace, with all its checks. A refusal is
      said in words, the notification stays, and the installed version is unchanged. Review closes the inbox and opens
      Settings → Extensions. A version from a local folder offers only Review, because only the person knows which
      folder to install from. **Skip this version**, under "More", stops notifications about that version and older
      ones of that package (or of Pi) for this person, removes the notification, and offers Undo; a newer version is
      still reported. A collapsed "Skipped versions" list beside "Quieted kinds" names each skipped version, and its
      Undo takes the skip back even after the notification is gone. Once the package is updated or removed, "More"
      says so instead of offering Update.
    - **Ask again** leads on the notification about a question nobody answered in time, while its conversation exists
      and it has not been asked again. It asks the same question in the same conversation, and the new card waits in
      "Waiting on you". The old card says it was asked again, and an expired card says it expired; neither claims an
      answer was recorded.
    - **Not offered yet**, because no route exists that could do them honestly:
      - asking again for an expired approval: re-issuing it would bypass Jev's policy gate, and an expired task
        approval has already ended its task;
      - replying to, or opening, a message from another device: there is no message channel between devices yet;
      - inspecting or fixing a system warning from the inbox.
  - **Waiting items are never snoozed or quieted.** Approvals, permission requests and Clark's questions are decisions,
    not notifications: they stay in "Waiting on you" until decided or expired.
- **A notification's actions are the same action wherever they are asked for** (#196). The panel's buttons, a typed or
  spoken sentence, the main agent and the voice agent, MCP and `clarkcant api` all reach one route on the node, which
  checks the action against what the notification offers now and refuses anything else with the reason, changing
  nothing. Every action is recorded with the surface it came from (a press, a typed or spoken sentence, an agent, MCP,
  the relay) and what came of it. The sentences are whole requests ("mark the latest notification as read", "dismiss
  the latest notification", "undo dismissing the notification", "snooze the latest notification", "bring back the
  snoozed notification", "retry the failed background work", "install the latest update", "skip this version", "ask
  the expired question again", and their Vietnamese forms such as "bỏ thông báo mới nhất", "hoàn tác bỏ thông báo" or
  "chạy lại việc nền bị lỗi"). A sentence names the action, never the notification: the node picks the newest one for
  read, unread, dismiss and snooze (one hour), the most recently dismissed one to undo, the soonest snoozed one to bring
  back, and the newest one that can take the action now for retry, update, skip and ask again. The read-back names that
  notification by its title, so a person who hears the wrong one knows; when none fits, Clark says so and does nothing.
  Read, unread, dismiss, undo, snooze, bring back and quieting a kind can be taken back, so they are carried out without
  asking back; a short status line then says what the node did, in the panel's own words. A dismissal's read-back
  says how long it can be undone ("Tôi bỏ thông báo “…” khỏi hộp thư nhé. Bạn có thể hoàn tác trong 5 phút."). What
  the node did is then said in the conversation itself, directly under that reply — never in a card over the page —
  with a real inline **Undo** for exactly those five minutes, the time the node keeps the notification restorable. It
  appears without taking focus, is reached with Tab like any control, and afterwards says quietly "Hết thời gian hoàn
  tác" / "Undo window has passed". Pressing it, or saying "undo dismissing the notification", brings the notification
  back through the same route, and the line then says "Đã đưa thông báo trở lại hộp thư" / "The notice is back in your
  inbox". Retry, update, skip and ask again start or change something and are not called
  reversible: retry, skip and ask again are carried out as asked, because each is the notification's own offer and
  runs with the checks the panel's button has. **Installing an update is the person's own decision**: it adds code to
  the machine and grants what the package asks for. Only the panel's Update button installs, or a spoken request that
  Clark asks back ("Install the update in …? It adds new code and the permissions it asks for. Do you confirm?") and a
  spoken yes confirms. Typed, Clark opens the inbox on that notification and says to press Update, installing nothing
  until the person does. The agents, MCP, the WebSocket relay and `clarkcant api` cannot install it: the route is
  person-only for them, `act_on_notice` does not offer it, and a request that names it anyway is refused. After an
  update installs, the status line says which permissions it asked for still wait for approval or were refused, since
  the package runs without them. The agents first read the inbox, which lists each notification's id with the actions
  they can take now, the ones they cannot and why, and the ones only the person can take; it marks the notifications'
  own words as data reported by other work, never instructions. Then they call `act_on_notice`, and the audit records
  these as the agent's or the voice agent's, not the person's. Opening a conversation, Ask Clark, Add to context,
  Review in Settings and Copy details change what the person's screen shows or holds and stay buttons on that screen;
  the answers about an action whose outcome nobody saw stay the person's (below). An update whose install the execution
  mode asks about installs nothing yet and says the install waits in the inbox under "Waiting for you"; the panel marks
  that item, where the person approves or denies it (#341). Pressing Install on a marketplace result under the same mode
  says the same beside the button, with an "Open inbox" control that opens the inbox on that item. A refusal is said in the
  reader's language, from the node's reason code, never as the code itself.
- **An action whose outcome nobody saw asks the person** (#273). When a command that reaches outside the node (a push, a
  deploy) timed out or was stopped before it reported, the task waits as uncertain and the inbox has one notice about
  it, pointing at the task and its conversation. A consequential browser action (a form submit) is written to the same
  ledger and leaves the same notice when it times out, but only where something drives the browser pack for a task, and
  nothing does in production yet, so today only commands reach the person this way. While that action is still unknown,
  and only then, the notice's two buttons are "It took effect" and "It did not take effect", with "Checked on the
  receiving side? Once recorded, this cannot be changed." said before them in the warning tone, not as body text. A
  press records the answer, with who and when, on the effect ledger; the notice leaves the list, focus moves to the next
  notice, and the task's conversation says how the task ended: succeeded only when the action took effect and the run
  had verified its result, failed otherwise, cancelled when the person had asked it to stop. A task with another unknown
  action gets one new notice naming that one; a task whose run is still going settles when the run reports. An answer
  someone already gave (another screen, a sentence) is said as such and the list is read again. Because an answer cannot
  be changed, the same words typed or spoken ("it took effect", "đã có hiệu lực", "it did not take effect", "chưa có
  hiệu lực") never record it alone. With exactly one action waiting, named in the read-back: spoken, Clark asks it back
  ("Record that … took effect? Once recorded, it cannot be changed.") and records on a spoken yes; typed, Clark says
  which button answers and opens the inbox on that notice, so the press beside the warning is the confirmation. With
  none or several, Clark says so and records nothing. Clark cannot give the answer itself: MCP, the WebSocket relay and
  `clarkcant api` refuse the route and `control_app` cannot name it, because an agent that could say its own push landed
  could report its own success.
- **Update notifications for installed packages and widgets** (`apps/runtime/src/update-checks.ts`), from a periodic
  job comparing the installed version against the directory index. The Pi SDK is not announced: it ships pinned with
  ClarkCant, so the inbox could offer nothing to do about it, and older Pi update notices are retired. Content states current version → new version and risk lane, using the same
  naming as the marketplace. Update, Review in Settings and Skip this version are described above; a version skipped
  there, or anything older, is not reported again.
- **Out-of-app notifications when the window is unfocused or in minimized/orb mode** (#171): on desktop this is an OS
  notification via Electron `Notification`, host-owned, with only redacted title/body — never a command line or a
  secret; clicking restores the window from orb/compact to normal size, focuses it and opens the inbox via the same
  `inbox.open` intent, on the item the notification was about: that row is marked with an accent edge, scrolled into
  view (without smooth scrolling under reduced motion) and focused as a row, which is named for what it is ("Notice: …",
  "Waiting for you: …"). Focus never lands on one of its buttons, so an Approve or Update is always a deliberate press
  after the person has read the item. When the item was decided,
  answered or dismissed elsewhere meanwhile, the inbox opens at the top and says so. A notification carries only the
  item's id (`notice:…`, `question:…`, `command-approval:…`, `capability-approval:…`, `install-approval:…`, `task-approval:…`), checked
  against the same grammar by the desktop shell and by the page; anything else opens the inbox at the top. The web
  notification's click does the same. Buttons on the OS notification itself are not offered (#340): on Windows
  they need a packaged app identity, and Linux notification servers differ in whether they show them. On the browser
  it's the Web Notification API, only enabled after the user presses the button in
  Settings → Control and the browser grants its own permission; the toggle reflects the browser's actual permission,
  states clearly when it's been denied or dismissed, and is hidden on desktop. On desktop, when the latest notification
  could not be handed to the OS, an inline status beside the OS toggle says why and that the item is still in the
  inbox, until the OS accepts a notification again. Per-group options (approvals waiting,
  background results, updates) plus quiet hours, saved immediately without a Save button; no toggle appears before its
  saved value has finished loading. The "other devices" group appears but is disabled with the reason "no device paired
  yet" until a node pairing exists. A waiting item about to expire (≤ 1 minute left) is nudged exactly once, with a
  title clearly stating under 1 minute remains.
- **An approval or question that expires unanswered is reported, not silently dropped from the list.** A periodic scan
  on the node writes exactly one notification per expired item, pointing back to its own conversation; a package
  permission approval (which belongs to no conversation) has nothing to point back to, so it isn't reported through
  this path.
- **An action whose outcome nobody saw is one notification for its task.** When a command a background task ran that
  changes something outside the node (a `git push` or opening a pull request, for example — not deleting a folder on
  this machine or reading from GitHub) was stopped, timed out or was cut off by a restart before it reported back, the
  task is kept as "outcome unknown" and refuses every further command it recognises as reaching outside, so the task
  does not do that action a second time on its own, as the same command or in other words. One notification for that
  task — in place of the one saying it stopped or ended, not in addition to it — quotes the action, says when it was
  the person's own Stop, says what was kept, and asks them to check the receiving side before running it again.
  Dismissing it does not bring it back.
- **Reminders and automations that come due** leave one notification per occurrence, pointing back to their
  conversation, including when a run came due but was refused or could not start.

Not shipped (target):

- notifications and waiting items from another ClarkCant node (already has `originNodeId` and a dedup key so repeated
  receipt is safe);
- marking an action whose outcome was unknown as checked (done or not done) from the notification;
- notification when an OAuth connection expires or is revoked: the `connections` table has no place writing real rows
  in production yet;
- action buttons on the OS notification itself (#340).

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
- ask the user a question / answer an open panel;
- act on a notification: mark the latest one read or unread, dismiss or snooze it, bring back the snoozed one, retry
  failed background work, install an update, skip a version, ask an expired question again (§6.7).

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

Built-in miniapps read their own state machines through one shared status
contract (`packages/contracts/src/surface-status.ts`). Each domain keeps its
machine; the contract only decides how a state looks, whether it is said aloud,
whether it can be retried, and whether it is still current.

- **Phases.** `loading`, `empty`, `pending`, `needs-action`, `success`,
  `partial`, `error`, `unavailable`, `cancelled`. One tone and one text mark per
  phase, so `partial` is never green on one card and amber on the next, and no
  state is told by colour alone. The mark is drawn by the stylesheet with an
  empty alternative text; the badge's text is only the domain's own words.
- **Never a failure as a success.** A task that reports success against
  contradicting evidence is `error`; success without verified evidence is
  `partial`. A state this build does not know is drawn plain, never guessed.
- **Missing is not zero.** A value is `reported` (with its source, `official` or
  `inferred`, and an as-of time), `unknown`, `unavailable` (with a reason) or
  `unsupported`. A missing duration or metric is left out or said as unknown.
- **Snapshot or live.** A host card is a snapshot and is never stale. A live
  view carries `observedAt` and a stale window, and past it keeps what it showed
  and says how old it is.
- **Announcements.** What a press answered goes in a live region that exists
  before the answer arrives: `error` is assertive, any other change of phase is
  polite, and the same phase again, `loading`, or anything already on screen at
  mount (a reload, a scroll back) is not announced.
- **Late answers and retry (contract helpers, adopted surface by surface).**
  The contract's `settleSurfaceStatus` drops an answer for an earlier attempt
  and keeps the first outcome of an attempt, so neither a late "still working"
  nor a later outcome replaces it; its `canRetry` offers a retry only for
  `error` or `partial` when the domain names `retry` or `check-again`. No
  built-in miniapp calls them yet: today's retries (press again on a task stop,
  try again on a credential) and late answers on command-card rows still follow
  each surface's own rules, and move onto these helpers as those surfaces are
  reworked.

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
- **In the Widget Library:** Terminal sits under "System cards", apart from the built-in catalog. The entry has only a
  description, a static illustration labelled as an illustration and a hint for opening it through the conversation.
  There is no live preview and no open button, because a host-owned card is tied to real state and is created only from
  the conversation.
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
nothing reads yet (background routing, voice picker) gets **no** control, and the reason is stated where the
user would look for it — silently skipping it is worse, because the user would think the app is broken.

### 11.1 Experience

Use segmented controls, toggles and swatches:

- Appearance: System / Light / Dark. This is the **colour scheme**, not the theme. The choice is stored on this
  device (`localStorage` key `cc.theme`), which is what the pre-paint script reads, so the page paints in the chosen
  scheme before anything else loads. The node also registers a key for it, `experience.colorScheme`, which the REST
  API reads and writes (`GET /preferences`, `PUT /preferences/experience.colorScheme`); the web client does not read
  or write that key yet, so a scheme chosen on one device does not follow the person to another. The theme is a
  separate preference (`experience.themeRef`, default `builtin:clark`, Clark Default), and every theme is drawn in
  whichever scheme the choice resolves to.
- Theme: a list under the colour scheme, Clark Default first, then each theme an installed package provides. Every
  entry shows its name, its description and the package's trust lane, because a theme reaches the whole window; the
  package id, version and full digest sit behind a small disclosure on the entry. Choosing one writes `experience.themeRef` and restyles the page in place by replacing only the token
  stylesheet: no reload, and the conversation, a half-typed message, a pinned widget and the Orb carry on (the Orb
  redraws in the new colours). Every theme is held to the contrast audit Clark Default is held to, in both schemes (the
  pairs are `requiredPairs` in `packages/design-tokens/src/contrast.ts`). A theme that fails is
  not offered — it is listed with the failing pairs — and a choice of it is refused with that reason. The page checks
  the document again, contrast included, before compiling it, and keeps a copy on the device (`cc.appearance`) so the
  next load starts in it; a copy that no longer compiles is dropped and the page starts on Clark Default rather than
  blank. When the chosen theme cannot be drawn — its package was removed, an update made it invalid or too low in
  contrast to read, or its files cannot be read — the page shows Clark Default and says so in a status notice where
  the choice is made, with the reason under "Details" in the reader's language — for colours, one failing pair per line,
  built from the pairs the node sends as data rather than from its English message; the choice is kept, so restoring the package, or an
  update that fixes it, brings the theme back.
- Theme depth: a theme can change more than colour — fonts from a fixed set of profiles, heading weight, line width and
  style, hard or no shadows, motion speed and easing, icon stroke, field radius, one host-owned recipe per button, card,
  input, modal, badge and composer, a backdrop (dot grid, hard grid, scanlines, grain, paper) and a surface finish
  (glass, soft glow, paper, grain). It picks each by name or bounded number; the host writes every value, so no theme
  supplies a selector or a rule. What stays the host's whatever the theme says: the focus ring (always the focus
  colour, never a recipe), disabled controls, the host's own cards (an approval, a credential, a connection keep their
  edge and their plain card surface — no glass, texture, glow or shadow — when widget cards are drawn otherwise), the
  buttons in those cards and in the inbox, and Stop (Clark's own button in the theme's colours, never the theme's button
  recipe, so an approval's Approve stays filled with the accent and its Deny plain beside it), and
  reduced motion (every duration none, the backdrop's pointer light off, the Orb still), whether it comes from the
  operating system or from the Reduced choice under Settings → Experience → Motion. Glass frosts widget cards and the
  composer as an opaque tint, so the Orb behind the composer never shows through; only the modal is translucent and
  blurred, one surface at a time. The backdrop's pointer light is as strong as the theme's backdrop, never stronger. A
  second audit refuses a theme that would make a protected state hard to tell apart — danger from warning or success,
  a status from text, focus from other edges, disabled from enabled, an edge from its card or the page, any text,
  status colour, accent or focus ring on a surface finished by an effect or on the page under the backdrop and its
  pointer light (the modal measured over the brightest and darkest page its scrim can cover), and an Orb whose light
  would vanish into the page — and lists what it hides one line per check, as the contrast audit does. Status is
  never shown by colour alone: a recipe or an effect changes surfaces and edges, never the icon or the words a status
  is shown with.
- Theme Orb default: a theme may suggest one of the shipped Orb presets, with its own colours on every channel but the
  page colour the Orb sits on, which the page always supplies. It applies only while the person has never chosen an
  Orb; once they choose one, including Clark's own, theirs wins, and reduced motion wins over both. A palette dark
  enough to disappear into a dark page is refused by the audit above.
- Changing the look by sentence: "đổi giao diện sang Neo", "chuyển giao diện sang tối", "đặt lại giao diện", "mở danh
  sách giao diện" (and the English equivalents), typed or spoken, and the agent's `control_app`, reach the same
  preference write and the same colour-scheme call as the controls above. A sentence names only a theme this node can
  draw; nothing asks for confirmation, because the change is undone by making it again. Opening the list by sentence
  puts keyboard focus on the chosen theme.
- Desktop: the desktop window's own shell page reads the same compiled tokens (`apps/desktop/src/appearance-tokens.css`,
  generated from Clark Default) and follows the system's light or dark; the conversation window is the same page as the
  web client, so a theme looks the same in normal, expanded, compact and Orb modes.
- Language: Tiếng Việt / English — segmented control, applies immediately (no save button), sets `<html lang>`, and
  persists across reload and devices through the preference registry (`experience.language`). Default is Vietnamese;
  there is no "follow system" option, because no cross-platform signal for "UI language" is reliable enough not to
  silently switch a Vietnamese speaker's product language away from Vietnamese. Only default chrome (composer,
  timeline chrome, settings, error copy, voice controls, marketplace headings) is translated; agent output is never
  translated. The words the node itself writes for its owner are worded in this language when they are written, and
  never translated on the client. That covers the model note and other host cards, the rows and receipts an approved
  command or package call leaves, approval cards and the reason a task waits for one, how a task ended when the node
  wrote it (a refusal, a run with nothing to show, a stop, an answer recorded for an effect), inbox notices,
  start-screen suggestions, and the Tools tab's labels. Text the node did not write, such as an error or what a run
  reported, is quoted as written rather than worded into the sentence. What is already written keeps its language:
  switching changes what is written next, so an approval card asked before the switch keeps its wording, and so does
  that wording where the notice of its expiry quotes it. Two kinds of text stay as written. Text a node sends to a
  paired node is one, because that node's owner's language is not known. Labels and summaries authored by a package or
  extension are the other: they are shown in their author's words.
- Theme Lab: Browse themes opens a temporary Gallery above Settings. Opening puts focus on the selected theme once;
  subsequent preview updates do not steal it. Picking in the Gallery previews production components locally, and
  Apply uses the same confirmed preference write as the main theme list. The last six choices are available as
  recent themes. The conversation and its draft stay mounted. Examples are labelled and never run a model turn or
  operate real approvals, files or voice. Scheme, normal/narrow/compact width and reduced-motion switches belong to
  the preview; token, recipe and audit details are disclosures within this authoring utility.
- Accent: bounded six-digit hex colors for dark and light, audited before storage with the production contrast and
  protected-state checks. Refusal keeps the saved appearance. If an installed update makes the saved accent unsafe,
  draw the theme's own accent, explain the fallback, and keep the preference for recovery.
- Motion: Full / Reduced / Follow system.
- Density: Comfortable / Compact, compiled into shared spacing tokens while preserving type and layout minima.
- Interface font and code font: a row of specimens, each tile set in the face it names, with "Theme's" first (choosing
  it clears the preference). The interface face covers body and headings together, so the page keeps one voice; the
  code face covers code blocks, inline code, paths and tabular figures. Choices are closed profiles compiled by the
  same snapshot compiler, never free family names; the host ships the extra faces (Inter, Geist, JetBrains Mono, Geist
  Mono) itself, so no choice needs the network.
- Reset theme customization clears accent, density, fonts, motion and explicit Orb tuning through the existing preference
  reset/Undo path. It preserves the selected theme, color scheme and language; each confirmed change is redrawn, and
  a failed write stops the remaining reset and reports the failure.
- Window behavior: remember size, start mode.
  - Shipped: the desktop window reopens where it was closed (size, position, maximized or full screen) while that
    display is still attached, and at the default size otherwise.
- Wake phrase: on/off + local-listening status.
- Keyboard shortcuts: opens a subpanel.
- Version & what's new: the installed Clark version and channel, and the release notes that came with the build,
  read offline (`GET /changelog`). It is the same list `/changelog` and "what's new?" draw as a card in the conversation:
  releases newest first, entries grouped Breaking, Features, Fixes, Other. A build run from source also says which
  commit its notes reach and that the checkout may hold later changes. There is no update button, update status or channel
  choice until an update service exists. When the notes cannot be read, the section says so in one sentence and keeps
  the rest of Settings usable.

Don't show contrast debugging to consumers; put it in the Developer section.

### 11.2 AI & Routing

- Current model as a searchable picker.
- Provider sign-in (shipped): under the provider and model picker, every provider pi can answer with, signed in or
  not, with only the ways in pi advertises for it — an account sign-in (OAuth) when pi offers one, an API key when pi
  takes one. A signed-in provider says where its credential comes from: stored by pi, the node's environment (.env
  or the shell), handed over at startup, pi's models.json, or pi's own fallback. Only a credential pi stored offers
  Sign out (and Replace API key / Sign in again); the others say they cannot be signed out here and where to remove
  them. It is the same capability `/login` and `/logout` answer with in the conversation — the same node routes,
  sign-in registry and client path — so the sign-in is followed in the row (the provider's page to open, a code, a
  password field for a key) with loading, failure and done states, and what is typed goes straight to pi and is
  never shown back. A finished sign-in or sign-out reads the provider list and the model catalogue again. A node
  without pi says there is nothing to sign in to here; a list pi could not read says why and offers Try again.
- Decision provider (shipped): beside Provider sign-in and separate from the conversation model, who answers Clark's
  small typed decisions. It shows the provider and model in effect, a badge for what chose them (Settings, the
  environment, or the default), the status — ready, local-only, misconfigured, no key, or off — with the decider's own
  reason and what to do about it, and the last call since the node started. A segmented control offers Follow
  environment, TypeSafe Jev, Cloudflare Clef and OpenRouter; Cloudflare adds its model choice and an account-id field,
  OpenRouter a pinned model-slug field that is saved only once a slug is entered (a router such as `openrouter/auto`
  is refused with the node's reason). Each provider has a key card that says where its key comes from (saved here, the
  environment, or none), with a password field, Save/Replace and Remove for a key saved here; a typed key is cleared
  once stored and never shown back. Every write goes to the node's decision-provider routes and the card redraws from
  the answer; each change says it applies from the next decision, and nothing asks for a restart.
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

# AGENTS.md

Process rules for agents working in this repository. Product intent and
architecture live in README.md and docs/README.md. UI/UX direction and interaction
invariants live in DESIGN.md. Do not restate those documents here except for the
hard rules an implementation agent must follow.

When docs/system-architecture.md and docs/system-architecture.png disagree, the
PNG is current and the prose is the thing to fix.

## Product and UX priority

**UX is a product invariant, not final-pass polish.** Before changing a visible
flow, read DESIGN.md and the relevant journey docs.

The user-facing mental model is deliberately tiny:

1. one conversation;
2. one Clark voice agent.

Pi sessions, Jev, workers, memory, node topology, package generations, tools and
routing are implementation details. Do not turn them into navigation concepts the
user must learn.

Hard UI rules:

- **The animated Orb is ClarkCant's signature and must not be removed or replaced as the default identity.** It may be personalized only through bounded, typed palette/effect/physics preferences defined by DESIGN.md; reduced-motion still wins.
- Conversation remains the primary application surface. Do not add a permanent
  sidebar, session picker or dashboard as the default navigation model.
- Settings, marketplace, widget details and diagnostics are secondary surfaces;
  opening them must preserve conversation state and restore focus on close.
- Any important action should be reachable through conversation, and when the
  voice action model supports it, through voice as well.
- Prefer progressive disclosure. Do not put node IDs, digests, capability refs,
  Pi internals or model-routing internals in the default UI.
- Do not add a control that looks usable before its real action exists. Disable it
  with a visible reason or omit it.
- Never present cached, sample, historical or uncertain data as live/current.
- Never invent progress, evidence, success or permission state.
- Error copy must say what failed, what was preserved and what the user can do.
- Do not make the user repeat an intent merely because the implementation has
  several tool calls underneath it.

### Execution-policy UX

The target product policy in DESIGN.md is:

- Autonomous — default; execute explicit user intent without per-action approval.
- Guarded — ask only where configured/risk policy requires it.
- Ask every time — confirm effectful actions.

This direction does **not** permit bypassing OS, OAuth, browser, vendor or other
hard external consent boundaries. It also does not turn untrusted widget code
into privileged code.

When implementing or changing execution policy:

- keep Stop, audit/provenance and recovery paths;
- add Undo/rollback where the underlying action genuinely supports it;
- keep host-owned trust/credential/OS consent UI outside untrusted widgets;
- route configurable guardrails through Jev/policy rather than sprinkling ad-hoc
  confirmation dialogs throughout components;
- update architecture/conformance docs and tests when behavior changes. DESIGN.md
  may describe target behavior before code implements it; never claim target
  behavior is already shipped merely because it is documented.

## Motion and interaction

Everything visible should transition deliberately, but motion exists to explain
state change rather than decorate the screen.

- Use design-token motion durations/easings. Do not hard-code a new duration when
  an existing token expresses the interaction.
- Use the shared motion helpers (`press`/`release`/`panel`/`popover` in
  `packages/design-tokens/src/motion.ts`) instead of writing a transition by hand. They
  animate only `transform` and `opacity`, so a hand-written transition is the only way to
  animate a layout property or put the mild bounce on body text.
- Use the mild bounce token for press/release, pin/drop and panel settle. Never
  bounce body text or run several competing springs.
- Do not use CSS transition: all.
- Prefer opacity and transform animations over repeatedly animating layout
  dimensions/positions.
- Pointer, keyboard, touch and voice must remain independently usable. Hover may
  enhance; it may not reveal the only affordance.
- Keyboard focus must be visible and must not depend on the accent color alone.
- Escape closes the nearest dismissible surface and restores focus.
- Respect prefers-reduced-motion. A zero-duration infinite spinner is a bug, not a
  reduced-motion implementation.
- Agent/voice ambient effects must remain subtle enough that text readability is
  always dominant.

If adding a root-level interaction state, prefer explicit state/data attributes
for input modality, agent state, policy mode or window mode instead of components
guessing from unrelated DOM state.

## Conversation surface

- Preserve chronological streaming: text, reasoning and tool activity appear in
  the order the turn produced them.
- Thinking indication ends when the first meaningful text/tool/reasoning event
  arrives.
- Do not auto-scroll a reader who deliberately scrolled up.
- Composer interaction must stay responsive while widgets or turns are busy.
- Attachments need visible checking/failed/retry/remove states beside the file.
- Prefer a send/stop control in the same physical location during an active turn.
- Dynamic/recent suggestions are preferable to growing a permanent menu.
- A background task count belongs in chrome only while non-zero.

## Voice

Voice is another interaction mode for the same Clark, not a separate product.

- Entry belongs in the conversation composer and may also come from a host
  shortcut or wake phrase.
- Local mute/end controls must not depend on a remote model.
- Voice actions should reach the same typed action/intent path as text; do not
  implement a second business-logic stack by matching arbitrary transcript
  strings in the renderer.
- Focused widgets should publish semantic state/actions so voice can manipulate
  them without screen-coordinate guessing.
- Compact voice bar and orb/minimal window modes must preserve session ownership;
  collapsing UI does not silently stop or duplicate a voice session.
- A future “Hey Clark” wake listener must be distinguishable from active remote
  transcription and should remain local where the platform allows.

## Widgets

There are four trust lanes and agents must not blur them:

1. host-owned UI — credentials, trust, policy, device/OS consent;
2. built-in catalog — trusted client components from declarative props/data;
3. declarative compositions — no executable payload;
4. custom isolated widgets/MCP Apps — sandboxed bridge and bounded capabilities.

Rules:

- One logical widget instance has at most one live effect owner.
- Inline history remains an immutable/read-only snapshot.
- Pin and detach are presentation changes; they do not create a new session.
- Local view state such as filter/select/zoom may remain interactive in a
  read-only snapshot. Effect actions must not.
- Every widget has loading, empty, partial/unavailable, error and read-only paths.
- Every rich visual needs a useful text alternative.
- Widgets do not get generic Electron IPC, raw secrets, privileged host cookies or
  arbitrary tool execution by name.
- Third-party code cannot render authoritative approval/credential/trust chrome.
- Use schema-validated action bindings and expected revisions; double-click
  effects must deduplicate.
- New default widgets should follow the priorities in DESIGN.md, especially
  question/form/task/artifact/diff and browser/computer surfaces.

### Widget marketplace

Before changing Widget SDK, authoring templates, package metadata, conformance or publish flows, read `docs/widget-development.md`; it is the canonical developer-UX target.

Follow Pi's successful package ergonomics — small core, package facets, npm/git/
local sources, easy install/update — without copying Pi native extension trust
into the widget renderer.

- UI-only executable widgets default to isolation.
- Packages may have independent UI/tool/skill/theme/recipe facets.
- UI-only updates must not require restarting Pi.
- Marketplace UI must show source, version, compatibility and capability/risk
  information without making package metadata the main interaction.
- Installed packages are listed with their **source, version, digest and risk lane**, and
  the lanes are labelled apart: a native Pi extension is trusted process-level code that runs
  beside the host, while an isolated widget is opaque-origin code with no Node, filesystem or
  host cookies. Showing them with the same wording is the one mistake that list exists to
  prevent.
- An explicit “install X” request is already user intent in Autonomous mode; do
  not insert a redundant confirmation unless configured policy or a hard external
  boundary requires it.
- Native Pi extensions are trusted process-level code and must be labeled/handled
  differently from isolated widgets.
- Developer templates must include conformance fixtures, accessibility, text
  fallback, state migration and action-dedup tests.

## Settings

Settings is a secondary modal/surface, not an admin dashboard.

Prefer the structure in DESIGN.md:

- Experience
- AI & Routing
- Control
- Extensions & Widgets
- Devices & Voice
- Developer/Advanced as progressive disclosure

Use the right control:

- segmented control for a small exclusive mode set;
- toggle for an immediate boolean preference;
- search-select for long provider/model/package lists;
- button for one-time actions;
- inline status for mutation outcome.

Do not use a save button for a reversible single preference if selection can be
safely persisted immediately.

Stored secret values are never rendered back to the browser. Show name, purpose,
connection status and replace/remove actions only.

## UI definition of done

For any visible journey change, run the normal checks plus browser E2E. Before
reporting complete, verify:

- main conversation still works at narrow and normal desktop widths;
- keyboard-only path works;
- focus returns after modal/live/detached surfaces close;
- reduced motion path works;
- loading/empty/error/blocked states are visible and truthful;
- no control is fake;
- no snapshot claims to be live;
- no secret is echoed;
- voice/text reach the same action semantics where applicable;
- motion does not introduce scroll/layout jank;
- the change does not add a new navigation concept without a strong reason.

Update DESIGN.md in the same change when intentionally changing a UX invariant.

## Tooling

- pnpm 12 via Corepack, Node 22.19+ (24 in CI too). Never npm/yarn.
- Dependencies are exact-pinned (saveExact, checked by pnpm invariants).
  pnpm-workspace.yaml refuses releases younger than 24h and blocks lifecycle
  scripts unless listed in allowBuilds; a fresh package failing to install is
  that policy, not a network error.
- Node runs .ts directly by stripping types: no enum, namespace, or constructor
  parameter properties (ESLint and pnpm invariants both fail on them).
- Workspace packages resolve to src/index.ts, never dist/; don't add build steps
  to make imports work.

## Commands

    pnpm verify
    pnpm exec vitest run packages/core/test/core.spec.ts
    pnpm test:e2e
    pnpm exec playwright install --with-deps chromium
    pnpm verify:full
    node apps/runtime/src/main.ts --data-dir ./.data --label dev

pnpm verify is the definition of done for non-journey code. Run a focused test
first. Run pnpm verify:full before reporting a UI/journey change complete.

Never point e2e at a running dev node: playwright.config.ts uses its own data dir
and ports so it cannot read the wrong identity file.

## Tests

- Unit tests live at packages/*/test/**/*.spec.ts (also apps/*, packs/*,
  examples/*). Single-level globs on purpose; a nested glob runs every suite
  twice.
- Vitest environment is node, no DOM. React rendering and accessibility
  assertions go in apps/web/e2e/*.spec.ts, not in .spec.tsx.
- Fixture providers (for example CC_VOICE_FIXTURE=1) prove the wiring, not the
  provider. Live-provider checks are opt-in and recorded as such.
- Fix the cause, never the assertion. A blocked test is reported BLOCKED with the
  missing condition named, not skipped silently.

## Repository invariants

Chạy `pnpm invariants` để kiểm tra các ràng buộc tự động trong
`tools/check-invariants.mjs`. Các yêu cầu dưới đây còn bao gồm quy tắc review;
không coi checker là bằng chứng cho những điều nó không kiểm tra:

- Editing any file listed in docs/manifest.json requires updating that entry's
  bytes and sha256. The check names the stale entry.
- Every workspace package.json declares clarkcant.phase, clarkcant.status,
  clarkcant.blueprint. A stub file must say so with the marker the check expects.
- docs/conformance-traceability.md never upgrades a T-id or V-id status without
  the named test existing. “Schema exists” is not PASS.
- No credentials in tracked files. .env is gitignored; TYPESAFE_API_KEY and
  provider keys come from the environment. Never reference another repo's .env
  path in code, docs, or plans.

## Files not to touch

- Applied migrations in packages/storage/src/migrate.ts: add a new one, never
  edit. Back up with VACUUM INTO before running a migration against a DB with
  data.
- plans/reports/evidence/*.png are regenerated by the e2e suite and gitignored.
  Do not git add -f them.
- packages/pi-adapter is the only package that may import the Pi SDK.

## Git

- Conventional commits, English, lowercase sentence after the colon, scopes are
  package names: fix(conversation-client): the orb no longer ...
- No AI attribution.
- Plans and docs may commit straight to main. Code changes go through a branch
  and a PR.
- Plan directories follow plans/{date}-{issue}-{slug}/; run ak plan validate
  plans/<dir> after editing a plan.

## Language

Docs and plans are written in Vietnamese with full diacritics; code, commit
messages, identifiers and protocol/schema names are English.

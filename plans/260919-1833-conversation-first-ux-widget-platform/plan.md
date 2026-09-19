---
title: "Conversation-first UX, Orb personalization & Widget platform"
description: "Triển khai UX operating model mới: Autonomous policy, Orb cá nhân hoá, Settings mới, personal instructions, voice choice, desktop modes, JIT onboarding, widget runtime/SDK/CLI và directory."
status: pending
priority: P0
effort: "~118 agent-hours tuần tự; ~72h wall-clock với các lane song song"
branch: "main"
tags: [feature, frontend, backend, ux, widgets, voice, desktop, sdk]
blockedBy: []
blocks: []
created: 2026-09-19
updated: 2026-09-19
---

# Conversation-first UX, Orb personalization & Widget platform

## Outcome

ClarkCant giữ một mental model duy nhất: **một conversation + một Clark voice agent**. User có thể điều khiển app, model, voice, execution policy và widgets qua chat/voice hoặc Settings mà không phải học Pi/Jev/node internals.

Orb tiếp tục là signature visual bắt buộc, nhưng user được cá nhân hoá palette/effects/physics trong bounded ranges. Widget ecosystem đi từ contracts hiện có tới runtime thật, authoring CLI, conformance và directory publish flow.

## Không rebuild những gì đã có

| Seam | Đã có | Cách dùng lại |
| --- | --- | --- |
| Preferences | `packages/core/src/preferences.ts`: scope, revision, undo | Xây typed registry/API trên seam này; không tạo settings DB thứ hai |
| Motion | `packages/design-tokens`: motion + bounce + reduced variants | Chuẩn hoá primitives; không tạo easing system song song |
| Orb | WebGL shader + pointer physics + fallback + reduced motion | Mở typed personalization; không thay Orb |
| Model catalogue | Pi SDK catalogue → `GET /model` | Dùng cho picker/favorites; không hardcode providers |
| Voice | Gemini Live qua provider-neutral adapter | Mở voice capabilities/voiceName |
| Widget contracts | definition/instance/snapshot/action/semantic view | Mở detach/runtime; không tạo protocol thứ hai |
| Live ownership | lease + one live owner | Dùng cho detached windows |
| Package/install | manifest, plan digest, generations, rollback | Dùng cho marketplace |
| Needs onboarding | `packages/core/src/onboarding.ts` | Đưa lên JIT setup UI |
| Desktop security | named preload bridge + IPC allowlist | Thêm named window/widget commands |

## Facts từ codebase chốt plan

1. `apps/web/src/App.tsx` vẫn có wizard `welcome → provider → model → key`; core lại đã có needs-based onboarding.
2. `OrbOptions` đã có radius/exposure/chromatic/glow/sheen/speed/palette, nhưng spring `SPRING_STIFFNESS=90`, `SPRING_DAMPING=7.5` đang hard-code.
3. `SettingsPanel.tsx` vẫn là General/Models/Tools/Devices và lộ nhiều Pi internals.
4. `model-turn.ts` chưa có personal system-instruction seam; `RealPiAdapter` tạo `DefaultResourceLoader`, đúng boundary để đưa preference vào Pi session.
5. Voice setup chỉ có model + systemInstruction; chưa có provider capability/voiceName.
6. `run_command` và effect widget actions đang hard-wire approval flow; Autonomous default không thể chỉ là radio UI.
7. Desktop bridge chưa có window modes, resize presets, always-on-top policy hoặc widget detach.
8. `widget-sdk` mới có codec/schema; `WIDGET_RUNTIME_STATUS` vẫn là `bridge-codec-implemented-runtime-pending`.
9. Built-in catalog thiên về visualization, thiếu question/form/task/artifact/browser/computer primitives.
10. Package/install primitives đã có digest/isolation/generation/rollback; Marketplace nên dùng lại thay vì dựng installer mới.

## Quan hệ với plan Issue #17 cũ

Plan này **supersede phase pending 5–8** của `plans/260919-0526-file-attachments-voice-bar-memory`:

- shared app-control intents;
- voice/widget action parity;
- desktop compact window;
- minimal voice bar.

Phases 1–4 attachments đã done và giữ nguyên. Recent-work/memory 9–11 vẫn có thể làm, nhưng Settings integration phải theo IA mới.

---

# Stage A — preferences và execution policy

## Phase 1 — Typed preference registry & Settings API (~8h)

### Mục tiêu

Biến generic preference store hiện có thành một registry typed duy nhất cho UI/runtime. Không cho component/gateway viết arbitrary preference keys.

### Files

- new: `packages/contracts/src/preferences.ts`
- update: `packages/contracts/src/index.ts`
- new hoặc update: `packages/core/src/preference-registry.ts`
- update: `packages/core/src/preferences.ts`
- update: `apps/runtime/src/gateway.ts`
- update: `packages/conversation-client/src/api.ts`
- tests: contracts/core/runtime

### Registry keys

| Key | Scope | Shape |
| --- | --- | --- |
| `experience.theme` | global | system/light/dark |
| `experience.motion` | global | system/full/reduced |
| `experience.density` | global | comfortable/compact |
| `orb.profile` | global | preset id |
| `orb.custom` | global | bounded palette/effect/physics |
| `execution.mode` | global | autonomous/guarded/ask |
| `execution.rules` | global | bounded rules |
| `ai.modelFavorites` | global | provider/model refs |
| `ai.backgroundRouting` | global | auto/same/fast/cheap/quality |
| `ai.personalInstructions` | global | enabled + bounded text |
| `voice.provider` | node | provider id |
| `voice.voiceName` | node | voice id |
| `voice.wake` | node | enabled + detector id |
| `desktop.startMode` | node | normal/expanded/compact/orb |
| `desktop.rememberBounds` | node | boolean |

### API

- `GET /preferences` → only registered user-facing preferences.
- `PUT /preferences/:key` → validate schema + allowed scope.
- `POST /preferences/:key/undo` → existing undo primitive.
- Include `revision` and `applies` metadata: immediate / next-turn / next-session / next-voice-session / desktop-restart. `next-turn` is what personal instructions need: the text reaches the model on the next turn, which is neither "now" nor "when the session is recreated".
- No secret values in preference API.

### Done

- arbitrary unknown key returns `PREFERENCE_UNKNOWN`;
- invalid shape refused before storage;
- undo works;
- no migration if existing preferences table is sufficient;
- Settings can subscribe/refetch without knowing DB layout.

---

## Phase 2 — Execution policy resolver (~10h)

### Mục tiêu

Làm `Autonomous | Guarded | Ask every time` thành behavior thật ở runtime, không chỉ Settings UI.

### Files

- new: `packages/core/src/execution-policy.ts`
- update: `packages/core/src/index.ts`
- update: `apps/runtime/src/node-tools.ts`
- update: `apps/runtime/src/run-command.ts`
- update: `packages/core/src/widget-service.ts`
- update: install activation/proposal seam
- update: approval host-card copy/tests

### Core contract

```ts
type ExecutionMode = "autonomous" | "guarded" | "ask";

type PolicyDecision =
  | { kind: "execute"; reason: string; audit: true }
  | { kind: "ask"; reason: string; approvalSpec: ApprovalSpec }
  | { kind: "deny"; reason: string };

decideExecution({
  principal,
  explicitUserIntent,
  effectCategory,
  operationDigest,
  mode,
  configuredRules,
  hardBoundary
});
```

### Rules

- local view action never asks.
- Autonomous: explicit user intent may execute effect without second confirmation.
- Guarded: use effect category + user rules.
- Ask: existing approval path.
- Hard OAuth/TCC/browser/vendor boundaries never auto-bypassed.
- Operation digest, binding digest, stale revision, grants, credential locality, deadlines and dedup stay enforced in all modes.
- Every autonomous effect writes audit/activity evidence.
- Do not duplicate resolver logic in tools/widgets/install.

### Refactor `run_command`

Current tool always says “sau khi bạn duyệt”. Change prompt/label dynamically according to policy capability or make tool wording policy-neutral:

> Run one bounded shell command according to the user's execution policy.

Tool execute:
1. resolve cwd + guard;
2. build canonical operation;
3. call policy resolver;
4. execute / produce approval card / deny.

### Tests

Matrix: 3 modes × read/local-write/external-write/destructive × explicit/not-explicit × hard boundary.

Regression: Ask mode produces same approval digest behavior as current code.

---

# Stage B — signature UI, Settings, AI & voice preferences

## Phase 3 — Orb personalization + input/agent state (~9h)

### Mục tiêu

Giữ Orb như signature, mở personalization an toàn và standardized ambient reactions.

### Files

- update: `packages/conversation-client/src/orb.ts`
- update: `Orb.tsx`, `orb-shader.ts`
- new: `orb-profile.ts`
- new: `input-modality.ts`
- update: `Conversation.tsx`, `VoiceOverlay.tsx`, `styles.ts`
- update design token tests + Orb tests

### Orb physics

Mở additive options:

```ts
physics?: {
  stiffness?: number;       // clamp 40..180
  damping?: number;         // clamp 4..24
  wobbleGain?: number;      // clamp 0..1
  pointerResponse?: number; // clamp 0..1.5
}
```

Không đọc storage trong renderer. `resolveOrbProfile(preferences)` trả immutable resolved options.

Presets:
- Clark;
- Calm;
- Jelly;
- Glass;
- Custom.

Custom palette chỉ cho named channels đang có; không shader source.

### Important implementation detail

`Orb.tsx` hiện effect dependency chỉ theme/pointerTarget dù options được read once. Thêm stable `profileRevision/profileKey` để renderer recreate khi profile đổi, nhưng không rebuild mỗi render/keystroke.

### Root interaction state

```text
data-input-modality = pointer | keyboard | touch | voice
data-agent-state    = idle | listening | thinking | tooling | responding | success | error
```

Pointer/keyboard/touch detector ở shell root, không đặt listeners trong từng button.

### Tests

- clamp physics;
- preset deterministic;
- profile update recreates Orb exactly once;
- reduced motion overrides custom speed/physics animation;
- WebGL fallback vẫn mang selected palette hợp lý;
- pointer movement không re-render conversation.

---

## Phase 4 — Settings IA & component primitives (~10h)

### Mục tiêu

Thay General/Models/Tools/Devices bằng IA user-centric:

1. Experience
2. AI & Routing
3. Control
4. Extensions & Widgets
5. Devices & Voice
6. Developer / Advanced (progressive disclosure)

### Refactor

Tách `SettingsPanel.tsx` thành:
- `settings/SettingsPanel.tsx`
- `settings/ExperienceSettings.tsx`
- `settings/AiRoutingSettings.tsx`
- `settings/ControlSettings.tsx`
- `settings/ExtensionsSettings.tsx`
- `settings/DevicesVoiceSettings.tsx`
- `settings/DeveloperSettings.tsx`
- `settings/controls/*`

Không để file monolith tiếp tục lớn.

### Correct controls

- segmented: theme/motion/density/execution mode;
- switch: booleans;
- search-select: provider/model/voice/package;
- slider + numeric field: Orb advanced physics;
- swatch/preset cards: Orb profile;
- textarea: personal instructions / Jev instructions;
- button: one-shot action;
- details/subpanel: diagnostics/raw Pi settings.

### Experience

Orb preview là live interactive preview, nhưng chỉ một Orb renderer; không render grid nhiều WebGL canvases cùng lúc. Preset list dùng static swatch, selected preset feed preview.

### Developer tab

Move:
- node ID;
- raw Pi settings;
- Pi extension file names;
- capability refs;
- budgets/limits;
- contrast/debug specimens.

### E2E

Keyboard tab navigation, autosave, status, focus restore, narrow viewport.

---

## Phase 5 — Personal system instructions & model routing (~8h)

### Mục tiêu

Cho user thêm personal instructions mà không phá product/tool/security system prompt.

### Files

- update: `packages/pi-adapter/src/types.ts`
- update: `packages/pi-adapter/src/real.ts`
- update: `apps/runtime/src/model-turn.ts`
- update preference reader in runtime services
- Settings AI & Routing tests

### Precedence

```text
Clark/product invariants
  → security/tool/action instructions
  → user personal instructions
  → recap/context
  → current user message
```

### Pi seam

Không prepend personal text vào user prompt và không dùng `systemPromptOverride` để thay nguyên prompt.

Pi SDK hiện có `DefaultResourceLoader.extensionFactories`, và `before_agent_start` exposes mutable structured `systemPromptOptions`; docs upstream khuyến nghị sửa `sections` / `promptGuidelines` thay vì force-replace prompt. Implement một **trusted inline control extension** trong `packages/pi-adapter`:

1. `RealPiAdapterOptions` nhận callback `personalInstructions?: () => string | undefined`.
2. ResourceLoader đăng ký named inline extension `clark-personal-instructions`.
3. Mỗi `before_agent_start` đọc callback mới nhất.
4. Thêm/xoá section riêng `clark_personal_instructions` trong structured prompt options.
5. Không log nội dung, không đưa vào extension list metadata ngoài tên control extension.
6. Fake Pi seam test assert tool snippets/context sections vẫn còn và section personal có precedence đúng.

Cách này cho phép thay đổi có hiệu lực ở **turn kế tiếp** trên SDK hiện tại mà không restart session, đồng thời giữ prompt/tool assembly của Pi. Nếu pinned SDK type thực tế khác latest docs, compatibility test phải fail và phase dừng để adapt exact typed API; không fallback sang string-prefix user prompt.

Personal instructions là app preference, không sửa `SYSTEM.md` / `APPEND_SYSTEM.md` trong agent dir.

### Semantics

- max chars + normalized whitespace;
- Enabled toggle;
- Reset;
- Preview “Clark will also receive…”;
- applies from next turn once preference write is acknowledged;
- model switch/favorites continue to use existing catalogue.

### Tests

FakePiAdapter/session fixture captures system instructions at creation; assert product instruction remains and personal text follows it.

---

## Phase 6 — Voice capabilities, voice picker & preview (~8h)

### Mục tiêu

Provider-neutral voice choices; Gemini maps to actual Live speech config.

### Files

- update: `packages/voice-adapters/src/provider.ts`
- update: `protocol.ts`, `gemini-live.ts`
- update: `apps/runtime/src/voice-session.ts`
- update gateway + client API
- update Devices & Voice Settings

### Contract

```ts
type VoiceOption = {
  id: string;
  label: string;
  locale?: string;
  description?: string;
};

type VoiceCapabilities = {
  supportsVoiceSelection: boolean;
  voices: VoiceOption[];
  supportsPreview: boolean;
};
```

Provider owns options. React does not know Gemini voice names.

### Gemini

Extend setup generation config with selected `voiceName` under provider speech config. Keep current system instruction that voice is “voice, not mind”.

### API

- `GET /voice/capabilities`
- `POST /voice/preview` or host-local preview command with bounded text.
- Preview session does not append transcript/message to conversation.
- Changing voice applies next voice session.

### Tests

Wire shape, unsupported provider behavior, preview cleanup, credential never enters response.

---

# Stage C — shared controls, desktop modes, voice

## Phase 7 — Shared app-control intents + desktop window/detach (~12h)

### Mục tiêu

Click/chat/voice gọi cùng typed registry for app chrome.

### Merge/supersede

Absorb old Issue #17 phase 5–7 rather than implementing a parallel registry.

### Intent families

- settings.open / settings.close / settings.select
- model.select / model.cycle
- execution.mode.set
- voice.start / voice.end / voice.mute
- window.mode.set
- window.resizePreset / window.restore / window.focus
- widget.pin / unpin / detach / attach / focus
- marketplace.open/search/install

### Desktop named bridge

Add explicit methods only:
- `setWindowMode`
- `resizeWindowPreset`
- `restoreWindow`
- `focusWindow`
- `detachWidget`
- `attachWidget`

No `invoke(channel,...)`.

### Modes

normal / expanded / compact / orb.

Bounds live in main process. Client requests semantic mode, not arbitrary pixels by default. Advanced resize can be bounded.

### Detach

Extend surface ownership contract to include detached host surface. Same instance, same owner lease.

Detached window receives only widget host bootstrap + instance ref, not full privileged conversation context.

Close detached → release/move ownership and restore pin/inline preview.

### Tests

- same intent result from click/chat/voice source;
- desktop smoke reads actual `BrowserWindow.getBounds()`;
- detach does not duplicate owner/media;
- forged renderer cannot call arbitrary IPC.

---

## Phase 8 — Compact/orb voice modes + wake-word seam (~10h)

### Mục tiêu

Voice is same Clark, with expanded/compact/orb presentations and optional local wake.

### UI

- Expanded: current VoiceOverlay.
- Compact: state + waveform + mute/end/expand.
- Orb: signature Orb + state only; transcript on request.

Collapsing never restarts provider session.

### Wake seam

Create interface before choosing detector dependency:

```ts
interface WakeWordDetector {
  start(onWake: () => void): Promise<void>;
  stop(): Promise<void>;
  status(): WakeStatus;
}
```

Rules:
- local detector where supported;
- wake listener has explicit UI state;
- ambient audio is not sent to Gemini merely for wake detection;
- wake activation opens voice session;
- “tắt voice / về chat” calls local host intent immediately.

Package/platform spike decides actual detector. If no acceptable local detector on release platform, ship toggle unavailable with reason rather than remote always-listening fallback.

### Tests

Fixture detector + browser client; macOS smoke for lifecycle; no duplicate microphone owner.

---

# Stage D — onboarding and default agentic widgets

## Phase 9 — Conversation-first / JIT onboarding (~6h)

### Mục tiêu

Fresh user sees Orb + one CTA, then conversation. Provider/model/key asked only when needed.

### Replace

Delete web state machine provider/model/key from `App.tsx`.

First run:
1. Welcome + Orb.
2. Get Started.
3. Conversation.

### JIT setup

Use:
- readiness;
- `packages/core/src/onboarding.ts` checkpoints;
- host-owned setup/question/credential cards.

Examples:
- first real model task → model/provider setup;
- first voice → mic/credential/voice setup;
- first browser task → browser profile/OS setup.

### Tests

- no credentials required to reach conversation;
- preconfigured node asks nothing;
- missing model task creates actionable setup, not dead end;
- resume after reload.

---

## Phase 10 — Default agentic widget catalog (~9h)

### P0 definitions

- `ui.question@1`
- `ui.form@1`
- `ui.task@1`
- `ui.artifact@1`
- improved `ui.diff@1`
- `ui.browser@1`
- `ui.computer@1`

### Architecture

Create a new host/UI pack rather than stuffing every semantic widget into `data-canvas`; data-canvas stays data visualization.

Question/form supports voice semantic selection/submission.

Task morphs progress→summary in same logical component.

Artifact reuses attachments/blob refs.

Browser/computer use host-owned preview/action leases.

### Definition gates

Every widget ships fixtures:
loading, empty, live, cached/offline where relevant, error, read-only, compact/expanded.

Every widget publishes text representation + semantic action state.

### E2E journeys

- agent asks question → click answer / voice answer same result;
- form draft survives rerender;
- task Stop;
- artifact reopen;
- diff keyboard;
- browser takeover/stop.

---

# Stage E — executable widget platform

## Phase 11 — Isolated Widget SDK runtime & host (~10h)

### Mục tiêu

Remove `bridge-codec-implemented-runtime-pending`: implement actual browser runtime/MessagePort handshake.

### Files

- `packages/widget-sdk`: client runtime
- `packages/widget-host`: frame host/session
- conversation-client isolated widget renderer
- reference fixture under `examples/`

### Runtime

Implement:
- init handshake with source window + nonce + negotiated MessagePort;
- props subscribe;
- state revision updates;
- event emit;
- action invoke;
- capability request;
- host focus/resize/requestPin/requestDetach/openExternal;
- semantic publish with available actions;
- lifecycle mount/suspend/resume/dispose.

### Isolation

- opaque origin/default no same-origin;
- CSP from installed manifest;
- exact source window;
- bounded messages;
- resource budgets;
- host chrome outside frame;
- no host storage/secret/Node.

### Tests

Security + lifecycle + stale revision + forged nonce + cleanup + offscreen suspension.

---

## Phase 12 — Widget Developer CLI, dev host & conformance (~8h)

Canonical behavior: `docs/widget-development.md`.

### CLI target

```text
clark widget init
clark widget dev
clark widget test
clark widget pack
clark widget publish   # publish command may initially prepare directory submission
```

### `init`

Templates:
blank/dashboard/form/editor/media/MCP-App-adapter.

### `dev`

Standalone local isolated host:
- HMR;
- fixtures;
- 320/conversation/compact/expanded;
- dark/light;
- reduced motion;
- offline/read-only;
- semantic inspector;
- action log;
- capability simulator;
- a11y checks.

### `test`

Conformance:
- schema;
- bridge security;
- keyboard;
- reduced motion;
- text fallback;
- local/effect action;
- dedup;
- state migration;
- pin/detach;
- voice/click parity.

### `pack`

Immutable artifact + digest + manifest report + preview metadata.

Developer can use local path without directory account.

---

# Stage F — Marketplace & directory

## Phase 13 — Package Marketplace/directory (~7h)

### Mục tiêu

Discovery layer over existing package/install primitives, not a second package manager.

### Sources

First-class:
- local path for development;
- git exact ref;
- npm exact version.

Directory stores/indexes metadata and source references; artifact install still resolves exact source/version/digest.

### UI

Conversation search returns `ui.marketplace-results`.
Settings Extensions & Widgets shows:
- installed;
- updates;
- enabled state;
- package facets;
- source/version/risk;
- marketplace search.

### Risk lanes

- UI-only isolated;
- isolated + network;
- tool/service;
- native Pi extension trusted/high-risk.

### Autonomous install

Explicit “install X” can satisfy product-level consent in Autonomous mode, but still:
- resolve exact plan;
- validate digest/deps/isolation;
- audit;
- stage/healthcheck;
- rollback on failure;
- obey hard auth/platform boundary.

Do not skip install-plan integrity just because confirmation UI is skipped.

### Directory publish metadata

As defined in `docs/widget-development.md`: previews, source, license, permissions, compatibility, conformance report.

---

# Stage G — polish & release

## Phase 14 — Motion polish, accessibility, performance & release gates

### Motion pass

Build shared press/release, panel, popover and FLIP helpers. Do not `transition: all`.

Pin/detach should visually morph where geometry exists; if cross-window morph is not reliable, use deterministic fade/scale handoff without fake continuity.

### Accessibility

- keyboard-only journey;
- focus restore;
- minimum touch targets;
- screen-reader text alternatives;
- bounded live regions;
- reduced motion;
- contrast.

### Performance

- pointer Orb loop stays outside React state;
- heavy widgets lazy mount;
- offscreen suspend;
- no duplicated live subscriptions after detach;
- large table/chart bounds;
- first panel frame meaningful.

### Final commands

- `pnpm verify`
- `pnpm test:e2e`
- `pnpm verify:full`
- desktop smoke on supported macOS target

Update conformance status only with named tests/evidence.

---

# Migration ownership

Không sửa migrations đã apply.

Ưu tiên dùng existing preferences/pins/ownership tables.

Chỉ thêm migration nếu phase thật sự cần durable data mới:
- detached window presentation metadata nếu không biểu đạt được bằng pins/ownership;
- optional local directory metadata cache.

Ngay trước migration, re-read `packages/storage/src/migrate.ts` vì memory plan khác có thể thêm migration song song.

---

# Release success criteria

- [ ] Fresh install tới conversation sau một CTA; không buộc provider/model/key.
- [ ] Orb xuất hiện ở onboarding, main shell, voice và orb mode.
- [ ] User đổi được Orb preset/color/effect/physics bounded, reload vẫn giữ.
- [ ] reduced-motion thắng Orb custom animation.
- [ ] Autonomous là default behavior thật ở command/widget/install seams.
- [ ] Guarded/Ask dùng approval system hiện có và hard consent vẫn enforce.
- [ ] Personal instructions vào system/session boundary có precedence test.
- [ ] Voice picker chỉ hiện khi provider hỗ trợ; Gemini session dùng selected voice.
- [ ] Settings theo IA mới; Pi internals chuyển Advanced.
- [ ] Chat/voice/click dùng chung app-control registry.
- [ ] Desktop normal/expanded/compact/orb hoạt động bằng named IPC.
- [ ] Detach giữ same widget instance + one live owner.
- [ ] P0 agentic widget catalog có fixtures và voice semantics.
- [ ] Widget SDK browser runtime không còn pending.
- [ ] Author có thể init → dev → test → pack bằng docs/CLI.
- [ ] Package local/git/npm install được qua existing generation/rollback path.
- [ ] Directory search/publish hiển thị source/version/digest/risk đúng.
- [ ] `DESIGN.md`, `AGENTS.md`, `docs/widget-development.md` khớp code shipped.

## Red-team questions bắt buộc trước khi bắt đầu mỗi Stage

1. Feature này có đang leak Pi/Jev/node concept lên default UI không?
2. Có tạo execution path thứ hai thay vì reuse action/policy path không?
3. Có fake “Autonomous” bằng cách chỉ ẩn approval card nhưng backend vẫn waiting không?
4. Orb personalization có thể gây GPU runaway/unbounded physics/CSS injection không?
5. Personal instruction có thể override product/security/tool semantics ngoài precedence dự kiến không?
6. Voice option có đang hardcode Gemini vào component không?
7. Detached widget có tạo second live owner/subscription/media playback không?
8. Marketplace có đang bypass exact digest/generation/rollback không?
9. Widget author API có thêm quyền generic chỉ vì dev convenience không?
10. Một design target chưa implement có bị UI/docs quảng cáo như shipped không?

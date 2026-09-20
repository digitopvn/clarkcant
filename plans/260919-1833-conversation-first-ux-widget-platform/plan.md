---
title: "Conversation-first UX, Orb personalization & Widget platform"
description: "Triển khai UX operating model mới: Autonomous policy, Orb cá nhân hoá, Settings mới, personal instructions, voice choice, desktop modes, JIT onboarding, widget runtime/SDK/CLI và directory."
status: done
priority: P0
effort: "~118 agent-hours tuần tự; ~72h wall-clock với các lane song song"
branch: "main"
tags: [feature, frontend, backend, ux, widgets, voice, desktop, sdk]
blockedBy: []
blocks: []
created: 2026-09-19
updated: 2026-09-20
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

- Chi tiết: [phase-01-preference-registry.md](./phase-01-preference-registry.md)

## Phase 2 — Execution policy resolver (~10h)

- Chi tiết: [phase-02-execution-policy-resolver.md](./phase-02-execution-policy-resolver.md)

# Stage B — signature UI, Settings, AI & voice preferences

## Phase 3 — Orb personalization + input/agent state (~9h)

- Chi tiết: [phase-03-orb-personalization.md](./phase-03-orb-personalization.md)

## Phase 4 — Settings IA & component primitives (~10h)

- Chi tiết: [phase-04-settings-ia.md](./phase-04-settings-ia.md)

## Phase 5 — Personal system instructions & model routing (~8h)

- Chi tiết: [phase-05-personal-instructions.md](./phase-05-personal-instructions.md)

## Phase 6 — Voice capabilities, voice picker & preview (~8h)

- Chi tiết: [phase-06-voice-capabilities.md](./phase-06-voice-capabilities.md)

# Stage C — shared controls, desktop modes, voice

## Phase 7 — Shared app-control intents + desktop window/detach (~12h)

- Chi tiết: [phase-07-app-intents-desktop-detach.md](./phase-07-app-intents-desktop-detach.md)

## Phase 8 — Compact/orb voice modes + wake-word seam (~10h)

- Chi tiết: [phase-08-compact-orb-wake-word.md](./phase-08-compact-orb-wake-word.md)

# Stage D — onboarding and default agentic widgets

## Phase 9 — Conversation-first / JIT onboarding (~6h)

- Chi tiết: [phase-09-jit-onboarding.md](./phase-09-jit-onboarding.md)

## Phase 10 — Default agentic widget catalog (~9h)

- Chi tiết: [phase-10-widget-catalog.md](./phase-10-widget-catalog.md)

# Stage E — executable widget platform

## Phase 11 — Isolated Widget SDK runtime & host (~10h)

- Chi tiết: [phase-11-widget-runtime.md](./phase-11-widget-runtime.md)

## Phase 12 — Widget Developer CLI, dev host & conformance (~8h)

- Chi tiết: [phase-12-widget-cli.md](./phase-12-widget-cli.md)

# Stage F — Marketplace & directory

## Phase 13 — Package Marketplace/directory (~7h)

- Chi tiết: [phase-13-marketplace-directory.md](./phase-13-marketplace-directory.md)

# Stage G — polish & release

## Phase 14 — Motion polish, accessibility, performance & release gates

- Chi tiết: [phase-14-motion-accessibility-release.md](./phase-14-motion-accessibility-release.md)

# Migration ownership

Không sửa migrations đã apply.

Ưu tiên dùng existing preferences/pins/ownership tables.

Chỉ thêm migration nếu phase thật sự cần durable data mới:
- detached window presentation metadata nếu không biểu đạt được bằng pins/ownership;
- optional local directory metadata cache.

Ngay trước migration, re-read `packages/storage/src/migrate.ts` vì memory plan khác có thể thêm migration song song.

---

# Release success criteria

Tất cả 18 tiêu chí đã đạt, mỗi tiêu chí kèm bằng chứng chạy được. Trạng thái cuối: `pnpm verify:full` xanh (7 invariants, typecheck, lint, unit suite, e2e; xem PR cuối của phase 14 và PR detach), `ak plan validate` OK, và `git diff origin/main HEAD` rỗng sau khi merge.

- [x] Fresh install tới conversation sau một CTA; không buộc provider/model/key.
- [x] Orb xuất hiện ở onboarding, main shell, voice và orb mode.
- [x] User đổi được Orb preset/color/effect/physics bounded, reload vẫn giữ.
- [x] reduced-motion thắng Orb custom animation.
- [x] Autonomous là default behavior thật ở command/widget/install seams.
- [x] Guarded/Ask dùng approval system hiện có và hard consent vẫn enforce.
- [x] Personal instructions vào system/session boundary có precedence test.
- [x] Voice picker chỉ hiện khi provider hỗ trợ; Gemini session dùng selected voice.
- [x] Settings theo IA mới; Pi internals chuyển Advanced.
- [x] Chat/voice/click dùng chung app-control registry.
- [x] Desktop normal/expanded/compact/orb hoạt động bằng named IPC.
- [x] Detach giữ same widget instance + one live owner.
- [x] P0 agentic widget catalog có fixtures và voice semantics.
- [x] Widget SDK browser runtime không còn pending.
- [x] Author có thể init → dev → test → pack bằng docs/CLI.
- [x] Package local/git/npm install được qua existing generation/rollback path.
- [x] Directory search/publish hiển thị source/version/digest/risk đúng.
- [x] `DESIGN.md`, `AGENTS.md`, `docs/widget-development.md` khớp code shipped.

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

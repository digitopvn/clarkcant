# Verification — reference comparison, and the two claims that are not verified

**Date:** 2026-09-17 · **Branch:** `feat/p3-voice-gemini-live`
**Purpose:** record what a browser actually confirms, and name the two goal requirements that a browser does **not** confirm.

---

## 1. Onboarding against the reference image

Compared `plans/reports/evidence/j1-01-empty.png` with `docs/demo-ui/6A684058-13F2-48BB-BD02-A400A6609086.png` by reading both.

**Structure matches:** header with the agent name on the left and Ready plus the gear on the right; a centred orb; a large centred question as the heading; a subtitle beneath it; four chips in a row; a composer with a leading `+`, the placeholder, and a trailing send control; a footer with a hint on the left and key bindings on the right.

**Three differences, all deliberate or environmental:**

1. **Copy is Vietnamese, the reference is English.** "Bạn đang nghĩ gì?" for "What's on your mind?", and so on. Translation, not divergence.
2. **Each chip carries a second line** — `chạy trên dữ liệu mẫu` or `cần model` — where the reference chips are single-line pills. This is a deliberate addition from the goal's own requirement that a chip either works or says why it cannot, and it is the reason the chips are taller than the reference.
3. **The evidence is light-themed and the reference is dark.** The default choice is `system`, the suite runs under a light emulated OS, so the captured page resolves to light. The layout is what is being compared here; a like-for-like colour comparison would need the screenshot captured with a dark emulated OS, which was not done.

**Verdict:** the layout matches. The palette difference is an artefact of the evidence, not of the interface, and it is stated rather than left for a reviewer to discover.

## 2. The two claims that are NOT verified

These are recorded here because both are in the goal's definition of done, and calling either verified would be false.

### 2.1 Widget isolation — not satisfied

**The goal asks for:** a widget from a pack rendering in the conversation **through an isolated widget host**.

**What is true:** a widget renders inside the conversation, and its state survives a reload. Both are asserted in `apps/web/e2e/widget.spec.ts` and `apps/web/e2e/j1.spec.ts`.

**What is not true:** the widget is not isolated in the browser. Specifically:

- `grep -rn "iframe" packages/conversation-client/src` returns **nothing**. Widgets render as ordinary React elements in the page (`<figure data-widget-role="chart">` in `renderers.tsx`).
- `buildSandboxPolicy` and its `iframeSandbox` field are consumed **only by `packages/widget-host/test/seams.spec.ts`** — the policy is tested and never used. That test asserts the sandbox list omits `allow-same-origin`, which is a true statement about a policy that nothing applies.
- `packages/widget-sdk/src/index.ts` declares the browser runtime a stub: `WIDGET_RUNTIME_STATUS = "bridge-codec-implemented-runtime-pending"`, `TODO(P6)`.

**Why it cannot be closed cheaply:** real isolation needs the widget bundle to execute inside the frame with the codec and MessagePort handshake that P6 names. A React portal into an iframe would give separate layout but the same script context, and it would require `allow-same-origin`, which is precisely what the policy forbids — so a portal would make the claim worse by making it look satisfied.

### 2.2 A browser image of the diff card — not produced

**The goal asks for:** a browser image of the diff card with its actions either working or blocked with a reason.

**What is true:** the rule is implemented and unit-tested — `packages/conversation-client/test/host-cards.spec.ts` asserts that an action which cannot be performed is reported rather than offered as a dead button — and `code-diff-card` is a host-owned type in `HOST_OWNED_BLOCK_TYPES`, rendered in `blocks.tsx`.

**What is not true:** nothing in the application **builds** a `code-diff-card`. A grep across `packages/core`, `packages/conversation-client` and `packages/data-canvas` finds the schema and the renderer and no producer. The model cannot build one either, by design — that is the point of the gate in PR #6. So the browser image the contract asks for is not producible without adding a host path that emits a diff card, which is task/approval-flow work.

## 3. What is verified

| Claim | Evidence |
| --- | --- |
| A card renders in the conversation and its data survives a reload | `j1.spec.ts`, `widget.spec.ts`, `j1-04-pinned.png`, `j1-05-after-reload.png` |
| Light, dark and system themes change the surface, and the choice survives a reload | `appearance.spec.ts`, `theme-01..03.png` |
| Settings is a modal with four tabs showing different content; Escape closes it and focus returns to the gear | `appearance.spec.ts`, `settings-01..02.png` |
| A model-supplied host-owned block cannot reach the timeline | `apps/runtime/test/view-tool.spec.ts`, conductor tests, `contracts.spec.ts` |
| The provider credential never appears in a message body | `packages/voice-adapters/test/gemini-live.spec.ts` |
| Audio leaves the browser, returns, plays, pauses and is recorded | `apps/web/e2e/voice.spec.ts` (46 frames out, 25 back, transcript recorded, survives reload) |

## 4. Unresolved

1. **Widget isolation (§2.1)** is the one place where the goal's wording and the code disagree. It needs either P6 work or a decision to change the requirement.
2. **The diff card's browser image (§2.2)** needs a host path that emits one.
3. The onboarding evidence was not captured in dark, so the comparison in §1 is structural rather than pixel-level.

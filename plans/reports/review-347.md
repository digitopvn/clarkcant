# Review: PR #347 (issue #298, Theme Platform M3 "appearance depth")

- Head: `ff52a93d` on `feat/298-appearance-depth`, base `a187a960`. 80 files, +4608/-420 (the count was checked against the GitHub file list).
- Method: read-only. I read the code from `D:\wt298` and cross-checked the changed-file list with the GitHub API.
- Tests: none ran locally. The Bash tool fails with `ENAMETOOLONG` and this agent has no PowerShell tool.
- CI on `ff52a93d` when I checked:
  - Passed: verify (ubuntu, node 22.19 and node 24), desktop smoke, service container and secret scans.
  - Still running: verify on windows and macos, and the E2E browser suite.

## Verdict: NOT READY

The CSS-injection surface is clean. Every value a theme supplies is a closed name or a bounded finite number, and the host writes all of the CSS. The page and the node both validate and both run the same audit, and Clark Default stays byte-identical.

One invariant is still breakable by a document that passes every check: a theme can hide the Orb (B1). The protected audit also leaves real gaps for status colours and effects (S1 to S3). Several claims in the PR body and in DESIGN.md go further than the code does (S3, S6).

---

## Blockers

### B1. A theme's Orb palette can make the Orb invisible, and nothing audits it

**Where**
- `packages/contracts/src/themes.ts:420-429` (`themeOrbSchema.palette` accepts any 0-1 triple on every channel).
- `packages/conversation-client/src/orb-profile.ts:293,313` (the theme palette is laid over the preset).
- `packages/design-tokens/src/protected.ts` (has no Orb check).
- `packages/conversation-client/src/orb-shader.ts:294` (`body = u_canvas + u_shellEdge * …`).
- `orb-profile.ts:396-406` (the still fallback gradient).

**Failure scenario.** A package ships a theme with a valid `appearanceApi` and `orb: { profile: "clark", palette: { glowColor: [0,0,0], highlight: [0,0,0], shellInner: [0,0,0], shellMid: [0,0,0], shellEdge: [0,0,0], sheenColor: [0,0,0], colorA: [0,0,0], colorB: [0,0,0], colorC: [0,0,0], colorD: [0,0,0] } }`.
- The contract accepts it and both audits pass it, so the node lists the theme and a person can choose it.
- In the dark scheme the shader body becomes exactly `u_canvas`, which `Orb.tsx:154-158` sets from `--cc-canvas`. The interior adds zero light, so the Orb disappears into the page.
- Without WebGL, the fallback is a black disc on `#111317`.

This breaks DESIGN §1.7, which says the Orb is mandatory identity. It also breaks the review rule that a theme must never hide the Orb identity. It lands on every person who has never chosen an Orb, which is the default state.

**Fix**
1. Drop `canvas` from what a theme palette may set. `Orb.tsx` overrides it anyway, so accepting it only misleads.
2. Add an `orb-visible` check to `auditProtected`, run in both schemes. Convert each channel from linear RGB to sRGB. Require the brightest of `shellEdge`, `glowColor` and `colorA`-`colorD` to be at least N ΔE (OKLab) from the scheme's `canvas`, with N set under the six presets, and refuse with `THEME_PROTECTED`.
3. Add a `blackout` hostile fixture and a unit test. Word the new check in VI and EN in `protectedLines`.

---

## Should-fix

### S1. The `surface-readable` check measures only the three text tiers, not status, accent or focus colours, and ignores backdrops

**Where**
- `packages/design-tokens/src/protected.ts:131-143` (the loop covers only `text`, `textMuted` and `textTertiary` on `card` and `elevated`).
- `identity.ts:166-171`.

**Failure scenario.** A theme has `danger` on `card` at 4.6:1 in the dark scheme, which passes the contrast audit, and `surface: { kind: "grain", intensity: 1 }`.
- Grain composites the card 10% toward `--cc-text`. That lifts a dark card toward light and pushes the danger text on host cards below 4.5:1: the "Từ chối" (Deny) label, an error line, a failed step mark.
- The focus ring (3:1 non-text) on a finished card is not re-measured either.
- `soft-glow` tints the card toward the accent, which erodes accent-on-card contrast in the same way.

None of these is caught.

**Fix.** In the effect branch, loop over `text`, `textMuted`, `textTertiary`, `accent`, `success`, `warning` and `danger` at `AA_NORMAL_TEXT`, and over `focus` at `AA_NON_TEXT`. Add a unit case with danger at about 4.6 plus grain.

### S2. The glass effect's worst case is modelled as "the card blended toward canvas", but glass shows whatever lies behind the element, including the Orb behind the composer

**Where**
- `identity.ts:167,180-181`.
- `protected.ts:135`.
- `composer.ts:198-202` (the composer gets `--cc-surface-fill` and `backdrop-filter`).
- `composer.ts:337-379` (the Orb stage sits behind the composer).
- `cards.ts:15-19`.

**Failure scenario.** With `surface: glass, intensity: 1`, the composer fill is 65% card over whatever is behind it. The docked Orb sits directly behind the composer, and with plasma or glass presets it is bright at 0.5 opacity. The placeholder (`textTertiary`) and typed text then sit on a blurred bright Orb, not on the "card + 35% canvas" colour the audit computed.

Approval cards over the accent-lit backdrop (see S4) show the same effect in a milder form.

**Fix**, either option:
- (a) Keep glass opaque on the composer and on `[data-owner="host"]` cards, with blur and tint only. For example, set `.cc-card[data-owner="host"], .cc-composer { background-color: var(--cc-card) }` under the fill, or give those elements a separate variable.
- (b) Audit glass against both extremes: composite over `#000000` and over `#FFFFFF`, plus the scheme's `accent`, rather than over `canvas`.

Option (a) also keeps host cards unambiguous (see S3).

### S3. The claim that no recipe or effect reaches host-owned cards is not true, and the test that backs it only proves the claim for one rule

**Where**
- `packages/conversation-client/src/styles/cards.ts:12-29`.
- `packages/conversation-client/test/styles.spec.ts:164-179,190-192`.
- The PR body, under "Components".

**What the code does.** `.cc-card` reads `--cc-surface-fill`, `--cc-surface-image`, `--cc-surface-filter` and `--cc-card-shadow`. The `[data-owner="host"]` override restores only `border-color`. So glass translucency, grain and paper textures, soft glow, hard offset shadows and the backdrop blur all reach the approval, credential and connection cards.

**Why the test misses it.** The protected-rules test filters rules whose selector contains `[data-owner="host"]`. It never looks at the generic `.cc-card` rule, which is where the variables reach host cards. The test is effectively decoration for the host-card half of its title.

**Failure scenario.** Under `flatline` (glass at 1), the approval card is translucent and blurred like every widget card. The only difference left is the border colour. A future recipe variable added to `.cc-card` would pass the test.

**Fix**
- Either extend the host-card override to reset the surface variables, for example `.cc-card[data-owner="host"] { background: var(--cc-card); background-image: none; backdrop-filter: none; box-shadow: none }`,
- or narrow the claim in the PR body, DESIGN §11.1 and `cards.ts:24-28` to the edge only.

Either way, make the test compute the effective declarations for a `[data-owner="host"]` element: every rule whose selector matches `.cc-card` or `.cc-card[data-owner="host"]`.

### S4. The pointer-lit backdrop layer draws the theme's pattern at a fixed 55% accent, ignoring the theme's intensity

**Where**
- `packages/conversation-client/src/styles/base.ts:50-53`.
- `identity.ts:397` (the pattern rule also targets `::after`).

**Failure scenario.** A theme sets `backdrop: { kind: "scanlines", intensity: 0.2, scale: 8 }`.
- The base layer is faint.
- Under the pointer, the lit layer draws 1px accent lines every 2px at 55% alpha in a 190px circle. That is a dense, high-contrast hatch behind whatever text the pointer is over.
- `hard-grid` at scale 8 behaves the same way.

Neither the contrast audit nor the protected audit measures it. Clark's sparse 22px dot grid hid the problem.

**Fix**
- Scale the lit colour with `--cc-backdrop-alpha`, for example `color-mix(in srgb, var(--cc-accent) calc(var(--cc-backdrop-alpha) * 2), transparent)` with a cap,
- or keep the lit layer on the dot-grid pattern only: do not emit `.cc-dot-grid::after` in `identityStylesheet`.

Include the backdrop worst case (text tiers over `canvas` with the pattern colour at its alpha) in `surface-readable`.

### S5. Appearance sentence matching claims requests for work, and third-party theme names can steer it

**Where**
- `packages/core/src/app-intents.ts:520-539` (`make` is a verb).
- `app-intents.ts:595-604` (vocabulary includes `make`, `a`, `for`, `me`).
- `app-intents.ts:656-664`.
- `apps/runtime/src/application/appearance-intents.ts:31-40`.

**Failure scenario 1: requests for work.** "make a dark theme" or "make me a light theme please" is someone asking Clark to build a theme (#300 Theme Lab is exactly this). Every word is in the vocabulary, so the node answers `appearance.set-color-scheme` dark, flips the scheme, and the message never reaches the agent.

**Failure scenario 2: theme names.** An installed package theme whose display name or id is "Dark", "Light", "System" or "Theme" becomes a `ThemeTarget`. `findThemeTarget` wins before `colorSchemeOf`, so "switch to dark mode" switches to that package's theme instead of the scheme. The display name is package-controlled text and only needs one character.

**Fix**
- Remove `make` (and `go`) from `APPEARANCE_VERBS`, or require a scheme sentence to contain `mode`, `scheme`, `giao diện` or `chế độ` together with switch, change, turn, set or use.
- In `themeTargets`, drop any phrase whose words are all in `APPEARANCE_VOCABULARY`, or at least the scheme words. When both a target and a scheme word match, prefer the scheme unless the target phrase has a word outside the vocabulary.
- Add core tests for "make a dark theme" (expect none) and for a theme named "Dark" (expect the scheme).

### S6. "Reduced motion wins" only holds for the OS setting, while DESIGN §11.1 now claims it in general

**Where**
- `DESIGN.md:1106` (and the paired line in `DESIGN.vi.md`).
- `packages/conversation-client/src/styles/panels.ts:531-548`.
- `packages/design-tokens/src/css.ts:118-125`.
- `packages/conversation-client/src/dot-grid.tsx:31-37`.

**Failure scenario.** A person picks Settings, then Motion, then "Giảm" (Reduced), with the OS setting off.
- The Orb stops, because `use-orb-profile.ts:57` reads `experience.motion`.
- Everything else keeps moving: every `--cc-motion-*` token keeps the theme's speed and `steps()` easing, `cc-enter` still bounces, the composer glow keeps orbiting, and the backdrop pointer light still follows the cursor.

DESIGN §11.1 says "reduced motion (every duration none, the backdrop's pointer light off, the Orb still)", and §1.7:139 says the stored preference is enough on its own. The UX audit already recorded this as F-01. This PR adds more theme-controlled motion and documents the stronger claim.

**Fix, preferred.** Set `data-cc-reduced-motion="true"` on `<html>` when `experience.motion === "reduced"`. The scoped token block already exists in `css.ts:123`. Then extend the `panels.ts` block to also match `:root[data-cc-reduced-motion="true"]`, including the `animation: none` rules and `.cc-dot-grid::after { display: none }`.

**Fix, minimum.** Scope the DESIGN EN/VI text to "the operating system's reduced-motion setting".

### S7. Glass puts `backdrop-filter` on every card, with a per-element cost that grows with the transcript

**Where:** `cards.ts:18-19`, `composer.ts:201-202`, `identity.ts:181`.

**Failure scenario, performance.** A long conversation with dozens of `.cc-card` elements (tool results, tables, host cards) under glass at intensity 1 means a `blur(16px) saturate(1.2)` backdrop filter on each card. Every scroll frame recomposites each card's backdrop. On integrated GPUs, and on Linux/Omarchy with software compositing, this causes visible scroll jank. The effect is bounded per element but not in count.

**Failure scenario, latent layout.** `backdrop-filter` makes each card a containing block for `position: fixed` descendants. Any fixed popover rendered inside a card, now or in a future widget, would be clipped by the card's `overflow: hidden`. Nothing in the repo uses portals.

**Fix.** Limit glass blur to the composer and modal, and give transcript cards the tint only. Alternatively, cap blur at about 8px and add `contain: paint`. Say in the docs that glass does not blur transcript cards.

### S8. Official docs follow-up is missing

**Where.** AGENTS.md, "Before completion": user-visible behaviour, new public contract surface and machine-readable codes all changed:
- appearance API 2 and its identity fields;
- the `THEME_PROTECTED` code and `protected[]` in `GET /themes`, `GET /appearance` and the `PUT /preferences` 409;
- the four appearance intents in `control_app` and `POST /app-intents`.

**Gap.** `digitopvn/clarkcant-web` has only #43 (M2, closed). The PR body lists no docs PR and no fallback issue.

**Fix.** Open a clarkcant-web PR in EN and VI covering theme authoring for v2, the new refusal code, and the intents. If that is blocked, open an `ai-handle` issue there that links #298 and #347.

---

## Nits

- **N1. The agent's theme refusal is always Vietnamese.** `apps/runtime/src/node-tools.ts:550-553` calls `checkThemeChoice(…, "vi")` and uses `describeAppIntent(intent)` with the default locale, so an English-UI person's agent gets and relays VI refusals and read-backs. Use `preferredAppIntentLocale({ db, now, … }, deps.principalId)`. The rest of `control_app` shares this pre-existing pattern, so fix it here for the new kinds at least.
- **N2. A raw English node message can reach a Vietnamese reader.** In `packages/conversation-client/src/appearance-actions.ts:58-59`, a non-audit 409 (`THEME_NOT_INSTALLED`, `THEME_INVALID` or `THEME_UNAVAILABLE`, for example after an uninstall between decision and write) is shown as `themeWriteFailed` with `cause.reason`. That is the node's English sentence, including the raw `package:…#…` ref. Map it through `APPEARANCE_FALLBACK_KEYS` when `cause.code` is a `THEME_*` fallback code.
- **N3. An unknown fallback code renders a missing key.** `ThemeSettings.tsx:287` and `appearance-actions.ts:68` call `t(APPEARANCE_FALLBACK_KEYS[code])` with no default. A newer node on a distributed setup that sends an unknown code would hit it. Add a generic fallback key.
- **N4. The terminal and the CSS disagree on Clark's mono stack.** `terminal-card.tsx:57` falls back to `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`, while Clark's `--cc-font-mono` fallback (`identity.ts:47`, `cards.ts:274`) has no `Consolas`. On Windows, Clark Default's terminal and code blocks can therefore render in different faces. Import `monoFontStack("clark")` instead of a second literal.
- **N5. Audit events record the decision, not the write.** `apps/runtime/src/app-intents.ts:305` records an `app.intent` audit event before the page's `PUT /preferences` runs, so a refused write (409) still has an event that reads as done. This pre-existing pattern (also `orb.select`) now applies to theme changes. Consider recording from the preference write path, or marking the event as "decided".
- **N6. A registry read on every theme write.** `readThemeRegistry` re-reads every installed package and re-runs both audits on each theme write (`routes/preferences.ts:174`) and each theme intent. This is fine at the current scale. Note it for #300, when the Theme Lab writes repeatedly.
- **N7. The injection test could cover more.** `identity-protected.spec.ts:73` forbids `[;{}<>@\\]`, `url(` and friends in values. Also assert that no value contains `!important` or `/*`, and that every `var(--cc-…)` reference names a known token, so a future template cannot chain into an attacker-influenced custom property.

---

## Verified as correct (for risk calibration)

**CSS injection.**
- Font profiles, recipes and effect kinds are `z.enum`. Numbers are bounded `z.number` or `z.int`; zod 4 rejects NaN and ±Infinity, and JSON cannot carry them.
- `px()`, `percent()` and `remLength()` round away exponent forms.
- Display name and description never reach CSS.
- The only selectors identity writes are host literals (`:root, [data-cc-theme]` and `.cc-dot-grid, .cc-dot-grid::after`).
- The snapshot is re-parsed by `appearanceSnapshotSchema`.

**Validation runs on both sides.**
- The node runs `themeDrawProblem` in `readThemeRegistry`, and `PUT /preferences` refuses with 409 and `protected[]`.
- The page runs `checkThemeDocument`, `themeDrawProblem` and the snapshot parse in `applyAppearance`.
- The cached `cc.appearance` value is re-validated before use.

**Scheme coverage.** Both audits run in both schemes (`auditProtectedSchemes`, `auditThemeDocument`).

**Reduced motion (OS setting).**
- `motionReduced` is host-owned.
- The `@media` block comes last and matches the scheme block's specificity.
- The Orb zeroes speed, wobble and pointer response.

**Orb precedence.** An explicit `orb.profile` wins, including an unparseable one (read as a choice of Clark), and a theme can never select `custom`.

**Compatibility.** A v1 document (`{min:1,max:1}`) still draws, identity fields with `min` 1 are refused, and `APPEARANCE_API_OLDEST` gives a range.

**Protected UI mechanics.**
- Focus rings all use `var(--cc-focus)`.
- `.cc-action:disabled` drops the recipe shadow.
- Stop (`.cc-icon-btn[data-stop]`) reads no recipe variable.
- The host-card border colour is restored.

**One path for every surface.** Text, voice, click (`POST /app-intents`) and `control_app` all go through `decideAppIntent` or `checkThemeChoice`. The page stores the choice through the same `writePreference("experience.themeRef")` as the picker.

**Machine surfaces.** They could already write `experience.themeRef` through `PUT /preferences` (M2). The PR adds no new privileged path, and a theme change is a reversible preference with no approval semantics.

**Desktop.** The generated token sheet is locked by `apps/desktop/test/appearance-tokens.spec.ts`, and CSP `style-src 'self'` allows the linked file.

## Unresolved questions

1. For B1 and S2, should theme Orb palettes be limited to hue and tint (for example an offset in OKLCH) rather than absolute channel values? That decision belongs to the product owner.
2. Is `PUT /preferences` meant to stay writable from MCP/relay for every key, including the `execution.*` policy keys? This is pre-existing and outside this PR, but the appearance intents make that surface more visible.

Sources: [issue #298](https://github.com/digitopvn/clarkcant/issues/298), [clarkcant-web PR #43](https://github.com/digitopvn/clarkcant-web/pull/43)

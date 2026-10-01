Addresses #298.

Theme Platform M3 (epic #201; builds on #304 and #305). A theme can now set the rest of its look: font profile, border, shadow, motion, icon stroke, field radius, a recipe per component (button, card, input, modal, badge, composer), bounded backdrop and surface effects, and a default Orb. Every value is a closed name or a bounded number, and the host writes all of the CSS. The same decision is reached by text, voice, click and the agent through four appearance intents.

## What changed

**Contract** (`packages/contracts/src/themes.ts`)
- Appearance API is now 2, and the node accepts documents declaring 1–2.
- The identity fields are strict objects with closed vocabularies and bounds.
- A document that uses them while declaring `appearanceApi.min` 1 is refused.
- Token contract 2 adds an `identity` group to the snapshot.

**Compiler** (`packages/design-tokens/src/identity.ts`)
- Recipes and effects are turned into host-written declarations under host-owned variable names.
- Clark Default writes no identity variables, and its `themeStylesheet()` output is byte-identical: the golden test is unchanged and the fixture was not regenerated.

**Protected audit** (`packages/design-tokens/src/protected.ts`), run in both schemes. It checks that:
- danger, warning, success and the accent stay distinct;
- each status stays distinct from the text colour;
- the focus ring is distinct from the edges;
- disabled text is distinct from enabled text;
- the edge that frames the host's cards is visible on a card and on the page;
- text, status colours, the accent and the focus ring stay readable, at the contrast audit's own minimums, on every surface an effect finishes. That covers cards and the composer, the modal over both the darkest and the brightest page its scrim can cover, and the page under the backdrop and its pointer light;
- the Orb's light stays visible against the page (`orb-visible`).

`themeDrawProblem` is the single decision used by the node's listing, its refusal of a choice (409 `THEME_PROTECTED`), and the page. Settings shows each failure as a sentence in VI or EN, with no codes.

**Components** (`packages/conversation-client/src/styles/*`, `terminal-card.tsx`)
- Every identity variable is read with Clark's own value as the fallback, and a test holds each fallback to Clark's value.
- Focus rings, disabled controls, status colours and host-owned cards (`[data-owner="host"]`) are drawn by rules that no recipe or effect variable reaches. A host card resets the surface variables, so it keeps its edge and its plain card surface, with no glass, texture, glow or shadow.
- Glass is an opaque tint on cards and the composer. Only the modal is translucent, and it is blurred by at most 12px.
- The backdrop's pointer light scales with the backdrop's intensity and never exceeds Clark's own strength (55%).
- The terminal follows the theme's mono profile and colours.

**Orb**
- A theme's Orb applies only while `orb.profile` has never been stored. An explicit choice wins, including Clark's own Orb.
- A theme's Orb palette may set every channel except `canvas`, which is the page the Orb sits on. A palette dark enough to vanish into the page is refused by `orb-visible`.
- Reduced motion zeroes speed, wobble and pointer response in every case.
- Reduced motion from Settings (Motion, then Reduced) now does what the operating system's setting does: every duration is none, nothing loops and the pointer light is off. The page marks `body[data-cc-reduced-motion]`, and each reduced-motion rule has a twin under that mark.

**Intents**
- The new intents are `appearance.set-theme`, `appearance.set-color-scheme`, `appearance.reset` and `appearance.open-theme-gallery`.
- Typed text (`routes/conversations.ts`), voice (`voice-bootstrap`), click (`POST /app-intents`) and the agent's `control_app` decide through `decideAppIntent`. The node checks the theme against its registry.
- The page stores the choice through the picker's own `PUT /preferences/experience.themeRef`, so Jev/policy applies unchanged and no confirmation is added.
- `open-theme-gallery` opens the existing Theme section in Settings. The Theme Lab belongs to #300.

**Desktop**
- `apps/desktop/src/appearance-tokens.css` is generated from design-tokens by `tools/desktop-appearance-tokens.ts`, and `shell.css` reads the same `--cc-*` tokens.
- A test keeps the generated sheet in step. Every window mode renders the same web client, so there is no second theme system.

**Docs (EN/VI)**
- `DESIGN.md` §11.1.
- `docs/open-interfaces.md`: `THEME_PROTECTED`, the v2 fields and the appearance intents.
- `docs/widget-development.md`: how the node reads a theme facet.
- `docs/conformance-traceability.md`: T73 evidence.

**Visible changes to Clark Default:**
- An approval card's Approve button is now filled with the accent (`data-emphasis="primary"`). Deny stays Clark's plain button beside it. Before, the two were drawn alike.
- Under reduced motion, the dot-grid light that follows the pointer is now hidden (`panels.ts`).
- With Settings set to Reduced and the operating system not, Clark's own animations (durations, the composer glow, the thinking dots, the caret, running tool marks) now stop, as they already did under the operating system's setting.
- The terminal's fallback font list is now Clark's CSS mono stack, so it no longer names Consolas explicitly. Browsers on Windows resolve the generic `monospace` to their default face.

Full-motion Clark is otherwise unchanged: the token sheet is byte-identical, and the lit layer's strength falls back to Clark's 55%.

## Acceptance criteria and evidence

| Criterion | Evidence |
| --- | --- |
| Theme applies consistently to web and desktop | E2E `a recipe-and-effect theme reaches the page…` checks that the accent, button shadow, composer line, surface image, backdrop and Orb all change. `apps/desktop/test/appearance-tokens.spec.ts` checks that the shell page's tokens are exactly the compiled Clark Default sheet, linked before `shell.css`, and that `shell.css` defines no colour, radius or custom property of its own and names only tokens the compiler writes. |
| Explicit user overrides beat theme defaults | `orb-theme-default.spec.ts` (`loses to the person's own choice, colours and all`; an unparseable stored value counts as a choice of Clark). The same E2E stores Orb `calm` under the depth theme, reloads, and the Orb stays `calm`. |
| Reduced motion always wins | `orb-theme-default.spec.ts` › reduced motion; `identity-protected.spec.ts` (`…keeps reduced motion at none`). E2E `reduced motion stills…` checks that motion tokens are 0ms, the Orb reports `data-orb-motion="reduced"` under the theme's plasma, the backdrop light has `display: none`, and no animation loops. The same holds when only Settings says Reduced: a second E2E stores `experience.motion` "reduced" with the operating system at no-preference and checks the body mark, 0ms tokens, the reduced Orb, the hidden pointer light and no loop. `styles.spec.ts` checks that every reduced-motion rule has its twin under the mark. |
| A theme cannot hide or spoof approval, credential or trust chrome | Contract refuses selectors, CSS, markup, unknown recipes and components, and out-of-range parameters (`packages/contracts/test/themes.spec.ts`). `styles.spec.ts` checks that no recipe or effect variable reaches a protected rule (focus ring, disabled state, provenance, host-owned cards). It also resolves every rule a host card gets, `.cc-card` included, and checks that no theme surface, texture, blur or shadow survives. E2E hostile theme: under `flatline` (every card flat and edgeless, with glass), the approval card keeps a ≥1px `--cc-border` edge on all four sides, has the plain `--cc-card` fill with no image, blur or shadow, and both buttons stay visible. |
| Protected interaction, status and focus semantics remain visible | `identity-protected.spec.ts` › the protected audit (danger equal to warning, focus in the edge colour, disabled reading as enabled, an edge lost into the card or page, text on a finished surface, a status colour or focus ring worn down by an effect, a translucent modal over a bright page, a dense lit backdrop, an Orb that vanishes). E2E: `blackout` (an all-black Orb palette) is refused with `THEME_PROTECTED` and `orb-visible`, and Settings words it as a sentence about the Orb. `theme-contrast-lines.spec.ts` (VI and EN sentences, no codes). E2E: `camouflage` is refused with `THEME_PROTECTED` and listed in Settings with its sentences. Under `flatline`, the focus ring on Approve is ≥2px in `--cc-focus`, and Stop is visible, named, ≥24px wide and fully opaque. |
| Keyboard-only flows work; narrow and normal widths usable | E2E `a typed sentence and the keyboard alone…` at 390px opens the gallery by a sentence with focus on the chosen theme, reaches Clark with Shift+Tab (visible ring), and chooses it with Enter. Overflow is 0 for every logged shot and state at 1280 and 390: 14 in `appearance-depth.spec.ts` and 8 in `themes.spec.ts`. |
| Text, voice and click hit the same code | Runtime `app-intents-appearance.spec.ts`: typed and voice sentences decide identically; a click on `POST /app-intents` equals the typed sentence; an undrawable theme is refused with the available list. Client `app-intents-appearance.spec.ts`: typed and agent decisions make the same host call, and the picker and the intent share `client.writePreference("experience.themeRef", …)`. E2E: a typed sentence changes the theme and the stored preference. |

**Clark Default pixels.** Before/after screenshots under reduced motion: the four conversation shots (1280 and 390, dark and light) are byte-identical. The Settings shots differ only in the dot grid under the pointer (at most 449 px, inside 1079,9–1279,208), which is the hidden pointer light above. That comparison was made before the review round and was not repeated. The review-round Clark Default screenshots (1280 and 390, dark and light) were inspected by eye, and the golden test still holds the token sheet byte-identical.

## Mutation checks

Each mutation was applied alone and run against its focused tests, then the original bytes were restored (checked by SHA-256).

| Mutation | Result | Caught by |
| --- | --- | --- |
| Protected audit skipped in `themeDrawProblem` | killed (3 failed) | `identity-protected.spec.ts`, `theme-contrast-lines.spec.ts`, `e2e-fixture-digests.spec.ts` |
| Theme Orb outranks the person's stored choice | killed (2) | `orb-theme-default.spec.ts` |
| Reduced motion keeps the Orb's speed | killed (1) | `orb-theme-default.spec.ts` › reduced motion |
| Reduced-motion tokens follow the theme's motion | killed (1) | `identity-protected.spec.ts` |
| Host card edge reads `--cc-card-edge` | killed (2) | `styles.spec.ts` (protected rules; host cards keep `--cc-border`) |
| Focus ring reads `--cc-button-edge` | killed (2) | `styles.spec.ts` (fallback check; protected rules) |
| Identity fields allowed on appearance API 1 | killed (1) | `contracts/test/themes.spec.ts` |
| `recipes` accepts unknown keys | killed (2) | `contracts/test/themes.spec.ts` (selectors/CSS; unknown component) |
| Effect intensity unbounded | killed (1) | `contracts/test/themes.spec.ts` (bounds) |
| Client sends `set-theme` to another host method | killed (3) | `conversation-client/test/app-intents-appearance.spec.ts` |
| Node accepts a theme its registry cannot draw | killed (2) | `apps/runtime/test/app-intents-appearance.spec.ts` (unit and route) |

11 of 11 were killed; none survived.

The review round added guards, and each was mutated the same way: an exact source replacement, its focused vitest files run, and the original bytes restored and checked by SHA-256.

| Mutation | Result | Caught by |
| --- | --- | --- |
| Orb visibility check skipped | killed (2) | `identity-protected.spec.ts`, `e2e-fixture-digests.spec.ts` |
| Theme Orb palette may set `canvas` | killed (1) | `identity-protected.spec.ts` |
| Finished surfaces measure only the text tiers | killed (1) | `identity-protected.spec.ts` (status, accent, focus) |
| Backdrop not measured | killed (1) | `identity-protected.spec.ts` (backdrop and pointer light) |
| Modal glass measured over the page colour only | killed (1) | `identity-protected.spec.ts` (modal over the brightest page) |
| Pointer light at full strength whatever the backdrop | killed (1) | `identity-protected.spec.ts` |
| Lit layer ignores `--cc-backdrop-lit` | killed (1) | `styles.spec.ts` |
| Host cards keep the theme surface | killed (1) | `styles.spec.ts` |
| Cards blurred under glass | killed (2) | `styles.spec.ts` |
| In-app Reduced does not mark the page | killed (1) | `orb-theme-default.spec.ts` |
| In-app Reduced keeps the pointer light | killed (1) | `styles.spec.ts` |
| "make" is an appearance verb again | killed (1) | `core/test/app-intents.spec.ts` |
| A theme named with scheme words becomes a target | killed (1) | `core/test/app-intents.spec.ts` |
| Agent refusal always Vietnamese | killed (1) | `control-app-tool.spec.ts` |
| Node write refusal shown as the node's English sentence | killed (1) | `appearance-actions.spec.ts` |
| Unknown fallback code has no sentence | killed (1) | `appearance-actions.spec.ts` |

16 of 16 were killed; none survived.

The host-button fix was mutated the same way.

| Mutation | Result | Caught by |
| --- | --- | --- |
| Host button reset removed | killed | `styles.spec.ts` |
| Host buttons drawn transparent | killed | `styles.spec.ts` |
| Host buttons keep the theme's shadow | killed | `styles.spec.ts` |
| Primary emphasis takes the recipe fill | killed (2) | `styles.spec.ts` |
| Stop reads `--cc-button-bg` | killed | `styles.spec.ts` |
| Stop given a shadow | killed | `styles.spec.ts` |

6 of 6 were killed; none survived. Two more mutations were run against the browser test `a theme's button recipe never reaches the host's answers or Stop`, again with the original bytes restored and checked by SHA-256:

| Mutation | Result | First failing check |
| --- | --- | --- |
| Approve drawn as a plain button (no primary emphasis) | killed | `flatline dark Approve` |
| Host button reset removed | killed | `flatline dark Deny` |

## Verification

All of the following ran on this branch after rebasing onto `main` at #344:

- `corepack pnpm verify`: invariants (12/12), typecheck (`tsconfig.json`, `tsconfig.web.json`), lint and vitest all pass (345 files; 4379 tests passed, 32 skipped).
  - The verify run shown in the footer was repeated on the final head, after a test-only change that adds provenance rules to the protected-rules check.
- Full Playwright suite (`pnpm run test:e2e`, which is the E2E half of `verify:full`): 271 passed, 3 skipped, 0 failed, 0 flaky.
  - It ran on Windows at ports 9676/5073/9678, on a tree that differs from the final head only in that one unit test and the plan's status lines.
- Focused E2E runs: `appearance-depth.spec.ts` (4 tests) and `themes.spec.ts` (1 test) both pass. Every logged screenshot and state has 0 horizontal overflow at 1280 and 390, 12 entries in all.
- Desktop smoke (`electron . --smoke-test`): 22/22 checks pass, loading `shell.html` with the generated token sheet, in normal, compact, pinned and expanded modes.
- `ak plan validate plans/260930-0298-appearance-depth`: OK.

After the review round, on head `e216e7cd`:
- `corepack pnpm verify`: invariants (12/12), typecheck (both configs), lint and vitest all pass (349 files passed, 1 skipped; 4481 tests passed, 32 skipped).
- `corepack pnpm invariants`: all 12 checks pass. `docs/manifest.json` was refreshed for the changed docs.
- Focused E2E: `appearance-depth.spec.ts` (5 tests) and `themes.spec.ts` (1 test) pass, 6 of 6, on Windows at ports 9676/5073/9678. The E2E ran on the working tree just before the commits. The commits hold exactly that tree: afterwards, the only untracked paths are local evidence. All 22 overflow checks are 0.
- The full Playwright suite was not re-run after the review round.
- Screenshots inspected by eye: Clark Default, depth and flatline at 1280 and 390 in dark and light, the flatline approval card up close, and Settings listing the refused `camouflage` and `blackout` themes. The screenshot helper now waits for the Orb to settle after a resize. Before that change, the 390 dark Clark Default shot caught the Orb mid-glide, off-screen.

After the host-button fix, on head `b0f42466`:
- Typecheck (both configs), eslint on the changed files, and the focused vitest (`styles.spec.ts`, `identity-protected.spec.ts`, `e2e-fixture-digests.spec.ts`, 37 of 37) all pass. `corepack pnpm invariants` passes 12 of 12.
- Focused E2E: `appearance-depth.spec.ts`, `inbox.spec.ts` and `themes.spec.ts` pass 22 of 22, twice in a row, on Windows at ports 9676/5073/9678. All overflow checks are 0.
  - An earlier run failed once because it read colours before the page had switched scheme. The test now waits for `html[data-cc-theme]` before reading.
- A full `corepack pnpm verify` was not re-run on this head. On the tree just before it, the unit suite passed in full (349 files; 4483 tests). One verify attempt reported one failed file with no failed test while another E2E run held the test ports. That did not reproduce.
- Screenshots inspected by eye:
  - Under `flatline` and `lookalike`, in dark and light, the approval card shows Approve filled with the accent beside a plain Deny.
  - Under `lookalike`, Deny keeps the theme's dashed 3px line in `--cc-border`.

After rebasing onto `main` at 4bcff63 (#342, #348 and #345; `docs/manifest.json` was the only conflict), on head `66021eef`, with typecheck, lint, invariants 12/12 and the focused app-intent, theme, style, notice and artifact specs passing 498 of 498:
- The app-intent conflicts with #342's `notice.act` were resolved by keeping both sides. Both `notice.act` and the four `appearance.*` kinds are in the contract, the read-backs, the audit fields and the client surfaces. The runtime checks the theme first, then the effect answer, then the notice target.
- `docs/open-interfaces.vi.md` keeps the order of the English text: the theme paragraph comes before the notice-action route.
- Typecheck (both configs), `pnpm lint` and `pnpm invariants` (12/12) pass.
- Focused vitest passes: the app-intent, theme, styles and fixture-digest specs, 108 of 108. The notice-action specs (`inbox`, `notice-action-surfaces` ×2, `notice-operations`, `notice-actions`, `security`, core `app-intents`) pass 173 of 173.
- CI runs the full suite and the browser E2E on this exact head.

## Not covered

- Voice is covered at the decision layer (typed and voice sentences decide identically) and through the shared client dispatch. No live microphone or voice E2E was run.
- Desktop: the smoke test checks that the shell page loads and that the window modes work. It does not assert computed styles in Electron, so desktop token parity rests on `appearance-tokens.spec.ts`. The compact, expanded and orb window modes render the same web client with the same stylesheet, and were not screenshotted separately.
- Screenshots and the overflow log are local evidence under `plans/reports/evidence/` and are not committed.
- `orb-visible` measures the WebGL Orb as the shader lights it. The no-WebGL fallback gradient is built from the same palette, but it is not measured on its own.
- The audit composites the modal's scrim in sRGB, while the CSS mixes it in OKLab, so the modal measurement is a close approximation rather than the exact drawn colour.
- The inbox's command and task approve buttons now use Clark's own button, but they are not given the primary emphasis the approval card's Approve has; they stay plain beside Deny, as before.
- The theme's line width and style (`--cc-line`, 1–3px, solid or dashed) still apply to the edges of host buttons and Stop, as they do to host card edges. Only their colour stays `--cc-border`.
- The input and badge recipes still reach inputs and badges inside host cards. Only buttons are reset.

## Review round

Each behavioural finding has a test that fails when its fix is reverted; the mutation table above shows each one killed. N4, N6 and S8 have no behavioural test. Four commits sit on `76373008`, the rebased feature commit: `12c8db02` (S5), `d54b9723` (N1), `5d6a271d` (the rest of the review) and `66021eef` (host buttons).

| Finding | Fix | Test |
| --- | --- | --- |
| B1: an all-black theme Orb palette hid the Orb | The theme palette cannot set `canvas`, the page the Orb sits on (contract, and `themeOrbPalette` drops it). A new `orb-visible` check lights each channel the way the shader does (`orbLitColors`) and requires the brightest to be at least 15 ΔE (OKLab) from the page, in both schemes, on the node and the page. Every preset clears it by more than 22.5. | `identity-protected.spec.ts` (blackout refused in dark with value 0; Clark and every preset pass; canvas refused), `orb-theme-default.spec.ts` (canvas dropped), `e2e-fixture-digests.spec.ts` (blackout refused with exactly `orb-visible`), `theme-contrast-lines.spec.ts` (VI/EN sentence), E2E `blackout` fixture (409 `THEME_PROTECTED`, sentence in Settings) |
| S1: status colours, the accent and focus were not re-measured on effect surfaces | Each finished surface is held to every pair the contrast audit holds the bare surface to, at the same minimums. The hairline is left to `edge-visible`, which measures it on the bare card. | `identity-protected.spec.ts`: a danger at 4.55 on the card fails under grain; a grey focus at 3.05 fails under grain |
| S2: glass showed whatever was behind it | Glass is an opaque tint on cards and the composer, so the Orb never shows through. The modal stays translucent and is measured over its scrim above both `#000` and `#FFF`. | `identity-protected.spec.ts`: glass at 1 fails the modal in dark; two elevated colours are measured; the card colour is the tint |
| S3: host cards took theme glass, texture and shadow | `.cc-card[data-owner="host"]` resets the surface variables (fill, image, size, shadow). | `styles.spec.ts` resolves every rule a host card gets, `.cc-card` included, and finds no theme surface, blur or shadow. E2E checks the approval card's computed fill, image, blur, shadow and all four edges under `flatline`. |
| S4: the pointer light ignored the backdrop's strength | `--cc-backdrop-lit` follows the backdrop intensity (22% at 0.2, capped at Clark's 55%). The page under the pattern and under the lit copy is audited, averaged over the share of the page the pattern paints. | `identity-protected.spec.ts` (dense scanlines refused; Clark and a faint grid pass), `styles.spec.ts` (the layers read the strengths the audit measures). The depth fixture moved to a faint hard grid. |
| S5: "make a dark theme" switched the scheme, and a theme named "Dark" captured scheme sentences | "make" is no longer an appearance verb. A theme whose name is made only of appearance words is never a target, so scheme sentences keep their meaning. | `core/test/app-intents.spec.ts`: four requests for work go to the agent; themes "Dark" and "Light Mode" leave scheme sentences alone, while "Dark Forest" is still chosen by name |
| S6: the in-app Reduced setting did not stop theme motion | The page marks `body[data-cc-reduced-motion]` from `experience.motion`, and every reduced-motion rule has a twin under that mark. | `styles.spec.ts` (twin per rule), `orb-theme-default.spec.ts` (`markReducedMotion`), E2E with the OS at no-preference |
| S7: a blur on every glass card | Only the modal is blurred, by 4–12px. | `styles.spec.ts` (only `.cc-modal` has `backdrop-filter`), `identity-protected.spec.ts` (the only blur is `--cc-modal-filter`, at most 12px) |
| S8: official docs | The EN/VI text for clarkcant-web now covers this round: no `canvas` in the Orb palette, `orb-visible`, glass, the pointer light, host cards, Reduced from Settings, every refusal code, and requests for work going to Clark. | n/a |
| N1: agent refusals were always Vietnamese | `control_app` reads the person's language (`preferredAppIntentLocale`) for the read-back and the theme refusal. | `control-app-tool.spec.ts`: VI by default, EN after the language preference is set |
| N2: a raw English node message reached a VI reader | `THEME_NOT_INSTALLED`, `THEME_INVALID`, `THEME_UNAVAILABLE` and `THEME_UNKNOWN` on a write are worded from the client's own messages. | `appearance-actions.spec.ts`: four codes in VI, with no English, ref or code |
| N3: an unknown fallback code rendered a missing key | `appearanceFallbackKey` falls back to a generic sentence (own keys only, so `toString` is unknown too). | `appearance-actions.spec.ts` |
| N4: two mono stacks | The terminal uses `monoFontStack("clark")`, and `FONT_STACKS.mono` is the same stack. | No dedicated test. The terminal imports the one stack instead of repeating it. |
| N6: a registry read on every theme write | Kept, with a comment on `themeDrawProblem`: the audit is cheap next to the file reads, and #300 is where repeated writes should revisit it. | n/a |
| N7: the injection test | Also forbids `!important` and comments, and every `var()` a value reads must be an identity variable or a name the token sheet declares. | `identity-protected.spec.ts` |
| N5: audit events record the decision, not the write | Not changed. This is pre-existing and shared with `orb.select`. | n/a |
| Host buttons took the theme's button recipe, so Approve and Deny could look alike | `[data-owner="host"] .cc-action` resets every button variable to Clark's own value. Approve carries `data-emphasis="primary"` (filled with the accent), and Deny is Clark's plain button. The inbox panel is marked `data-owner="host"`. Stop (`.cc-icon-btn`) already read no recipe variable; a test now holds it there. Colours still follow the audited tokens, and the contrast audit already requires the accent to read on the elevated fill (≥ 4.5). | `styles.spec.ts`: the host reset declares Clark's value for every button variable; the primary rule reads no recipe variable; accent against elevated is required in both schemes; Stop's rules read no styling variable and draw no shadow, blur or image. E2E `a theme's button recipe never reaches the host's answers or Stop` under `flatline` (quiet) and the new `lookalike` fixture (solid buttons in the card colour, a hard accent shadow), in dark and light: Approve is the accent fill and edge, Deny is `--cc-elevated` with a `--cc-border` edge, neither has a shadow, the two fills differ, and Stop is `--cc-elevated` with a `--cc-border` edge and no shadow. `inbox.spec.ts` checks the panel is host-owned. |

## Follow-ups

- #300 (M5) should retarget `appearance.open-theme-gallery` to the Theme Lab when it lands, and can reuse `themeDrawProblem` for `clark theme` and conformance.
- #302 (M7): font profiles are system stacks. Bundled fonts need a font-asset contract, which is a new appearance API version.
- #299 (M4) can build on appearance API 2 and the identity snapshot group.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

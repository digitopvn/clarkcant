Part of #201 (Theme Platform), milestone M7. Depends on M1–M5.

## Scope
- **Pixel Arcade**: packaged pixel display font (or a font-family profile) with a readable body fallback, zero/small radii, crisp borders, hard/stepped shadows, component recipes, a bounded decorative effect (scanlines or pixel grid), stepped/snap motion vocabulary, themed Orb defaults, built-in and isolated widget adaptation.
- **Neo Brutalism**: near-zero radius, heavy borders, hard offset shadows, strong type, pressed-state treatment, modal/card/control recipe differences, accessibility still passes.
- Fonts are bundled **only if their licence permits redistribution** (for example SIL OFL 1.1), with licence and source metadata recorded in the package. Otherwise use a font-family profile with system fallbacks.
- Cross-platform visual/E2E coverage (macOS, Windows, Linux/Omarchy) at narrow and normal widths, light and dark, reduced motion.

## Acceptance criteria (from #201)
- [ ] Pixel Arcade and Neo Brutalism both pass conformance without raw CSS/JS escape hatches.
- [ ] `builtin:clark` preserves the current visual baseline.
- [ ] Both themes apply to host UI, built-in widgets, declarative Mini Apps, isolated iframe widgets, detached windows and compatible Orb defaults.
- [ ] Any bundled font has a licence that permits redistribution, recorded with its source.


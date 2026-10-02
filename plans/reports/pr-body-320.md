Addresses #320. Part of #200.

## Summary

Reference app D: a media render tool whose render is a job the person can stop, and the host support it needs for a
package service to read a file a widget holds.

**Host: files a service reads**

- A capability names the argument fields that carry artifact ids:
  `inputArtifacts: { version: 1, fields: [...] }` (manifest v2 tools facet).
- Only the press of the widget instance holding the file can name one. Clark, voice, MCP and the CLI get
  `403 ARTIFACT_INPUT_REFUSED`.
- Before the call is sent, the node refuses:
  - a file the pressing instance holds no grant on, or one still being written (`403 ARTIFACT_INPUT_REFUSED`);
  - a file over the granted profile's input cap (`413 ARTIFACT_INPUT_TOO_LARGE`).
  A refused call sends nothing.
- The host offers `clarkcant/artifacts` in MCP `initialize`. The offer carries the chunk size and the profile's input,
  media-length and result caps.
- The service reads with `clarkcant/artifacts.read`:
  - at most 256 KiB per read, and every read is re-authorized;
  - an id the call did not name is refused (`-32020`);
  - any other refusal is `-32021`.
- Resource profiles gain `input: { maxBytes, maxMediaSeconds }`, from 8 MiB / 2 min up to 25 MiB / 2 h. A manifest
  names fields, never sizes, so it cannot raise a cap.
- WAV is accepted as an audio attachment and artifact type in the runtime, the client, the desktop file bridge and
  `clark widget dev`.

**Reference app: `examples/reference-apps/media-render`**

- Manifest v2 with a UI facet and a service. The service exposes `…media-render.render@1`, which runs as a job and
  reads its `source` field as an input artifact. The package asks for the `background-compute` profile.
- The transform is pure JavaScript: gain and trim on 16-bit PCM WAV, with a pinned digest.
- The service:
  - streams the clip chunk by chunk and reports MCP progress;
  - stops reading on cancel and does not answer;
  - refuses a clip over the profile's media length, or a render over the result cap, before rendering anything.
- The widget:
  - picks a clip through the host and keeps only the `ArtifactRef` and the JobRef in state, so a remount follows the
    same render;
  - shows the service's progress; Stop or Escape cancels;
  - offers the output only when the job completed, as a canvas waveform with its duration and the host's digest,
    with Attach and Save;
  - when the profile is refused, disables Render and shows the host's reason.
- `clark widget init --template media-tool` copies the app under a new id and passes conformance as scaffolded.
- Shared files carry minimal additions:
  - the vitest and tsconfig includes;
  - `examples/reference-apps/package.json`;
  - a `directory.json` entry;
  - a fixture-model block that places the widget with its `render` binding (`paceMs: 700`).
- Docs, in English and Vietnamese:
  - `docs/widget-development{,.vi}.md`: §14.4 "Files a service reads" and §24 "Reference apps" with §24.4;
  - `docs/widgets-and-extensions{,.vi}.md`: the status;
  - `docs/conformance-traceability.md`: the V12 row;
  - `docs/manifest.json`: regenerated.

## Validation

All runs are on Windows 11 with Docker 29.8.0 (Linux containers).

**Focused tests**

- `vitest run examples/reference-apps/media-render apps/runtime/test/service-artifact-input.spec.ts packages/widget-cli/test/media-tool-template.spec.ts`: 34 passed.
  - wav: 12;
  - service process: 8;
  - package: 5;
  - service-artifact-input, with a real service process: 5;
  - template: 4.
- `packages/widget-cli`: 18 files, 126 tests passed.

**Widget CLI**

- `clark widget test media-render`: 23 passed, 0 failed, 12 need the dev host.
- `clark widget pack media-render`: packed `com.clarkcant.reference.media-render@1.0.0`.

**Typecheck**

- `tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.web.json --noEmit`: both exit 0.

**E2E**: `playwright test apps/web/e2e/media-render.spec.ts`, 5 passed (1.0 m).

- A 68 s clip of twelve chunks: progress, preview, a download whose sha256 equals the digest shown, and attach.
- Escape mid-way, with `resultRefs: []` and no preview, also after a reload.
- A reload during a render follows the same job id to its file.
- With a policy rule refusing `background-compute` and the services restarted, the widget shows "Chưa dựng được:
  background-compute is not granted: …". After the policy is restored, the tool is available again.
- Keyboard only at 390 px, in dark with reduced motion: no horizontal overflow in the page or the frame.

**Repository checks**

- `pnpm verify`: exit 0, 411 test files passed and 1 skipped, 5219 tests passed and 34 skipped.
- `pnpm invariants`: all 12 checks passed.
- `pnpm verify:full`:
  - verify passed again (411 files, 5219 tests), and `test:widget-dev-host` (42) and `test:widget-browser` (4) passed;
  - `test:reference-theme-browser` failed one test, "pixel-arcade … at 390 light", on a browser
    `net::ERR_NO_BUFFER_SPACE` console error (Windows socket exhaustion, outside this change). Rerun alone: 8/8
    passed;
  - the remaining stage, `test:e2e`, run on its own: 367 passed, 3 skipped, 0 failed (370 tests, 17.5 m).

## Not in this PR

- No product path places an installed package's widget with a binding (#382). Only the fixture model gives this widget
  its `renderBinding`, so in a real installation Render is disabled and the reason is shown.
- There is no audio playback in the preview. The widget frame CSP has no `media-src`, so the preview is a waveform.
- No codec beyond 16-bit PCM WAV, and no binary fixture file is checked in. The clip is generated by `fixtureClip`.

## Open questions

- **Overlap with #324.** This PR adds `audio/wav` as an attachment and artifact type. If #324 adds an audio kind too,
  one of the two should rebase onto the other.
- **Conflicts with #317, #318 and #319.** They will add/add conflict in the shared files. Each change is a
  self-contained addition, so resolving means keeping both sides:
  - `examples/reference-apps/package.json`;
  - the `clark widget init` template list in `packages/widget-cli/src/cli.ts`;
  - `fixture-model.ts`, `directory.json`, and the vitest and tsconfig includes;
  - §24 numbering. This PR uses §24.4 for app D and writes the §24 intro the same way #318 does.
- **The over-cap refusal has no browser journey.** Under `background-compute` the input cap equals the largest
  artifact a person can pick (25 MiB), so a browser cannot pick a file over it. The 413 refusal is covered in
  `service-artifact-input.spec.ts` under `interactive-light` instead.
- **Fixed `paceMs`.** The fixture binding fixes `paceMs: 700` per chunk so a journey can watch progress and stop a
  render mid-way. A real placement would leave it unset.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

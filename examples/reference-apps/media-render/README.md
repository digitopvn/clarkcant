# Media render (reference app)

A widget and a service that render a WAV clip the person picks with a gain change and a trim. The render runs as a
job the widget follows and can stop. The widget never sees where the file lives, and the service gets no path or
handle: it reads the clip from the host a chunk at a time, only during the call it was given the clip for. The service
declares no egress, and a call that holds a file and is decided as `read` could not use any. This is the package that
`clark widget init --template media-tool` starts from.

Vietnamese: [README.vi.md](README.vi.md).

- **A UI facet and a service facet.** The service's one capability, `…media-render.render@1`, is declared with
  `execution: { kind: "job" }` and `inputArtifacts: { version: 1, fields: ["source"] }`. The package asks for the
  `background-compute` resource profile by name and never for numbers.
- **Pick:** `artifacts.pick({ accept: ["audio/wav"] })` opens the host's own prompt. The widget receives an
  `ArtifactRef` and keeps it in widget state.
- **Render:** the widget presses its own `invoke` binding, named in props as `renderBinding`, with the clip's artifact
  id and the parameters. Before the call is sent, the host checks three things: the pressing widget holds a grant on
  the file, the file is sealed, and the file fits the input cap of the profile it granted (25 MiB for
  `background-compute`). A file over the cap is refused with `ARTIFACT_INPUT_TOO_LARGE`, and no byte of it reaches the
  service.
- **Streaming:** during that call only, the service asks for the bytes with `clarkcant/artifacts.read`, one range of
  at most 256 KiB at a time. The host reauthorizes every read. It refuses any id the call did not name in a declared
  field.
- **Limits from the profile:** the host offers the limits in `initialize`, under `clarkcant/artifacts`. Only the
  service can read a clip's duration, so it refuses a clip longer than the profile's `maxMediaSeconds` before it
  renders anything. A manifest names fields, never sizes, so it cannot raise either limit.
- **Progress:** comes from the service's own MCP `notifications/progress`, as the bytes rendered so far.
- **Stop:** the job's cancel reaches the service through MCP cancellation. The service stops reading and does not
  answer. The host keeps a result file only when the job completes, so a stopped render leaves no partial file
  presented as finished.
- **Remount:** the JobRef lives in widget state, so a reloaded frame follows the same render.
- **Preview:** the rendered file is a finalized `ArtifactRef`. The widget reads it and draws a waveform on a canvas,
  and it shows the duration, the format and the host's sha256 digest. The widget's frame policy has no media source,
  so there is no audio player.
- **Attach and export:** `artifacts.attachToConversation` puts the rendered file in the composer.
  `artifacts.export` offers it as a save, or as a download on the web.
- **Unavailable profile:** when the host cannot grant the profile (a policy rule refuses it, or the container engine is
  too small), the service is not started at that size or any smaller one. Render is disabled, and the host's reason is
  shown in its place.

The `place_widget` tool places the widget in a real installation, with `renderBinding` bound to the package's
`render@1` and `source`, `gainDb`, `trimStartMs` and `trimEndMs` as its `inputs`; see
[widget development §10.3](../../../docs/widget-development.md#103-actions-clark-performs-actionsperform1).

## Files

- `clarkcant.json`: the manifest (schema version 2).
- `service/server.mjs`: the MCP stdio service. It has no dependencies and runs in the container read-only.
- `service/wav.mjs`: the transform (16-bit PCM WAV, mono or stereo, gain and trim) as pure functions, and the
  deterministic fixture clip the tests and journeys pick.
- `widgets/main/widget.json`: props (`title`, `renderBinding`), the state schema, sizing and the text fallback.
- `widgets/main/render-core.js`: the widget's rules (state, what a job snapshot means, the waveform) as pure functions.
- `widgets/main/main.js`: the frame code. Escape stops a render in progress.
- `fixtures/`: the four prop sets the conformance suite requires, and a simulated job for `clark widget dev`.

## Check it

```sh
node packages/widget-cli/src/cli.ts widget test examples/reference-apps/media-render
node packages/widget-cli/src/cli.ts widget pack examples/reference-apps/media-render
corepack pnpm exec vitest run examples/reference-apps/media-render apps/runtime/test/service-artifact-input.spec.ts
```

The browser journeys are in `apps/web/e2e/media-render.spec.ts`. They cover a clip larger than one chunk rendered
with progress and a preview, a stop mid-way, a remount, the unavailable profile, keyboard only, light and dark,
390 px and reduced motion. They need a container engine that runs Linux containers.

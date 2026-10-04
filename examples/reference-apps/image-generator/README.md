# Image generator (reference app)

A widget that turns a prompt into an image made by a provider, shows the job's progress, keeps the images in a
gallery, and lets the person attach one to the conversation or export it. It is the shape `clark widget init
--template ai-generator` starts from; `--template ui-with-service` starts from the same widget and job with a service
that draws the image itself.

- **Two facets.** An isolated UI facet (`widgets/main`) and a service facet (`service/server.mjs`, MCP over standard
  streams) that offers one capability, `com.clarkcant.reference.image-generator.image.generate@1`, run as a job.
- **Generate:** the prompt goes to the widget's `invoke` action binding named in props as `generateBinding`. The
  binding fills `prompt` from the draft in widget state, and from the person's input when there is one. The capability
  answers at once with a JobRef; the image is made as a durable job the node owns, so it goes on while the frame is
  unmounted, reloaded or on another device.
- **Progress:** the service polls the provider and reports each step as MCP progress; the job records it and the widget
  shows it. Nothing in the widget estimates progress. Every running job has its own panel and **Stop**, which cancels
  that job; the service stops polling. A failed job shows the service's own words in quotes, inside the widget's
  sentence.
- **Result:** the service returns the PNG as an image part; the node stores it as the job's result artifact. When the
  host offers `jobs.list@1` (`api.jobs.canList()`), the widget lists its own jobs with `jobs.list()` — including jobs
  started by voice or by Clark through the same binding — and reads finished images as `ArtifactRef`s, in 256 KiB
  chunks, into the gallery. On an older host it shows the jobs started while it is open, and says so.
- **Language:** the widget's text is Vietnamese only, like the reference text editor's; the host translates its own
  chrome, not a widget's.
- **Attach and export:** each gallery image can be put in the composer with `artifacts.attachToConversation` or
  handed to the host with `artifacts.export`. The widget learns only whether the host took it. Attach proposes a file
  name from a slug of the prompt and the end of the job's id (`a-red-kite-over-a-green-sea-3f9a1c.png`), which the
  node sanitizes, so two attached images never share a name.
- **The provider's key:** the manifest declares one origin and one secret, `IMAGE_PROVIDER_KEY`. The person stores the
  key for this package; the node adds it as a bearer header to each request the service asks it to make
  (`clarkcant/egress.fetch`). The service, its container and the widget never receive the key. Until it is stored the
  capability is refused as not authenticated.
- **Why `external-write`:** starting an image asks the provider to do work and spends the person's quota with it, so
  the capability is declared `external-write`, not `read`. That is also what lets the node send the start as a POST
  with the prompt in a JSON body: for a `read` capability the node sends only GET and HEAD, and a prompt in a URL ends
  up in more logs than a body does. Following the job and fetching the image stay GET. Under the default autonomous
  policy the press just runs; a person whose policy asks before external writes sees the host's approval card first.
- **Voice and Clark:** saying the button's label (*Tạo ảnh*) with the widget focused presses the same binding, and
  Clark's `invoke_capability` tool starts the job through the conversation's widget that has the binding, so the
  widget follows it either way.

The provider in this repository is a fake one (`test/fake-provider.ts`): it checks the bearer header, starts an image
only from a POST whose prompt is in a JSON body (a prompt in the URL is refused), answers status and image reads as
GET, advances one step per poll and returns a deterministic PNG. A real provider is
[digitopvn/clarkcant#321](https://github.com/digitopvn/clarkcant/issues/321).

Only the repository's scripted fixture model places the widget with `generateBinding` today. The `place_widget` tool
binds a widget's offered actions and "Ask Clark" buttons, not a binding to a service's capability, so in a real
installation the widget says it is not connected to the service.

## Files

- `clarkcant.json` — the manifest (schema version 2), with the service's capability and its egress.
- `widgets/main/widget.json` — props (`title`, `generateBinding`), the state schema (the draft prompt), sizing and the
  text fallback.
- `widgets/main/main.js` — the frame code: the form, the job panels, the gallery and the keyboard shortcuts
  (Ctrl/Cmd+Enter generates).
- `service/server.mjs` — the service; `service/png.mjs` draws the deterministic image.
- `fixtures/` — the prop sets the conformance suite requires, and the dev host's service fixture.
- `test/` — the fake provider, the service and job tests, and the package checks.

## Check it

```sh
node packages/widget-cli/src/cli.ts widget test examples/reference-apps/image-generator
node packages/widget-cli/src/cli.ts widget pack examples/reference-apps/image-generator
corepack pnpm exec vitest run examples/reference-apps/image-generator
```

The browser journeys (prompt, progress and gallery; reload mid-job; two jobs, each with its own Stop; a provider error
that echoes the key; attach and export; from Clark and from voice; an approval on the host's card; a host without
`jobs.list@1`; keyboard only; light and dark; 390 px; reduced motion; and after each one, the key absent from the page,
the bridge, storage, the node's files and tables and the service's container) are in
`apps/web/e2e/image-generator.spec.ts`.

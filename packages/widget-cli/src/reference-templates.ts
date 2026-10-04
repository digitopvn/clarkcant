import { referenceAppDirectory } from "./package-assets.ts";

/**
 * The `clark widget init` templates that are copies of a reference app, described as data.
 *
 * Copied rather than restated, so a template is an app this repository's own tests keep working instead of a second
 * copy nobody runs. One copier in `cli.ts` makes every copy the same way — the reference's id replaced with the new
 * package's, its tests and README left behind, version 0.1.0 — and this file says only what differs between them.
 *
 *   - `pure-ui` is the reference text editor: one isolated UI facet, no service.
 *   - `ai-generator` is the reference image generator with its provider: one declared origin, and a key the person
 *     stores for the package, which the node adds to each request. The service never holds it. The origin is a
 *     placeholder (`https://images.example.com`) to replace with the provider's before publishing.
 *   - `ui-with-service` is the same widget and job with no provider: a service that draws the picture itself, so the
 *     capability only reads.
 *   - `media-tool` is the reference media render tool: a widget and a service whose one capability runs as a job that
 *     reads a picked file through the host.
 *   - `connected-app` is the reference connected app: a UI facet, a service whose capabilities name the scopes they
 *     need on one declared account connection, skills, and a fake connector (`dev/fake-connector.mjs`, a test fixture)
 *     its own tests run against. The node connects the account and adds the token; the package never holds it.
 */

export const REFERENCE_TEMPLATES = ["pure-ui", "ai-generator", "ui-with-service", "media-tool", "connected-app"] as const;
export type ReferenceTemplate = (typeof REFERENCE_TEMPLATES)[number];

/** A JSON document the copier rewrites: the manifest, or a widget definition. */
export type JsonDocument = Record<string, unknown>;

export interface ReferenceCopy {
  /** The reference app's directory. */
  source: string;
  /** The reference package's id; every occurrence in its text files becomes the new package's id. */
  referenceId: string;
  displayName: string;
  description: string;
  sourceUrl: string;
  /** What else the copy's manifest changes, after its id, version, name and publisher. */
  manifest?: (manifest: JsonDocument) => JsonDocument;
  /** What else the copy's widget definition changes, after its id and version. */
  definition?: (definition: JsonDocument) => JsonDocument;
  readme: string;
}

/** The origin an `ai-generator` copy starts with: plainly not a provider, so nobody publishes it by accident. */
export const PLACEHOLDER_PROVIDER_ORIGIN = "https://images.example.com";

// The checkout's reference apps, or the copies an installed CLI carries (`package-assets.ts`).
const TEXT_EDITOR = referenceAppDirectory("text-editor");
const IMAGE_GENERATOR = referenceAppDirectory("image-generator");
const MEDIA_RENDER = referenceAppDirectory("media-render");
const CONNECTED_APP = referenceAppDirectory("connected-app");

type Facet = JsonDocument & { kind?: unknown; egress?: unknown; capabilities?: unknown };

function withFacets(manifest: JsonDocument, change: (facet: Facet) => Facet): JsonDocument {
  return { ...manifest, facets: (manifest.facets as Facet[]).map((facet) => change(facet)) };
}

/** The provider's origin, replaced by the placeholder. */
function placeholderOrigin(manifest: JsonDocument): JsonDocument {
  return withFacets(manifest, (facet) => {
    const egress = facet.egress as { origins?: JsonDocument[] } | undefined;
    if (facet.kind !== "tools" || egress?.origins === undefined) return facet;
    return { ...facet, egress: { ...egress, origins: egress.origins.map((origin) => ({ ...origin, origin: PLACEHOLDER_PROVIDER_ORIGIN })) } };
  });
}

/** No provider: no egress, and a capability that draws locally only reads. */
function withoutProvider(manifest: JsonDocument): JsonDocument {
  return withFacets(manifest, (facet) => {
    if (facet.kind !== "tools") return facet;
    const rest = Object.fromEntries(Object.entries(facet).filter(([key]) => key !== "egress"));
    const capabilities = (facet.capabilities as JsonDocument[] | undefined)?.map((capability) => ({ ...capability, effectCategory: "read" }));
    return capabilities === undefined ? rest : { ...rest, capabilities };
  });
}

const IMAGE_README =
  "# My Image Generator\n\n" +
  "A copy of the reference image generator: a prompt form, a job the widget follows and can stop, and a gallery of " +
  "the images it made, which the person can attach to the conversation or export.\n\n";

const RUN = "Run `clark widget test`, `clark widget dev` and `clark widget pack`.\n";

export function referenceCopy(template: ReferenceTemplate): ReferenceCopy {
  if (template === "pure-ui") {
    return {
      source: TEXT_EDITOR,
      referenceId: "com.clarkcant.reference.text-editor",
      displayName: "My Widget",
      description: "A text editor that opens, edits and saves a file the person picks.",
      sourceUrl: "https://github.com/example/my-widget",
      readme:
        "# My Widget\n\nA copy of the reference text editor: it opens a file through the host, keeps the draft in widget " +
        "state and saves through the host's export. Its rules are in `widgets/main/editor-core.js`.\n\n" +
        "Run `clark widget test` then `clark widget pack`.\n",
    };
  }
  if (template === "media-tool") {
    return {
      source: MEDIA_RENDER,
      referenceId: "com.clarkcant.reference.media-render",
      displayName: "My Media Tool",
      description: "Renders a file the person picks as a job the widget follows and can stop.",
      sourceUrl: "https://github.com/example/my-media-tool",
      readme:
        "# My Media Tool\n\nA copy of the reference media render tool: the widget picks a WAV file through the host, and " +
        "the service renders it as a job, reading the file a chunk at a time through `clarkcant/artifacts.read`. The " +
        "transform is in `service/wav.mjs`; the widget's rules are in `widgets/main/render-core.js`.\n\n" +
        "Run `clark widget test` then `clark widget pack`.\n",
    };
  }
  if (template === "connected-app") {
    return {
      source: CONNECTED_APP,
      referenceId: "com.clarkcant.reference.connected-app",
      displayName: "My Connected App",
      description: "Lists and renames tasks in an account you connect; the node holds the account, the package never does.",
      sourceUrl: "https://github.com/example/my-connected-app",
      readme:
        "# My Connected App\n\n" +
        "A copy of the reference connected app: a widget that lists and renames tasks, a service whose two capabilities " +
        "name the scopes they need, one declared account connection, and skills that tell Clark how to use them.\n\n" +
        "- **The node holds the account.** A person connects it in Settings, in their system browser. The node keeps the " +
        "tokens, adds the access token to the service's requests to the declared endpoints only, and marks a capability " +
        "not ready, with the reason, when the connection is missing, expired, revoked or lacks its scope. The widget and " +
        "the service never see a token, a refresh token or a code.\n" +
        "- **The connection points at a fake.** `clarkcant.json` declares `http://127.0.0.1:8880`, served by " +
        "`dev/fake-connector.mjs`, a test fixture with no real account. Run it with `node dev/fake-connector.mjs`; a node " +
        "reaches loopback endpoints only with `CC_EGRESS_ALLOW_PRIVATE_NETWORK=1`. **Replace the provider, client id, " +
        "scopes and endpoints with your provider's before publishing.** A real provider's endpoints must be HTTPS.\n" +
        "- **Writes are decided by the node.** `update-task` is `external-write`: the person's execution policy may ask " +
        "first, and a rename whose answer never came back is recorded as unknown and not retried.\n\n" +
        "Run `clark widget test`, `clark widget pack`, and `node --test dev/service.test.mjs` for the service's own tests.\n",
    };
  }
  if (template === "ai-generator") {
    return {
      source: IMAGE_GENERATOR,
      referenceId: "com.clarkcant.reference.image-generator",
      displayName: "My Image Generator",
      description: "Turns a prompt into an image with a provider the node reaches for it, adding the key you store for this package.",
      sourceUrl: "https://github.com/example/my-image-generator",
      manifest: placeholderOrigin,
      readme:
        IMAGE_README +
        `**Replace the provider origin before you publish.** \`clarkcant.json\` declares \`${PLACEHOLDER_PROVIDER_ORIGIN}\`, ` +
        "a placeholder that reaches no provider. Put your provider's origin there, and its paths in `service/server.mjs`.\n\n" +
        "The service asks the provider through the node, which adds the key you store for this package as a bearer " +
        "header. The service and the widget never see the key.\n\n" +
        "The capability is declared `external-write`: asking a provider to draw spends the person's quota with it. That " +
        "is also what lets the node send the start as a POST with the prompt in a JSON body; for a `read` capability it " +
        "sends only GET and HEAD. Keep prompts out of URLs.\n\n" +
        "The widget lists earlier jobs only when the host offers `jobs.list@1` (`api.jobs.canList()`); on an older host " +
        "it shows the jobs started while it is open, and says so.\n\n" +
        RUN,
    };
  }
  return {
    source: IMAGE_GENERATOR,
    referenceId: "com.clarkcant.reference.image-generator",
    displayName: "My Image Generator",
    description: "Turns a prompt into an image its own service draws, as a job the widget follows.",
    sourceUrl: "https://github.com/example/my-image-generator",
    manifest: withoutProvider,
    definition: (definition) => ({ ...definition, effectCategories: ["read"] }),
    readme:
      IMAGE_README +
      "The service draws the picture itself; it declares no provider and needs no key, so its capability only reads. " +
      "To reach a provider later, add an `egress` block to the tools facet and declare the capability `external-write` " +
      "(see the `ai-generator` template): the node sends a service's POST only for a capability that writes.\n\n" +
      "The widget lists earlier jobs only when the host offers `jobs.list@1` (`api.jobs.canList()`); on an older host " +
      "it shows the jobs started while it is open, and says so.\n\n" +
      RUN,
  };
}

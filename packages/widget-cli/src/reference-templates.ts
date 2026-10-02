import { fileURLToPath } from "node:url";

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
 */

export const REFERENCE_TEMPLATES = ["pure-ui", "ai-generator", "ui-with-service"] as const;
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

const TEXT_EDITOR = fileURLToPath(new URL("../../../examples/reference-apps/text-editor/", import.meta.url));
const IMAGE_GENERATOR = fileURLToPath(new URL("../../../examples/reference-apps/image-generator/", import.meta.url));

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

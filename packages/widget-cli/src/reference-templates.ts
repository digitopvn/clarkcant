import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { packageFiles } from "./package-files.ts";

/**
 * `clark widget init --template ai-generator | ui-with-service`: a working copy of the reference image generator.
 *
 * Copied rather than restated, so the template is the app this repository's own tests keep working — a prompt, a job
 * the widget follows and stops, an image that becomes an artifact, attach and export — instead of a second copy nobody
 * runs. The reference's ids are replaced with the new package's, so its capability is named under its own id.
 *
 *   - `ai-generator` keeps the provider: one declared origin, and a key the person stores for the package, which the
 *     node adds to each request. The service never holds it. Point the origin at your provider before you publish.
 *   - `ui-with-service` drops the provider: the same widget and job, with a service that draws the picture itself.
 *     The shape for a package whose service does its own work.
 */

export const REFERENCE_TEMPLATES = ["ai-generator", "ui-with-service"] as const;
export type ReferenceTemplate = (typeof REFERENCE_TEMPLATES)[number];

const SOURCE = fileURLToPath(new URL("../../../examples/reference-apps/image-generator/", import.meta.url));
const REFERENCE_ID = "com.clarkcant.reference.image-generator";
/** Files whose text names the reference's ids. Anything else (none today) is copied byte for byte. */
const TEXT = /\.(json|js|mjs|html|css)$/;

/** The reference app's own files that describe or test that app rather than the package a person starts from. */
function skipped(path: string): boolean {
  return path.startsWith("test/") || path.startsWith("dist/") || path === "README.md" || path === "LICENSE";
}

interface Manifest extends Record<string, unknown> {
  facets: (Record<string, unknown> & { kind: string })[];
}

function manifestFor(text: string, template: ReferenceTemplate): string {
  const manifest = JSON.parse(text) as Manifest;
  const copy: Manifest = {
    ...manifest,
    version: "0.1.0",
    displayName: "My Image Generator",
    description:
      template === "ai-generator"
        ? "Turns a prompt into an image with a provider the node reaches for it, adding the key you store for this package."
        : "Turns a prompt into an image its own service draws, as a job the widget follows.",
    facets: manifest.facets.map((facet) => {
      if (facet.kind !== "tools" || template === "ai-generator") return facet;
      return Object.fromEntries(Object.entries(facet).filter(([key]) => key !== "egress")) as Manifest["facets"][number];
    }),
    publisher: { id: "example", sourceUrl: "https://github.com/example/my-image-generator", license: "MIT" },
  };
  return `${JSON.stringify(copy, null, 2)}\n`;
}

function readme(template: ReferenceTemplate): string {
  const provider =
    template === "ai-generator"
      ? "The service asks the provider at the origin declared in `clarkcant.json` through the node, which adds the key " +
        "you store for this package as a bearer header. The service and the widget never see the key. Change the origin " +
        "and the paths in `service/server.mjs` to your provider's before you publish.\n\n"
      : "The service draws the picture itself; it declares no provider and needs no key. To reach a provider later, add " +
        "an `egress` block to the tools facet (see the `ai-generator` template).\n\n";
  return (
    "# My Image Generator\n\n" +
    "A copy of the reference image generator: a prompt form, a job the widget follows and can stop, and a gallery of " +
    "the images it made, which the person can attach to the conversation or export.\n\n" +
    provider +
    "Run `clark widget test`, `clark widget dev` and `clark widget pack`.\n"
  );
}

export function initFromReferenceTemplate(root: string, id: string, template: ReferenceTemplate): void {
  if (!existsSync(join(SOURCE, "clarkcant.json"))) {
    throw new Error(`the ${template} template is copied from ${SOURCE}, which is missing from this checkout`);
  }
  for (const { path, bytes } of packageFiles(SOURCE)) {
    if (skipped(path)) continue;
    const target = join(root, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    if (!TEXT.test(path)) {
      writeFileSync(target, bytes);
      continue;
    }
    const text = bytes.toString("utf8").split(REFERENCE_ID).join(id);
    if (path === "clarkcant.json") writeFileSync(target, manifestFor(text, template));
    else if (path === "widgets/main/widget.json") {
      writeFileSync(target, `${JSON.stringify({ ...(JSON.parse(text) as Record<string, unknown>), version: "0.1.0" }, null, 2)}\n`);
    } else writeFileSync(target, text);
  }
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "README.md"), readme(template));
  writeFileSync(join(root, "LICENSE"), "MIT\n");
}

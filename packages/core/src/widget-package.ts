import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { fixtureDatasetSchema, widgetDefinitionSchema, type FixtureDataset, type WidgetDefinition } from "@clarkcant/contracts";
import { z } from "zod";

/**
 * Reading a widget package.
 *
 * The layout and the manifest come from `docs/widget-development.md`, which is the canonical developer-UX target: a
 * package has a root `clarkcant.json`, one or more `widgets/<name>/` directories holding an entry and a definition,
 * and a `fixtures/` directory the conformance suite and the dev host both read.
 *
 * Two things this layer deliberately does *not* do. It does not repair a manifest — a package with a malformed
 * manifest is a package whose author needs to know, and a tool that silently filled in defaults would hide the
 * mistake until publish. And it does not treat `requestedCapabilities` as granted: the manifest is request metadata,
 * so it is read as a request and the conformance suite checks it against what the entry actually needs.
 */

export const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(160),
  version: z.string().min(1).max(80),
  displayName: z.string().min(1).max(200),
  description: z.string().min(1).max(600),
  hostApi: z.strictObject({ min: z.int().nonnegative(), max: z.int().nonnegative() }),
  facets: z
    .array(
      z.strictObject({
        kind: z.literal("widget"),
        id: z.string().min(1).max(160),
        entry: z.string().min(1).max(300),
        definition: z.string().min(1).max(300),
        isolation: z.literal("isolated-ui"),
      }),
    )
    .min(1),
  requestedCapabilities: z.array(z.string().min(1).max(160)).max(64),
  permissions: z.strictObject({
    networkOrigins: z.array(z.string().min(1).max(300)).max(64),
    filesystem: z.array(z.string().min(1).max(300)).max(64),
    microphone: z.boolean(),
    camera: z.boolean(),
    lifecycleScripts: z.array(z.string().min(1).max(300)).max(64),
  }),
  platforms: z.array(z.string().min(1).max(120)).min(1),
  publisher: z.strictObject({
    id: z.string().min(1).max(160),
    sourceUrl: z.string().min(1).max(400),
    license: z.string().min(1).max(80),
  }),
});
export type WidgetManifest = z.infer<typeof manifestSchema>;

export interface WidgetFacet {
  manifest: WidgetManifest;
  facetId: string;
  definition: WidgetDefinition;
  /** Directory holding the entry and the definition, relative to the package root. */
  directory: string;
  entryPath: string;
}

export interface WidgetPackage {
  root: string;
  manifest: WidgetManifest;
  facets: WidgetFacet[];
  /** Fixture name to the props it declares, read from `fixtures/*.json`. */
  fixtures: Record<string, Record<string, unknown>>;
  /**
   * Fixture name to the dataset it renders from, read from `fixtures/<name>.dataset.json`.
   *
   * A package's fixture file holds raw props, and props cannot carry a dataset: the catalog's renderers read one
   * from the fixture rather than from the props, so without this a data-backed widget a package declares would
   * draw "no data" forever. The sibling file keeps "props are props" and gives the dataset its own artifact,
   * validated by the same schema the catalog's own fixtures use.
   */
  datasets: Record<string, FixtureDataset>;
  /** Anything that stopped the package from being read at all. */
  problems: string[];
}

function readJson(path: string): { ok: true; value: unknown } | { ok: false; problem: string } {
  if (!existsSync(path)) return { ok: false, problem: `${path} does not exist` };
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { ok: false, problem: `${path} is not valid JSON: ${error instanceof Error ? error.message : "unknown"}` };
  }
}

export function readPackage(root: string): WidgetPackage {
  const problems: string[] = [];
  const manifestPath = join(root, "clarkcant.json");
  const read = readJson(manifestPath);
  if (!read.ok) {
    // Nothing else can be read without a manifest, and guessing at one would validate the wrong package.
    return { root, manifest: {} as WidgetManifest, facets: [], fixtures: {}, datasets: {}, problems: [read.problem] };
  }
  const parsed = manifestSchema.safeParse(read.value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      root,
      manifest: {} as WidgetManifest,
      facets: [],
      fixtures: {},
      datasets: {},
      problems: [`${manifestPath}: ${first?.path.join(".") ?? ""} ${first?.message ?? "does not match the manifest schema"}`],
    };
  }

  const facets: WidgetFacet[] = [];
  for (const facet of parsed.data.facets) {
    const definitionRead = readJson(join(root, facet.definition));
    if (!definitionRead.ok) {
      problems.push(definitionRead.problem);
      continue;
    }
    const definition = widgetDefinitionSchema.safeParse(definitionRead.value);
    if (!definition.success) {
      const first = definition.error.issues[0];
      problems.push(
        `${facet.definition}: ${first?.path.join(".") ?? ""} ${first?.message ?? "does not match the widget definition schema"}`,
      );
      continue;
    }
    // The facet id in the manifest and the id in the definition are two places to say the same thing, and a package
    // where they disagree is a package whose instance cannot be resolved to what it renders.
    if (definition.data.id !== facet.id) {
      problems.push(`${facet.definition}: id "${definition.data.id}" does not match the manifest facet id "${facet.id}"`);
    }
    facets.push({
      manifest: parsed.data,
      facetId: facet.id,
      definition: definition.data,
      directory: facet.entry.split("/").slice(0, -1).join("/"),
      entryPath: facet.entry,
    });
  }

  const fixtures: Record<string, Record<string, unknown>> = {};
  const datasets: Record<string, FixtureDataset> = {};
  const fixturesDir = join(root, "fixtures");
  if (existsSync(fixturesDir)) {
    for (const name of readdirSync(fixturesDir)) {
      if (!name.endsWith(".json")) continue;
      const fixtureRead = readJson(join(fixturesDir, name));
      if (!fixtureRead.ok) {
        problems.push(fixtureRead.problem);
        continue;
      }

      /*
       * Checked before the props branch, and not only because of the name: `default.dataset.json` would otherwise
       * be read as a fixture called "default.dataset", which is a fixture nobody declared and nobody can select.
       */
      if (name.endsWith(".dataset.json")) {
        const parsedDataset = fixtureDatasetSchema.safeParse(fixtureRead.value);
        if (!parsedDataset.success) {
          const first = parsedDataset.error.issues[0];
          problems.push(
            `fixtures/${name}: ${first?.path.join(".") ?? ""} ${first?.message ?? "does not match the dataset schema"}`,
          );
          continue;
        }
        datasets[name.slice(0, -".dataset.json".length)] = parsedDataset.data;
        continue;
      }

      const value = fixtureRead.value;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        problems.push(`fixtures/${name} must be a JSON object of props`);
        continue;
      }
      fixtures[name.replace(/\.json$/, "")] = value as Record<string, unknown>;
    }
  }

  return { root, manifest: parsed.data, facets, fixtures, datasets, problems };
}

/** The fixture names the standard requires, because the states they stand for are the ones a widget must survive. */
export const REQUIRED_FIXTURES = ["default", "empty", "error", "compact"] as const;

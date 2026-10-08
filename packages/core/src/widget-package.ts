import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  PACKAGE_MANIFEST_SCHEMA_VERSION,
  PACKAGE_MANIFEST_SCHEMA_VERSIONS,
  describeUnsafePattern,
  fixtureDatasetSchema,
  manifestProblems,
  networkOriginSchema,
  packageManifestSchema,
  unsafeSchemaPattern,
  widgetDefinitionSchema,
  type FixtureDataset,
  type PackageManifest,
  type WidgetDefinition,
} from "@clarkcant/contracts";
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

/**
 * The widget-only manifest, `schemaVersion: 1`, that `clark widget init` wrote before a package could carry anything
 * but widgets. Read, never written: a package installed under it keeps its consent, because consent is bound to the
 * artifact's digest and upgrading the file on disk would change those bytes.
 */
export const widgetManifestV1Schema = z.strictObject({
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
    networkOrigins: z.array(networkOriginSchema).max(64),
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
export type WidgetManifestV1 = z.infer<typeof widgetManifestV1Schema>;

/**
 * A v1 manifest in the canonical shape, before the canonical schema has checked it.
 *
 * The mapping is mechanical: a `widget` facet is what the contract calls a `ui` facet, and a filesystem path v1 listed
 * with no access mode could only ever be read. Nothing is filled in that v1 did not say, so a v1 value the canonical
 * schema refuses — a version that is not semver, a platform that does not exist — is reported, not repaired.
 */
export function upgradeWidgetManifestV1(manifest: WidgetManifestV1): unknown {
  return {
    // The version that carries exactly what v1 could: widgets.
    schemaVersion: 2,
    id: manifest.id,
    version: manifest.version,
    displayName: manifest.displayName,
    description: manifest.description,
    hostApi: manifest.hostApi,
    facets: manifest.facets.map((facet) => ({
      kind: "ui",
      id: facet.id,
      entry: facet.entry,
      definition: facet.definition,
      isolation: facet.isolation,
    })),
    requestedCapabilities: manifest.requestedCapabilities,
    permissions: {
      ...manifest.permissions,
      filesystem: manifest.permissions.filesystem.map((path) => ({ path, access: "read" })),
    },
    platforms: manifest.platforms,
    publisher: manifest.publisher,
    dependencies: [],
  };
}

/** A widget a package declares, with the definition its `ui` facet points at. */
export interface WidgetFacet {
  manifest: PackageManifest;
  facetId: string;
  definition: WidgetDefinition;
  /** Directory holding the entry and the definition, relative to the package root. */
  directory: string;
  entryPath: string;
}

export interface WidgetPackage {
  root: string;
  /**
   * The canonical manifest, whichever version the file was written in. Empty when the package could not be read, in
   * which case `problems` says why and `facets` is empty.
   */
  manifest: PackageManifest;
  /** The package's `ui` facets. Its other facets are in `manifest.facets`, and their hosts read them from there. */
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

function firstIssue(error: z.ZodError, fallback: string): string {
  const first = error.issues[0];
  return `${first?.path.join(".") ?? ""} ${first?.message ?? fallback}`;
}

/**
 * The manifest in its canonical shape, or every reason it is not one.
 *
 * A v1 file is read by the schema it was written against and then held to the canonical one, so both versions end at
 * the same checks — including the ones only `manifestProblems` can make, such as a facet whose files are outside the
 * package, which this reader would otherwise go on to open.
 */
export function parseManifest(value: unknown): { ok: true; manifest: PackageManifest } | { ok: false; problems: string[] } {
  const schemaVersion = typeof value === "object" && value !== null ? (value as { schemaVersion?: unknown }).schemaVersion : undefined;
  let candidate = value;
  if (schemaVersion === 1) {
    const v1 = widgetManifestV1Schema.safeParse(value);
    if (!v1.success) return { ok: false, problems: [firstIssue(v1.error, "does not match the schemaVersion 1 manifest")] };
    candidate = upgradeWidgetManifestV1(v1.data);
  } else if (!(PACKAGE_MANIFEST_SCHEMA_VERSIONS as readonly unknown[]).includes(schemaVersion)) {
    const known = PACKAGE_MANIFEST_SCHEMA_VERSIONS.join(" or ");
    return {
      ok: false,
      problems: [
        typeof schemaVersion === "number" && schemaVersion > PACKAGE_MANIFEST_SCHEMA_VERSION
          ? `schemaVersion ${String(schemaVersion)} is newer than this build reads (${known}); update ClarkCant`
          : `schemaVersion must be ${known} (or 1, the widget-only format still read)`,
      ],
    };
  }
  const parsed = packageManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    const problem = firstIssue(parsed.error, "does not match the manifest schema");
    return { ok: false, problems: [schemaVersion === 1 ? `${problem} (a schemaVersion 1 value the canonical manifest does not accept)` : problem] };
  }
  const problems = manifestProblems(parsed.data);
  return problems.length === 0 ? { ok: true, manifest: parsed.data } : { ok: false, problems };
}

export function readPackage(root: string): WidgetPackage {
  const problems: string[] = [];
  const manifestPath = join(root, "clarkcant.json");
  const unread = (reasons: string[]): WidgetPackage => ({
    root,
    manifest: {} as PackageManifest,
    facets: [],
    fixtures: {},
    datasets: {},
    problems: reasons,
  });
  const read = readJson(manifestPath);
  // Nothing else can be read without a manifest, and guessing at one would validate the wrong package.
  if (!read.ok) return unread([read.problem]);
  const parsed = parseManifest(read.value);
  if (!parsed.ok) return unread(parsed.problems.map((problem) => `${manifestPath}: ${problem.trim()}`));
  const manifest = parsed.manifest;

  const facets: WidgetFacet[] = [];
  for (const facet of manifest.facets) {
    if (facet.kind !== "ui") continue;
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
    // Props are checked against this schema on the node's main thread, so a pattern that could stall it keeps the
    // widget out: named here, where the author's tools and the node's library both read the package.
    const unsafe = unsafeSchemaPattern(definition.data.propsSchema, "propsSchema");
    if (unsafe !== undefined) {
      problems.push(`${facet.definition}: the widget is not loaded, because ${describeUnsafePattern(unsafe)}`);
      continue;
    }
    facets.push({
      manifest,
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

  return { root, manifest, facets, fixtures, datasets, problems };
}

/** The fixture names the standard requires, because the states they stand for are the ones a widget must survive. */
export const REQUIRED_FIXTURES = ["default", "empty", "error", "compact"] as const;

import { z } from "zod";

import { declaredReachSchema } from "./declared-reach.ts";
import { resourceRequestSchema } from "./resource-profiles.ts";
import { facetKindSchema, isUnknownFacetKind, isolationClassSchema } from "./install.ts";
import { platformSchema, semverSchema, type Platform } from "./primitives.ts";

/**
 * Where a package comes from, and what a directory entry may say about it.
 *
 * Two rules shape both schemas, and they are the same rule seen from two sides.
 *
 * **A source resolves to an exact artifact or it does not resolve.** A git branch and an npm range are both
 * "whatever is there when you look", and installing one means installing something nobody reviewed. So the
 * schemas carry `gitRef` and `npmVersion` as exact values, and the resolver refuses anything that is not one.
 *
 * **A directory entry is a claim, not an authority.** Everything here is what a publisher says about their
 * package. None of it grants anything: the manifest inside the artifact is validated by the install supervisor and
 * approved by digest, which is why `directoryEntrySchema` has no field that could be mistaken for a permission.
 */

/**
 * How the package is reached.
 *
 * `local` is first-class rather than a development afterthought: a directory account is not a precondition for
 * running your own widget, and a source model that treated a local path as a special case would make the
 * marketplace the only real path.
 */
export const packageSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("local"),
    /** Absolute or workspace-relative path to the package directory. */
    path: z.string().min(1).max(1000),
  }),
  z.strictObject({
    kind: z.literal("git"),
    url: z.string().min(1).max(1000),
    /**
     * A commit id, or a tag that is pinned. A branch name is refused by the resolver, because it names a moving
     * target rather than a revision.
     */
    ref: z.string().min(1).max(200),
  }),
  z.strictObject({
    kind: z.literal("npm"),
    name: z.string().min(1).max(300),
    /** An exact version. A range is refused by the resolver. */
    version: z.string().min(1).max(80),
  }),
]);
export type PackageSource = z.infer<typeof packageSourceSchema>;

/**
 * The state of one directory source, named so that "could not be consulted" is never shown as "nothing found":
 * `ready`, `stale` (a remote source listed from its last copy because a refresh failed), `not-fetched`, `unreachable`,
 * `unsupported` (the address serves no ClarkCant directory feed) and `unreadable` (read, and not a valid directory).
 */
export const directorySourceStateSchema = z.enum(["ready", "stale", "not-fetched", "unreachable", "unsupported", "unreadable"]);
export type DirectorySourceState = z.infer<typeof directorySourceStateSchema>;

/** The risk lane a facet runs in. Shown to the user, because the three are not equally trusted. */
export const riskLaneSchema = z.enum(["isolated-ui", "service", "declarative", "trusted-native"]);
export type RiskLane = z.infer<typeof riskLaneSchema>;

/**
 * Which of a package's widgets keep a fixed look rather than following the person's appearance, as the publisher
 * claims it. A discovery claim shown before install: the installed, digest-checked widget definition's
 * `appearanceMode` is what the host applies. One schema for the directory entry and the marketplace card that
 * repeats it, so the card can never be stricter than the listing it shows.
 */
export const widgetAppearanceClaimsSchema = z
  .array(z.strictObject({ id: z.string().min(1).max(160), mode: z.enum(["adaptive", "fixed"]) }))
  .max(64);
export type WidgetAppearanceClaims = z.infer<typeof widgetAppearanceClaimsSchema>;

/**
 * The longest version a listing may carry. The marketplace card repeats the version and Install sends it back as it
 * was listed, so it cannot be shortened on the way: a listing whose version is longer is refused here instead, where
 * the reason can be named, rather than dropping the card that would have shown it. `semverSchema` itself stays
 * unbounded because installed records and protocol versions already validate against it.
 */
export const DIRECTORY_VERSION_MAX = 80;
export const directoryVersionSchema = semverSchema.max(DIRECTORY_VERSION_MAX, {
  error: `must be a semantic version of at most ${String(DIRECTORY_VERSION_MAX)} characters`,
});

/**
 * The directory entry.
 *
 * The fields are the ones `docs/widget-development.md` §18 requires. `riskTier` is not derived from the publisher's
 * own claims: it is the strongest lane among the package's facets, because a package is as trusted as its least
 * isolated facet.
 */
export const directoryEntrySchema = z.strictObject({
  packageId: z.string().min(1).max(160),
  version: directoryVersionSchema,
  displayName: z.string().min(1).max(200),
  description: z.string().min(1).max(600),
  /**
   * Where the artifact is fetched from. Required, because a listing that named a package but not a source would
   * be a result nobody could install — the plan asks the directory to index source references, and this is that
   * reference. It is still only a pointer: the install path re-resolves it and checks the digest.
   */
  source: packageSourceSchema,
  publisher: z.strictObject({
    id: z.string().min(1).max(160),
    sourceUrl: z.string().min(1).max(400),
    license: z.string().min(1).max(80),
  }),
  /** Preview media, optional: a package without one is listed rather than hidden. */
  preview: z.strictObject({ imageUrl: z.string().min(1).max(1000).optional(), videoUrl: z.string().min(1).max(1000).optional() }),
  facets: z.array(facetKindSchema).min(1).max(64),
  /** Optional discovery claims; the installed, digest-checked widget definition remains authoritative. */
  widgetAppearance: widgetAppearanceClaimsSchema.optional(),
  /**
   * Each facet with the lane it runs in.
   *
   * The entry used to carry facet kinds and one `riskTier`, which is the *strongest* lane among them — and a
   * strongest lane cannot be turned back into a per-facet answer: applying it to every facet would describe a
   * declarative theme as trusted native, and deriving it from the facet kind would be guessing what some other
   * publisher meant. The install supervisor needs the per-facet plan, so the entry carries it. The publisher
   * already knows it (it is in the manifest), and `riskTier` stays as the summary a listing shows.
   */
  isolations: z.array(z.strictObject({ facetKind: facetKindSchema, isolation: isolationClassSchema })).min(1).max(64),
  platforms: z.array(platformSchema).min(1),
  hostApi: z.strictObject({ min: z.int().nonnegative(), max: z.int().nonnegative() }),
  /** Summarised for the listing; the authoritative list is the manifest inside the artifact. */
  permissionsSummary: z.array(z.string().min(1).max(200)).max(64),
  /**
   * The origins, secrets and browser-token providers the package reaches (`declared-reach.ts`), so a listing and an
   * install question show them before anything is fetched. Absent means it reaches none. Unlike the other claims here
   * it is binding: the install refuses an artifact whose manifest declares a different reach.
   */
  declaredReach: declaredReachSchema.optional(),
  /**
   * The resource profile the package requests (`resource-profiles.ts`), so an update notice can say what changes before
   * anything is fetched. Absent means the default profile and no GPU. Binding like `declaredReach`: the install refuses an
   * artifact whose manifest requests anything else.
   */
  resources: resourceRequestSchema.optional(),
  riskTier: riskLaneSchema,
  sizeBytes: z.int().nonnegative(),
  /** The digest the publisher published. An install that resolves to anything else is refused. */
  digest: z.string().min(1).max(120),
});
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;

/**
 * The parts of an entry a newer directory may add fields to without an older node refusing it: the entry itself and its
 * descriptive objects. The binding ones (`source`, `isolations`, `declaredReach`, `resources`) and the claims a card
 * repeats (`widgetAppearance`) stay strict: a node reads them completely or not at all.
 */
const OPEN_ENTRY_OBJECTS = {
  publisher: Object.keys(directoryEntrySchema.shape.publisher.shape),
  preview: Object.keys(directoryEntrySchema.shape.preview.shape),
  hostApi: Object.keys(directoryEntrySchema.shape.hostApi.shape),
} as const;
const ENTRY_KEYS: readonly string[] = Object.keys(directoryEntrySchema.shape);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One segment of a field path a note may name: an identifier, as every field a directory has added so far is. A key is
 * the publisher's text, and a note shows it next to Clark's own words on an install question, so a key that is not a
 * plain identifier (a bidi control, a line break, a space, wording made to look like the host's, an over-long name) is
 * counted without being named.
 */
const FIELD_SEGMENT = "[A-Za-z_$][A-Za-z0-9_$-]{0,63}";
const FIELD_SEGMENT_PATTERN = new RegExp(`^${FIELD_SEGMENT}$`, "u");
/** A nameable field path: one segment, or two for a field inside `publisher`, `preview` or `hostApi`. */
export const UNREAD_FIELD_PATH_PATTERN = new RegExp(`^${FIELD_SEGMENT}(?:\\.${FIELD_SEGMENT})?$`, "u");

/** What an entry carried that this node does not read: the paths it can name, and how many others it cannot. */
export type UnreadEntryFields = { names: string[]; unnamed: number };

/**
 * The fields of `value` the node knows, and what it does not. Names keep the order the entry lists them in: the
 * publisher writes the entry either way, so no order would stop them choosing which names come first, and the count is
 * what tells a person how much there is.
 */
function splitKnownFields(value: Record<string, unknown>): {
  known: Record<string, unknown>;
  unread: UnreadEntryFields;
  skippedKinds: string[];
} {
  const known: Record<string, unknown> = {};
  const unread: UnreadEntryFields = { names: [], unnamed: 0 };
  const left = (segments: readonly string[]): void => {
    if (segments.every((segment) => FIELD_SEGMENT_PATTERN.test(segment))) unread.names.push(segments.join("."));
    else unread.unnamed += 1;
  };
  for (const [key, field] of Object.entries(value)) {
    if (!ENTRY_KEYS.includes(key)) {
      left([key]);
      continue;
    }
    const nestedKeys: readonly string[] | undefined = Object.hasOwn(OPEN_ENTRY_OBJECTS, key)
      ? OPEN_ENTRY_OBJECTS[key as keyof typeof OPEN_ENTRY_OBJECTS]
      : undefined;
    if (nestedKeys === undefined || !isPlainObject(field)) {
      known[key] = field;
      continue;
    }
    const nested: Record<string, unknown> = {};
    for (const [nestedKey, nestedField] of Object.entries(field)) {
      if (nestedKeys.includes(nestedKey)) nested[nestedKey] = nestedField;
      else left([key, nestedKey]);
    }
    known[key] = nested;
  }
  const skippedKinds = skipUnknownFacetKinds(known);
  for (const kind of skippedKinds) left(["facets", kind]);
  return { known, unread, skippedKinds };
}

/**
 * A facet kind this node does not know, in `facets` or `isolations`, is left out and named once as `facets.<kind>`, the
 * same way the manifest reader skips the facet itself (`readPackageManifest`). Nothing else in either list is relaxed: a
 * malformed item, or a known kind with an unknown isolation, still refuses the entry. The entry's `riskTier` is kept as
 * listed, so a skipped facet's lane still counts toward the lane its capabilities are granted in.
 */
function skipUnknownFacetKinds(known: Record<string, unknown>): string[] {
  const skipped = new Set<string>();
  const facets = known["facets"];
  if (Array.isArray(facets)) {
    known["facets"] = facets.filter((kind) => {
      if (!isUnknownFacetKind(kind)) return true;
      skipped.add(kind);
      return false;
    });
  }
  const isolations = known["isolations"];
  if (Array.isArray(isolations)) {
    known["isolations"] = isolations.filter((entry) => {
      const kind = isPlainObject(entry) ? entry["facetKind"] : undefined;
      if (!isUnknownFacetKind(kind)) return true;
      skipped.add(kind);
      return false;
    });
  }
  return [...skipped];
}

/**
 * Read one directory entry the way a node reads an index: tolerant of fields it does not know, strict about every
 * field it does.
 *
 * A directory gains fields over time (`declaredReach`, then `resources`), and an index is shared by nodes of different
 * ages. Refusing an entry for a field this node has never heard of made an older node read the whole directory as
 * unreadable, losing search, updates and installs for every package. So a field outside this schema, at the top of the
 * entry or inside `publisher`, `preview` or `hostApi`, is dropped and reported in `unreadFields`; it is never passed on,
 * so nothing downstream (the marketplace card, the install question) carries a value nobody validated. Every known
 * field is still checked against `directoryEntrySchema` with all its bounds, so a known field with a bad value refuses
 * the entry as before.
 *
 * `unreadFields` exists so what was dropped is said rather than hidden: a field this node does not know may be one the
 * newer directory treats as binding, and a listing shown without it would claim less than the listing says.
 *
 * A facet kind this node does not know is skipped the same way and named as `facets.<kind>`. An entry left with no facet
 * kind this node knows fails with `onlyUnknownFacets`, so an index reader can leave that one listing out (nothing of it
 * could run here) rather than refuse every other listing in the index.
 *
 * Publishing stays strict: `clark widget publish` validates with `directoryEntrySchema`, where an unknown field is a
 * mistake rather than a newer format.
 */
export function readDirectoryEntry(
  candidate: unknown,
):
  | { success: true; data: DirectoryEntry; unreadFields: UnreadEntryFields }
  | { success: false; error: z.ZodError; onlyUnknownFacets?: true } {
  if (!isPlainObject(candidate)) {
    const result = directoryEntrySchema.safeParse(candidate);
    return result.success
      ? { success: true, data: result.data, unreadFields: { names: [], unnamed: 0 } }
      : { success: false, error: result.error };
  }
  const { known, unread, skippedKinds } = splitKnownFields(candidate);
  if (skippedKinds.length > 0 && Array.isArray(known["facets"]) && known["facets"].length === 0) {
    return {
      success: false,
      onlyUnknownFacets: true,
      error: new z.ZodError([
        {
          code: "custom",
          path: ["facets"],
          message: `lists no facet kind this node understands (${skippedKinds.join(", ")})`,
          input: candidate["facets"],
        },
      ]),
    };
  }
  const result = directoryEntrySchema.safeParse(known);
  return result.success ? { success: true, data: result.data, unreadFields: unread } : { success: false, error: result.error };
}

/** The most field names a listing note carries; the count says how many there were in all. */
export const UNREAD_FIELD_NAMES_MAX = 8;

/**
 * What a listing said that this node could not read, as a card, an install question or an update notice shows it:
 * how many fields, and the names of the first few that are plain identifier paths. Names only, never values, and never
 * a name outside `UNREAD_FIELD_PATH_PATTERN`, so a client can show each one as it is.
 */
export const unreadListingFieldsSchema = z
  .strictObject({
    count: z.int().positive(),
    names: z.array(z.string().regex(UNREAD_FIELD_PATH_PATTERN)).max(UNREAD_FIELD_NAMES_MAX),
  })
  .refine((fields) => fields.names.length <= fields.count, { error: "names more fields than it counts" });
export type UnreadListingFields = z.infer<typeof unreadListingFieldsSchema>;

/** The note for what an entry left out, or undefined when the listing had nothing this node could not read. */
export function unreadListingFields(fields: UnreadEntryFields): UnreadListingFields | undefined {
  const count = fields.names.length + fields.unnamed;
  if (count === 0) return undefined;
  return { count, names: fields.names.slice(0, UNREAD_FIELD_NAMES_MAX) };
}
/**
 * The lane a package runs in.
 *
 * The strongest facet wins, because a package is as trusted as its least isolated part: a declarative widget that
 * ships a native tool alongside it is a native package, and listing it as "declarative" would be the kind of
 * labelling that makes a risk tier meaningless.
 */
const LANE_ORDER: readonly RiskLane[] = ["declarative", "isolated-ui", "service", "trusted-native"];

export function riskLaneFor(isolations: readonly z.infer<typeof isolationClassSchema>[]): RiskLane {
  let strongest: RiskLane = "declarative";
  for (const isolation of isolations) {
    if (LANE_ORDER.indexOf(isolation) > LANE_ORDER.indexOf(strongest)) strongest = isolation;
  }
  return strongest;
}

/**
 * Whether a directory entry may be offered to this host.
 *
 * Compatibility is checked here rather than after download, so a listing that cannot run is not shown as one that
 * can. A version mismatch is a refusal with the reason, not a disabled button with none.
 */
export function entryFitsHost(input: {
  entry: Pick<DirectoryEntry, "hostApi" | "platforms">;
  hostApi: number;
  /**
   * Typed as the vocabulary rather than `string`. It was a string with an `as never` at the comparison, which meant
   * the one check standing between a package and the wrong host was the one place the compiler was told to look
   * away — and a raw `win32` from Node sailed through it.
   */
  platform: Platform;
}): { ok: true } | { ok: false; reason: string } {
  if (input.hostApi < input.entry.hostApi.min || input.hostApi > input.entry.hostApi.max) {
    return {
      ok: false,
      reason: `package needs host API ${String(input.entry.hostApi.min)}–${String(input.entry.hostApi.max)}, this host is ${String(input.hostApi)}`,
    };
  }
  if (!input.entry.platforms.includes(input.platform)) {
    // The same reason as the resolver's: naming only the host describes the reader's machine, not the package.
    return {
      ok: false,
      reason: `package is built for ${input.entry.platforms.join(", ")}; this host is ${input.platform}`,
    };
  }
  return { ok: true };
}

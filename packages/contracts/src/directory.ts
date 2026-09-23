import { z } from "zod";

import { facetKindSchema, isolationClassSchema } from "./install.ts";
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

/** The risk lane a facet runs in. Shown to the user, because the three are not equally trusted. */
export const riskLaneSchema = z.enum(["isolated-ui", "service", "declarative", "trusted-native"]);
export type RiskLane = z.infer<typeof riskLaneSchema>;

/**
 * The directory entry.
 *
 * The fields are the ones `docs/widget-development.md` §18 requires. `riskTier` is not derived from the publisher's
 * own claims: it is the strongest lane among the package's facets, because a package is as trusted as its least
 * isolated facet.
 */
export const directoryEntrySchema = z.strictObject({
  packageId: z.string().min(1).max(160),
  version: semverSchema,
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
  riskTier: riskLaneSchema,
  sizeBytes: z.int().nonnegative(),
  /** The digest the publisher published. An install that resolves to anything else is refused. */
  digest: z.string().min(1).max(120),
});
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;

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

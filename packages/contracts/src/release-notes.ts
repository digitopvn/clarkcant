import { z } from "zod";

import { instantSchema, semverSchema } from "./primitives.ts";

/**
 * Release notes as data: what each ClarkCant version changed, embedded with the build so "what's new?" is answered
 * offline, from the same canonical record a GitHub Release is written from.
 *
 * The release tooling (`tools/release/`) generates this record from the exact commit range semantic-release planned,
 * so an entry is always a commit that shipped in that version. Nothing else writes it: a model may summarise the
 * entries in the person's language, but the card draws only what this record holds, and a model can neither add to it
 * nor mint a card that claims to come from it (`changelog-card` is host-owned).
 *
 * Every list is bounded, because the record travels inside the build and into a card: a release with more entries than
 * the bound keeps the newest and counts the rest in `omittedEntries`, and the full list stays in the canonical source.
 */

export { CLARK_REPOSITORY_URL } from "./clark-repository.ts";

/** The channels a release is published on: `main` releases stable versions, `dev` beta prereleases. */
export const RELEASE_CHANNELS = ["stable", "beta"] as const;
export const releaseChannelSchema = z.enum(RELEASE_CHANNELS);
export type ReleaseChannel = z.infer<typeof releaseChannelSchema>;

/**
 * Where the running build came from. `source` is a checkout run from source (`pnpm start:runtime`, Docker built from
 * the repository): it carries the version line of the tree it was built from, not a published release.
 */
export const INSTALLED_CHANNELS = ["stable", "beta", "source"] as const;
export const installedChannelSchema = z.enum(INSTALLED_CHANNELS);
export type InstalledChannel = z.infer<typeof installedChannelSchema>;

/** How an entry is grouped: Breaking, Features, Fixes, Other. */
export const RELEASE_NOTE_KINDS = ["breaking", "feature", "fix", "other"] as const;
export const releaseNoteKindSchema = z.enum(RELEASE_NOTE_KINDS);
export type ReleaseNoteKind = z.infer<typeof releaseNoteKindSchema>;

export const RELEASE_NOTES_BOUNDS = {
  releases: 20,
  entries: 100,
  notes: 40_000,
  artifacts: 40,
  summary: 300,
} as const;

const commitShaSchema = z.string().regex(/^[0-9a-f]{7,40}$/, { error: "must be a git commit id" });
const releaseDateSchema = z.iso.date();

export const releaseNoteEntrySchema = z.strictObject({
  kind: releaseNoteKindSchema,
  /** The commit's description, as written in its Conventional Commit header. */
  summary: z.string().min(1).max(RELEASE_NOTES_BOUNDS.summary),
  scope: z.string().min(1).max(60).optional(),
  commit: commitShaSchema,
});
export type ReleaseNoteEntry = z.infer<typeof releaseNoteEntrySchema>;

/** A verified file a release published. Empty until the signed build stages exist. */
export const releaseArtifactSchema = z.strictObject({
  platform: z.enum(["win32", "darwin", "linux"]),
  arch: z.enum(["x64", "arm64"]),
  /** The package format, such as `msix`, `dmg`, `appimage` or `pacman`. */
  format: z.string().min(1).max(40),
  fileName: z.string().min(1).max(200),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, { error: "must be a SHA-256 digest" }),
});
export type ReleaseArtifact = z.infer<typeof releaseArtifactSchema>;

export const commitRangeSchema = z.strictObject({
  /** The previous release's commit, or `null` when the range starts at the first commit. */
  from: commitShaSchema.nullable(),
  to: commitShaSchema,
});

/**
 * One release.
 *
 * `baseline` is the one record that is not a published release: the history of the source tree before the first
 * release was published. It has no channel and no artifacts, and the card says what it is rather than presenting it
 * as a release someone installed.
 */
export const releaseNotesSchema = z
  .strictObject({
    version: semverSchema,
    kind: z.enum(["release", "baseline"]),
    channel: releaseChannelSchema.optional(),
    date: releaseDateSchema,
    previousVersion: semverSchema.nullable(),
    commitRange: commitRangeSchema,
    /** The release notes as Markdown, as the GitHub Release body carries them. */
    notes: z.string().max(RELEASE_NOTES_BOUNDS.notes),
    entries: z.array(releaseNoteEntrySchema).max(RELEASE_NOTES_BOUNDS.entries),
    /** Release-worthy commits in the range that are not listed in `entries` because of the bound. */
    omittedEntries: z.int().nonnegative(),
    artifacts: z.array(releaseArtifactSchema).max(RELEASE_NOTES_BOUNDS.artifacts),
  })
  .refine((release) => (release.kind === "release") === (release.channel !== undefined), {
    message: "a published release names its channel, and the baseline names none",
    path: ["channel"],
  })
  .refine((release) => release.kind === "release" || release.artifacts.length === 0, {
    message: "the baseline published no artifacts",
    path: ["artifacts"],
  });
export type ReleaseNotes = z.infer<typeof releaseNotesSchema>;

/** The record embedded with a build: what this build is, and the releases up to it, newest first. */
export const releaseHistorySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    build: z.strictObject({ version: semverSchema, channel: installedChannelSchema }),
    /** Where the full, canonical notes live. */
    source: z.url(),
    releases: z.array(releaseNotesSchema).max(RELEASE_NOTES_BOUNDS.releases),
  })
  .refine(
    (history) => history.releases.every((release, index) => index === 0 || compareReleaseVersions(history.releases[index - 1]?.version ?? "", release.version) > 0),
    { message: "releases are listed newest first, each version once", path: ["releases"] },
  );
export type ReleaseHistory = z.infer<typeof releaseHistorySchema>;

/**
 * The changelog as a host-owned card: the installed version and channel, and the releases asked about with their
 * entries. The renderer groups entries by kind and labels everything in the reader's language; the entries themselves
 * are the canonical English commit descriptions.
 *
 * It carries no update action and no update status: those belong to the update service, and a button that could do
 * nothing would be a fake control.
 */
export const changelogCardSchema = z.strictObject({
  type: z.literal("changelog-card"),
  owner: z.literal("host"),
  cardId: z.string().min(1).max(128),
  installed: z.strictObject({ version: semverSchema, channel: installedChannelSchema }),
  /** Present when the person asked what changed after a version. */
  since: semverSchema.optional(),
  /**
   * For a build run from source: the newest commit and date the embedded notes reach. The record is written at release
   * time and never committed back, so a checkout can be ahead of it, and the card says so instead of presenting the
   * notes as the checkout's whole history.
   */
  notesCover: z.strictObject({ commit: commitShaSchema, date: releaseDateSchema }).optional(),
  releases: z
    .array(
      z.strictObject({
        version: semverSchema,
        kind: z.enum(["release", "baseline"]),
        channel: releaseChannelSchema.optional(),
        date: releaseDateSchema,
        previousVersion: semverSchema.nullable(),
        commitRange: commitRangeSchema,
        entries: z.array(releaseNoteEntrySchema).max(RELEASE_NOTES_BOUNDS.entries),
        omittedEntries: z.int().nonnegative(),
      }),
    )
    .max(RELEASE_NOTES_BOUNDS.releases),
  source: z.url(),
  updatedAt: instantSchema,
});
export type ChangelogCard = z.infer<typeof changelogCardSchema>;

/** The changelog as `GET /changelog` answers it: the card's content without the card's identity. */
export const changelogViewSchema = changelogCardSchema.omit({ type: true, owner: true, cardId: true, updatedAt: true });
export type ChangelogView = z.infer<typeof changelogViewSchema>;

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * SemVer 2.0 precedence: negative when `a` is older than `b`, positive when newer, 0 when equal. A string that is not a
 * version sorts before every version, so a malformed value can never be taken for the newest.
 */
export function compareReleaseVersions(a: string, b: string): number {
  const left = VERSION_PATTERN.exec(a);
  const right = VERSION_PATTERN.exec(b);
  if (left === null || right === null) return left === null ? (right === null ? 0 : -1) : 1;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  const leftPre = left[4];
  const rightPre = right[4];
  if (leftPre === undefined || rightPre === undefined) return leftPre === rightPre ? 0 : leftPre === undefined ? 1 : -1;
  const leftParts = leftPre.split(".");
  const rightParts = rightPre.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const l = leftParts[index];
    const r = rightParts[index];
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) return Math.sign(Number(l) - Number(r));
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * A version as a person writes it — `1.4`, `v1.4`, `1.4.0`, `1.5.0-beta.2` — as a full version, or `undefined` when it
 * is not one. A missing minor or patch is 0, so "since 1.4" means after 1.4.0.
 */
export function normalizeReleaseVersion(text: string): string | undefined {
  const match = /^v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(-[0-9A-Za-z.-]{1,60})?$/i.exec(text.trim());
  if (match === null) return undefined;
  if (match[4] !== undefined && match[3] === undefined) return undefined;
  return `${Number(match[1])}.${Number(match[2] ?? 0)}.${Number(match[3] ?? 0)}${match[4] ?? ""}`;
}

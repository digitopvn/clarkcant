/**
 * Release-note records, built from commits semantic-release already classified.
 *
 * Pure and dependency-free: `history.mjs` parses and classifies commits with the real Conventional Commits parser and
 * commit analyzer, and hands this module only commits that release. This module groups them and holds the record to
 * the bounds of `releaseHistorySchema` (`packages/contracts/src/release-notes.ts`), which validates the result.
 */

/** Kept in step with `RELEASE_NOTES_BOUNDS` in the contract; the contract's schema is what refuses a record that is not. */
export const BOUNDS = { releases: 20, entries: 100, notes: 40_000, summary: 300 };

/** Where the full notes live: the repository's releases, and its history for the baseline. */
export const CANONICAL_REPOSITORY = "https://github.com/digitopvn/clarkcant";
export const CANONICAL_SOURCE = `${CANONICAL_REPOSITORY}/releases`;

/**
 * The version every release before the first published one is folded into. `v0.2.1` tags the last commit of that
 * history; the history builder reads it as the baseline, never as a published release.
 */
export const BASELINE_VERSION = "0.2.1";

/**
 * The group an entry is shown in.
 *
 * @param {{ type?: string | null, breaking: boolean }} commit
 * @returns {"breaking" | "feature" | "fix" | "other"}
 */
export function entryKind(commit) {
  if (commit.breaking) return "breaking";
  if (commit.type === "feat") return "feature";
  if (commit.type === "fix" || commit.type === "perf") return "fix";
  return "other";
}

/** A commit's description on one line, within the bound. */
function summaryOf(text) {
  const flat = String(text ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/gu, " ").trim();
  return flat.length <= BOUNDS.summary ? flat : `${flat.slice(0, BOUNDS.summary - 1)}…`;
}

/**
 * Entries for releasing commits, newest first as given, keeping at most `BOUNDS.entries` and counting the rest.
 *
 * @param {{ hash: string, type?: string | null, scope?: string | null, subject?: string | null, header?: string | null, breaking: boolean }[]} commits
 */
export function releaseEntries(commits) {
  const entries = [];
  for (const commit of commits) {
    const summary = summaryOf(commit.subject || commit.header);
    if (summary === "") continue;
    const scope = typeof commit.scope === "string" && commit.scope.trim() !== "" ? commit.scope.trim().slice(0, 60) : undefined;
    entries.push({ kind: entryKind(commit), summary, ...(scope === undefined ? {} : { scope }), commit: commit.hash.slice(0, 12) });
  }
  return { entries: entries.slice(0, BOUNDS.entries), omittedEntries: Math.max(0, entries.length - BOUNDS.entries) };
}

/** Markdown notes within the bound; a cut says where the rest is. */
export function boundNotes(markdown) {
  const text = String(markdown ?? "").trim();
  if (text.length <= BOUNDS.notes) return text;
  const tail = `\n\n…\n\nThe full notes are in ${CANONICAL_SOURCE}.`;
  const cut = text.slice(0, BOUNDS.notes - tail.length);
  return `${cut.slice(0, Math.max(0, cut.lastIndexOf("\n")))}${tail}`;
}

/** `true` for a version with a prerelease part, which only the beta channel publishes. */
export function isPrerelease(version) {
  return /^\d+\.\d+\.\d+-/.test(version);
}

/**
 * One release record.
 *
 * @param {{
 *   version: string,
 *   baseline?: boolean,
 *   date: string,
 *   previousVersion: string | null,
 *   commitRange: { from: string | null, to: string },
 *   notes: string,
 *   commits: Parameters<typeof releaseEntries>[0],
 * }} input
 */
export function releaseRecord(input) {
  const { entries, omittedEntries } = releaseEntries(input.commits);
  const baseline = input.baseline === true;
  return {
    version: input.version,
    kind: baseline ? "baseline" : "release",
    ...(baseline ? {} : { channel: isPrerelease(input.version) ? "beta" : "stable" }),
    date: input.date.slice(0, 10),
    previousVersion: input.previousVersion,
    commitRange: input.commitRange,
    notes: boundNotes(input.notes),
    entries,
    omittedEntries,
    // Filled by the signed build stages once they exist; a record never lists a file that was not published.
    artifacts: [],
  };
}

/**
 * The record embedded with a build: what the build is, and its releases newest first, at most `BOUNDS.releases`.
 *
 * @param {{ version: string, channel: "stable" | "beta" | "source", releases: ReturnType<typeof releaseRecord>[] }} input
 */
export function releaseHistory(input) {
  return {
    schemaVersion: 1,
    build: { version: input.version, channel: input.channel },
    source: CANONICAL_SOURCE,
    releases: input.releases.slice(0, BOUNDS.releases),
  };
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import {
  directoryEntrySchema,
  widgetDevBuildSchema,
  widgetDevGenerationSchema,
  type DirectoryEntry,
} from "@clarkcant/contracts";
import { directoryIndexPath, readDirectoryIndex, type DirectoryIndexState } from "@clarkcant/core";

/**
 * Where a node keeps its live widget authoring sessions, and the directory view they add to.
 *
 * A session's generations are installed through the node's one install path, which finds what it installs in a
 * directory. A package being developed is in no directory the person configured — local development must work with no
 * index, npm or Marketplace — so each session lists its own generations here, and `readNodeDirectory` is the configured
 * index with those listings in front. Everything that resolves an installed package (install, the install question,
 * frame lookup and serving, uninstall) reads that view, so a dev generation is installed, asked about, served and removed
 * exactly like any other package, from the immutable snapshot its listing names.
 *
 * One JSON file, written whole and renamed into place, so a crash leaves the previous file rather than half of one. It
 * survives a restart on purpose: an installed dev generation keeps rendering, and a session that was live resumes.
 */

const storedGenerationSchema = z.strictObject({
  generation: widgetDevGenerationSchema,
  listing: directoryEntrySchema,
});

export const storedDevSessionSchema = z.strictObject({
  sessionId: z.string().min(1).max(200),
  root: z.string().min(1).max(1000),
  status: z.enum(["live", "stopped"]),
  startedAt: z.iso.datetime({ offset: false }),
  conversationId: z.string().min(1).max(200).optional(),
  widgetId: z.string().min(1).max(160).optional(),
  placed: z.strictObject({ conversationId: z.string().min(1).max(200), instanceId: z.string().min(1).max(200) }).optional(),
  /** The generation the node runs, with the install generation id it was activated as. */
  running: storedGenerationSchema.extend({ generationId: z.string().min(1).max(200) }).optional(),
  /** The newest generation, while it is not the running one: being installed, waiting on the person, or refused. */
  pending: storedGenerationSchema
    .extend({
      approvalId: z.string().min(1).max(200).optional(),
      refused: z.strictObject({ code: z.string().min(1).max(80), message: z.string().min(1).max(1000) }).optional(),
    })
    .optional(),
  lastBuild: widgetDevBuildSchema.optional(),
  /**
   * The consent the session's installs were last decided under: the scope (`devConsentScopeOf`), and the approval the
   * person granted for it when the policy asked. A later generation with the same scope installs on that approval; a
   * generation whose scope differs is a new question.
   */
  consent: z
    .strictObject({ scope: z.string().min(1).max(200), approvalId: z.string().min(1).max(200).optional() })
    .optional(),
});
export type StoredDevSession = z.infer<typeof storedDevSessionSchema>;

const storeSchema = z.strictObject({ version: z.literal(1), sessions: z.array(storedDevSessionSchema).max(256) });

export function widgetDevStoreDir(dataDir: string): string {
  return join(dataDir, "widget-dev");
}

function storePath(dataDir: string): string {
  return join(widgetDevStoreDir(dataDir), "sessions.json");
}

/**
 * The stored sessions. A missing file is no sessions. A file that does not parse is reported once per read and read as
 * none, rather than throwing out of every directory read on the node: the installed generations stay installed, and only
 * their dev listings are missing until a session writes the file again.
 */
export function readDevSessions(dataDir: string): StoredDevSession[] {
  let raw: string;
  try {
    raw = readFileSync(storePath(dataDir), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    process.stderr.write(`widget dev: could not read the session store: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    return [];
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    process.stderr.write(`widget dev: the session store is not JSON (${cause instanceof Error ? cause.message : String(cause)}); read as empty\n`);
    return [];
  }
  const parsed = storeSchema.safeParse(json);
  if (!parsed.success) {
    process.stderr.write(`widget dev: the session store does not match its schema; read as empty\n`);
    return [];
  }
  return parsed.data.sessions;
}

export function writeDevSessions(dataDir: string, sessions: readonly StoredDevSession[]): void {
  const dir = widgetDevStoreDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const target = storePath(dataDir);
  const temp = `${target}.${String(process.pid)}.${String(Date.now())}.tmp`;
  writeFileSync(temp, JSON.stringify(storeSchema.parse({ version: 1, sessions }), null, 2));
  renameSync(temp, target);
}

/**
 * The listings the node's sessions add: each session's pending generation first, so an install of it finds the new
 * bytes, then the one it runs, so frames keep being served from it until the new one is active.
 */
export function devListings(dataDir: string): DirectoryEntry[] {
  return readDevSessions(dataDir).flatMap((session) => [
    ...(session.pending === undefined || session.pending.refused !== undefined ? [] : [session.pending.listing]),
    ...(session.running === undefined ? [] : [session.running.listing]),
  ]);
}

/**
 * The directory as this node resolves installed packages: the configured index (`CC_DIRECTORY_INDEX`), with the
 * listings of its widget dev sessions in front. With no index configured and no sessions, the answer is the index's own
 * `not-configured`; an index that cannot be read stays unreadable rather than shrinking to the dev listings.
 */
export function readNodeDirectory(dataDir: string, env: NodeJS.ProcessEnv = process.env): DirectoryIndexState {
  const index = readDirectoryIndex(directoryIndexPath(env));
  const dev = devListings(dataDir);
  if (dev.length === 0 || index.kind === "unreadable") return index;
  if (index.kind === "not-configured") return { kind: "configured", directory: widgetDevStoreDir(dataDir), entries: dev };
  return { ...index, entries: [...dev, ...index.entries] };
}

/**
 * The session whose generations run `packageId@version`, a live one before a stopped one. A stopped session's last
 * generation keeps running until the package is uninstalled, so it is still named: its status says it is no longer
 * watching the folder.
 */
export function devSessionRunning(dataDir: string, packageId: string, version: string): StoredDevSession | undefined {
  const sessions = readDevSessions(dataDir).filter(
    (session) => session.running?.listing.packageId === packageId && session.running.listing.version === version,
  );
  return sessions.find((session) => session.status === "live") ?? sessions.at(-1);
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import {
  directoryEntrySchema,
  turnOriginSchema,
  widgetDevBuildSchema,
  widgetDevGenerationSchema,
  widgetDevStopReasonSchema,
  type DirectoryEntry,
} from "@clarkcant/contracts";
import {
  directoryIndexPath,
  listingKey,
  readDirectory,
  readDirectoryIndex,
  type DirectoryIndexState,
  type DirectoryOrigin,
} from "@clarkcant/core";

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

/** The most sessions one node keeps, live and stopped. */
export const WIDGET_DEV_STORE_MAX = 256;
/** The most snapshot digests one session remembers making, so it can remove the ones nothing runs any more. */
export const WIDGET_DEV_SNAPSHOTS_MAX = 64;

export const storedDevSessionSchema = z.strictObject({
  sessionId: z.string().min(1).max(200),
  root: z.string().min(1).max(1000),
  status: z.enum(["live", "stopped"]),
  stopReason: widgetDevStopReasonSchema.optional(),
  /** With `root-refused`, the code the start check refused the folder with when the node started again. */
  stopCode: z.string().min(1).max(80).optional(),
  /**
   * Who started the session, which is whose intent its installs carry out: the person on their own surface, or Clark
   * during a turn (with the turn's origin), whose installs the policy decides as Clark's own proposal.
   */
  initiative: z
    .discriminatedUnion("kind", [z.strictObject({ kind: z.literal("person") }), z.strictObject({ kind: z.literal("clark"), origin: turnOriginSchema.optional() })])
    .optional(),
  /**
   * The person chose this folder for widget development on their own surface: they started a session here. It stays set
   * when Clark picks the session up again, and it is what lets a session Clark starts watch this folder (and folders
   * inside it). Only a start the person made sets it; nothing Clark, a widget or a machine surface does can.
   */
  chosenByPerson: z.literal(true).optional(),
  /**
   * Which folder the person chose (`chosenByPerson`): its device and file id when they chose it, as decimal strings. The
   * choice counts only while that same folder is at `root`, so a folder made at the path later, after the chosen one was
   * moved or removed, is not taken for it. A mark stored before this was kept has none; it takes the id of the folder
   * found at its path the first time it is looked at (`markedFolders`).
   */
  chosenFolderId: z.strictObject({ dev: z.string().regex(/^\d{1,40}$/), ino: z.string().regex(/^\d{1,40}$/) }).optional(),
  /** Snapshot digests this session made in the package cache, so the ones nothing runs or waits on can be removed. */
  snapshots: z.array(z.string().min(1).max(120)).max(WIDGET_DEV_SNAPSHOTS_MAX).optional(),
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

const storeSchema = z.strictObject({ version: z.literal(1), sessions: z.array(storedDevSessionSchema).max(WIDGET_DEV_STORE_MAX) });

export function widgetDevStoreDir(dataDir: string): string {
  return join(dataDir, "widget-dev");
}

/**
 * The folder Clark owns for widgets it scaffolds itself. Besides the folders the person chose, it is the one place a
 * session Clark starts may watch; nothing else under the data folder may be developed.
 */
export function widgetWorkspaceDir(dataDir: string): string {
  return join(dataDir, "widget-workspace");
}

function storePath(dataDir: string): string {
  return join(widgetDevStoreDir(dataDir), "sessions.json");
}

/**
 * A store file that cannot be read as one is moved aside under a name of its own, so the next write starts a new file
 * instead of overwriting what may be recovered by hand. Said once, with where it went.
 */
function setAside(path: string, why: string): void {
  const aside = `${path}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    renameSync(path, aside);
    process.stderr.write(`widget dev: the session store ${why}; it was moved to ${aside} and the node starts with no sessions\n`);
  } catch (cause) {
    process.stderr.write(
      `widget dev: the session store ${why}, and it could not be moved aside (${cause instanceof Error ? cause.message : String(cause)}); read as empty\n`,
    );
  }
}

/**
 * The stored sessions. A missing file is no sessions. A file that does not parse is moved aside (`setAside`) and read as
 * none, rather than throwing out of every directory read on the node: the installed generations stay installed, and only
 * their dev listings are missing until a session writes the file again.
 */
export function readDevSessions(dataDir: string): StoredDevSession[] {
  const path = storePath(dataDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    process.stderr.write(`widget dev: could not read the session store: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    return [];
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    setAside(path, `is not JSON (${cause instanceof Error ? cause.message : String(cause)})`);
    return [];
  }
  const parsed = storeSchema.safeParse(json);
  if (!parsed.success) {
    setAside(path, "does not match its schema");
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
 * The source every dev listing names. Like any other source, it is recorded on what is installed from it and checked by
 * the install path, so an install from a row that named another source (a marketplace card) never takes a session's
 * build of the same id and version, and a session's own install names this source to take its build.
 */
export const WIDGET_DEV_DIRECTORY_SOURCE: DirectoryOrigin = {
  id: "widget-dev",
  kind: "widget-dev",
  label: "this node's widget dev sessions",
};

/**
 * The directory as this node resolves installed packages: every configured source (`readDirectory`), with the listings
 * of its widget dev sessions in front, each owned by `WIDGET_DEV_DIRECTORY_SOURCE`. With no source configured and no
 * sessions, the answer is the directory's own `not-configured`. The person's own index file that cannot be read keeps
 * the directory unreadable rather than shrinking to the dev listings; remote sources that have nothing to list yet (never
 * fetched, unreachable) do not hide a session's generations, since local development must work without any marketplace.
 */
export function readNodeDirectory(dataDir: string, env: NodeJS.ProcessEnv = process.env): DirectoryIndexState {
  const index = readDirectory({ env, dataDir });
  const dev = devListings(dataDir);
  if (dev.length === 0) return index;
  const devOrigins = dev.map((entry): [string, DirectoryOrigin] => [listingKey(entry), WIDGET_DEV_DIRECTORY_SOURCE]);
  if (index.kind === "not-configured") {
    return { kind: "configured", directory: widgetDevStoreDir(dataDir), entries: dev, origins: new Map(devOrigins) };
  }
  if (index.kind === "unreadable") {
    const indexPath = directoryIndexPath(env);
    if (indexPath !== undefined && readDirectoryIndex(indexPath).kind !== "configured") return index;
    return {
      kind: "configured",
      directory: index.directory,
      entries: dev,
      origins: new Map(devOrigins),
      ...(index.sources === undefined ? {} : { sources: index.sources }),
    };
  }
  // The dev listings come first, so the same listing key is the session's: the entry found first is the one it names.
  return { ...index, entries: [...dev, ...index.entries], origins: new Map([...(index.origins ?? []), ...devOrigins]) };
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

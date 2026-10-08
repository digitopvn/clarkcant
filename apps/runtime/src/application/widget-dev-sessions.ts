import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  WIDGET_DEV_ALLOWED_ISOLATIONS,
  messageBlockSchema,
  nowInstant,
  type CommandCard,
  type MessageBlock,
  type PackageManifest,
  type TurnOrigin,
  type WidgetDevActivation,
  type WidgetDevSessionView,
  type WidgetDevStopReason,
  type WidgetDevTrigger,
} from "@clarkcant/contracts";
import {
  activeGeneration,
  cachedLocalSnapshotPath,
  devConsentScopeOf,
  devRootState,
  getPreference,
  pinInstance,
  readDirectory,
  readPackage,
  startDevEngine,
  type DevEngine,
  type DevGenerationRecord,
  type ExecutionIntent,
} from "@clarkcant/core";
import { allRows, oneRow, parseJson } from "@clarkcant/storage";

import { hostText, ownerLocale } from "../host-text.ts";
import { containingRoot, ownedResources } from "../preflight.ts";
import { appendHostReply } from "../routes/conversations.ts";
import { type NodeServices } from "../services.ts";
import { placeWidget } from "../widget-perform-tool.ts";
import { installPackage, packageInstallDepsOf, type ApprovedInstall } from "./package-install.ts";
import { developFolderCard, type ProposedFolder } from "./widget-dev-card.ts";
import {
  WIDGET_DEV_DIRECTORY_SOURCE,
  WIDGET_DEV_SNAPSHOTS_MAX,
  WIDGET_DEV_STORE_MAX,
  readDevSessions,
  widgetWorkspaceDir,
  writeDevSessions,
  type StoredDevSession,
} from "./widget-dev-store.ts";

/**
 * A node's live widget authoring sessions: a package folder on this machine, watched, each good build installed through
 * the node's one install path, and the running generation shown in the conversation's own widget frame.
 *
 * There is no development lane. A generation is installed exactly like any other local package — from an immutable
 * snapshot, decided by the execution policy, asked about in the inbox when the policy asks — and served by the same
 * frame route, in the same sandbox. What a session adds is the consent scope (`devConsentScopeOf`): one decision covers
 * every generation that reaches exactly what the decided one did, so a save that changes only code inside that reach
 * activates on its own, while any change to what the package may reach is a new question to the policy.
 *
 * Whose intent the installs carry out is the session's initiative. A session the person starts on their own surface
 * installs as their request, for any folder on the node outside its data folder. A session Clark starts during a turn
 * installs as Clark's own proposal (`proposed`), so a mode that asks before what the person did not ask for by name asks,
 * and it may watch only Clark's own widget workspace (`widgetWorkspaceDir`), a folder the person chose for widget
 * development by starting a session there themselves (`chosenFolders`), or a folder inside a `workspace.roots` value the
 * person recorded themselves (`configuredRoots`). For any other folder Clark offers the person a card to choose it
 * (`folderCard`); the press on it starts the session on the person's own surface. A turn a machine surface, an
 * automation or a peer sent starts nothing.
 *
 * Phases 1–2 run only packages whose facets stay in the widget frame or are data (`WIDGET_DEV_ALLOWED_ISOLATIONS`); a
 * package with a service, tools or native facet is a failed build saying so.
 *
 * A build that fails, or a generation the policy has not let run, leaves the running generation where it is, and the
 * session says so (`showingLastKnownGood`) instead of presenting older code as the current files.
 */

/** The most sessions that watch folders at once on one node. */
export const WIDGET_DEV_LIVE_MAX = 8;

export type WidgetDevServices = Pick<NodeServices, "runtime" | "conductor" | "search" | "serviceHost" | "browserTokens">;

export type WidgetDevResult<T> = { ok: true; value: T } | { ok: false; status: number; code: string; message: string };

/** Who starts a session: the person on their own surface, or Clark during a turn with the turn's origin. */
export type WidgetDevInitiative = { kind: "person" } | { kind: "clark"; origin?: TurnOrigin };

export interface WidgetDevSessions {
  start(input: {
    root: string;
    conversationId?: string;
    widgetId?: string;
    /** Absent is the person. */
    initiative?: WidgetDevInitiative;
  }): Promise<WidgetDevResult<WidgetDevSessionView>>;
  /** What the node knows about a session now. Reading changes nothing: it neither builds nor installs. */
  get(sessionId: string): WidgetDevSessionView | undefined;
  list(): WidgetDevSessionView[];
  rebuild(sessionId: string): Promise<WidgetDevResult<WidgetDevSessionView>>;
  stop(sessionId: string): Promise<WidgetDevResult<WidgetDevSessionView>>;
  /**
   * Place the session's widget in a conversation. `messageId` is the message a turn is answering with, when a turn
   * places it; left out, the node writes its own reply to carry the widget.
   */
  place(
    sessionId: string,
    input: { conversationId: string; widgetId?: string; messageId?: string },
  ): Promise<WidgetDevResult<{ session: WidgetDevSessionView; text: string; hostBlocks: Record<string, unknown>[] }>>;
  /** The folder Clark may scaffold widgets in, created when missing. */
  workspace(): string;
  /**
   * The host-owned card a person chooses a folder to develop on (`developFolderCard`), offering `proposed` first, in
   * `locale` (the owner's language when left out).
   */
  folderCard(input: { proposed?: string; locale?: "vi" | "en"; only?: "chosen" }): CommandCard;
  /** The folders the person chose that Clark may develop in now (`chosenFolders`), as canonical paths. */
  chosen(): string[];
  /**
   * Every folder the person chose, with whether it is found at its path now (`markedFolders`): one that is missing, or
   * now leads elsewhere, grants nothing, but is still listed so the person can forget it.
   */
  marked(): { root: string; found: boolean }[];
  /**
   * Take back the person's choice of a folder: it no longer lets Clark start sessions in it, or in a folder inside it.
   * `stillCoveredBy` names a folder Clark may still develop in that holds it, when there is one. Only the person's own
   * surface calls this (the route is person-only). Sessions there, and what they run, stay as they are.
   */
  forget(root: string): WidgetDevResult<{ root: string; forgotten: boolean; stillCoveredBy?: string }>;
  /** Start watching again every session that was live when the node stopped. */
  resume(): Promise<void>;
  /**
   * Stop watching every folder, then wait for the work each session already started (a build being followed, a
   * superseded snapshot being removed) to finish, for at most `closeWaitMs`, so the caller can let go of the database and
   * the data folder without pulling them from under a removal. Past the bound it resolves anyway: a shutdown never hangs.
   * It never rejects. Once called, nothing new is watched: a later `start` is refused and a `resume` still going stops.
   */
  close(): Promise<void>;
}

/** How often a session waiting on the person's answer looks for it, so an approval in the inbox is followed promptly. */
const ANSWER_POLL_MS = 2_000;

/**
 * How a superseded snapshot is removed: the promise form of `rm`, retrying a file still held open (on Windows) after 100,
 * 200, 300, 400 and 500 ms, about 1.5 s in all.
 */
export const SNAPSHOT_REMOVAL = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

/**
 * The longest `close` waits for work already started: one snapshot's removal with all its retries, with room to spare,
 * and well inside the node's shutdown grace. One removal is all it has to cover: once `close` is called a prune starts
 * no further removal, so a session with several held snapshots left over waits only for the one in flight, and the rest
 * stay on its list for the next prune after an install.
 */
export const WIDGET_DEV_CLOSE_WAIT_MS = 2_000;

interface LiveSession {
  sessionId: string;
  engine: DevEngine;
  answerPoll: ReturnType<typeof setInterval>;
  /** The manifest of the running generation, read from its snapshot, which a new generation's delta is compared with. */
  baseline: PackageManifest | undefined;
}

/** Stop a session's answer poll and its engine. An engine that fails to let go is said, never thrown: the others still end. */
function end(session: LiveSession): void {
  clearInterval(session.answerPoll);
  try {
    session.engine.close();
  } catch (cause) {
    process.stderr.write(`widget dev: ${session.sessionId} could not stop watching: ${messageOf(cause)}\n`);
  }
}

const refusal = (status: number, code: string, message: string) => ({ ok: false as const, status, code, message });

function sameRoot(a: string, b: string): boolean {
  return process.platform === "win32" || process.platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function manifestAt(path: string): PackageManifest | undefined {
  try {
    const pkg = readPackage(path);
    return pkg.problems.length === 0 ? pkg.manifest : undefined;
  } catch {
    return undefined;
  }
}

/** A canonical path, or undefined when it does not exist (or cannot be resolved). */
function realOrUndefined(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

type ChosenFolderId = NonNullable<StoredDevSession["chosenFolderId"]>;

/** The device and file id of the folder at `path` itself, not reached through a link, or undefined when none is there. */
function folderIdOf(path: string): ChosenFolderId | undefined {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isDirectory() ? { dev: String(stat.dev), ino: String(stat.ino) } : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the folder at `root` is still the one with `id` (`devRootState`, as a dev session watches its folder). */
const isFolder = (root: string, id: ChosenFolderId): boolean => devRootState(root, { dev: BigInt(id.dev), ino: BigInt(id.ino) }) === "present";

/** A Windows path that names another machine or a device rather than a folder on a local drive. */
function isRemoteOrDevicePath(path: string): boolean {
  return process.platform === "win32" && /^[\\/]{2}/.test(path);
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export function createWidgetDevSessions(
  services: () => WidgetDevServices,
  options: {
    /** `false` builds only on start and `rebuild`, for a caller that drives builds itself (tests). */
    watch?: boolean;
    /** How often a session waiting on an answer looks for it. */
    answerPollMs?: number;
    /** How long a folder may keep failing to be looked at before its session stops (`DEV_ENGINE_ROOT_UNREADABLE_MS`). */
    rootUnreadableMs?: number;
    /** The longest `close` waits for work already started (`WIDGET_DEV_CLOSE_WAIT_MS`). */
    closeWaitMs?: number;
  } = {},
): WidgetDevSessions {
  const live = new Map<string, LiveSession>();
  /**
   * Set by `close`: nothing watches a folder again, neither a late start nor a resume still going through the store, and
   * no prune starts another removal. A session left reading as live in the store is resumed at the next boot.
   */
  let closed = false;
  /** One chain per session: builds, approvals and placement of one session never interleave. */
  const chains = new Map<string, Promise<unknown>>();

  const serial = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const previous = chains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(work, work);
    chains.set(
      sessionId,
      next.catch(() => undefined),
    );
    return next;
  };

  const dataDir = (): string => services().runtime.dataDir;
  const cacheRoot = (): string => join(dataDir(), "package-cache");
  const read = (sessionId: string): StoredDevSession | undefined =>
    readDevSessions(dataDir()).find((session) => session.sessionId === sessionId);
  const update = (sessionId: string, change: (session: StoredDevSession) => StoredDevSession): StoredDevSession | undefined => {
    const sessions = readDevSessions(dataDir());
    const index = sessions.findIndex((session) => session.sessionId === sessionId);
    const current = sessions[index];
    if (current === undefined) return undefined;
    const next = change(current);
    sessions[index] = next;
    writeDevSessions(dataDir(), sessions);
    return next;
  };

  const workspace = (): string => {
    const dir = widgetWorkspaceDir(dataDir());
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  /** The approval row, read as the inbox reads it: a pending one past its deadline is expired. */
  const approvalState = (approvalId: string): { decision: string; operationDigest: string } | undefined => {
    const row = oneRow<{ decision: string; operation_digest: string; expires_at: string }>(
      services().runtime.db,
      "SELECT decision, operation_digest, expires_at FROM approvals WHERE approval_id = ?",
      approvalId,
    );
    if (row === undefined) return undefined;
    const decision = row.decision === "pending" && row.expires_at <= nowInstant() ? "expired" : row.decision;
    return { decision, operationDigest: row.operation_digest };
  };

  const installDeps = () => {
    const node = services();
    return { db: node.runtime.db, nodeId: node.runtime.identity.nodeId, now: nowInstant, newId: node.conductor.newId };
  };

  const conversationExists = (conversationId: string): boolean =>
    oneRow<{ found: number }>(services().runtime.db, "SELECT 1 AS found FROM conversations WHERE conversation_id = ?", conversationId) !== undefined;
  const noConversation = (conversationId: string) => refusal(404, "CONVERSATION_NOT_FOUND", `there is no conversation ${conversationId} on this node`);

  /**
   * The folder a session may watch, as its canonical path, or why not.
   *
   * Local folders only: a Windows share or device path is refused. Nothing that holds the node's data folder, or lies
   * inside it, may be watched, except Clark's widget workspace: the package cache, the session store and the database
   * live there, and a session that watched them would build from its own snapshots. A session Clark starts may watch only
   * that workspace, folders the person chose for widget development (`chosenFolders`) and folders inside a root the
   * person recorded themselves (`configuredRoots`), so a model cannot point the node's install path at an arbitrary
   * folder. A session the person starts on their own surface (the REST route, as the owner) may name any other local
   * folder.
   */
  const checkRoot = (raw: string, initiative: { kind: WidgetDevInitiative["kind"] }): WidgetDevResult<string> => {
    const given = raw.trim();
    if (!isAbsolute(given)) return refusal(400, "ROOT_NOT_ABSOLUTE", "give the package folder as an absolute path on this node");
    if (isRemoteOrDevicePath(given)) {
      return refusal(400, "ROOT_NOT_LOCAL", "give a folder on a drive of this machine; a network share or device path is not developed from");
    }
    const resolved = resolve(given);
    // Only "not found" means not there: a folder an antivirus or indexer holds (`EPERM`, `EBUSY`) is there, unreadable.
    const unreadable = (cause: unknown) => {
      const code = (cause as NodeJS.ErrnoException).code;
      return code !== undefined && code !== "ENOENT" && code !== "ENOTDIR"
        ? refusal(403, "ROOT_UNREADABLE", `${resolved} cannot be read on this node (${code})`)
        : undefined;
    };
    try {
      if (!statSync(resolved).isDirectory()) return refusal(400, "ROOT_NOT_A_FOLDER", `${resolved} is not a folder`);
    } catch (cause) {
      return unreadable(cause) ?? refusal(404, "ROOT_NOT_FOUND", `${resolved} does not exist on this node`);
    }
    let root: string;
    try {
      root = realpathSync.native(resolved);
    } catch (cause) {
      return unreadable(cause) ?? refusal(404, "ROOT_NOT_FOUND", `${resolved} could not be resolved on this node`);
    }
    if (isRemoteOrDevicePath(root)) {
      return refusal(400, "ROOT_NOT_LOCAL", "the folder resolves to a network share or device path, which is not developed from");
    }
    const data = realOrUndefined(dataDir()) ?? resolve(dataDir());
    const widgetWorkspace = resolve(data, "widget-workspace");
    const inWorkspace = containingRoot(ownedResources([widgetWorkspace]), root) !== undefined;
    if (containingRoot(ownedResources([root]), data) !== undefined || (containingRoot(ownedResources([data]), root) !== undefined && !inWorkspace)) {
      return refusal(400, "ROOT_IN_DATA_FOLDER", "the folder holds or lies inside this node's data folder, which is not developed from; use a project folder");
    }
    if (initiative.kind === "clark" && !inWorkspace) {
      // The person's configured roots are resolved as they are now; a chosen folder is the canonical path the person's
      // start stored, compared as it is, and only while the same folder is there (`chosenFolders`), so neither a link
      // swapped in at its path later nor another folder made there widens anything.
      const allowed = [
        ...configuredRoots()
          .map((path) => realOrUndefined(path))
          .filter((path): path is string => path !== undefined),
        ...chosenFolders(),
      ];
      if (containingRoot(ownedResources(allowed), root) === undefined) {
        return refusal(403, "ROOT_NOT_OWNED", hostText(ownerLocale(services().runtime)).approvals.devSessionRootNotOwned(root, widgetWorkspace));
      }
    }
    return { ok: true, value: root };
  };

  /**
   * The folders the person recorded themselves for their projects: a `workspace.roots` preference whose source is the
   * person (`user` or `onboarding`). The built-in default, the home folder and the drive the node runs from, is not a
   * choice the person made, and a value Clark wrote is not one either: neither lets Clark watch a folder. No surface
   * writes such a value today, so this is normally empty; the folders the person chooses are `chosenFolders`.
   */
  const configuredRoots = (): string[] => {
    const runtime = services().runtime;
    const record = getPreference(
      { db: runtime.db, now: nowInstant },
      { principalId: runtime.identity.ownerPrincipalId, key: "workspace.roots", scope: "global" },
    );
    if (record === undefined || (record.source !== "user" && record.source !== "onboarding") || !Array.isArray(record.value)) return [];
    return record.value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "" && isAbsolute(entry.trim())).map((entry) => entry.trim());
  };

  /**
   * The folders the person chose for widget development: the folder of every session they started on their own surface
   * (`chosenByPerson`), live or stopped. Only the person-only start writes that mark, so no turn, widget or machine
   * surface can add a folder here; a session the store forgets takes its folder with it.
   */
  const chosenFolders = (): string[] => markedFolders().filter((folder) => folder.found).map((folder) => folder.root);

  /**
   * Every folder marked as chosen, once each. The stored root is the canonical path the person's start resolved, and the
   * stored id (`chosenFolderId`) is the folder that was there. A path that now resolves anywhere else (it was replaced by
   * a link, moved or removed), or that holds another folder (one made there after the chosen one went), is not `found`,
   * and so grants nothing (`chosenFolders`), but it is still the person's mark to see and forget. The chosen folder moved
   * back to its path is found again.
   *
   * A mark stored before ids were kept has none. It takes the id of the folder found at its path the first time one is,
   * and is held to that folder from then on: until then there is no record of which folder was chosen.
   */
  const markedFolders = (): { root: string; found: boolean }[] => {
    const sessions = readDevSessions(dataDir());
    const folders: { root: string; found: boolean }[] = [];
    const adopted = new Map<string, ChosenFolderId>();
    for (const session of sessions) {
      if (session.chosenByPerson !== true) continue;
      const now = realOrUndefined(session.root);
      let found = false;
      if (now !== undefined && sameRoot(now, session.root)) {
        if (session.chosenFolderId !== undefined) found = isFolder(session.root, session.chosenFolderId);
        else {
          const id = folderIdOf(session.root);
          if (id !== undefined) adopted.set(session.sessionId, id);
          found = id !== undefined;
        }
      }
      const listed = folders.find((folder) => sameRoot(folder.root, session.root));
      if (listed === undefined) folders.push({ root: session.root, found });
      else listed.found ||= found;
    }
    if (adopted.size > 0) {
      writeDevSessions(
        dataDir(),
        sessions.map((session) => {
          const id = adopted.get(session.sessionId);
          return id === undefined ? session : { ...session, chosenFolderId: id };
        }),
      );
    }
    return folders;
  };

  /**
   * Whether a folder is too broad to keep as a choice: a filesystem or drive root, or the person's home folder itself. A
   * session there may still run, but its start leaves no lasting choice behind, since a choice covers every folder inside.
   */
  const broadFolder = (root: string): "drive" | "home" | undefined => {
    if (dirname(root) === root) return "drive";
    const home = realOrUndefined(homedir()) ?? resolve(homedir());
    return sameRoot(root, home) ? "home" : undefined;
  };

  /**
   * The person's start chooses its folder only when the path they pressed is the folder itself, as it resolves now. A card
   * always carries the canonical path it showed; if that path leads somewhere else by the time of the press (a link
   * swapped in, or a missing folder made a link), the session runs but nothing is kept, so the person never approves one
   * folder and grants another. A folder too broad to keep (`broadFolder`) is never chosen either.
   *
   * What it keeps is the id of the folder at `root` (`folderIdOf`), read right after `checkRoot` resolved it, so the mark
   * names that folder and no other made at the path later; with no folder of its own there by then, nothing is kept.
   */
  const choiceOf = (initiative: WidgetDevInitiative, root: string, pressed: string): ChosenFolderId | undefined =>
    initiative.kind === "person" && sameRoot(resolve(pressed.trim()), root) && broadFolder(root) === undefined ? folderIdOf(root) : undefined;

  const viewOf = (stored: StoredDevSession): WidgetDevSessionView => {
    const session = live.get(stored.sessionId);
    const latest = session?.engine.latest()?.generation ?? stored.pending?.generation ?? stored.running?.generation;
    const lastBuild = session?.engine.lastBuild() ?? stored.lastBuild;
    const { pending, running } = stored;
    let activation: WidgetDevActivation;
    if (pending?.refused !== undefined) {
      activation = { state: "refused", generation: pending.generation.generation, code: pending.refused.code, message: pending.refused.message };
    } else if (pending?.approvalId !== undefined) {
      activation = { state: "awaiting-approval", generation: pending.generation.generation, approvalId: pending.approvalId };
    } else if (running !== undefined) {
      activation = { state: "active", generation: running.generation.generation, generationId: running.generationId };
    } else {
      activation = { state: "none" };
    }
    const behind = running !== undefined && (lastBuild?.ok === false || (latest !== undefined && latest.digest !== running.generation.digest));
    return {
      sessionId: stored.sessionId,
      status: stored.status,
      ...(stored.status === "stopped" && stored.stopReason !== undefined ? { stopReason: stored.stopReason } : {}),
      root: stored.root,
      ...(latest === undefined ? {} : { packageId: latest.packageId, version: latest.version, latest }),
      startedAt: stored.startedAt,
      ...(running === undefined ? {} : { running: running.generation }),
      activation,
      ...(lastBuild === undefined ? {} : { lastBuild }),
      showingLastKnownGood: behind,
      ...(stored.placed === undefined ? {} : { placed: stored.placed }),
      ...(stored.chosenByPerson === true ? { chosenByPerson: true as const } : {}),
    };
  };

  /**
   * Place the session's widget, once a generation runs and nothing is placed yet. A turn passes the message it answers
   * with; otherwise the node writes a reply of its own that carries the widget, so the widget is in the conversation's
   * history like any placed one. The placed widget is pinned open so it stays in view while the author works.
   */
  const placeNow = (
    stored: StoredDevSession,
    input: { conversationId: string; widgetId?: string; messageId?: string },
  ): { ok: true; text: string; hostBlocks: Record<string, unknown>[]; instanceId: string } | { ok: false; status: number; code: string; message: string } => {
    const running = stored.running;
    if (running === undefined) return refusal(409, "NOT_ACTIVE", "no generation of this package is running yet, so there is nothing to place");
    const widgetId = input.widgetId ?? stored.widgetId ?? running.generation.widgetIds[0];
    if (widgetId === undefined || !running.generation.widgetIds.includes(widgetId)) {
      return refusal(400, "NO_SUCH_WIDGET", `${running.generation.packageId} declares no widget ${widgetId ?? ""}`.trim());
    }
    const node = services();
    const messageId = input.messageId ?? node.conductor.newId("msg");
    const placed = placeWidget(node, { messageId: () => messageId }, { widgetId });
    if (placed.instanceId === undefined) return refusal(409, "NOT_PLACED", placed.text);
    if (input.messageId === undefined) {
      const blocks: MessageBlock[] = [];
      for (const block of placed.hostBlocks ?? []) {
        const parsed = messageBlockSchema.safeParse(block);
        if (parsed.success) blocks.push(parsed.data);
      }
      appendHostReply(node, { conversationId: input.conversationId, blocks, at: nowInstant(), messageId });
    }
    const pinned = pinInstance(node.conductor, { conversationId: input.conversationId, instanceId: placed.instanceId, displayMode: "expanded" });
    const pinNote = pinned.ok ? "" : ` It was not pinned open: ${pinned.message}.`;
    return { ok: true, text: `${placed.text}${pinNote}`, hostBlocks: placed.hostBlocks ?? [], instanceId: placed.instanceId };
  };

  /**
   * Bring what the node runs for a session up to its newest generation, as far as the policy allows. Called after every
   * build, by the answer poll while a question waits, and by an explicit start, rebuild or place; never by a read.
   */
  const settle = async (sessionId: string, trigger: WidgetDevTrigger | "answer"): Promise<void> => {
    await follow(sessionId, trigger);
    placeIfDue(sessionId);
  };

  /** Place the widget in the session's conversation the first time a generation of it runs, when one was named. */
  const placeIfDue = (sessionId: string): void => {
    const stored = read(sessionId);
    if (stored?.placed !== undefined || stored?.conversationId === undefined || stored.running === undefined) return;
    const conversationId = stored.conversationId;
    const placed = placeNow(stored, { conversationId, ...(stored.widgetId === undefined ? {} : { widgetId: stored.widgetId }) });
    if (placed.ok) {
      update(sessionId, (current) => ({ ...current, placed: { conversationId, instanceId: placed.instanceId } }));
      return;
    }
    // Said once and dropped: the session keeps running, and placing it again by hand reports the reason too.
    update(sessionId, ({ conversationId: _unplaced, ...rest }) => rest);
    process.stderr.write(`widget dev: could not place ${sessionId}'s widget: ${placed.message}\n`);
  };

  const follow = async (sessionId: string, trigger: WidgetDevTrigger | "answer"): Promise<void> => {
    let stored = read(sessionId);
    if (stored === undefined) return;
    const session = live.get(sessionId);

    // A question the person has answered since the last look.
    const asked = stored.pending;
    if (asked?.approvalId !== undefined && asked.refused === undefined) {
      const approval = approvalState(asked.approvalId);
      if (approval?.decision === "pending") return;
      const scope = devConsentScopeOf(asked.listing);
      if (approval?.decision === "granted" && approval.operationDigest === scope) {
        const active = activeGeneration(installDeps(), asked.listing.packageId, services().runtime.identity.nodeId);
        const approvalId = asked.approvalId;
        stored = update(sessionId, (current) => {
          const { pending: _answered, ...rest } = current;
          // Installed by the inbox's decision: what runs is the generation that was asked about.
          if (active?.snapshotDigest === asked.generation.digest) {
            return { ...rest, running: { generation: asked.generation, listing: asked.listing, generationId: active.generationId }, consent: { scope, approvalId } };
          }
          // Granted, and not installed (yet): the approval covers this scope, and the newest generation installs on it below.
          return { ...rest, consent: { scope, approvalId } };
        });
        if (session !== undefined && active?.snapshotDigest === asked.generation.digest) {
          session.baseline = manifestAt(asked.listing.source.kind === "local" ? asked.listing.source.path : "");
          await prune(sessionId);
        }
      } else {
        const denied = approval?.decision === "denied";
        const said = hostText(ownerLocale(services().runtime)).approvals;
        stored = update(sessionId, (current) =>
          current.pending === undefined
            ? current
            : {
                ...current,
                pending: {
                  ...current.pending,
                  refused: denied ? { code: "APPROVAL_DENIED", message: said.devBuildDenied } : { code: "APPROVAL_EXPIRED", message: said.devBuildExpired },
                },
              },
        );
      }
      if (stored === undefined) return;
    }

    const latest: DevGenerationRecord | undefined = session?.engine.latest();
    if (latest === undefined || stored.status !== "live") return;
    if (stored.running?.generation.digest === latest.generation.digest) {
      if (stored.pending !== undefined) update(sessionId, ({ pending: _superseded, ...rest }) => rest);
      return;
    }
    // Asked about already and waiting, or refused and not asked for again: the running generation stays.
    if (stored.pending?.approvalId !== undefined && stored.pending.refused === undefined) return;
    if (stored.pending?.generation.digest === latest.generation.digest && stored.pending.refused !== undefined && trigger !== "rebuild") return;

    await activate(sessionId, latest);
  };

  /**
   * A generation that reaches more than the one it replaced, and that the policy ran without anybody being asked, is
   * said in the session's conversation with what it added. The policy decided, as it does for any install; this only
   * keeps a wider reach from being taken in silence.
   */
  const sayWidened = (stored: StoredDevSession, latest: DevGenerationRecord): void => {
    const { delta } = latest.generation;
    const conversationId = stored.placed?.conversationId ?? stored.conversationId;
    if (delta.verdict !== "wider" || conversationId === undefined) return;
    const added = [
      ...delta.capabilities.added,
      ...delta.frameOrigins.added,
      ...delta.permissions.added,
      ...delta.facets.added,
      // The reach comparison (origins, secrets, tokens, connections, resources) is named as one item; its detail is on the session.
      ...(delta.reach === undefined ? [] : ["declared reach"]),
    ];
    const text = hostText(ownerLocale(services().runtime)).approvals.devSessionWidened(
      latest.listing.displayName,
      latest.generation.generation,
      added.join(", "),
    );
    try {
      appendHostReply(services(), { conversationId, text, at: nowInstant() });
    } catch (cause) {
      process.stderr.write(`widget dev: could not say that ${latest.listing.packageId} widened: ${messageOf(cause)}\n`);
    }
  };

  /**
   * Why a session may not install this package id, when it may not: the id belongs to something else on the node.
   *
   * A dev listing is put in front of the configured index, so a session that took an id the index lists, another session
   * runs, or a package installed the ordinary way would change what that install resolves to and pick up an approval the
   * person gave for another folder. Such a build is refused with the reason, and nothing is installed or listed.
   */
  const idConflict = (stored: StoredDevSession, latest: DevGenerationRecord): { code: string; message: string } | undefined => {
    const { packageId, version } = latest.listing;
    const index = readDirectory({ env: process.env, dataDir: dataDir() });
    if (index.kind === "configured" && index.entries.some((entry) => entry.packageId === packageId && entry.version === version)) {
      return {
        code: "PACKAGE_LISTED",
        message: `${packageId}@${version} is listed in this node's package directory; give the package in development another id or version`,
      };
    }
    const active = activeGeneration(installDeps(), packageId, services().runtime.identity.nodeId);
    const other = readDevSessions(dataDir()).find(
      (session) =>
        session.sessionId !== stored.sessionId &&
        ((session.status === "live" && live.has(session.sessionId) && (session.running?.listing.packageId === packageId || session.pending?.listing.packageId === packageId)) ||
          (session.running?.listing.packageId === packageId && active?.snapshotDigest === session.running.generation.digest)),
    );
    if (other !== undefined) {
      return {
        code: "PACKAGE_IN_OTHER_SESSION",
        message: `${packageId} is developed by another session, from ${other.root}; stop that one and uninstall what it runs, or give this package another id`,
      };
    }
    const ours = (digest: string | undefined): boolean =>
      digest !== undefined && (digest === stored.running?.generation.digest || (stored.snapshots ?? []).includes(digest));
    if (active !== undefined && !ours(active.snapshotDigest)) {
      return {
        code: "PACKAGE_INSTALLED_OTHERWISE",
        message: `${packageId} is already installed on this node from elsewhere; uninstall it first or give the package in development another id`,
      };
    }
    return undefined;
  };

  const intentOf = (stored: StoredDevSession): ExecutionIntent | undefined => {
    const initiative = stored.initiative;
    if (initiative?.kind !== "clark") return undefined;
    return initiative.origin === undefined ? { kind: "proposed" } : { kind: "proposed", origin: initiative.origin };
  };

  const activate = async (sessionId: string, latest: DevGenerationRecord): Promise<void> => {
    const before = read(sessionId);
    if (before === undefined) return;
    const conflict = idConflict(before, latest);
    if (conflict !== undefined) {
      update(sessionId, (current) => ({ ...current, pending: { generation: latest.generation, listing: latest.listing, refused: conflict } }));
      return;
    }
    const stored = update(sessionId, (current) => ({ ...current, pending: { generation: latest.generation, listing: latest.listing } }));
    if (stored === undefined) return;
    const scope = devConsentScopeOf(latest.listing, latest.manifest);
    const consentApproval = stored.consent?.scope === scope ? stored.consent.approvalId : undefined;
    const granted =
      consentApproval === undefined
        ? undefined
        : (() => {
            const approval = approvalState(consentApproval);
            return approval !== undefined && approval.decision === "granted" && approval.operationDigest === scope ? consentApproval : undefined;
          })();
    // The session installs its own listing, so it names the dev source: a listing another source owns is never taken.
    const sourceId = WIDGET_DEV_DIRECTORY_SOURCE.id;
    const approved: ApprovedInstall | undefined =
      granted === undefined ? undefined : { approvalId: granted, digest: scope, localDigest: latest.generation.digest, sourceId };
    const intent = intentOf(stored);

    let outcome: Awaited<ReturnType<typeof installPackage>>;
    try {
      outcome = await installPackage(
        packageInstallDepsOf(services()),
        { packageId: latest.listing.packageId, version: latest.listing.version, contentDigest: latest.generation.digest, sourceId },
        { consentScope: scope, ...(approved === undefined ? {} : { approved }), ...(intent === undefined ? {} : { intent }) },
      );
    } catch (cause) {
      outcome = { kind: "refused", status: 500, code: "INSTALL_FAILED", message: messageOf(cause) };
    }

    if (outcome.kind === "installed") {
      // An install that joined one already made (the inbox's decision installed it) names no generation of its own.
      const active =
        outcome.generationId === "" ? activeGeneration(installDeps(), latest.listing.packageId, services().runtime.identity.nodeId) : undefined;
      const generationId = outcome.generationId !== "" ? outcome.generationId : active?.snapshotDigest === latest.generation.digest ? active.generationId : undefined;
      if (generationId === undefined) {
        const refused = { code: "INSTALL_NOT_ACTIVE", message: hostText(ownerLocale(services().runtime)).approvals.devBuildNotActive };
        update(sessionId, (current) => (current.pending === undefined ? current : { ...current, pending: { ...current.pending, refused } }));
        return;
      }
      update(sessionId, ({ pending: _installed, ...rest }) => ({
        ...rest,
        running: { generation: latest.generation, listing: latest.listing, generationId },
        consent: { scope, ...(granted === undefined ? {} : { approvalId: granted }) },
      }));
      const session = live.get(sessionId);
      if (session !== undefined) session.baseline = latest.manifest;
      // Only when nobody was asked: a build the person approved in the inbox was shown to them with what it adds.
      if (granted === undefined) sayWidened(stored, latest);
      await prune(sessionId);
      return;
    }
    if (outcome.kind === "approval-required") {
      const approvalId = outcome.approvalId;
      update(sessionId, (current) => (current.pending === undefined ? current : { ...current, pending: { ...current.pending, approvalId } }));
      return;
    }
    const refused = { code: outcome.code.slice(0, 80), message: outcome.message.slice(0, 1000) || "the install was refused" };
    update(sessionId, (current) => (current.pending === undefined ? current : { ...current, pending: { ...current.pending, refused } }));
  };

  /** Remember a snapshot the session made, so it can be removed once nothing runs or waits on it. */
  const remember = (sessionId: string, digest: string): void => {
    update(sessionId, (current) => {
      const known = current.snapshots ?? [];
      if (known.includes(digest)) return current;
      // The oldest are forgotten past the bound; pruning keeps the list to a handful, so this is a backstop.
      return { ...current, snapshots: [...known, digest].slice(-WIDGET_DEV_SNAPSHOTS_MAX) };
    });
  };

  /**
   * Remove what superseded generations of a session left behind: their generation records, except the newest superseded
   * one (the generation a rollback returns to), and their snapshots in the package cache, except the ones something
   * still runs, waits on or can roll back to. Only what this session made is touched. A snapshot that cannot be removed
   * now (a file still open on Windows past the retries) is kept on the list and tried again after the next install. It
   * runs on the session's chain, so nothing else of the session interleaves with it.
   */
  const prune = async (sessionId: string): Promise<void> => {
    const stored = read(sessionId);
    if (stored === undefined) return;
    const made = new Set(stored.snapshots ?? []);
    if (made.size === 0) return;
    const node = services();
    const nodeId = node.runtime.identity.nodeId;
    const keep = new Set<string>();
    const keepDigest = (digest: string | undefined): void => {
      if (digest !== undefined) keep.add(digest);
    };
    keepDigest(stored.running?.generation.digest);
    keepDigest(stored.pending?.generation.digest);
    /*
     * The engine's newest build, which neither runs nor waits while the session waits on a question about an older one.
     * After `close` no engine is found here, and nothing is lost: a prune starts no removal once `close` is called, and
     * a build made while a prune or an install ran is remembered only later on this chain, so it is not on the list yet.
     */
    keepDigest(live.get(sessionId)?.engine.latest()?.generation.digest);

    const packageId = stored.running?.listing.packageId ?? stored.pending?.listing.packageId;
    try {
      if (packageId !== undefined) {
        const superseded = allRows<{ generation_id: string; document: string }>(
          node.runtime.db,
          `SELECT generation_id, document FROM package_generations
            WHERE package_id = ? AND node_id = ? AND superseded_at IS NOT NULL
            ORDER BY superseded_at DESC, rowid DESC`,
          packageId,
          nodeId,
        );
        superseded.forEach((row, index) => {
          const digest = parseJson<{ snapshotDigest?: string }>(row.document, "package_generations.document").snapshotDigest;
          if (index === 0) {
            keepDigest(digest);
            return;
          }
          if (digest !== undefined && made.has(digest)) {
            node.runtime.db.prepare("DELETE FROM package_generations WHERE generation_id = ?").run(row.generation_id);
          }
        });
      }
      const others = readDevSessions(dataDir()).filter((session) => session.sessionId !== sessionId);
      for (const session of others) {
        keepDigest(session.running?.generation.digest);
        keepDigest(session.pending?.generation.digest);
      }
      const removed: string[] = [];
      for (const digest of made) {
        if (keep.has(digest)) continue;
        const stillRecorded = oneRow<{ found: number }>(
          node.runtime.db,
          "SELECT 1 AS found FROM package_generations WHERE node_id = ? AND instr(document, ?) > 0",
          nodeId,
          digest,
        );
        if (stillRecorded !== undefined) continue;
        // A closing node removes no more: each removal may wait out its retries, and `close` waits for the one in flight
        // only (`WIDGET_DEV_CLOSE_WAIT_MS`). What is left stays on the list for the next prune.
        if (closed) break;
        const path = cachedLocalSnapshotPath(cacheRoot(), digest);
        if (path === undefined) {
          removed.push(digest);
          continue;
        }
        try {
          // The promise form on purpose: on Windows `rmSync` reports a held file as `EBUSY` or `EPERM` at once and never
          // runs its retries. These wait up to about 1.5 s on this session's chain, never on the event loop.
          await rm(path, SNAPSHOT_REMOVAL);
          removed.push(digest);
        } catch (cause) {
          process.stderr.write(`widget dev: could not remove the superseded snapshot ${digest} yet: ${messageOf(cause)}\n`);
        }
      }
      if (removed.length > 0) {
        update(sessionId, (current) => ({ ...current, snapshots: (current.snapshots ?? []).filter((digest) => !removed.includes(digest)) }));
      }
    } catch (cause) {
      process.stderr.write(`widget dev: could not tidy ${sessionId}'s superseded generations: ${messageOf(cause)}\n`);
    }
  };

  /** Stop watching, and say why: the person, a watcher that failed, a folder that is gone, or the node's capacity. */
  const markStopped = (sessionId: string, reason: WidgetDevStopReason): StoredDevSession | undefined => {
    const session = live.get(sessionId);
    if (session !== undefined) end(session);
    live.delete(sessionId);
    /*
     * The running generation stays installed and keeps rendering where it was placed; only the folder stops being
     * watched. A build that was waiting on a question is dropped with its listing, so the question leaves the inbox.
     */
    return update(sessionId, ({ pending: _dropped, ...rest }) => ({ ...rest, status: "stopped", stopReason: reason }));
  };

  /**
   * Whether a live session's folder has gone (deleted, renamed, or no longer a folder; another folder made at the same
   * path is watched in its place by the engine); when it has, the session is stopped as `folder-gone` before anything is
   * built or installed from it. A
   * platform watcher does not always report this (Windows reports nothing), so the check is made before each build is
   * followed, not only on a watcher error. The session's engine answers, since it knows which folder it watches; a folder
   * that could not be looked at this time (a busy or locked folder on Windows) is not taken as gone.
   */
  const stoppedIfGone = (sessionId: string, root: string): boolean => {
    const engine = live.get(sessionId)?.engine;
    if (!(engine === undefined ? devRootState(root) === "gone" : engine.rootGone())) return false;
    if (live.has(sessionId)) {
      markStopped(sessionId, "folder-gone");
      process.stderr.write(`widget dev: ${root} is gone, so its session was stopped; what it ran keeps running\n`);
    }
    return true;
  };

  const watch = (stored: StoredDevSession): LiveSession => {
    const sessionId = stored.sessionId;
    const running = stored.running;
    const baseline = running?.listing.source.kind === "local" ? manifestAt(running.listing.source.path) : undefined;
    const before = Math.max(running?.generation.generation ?? 0, stored.pending?.generation.generation ?? 0);
    const answerPoll = setInterval(() => {
      const current = read(sessionId);
      if (current?.pending?.approvalId === undefined || current.pending.refused !== undefined) return;
      void serial(sessionId, () => settle(sessionId, "answer")).catch((cause: unknown) => {
        process.stderr.write(`widget dev: ${sessionId} could not follow an answer: ${messageOf(cause)}\n`);
      });
    }, options.answerPollMs ?? ANSWER_POLL_MS);
    answerPoll.unref();
    const session: LiveSession = {
      sessionId,
      answerPoll,
      baseline,
      engine: startDevEngine({
        root: stored.root,
        cacheRoot: cacheRoot(),
        watch: options.watch !== false,
        ...(options.rootUnreadableMs === undefined ? {} : { rootUnreadableMs: options.rootUnreadableMs }),
        generationsBefore: before,
        allowedIsolations: WIDGET_DEV_ALLOWED_ISOLATIONS,
        baseline: () => live.get(sessionId)?.baseline,
        onBuild: (event) => {
          void serial(sessionId, async () => {
            if (live.get(sessionId) !== session || stoppedIfGone(sessionId, stored.root)) return;
            update(sessionId, (current) => ({ ...current, lastBuild: event.build }));
            if (event.kind === "generation") remember(sessionId, event.record.generation.digest);
            await settle(sessionId, event.build.trigger);
          }).catch((cause: unknown) => {
            process.stderr.write(`widget dev: ${sessionId} could not follow a build: ${messageOf(cause)}\n`);
          });
        },
        onWatchError: (error) => {
          process.stderr.write(`widget dev: ${sessionId} stopped watching ${stored.root}: ${error.message}; what it ran keeps running\n`);
          // Said as it is: a session whose folder is no longer watched is stopped, not live.
          void serial(sessionId, async () => {
            if (live.get(sessionId) === session) markStopped(sessionId, "watch-failed");
          });
        },
        onRootGone: () => {
          void serial(sessionId, async () => {
            if (live.get(sessionId) === session) stoppedIfGone(sessionId, stored.root);
          });
        },
      }),
    };
    live.set(sessionId, session);
    return session;
  };

  /** Wait for a session's first build and follow it, so a start answers with what the build produced. */
  const firstBuild = async (session: LiveSession): Promise<void> => {
    const event = await session.engine.ready;
    await serial(session.sessionId, async () => {
      const root = read(session.sessionId)?.root;
      if (live.get(session.sessionId) !== session || (root !== undefined && stoppedIfGone(session.sessionId, root))) return;
      update(session.sessionId, (current) => ({ ...current, lastBuild: event.build }));
      if (event.kind === "generation") remember(session.sessionId, event.record.generation.digest);
      await settle(session.sessionId, "start");
    });
  };

  const sessionView = (sessionId: string): WidgetDevSessionView | undefined => {
    const stored = read(sessionId);
    return stored === undefined ? undefined : viewOf(stored);
  };

  /**
   * Room in the store for one more session: the oldest stopped sessions that no longer run anything installed are
   * forgotten first. A store full of sessions whose builds still run refuses rather than forgetting what runs.
   */
  const makeRoom = (sessions: StoredDevSession[]): StoredDevSession[] | undefined => {
    if (sessions.length < WIDGET_DEV_STORE_MAX) return sessions;
    const nodeId = services().runtime.identity.nodeId;
    const runsNothing = (session: StoredDevSession): boolean =>
      session.status === "stopped" &&
      (session.running === undefined ||
        activeGeneration(installDeps(), session.running.listing.packageId, nodeId)?.snapshotDigest !== session.running.generation.digest);
    const forgettable = sessions
      .filter(runsNothing)
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0))
      .slice(0, sessions.length - WIDGET_DEV_STORE_MAX + 1)
      .map((session) => session.sessionId);
    const kept = sessions.filter((session) => !forgettable.includes(session.sessionId));
    return kept.length < WIDGET_DEV_STORE_MAX ? kept : undefined;
  };

  return {
    async start(input) {
      if (closed) return refusal(503, "WIDGET_DEV_UNAVAILABLE", "this node is closing, so it starts no widget dev session; start it again once the node is back");
      const initiative = input.initiative ?? { kind: "person" };
      const checked = checkRoot(input.root, initiative);
      if (!checked.ok) return checked;
      const root = checked.value;
      const choice = choiceOf(initiative, root, input.root);
      if (input.conversationId !== undefined && !conversationExists(input.conversationId)) return noConversation(input.conversationId);
      const sessions = readDevSessions(dataDir());
      const existing = sessions.find((session) => sameRoot(session.root, root) && session.status === "live" && live.has(session.sessionId));
      if (existing !== undefined) {
        const view = await serial(existing.sessionId, async () => {
          if (choice !== undefined) update(existing.sessionId, (current) => ({ ...current, chosenByPerson: true, chosenFolderId: choice }));
          await settle(existing.sessionId, "start");
          return sessionView(existing.sessionId);
        });
        return view === undefined ? refusal(404, "SESSION_NOT_FOUND", "the session ended while it was read") : { ok: true, value: view };
      }
      if (live.size >= WIDGET_DEV_LIVE_MAX) {
        return refusal(409, "TOO_MANY_SESSIONS", `this node already develops ${String(WIDGET_DEV_LIVE_MAX)} packages at once; stop one first`);
      }
      // A stopped session for the same folder is picked up again: what it runs, and the consent it was given, carry over.
      const reopened = sessions.find((session) => sameRoot(session.root, root));
      const others = makeRoom(sessions.filter((session) => session.sessionId !== reopened?.sessionId));
      if (others === undefined) {
        return refusal(
          409,
          "TOO_MANY_SESSIONS",
          `this node keeps ${String(WIDGET_DEV_STORE_MAX)} widget dev sessions and each still runs what it built; uninstall some of those packages first`,
        );
      }
      const { stopReason: _old, placed: oldPlaced, ...carried } = reopened ?? { sessionId: services().conductor.newId("wdev"), root };
      // A conversation named now replaces where the reopened session placed its widget before.
      const placed = oldPlaced !== undefined && input.conversationId !== undefined && oldPlaced.conversationId !== input.conversationId ? undefined : oldPlaced;
      const stored: StoredDevSession = {
        ...carried,
        root,
        status: "live",
        startedAt: nowInstant(),
        initiative,
        // The person starting a folder is them choosing it; Clark picking up a folder they chose keeps the mark.
        ...(choice === undefined ? {} : { chosenByPerson: true as const, chosenFolderId: choice }),
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        ...(input.widgetId === undefined ? {} : { widgetId: input.widgetId }),
        ...(placed === undefined ? {} : { placed }),
      };
      writeDevSessions(dataDir(), [...others, stored]);
      const session = watch(stored);
      await firstBuild(session);
      const view = sessionView(stored.sessionId);
      return view === undefined ? refusal(404, "SESSION_NOT_FOUND", "the session ended while it started") : { ok: true, value: view };
    },

    get: sessionView,

    list() {
      return readDevSessions(dataDir()).map(viewOf);
    },

    async rebuild(sessionId) {
      const session = live.get(sessionId);
      if (session === undefined) {
        return read(sessionId) === undefined
          ? refusal(404, "SESSION_NOT_FOUND", "there is no such widget dev session on this node")
          : refusal(409, "SESSION_STOPPED", "this session is stopped; start it again to build its folder");
      }
      const root = read(sessionId)?.root;
      if (root !== undefined) {
        // A folder that has gone is said as a stopped session rather than built (and failed) once more.
        const gone = await serial(sessionId, async () => (live.get(sessionId) === session ? stoppedIfGone(sessionId, root) : false));
        if (gone) {
          const view = sessionView(sessionId);
          return view === undefined ? refusal(404, "SESSION_NOT_FOUND", "the session ended while it rebuilt") : { ok: true, value: view };
        }
      }
      // The engine reports the build through `onBuild`, which follows it on the session's chain; this waits behind it.
      await session.engine.rebuild("rebuild");
      const view = await serial(sessionId, async () => sessionView(sessionId));
      return view === undefined ? refusal(404, "SESSION_NOT_FOUND", "the session ended while it rebuilt") : { ok: true, value: view };
    },

    async stop(sessionId) {
      if (read(sessionId) === undefined) return refusal(404, "SESSION_NOT_FOUND", "there is no such widget dev session on this node");
      const view = await serial(sessionId, async () => {
        markStopped(sessionId, "requested");
        return sessionView(sessionId);
      });
      return view === undefined ? refusal(404, "SESSION_NOT_FOUND", "the session ended while it stopped") : { ok: true, value: view };
    },

    async place(sessionId, input) {
      if (read(sessionId) === undefined) return refusal(404, "SESSION_NOT_FOUND", "there is no such widget dev session on this node");
      if (!conversationExists(input.conversationId)) return noConversation(input.conversationId);
      return serial(sessionId, async () => {
        await settle(sessionId, "answer");
        const stored = read(sessionId);
        if (stored === undefined) return refusal(404, "SESSION_NOT_FOUND", "the session ended while it was placed");
        const placed = placeNow(stored, input);
        if (!placed.ok) return placed;
        update(sessionId, (current) => ({
          ...current,
          conversationId: input.conversationId,
          placed: { conversationId: input.conversationId, instanceId: placed.instanceId },
          ...(input.widgetId === undefined ? {} : { widgetId: input.widgetId }),
        }));
        const session = sessionView(sessionId);
        if (session === undefined) return refusal(404, "SESSION_NOT_FOUND", "the session ended while it was placed");
        return { ok: true as const, value: { session, text: placed.text, hostBlocks: placed.hostBlocks } };
      });
    },

    workspace,

    folderCard(input) {
      const node = services();
      const given = input.proposed?.trim().slice(0, 1000);
      // The card names, and its press starts, the folder the path resolves to now, never only the words Clark or the
      // command gave: a link or `..` cannot make the person approve one folder and grant a wider one.
      // A path that names no local folder now gets no button: a press could only fail, or find something else there later.
      let proposed: ProposedFolder | undefined;
      if (given !== undefined && given !== "") {
        const folder = !isAbsolute(given) || isRemoteOrDevicePath(given) ? undefined : realOrUndefined(resolve(given));
        if (!isAbsolute(given)) proposed = { given, problem: "relative" };
        else if (isRemoteOrDevicePath(given) || (folder !== undefined && isRemoteOrDevicePath(folder))) proposed = { given, problem: "remote" };
        else if (folder === undefined) proposed = { given, problem: "missing" };
        else {
          const broad = broadFolder(folder);
          proposed = { given, folder, ...(broad === undefined ? {} : { broad }) };
        }
      }
      return developFolderCard({
        cardId: node.conductor.newId("card"),
        at: nowInstant(),
        locale: input.locale ?? ownerLocale(node.runtime),
        ...(proposed === undefined ? {} : { proposed }),
        chosen: markedFolders(),
        sessions: readDevSessions(dataDir()).map(viewOf),
        ...(input.only === undefined ? {} : { only: input.only }),
      });
    },

    chosen: chosenFolders,

    marked: markedFolders,

    forget(raw) {
      const given = raw.trim();
      if (!isAbsolute(given)) return refusal(400, "ROOT_NOT_ABSOLUTE", "give the chosen folder as an absolute path on this node");
      const real = realOrUndefined(resolve(given));
      const matches = (root: string): boolean => sameRoot(root, given) || (real !== undefined && sameRoot(root, real));
      const sessions = readDevSessions(dataDir());
      const chosen = sessions.find((session) => session.chosenByPerson === true && matches(session.root));
      if (chosen !== undefined) {
        writeDevSessions(
          dataDir(),
          sessions.map((session) => {
            if (session.chosenByPerson !== true || !matches(session.root)) return session;
            const { chosenByPerson: _forgotten, chosenFolderId: _which, ...rest } = session;
            return rest;
          }),
        );
      }
      const root = chosen?.root ?? real ?? given;
      // Said rather than hidden: a folder inside another one Clark may still develop in stays reachable through that one.
      const covering = [
        ...configuredRoots()
          .map((path) => realOrUndefined(path))
          .filter((path): path is string => path !== undefined),
        ...chosenFolders(),
      ];
      const stillCoveredBy = containingRoot(ownedResources(covering), root);
      return { ok: true, value: { root, forgotten: chosen !== undefined, ...(stillCoveredBy === undefined ? {} : { stillCoveredBy }) } };
    },

    async resume() {
      try {
        workspace();
      } catch (cause) {
        process.stderr.write(`widget dev: could not create the widget workspace: ${messageOf(cause)}\n`);
      }
      for (const stored of readDevSessions(dataDir())) {
        // Closed while an earlier session's first build was followed: the rest stay live in the store for the next boot.
        if (closed) return;
        if (stored.status !== "live" || live.has(stored.sessionId)) continue;
        // The folder is checked again as a start checks it (where its path resolves to now, for whoever started the
        // session): what was allowed then, such as a root the person has since removed, is not taken as allowed now.
        const checked = checkRoot(stored.root, { kind: stored.initiative?.kind ?? "person" });
        if (!checked.ok) {
          const gone = checked.code === "ROOT_NOT_FOUND" || checked.code === "ROOT_NOT_A_FOLDER";
          // A folder that is there but cannot be read is not gone, nor refused: watching it failed.
          markStopped(stored.sessionId, gone ? "folder-gone" : checked.code === "ROOT_UNREADABLE" ? "watch-failed" : "root-refused");
          process.stderr.write(`widget dev: ${stored.root} could not be watched again (${checked.code}: ${checked.message}), so its session was stopped; what it ran keeps running\n`);
          continue;
        }
        if (live.size >= WIDGET_DEV_LIVE_MAX) {
          // Said as it is rather than left reading as live: the node watches as many folders as it does at once.
          markStopped(stored.sessionId, "capacity");
          continue;
        }
        await firstBuild(watch(stored)).catch((cause: unknown) => {
          process.stderr.write(`widget dev: could not resume ${stored.sessionId}: ${messageOf(cause)}\n`);
        });
      }
    },

    async close() {
      closed = true;
      for (const session of live.values()) end(session);
      live.clear();
      // Each chain already settles rather than rejects; work queued behind a closed session finds it gone and returns.
      const started = Promise.all([...chains.values()]);
      let bound: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<boolean>((done) => {
        bound = setTimeout(() => done(true), options.closeWaitMs ?? WIDGET_DEV_CLOSE_WAIT_MS);
      });
      try {
        if (await Promise.race([started.then(() => false), timedOut])) {
          process.stderr.write("widget dev: work a session started was still running at close; closing anyway\n");
        }
      } finally {
        clearTimeout(bound);
      }
    },
  };
}

import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  messageBlockSchema,
  nowInstant,
  type MessageBlock,
  type PackageManifest,
  type WidgetDevActivation,
  type WidgetDevSessionView,
  type WidgetDevTrigger,
} from "@clarkcant/contracts";
import { activeGeneration, devConsentScopeOf, pinInstance, readPackage, startDevEngine, type DevEngine, type DevGenerationRecord } from "@clarkcant/core";
import { oneRow } from "@clarkcant/storage";

import { hostText, ownerLocale } from "../host-text.ts";
import { appendHostReply } from "../routes/conversations.ts";
import { type NodeServices } from "../services.ts";
import { placeWidget } from "../widget-perform-tool.ts";
import { installPackage, packageInstallDepsOf, type ApprovedInstall } from "./package-install.ts";
import { readDevSessions, writeDevSessions, type StoredDevSession } from "./widget-dev-store.ts";

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
 * A build that fails, or a generation the policy has not let run, leaves the running generation where it is, and the
 * session says so (`showingLastKnownGood`) instead of presenting older code as the current files.
 */

/** The most sessions that watch folders at once on one node. */
export const WIDGET_DEV_LIVE_MAX = 8;

export type WidgetDevServices = Pick<NodeServices, "runtime" | "conductor" | "search" | "serviceHost" | "browserTokens">;

export type WidgetDevResult<T> = { ok: true; value: T } | { ok: false; status: number; code: string; message: string };

export interface WidgetDevSessions {
  start(input: { root: string; conversationId?: string; widgetId?: string }): Promise<WidgetDevResult<WidgetDevSessionView>>;
  get(sessionId: string): Promise<WidgetDevSessionView | undefined>;
  list(): Promise<WidgetDevSessionView[]>;
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
  /** Start watching again every session that was live when the node stopped. */
  resume(): Promise<void>;
  close(): void;
}

/** How often a session waiting on the person's answer looks for it, so an approval in the inbox is followed promptly. */
const ANSWER_POLL_MS = 2_000;

interface LiveSession {
  sessionId: string;
  engine: DevEngine;
  answerPoll: ReturnType<typeof setInterval>;
  /** The manifest of the running generation, read from its snapshot, which a new generation's delta is compared with. */
  baseline: PackageManifest | undefined;
}

function end(session: LiveSession): void {
  clearInterval(session.answerPoll);
  session.engine.close();
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

export function createWidgetDevSessions(
  services: () => WidgetDevServices,
  /** `watch: false` builds only on start and `rebuild`, for a caller that drives builds itself (tests). */
  options: { watch?: boolean } = {},
): WidgetDevSessions {
  const live = new Map<string, LiveSession>();
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

  const conversationExists = (conversationId: string): boolean =>
    oneRow<{ found: number }>(services().runtime.db, "SELECT 1 AS found FROM conversations WHERE conversation_id = ?", conversationId) !== undefined;
  const noConversation = (conversationId: string) => refusal(404, "CONVERSATION_NOT_FOUND", `there is no conversation ${conversationId} on this node`);

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
      root: stored.root,
      ...(latest === undefined ? {} : { packageId: latest.packageId, version: latest.version, latest }),
      startedAt: stored.startedAt,
      ...(running === undefined ? {} : { running: running.generation }),
      activation,
      ...(lastBuild === undefined ? {} : { lastBuild }),
      showingLastKnownGood: behind,
      ...(stored.placed === undefined ? {} : { placed: stored.placed }),
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
   * build and whenever the session is read, so an approval the person granted in the inbox is followed without a
   * callback from it.
   */
  const settle = async (sessionId: string, trigger: WidgetDevTrigger | "read"): Promise<void> => {
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

  const follow = async (sessionId: string, trigger: WidgetDevTrigger | "read"): Promise<void> => {
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
        const deps = { db: services().runtime.db, nodeId: services().runtime.identity.nodeId, now: nowInstant, newId: services().conductor.newId };
        const active = activeGeneration(deps, asked.listing.packageId, services().runtime.identity.nodeId);
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
        }
      } else {
        const denied = approval?.decision === "denied";
        stored = update(sessionId, (current) =>
          current.pending === undefined
            ? current
            : {
                ...current,
                pending: {
                  ...current.pending,
                  refused: denied
                    ? { code: "APPROVAL_DENIED", message: "you declined to run this build, so the previous one keeps running" }
                    : { code: "APPROVAL_EXPIRED", message: "nobody answered the question about this build in time, so the previous one keeps running" },
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
   * A generation that reaches more than the one it replaced, and that the policy ran without asking, is said in the
   * session's conversation with what it added. The policy decided, as it does for any install; this only keeps a wider
   * reach from being taken in silence.
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
      process.stderr.write(`widget dev: could not say that ${latest.listing.packageId} widened: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    }
  };

  const activate = async (sessionId: string, latest: DevGenerationRecord): Promise<void> => {
    const stored = update(sessionId, (current) => ({ ...current, pending: { generation: latest.generation, listing: latest.listing } }));
    if (stored === undefined) return;
    const scope = devConsentScopeOf(latest.listing);
    const consentApproval = stored.consent?.scope === scope ? stored.consent.approvalId : undefined;
    const granted =
      consentApproval === undefined
        ? undefined
        : (() => {
            const approval = approvalState(consentApproval);
            return approval !== undefined && approval.decision === "granted" && approval.operationDigest === scope ? consentApproval : undefined;
          })();
    const approved: ApprovedInstall | undefined =
      granted === undefined ? undefined : { approvalId: granted, digest: scope, localDigest: latest.generation.digest };

    let outcome: Awaited<ReturnType<typeof installPackage>>;
    try {
      outcome = await installPackage(
        packageInstallDepsOf(services()),
        { packageId: latest.listing.packageId, version: latest.listing.version, contentDigest: latest.generation.digest },
        { consentScope: scope, ...(approved === undefined ? {} : { approved }) },
      );
    } catch (cause) {
      outcome = { kind: "refused", status: 500, code: "INSTALL_FAILED", message: cause instanceof Error ? cause.message : String(cause) };
    }

    if (outcome.kind === "installed") {
      const generationId = outcome.generationId;
      update(sessionId, ({ pending: _installed, ...rest }) => ({
        ...rest,
        running: { generation: latest.generation, listing: latest.listing, generationId },
        consent: { scope, ...(granted === undefined ? {} : { approvalId: granted }) },
      }));
      const session = live.get(sessionId);
      if (session !== undefined) session.baseline = latest.manifest;
      sayWidened(stored, latest);
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

  const watch = (stored: StoredDevSession): LiveSession => {
    const sessionId = stored.sessionId;
    const running = stored.running;
    const baseline = running?.listing.source.kind === "local" ? manifestAt(running.listing.source.path) : undefined;
    const before = Math.max(running?.generation.generation ?? 0, stored.pending?.generation.generation ?? 0);
    const answerPoll = setInterval(() => {
      const current = read(sessionId);
      if (current?.pending?.approvalId === undefined || current.pending.refused !== undefined) return;
      void serial(sessionId, () => settle(sessionId, "read")).catch((cause: unknown) => {
        process.stderr.write(`widget dev: ${sessionId} could not follow an answer: ${cause instanceof Error ? cause.message : String(cause)}\n`);
      });
    }, ANSWER_POLL_MS);
    answerPoll.unref();
    const session: LiveSession = {
      sessionId,
      answerPoll,
      baseline,
      engine: startDevEngine({
        root: stored.root,
        cacheRoot: join(dataDir(), "package-cache"),
        watch: options.watch !== false,
        generationsBefore: before,
        baseline: () => live.get(sessionId)?.baseline,
        onBuild: (event) => {
          void serial(sessionId, async () => {
            update(sessionId, (current) => ({ ...current, lastBuild: event.build }));
            await settle(sessionId, event.build.trigger);
          }).catch((cause: unknown) => {
            process.stderr.write(`widget dev: ${sessionId} could not follow a build: ${cause instanceof Error ? cause.message : String(cause)}\n`);
          });
        },
        onWatchError: (error) => {
          process.stderr.write(`widget dev: ${sessionId} stopped watching ${stored.root}: ${error.message}\n`);
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
      update(session.sessionId, (current) => ({ ...current, lastBuild: event.build }));
      await settle(session.sessionId, "start");
    });
  };

  const sessionView = (sessionId: string): WidgetDevSessionView | undefined => {
    const stored = read(sessionId);
    return stored === undefined ? undefined : viewOf(stored);
  };

  const get = async (sessionId: string): Promise<WidgetDevSessionView | undefined> => {
    if (read(sessionId) === undefined) return undefined;
    return serial(sessionId, async () => {
      await settle(sessionId, "read");
      return sessionView(sessionId);
    });
  };

  return {
    async start(input) {
      const raw = input.root.trim();
      if (!isAbsolute(raw)) return refusal(400, "ROOT_NOT_ABSOLUTE", "give the package folder as an absolute path on this node");
      const root = resolve(raw);
      if (input.conversationId !== undefined && !conversationExists(input.conversationId)) return noConversation(input.conversationId);
      try {
        if (!statSync(root).isDirectory()) return refusal(400, "ROOT_NOT_A_FOLDER", `${root} is not a folder`);
      } catch {
        return refusal(404, "ROOT_NOT_FOUND", `${root} does not exist on this node`);
      }
      const sessions = readDevSessions(dataDir());
      const existing = sessions.find((session) => sameRoot(session.root, root) && session.status === "live" && live.has(session.sessionId));
      if (existing !== undefined) {
        const view = await serial(existing.sessionId, async () => {
          await settle(existing.sessionId, "read");
          return sessionView(existing.sessionId);
        });
        return view === undefined ? refusal(404, "SESSION_NOT_FOUND", "the session ended while it was read") : { ok: true, value: view };
      }
      if (live.size >= WIDGET_DEV_LIVE_MAX) {
        return refusal(409, "TOO_MANY_SESSIONS", `this node already develops ${String(WIDGET_DEV_LIVE_MAX)} packages at once; stop one first`);
      }
      // A stopped session for the same folder is picked up again: what it runs, and the consent it was given, carry over.
      const reopened = sessions.find((session) => sameRoot(session.root, root));
      const stored: StoredDevSession = {
        ...(reopened ?? { sessionId: services().conductor.newId("wdev"), root }),
        status: "live",
        startedAt: nowInstant(),
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        ...(input.widgetId === undefined ? {} : { widgetId: input.widgetId }),
      };
      const others = sessions.filter((session) => session.sessionId !== stored.sessionId);
      // A conversation named now replaces where the reopened session placed its widget before.
      const placed = reopened?.placed !== undefined && input.conversationId !== undefined && reopened.placed.conversationId !== input.conversationId ? undefined : stored.placed;
      const { placed: _old, ...withoutPlaced } = stored;
      writeDevSessions(dataDir(), [...others, placed === undefined ? withoutPlaced : { ...withoutPlaced, placed }]);
      const session = watch(stored);
      await firstBuild(session);
      const view = sessionView(stored.sessionId);
      return view === undefined ? refusal(404, "SESSION_NOT_FOUND", "the session ended while it started") : { ok: true, value: view };
    },

    get,

    async list() {
      const views: WidgetDevSessionView[] = [];
      for (const stored of readDevSessions(dataDir())) {
        const view = await get(stored.sessionId);
        if (view !== undefined) views.push(view);
      }
      return views;
    },

    async rebuild(sessionId) {
      const session = live.get(sessionId);
      if (session === undefined) {
        return read(sessionId) === undefined
          ? refusal(404, "SESSION_NOT_FOUND", "there is no such widget dev session on this node")
          : refusal(409, "SESSION_STOPPED", "this session is stopped; start it again to build its folder");
      }
      // The engine reports the build through `onBuild`, which follows it on the session's chain; this waits behind it.
      await session.engine.rebuild("rebuild");
      const view = await serial(sessionId, async () => sessionView(sessionId));
      return view === undefined ? refusal(404, "SESSION_NOT_FOUND", "the session ended while it rebuilt") : { ok: true, value: view };
    },

    async stop(sessionId) {
      if (read(sessionId) === undefined) return refusal(404, "SESSION_NOT_FOUND", "there is no such widget dev session on this node");
      const view = await serial(sessionId, async () => {
        const session = live.get(sessionId);
        if (session !== undefined) end(session);
        live.delete(sessionId);
        /*
         * The running generation stays installed and keeps rendering where it was placed; only the folder stops being
         * watched. A build that was waiting on a question is dropped with its listing, so the question leaves the inbox.
         */
        update(sessionId, ({ pending: _dropped, ...rest }) => ({ ...rest, status: "stopped" }));
        return sessionView(sessionId);
      });
      return view === undefined ? refusal(404, "SESSION_NOT_FOUND", "the session ended while it stopped") : { ok: true, value: view };
    },

    async place(sessionId, input) {
      if (read(sessionId) === undefined) return refusal(404, "SESSION_NOT_FOUND", "there is no such widget dev session on this node");
      if (!conversationExists(input.conversationId)) return noConversation(input.conversationId);
      return serial(sessionId, async () => {
        await settle(sessionId, "read");
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

    async resume() {
      for (const stored of readDevSessions(dataDir())) {
        if (stored.status !== "live" || live.has(stored.sessionId)) continue;
        try {
          if (!statSync(stored.root).isDirectory()) throw new Error("not a folder");
        } catch {
          update(stored.sessionId, ({ pending: _dropped, ...rest }) => ({ ...rest, status: "stopped" }));
          process.stderr.write(`widget dev: ${stored.root} is gone, so its session was stopped; what it ran keeps running\n`);
          continue;
        }
        if (live.size >= WIDGET_DEV_LIVE_MAX) break;
        await firstBuild(watch(stored)).catch((cause: unknown) => {
          process.stderr.write(`widget dev: could not resume ${stored.sessionId}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        });
      }
    },

    close() {
      for (const session of live.values()) end(session);
      live.clear();
    },
  };
}

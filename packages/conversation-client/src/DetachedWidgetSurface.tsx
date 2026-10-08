import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MiniAppSurface, STATE_EVENT_OPERATION, actionForIntent } from "./mini-app-surface.tsx";
import { frameStateNotice, keepMountedFrame, toSurfaceViewFromLive } from "./DesktopSurfaces.tsx";
import { type IsolatedFrameLiveResponse, type LiveWidgetResponse, withFrameExpiry } from "./api.ts";
import { useT } from "./i18n/locale-context.tsx";
import type { AppearanceSnapshot } from "@clarkcant/contracts";
import { applyRelayedAppearance } from "./appearance.ts";
import {
  type DetachedFrameBridge,
  detachedArtifactFiles,
  detachedDevStatusClient,
  detachedFrameTransport,
  detachedJobTransport,
  detachedTokenTransport,
  frameHostCallbacks,
  frameJobBroker,
  frameTokenBroker,
  offersBrowserTokens,
  relayRefusalError,
} from "./frame-host-callbacks.ts";
import { answerForwardedPerforms } from "./frame-performs.ts";
import { type FrameSource, WidgetFrame } from "./WidgetFrame.tsx";
import { useWidgetArtifactHost } from "./widget-artifacts.tsx";
import { WidgetDevStatus } from "./widget-dev-status.tsx";

/**
 * The detached widget window's document.
 *
 * This is the other half of the host's relay. The window holds no credential, so it cannot read a conversation,
 * cannot list one and cannot invoke anything itself — it asks the host, and the host performs the action with its
 * own token. Everything this file does is therefore one of three things: draw the composition the host handed
 * over, forward an intent, or hand the instance back.
 *
 * The composition arrives in the bootstrap rather than being fetched, which is what makes "receives only the
 * widget host bootstrap and an instance reference" true in practice instead of only in the policy module: there is
 * no fetch here to authorise, because there is nothing to fetch with.
 */

/** What the detached preload exposes. Declared here so the window's reach is visible in one place. */
export interface DetachedBridge {
  bootstrap(): Promise<{
    ok: boolean;
    bootstrap?: { instanceRef: string; title: string; widgetKind: string; live: LiveWidgetResponse | IsolatedFrameLiveResponse; appearance?: AppearanceSnapshot };
    refused?: string;
  }>;
  intent(input: {
    instanceRef: string;
    actionBindingId: string;
    expectedRevision: number;
    input: Record<string, unknown>;
    invocationId?: string;
  }): Promise<{ ok: boolean; result?: unknown; refused?: string; code?: string; details?: Record<string, unknown> }>;
  release(): Promise<{ ok: boolean }>;
  onAppearance?(listener: (snapshot: unknown) => void): () => void;
  /*
   * The relays a widget in its own frame needs. Optional in the type because a composition needs none of them; a window
   * asked to run a frame without them says it cannot rather than drawing a frame that cannot save.
   */
  frameRead?: DetachedFrameBridge["frameRead"];
  saveState?: DetachedFrameBridge["saveState"];
  publishSemantic?: DetachedFrameBridge["publishSemantic"];
  devSession?: DetachedFrameBridge["devSession"];
  artifacts?: DetachedFrameBridge["artifacts"];
  jobs?: DetachedFrameBridge["jobs"];
  tokens?: DetachedFrameBridge["tokens"];
  onPackagesChanged?: DetachedFrameBridge["onPackagesChanged"];
  onPerform?: DetachedFrameBridge["onPerform"];
  reportPerform?: DetachedFrameBridge["reportPerform"];
}

/** The bridge, when it carries every relay a frame needs. */
function frameBridge(bridge: DetachedBridge): DetachedFrameBridge | undefined {
  const { frameRead, saveState, publishSemantic, devSession, artifacts, jobs, tokens, onPackagesChanged, onPerform, reportPerform } = bridge;
  if (
    frameRead === undefined ||
    saveState === undefined ||
    publishSemantic === undefined ||
    devSession === undefined ||
    artifacts === undefined ||
    jobs === undefined ||
    tokens === undefined
  ) {
    return undefined;
  }
  return {
    frameRead: () => frameRead(),
    saveState: (write) => saveState(write),
    publishSemantic: (input) => publishSemantic(input),
    devSession: () => devSession(),
    artifacts,
    jobs,
    tokens,
    ...(onPackagesChanged === undefined ? {} : { onPackagesChanged: (listener: () => void) => onPackagesChanged(listener) }),
    // Both or neither: a window told of performs it cannot report would leave the node waiting on each one.
    ...(onPerform === undefined || reportPerform === undefined
      ? {}
      : { onPerform: (listener: (push: unknown) => void) => onPerform(listener), reportPerform: (answer) => reportPerform(answer) }),
    intent: async (input) => {
      const answer = await bridge.intent(input);
      return answer.ok ? { ok: true, result: answer.result } : { ok: false, refused: answer.refused, code: answer.code, details: answer.details };
    },
  };
}

/** How often a frame whose bindings call a service re-reads, as the conversation's surface does. */
const SERVICE_AVAILABILITY_MS = 5_000;

/**
 * A widget in its own frame, run in the detached window.
 *
 * The same `WidgetFrame` the conversation mounts, with the same sandbox and the same session; only the transport
 * differs. Every read, state write, publish and press is a relay the host performs with its own credential against the
 * instance it opened this window for, and the window never names either id. The first read happens here rather than
 * reusing the bootstrap's URL: each read carries a fresh grant, and the one the conversation held was minted for it.
 */
function DetachedFrame({ bridge, instanceRef, title }: { bridge: DetachedBridge; instanceRef: string; title: string }): ReactElement {
  const t = useT();
  const relays = useMemo(() => frameBridge(bridge), [bridge]);
  const [live, setLive] = useState<IsolatedFrameLiveResponse | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const read = useCallback(async (): Promise<IsolatedFrameLiveResponse> => {
    if (relays === undefined) throw new Error(t("widgets.detached.isolatedFrame"));
    const sentAt = Date.now();
    const answer = await relays.frameRead();
    if (!answer.ok) throw relayRefusalError(answer);
    if (answer.live === undefined) throw relayRefusalError({ ok: false, code: "MALFORMED_RESPONSE", refused: "the host answered without the widget" });
    return withFrameExpiry(answer.live, sentAt);
  }, [relays, t]);

  /** Re-reads the widget, keeping the mounted frame's URL while its document is the same (`keepMountedFrame`). */
  const merge = useCallback((fresh: IsolatedFrameLiveResponse): void => {
    setLive((previous) => {
      const kept = keepMountedFrame(previous, fresh);
      return kept.kind === "isolated-frame" ? kept : fresh;
    });
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      merge(await read());
      setProblem(undefined);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    }
  }, [merge, read]);

  useEffect(() => {
    void load();
  }, [load]);

  // A package installed, updated or removed elsewhere: re-read, so a new build loads and a removed one says so.
  useEffect(() => relays?.onPackagesChanged?.(() => void load()), [relays, load]);

  // Clark's performs for this widget, pushed by the host: asked of the frame this window mounts, and reported back.
  useEffect(() => {
    const onPerform = relays?.onPerform;
    const reportPerform = relays?.reportPerform;
    if (onPerform === undefined || reportPerform === undefined) return undefined;
    return answerForwardedPerforms({ instanceId: instanceRef, onPerform, reportPerform });
  }, [relays, instanceRef]);

  const watchesServices = live?.bindings.some((entry) => entry.available !== undefined) ?? false;
  useEffect(() => {
    if (!watchesServices) return;
    const timer = setInterval(() => void load(), SERVICE_AVAILABILITY_MS);
    return () => clearInterval(timer);
  }, [watchesServices, load]);

  // A fresh URL when the frame has to load its document again after the old grant lapsed; it refreshes the view too.
  const renewUrl = useCallback(async (): Promise<FrameSource> => {
    const fresh = await read();
    merge(fresh);
    if (fresh.frame === null) throw new Error("the widget's package is no longer installed, so it has no frame to load");
    return { url: fresh.frame.url, urlExpiresAt: fresh.frame.urlExpiresAt };
  }, [merge, read]);

  return (
    <DetachedFrameView
      relays={relays}
      instanceRef={instanceRef}
      title={title}
      live={live}
      problem={problem}
      release={() => void bridge.release()}
      reload={() => void load()}
      renewUrl={renewUrl}
    />
  );
}

/**
 * What the detached window draws for a widget in its own frame, given what the relays answered.
 *
 * Kept apart from the reads so what is drawn for each answer can be checked without a window.
 */
export function DetachedFrameView({
  relays,
  instanceRef,
  title,
  live,
  problem,
  release,
  reload,
  renewUrl,
}: {
  relays: DetachedFrameBridge | undefined;
  instanceRef: string;
  title: string;
  live: IsolatedFrameLiveResponse | undefined;
  problem: string | undefined;
  release: () => void;
  reload: () => void;
  renewUrl: () => Promise<FrameSource>;
}): ReactElement {
  const t = useT();
  const devClient = useMemo(() => (relays === undefined ? undefined : detachedDevStatusClient(relays)), [relays]);
  const main = useRef<HTMLElement>(null);

  const reattach = (
    <button type="button" data-detached-release="true" onClick={release}>
      {t("widgets.detached.reattach")}
    </button>
  );

  if (relays === undefined || (live === undefined && problem !== undefined)) {
    return (
      <main className="cc-card" data-detached-surface="true" data-detached-error="true">
        <h1 className="cc-card-title">{t("widgets.detached.cannotOpen")}</h1>
        <p className="cc-card-note">{problem ?? t("widgets.detached.isolatedFrame")}</p>
        {reattach}
      </main>
    );
  }
  if (live === undefined) {
    return (
      <main className="cc-card" data-detached-surface="true" data-detached-loading="true">
        <p className="cc-card-note">{t("widgets.detached.opening")}</p>
      </main>
    );
  }

  const frame = live.frame;
  return (
    <main ref={main} tabIndex={-1} className="cc-detached" data-detached-surface="true" data-detached-instance={instanceRef} data-detached-frame="true">
      <header className="cc-detached-head">
        <h1 className="cc-detached-title">{title}</h1>
        {reattach}
      </header>
      {/* A dev session's build status, without the developer's folder: the conversation still shows where it is. */}
      {live.development !== undefined && devClient !== undefined && (
        <WidgetDevStatus client={devClient} sessionId={live.development.sessionId} onRunningChange={reload} />
      )}
      {problem !== undefined && (
        <p className="cc-freshness" data-detached-notice="true" role="status">
          {problem}
        </p>
      )}
      {live.stateStatus.kind !== "writable" && (
        <p className="cc-freshness" data-live-notice="true" data-state-status={live.stateStatus.kind} role="status">
          {frameStateNotice(live.stateStatus, t)}
        </p>
      )}
      {frame === null ? (
        // The package went away while the window was open: what the widget said about itself is what is left.
        <p data-widget-text-fallback="true" style={{ margin: 0 }}>
          {live.textFallback ?? title}
        </p>
      ) : (
        <DetachedWidgetFrame
          relays={relays}
          instanceRef={instanceRef}
          title={title}
          live={live}
          frame={frame}
          reload={reload}
          renewUrl={renewUrl}
          focus={() => main.current?.focus()}
        />
      )}
    </main>
  );
}

/**
 * The frame itself, with every broker the conversation's frame is given, each through the host's relays: files, jobs,
 * browser tokens. A pick or a save opens the OS dialog over this window; the panel asking the person first is drawn
 * here, beside the frame, as the conversation draws it. Clark's performs reach this frame too: the host pushes each one
 * to the window (`answerForwardedPerforms`), which asks the frame mounted here, by instance, as the conversation would.
 */
function DetachedWidgetFrame({
  relays,
  instanceRef,
  title,
  live,
  frame,
  reload,
  renewUrl,
  focus,
}: {
  relays: DetachedFrameBridge;
  instanceRef: string;
  title: string;
  live: IsolatedFrameLiveResponse;
  frame: NonNullable<IsolatedFrameLiveResponse["frame"]>;
  reload: () => void;
  renewUrl: () => Promise<FrameSource>;
  focus: () => void;
}): ReactElement {
  const t = useT();
  const files = useMemo(() => detachedArtifactFiles(relays.artifacts), [relays]);
  // An attached file goes to the conversation's composer: the host hands it to the shell, never this window's.
  const artifactHost = useWidgetArtifactHost({ files, widgetTitle: title });
  const jobs = useMemo(() => frameJobBroker(detachedJobTransport(relays.jobs)), [relays]);
  const tokens = useMemo(() => frameTokenBroker(detachedTokenTransport(relays.tokens)), [relays]);
  return (
    <>
      <WidgetFrame
        instanceId={live.instanceId}
        url={frame.url}
        urlExpiresAt={frame.urlExpiresAt}
        renewUrl={renewUrl}
        // Without the actions it offers, the session refuses every perform the host forwards here.
        {...(frame.offeredActions === undefined ? {} : { offeredActions: frame.offeredActions })}
        title={title}
        props={live.props}
        state={live.state}
        stateRevision={live.stateRevision}
        ephemeralStateKeys={live.ephemeralStateKeys}
        {...frameHostCallbacks({
          transport: detachedFrameTransport(relays, instanceRef),
          bindings: live.bindings,
          t,
          // A refusal may be a service that stopped; re-reading shows why.
          onPressRefused: reload,
        })}
        contextBindings={live.bindings.flatMap((entry) =>
          entry.contextRefs !== undefined && entry.contextRefs.length > 0 ? [entry.actionBindingId] : [],
        )}
        brokeredCapabilities={frame.grantedCapabilities}
        allowedOrigins={frame.allowedOrigins}
        knownActionBindings={live.bindings.map((entry) => entry.actionBindingId)}
        actionAvailability={live.bindings.flatMap((entry) =>
          entry.available === undefined
            ? []
            : [
                {
                  actionBindingId: entry.actionBindingId,
                  available: entry.available,
                  ...(entry.unavailableReason === undefined ? {} : { reason: entry.unavailableReason }),
                },
              ],
        )}
        revision={live.revision}
        chrome={{
          focus,
          resize: () => undefined,
          requestPin: () => undefined,
          openExternal: () => undefined,
        }}
        artifacts={artifactHost.broker}
        jobs={jobs}
        tokens={offersBrowserTokens(frame) ? tokens : undefined}
      />
      {artifactHost.chrome}
    </>
  );
}
export function DetachedWidgetSurface({ bridge }: { bridge: DetachedBridge }): ReactElement {
  const t = useT();
  const [loaded, setLoaded] = useState<
    { instanceRef: string; title: string; live: LiveWidgetResponse | IsolatedFrameLiveResponse } | undefined
  >(undefined);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  /*
   * Intents go to the host one at a time, each against the revision the one before it produced. The window never re-reads
   * the surface, so without this every action after the first would be refused as made against an older view.
   */
  const queue = useRef<{ chain: Promise<void>; revision: number | undefined }>({ chain: Promise.resolve(), revision: undefined });

  useEffect(() => {
    let cancelled = false;
    let receivedAppearance = false;
    const apply = (raw: unknown): void => {
      if (!cancelled && applyRelayedAppearance(raw)) receivedAppearance = true;
    };
    const unsubscribe = bridge.onAppearance?.(apply);
    void bridge.bootstrap().then((answer) => {
      if (cancelled) return;
      if (!answer.ok || answer.bootstrap === undefined) {
        // Named rather than blank: an empty window reads as a widget that failed to load, and the two are not the
        // same thing to whoever is looking at it.
        setRefusal(answer.refused ?? "the host did not send this instance");
        return;
      }
      if (answer.bootstrap.appearance !== undefined && !receivedAppearance) apply(answer.bootstrap.appearance);
      setLoaded(answer.bootstrap);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [bridge]);

  if (refusal !== undefined) {
    return (
      <main className="cc-card" data-detached-surface="true" data-detached-error="true">
        <h1 className="cc-card-title">{t("widgets.detached.cannotOpen")}</h1>
        <p className="cc-card-note">{refusal}</p>
      </main>
    );
  }
  if (loaded === undefined) {
    // A window that is opening says so; it does not show an empty frame and call it loaded.
    return (
      <main className="cc-card" data-detached-surface="true" data-detached-loading="true">
        <p className="cc-card-note">{t("widgets.detached.opening")}</p>
      </main>
    );
  }

  const live = loaded.live;
  if (live.kind === "isolated-frame") {
    return <DetachedFrame bridge={bridge} instanceRef={loaded.instanceRef} title={loaded.title} />;
  }
  const view = toSurfaceViewFromLive(live, false);
  return (
    <main className="cc-detached" data-detached-surface="true" data-detached-instance={loaded.instanceRef}>
      <header className="cc-detached-head">
        <h1 className="cc-detached-title">{loaded.title}</h1>
        {/*
          * The one control this window owns. It asks the host to close it, which is also what releases the lease —
          * so the instance goes back to the conversation whether the user clicks this or closes the window.
          */}
        <button type="button" data-detached-release="true" onClick={() => void bridge.release()}>
          {t("widgets.detached.reattach")}
        </button>
      </header>
      {notice !== undefined && (
        <p className="cc-freshness" data-detached-notice="true">
          {notice}
        </p>
      )}
      <MiniAppSurface
        view={view}
        title={loaded.title}
        busy={busy}
        onIntent={(intent) => {
          const action = actionForIntent(live.spec.actions, intent);
          if (action === undefined) {
            setNotice(t("widgets.detached.actionDetached"));
            return;
          }
          // A graph event is the surface keeping its own state, not a press: it does not hold the other controls.
          const pressed = intent.action !== STATE_EVENT_OPERATION;
          if (pressed) {
            setBusy(true);
            setNotice(undefined);
          }
          queue.current.chain = queue.current.chain.then(() =>
            bridge
              .intent({
                instanceRef: loaded.instanceRef,
                actionBindingId: action.actionBindingId,
                // The revision the user is looking at: the node refuses a stale one rather than applying it to
                // something the window never showed.
                expectedRevision: queue.current.revision ?? live.revision,
                input: intent.input,
              })
              .then((answer) => {
                if (pressed) setBusy(false);
                const revision = (answer.result as { revision?: unknown } | undefined)?.revision;
                if (answer.ok && typeof revision === "number") queue.current.revision = revision;
                if (!answer.ok) setNotice(answer.refused ?? t("widgets.detached.serverRefused"));
              }),
          );
        }}
      />
    </main>
  );
}

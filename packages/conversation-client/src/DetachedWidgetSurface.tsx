import { type ReactElement, useEffect, useRef, useState } from "react";

import { MiniAppSurface, STATE_EVENT_OPERATION, actionForIntent } from "./mini-app-surface.tsx";
import { toSurfaceViewFromLive } from "./DesktopSurfaces.tsx";
import type { IsolatedFrameLiveResponse, LiveWidgetResponse } from "./api.ts";
import { useT } from "./i18n/locale-context.tsx";
import type { AppearanceSnapshot } from "@clarkcant/contracts";
import { applyRelayedAppearance } from "./appearance.ts";

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
  }): Promise<{ ok: boolean; result?: unknown; refused?: string }>;
  release(): Promise<{ ok: boolean }>;
  onAppearance?(listener: (snapshot: unknown) => void): () => void;
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
    /*
     * A widget in its own frame needs the conversation's credential to save state and renew its URL, and this window
     * has none. The conversation does not offer Detach for one and the host refuses it; this is the answer for any
     * caller that got past both, said rather than drawn as a frame that cannot save.
     */
    return (
      <main className="cc-card" data-detached-surface="true" data-detached-error="true" data-detached-unsupported="isolated-frame">
        <h1 className="cc-card-title">{t("widgets.detached.cannotOpen")}</h1>
        <p className="cc-card-note">{t("widgets.detached.isolatedFrame")}</p>
        <button type="button" data-detached-release="true" onClick={() => void bridge.release()}>
          {t("widgets.detached.reattach")}
        </button>
      </main>
    );
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

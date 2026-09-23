import { type ReactElement, useEffect, useState } from "react";

import { MiniAppSurface } from "./mini-app-surface.tsx";
import { toSurfaceViewFromLive } from "./DesktopSurfaces.tsx";
import type { LiveWidgetResponse } from "./api.ts";
import { useT } from "./i18n/locale-context.tsx";

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
    bootstrap?: { instanceRef: string; title: string; widgetKind: string; live: LiveWidgetResponse };
    refused?: string;
  }>;
  intent(input: {
    instanceRef: string;
    actionBindingId: string;
    expectedRevision: number;
    input: Record<string, unknown>;
  }): Promise<{ ok: boolean; result?: unknown; refused?: string }>;
  release(): Promise<{ ok: boolean }>;
}

export function DetachedWidgetSurface({ bridge }: { bridge: DetachedBridge }): ReactElement {
  const t = useT();
  const [loaded, setLoaded] = useState<
    { instanceRef: string; title: string; live: LiveWidgetResponse } | undefined
  >(undefined);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void bridge.bootstrap().then((answer) => {
      if (cancelled) return;
      if (!answer.ok || answer.bootstrap === undefined) {
        // Named rather than blank: an empty window reads as a widget that failed to load, and the two are not the
        // same thing to whoever is looking at it.
        setRefusal(answer.refused ?? "the host did not send this instance");
        return;
      }
      setLoaded(answer.bootstrap);
    });
    return () => {
      cancelled = true;
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

  const view = toSurfaceViewFromLive(loaded.live, false);
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
          const action = loaded.live.spec.actions.find((entry) => entry.sectionId === intent.sectionId);
          if (action === undefined) {
            setNotice(t("widgets.detached.actionDetached"));
            return;
          }
          setBusy(true);
          setNotice(undefined);
          void bridge
            .intent({
              instanceRef: loaded.instanceRef,
              actionBindingId: action.actionBindingId,
              // The revision the user is looking at: the node refuses a stale one rather than applying it to
              // something the window never showed.
              expectedRevision: loaded.live.revision,
              input: intent.input,
            })
            .then((answer) => {
              setBusy(false);
              if (!answer.ok) setNotice(answer.refused ?? t("widgets.detached.serverRefused"));
            });
        }}
      />
    </main>
  );
}

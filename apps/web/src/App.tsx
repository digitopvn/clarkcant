import { type ReactElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  Conversation,
  DetachedWidgetSurface,
  type DetachedBridge,
  GatewayClient,
  ORB_DRAW_SIZE,
  ORB_RADIUS,
  Orb,
  installStyles,
  readStoredTheme,
  resolveTheme,
  sessionFromBridge,
  systemPrefersLight,
  useLocale,
  useOrbProfile,
} from "@clarkcant/conversation-client";

/**
 * Browser client entry.
 *
 * The runtime token is a development affordance read from the URL or session storage. It is
 * deliberately not a cookie: the gateway is token-authenticated, so a cookie would add a
 * CSRF surface for no benefit. A production deployment replaces this with a same-origin
 * session established by the operator's ingress, and the blueprint's requirement that the
 * web UI be served over HTTPS applies there rather than on loopback.
 */

/**
 * Install the stylesheet for the theme the user actually chose.
 *
 * This was the literal `"dark"` and that was a bug with a misleading shape. The pre-paint script
 * applied the stored choice correctly, then this line overwrote it with dark a moment later — so
 * the preference was stored, read back, and thrown away, and a light preference returned as dark
 * on every reload. Found by `apps/web/e2e/appearance.spec.ts`, which is the only place it was
 * visible: reading either half of the code on its own looks right.
 */
installStyles(resolveTheme(readStoredTheme(), systemPrefersLight()));

function readToken(): string {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("token");
  if (fromUrl !== null && fromUrl !== "") {
    // Kept only for this tab: a bearer token does not belong in durable browser storage.
    window.sessionStorage.setItem("cc_token", fromUrl);
    return fromUrl;
  }
  return window.sessionStorage.getItem("cc_token") ?? "";
}

function readGateway(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("gateway") ?? "http://127.0.0.1:8765";
}

export function App(): ReactElement {
  /*
   * The detached widget window.
   *
   * It is served from this same app and shows none of it. The window holds no token, so this branch is taken
   * before anything that would read one - not the bridge, not the URL, not session storage - and what remains is
   * the widget the host handed over. That ordering is the design rather than a detail: a detached window that read
   * a token on its way to rendering would be a window that could read the whole conversation.
   *
   * The branch is a return rather than a flag threaded through everything below, because there is nothing below
   * that this window has any use for.
   */
  /*
   * SAFETY: `clarkcantDetached` is injected into the page by the desktop shell's `contextBridge`, so it exists at
   * runtime and in no type. The assertion is narrow (an optional property, read once) and the value is validated
   * by use: a bridge without `bootstrap` produces a refusal in the surface rather than a crash here.
   */
  const detachedBridge = (window as unknown as { clarkcantDetached?: DetachedBridge }).clarkcantDetached;
  if (new URLSearchParams(window.location.search).get("detached") === "1" && detachedBridge !== undefined) {
    return <DetachedWidgetSurface bridge={detachedBridge} />;
  }

  /**
   * The token, from the desktop shell when there is one and from the page otherwise.
   *
   * The shell hands it over through a named bridge rather than through the URL, where it would be visible in
   * history and in the address bar. That answer arrives over IPC, so the client exists unauthenticated for the
   * moment it takes and is rebuilt when the token arrives; a browser has no bridge and answers nothing, which
   * leaves the URL and session storage exactly as they were.
   */
  const [token, setToken] = useState(readToken);
  const baseUrl = readGateway();
  const { t } = useLocale();

  useEffect(() => {
    let cancelled = false;
    void sessionFromBridge().then((session) => {
      if (cancelled || session === undefined) return;
      window.sessionStorage.setItem("cc_token", session.token);
      setToken(session.token);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Memoised: passing a fresh client into the conversation on every render would make its
  // load effect depend on a new object each time and re-run without end.
  const client = useMemo(() => new GatewayClient({ baseUrl, token }), [baseUrl, token]);

  /*
   * Whether this browser has been through the first-run screen.
   *
   * In the browser rather than on the node, deliberately: the question is whether this person has seen it, and a node
   * that answered would answer for every browser that ever connects to it.
   */
  const [onboarded, setOnboarded] = useState(() => window.localStorage.getItem("cc_onboarded") === "1");

  /**
   * The personalized orb, resolved from what this node stored.
   *
   * Resolved by the shared hook rather than here, because the settings surface writes the same preferences and
   * has to be able to re-resolve them: writing a profile changes the orb that is on screen, not the one that
   * appears after a reload. Undefined until the node answers, and it stays undefined on failure — the orb is the
   * product's own face, so a node that cannot answer for a preference must not be why it is missing.
   */
  const { profile: orbProfile, refresh: refreshOrbProfile } = useOrbProfile(client);

  /**
   * What the node says it already has.
   *
   * Undefined until it answers, and the full walk is the fallback: asking is the recoverable failure, because a question
   * skipped by mistake cannot be asked again, and the answer decides which steps are worth showing at all.
   */
  const [readiness, setReadiness] = useState<{ model: boolean; credentials: string[] } | undefined>(undefined);

  /** The surface the orb reads the pointer against, so its glow reacts here as it does once the app is open. */
  const shellRef = useRef<HTMLDivElement>(null);

  /** The space the first run reserves for the orb. The orb measures itself from this rather than from the screen. */
  const heroOrbRef = useRef<HTMLDivElement>(null);
  /** Where the orb is drawn, once that space has been measured. */
  const [orbPlacement, setOrbPlacement] = useState<{ x: number; y: number; scale: number } | undefined>(undefined);
  /**
   * Which mounting of the conversation is on screen.
   *
   * Opening another conversation from the inbox changes the remembered id and bumps this, so the conversation is
   * mounted afresh on the new record instead of each of its hooks having to learn that its conversation changed
   * under it. It is the same thing a reload does, without the reload.
   */
  const [conversationKey, setConversationKey] = useState(0);


  /*
   * The orb is placed against the space reserved for it, not against the screen.
   *
   * This is the app's own arrangement, and the difference matters: a canvas is drawn at 960 across and shrinking it
   * with a transform does not shrink the box it occupies, so the only way to have an orb of a chosen size in a layout
   * is to reserve that size and scale the drawing into it. Placed at the centre of the screen at full size first, the
   * ball covered the name and the button - which is what a person means by "the orb is over the interface".
   *
   * Measured over a bounded settle window rather than once, because the heading arrives with its webfont and moves
   * everything below it; a single measurement describes a page that no longer exists.
   */
  useLayoutEffect(() => {
    if (onboarded) return;
    const measure = (): void => {
      const shellBox = shellRef.current?.getBoundingClientRect();
      const anchor = heroOrbRef.current?.getBoundingClientRect();
      if (shellBox === undefined || anchor === undefined) return;
      setOrbPlacement({
        x: anchor.left + anchor.width / 2 - shellBox.left,
        y: anchor.top + anchor.height / 2 - shellBox.top,
        scale: anchor.width / ORB_DRAW_SIZE,
      });
    };
    measure();
    const timers = [0, 50, 150, 400, 900].map((ms) => setTimeout(measure, ms));
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => measure()) : undefined;
    if (observer !== undefined && heroOrbRef.current?.parentElement != null) {
      observer.observe(heroOrbRef.current.parentElement);
    }
    void document.fonts?.ready.then(() => measure());
    return () => {
      for (const timer of timers) clearTimeout(timer);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [onboarded]);

  /*
   * Read regardless of whether the first run is over.
   *
   * It used to be fetched only while onboarding, which was right when its only reader was the wizard. The
   * conversation now asks whether this node has a model, and a fact about the node does not stop being true
   * once somebody has pressed Get Started — so guarding this on `onboarded` meant the setup card appeared
   * during the first run and never again.
   */
  useEffect(() => {
    let cancelled = false;
    void client
      .readiness()
      .then((answer) => {
        if (!cancelled) setReadiness(answer);
      })
      .catch(() => {
        // A node that cannot answer is treated as unanswered rather than as ready: the cost of asking unnecessarily is a
        // skipped question, and the cost of not asking is a step nobody can complete.
        if (!cancelled) setReadiness({ model: false, credentials: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [onboarded, client]);

  /*
   * What somebody sees the first time.
   *
   * The product's name, one sentence about what it is, and one button. Everything else this interface needs — a
   * provider, a model, a key — is asked for when it is needed and with the reason in front of the person, rather
   * than as a form in front of a thing they have not used yet.
   *
   * This was a four-step wizard: welcome, then provider, then model, then key. It asked before anything had been
   * tried — which is how a real key ends up in a screenshot — and it dead-ended whenever the machine had no
   * provider to offer, which is the state a fresh install is most likely to be in. The steps are gone. What a
   * node still needs is asked for by the conversation, when a turn actually needs it.
   */
  if (!onboarded) {
    const start = (): void => {
      // Written before the state flips, so a reload during the transition does not show this screen again.
      window.localStorage.setItem("cc_onboarded", "1");
      setOnboarded(true);
    };

    return (
      <div className="cc-shell" data-view="hero" data-onboarding="true" ref={shellRef}>
        {/*
          The same orb the app opens with, drawn before anything is chosen. The first screen is where somebody decides
          whether this thing is worth their afternoon, and it was the one place the product's own face was missing.
        */}
        {orbPlacement === undefined ? null : (
          <div className="cc-orb-stage">
            <div
              className="cc-stage-orb"
              data-docked="false"
              style={{
                left: `${orbPlacement.x}px`,
                top: `${orbPlacement.y}px`,
                transform: `translate(-50%, -50%) scale(${orbPlacement.scale})`,
              }}
            >
              <Orb
                size={ORB_DRAW_SIZE}
                radius={ORB_RADIUS}
                className="cc-empty-orb"
                label="ClarkCant"
                // Drawn at a lower ratio than the small orbs: the canvas is 960 across, and at two device pixels per CSS
                // pixel that is nearly four million fragments a frame for a soft glow nobody can see the difference in.
                maxPixelRatio={1.25}
                pointerTarget={shellRef}
                {...(orbProfile === undefined ? {} : { profile: orbProfile })}
              />
            </div>
          </div>
        )}
        <div className="cc-body">
          <div className="cc-scroll">
            <div className="cc-empty">
              {/* Reserves the space the orb is drawn into, exactly as the app's own hero does. It paints nothing. */}
              <div className="cc-hero-orb" ref={heroOrbRef} aria-hidden="true" />
              <h1>ClarkCant</h1>
              <p>{t("shell.onboarding.tagline")}</p>
              <div className="cc-chip-row">
                <button type="button" className="cc-chip" data-onboarding-start="true" onClick={start}>
                  {t("shell.onboarding.start")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (token === "") {
    return (
      // The same shape the start screen uses, so the two screens centre their content the same way:
      // `data-view="hero"` is what tells the layout to centre the group rather than stack it from the
      // top, and `.cc-body` is the region that does the centring.
      <div className="cc-shell" data-view="hero">
        <header className="cc-header">
          <div className="cc-brand">
            <span className="cc-orb" aria-hidden="true" />
            <span>ClarkCant</span>
          </div>
          <div className="cc-status">
            <span className="cc-dot" data-state="offline" aria-hidden="true" />
            {t("shell.onboarding.noToken")}
          </div>
        </header>
        <div className="cc-body">
          <div className="cc-scroll">
            <div className="cc-empty">
              <h1>{t("shell.onboarding.notConnectedHeading")}</h1>
              <p data-needs-token="true">
                {t("shell.onboarding.notConnectedBody")}{" "}
                <code>{t("shell.onboarding.notConnectedExample")}</code>. {t("shell.onboarding.notConnectedTokenNote")}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // The conversation id lives in session storage, so reopening the tab resumes the same
  // conversation without introducing a session picker the user would have to learn.
  const existing = window.sessionStorage.getItem("cc_conversation") ?? undefined;

  return (
    <Conversation
      key={conversationKey}
      client={client}
      // Spread rather than passing undefined: with exactOptionalPropertyTypes an optional
      // prop may be absent, but may not be explicitly undefined.
      {...(existing === undefined ? {} : { conversationId: existing })}
      onConversationReady={(conversationId) => window.sessionStorage.setItem("cc_conversation", conversationId)}
      // Remembering the conversation and forgetting it belong in the same place. Without this the
      // start screen would appear and the next reload would pull the old conversation back.
      onSessionReset={() => window.sessionStorage.removeItem("cc_conversation")}
      onOpenConversation={(conversationId) => {
        window.sessionStorage.setItem("cc_conversation", conversationId);
        setConversationKey((key) => key + 1);
      }}
      {...(orbProfile === undefined ? {} : { orbProfile })}
      /*
       * What the node still needs, so the conversation can offer it where a turn actually needs it. The
       * wizard used to ask this before anything had been tried; this asks it in the place the answer is
       * used, and only when the answer is missing.
       */
      {...(readiness?.model === false ? { needsModel: true } : {})}
      // The orb is drawn by this host, so this host is what re-resolves it after a settings write.
      onOrbChange={refreshOrbProfile}
    />
  );
}

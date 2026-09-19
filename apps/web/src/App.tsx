import { type ReactElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  Conversation,
  GatewayClient,
  ORB_DRAW_SIZE,
  ORB_RADIUS,
  Orb,
  installStyles,
  readStoredTheme,
  resolveTheme,
  sessionFromBridge,
  systemPrefersLight,
  firstRunSteps,
  type FirstRunStep,
  prefersReducedMotion,
  resolveOrbProfile,
  type RegisteredPreference,
  type ResolvedOrbProfile,
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
   * Resolved once here and passed down rather than read by the orb itself: the conversation re-renders
   * many times per turn, and a component that fetched its own preferences would rebuild the orb's GPU
   * program on whatever schedule its own re-renders happened to follow.
   *
   * Undefined until the node answers, and it stays undefined on failure. The orb is the product's own face,
   * so a node that cannot answer for a preference must not be the reason it is missing — the shipped
   * profile is what draws in that case.
   */
  const [orbProfile, setOrbProfile] = useState<ResolvedOrbProfile | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void client
      .preferences()
      .then((listed) => {
        if (cancelled) return;
        /*
         * The registered preference itself rather than its value, so nothing here has to name `unknown`.
         * `resolveOrbProfile` is the boundary that parses what a stored value actually is; this only has to
         * find the row.
         */
        const preference = (key: string): RegisteredPreference | undefined =>
          listed.preferences.find((candidate) => candidate.key === key);
        setOrbProfile(
          resolveOrbProfile({
            profile: preference("orb.profile")?.value,
            custom: preference("orb.custom")?.value,
            // Two ways to ask for stillness, and either one is enough: the platform's own setting, and the
            // choice this application stores. A preference that could outrank the platform one would make
            // the accessibility switch a lie.
            reducedMotion:
              preference("experience.motion")?.value === "reduced" || prefersReducedMotion(),
          }),
        );
      })
      .catch(() => {
        // Left undefined deliberately; see above.
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  /**
   * What the node says it already has.
   *
   * Undefined until it answers, and the full walk is the fallback: asking is the recoverable failure, because a question
   * skipped by mistake cannot be asked again, and the answer decides which steps are worth showing at all.
   */
  const [readiness, setReadiness] = useState<{ model: boolean; credentials: string[] } | undefined>(undefined);

  /**
   * Which of the first-run steps is showing, and the choices made so far.
   *
   * A step machine rather than one screen, because these are genuinely two questions: which provider, and which of
   * that provider's models. The provider list is read from the node, so it is pi's own catalogue rather than one
   * written here and a provider added by upgrading pi appears without this file changing.
   */
  /** The surface the orb reads the pointer against, so its glow reacts here as it does once the app is open. */
  const shellRef = useRef<HTMLDivElement>(null);

  /** The space the first run reserves for the orb. The orb measures itself from this rather than from the screen. */
  const heroOrbRef = useRef<HTMLDivElement>(null);
  /** Where the orb is drawn, once that space has been measured. */
  const [orbPlacement, setOrbPlacement] = useState<{ x: number; y: number; scale: number } | undefined>(undefined);

  const [onboardStep, setOnboardStep] = useState<"welcome" | "provider" | "model" | "key">("welcome");
  const [pickedProvider, setPickedProvider] = useState<string | undefined>(undefined);
  const [pickedModel, setPickedModel] = useState<string | undefined>(undefined);
  /**
   * The key being typed, and what became of the last attempt.
   *
   * Held in state only long enough to send it, and cleared once the node has it: a secret that stays in the page is a
   * secret in a screenshot, a devtools panel and whatever else reads the DOM.
   */
  const [keyDraft, setKeyDraft] = useState("");
  const [keyStatus, setKeyStatus] = useState<string | undefined>(undefined);
  const [catalogue, setCatalogue] = useState<{ id: string; models: { id: string }[] }[] | undefined>(undefined);

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
  }, [onboarded, onboardStep]);

  useEffect(() => {
    if (onboarded) return;
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

  useEffect(() => {
    if (onboarded || onboardStep !== "provider" || catalogue !== undefined) return;
    let cancelled = false;
    void client
      .model()
      .then((answer) => {
        if (!cancelled) setCatalogue(answer.catalogue);
      })
      .catch(() => {
        // An empty list rather than an error. What this step needs is a choice, and a node that cannot answer the
        // question still leaves the person able to carry on instead of staring at a failure they cannot act on.
        if (!cancelled) setCatalogue([]);
      });
    return () => {
      cancelled = true;
    };
  }, [onboarded, onboardStep, catalogue, client]);

  /*
   * What somebody sees the first time.
   *
   * The product's name, one sentence about what it is, and one button. Everything else this interface needs - a
   * provider, a model, a key - is asked for when it is needed and with the reason in front of the person, rather than
   * as a form in front of a thing they have not used yet.
   */
  if (!onboarded) {
    const finish = (): void => {
      // Written before the state flips, so a reload during the transition does not show this screen again.
      window.localStorage.setItem("cc_onboarded", "1");
      setOnboarded(true);
    };
    const pickedModels = catalogue?.find((provider) => provider.id === pickedProvider)?.models ?? [];
    /*
     * The steps worth showing, decided once from what the node reported. A node started from a filled-in environment
     * needs nothing, so Get Started goes straight into the app rather than asking for a provider, a model and a key it
     * already has - and asking anyway asks somebody to retype a key, which is how a real key ends up in a screenshot.
     */
    const steps = firstRunSteps(readiness ?? { model: false, credentials: [] });
    /** Moves to whatever comes next in that list, or opens the app when nothing does. */
    const advanceFrom = (current: FirstRunStep): void => {
      const next = steps[steps.indexOf(current) + 1];
      if (next === undefined) finish();
      else setOnboardStep(next);
    };

    return (
      <div
        className="cc-shell"
        data-view="hero"
        data-onboarding="true"
        data-onboarding-step={onboardStep}
        ref={shellRef}
      >
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
              {onboardStep === "welcome" ? (
                <>
                  <h1>ClarkCant</h1>
                  <p>Clark Cant Can. The Most Minimal Yet Powerful Harness You&apos;ve Ever Need.</p>
                  <div className="cc-chip-row">
                    <button
                      type="button"
                      className="cc-chip"
                      data-onboarding-start="true"
                      onClick={() => advanceFrom("welcome")}
                    >
                      Get Started
                    </button>
                  </div>
                </>
              ) : onboardStep === "provider" ? (
                <>
                  <h1>Provider</h1>
                  <p>Chọn provider để chạy phiên chính. Danh sách này đọc từ pi trên máy.</p>
                  {catalogue === undefined ? (
                    <p className="cc-panel-note">Đang đọc…</p>
                  ) : catalogue.length === 0 ? (
                    <>
                      {/*
                       * A node that reports no provider is still a working node: it answers from recipes and installed
                       * capabilities. Saying that, and letting the person carry on, beats a step that cannot be
                       * completed - which is what an onboarding that dead-ends amounts to.
                       */}
                      <p className="cc-panel-note" data-onboarding-none="true">
                        Node chưa thấy provider nào. Harness vẫn dùng được: nó trả lời bằng recipe và capability đã cài.
                        Cấu hình provider cho pi rồi mở lại, hoặc đi tiếp.
                      </p>
                      <div className="cc-chip-row">
                        <button
                          type="button"
                          className="cc-chip"
                          data-onboarding-finish="true"
                          onClick={() => advanceFrom("provider")}
                        >
                          Tiếp tục
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="cc-chip-row">
                      {catalogue.map((provider) => (
                        <button
                          key={provider.id}
                          type="button"
                          className="cc-chip"
                          data-onboarding-provider={provider.id}
                          onClick={() => {
                            setPickedProvider(provider.id);
                            setOnboardStep("model");
                          }}
                        >
                          {provider.id}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : onboardStep === "model" ? (
                <>
                  <h1>Model</h1>
                  <p>Chọn model cho phiên chính.</p>
                  {/*
                   * A select rather than a row of chips. A provider can offer dozens of models - the first provider in
                   * this machine's catalogue alone offers more than the screen is tall - and a wall of buttons that has
                   * to be scrolled is worse than a control built for choosing from a long list.
                   */}
                  <label className="cc-panel-note" htmlFor="cc-onboarding-model">
                    Model của {pickedProvider}
                  </label>
                  <select
                    id="cc-onboarding-model"
                    className="cc-select"
                    data-onboarding-model-select="true"
                    value={pickedModel ?? pickedModels[0]?.id ?? ""}
                    onChange={(event) => setPickedModel(event.target.value)}
                  >
                    {pickedModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.id}
                      </option>
                    ))}
                  </select>
                  <div className="cc-chip-row">
                    <button
                      type="button"
                      className="cc-chip"
                      data-onboarding-continue="true"
                      onClick={() => {
                        const model = pickedModel ?? pickedModels[0]?.id;
                        if (pickedProvider !== undefined && model !== undefined) {
                          window.localStorage.setItem("cc_model", `${pickedProvider}/${model}`);
                        }
                        advanceFrom("model");
                      }}
                    >
                      Tiếp tục
                    </button>
                  </div>
                  {/*
                   * Said here rather than left to be discovered: the node runs the model its own configuration names,
                   * so this choice is remembered for this browser and is not a remote control for the node. An
                   * onboarding that implied otherwise would be lying at the first screen a person ever sees.
                   */}
                  <p className="cc-panel-note">
                    Node lấy model từ cấu hình của chính nó (CC_MODEL_PROVIDER / CC_MODEL_ID). Lựa chọn ở đây được ghi
                    nhớ cho trình duyệt này.
                  </p>
                </>
              ) : (
                <>
                  <h1>TypeSafe</h1>
                  <p>
                    Jev dùng TypeSafe khi nó phải quyết định cách xử lý một việc. Bỏ qua được: nhập sau trong Cài đặt
                    cũng không sao.
                  </p>
                  <form
                    className="cc-credential-form"
                    data-onboarding-key="typesafe"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const value = keyDraft.trim();
                      if (value === "") return;
                      void client
                        .putCredential({ fields: [{ name: "typesafe", value }] })
                        .then((answer) => {
                          // Cleared, and the confirmation names the credential rather than repeating what was typed: a
                          // secret echoed into a status line is a secret written to a screenshot and a log.
                          setKeyDraft("");
                          setKeyStatus(`Đã lưu khoá: ${answer.names.join(", ")}`);
                          finish();
                        })
                        .catch((cause: unknown) => {
                          setKeyStatus(
                            `Không lưu được: ${cause instanceof Error ? cause.message : String(cause)}`,
                          );
                        });
                    }}
                  >
                    <input
                      type="password"
                      className="cc-select"
                      autoComplete="off"
                      placeholder="TypeSafe API key"
                      data-onboarding-key-input="true"
                      value={keyDraft}
                      onChange={(event) => setKeyDraft(event.target.value)}
                    />
                    <div className="cc-chip-row">
                      <button type="submit" className="cc-chip" data-onboarding-key-save="true">
                        Lưu
                      </button>
                      <button type="button" className="cc-chip" data-onboarding-finish="true" onClick={() => finish()}>
                        Bỏ qua
                      </button>
                    </div>
                  </form>
                  {keyStatus === undefined ? null : (
                    <p className="cc-panel-note" data-onboarding-key-status="true">
                      {keyStatus}
                    </p>
                  )}
                </>
              )}
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
            Chưa có token
          </div>
        </header>
        <div className="cc-body">
          <div className="cc-scroll">
            <div className="cc-empty">
              <h1>Chưa kết nối tới runtime</h1>
              <p data-needs-token="true">
                Mở trang này kèm token của node, ví dụ{" "}
                <code>?token=&lt;token trong identity.json&gt;</code>. Token chỉ được giữ trong tab này.
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
      client={client}
      // Spread rather than passing undefined: with exactOptionalPropertyTypes an optional
      // prop may be absent, but may not be explicitly undefined.
      {...(existing === undefined ? {} : { conversationId: existing })}
      onConversationReady={(conversationId) => window.sessionStorage.setItem("cc_conversation", conversationId)}
      // Remembering the conversation and forgetting it belong in the same place. Without this the
      // start screen would appear and the next reload would pull the old conversation back.
      onSessionReset={() => window.sessionStorage.removeItem("cc_conversation")}
      {...(orbProfile === undefined ? {} : { orbProfile })}
    />
  );
}

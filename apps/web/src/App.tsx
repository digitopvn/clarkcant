import { type ReactElement, useMemo, useState } from "react";

import { Conversation, GatewayClient, installStyles, readStoredTheme, resolveTheme, systemPrefersLight } from "@clarkcant/conversation-client";

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
  const token = readToken();
  const baseUrl = readGateway();

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

  /*
   * What somebody sees the first time.
   *
   * The product's name, one sentence about what it is, and one button. Everything else this interface needs - a
   * provider, a model, a key - is asked for when it is needed and with the reason in front of the person, rather than
   * as a form in front of a thing they have not used yet.
   */
  if (!onboarded) {
    return (
      <div className="cc-shell" data-view="hero" data-onboarding="true">
        <div className="cc-body">
          <div className="cc-scroll">
            <div className="cc-empty">
              <h1>ClarkCant</h1>
              <p>Clark Cant Can. The Most Minimal Yet Powerful Harness You&apos;ve Ever Need.</p>
              <div className="cc-chip-row">
                <button
                  type="button"
                  className="cc-chip"
                  data-onboarding-start="true"
                  onClick={() => {
                    window.localStorage.setItem("cc_onboarded", "1");
                    setOnboarded(true);
                  }}
                >
                  Get Started
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
    />
  );
}

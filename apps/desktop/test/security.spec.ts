import { describe, expect, it } from "vitest";

import {
  contentSecurityPolicy,
  createWindowOptions,
  IPC_CHANNELS,
  normalizeExternalUrl,
  reviewCredentialRequest,
  reviewDevServerUrl,
  reviewIpcCall,
} from "../src/security.mjs";

/**
 * Desktop shell security tests.
 *
 * These run in Node against the policy module the Electron main process imports, so the
 * posture is checked on every test run rather than confirmed once by opening a window. The
 * window itself is exercised separately by `electron . --smoke-test`.
 *
 * The tests are written as attacks rather than as assertions about an options object: each one
 * names a way in, and checks that the way in is closed.
 */

const SHELL_URL = "file:///Applications/clarkcant/shell.html";

/** A frame as Electron presents it: `parent` is null only for the top-level document. */
function frame(url: string, parent: unknown = null) {
  return { url, parent };
}

function sender(url: string, parent: unknown = null) {
  return { senderFrame: frame(url, parent) };
}

describe("the renderer cannot reach the host", () => {
  it("turns Node integration off in every embedding", () => {
    const options = createWindowOptions("/preload.mjs");
    expect(options.nodeIntegration).toBe(false);
    expect(options.nodeIntegrationInWorker).toBe(false);
    expect(options.nodeIntegrationInSubFrames).toBe(false);
  });

  it("isolates the context and sandboxes the renderer", () => {
    const options = createWindowOptions("/preload.mjs");
    expect(options.contextIsolation).toBe(true);
    // Isolation separates the worlds; the sandbox removes Node from underneath them. Either
    // alone leaves the other as the only barrier.
    expect(options.sandbox).toBe(true);
    expect(options.webSecurity).toBe(true);
  });

  it("refuses to build a window with no preload path, rather than building an unisolated one", () => {
    expect(() => createWindowOptions("")).toThrow(/preload/);
  });

  it("does not enable the webview tag or experimental features", () => {
    const options = createWindowOptions("/preload.mjs");
    expect(options.webviewTag).toBe(false);
    expect(options.experimentalFeatures).toBe(false);
    expect(options.allowRunningInsecureContent).toBe(false);
  });
});

describe("the content security policy leaves no execution primitive", () => {
  const policy = contentSecurityPolicy();

  it("defaults to denying everything", () => {
    expect(policy).toContain("default-src 'none'");
  });

  it("allows no inline or evaluated script", () => {
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).toContain("script-src 'self'");
  });

  it("refuses to be framed and refuses to load plugins", () => {
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
  });
});

describe("the dev policy is the only one that allows inline code", () => {
  it("keeps inline code out when the app and node are served normally", () => {
    const policy = contentSecurityPolicy({ appOrigin: "http://127.0.0.1:4173/", nodeOrigin: "http://127.0.0.1:8765" });
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("allows inline script and style, and the hot-reload socket, for a dev server", () => {
    const policy = contentSecurityPolicy({
      appOrigin: "http://127.0.0.1:5173/?gateway=x",
      nodeOrigin: "http://127.0.0.1:8765",
      devOrigin: "http://127.0.0.1:5173",
    });
    expect(policy).toContain("script-src 'self' http://127.0.0.1:5173 'unsafe-inline'");
    expect(policy).toContain("style-src 'self' http://127.0.0.1:5173 'unsafe-inline'");
    expect(policy).toContain("ws://127.0.0.1:5173");
    expect(policy).not.toContain("unsafe-eval");
  });
});

describe("a dev server is accepted only on loopback in an unpackaged app", () => {
  it("accepts loopback http", () => {
    for (const candidate of ["http://127.0.0.1:5173/", "http://localhost:5173/?gateway=x", "http://[::1]:5173"]) {
      expect(reviewDevServerUrl(candidate, { packaged: false }).ok, candidate).toBe(true);
    }
  });

  it("refuses any address off this machine or not plain http", () => {
    for (const candidate of ["http://192.168.1.2:5173/", "http://dev.example.com/", "https://127.0.0.1:5173/", "file:///x", "nope"]) {
      expect(reviewDevServerUrl(candidate, { packaged: false }).ok, candidate).toBe(false);
    }
  });

  it("refuses every dev server in a packaged app", () => {
    const result = reviewDevServerUrl("http://127.0.0.1:5173/", { packaged: true });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("packaged");
  });
});

describe("openExternal only opens https", () => {
  it("accepts an https URL", () => {
    const result = normalizeExternalUrl("https://example.com/path?q=1");
    expect(result.ok).toBe(true);
    expect(result.ok && result.url).toBe("https://example.com/path?q=1");
  });

  it("refuses every scheme that turns a link into a code path or a local file read", () => {
    const refused = [
      "http://example.com/",
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      `${"java"}script:alert(1)`,
      "vbscript:msgbox(1)",
      "mailto:someone@example.com",
      "custom-handler://do/thing",
    ];
    for (const candidate of refused) {
      const result = normalizeExternalUrl(candidate);
      expect(result.ok, `expected ${candidate} to be refused`).toBe(false);
      expect(result.ok === false && result.reason).toContain("not allowed");
    }
  });

  it("refuses input that is not a URL at all", () => {
    for (const candidate of ["", "not a url", "/etc/passwd", "https://"]) {
      expect(normalizeExternalUrl(candidate).ok, `expected ${candidate} to be refused`).toBe(false);
    }
  });
});

describe("IPC is answered only for the shell document (sender validation)", () => {
  it("allows the loaded shell document on an allowlisted channel", () => {
    expect(reviewIpcCall(sender(SHELL_URL), "desktop:getStatus", SHELL_URL)).toEqual({
      allowed: true,
    });
  });

  it("refuses a channel that is not on the allowlist", () => {
    const review = reviewIpcCall(sender(SHELL_URL), "desktop:runCommand", SHELL_URL);
    expect(review.allowed).toBe(false);
    expect(review.allowed === false && review.reason).toContain("allowlist");
  });

  it("refuses a call from a nested frame, which is how a widget would reach host methods", () => {
    const review = reviewIpcCall(sender(SHELL_URL, { url: SHELL_URL }), "desktop:getStatus", SHELL_URL);
    expect(review.allowed).toBe(false);
    expect(review.allowed === false && review.reason).toContain("nested frame");
  });

  it("refuses a call from a document that is not the one the shell loaded", () => {
    const review = reviewIpcCall(
      sender("https://attacker.example/shell.html"),
      "desktop:getStatus",
      SHELL_URL,
    );
    expect(review.allowed).toBe(false);
    expect(review.allowed === false && review.reason).toContain("not the loaded shell document");
  });

  it("refuses a call whose frame has been destroyed", () => {
    expect(reviewIpcCall({ senderFrame: null }, "desktop:getStatus", SHELL_URL).allowed).toBe(false);
    expect(reviewIpcCall({}, "desktop:getStatus", SHELL_URL).allowed).toBe(false);
  });

  it("a refused channel is still refused after compact mode exists", () => {
    // Adding a channel must not widen the sender check by accident: the new one answers the shell document and
    // nobody else, and a name that is not registered is not a channel.
    const shellFrame = { senderFrame: { url: SHELL_URL } };
    expect(reviewIpcCall(shellFrame, "desktop:setCompactMode", SHELL_URL).allowed).toBe(true);
    expect(
      reviewIpcCall({ senderFrame: { url: "https://example.com/" } }, "desktop:setCompactMode", SHELL_URL).allowed,
    ).toBe(false);
    expect(reviewIpcCall(shellFrame, "desktop:notRegistered", SHELL_URL).allowed).toBe(false);
  });

  it("a detached window cannot minimize or take over the screen of the conversation window", () => {
    const DETACHED_URL = "file:///Applications/clarkcant/detached.html";
    const detached = { senderFrame: { url: DETACHED_URL, parent: null } };
    for (const channel of ["desktop:minimizeWindow", "desktop:setFullScreen"]) {
      expect(reviewIpcCall(sender(SHELL_URL), channel, SHELL_URL, DETACHED_URL).allowed).toBe(true);
      expect(reviewIpcCall(detached, channel, SHELL_URL, DETACHED_URL).allowed).toBe(false);
      // A widget iframe inside the shell is not the shell either.
      expect(reviewIpcCall(sender(SHELL_URL, frame(SHELL_URL)), channel, SHELL_URL).allowed).toBe(false);
    }
  });

  it("allowlists exactly the channels the bridge uses", () => {
    /*
     * Written out rather than derived from the preload bridge on purpose: the point is that adding a channel
     * takes two edits, one of which is this list. A test that read the bridge would agree with whatever the
     * bridge did, including a channel added to the bridge and never reviewed.
     *
     * The window channels are separate entries rather than one `desktop:window` taking a verb, because the
     * allowlist is a list of what this window may do: "resize" and "focus" are different permissions, and hiding
     * that distinction inside a payload would put the decision where review cannot see it.
     */
    expect([...IPC_CHANNELS].sort()).toEqual([
      "desktop:attachWidget",
      "desktop:closeWindow",
      "desktop:detachWidget",
      "desktop:focusWindow",
      "desktop:getSession",
      "desktop:getStatus",
      "desktop:minimizeWindow",
      "desktop:notify",
      "desktop:openExternal",
      "desktop:pickDirectory",
      "desktop:requestCredential",
      "desktop:resizeWindowPreset",
      "desktop:restoreWindow",
      "desktop:setCompactMode",
      "desktop:setFullScreen",
      "desktop:setKeepRunning",
      "desktop:setWindowMode",
      "detached:bootstrap",
      "detached:intent",
      "detached:release",
    ]);
  });
});

describe("a credential prompt has to explain itself", () => {
  it("accepts a request that states a real purpose", () => {
    const review = reviewCredentialRequest({
      requestId: "req_1",
      purpose: "Sign in to the team calendar so the agent can read your agenda.",
    });
    expect(review.allowed).toBe(true);
  });

  it("refuses a purpose too short to consent to", () => {
    for (const purpose of ["", "  ", "why", "login"]) {
      const review = reviewCredentialRequest({ requestId: "req_1", purpose });
      expect(review.allowed, `expected purpose ${JSON.stringify(purpose)} to be refused`).toBe(false);
      expect(review.allowed === false && review.reason).toContain("purpose");
    }
  });

  it("refuses a request with no usable identity", () => {
    for (const requestId of ["", "x".repeat(129), 42, null]) {
      const review = reviewCredentialRequest({
        requestId,
        purpose: "Sign in to the team calendar so the agent can read your agenda.",
      });
      expect(review.allowed, `expected requestId ${String(requestId)} to be refused`).toBe(false);
    }
  });

  it("refuses input that is not a request object", () => {
    for (const input of [null, undefined, "req", 7]) {
      expect(reviewCredentialRequest(input).allowed).toBe(false);
    }
  });
});

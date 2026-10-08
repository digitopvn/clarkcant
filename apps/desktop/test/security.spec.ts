import { describe, expect, it } from "vitest";

import { BROKER_RELAY_VERBS } from "../src/detached-window.mjs";
import {
  contentSecurityPolicy,
  createWindowOptions,
  DETACHED_WINDOW_CHANNELS,
  IPC_CHANNELS,
  normalizeExternalUrl,
  reviewCredentialRequest,
  reviewDevServerUrl,
  reviewIpcCall,
  reviewNotificationTarget,
  withContentSecurityPolicy,
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

  it("plays only media the page itself turned into an object URL", () => {
    const media = policy.split("; ").filter((directive) => directive.startsWith("media-src"));
    expect(media).toEqual(["media-src 'self' blob:"]);
    const served = contentSecurityPolicy({ appOrigin: "http://127.0.0.1:4173/", nodeOrigin: "http://127.0.0.1:8765" });
    expect(served.split("; ").filter((directive) => directive.startsWith("media-src"))).toEqual(["media-src 'self' blob:"]);
  });

  it("refuses to be framed and refuses to load plugins", () => {
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
  });

  it("may frame the node, which serves isolated widgets, and nothing else", () => {
    const frameSrc = (value: string) => value.split("; ").filter((directive) => directive.startsWith("frame-src"));
    // Without the directive `default-src 'none'` refuses every isolated widget in the desktop window.
    expect(frameSrc(contentSecurityPolicy({ appOrigin: "http://127.0.0.1:8765/", nodeOrigin: "http://127.0.0.1:8765" }))).toEqual([
      "frame-src 'self' http://127.0.0.1:8765",
    ]);
    // Under a dev server the app and the node are two origins; frames come from the node.
    const dev = contentSecurityPolicy({
      appOrigin: "http://127.0.0.1:5173/?gateway=x",
      nodeOrigin: "http://127.0.0.1:8765",
      devOrigin: "http://127.0.0.1:5173",
    });
    expect(frameSrc(dev)).toEqual(["frame-src 'self' http://127.0.0.1:5173 http://127.0.0.1:8765"]);
    expect(frameSrc(policy)).toEqual(["frame-src 'self'"]);
  });
});

describe("the window's policy is applied to the window's documents", () => {
  const POLICY = contentSecurityPolicy({ appOrigin: "http://127.0.0.1:8765/" });
  const WIDGET_POLICY = "default-src 'none'; script-src 'nonce-abc' 'self'; frame-ancestors 'self'";

  it("is set on the window's own document", () => {
    const headers = withContentSecurityPolicy({ resourceType: "mainFrame", responseHeaders: { "content-type": ["text/html"] } }, POLICY);
    expect(headers["Content-Security-Policy"]).toEqual([POLICY]);
  });

  const NODE = { nodeOrigin: "http://127.0.0.1:8765" };
  const FRAME_URL = "http://127.0.0.1:8765/frame/grant_abc/widgets/main/index.html";

  it("leaves a framed widget document its own policy, which the window's would refuse outright", () => {
    const responseHeaders = { "content-security-policy": [WIDGET_POLICY] };
    const headers = withContentSecurityPolicy({ resourceType: "subFrame", url: FRAME_URL, responseHeaders }, POLICY, NODE);
    expect(headers).toEqual(responseHeaders);
    expect(headers["Content-Security-Policy"]).toBeUndefined();
  });

  it("adds the window's policy to a framed document that is not one of the node's widget frames", () => {
    const responseHeaders = { "content-security-policy": [WIDGET_POLICY] };
    for (const url of [
      "http://127.0.0.1:8765/conversations/c1",
      "http://127.0.0.1:9999/frame/grant_abc/index.html",
      "https://example.com/frame/grant_abc/index.html",
      undefined,
    ]) {
      const headers = withContentSecurityPolicy({ resourceType: "subFrame", url, responseHeaders }, POLICY, NODE);
      expect(headers["Content-Security-Policy"]).toEqual([POLICY]);
    }
    // No node known: no frame keeps its own policy alone.
    const unknownNode = withContentSecurityPolicy({ resourceType: "subFrame", url: FRAME_URL, responseHeaders }, POLICY);
    expect(unknownNode["Content-Security-Policy"]).toEqual([POLICY]);
  });

  it("adds the window's policy to a widget frame whose own policy is empty", () => {
    for (const empty of [[""], ["   "], [], ""]) {
      const responseHeaders = { "Content-Security-Policy": empty };
      const headers = withContentSecurityPolicy({ resourceType: "subFrame", url: FRAME_URL, responseHeaders }, POLICY, NODE);
      expect(headers["Content-Security-Policy"]).toEqual([POLICY]);
    }
  });

  it("gives a framed document with no policy of its own the window's, so nothing is framed with less", () => {
    const headers = withContentSecurityPolicy({ resourceType: "subFrame", responseHeaders: { "content-type": ["text/html"] } }, POLICY);
    expect(headers["Content-Security-Policy"]).toEqual([POLICY]);
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

describe("a notification carries only an inbox target to the renderer", () => {
  // The same vectors as packages/contracts/test/notice-actions.spec.ts: the shell and the page read one grammar.
  it("keeps a target that names one kind of inbox item and an id", () => {
    for (const target of ["notice:ntf_1", "question:q_1", "command-approval:appr_1", "capability-approval:appr_2", "install-approval:appr_4", "task-approval:task_1:appr_3", "notice:a.b-c_d@e/f"]) {
      expect(reviewNotificationTarget(target), target).toBe(target);
    }
  });

  it("drops anything else, so a page cannot use a notification to send the renderer somewhere", () => {
    const refused = [
      undefined,
      null,
      7,
      { target: "notice:ntf_1" },
      "",
      "notice:",
      "notice",
      "effect:eff_1",
      `${"java"}script:alert(1)`,
      "notice:a b",
      "notice:<script>",
      "notice:ntf\n1",
      `notice:${"a".repeat(161)}`,
    ];
    for (const candidate of refused) {
      expect(reviewNotificationTarget(candidate), JSON.stringify(candidate)).toBeUndefined();
    }
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

  it("only the conversation shell can send an appearance update", () => {
    const detachedUrl = "file:///Applications/clarkcant/detached.html";
    expect(reviewIpcCall(sender(SHELL_URL), "desktop:updateAppearance", SHELL_URL, detachedUrl).allowed).toBe(true);
    expect(reviewIpcCall(sender(detachedUrl), "desktop:updateAppearance", SHELL_URL, detachedUrl).allowed).toBe(false);
    expect(reviewIpcCall(sender(SHELL_URL, frame(SHELL_URL)), "desktop:updateAppearance", SHELL_URL, detachedUrl).allowed).toBe(false);
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
      "desktop:notifyPackagesChanged",
      "desktop:openExternal",
      "desktop:pickDirectory",
      "desktop:pickFile",
      "desktop:requestCredential",
      "desktop:resizeWindowPreset",
      "desktop:restoreWindow",
      "desktop:saveFile",
      "desktop:setCompactMode",
      "desktop:setFullScreen",
      "desktop:setKeepRunning",
      "desktop:setWindowMode",
      "desktop:updateAppearance",
      "detached:artifacts.attach",
      "detached:artifacts.create",
      "detached:artifacts.describe",
      "detached:artifacts.discard",
      "detached:artifacts.export",
      "detached:artifacts.finalize",
      "detached:artifacts.pick",
      "detached:artifacts.read",
      "detached:artifacts.write",
      "detached:bootstrap",
      "detached:dev.session",
      "detached:frame.read",
      "detached:intent",
      "detached:jobs.cancel",
      "detached:jobs.get",
      "detached:jobs.list",
      "detached:release",
      "detached:semantic.publish",
      "detached:state.save",
      "detached:tokens.end",
      "detached:tokens.request",
    ]);
  });

  it("lets only the detached document use each detached channel, and refuses it every desktop channel", () => {
    const detachedUrl = "file:///Applications/clarkcant/shell.html?detached=1";
    const relays = [
      "detached:frame.read",
      "detached:state.save",
      "detached:semantic.publish",
      "detached:dev.session",
      ...BROKER_RELAY_VERBS.map((verb) => `detached:${verb}`),
    ];
    expect(DETACHED_WINDOW_CHANNELS).toEqual(expect.arrayContaining(relays));
    for (const channel of DETACHED_WINDOW_CHANNELS) {
      expect(reviewIpcCall(sender(detachedUrl), channel, SHELL_URL, detachedUrl).allowed).toBe(true);
      // The conversation's own document may not ask for them, nor may a frame inside the detached window.
      expect(reviewIpcCall(sender(SHELL_URL), channel, SHELL_URL, detachedUrl).allowed).toBe(false);
      expect(reviewIpcCall(sender(detachedUrl, frame(detachedUrl)), channel, SHELL_URL, detachedUrl).allowed).toBe(false);
      // With no detached window open there is no document entitled to them at all.
      expect(reviewIpcCall(sender(detachedUrl), channel, SHELL_URL, undefined).allowed).toBe(false);
    }
    for (const channel of IPC_CHANNELS.filter((name) => name.startsWith("desktop:"))) {
      expect(reviewIpcCall(sender(detachedUrl), channel, SHELL_URL, detachedUrl).allowed).toBe(false);
    }
  });

  it("offers no generic node call, no external link and no hand-over of a token to a detached window", () => {
    for (const refused of ["detached:openExternal", "detached:node", "detached:getSession", "detached:pickDirectory", "detached:timeline"]) {
      expect(IPC_CHANNELS).not.toContain(refused);
    }
    // Clark's performs are not relayed to a detached window yet.
    expect(IPC_CHANNELS.some((name) => /^detached:perform/.test(name))).toBe(false);
    // Every file, job and token relay names its own verb: none takes a path, a conversation or an instance to act on.
    expect(IPC_CHANNELS.filter((name) => /^detached:(artifacts|jobs|tokens)\./.test(name)).sort()).toEqual(
      BROKER_RELAY_VERBS.map((verb) => `detached:${verb}`).sort(),
    );
  });

  it("lets only the conversation's document tell the desktop the packages changed", () => {
    const detachedUrl = "file:///Applications/clarkcant/shell.html?detached=1";
    expect(reviewIpcCall(sender(SHELL_URL), "desktop:notifyPackagesChanged", SHELL_URL, detachedUrl).allowed).toBe(true);
    expect(reviewIpcCall(sender(detachedUrl), "desktop:notifyPackagesChanged", SHELL_URL, detachedUrl).allowed).toBe(false);
    expect(reviewIpcCall(sender(SHELL_URL, frame(SHELL_URL)), "desktop:notifyPackagesChanged", SHELL_URL, detachedUrl).allowed).toBe(false);
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

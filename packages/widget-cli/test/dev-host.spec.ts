import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.ts";
import { startDevHost } from "../src/dev-host.ts";
import {
  DEV_VIEWPORTS,
  applyShellAction,
  auditFrame,
  initialState,
  renderShell,
  shellAttributes,
  type DevShellState,
  type FrameFacts,
} from "../src/dev-shell.ts";

/**
 * The dev host.
 *
 * Two halves, tested differently on purpose. The shell's behaviour — switch the fixture, check 320px, deny a
 * capability, run the accessibility audit — is plain functions, so it is asserted directly and in the same place the
 * page's decisions are made. The server is asserted over HTTP, including the refusal that matters most for a tool
 * that serves a directory: a path outside the package is not served.
 *
 * What is *not* here is the in-page script. It collects facts and forwards actions, and it is the part a browser
 * would have to run; saying so is better than implying the whole host is covered by this file.
 */

const created: string[] = [];

async function tempPackage(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "clark-devhost-"));
  created.push(root);
  expect(await runCli(["widget", "init", root, "--template", "form"])).toBe(0);
  return root;
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

const KNOWN = { fixtures: ["default", "empty", "error", "compact"], capabilities: ["dataset.read@1"] };

describe("the shell's state", () => {
  it("denies every declared capability to begin with", () => {
    const state = initialState({ fixtures: KNOWN.fixtures, requestedCapabilities: KNOWN.capabilities });

    /*
     * Denied, not granted. A simulator that started by granting everything would let an author ship a widget that
     * only works when every capability is available — the state their users are least likely to be in.
     */
    expect(state.capabilities).toEqual({ "dataset.read@1": "denied" });
    expect(state.viewport).toBe("conversation");
    expect(state.fixture).toBe("default");
  });

  it("ignores a fixture that does not exist rather than showing an empty widget", () => {
    const state = initialState({ fixtures: KNOWN.fixtures, requestedCapabilities: [] });

    // A shell that selected a typo'd fixture would look like the widget's bug rather than the typo.
    expect(applyShellAction(state, { kind: "fixture", value: "nope" }, KNOWN).fixture).toBe("default");
    expect(applyShellAction(state, { kind: "fixture", value: "error" }, KNOWN).fixture).toBe("error");
  });

  it("offers 320px as a real viewport, not a note in the docs", () => {
    const state = initialState({ fixtures: KNOWN.fixtures, requestedCapabilities: [] });
    const narrow = applyShellAction(state, { kind: "viewport", value: "narrow-320" }, KNOWN);

    expect(DEV_VIEWPORTS).toContain("narrow-320");
    expect(shellAttributes(narrow)["data-dev-width"]).toBe("320");
  });

  it("ignores a viewport or theme it does not have", () => {
    const state = initialState({ fixtures: KNOWN.fixtures, requestedCapabilities: [] });

    expect(applyShellAction(state, { kind: "viewport", value: "ultrawide" }, KNOWN).viewport).toBe("conversation");
    expect(applyShellAction(state, { kind: "theme", value: "sepia" }, KNOWN).theme).toBe("system");
  });

  it("only simulates capabilities the package declared", () => {
    const state = initialState({ fixtures: KNOWN.fixtures, requestedCapabilities: KNOWN.capabilities });

    // A host does not broker what the manifest never asked for, so neither does the simulator.
    const ignored = applyShellAction(state, { kind: "capability", value: "filesystem.write@1" }, KNOWN);
    expect(ignored.capabilities).toEqual({ "dataset.read@1": "denied" });

    const granted = applyShellAction(state, { kind: "capability", value: "dataset.read@1" }, KNOWN);
    expect(granted.capabilities["dataset.read@1"]).toBe("granted");
    // And it toggles back, because an author checks both paths.
    expect(applyShellAction(granted, { kind: "capability", value: "dataset.read@1" }, KNOWN).capabilities["dataset.read@1"]).toBe("denied");
  });

  it("carries the toggles into the markup as well as onto the screen", () => {
    const state = applyShellAction(
      initialState({ fixtures: KNOWN.fixtures, requestedCapabilities: [] }),
      { kind: "reduced-motion", value: true },
      KNOWN,
    );

    expect(shellAttributes(state)["data-dev-reduced-motion"]).toBe("true");
  });

  it("renders the frame with the host's own sandbox policy", async () => {
    const root = await tempPackage();
    const html = renderShell(
      {
        packageId: "com.example.x",
        definitionId: "com.example.x.main@1",
        fixtures: KNOWN.fixtures,
        requestedCapabilities: KNOWN.capabilities,
        entryUrl: "/widgets/main/index.html",
        definition: { textFallback: "fallback", semanticDescription: "mô tả" },
      },
      initialState({ fixtures: KNOWN.fixtures, requestedCapabilities: KNOWN.capabilities }),
    );

    /*
     * Read the attribute rather than searching the document for the string: the shell explains this policy in a
     * comment, so a substring check would have failed on its own explanation — and would have passed if the
     * attribute were wrong in a way the comment did not mention.
     */
    const sandbox = /sandbox="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(sandbox).toBe("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(html).toContain("data-dev-frame");
    expect(root).toBeTruthy();
  });
});

describe("the accessibility audit", () => {
  const base: FrameFacts = {
    tabbable: [{ name: "Nút", focusVisible: true }],
    targets: [{ name: "Nút", width: 40, height: 32 }],
    images: [{ src: "a.png", alt: "mô tả" }],
    textOverMotion: false,
    zeroDurationAnimation: false,
    declaredTextFallback: "fallback",
  };

  it("passes a frame with nothing to say", () => {
    expect(auditFrame(base, { reducedMotion: false })).toEqual([]);
  });

  it("reports focus that cannot be seen", () => {
    const findings = auditFrame({ ...base, tabbable: [{ name: "Nút", focusVisible: false }] }, { reducedMotion: false });

    expect(findings.map((finding) => finding.id)).toContain("focus-visible");
    expect(findings[0]?.severity).toBe("error");
  });

  it("reports a touch target that is too small, and says how small", () => {
    const findings = auditFrame({ ...base, targets: [{ name: "Nút", width: 16, height: 16 }] }, { reducedMotion: false });
    const finding = findings.find((f) => f.id === "target-size");

    expect(finding).toBeDefined();
    expect(finding?.message).toContain("16x16");
  });

  it("reports an image with no text alternative", () => {
    const findings = auditFrame({ ...base, images: [{ src: "a.png", alt: "  " }] }, { reducedMotion: false });

    expect(findings.map((finding) => finding.id)).toContain("image-alt");
  });

  it("reports text over motion, because readability has to win", () => {
    const findings = auditFrame({ ...base, textOverMotion: true }, { reducedMotion: false });

    expect(findings.map((finding) => finding.id)).toContain("text-over-motion");
  });

  it("treats a zero-duration animation as a bug rather than as reduced motion", () => {
    // The project's rule is explicit about this, and it is the check a reviewer cannot see.
    const findings = auditFrame({ ...base, zeroDurationAnimation: true }, { reducedMotion: true });

    expect(findings.map((finding) => finding.id)).toContain("zero-duration-animation");
  });

  it("reports a missing text fallback, because a reader who cannot see the frame gets nothing", () => {
    const findings = auditFrame({ ...base, declaredTextFallback: "" }, { reducedMotion: false });

    expect(findings.map((finding) => finding.id)).toContain("text-fallback");
  });

  it("warns when nothing is reachable at all rather than calling it clean", () => {
    const findings = auditFrame({ ...base, tabbable: [] }, { reducedMotion: false });
    const finding = findings.find((f) => f.id === "no-tab-stops");

    expect(finding?.severity).toBe("warning");
  });
});

describe("the dev host server", () => {
  async function started(): Promise<{ url: string; stop: () => Promise<void>; host: Awaited<ReturnType<typeof startDevHost>> }> {
    const root = await tempPackage();
    // Watching is off in tests: the reload path is asserted through the counter, not through the filesystem's
    // timing, which differs per platform.
    const host = await startDevHost({ root, port: 0, watchFiles: false });
    return { url: host.url, stop: host.close, host };
  }

  it("serves the shell with the package's fixtures on it", async () => {
    const { url, stop } = await started();
    try {
      const response = await fetch(url);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("data-dev-frame");
      expect(html).toContain('data-dev-action="fixture" data-dev-value="empty"');
      expect(html).toContain('data-dev-action="viewport" data-dev-value="narrow-320"');
      expect(html).toContain("Capability simulator");
      expect(html).toContain("Action log");
      expect(html).toContain("Semantic");
    } finally {
      await stop();
    }
  });

  it("serves the package's own files", async () => {
    const { url, stop } = await started();
    try {
      const fixture = await fetch(`${url}fixtures/default.json`);
      expect(fixture.status).toBe(200);
      expect((await fixture.json()) as unknown).toEqual({ title: "Xin chào" });

      const entry = await fetch(`${url}widgets/main/index.html`);
      expect(entry.status).toBe(200);
      expect(await entry.text()).toContain("<!doctype html>");
    } finally {
      await stop();
    }
  });

  it("refuses a path outside the package", async () => {
    const { url, stop } = await started();
    try {
      /*
       * The refusal that matters most for a tool that serves a directory. A dev server that resolves a path without
       * checking it hands out the author's home directory, which is the ordinary way a local tool becomes a way to
       * read files.
       */
      const escaped = await fetch(`${url}../../../etc/passwd`, { redirect: "manual" });
      expect([403, 404]).toContain(escaped.status);
      expect(await escaped.text()).not.toContain("root:");
    } finally {
      await stop();
    }
  });

  it("answers 404 for a file that is not there, rather than the shell", async () => {
    const { url, stop } = await started();
    try {
      const missing = await fetch(`${url}fixtures/nope.json`);
      expect(missing.status).toBe(404);
    } finally {
      await stop();
    }
  });

  it("applies a control change and reports the new state", async () => {
    const { url, stop, host } = await started();
    try {
      const response = await fetch(`${url}dev/api/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "viewport", value: "narrow-320" }),
      });

      expect(response.status).toBe(200);
      expect(host.state().viewport).toBe("narrow-320");
      // The server's own state is the same model the page drives, so the two cannot disagree.
      expect(((await response.json()) as DevShellState).viewport).toBe("narrow-320");
    } finally {
      await stop();
    }
  });

  it("refuses a malformed action without resetting the shell", async () => {
    const { url, stop, host } = await started();
    try {
      host.apply({ kind: "viewport", value: "compact" });
      const response = await fetch(`${url}dev/api/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });

      expect(response.status).toBe(400);
      // The state is left alone: a bad request should not cost the author their setup.
      expect(host.state().viewport).toBe("compact");
    } finally {
      await stop();
    }
  });

  it("runs the audit over facts posted from the page", async () => {
    const { url, stop } = await started();
    try {
      const response = await fetch(`${url}dev/api/a11y`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tabbable: [{ name: "Nút", focusVisible: false }],
          targets: [],
          images: [],
          textOverMotion: false,
          zeroDurationAnimation: false,
          declaredTextFallback: "fallback",
        }),
      });
      const body = (await response.json()) as { findings: { id: string }[] };

      expect(response.status).toBe(200);
      expect(body.findings.map((finding) => finding.id)).toContain("focus-visible");
    } finally {
      await stop();
    }
  });

  it("opens the reload stream", async () => {
    const { url, stop } = await started();
    try {
      const response = await fetch(`${url}dev/events`, { headers: { accept: "text/event-stream" } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      // The stream is left open by design; closing the reader is what ends it.
      await response.body?.cancel();
    } finally {
      await stop();
    }
  });

  it("refuses to start for a directory that is not a widget package", async () => {
    const empty = mkdtempSync(join(tmpdir(), "clark-devhost-empty-"));
    created.push(empty);

    // Named, so an author who ran it in the wrong directory is told which directory was wrong.
    await expect(startDevHost({ root: empty, port: 0, watchFiles: false })).rejects.toThrow(/no widget facet/);
  });
});

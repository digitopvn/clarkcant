import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { catalogEntry } from "@clarkcant/widget-catalog";

import { runCli } from "../src/cli.ts";
import { createDevArtifactBroker, readFixtureFiles, type DevFixtureFile } from "../src/dev-artifacts.ts";
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
      const shell = await fetch(url);
      const html = await shell.text();
      const framePath = /<iframe[^>]+src="([^"]+)"/.exec(html)?.[1];
      expect(framePath).toBeDefined();
      const framePathname = new URL(framePath ?? "", url).pathname;
      const framePrefix = framePathname.slice(0, framePathname.indexOf("/widgets/"));
      const fixture = await fetch(`${url}${framePrefix.slice(1)}/fixtures/default.json`);
      expect(fixture.status, `request path: ${new URL("fixtures/default.json", new URL(framePath ?? "", url)).pathname}; frame prefix: ${framePrefix}`).toBe(200);
      expect((await fixture.json()) as unknown).toEqual({ title: "Xin chào" });

      const entry = await fetch(new URL(framePath ?? "", url));
      expect(entry.status).toBe(200);
      expect(await entry.text()).toContain("<!doctype html>");
      expect((await fetch(`${url}widgets/main/index.html`)).status).toBe(404);
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

  it("inspects bounded semantic proposals and refuses a forged frame nonce", async () => {
    const { url, stop } = await started();
    try {
      const state = (await (await fetch(`${url}dev/api/state`)).json()) as { bridgeNonce: string };
      const proposal = {
        summary: "quarterly widget summary ".repeat(16),
        selectedIds: ["row-1"],
        values: { query: "north region ".repeat(18) },
      };
      const accepted = await fetch(`${url}dev/api/semantic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: state.bridgeNonce, proposal }),
      });
      const inspection = (await accepted.json()) as {
        doc: { summary: string; values: Record<string, unknown>; source: string };
        clippedOrDropped: string[];
        delta: string[];
        contextNote: string;
        inspectUi: string;
      };

      expect(accepted.status).toBe(200);
      expect(inspection.doc.summary).toHaveLength(300);
      expect(inspection.doc.values.query).toHaveLength(200);
      expect(inspection.doc.source).toBe("frame");
      expect(inspection.clippedOrDropped).toEqual(["summary", "values.query (cleaned or clipped)"]);
      expect(inspection.contextNote).toContain(inspection.doc.summary.slice(0, 30));
      expect(inspection.inspectUi).toContain(inspection.doc.summary.slice(0, 30));

      const changed = await fetch(`${url}dev/api/semantic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: state.bridgeNonce, proposal: { summary: "updated", selectedIds: ["row-2"] } }),
      });
      expect(((await changed.json()) as { delta: string[] }).delta).toContain('summary: "updated"');

      const forged = await fetch(`${url}dev/api/semantic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: "not-the-frame-nonce", proposal: { summary: "forged" } }),
      });
      expect(forged.status).toBe(403);
    } finally {
      await stop();
    }
  });

  it("simulates only declared composition events with a valid frame nonce", async () => {
    const root = await tempPackage();
    const definitionPath = join(root, "widgets", "main", "widget.json");
    const definition = JSON.parse(readFileSync(definitionPath, "utf8")) as Record<string, unknown>;
    definition.eventSchemas = {
      "demo.changed": {
        type: "object",
        properties: { count: { type: "integer", minimum: 0 } },
        required: ["count"],
        additionalProperties: false,
      },
    };
    writeFileSync(definitionPath, JSON.stringify(definition, null, 2) + "\n");
    const host = await startDevHost({ root, port: 0, watchFiles: false });
    const { url } = host;
    try {
      const state = (await (await fetch(`${url}dev/api/state`)).json()) as { bridgeNonce: string };
      const accepted = await fetch(`${url}dev/api/composition-event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: state.bridgeNonce, name: "demo.changed", payload: { count: 2 } }),
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ ok: true, event: { name: "demo.changed", payload: { count: 2 } } });

      const undeclared = await fetch(`${url}dev/api/composition-event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: state.bridgeNonce, name: "not.declared", payload: {} }),
      });
      expect(undeclared.status).toBe(400);
      expect((await undeclared.json() as { problem: string }).problem).toContain("does not declare event");

      const malformed = await fetch(`${url}dev/api/composition-event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: state.bridgeNonce, name: "demo.changed", payload: { count: "invalid" } }),
      });
      expect(malformed.status).toBe(400);

      const forged = await fetch(`${url}dev/api/composition-event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: "not-the-frame-nonce", name: "query.change", payload: { query: "x" } }),
      });
      expect(forged.status).toBe(403);
    } finally {
      await host.close();
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

describe("the dev host serving a catalog widget", () => {
  async function started(builtin: string): Promise<{ url: string; stop: () => Promise<void> }> {
    // No package directory is read, because a catalog widget has none: this is the whole reason the option exists.
    const host = await startDevHost({ builtin, port: 0, watchFiles: false });
    return { url: host.url, stop: host.close };
  }

  it("serves the same shell, naming a catalog widget instead of a package", async () => {
    const { url, stop } = await started("canvas.line@1");
    try {
      const response = await fetch(url);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("canvas.line@1");
      // The same surface, so the same frame policy: a builtin preview is not given a weaker sandbox.
      expect(html).toContain('sandbox="allow-scripts"');
      expect(html).toContain('src="/catalog-runtime.html"');
    } finally {
      await stop();
    }
  });

  it("offers the entry's own fixtures, so the fixture control is not decorative", async () => {
    const { url, stop } = await started("canvas.line@1");
    try {
      const html = await (await fetch(url)).text();
      const first = catalogEntry("canvas.line@1")?.fixtures[0]?.id;

      expect(first).toBeDefined();
      expect(html).toContain(`data-dev-action="fixture" data-dev-value="${String(first)}"`);
    } finally {
      await stop();
    }
  });

  it("hands the frame the fixture the shell is showing", async () => {
    const host = await startDevHost({ builtin: "canvas.line@1", port: 0, watchFiles: false });
    try {
      const before = await (await fetch(`${host.url}catalog-runtime.html`)).text();
      const other = catalogEntry("canvas.line@1")?.fixtures[1]?.id;
      expect(other, "this test needs an entry with more than one fixture").toBeDefined();
      if (other === undefined) return;

      host.apply({ kind: "fixture", value: other });
      const after = await (await fetch(`${host.url}catalog-runtime.html`)).text();

      // The page carries the state on screen rather than a default, so changing the control changes what is drawn.
      expect(before).not.toBe(after);
      expect(after).toContain(`"fixtureId":"${other}"`);
    } finally {
      await host.close();
    }
  });

  it("serves the runtime module Vite builds from the workspace source", async () => {
    const { url, stop } = await started("canvas.note@1");
    try {
      // The module the frame loads. Serving it is what makes the preview the production renderer rather than a
      // second implementation of it, so this is the assertion the option rests on. `Sec-Fetch-Dest` is what a
      // browser's own module request carries and a bare fetch does not, and Vite answers only the former.
      const response = await fetch(`${url}src/catalog-runtime.tsx`, { headers: { "sec-fetch-dest": "script" } });
      const code = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("javascript");
      expect(code).toContain("WidgetPreview");
    } finally {
      await stop();
    }
  });

  it("refuses an id the catalog does not have, by name", async () => {
    await expect(startDevHost({ builtin: "canvas.nope@1", port: 0, watchFiles: false })).rejects.toThrow(
      /canvas\.nope@1 is not a definition in the catalog/,
    );
  });

  it("refuses to be given both a package and a catalog widget", async () => {
    await expect(
      startDevHost({ root: process.cwd(), builtin: "canvas.note@1", port: 0, watchFiles: false }),
    ).rejects.toThrow(/not both/);
  });
});

describe("the simulated file picker", () => {
  const encoder = new TextEncoder();
  const NOTES: DevFixtureFile = { name: "ghi-chu.txt", mimeType: "text/plain", bytes: encoder.encode("xin chào") };
  // Larger than one read, so a reader has to come back for the rest.
  const BIG: DevFixtureFile = { name: "lon.csv", mimeType: "text/csv", bytes: new Uint8Array(262_144 + 10).fill(97) };

  function broker(choice: { current: string }) {
    return createDevArtifactBroker({ files: [NOTES, BIG], choosePick: () => choice.current });
  }

  it("returns the fixture file the shell chose, by name and digest, and nothing about where it is", async () => {
    const choice = { current: "ghi-chu.txt" };
    const outcome = await broker(choice).handle({ op: "pick", accept: ["text/*"] });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.ref).toMatchObject({ v: 1, kind: "external", name: "ghi-chu.txt", mimeType: "text/plain", sizeBytes: 9 });
    expect(outcome.ref?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The ref carries the bare name; the directory it was read from appears nowhere in the answer.
    expect(JSON.stringify(outcome)).not.toContain("fixtures");
  });

  it("answers a closed picker as cancelled, and a type the widget did not ask for as refused", async () => {
    const choice = { current: "" };
    const simulated = broker(choice);

    expect(await simulated.handle({ op: "pick", accept: [] })).toMatchObject({ status: "cancelled" });
    choice.current = "ghi-chu.txt";
    expect(await simulated.handle({ op: "pick", accept: ["image/*"] })).toMatchObject({
      status: "refused",
      code: "ARTIFACT_TYPE_NOT_ACCEPTED",
    });
  });

  it("streams a file larger than one chunk in bounded reads", async () => {
    const choice = { current: "lon.csv" };
    const simulated = broker(choice);
    const picked = await simulated.handle({ op: "pick", accept: ["text/csv"] });
    const artifactId = picked.status === "ok" ? (picked.ref?.artifactId ?? "") : "";

    const first = await simulated.handle({ op: "read", artifactId, offset: 0, length: 262_144 });
    const second = await simulated.handle({ op: "read", artifactId, offset: 262_144, length: 262_144 });

    expect(first).toMatchObject({ status: "ok", eof: false });
    expect(second).toMatchObject({ status: "ok", eof: true });
    const bytes = (outcome: typeof first) => (outcome.status === "ok" ? Buffer.from(outcome.chunkBase64 ?? "", "base64").byteLength : -1);
    expect(bytes(first)).toBe(262_144);
    expect(bytes(second)).toBe(10);
    // A read longer than one chunk is refused rather than served.
    expect(await simulated.handle({ op: "read", artifactId, offset: 0, length: 262_145 })).toMatchObject({ status: "refused" });
  });

  it("writes in order, finalizes, then saves and attaches — and refuses each step taken out of order", async () => {
    const simulated = broker({ current: "" });
    const created = await simulated.handle({ op: "create", mimeType: "text/plain", name: "bao-cao.txt" });
    const artifactId = created.status === "ok" ? (created.ref?.artifactId ?? "") : "";

    expect(await simulated.handle({ op: "export", artifactId, suggestedName: "bao-cao.txt" })).toMatchObject({
      code: "ARTIFACT_NOT_FINALIZED",
    });
    expect(await simulated.handle({ op: "write", artifactId, offset: 0, chunkBase64: "YWJj" })).toMatchObject({ status: "ok" });
    expect(await simulated.handle({ op: "write", artifactId, offset: 0, chunkBase64: "YWJj" })).toMatchObject({
      code: "ARTIFACT_OFFSET_MISMATCH",
    });
    expect(await simulated.handle({ op: "finalize", artifactId })).toMatchObject({ status: "ok", ref: { kind: "finalized", sizeBytes: 3 } });
    expect(await simulated.handle({ op: "write", artifactId, offset: 3, chunkBase64: "YWJj" })).toMatchObject({
      code: "ARTIFACT_NOT_WRITABLE",
    });
    expect(await simulated.handle({ op: "export", artifactId, suggestedName: "ban-sao.txt" })).toMatchObject({ status: "ok" });
    expect(await simulated.handle({ op: "attach", artifactId })).toMatchObject({ status: "ok" });
    // A proposed name is logged as the node would store it: sanitized, with the bytes' type's extension.
    expect(await simulated.handle({ op: "attach", artifactId, name: "../tom tat.exe" })).toMatchObject({ status: "ok" });

    expect(simulated.events().map((event) => `${event.op} ${event.name}`)).toEqual([
      "create bao-cao.txt",
      "finalize bao-cao.txt",
      "export ban-sao.txt",
      "attach bao-cao.txt",
      "attach tom tat.txt",
    ]);
  });

  it("discards a file the widget made, and refuses one the person chose, as the node does", async () => {
    const simulated = broker({ current: "ghi-chu.txt" });
    const created = await simulated.handle({ op: "create", mimeType: "text/plain", name: "nhap.txt" });
    const createdId = created.status === "ok" ? (created.ref?.artifactId ?? "") : "";
    const picked = await simulated.handle({ op: "pick", accept: ["text/plain"] });
    const pickedId = picked.status === "ok" ? (picked.ref?.artifactId ?? "") : "";

    expect(await simulated.handle({ op: "discard", artifactId: createdId })).toEqual({ status: "ok" });
    expect(await simulated.handle({ op: "read", artifactId: createdId, offset: 0, length: 1 })).toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
    expect(await simulated.handle({ op: "discard", artifactId: pickedId })).toMatchObject({ code: "ARTIFACT_NOT_CREATOR" });
    // The refused discard is not recorded: only what the dev host did.
    expect(simulated.events().map((event) => event.op)).toEqual(["create", "pick", "discard"]);
  });

  it("holds a widget to its share of the node's space, so a widget that never discards is caught while developing", async () => {
    const quarterMiB = Buffer.alloc(262_144, 97).toString("base64");
    const simulated = broker({ current: "" });
    const created = await simulated.handle({ op: "create", mimeType: "text/plain" });
    const artifactId = created.status === "ok" ? (created.ref?.artifactId ?? "") : "";

    // 25 MiB per file, so the share is reached across several files.
    let refusal: Awaited<ReturnType<typeof simulated.handle>> | undefined;
    let current = artifactId;
    let offset = 0;
    for (let written = 0; written < 520 && refusal === undefined; written += 1) {
      if (offset + 262_144 > 26_214_400) {
        const next = await simulated.handle({ op: "create", mimeType: "text/plain" });
        current = next.status === "ok" ? (next.ref?.artifactId ?? "") : "";
        offset = 0;
      }
      const outcome = await simulated.handle({ op: "write", artifactId: current, offset, chunkBase64: quarterMiB });
      if (outcome.status === "refused") refusal = outcome;
      else offset += 262_144;
    }

    expect(refusal).toMatchObject({ code: "ARTIFACT_INSTANCE_QUOTA_EXCEEDED" });
  });

  it("refuses a type no node holds and an id it never minted", async () => {
    const simulated = broker({ current: "" });

    expect(await simulated.handle({ op: "create", mimeType: "application/x-msdownload" })).toMatchObject({
      code: "ARTIFACT_TYPE_UNSUPPORTED",
    });
    expect(await simulated.handle({ op: "read", artifactId: "art_someone_else", offset: 0, length: 1 })).toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
    });
    expect(await simulated.handle({ op: "pick", accept: ["../etc"] })).toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("offers only files a node would hold, and says why the others were skipped", async () => {
    const root = await tempPackage();
    mkdirSync(join(root, "fixtures", "files"));
    writeFileSync(join(root, "fixtures", "files", "ghi-chu.txt"), "xin chào");
    writeFileSync(join(root, "fixtures", "files", "setup.exe"), "MZ");

    const read = readFixtureFiles(root);

    expect(read.files.map((file) => file.name)).toEqual(["ghi-chu.txt"]);
    expect(read.skipped).toEqual(["setup.exe: not a type a node holds"]);
  });

  it("switches the next pick between fixture files and Cancel, and ignores a file that is not there", () => {
    const known = { ...KNOWN, files: ["ghi-chu.txt", "lon.csv"] };
    const state = initialState({ fixtures: KNOWN.fixtures, requestedCapabilities: [], files: known.files });

    expect(state.pickFile).toBe("ghi-chu.txt");
    expect(applyShellAction(state, { kind: "pick-file", value: "lon.csv" }, known).pickFile).toBe("lon.csv");
    expect(applyShellAction(state, { kind: "pick-file", value: "" }, known).pickFile).toBe("");
    expect(applyShellAction(state, { kind: "pick-file", value: "C:/secrets.txt" }, known).pickFile).toBe("ghi-chu.txt");
  });

  it("answers the frame's pick through the dev host, from the package's fixture files", async () => {
    const root = await tempPackage();
    mkdirSync(join(root, "fixtures", "files"));
    writeFileSync(join(root, "fixtures", "files", "ghi-chu.txt"), "xin chào");
    const host = await startDevHost({ root, port: 0, watchFiles: false });
    try {
      const shell = await (await fetch(host.url)).text();
      expect(shell).toContain('data-dev-action="pick-file" data-dev-value="ghi-chu.txt"');

      host.apply({ kind: "fixture", value: "default" });
      const state = (await (await fetch(`${host.url}dev/api/state`)).json()) as { bridge: boolean; props: unknown };
      // A package's frame is handed the props of the fixture on screen in the handshake the shell sends.
      expect(state.bridge).toBe(true);
      expect(state.props).toEqual({ title: "Xin chào" });

      const response = await fetch(`${host.url}dev/api/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "pick", accept: ["text/plain"] }),
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(JSON.parse(text)).toMatchObject({ status: "ok", ref: { name: "ghi-chu.txt", kind: "external" } });
      expect(text).not.toContain(root);
      expect(host.artifactEvents()).toEqual([{ op: "pick", name: "ghi-chu.txt", sizeBytes: 9 }]);

      host.apply({ kind: "pick-file", value: "" });
      const cancelled = await fetch(`${host.url}dev/api/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "pick", accept: [] }),
      });
      expect(await cancelled.json()).toMatchObject({ status: "cancelled" });
    } finally {
      await host.close();
    }
  });
});

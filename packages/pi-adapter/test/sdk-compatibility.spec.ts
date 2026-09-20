import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

/**
 * The pinned SDK's actual API, asserted rather than assumed.
 *
 * This file exists because the plan was written against documentation for a newer SDK than the one
 * installed. The plan describes appending to `systemPromptOptions.sections`. The installed package
 * (0.85.1) has no such field: its options are `{cwd, skills, contextFiles, customPrompt,
 * appendSystemPrompt, selectedTools, toolSnippets, promptGuidelines}`, and the only way an extension can
 * reach the system prompt is to return `{systemPrompt}` from a `before_agent_start` handler.
 *
 * That is the case the phase contract names: a pinned typed API that differs from the latest docs means
 * the compatibility test fails and the phase adapts to the exact API rather than falling back to
 * prefixing the user prompt. This is that test, written against the real package so an upgrade that
 * changes any of these facts fails here instead of in a user's turn.
 *
 * It imports the SDK directly, which is allowed here and nowhere else in the repository.
 */

const SDK_PACKAGE = "@earendil-works/pi-coding-agent";

/** One temporary directory for the loader construction, cleaned up at the end. */
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function loadSdk(): Promise<Record<string, unknown>> {
  return (await import(SDK_PACKAGE)) as unknown as Record<string, unknown>;
}

describe("the extension seam this feature depends on", () => {
  it("exports the loader, the session factory and the extension runtime", async () => {
    const sdk = await loadSdk();
    for (const name of ["DefaultResourceLoader", "createAgentSession", "ExtensionRunner", "defineTool"]) {
      expect(typeof sdk[name], `${name} is missing from ${SDK_PACKAGE}`).toBe("function");
    }
  });

  it("has a before_agent_start hook, and it is the one that can reach the system prompt", async () => {
    /*
     * Read from the runner's own source rather than from a type declaration: the hook names are string
     * literals in a Map lookup, so a renamed hook would still typecheck and would silently stop firing.
     * A feature that stops firing looks like a preference that does nothing.
     */
    const sdk = await loadSdk();
    const runner = sdk.ExtensionRunner as { toString(): string };
    const source = runner.toString();

    expect(source).toContain('handlers.get("before_agent_start")');
    // The handler's return value is what carries a modified prompt; without this branch the handler
    // would run and change nothing.
    expect(source).toContain("result.systemPrompt !== undefined");
    expect(source).toContain("emitBeforeAgentStart");
  });

  it("passes the prompt the SDK composed into the hook, so an append can build on it", async () => {
    // The event carries `systemPrompt`, which is the composed base — not an empty string and not only
    // the user's text. If that changed, appending would produce a prompt missing every product and
    // security instruction, which is the failure this whole design exists to prevent.
    const sdk = await loadSdk();
    const source = (sdk.ExtensionRunner as { toString(): string }).toString();
    expect(source).toContain("systemPrompt: currentSystemPrompt");
    expect(source).toContain("systemPromptOptions");
  });

  it("builds its system prompt from structured options that do not include `sections`", async () => {
    /*
     * The fact that changed the implementation.
     *
     * Asserted in the negative so an upgrade that *adds* `sections` fails here and somebody re-reads the
     * plan: at that point the structured-section approach becomes available and this feature should use
     * it instead of the append.
     */
    const sdk = await loadSdk();
    const source = (sdk.AgentSession as { toString(): string }).toString();
    const at = source.indexOf("_baseSystemPromptOptions = {");
    expect(at, "the SDK no longer assembles system prompt options where this test looks").toBeGreaterThan(0);

    const options = source.slice(at, at + 600);
    for (const field of ["cwd", "customPrompt", "appendSystemPrompt", "selectedTools", "promptGuidelines"]) {
      expect(options, `systemPromptOptions no longer carries ${field}`).toContain(field);
    }
    // The plan's assumption, which the installed package does not satisfy.
    expect(options, "the SDK now has structured sections; the plan's approach may be available").not.toContain("sections:");
  });

  it("accepts named, hidden inline extension factories on the loader", async () => {
    // The shape the adapter passes. A named factory is what makes the extension identifiable in a
    // diagnostic, and `hidden` is what keeps it out of the list of the user's own extensions.
    const sdk = await loadSdk();
    const loader = sdk.DefaultResourceLoader as { prototype: { loadExtensionFactories: unknown } };
    const source = String(loader.prototype.loadExtensionFactories);
    expect(source).toContain("extensionFactories");
    expect(source).toContain("input.name");
    expect(source).toContain("hidden");
    expect(source).toContain("<inline:");
  });

  it("calls an inline factory with an api that can register the hook", async () => {
    /*
     * The end-to-end proof that the wiring shape is right: construct a real loader with a real inline
     * factory and assert the factory was called with an object that has `on`.
     *
     * This is the one test here that runs SDK code rather than reading it, and it is the one that would
     * catch a change in how factories are invoked.
     */
    const sdk = await loadSdk();
    const dir = mkdtempSync(join(tmpdir(), "cc-compat-"));
    dirs.push(dir);

    let received: string[] | undefined;
    const Loader = sdk.DefaultResourceLoader as new (options: Record<string, unknown>) => {
      reload(): Promise<unknown>;
    };

    const loader = new Loader({
      cwd: dir,
      agentDir: dir,
      extensionFactories: [
        {
          name: "clark-compat-probe",
          hidden: true,
          factory: (api: unknown) => {
            received = Object.keys(api as Record<string, unknown>);
            return {};
          },
        },
      ],
    });
    await loader.reload();

    expect(received, "the inline factory was never called").toBeDefined();
    expect(received).toContain("on");
  });
});

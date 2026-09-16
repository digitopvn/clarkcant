import { describe, expect, it, vi } from "vitest";

import { authorApiExposes, handleWidgetMessage, MUST_FAIL, REQUESTED_CAPABILITY, WITHHELD_VERBS } from "../src/bridge.ts";

/**
 * MCP App fixture: the reference bridge (T57-T61).
 *
 * The most valuable assertions here are the absences. A verb that is refused by a check is one
 * refactor away from being reachable; a verb that does not exist in the API surface cannot be
 * reached at all, and that difference is the whole reason the forbidden list is asserted rather
 * than trusted.
 */

const NONCE = "nonce_0123456789abcdef";

function makeHost(overrides: Partial<Parameters<typeof handleWidgetMessage>[0]> = {}) {
  return {
    nonce: NONCE,
    sourceMatchesExpectedWindow: true,
    callTool: vi.fn(async () => ({ text: "echoed" })),
    render: vi.fn(),
    ...overrides,
  };
}

describe("the protocol has no secret-reading verb", () => {
  it("does not expose any withheld verb on the author API", () => {
    for (const verb of WITHHELD_VERBS) {
      expect(authorApiExposes(verb), `${verb} must not be reachable`).toBe(false);
    }
  });

  it("withholds every verb the fixture's own list promises to probe", () => {
    // The withheld verbs are the mechanism; this checks the fixture is honest about which ones
    // matter for the probes it advertises.
    expect(WITHHELD_VERBS).toContain("readAllSecrets");
    expect(WITHHELD_VERBS).toContain("approve");
    expect(WITHHELD_VERBS).toContain("installAnything");
    expect(WITHHELD_VERBS).toContain("queryCoreDb");
    expect(MUST_FAIL.length).toBeGreaterThan(0);
  });

  it("exposes the groups it is supposed to", () => {
    for (const group of ["props", "state", "events", "actions", "capabilities", "host", "semantic", "lifecycle"]) {
      expect(authorApiExposes(group)).toBe(true);
    }
  });
});

describe("a message is validated before it is interpreted", () => {
  it("accepts a nonce-correct capability request and brokers it", async () => {
    const host = makeHost();

    const outcome = await handleWidgetMessage(host, {
      kind: "capability.request",
      nonce: NONCE,
      capabilityRef: REQUESTED_CAPABILITY,
      justification: "to echo the value the user asked about",
    });

    expect(outcome).toEqual({ ok: true, text: "echoed" });
    expect(host.callTool).toHaveBeenCalledOnce();
    // The result reaches the user through the host's own renderer, never by the widget
    // reaching into host chrome.
    expect(host.render).toHaveBeenCalledWith("echoed");
  });

  it("refuses a message with the wrong nonce before any branch can act on it", async () => {
    const host = makeHost();

    const outcome = await handleWidgetMessage(host, {
      kind: "capability.request",
      nonce: "nonce_from_another_frame",
      capabilityRef: REQUESTED_CAPABILITY,
      justification: "pretending to be a different widget",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe("rejected");
    expect(outcome.ok === false && "code" in outcome && outcome.code).toBe("NONCE_MISMATCH");
    // Nothing was brokered, which is the point: validation precedes interpretation.
    expect(host.callTool).not.toHaveBeenCalled();
  });

  it("refuses a message from a window the host did not register", async () => {
    const host = makeHost({ sourceMatchesExpectedWindow: false });

    const outcome = await handleWidgetMessage(host, {
      kind: "capability.request",
      nonce: NONCE,
      capabilityRef: REQUESTED_CAPABILITY,
      justification: "from an unregistered window",
    });

    expect(outcome.ok === false && "code" in outcome && outcome.code).toBe("SOURCE_MISMATCH");
    expect(host.callTool).not.toHaveBeenCalled();
  });

  it("refuses a message that is not shaped like the protocol at all", async () => {
    const host = makeHost();

    const outcome = await handleWidgetMessage(host, { kind: "readAllSecrets", nonce: NONCE });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && "code" in outcome && outcome.code).toBe("SCHEMA_INVALID");
    expect(host.callTool).not.toHaveBeenCalled();
  });
});

describe("only the granted capability is brokered", () => {
  it("refuses a capability the fixture was not granted, by name", async () => {
    const host = makeHost();

    const outcome = await handleWidgetMessage(host, {
      kind: "capability.request",
      nonce: NONCE,
      capabilityRef: "filesystem.read@1",
      justification: "the user probably wants this",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe("capability-not-granted");
    expect(outcome.ok === false && "requested" in outcome && outcome.requested).toBe("filesystem.read@1");
    expect(host.callTool).not.toHaveBeenCalled();
  });

  it("refuses a well-formed message that is not a capability request", async () => {
    const host = makeHost();

    const outcome = await handleWidgetMessage(host, {
      kind: "semantic.publish",
      nonce: NONCE,
      summary: "the user selected three rows",
      selectedIds: ["a", "b", "c"],
    });

    expect(outcome.ok === false && outcome.reason).toBe("not-a-capability-request");
    expect(host.callTool).not.toHaveBeenCalled();
  });
});

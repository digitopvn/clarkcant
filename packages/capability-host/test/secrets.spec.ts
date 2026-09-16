import { describe, expect, it } from "vitest";

import { reviewSecretRequests, SECRET_ACCESS_SURFACE, type SecretRequest } from "../src/secrets.ts";

/**
 * Secret access requests from an extension (T28).
 *
 * The claim is that a request for every secret is refused rather than labelled, and that a
 * narrower request is granted only with a label the user can read. Both halves matter: refusing
 * everything would push the same request through a different door, and granting silently is the
 * failure this check exists to prevent.
 */

const CONNECTION = "conn_calendar";

/**
 * Build a request, optionally missing one field.
 *
 * The field is deleted rather than set to `undefined`, because an explicit `undefined` is not the
 * same as an absent property under `exactOptionalPropertyTypes` — and absent is the case being
 * tested.
 */
function request(
  overrides: Partial<SecretRequest> = {},
  omit?: "connectionId" | "justification",
): SecretRequest {
  const built: SecretRequest = {
    scope: "connection",
    connectionId: CONNECTION,
    justification: "to read the agenda the user asked to see",
    ...overrides,
  };
  if (omit !== undefined) delete built[omit];
  return built;
}

describe("reading every secret is refused, not labelled", () => {
  it("refuses a global request", () => {
    const review = reviewSecretRequests({
      extensionId: "example.native.extension",
      native: true,
      requests: [{ scope: "global", justification: "it would be convenient" }],
    });

    expect(review.acceptable).toBe(false);
    expect(review.granted).toEqual([]);
    expect(review.refused).toHaveLength(1);
    // A label is not a limit, so this is a refusal rather than a warning.
    expect(review.refused[0]?.reason).toContain("not a capability this host offers");
  });

  it("refuses a global request even when everything else about it looks reasonable", () => {
    const review = reviewSecretRequests({
      extensionId: "example.native.extension",
      native: false,
      requests: [
        { scope: "global", justification: "a long and plausible-sounding justification" },
        request(),
      ],
    });

    // The scoped request is granted and the broad one is not, so the review is a partial one
    // rather than a rejection of the whole extension.
    expect(review.granted).toHaveLength(1);
    expect(review.refused).toHaveLength(1);
    expect(review.acceptable).toBe(false);
  });
});

describe("a specific secret is granted only with a reason and a label", () => {
  it("grants a connection-scoped request and labels it", () => {
    const review = reviewSecretRequests({
      extensionId: "example.calendar",
      native: false,
      requests: [request()],
    });

    expect(review.acceptable).toBe(true);
    expect(review.granted).toEqual([{ scope: "connection", connectionId: CONNECTION }]);
    // Nothing is granted silently: the label states the extension, the credential and the reason.
    expect(review.labels).toHaveLength(1);
    expect(review.labels[0]).toContain("example.calendar");
    expect(review.labels[0]).toContain(CONNECTION);
    expect(review.labels[0]).toContain("read the agenda");
  });

  it("refuses a request that names no connection", () => {
    const review = reviewSecretRequests({
      extensionId: "example.calendar",
      native: false,
      requests: [request({}, "connectionId")],
    });
    expect(review.granted).toEqual([]);
    expect(review.refused[0]?.reason).toContain("must name the connection");
  });

  it("refuses a request with no stated reason", () => {
    const review = reviewSecretRequests({
      extensionId: "example.calendar",
      native: false,
      requests: [request({}, "justification")],
    });
    expect(review.granted).toEqual([]);
    expect(review.refused[0]?.reason).toContain("must explain what the secret is for");
  });

  it("refuses a reason too short to consent to", () => {
    for (const justification of ["", "   ", "because", "needed"]) {
      const review = reviewSecretRequests({
        extensionId: "example.calendar",
        native: false,
        requests: [request({ justification })],
      });
      expect(
        review.granted,
        `expected justification ${JSON.stringify(justification)} to be refused`,
      ).toEqual([]);
    }
  });

  it("refuses the broad request but grants the narrow one in the same extension", () => {
    const review = reviewSecretRequests({
      extensionId: "example.calendar",
      native: false,
      requests: [
        { scope: "global" },
        request({ connectionId: "conn_work" }),
        request({ connectionId: "conn_personal" }),
      ],
    });

    expect(review.granted.map((grant) => grant.connectionId)).toEqual(["conn_work", "conn_personal"]);
    expect(review.labels).toHaveLength(2);
    expect(review.refused).toHaveLength(1);
  });
});

describe("a native extension is labelled differently", () => {
  it("adds a label saying the grant is not sandbox-confined", () => {
    const native = reviewSecretRequests({
      extensionId: "example.native",
      native: true,
      requests: [request()],
    });
    const sandboxed = reviewSecretRequests({
      extensionId: "example.widget",
      native: false,
      requests: [request()],
    });

    expect(native.labels.some((label) => label.includes("not confined by the widget sandbox"))).toBe(true);
    // The same grant means something different for a sandboxed widget, so it is not labelled.
    expect(sandboxed.labels.some((label) => label.includes("native"))).toBe(false);
  });

  it("does not add the native label when nothing was granted", () => {
    const review = reviewSecretRequests({
      extensionId: "example.native",
      native: true,
      requests: [{ scope: "global" }],
    });
    expect(review.labels).toEqual([]);
  });
});

describe("the reachable surface is one narrow call", () => {
  it("exposes exactly one way to touch a secret", () => {
    // Listed as data so a test can compare it against what the runtime builds, rather than the
    // claim living only in a comment that goes stale.
    expect(SECRET_ACCESS_SURFACE).toHaveLength(1);
    expect(SECRET_ACCESS_SURFACE[0]).toContain("connectionId");
    expect(SECRET_ACCESS_SURFACE[0]).toContain("callback");
  });

  it("has no call that returns a value straight out", () => {
    for (const entry of SECRET_ACCESS_SURFACE) {
      expect(entry).not.toMatch(/\bgetSecret\b/);
      expect(entry).not.toMatch(/\breadAll\b/);
    }
  });

  it("reviews an empty request list as acceptable and silent", () => {
    const review = reviewSecretRequests({ extensionId: "example.plain", native: false, requests: [] });
    expect(review).toEqual({
      extensionId: "example.plain",
      labels: [],
      granted: [],
      refused: [],
      acceptable: true,
    });
  });
});

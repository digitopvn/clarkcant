/**
 * @clarkcant/example-mcp-app-fixture
 *
 * MCP App fixture: receives props from the host and calls one host-brokered tool. It
 * exists to prove the MCP Apps bridge against a reference implementation rather than
 * against a vendor, and to prove that an attempted host-storage read fails.
 *
 * @implementation-status stub
 * TODO(P6): the fixture UI and its host bridge wiring, against the exact negotiated MCP
 * Apps specification. The bridge codec this will use is implemented and tested
 * (`@clarkcant/widget-sdk`: nonce validation, opaque-origin source matching, and a
 * message schema that has no secret-reading verb).
 *
 * Deliberately absent from the codec, and therefore unavailable to this fixture:
 * `readAllSecrets`, `shell`, `queryCoreDb`, `approve` and `installAnything`. A capability
 * that does not exist cannot be reached by accident.
 */

/** The one capability this fixture is allowed to request. */
export const REQUESTED_TOOL = "fixture.echo@1";

/**
 * Probes the fixture must attempt and fail, proving isolation rather than asserting it:
 */
export const MUST_FAIL = [
  "read the host's storage",
  "read a credential value",
  "mint an approval record",
  "reach an origin that is not in the declared allowlist",
] as const;

/**
 * @implementation-status stub
 * TODO(P6): the fixture UI. It also needs a reference MCP Apps host, which this
 * repository does not yet provide.
 */
export const MCP_FIXTURE_STATUS = "blocked-on-reference-host";

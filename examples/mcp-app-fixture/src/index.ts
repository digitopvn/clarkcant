/**
 * @clarkcant/example-mcp-app-fixture
 *
 * MCP App fixture: receives props from the host and calls one host-brokered tool. It
 * exists to prove the MCP Apps bridge against a reference implementation rather than
 * against a vendor, and to prove that an attempted host-storage read fails.
 *
 * @status-ref example.mcp-app-fixture
 * TODO(P6): the fixture UI and its host bridge wiring, against the exact negotiated MCP Apps
 * specification. `bridge.ts` is the codec path the host brokers; it has no host to run against.
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

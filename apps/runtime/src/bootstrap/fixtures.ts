/**
 * The fixture gates, and the one place `test-support/` is reached from the bootstrap.
 *
 * A gate is a variable that must be exactly `"1"`: a node either says it is running a fixture, or it is a node. The
 * composition behind the gates is imported **dynamically and only when one matched**, which is what "the production
 * bootstrap does not import test-support" has to mean for a single-entry-point node: a static import would put the
 * scripted composer, the fake adapter and the session starter into every process, including the ones they would be
 * indistinguishable from real work in.
 *
 * This module holds no fixture code of its own. It reads three environment variables and it is the seam, so the gate
 * can be read, grepped and tested in one place.
 */

export interface FixtureGates {
  /** `CC_MODEL_FIXTURE=1`: the scripted composer, the scripted turn control and the node's own preconditions. */
  model: boolean;
  /** `CC_SESSION_FIXTURE=1`: a session starter that reports a session and spawns no worker. */
  session: boolean;
  /** `CC_VOICE_FIXTURE=1`: the scripted voice provider, and the seam that scripts what it hears. */
  voice: boolean;
}

/**
 * The gates as the environment states them.
 *
 * Read after `.env` has been applied, so a file that sets `CC_VOICE_FIXTURE=1` is a gate as much as an exported
 * variable is - which is how the browser suite runs a fixture node.
 */
export function fixtureGatesFromEnv(env: Record<string, string | undefined>): FixtureGates {
  return {
    model: env["CC_MODEL_FIXTURE"] === "1",
    session: env["CC_SESSION_FIXTURE"] === "1",
    voice: env["CC_VOICE_FIXTURE"] === "1",
  };
}

/** What the gate reaches: the fixtures' own module, typed without importing it at runtime. */
export type FixtureComposition = typeof import("../test-support/index.ts");

/**
 * Load the deterministic composition, or nothing at all.
 *
 * `undefined` is the production answer, and it is the answer for a node that sets no gate: the caller then never
 * touches a fixture seam, and the modules above are never evaluated.
 */
export async function loadFixtureComposition(gates: FixtureGates): Promise<FixtureComposition | undefined> {
  if (!gates.model && !gates.session && !gates.voice) return undefined;
  return await import("../test-support/index.ts");
}

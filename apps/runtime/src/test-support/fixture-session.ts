import type { ProjectSessionStarter } from "../project-session.ts";

/**
 * A session starter that starts nothing.
 *
 * The same reason the model and voice fixtures exist: the flow that starts a session in a chosen directory has a
 * browser half, and proving it must not spawn a worker process - which would need a provider, a longer wait than any
 * test should take, and would leave a session behind on the machine running the suite. It answers the shape the
 * gateway expects and says out loud that it is a fixture.
 *
 * Loaded only through `bootstrap/fixtures.ts`, and only when `CC_SESSION_FIXTURE=1`.
 */
export function fixtureProjectSessions(): ProjectSessionStarter {
  let started = 0;
  return {
    available: () => ({ available: true }),
    start: async (input) => {
      started += 1;
      void input;
      return { sessionId: `sess_fixture_${started}`, sessionFile: undefined };
    },
  };
}

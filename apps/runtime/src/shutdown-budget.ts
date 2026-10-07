/**
 * How long one step of a node's shutdown may wait, out of what is left before the hard stop.
 *
 * The steps after it (disposing sessions, withdrawing browser tokens, closing sockets and the database) are what make
 * the exit clean, so `reserveMs` is kept back for them: a step that waits too long costs the clean close rather than
 * only itself. Never negative; zero when the reserve is already spent.
 */
export function shutdownStepBudget(input: { deadline: number; now: number; reserveMs: number }): number {
  return Math.max(0, input.deadline - input.now - input.reserveMs);
}

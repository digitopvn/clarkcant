/**
 * Repositories.
 *
 * The actual implementation lives in `./repositories/`, split by aggregate
 * (commands, events, outbox/inbox, tasks, effects, grants, pairing, projects,
 * and so on). This file stays as a thin re-export so existing imports of
 * `./repositories.ts` keep working unchanged.
 */
export * from "./repositories/index.ts";

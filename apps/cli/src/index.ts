/**
 * @clarkcant/cli
 *
 * The `clarkcant` command as an importable function, so a test or another tool can run it without a process.
 * `main.ts` is the executable (`node apps/cli/src/main.ts`).
 */

export { DEFAULT_URL, USAGE, resolveConnection, runCli, type CliIo, type Connection } from "./cli.ts";

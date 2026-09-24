#!/usr/bin/env node
/**
 * `clarkcant` entry point: hands the process's environment and streams to the command, and exits with its status.
 */
import { createInterface } from "node:readline";

import { runCli } from "./cli.ts";

const status = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  stdinLines: () => createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY }),
});
process.exitCode = status;

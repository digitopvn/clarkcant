#!/usr/bin/env node
/**
 * P0.1 lifecycle probe.
 *
 * The blueprint requires every P0 risk to end in pass, blocked, or fail with
 * reproducible evidence, and explicitly forbids recording a pass for something that
 * was never run. This program is that evidence producer for the Pi SDK: it records
 * exactly which lifecycle steps were executed, which were refused by the
 * environment, and why.
 *
 * Usage:
 *   node packages/pi-adapter/src/probe-cli.ts [--json] [--write] [--live [--model <provider>/<id>]]
 *
 * `--write` records the result into docs/research/compatibility-lock.md. `--live` sends one short prompt to a
 * real model — the named one, or the configured default — which spends the operator's own quota.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { READ_ONLY_TOOLS, RealPiAdapter, REQUIRED_SDK_EXPORTS, sdkVersion } from "./real.ts";

type StepStatus = "pass" | "blocked" | "fail";

interface StepResult {
  step: string;
  status: StepStatus;
  detail: string;
  evidence: string[];
}

interface ProbeReport {
  probe: "P0.1-pi-sdk-lifecycle";
  ranAt: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  sdkPackage: string;
  sdkVersion: string;
  overall: StepStatus;
  steps: StepResult[];
}

const results: StepResult[] = [];

function record(step: string, status: StepStatus, detail: string, evidence: string[] = []): void {
  results.push({ step, status, detail, evidence });
  const icon = status === "pass" ? "PASS   " : status === "blocked" ? "BLOCKED" : "FAIL   ";
  process.stderr.write(`${icon} ${step}\n`);
  process.stderr.write(`        ${detail}\n`);
}

interface ProbeArguments {
  json: boolean;
  write: boolean;
  live: boolean;
  /** The model `--live` runs; absent means the configured default. */
  model: { provider: string; id: string } | undefined;
}

/**
 * Reads the command line once, before any step runs.
 *
 * An argument that is not understood stops the probe rather than being skipped: `--model=x` read as nothing would
 * spend the operator's quota on a model they did not pick.
 */
function parseArguments(argv: readonly string[]): ProbeArguments {
  const parsed: ProbeArguments = { json: false, write: false, live: false, model: undefined };
  let named: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--json") parsed.json = true;
    else if (argument === "--write") parsed.write = true;
    else if (argument === "--live") parsed.live = true;
    else if (argument === "--model") {
      index += 1;
      named = argv[index] ?? "";
    } else if (argument.startsWith("--model=")) named = argument.slice("--model=".length);
    else throw new Error(`unknown argument ${argument}`);
  }
  if (named !== undefined) {
    if (!parsed.live) throw new Error("--model only applies to --live");
    // A provider id has no slash; a model id may.
    const slash = named.indexOf("/");
    if (slash <= 0 || slash === named.length - 1) {
      throw new Error(`--model expects <provider>/<id>, for example anthropic/claude-opus-5-5; got "${named}"`);
    }
    parsed.model = { provider: named.slice(0, slash), id: named.slice(slash + 1) };
  }
  return parsed;
}

/**
 * What a provider or the SDK said, made fit to keep: `--write` puts it in a committed file.
 *
 * Its first line only, without this machine's paths or anything shaped like a key — some providers repeat part of
 * the key they refuse.
 */
function reasonToRecord(raw: string): string {
  const firstLine = raw.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  return firstLine
    // A path of this machine, not the path part of an address: it does not follow a host name or a scheme.
    .replace(/(?<![\w.:\\/])(?:[A-Za-z]:)?[\\/](?:[^\\/\s"'`:]+[\\/])+[^\\/\s"'`:]*/g, "[path]")
    .replace(/\b(?:sk|pk|rk|key|xox[a-z])[-_][A-Za-z0-9*._-]{6,}/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .trim()
    .slice(0, 300);
}

/**
 * One real turn through the adapter, with no tools and nothing of the operator's in the prompt: the session is
 * isolated, so no extension, skill or instructions file found on this machine is sent or can change the turn.
 *
 * Three outcomes, because they need different responses: the model answered (pass); the turn could not be made for
 * a reason that belongs to the account — no credential, no quota — so the SDK path is still unproven (blocked); or
 * it failed for any other reason, which is what an incompatible SDK looks like (fail). Recorded exactly once.
 */
async function liveCompletion(model: ProbeArguments["model"]): Promise<void> {
  const named = model === undefined ? "the configured default model" : `${model.provider}/${model.id}`;
  const adapter = new RealPiAdapter({ cwd: process.cwd(), builtinTools: [], isolated: true });
  let text = "";
  const errors: string[] = [];
  let usage: { inputTokens?: number; outputTokens?: number } = {};
  try {
    const handle = await adapter.createWorkerSession({
      goal: "P0.1 live completion probe",
      projectRoots: [],
      allowedCapabilityRefs: [],
      thinkingLevel: "off",
      ...(model === undefined ? {} : { model }),
    });
    try {
      adapter.subscribe(handle.sessionId, (event) => {
        if (event.type === "text-delta") text += event.delta;
        if (event.type === "error") errors.push(event.message);
      });
      await adapter.prompt(handle.sessionId, "Reply with exactly: pong");
    } finally {
      usage = adapter.usage(handle.sessionId);
      await adapter.dispose(handle.sessionId);
    }
  } catch (cause) {
    // A turn that threw is a turn that did not complete, whatever had streamed before it did.
    errors.push(cause instanceof Error ? cause.message : String(cause));
  }

  const evidence = [
    `model: ${named}`,
    `input tokens: ${String(usage.inputTokens ?? "not reported")}; output tokens: ${String(usage.outputTokens ?? "not reported")}`,
  ];
  if (errors.length === 0) {
    const answered = text.trim() !== "";
    record(
      "live-model-completion",
      answered ? "pass" : "fail",
      answered
        ? `${named} answered a real turn (${text.trim().length} characters)`
        : `${named} settled without text and without an error`,
      evidence,
    );
    return;
  }
  const account = errors.some((reason) =>
    /usage|quota|credit|billing|api[_ -]?key|credential|auth|log ?in|HTTP 40[123]|HTTP 429/i.test(reason),
  );
  const reason = errors.map(reasonToRecord).join("; ");
  record(
    "live-model-completion",
    account ? "blocked" : "fail",
    account
      ? `${named} gave no answer, for a reason that belongs to the account: ${reason}`
      : `${named} did not answer: ${reason}`,
    [
      ...evidence,
      ...(account
        ? ["unblock condition: a credential for this provider with usable quota, then re-run with --live"]
        : []),
    ],
  );
}

async function main(options: ProbeArguments): Promise<void> {
  const sdk = await sdkVersion();

  /* 1. The module loads at all. */
  let loaded: typeof import("@earendil-works/pi-coding-agent") | undefined;
  try {
    loaded = await import("@earendil-works/pi-coding-agent");
    record("sdk-module-load", "pass", `@earendil-works/pi-coding-agent@${sdk} imported successfully`, [
      `resolved version: ${sdk}`,
      `export count: ${Object.keys(loaded).length}`,
    ]);
  } catch (cause) {
    record(
      "sdk-module-load",
      "fail",
      `the SDK could not be imported: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  /* 2. Every export the adapter depends on is present. */
  if (loaded) {
    const present = REQUIRED_SDK_EXPORTS.filter((name) => name in loaded);
    const missing = REQUIRED_SDK_EXPORTS.filter((name) => !(name in loaded));
    record(
      "required-exports-present",
      missing.length === 0 ? "pass" : "fail",
      missing.length === 0
        ? `all ${REQUIRED_SDK_EXPORTS.length} required exports are present`
        : `missing exports: ${missing.join(", ")}`,
      [`present: ${present.join(", ")}`],
    );
  }

  /* 3. A custom ResourceLoader can be constructed and reloaded. */
  if (loaded) {
    try {
      const loader = new loaded.DefaultResourceLoader({
        cwd: process.cwd(),
        // Both options are required by the SDK's option type; omitting `agentDir` makes
        // `reload()` throw inside the loader rather than at construction.
        agentDir: loaded.getAgentDir(),
      } as never);
      await loader.reload();
      record(
        "custom-resource-loader",
        "pass",
        "DefaultResourceLoader constructed with an explicit cwd and reloaded without touching global discovery",
        ["loader.reload() resolved"],
      );
    } catch (cause) {
      record(
        "custom-resource-loader",
        "fail",
        `could not construct or reload a custom ResourceLoader: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  /* 4. Availability reporting works and is honest. */
  const adapter = new RealPiAdapter({ cwd: process.cwd(), builtinTools: READ_ONLY_TOOLS });
  const availability = await adapter.availability();
  record(
    "availability-report",
    availability.available ? "pass" : "fail",
    availability.available
      ? `adapter reports the SDK available at version ${String(availability.sdkVersion)}`
      : `adapter reports the SDK unavailable: ${String(availability.reason)}`,
    [`sdkVersion=${String(availability.sdkVersion ?? "unknown")}`],
  );

  /*
   * 5. Creating a live session.
   *
   * This is where a provider account becomes necessary. The probe distinguishes
   * "no credentials configured" (blocked, with the exact condition to unblock) from
   * "the SDK rejected a valid-looking call" (fail), because those need very
   * different responses.
   */
  try {
    const { session, modelFallbackMessage } = await loaded!.createAgentSession({
      cwd: process.cwd(),
      sessionManager: loaded!.SessionManager.inMemory(process.cwd()),
      tools: [...READ_ONLY_TOOLS],
    });
    record("live-session-creation", "pass", `created session ${session.sessionId}`, [
      `has subscribe: ${typeof session.subscribe === "function"}`,
      `has steer: ${typeof session.steer === "function"}`,
      `has abort: ${typeof session.abort === "function"}`,
      `has dispose: ${typeof session.dispose === "function"}`,
      ...(modelFallbackMessage === undefined ? [] : [`model fallback: ${modelFallbackMessage}`]),
    ]);

    /* 6. Subscription lifecycle, asserted on the adapter rather than the raw session.
     *
     * Duplicate-listener refusal is this application's guarantee, not an SDK feature, so
     * asserting it against `session.subscribe` would be testing the wrong thing. */
    const adapterSession = await adapter.createWorkerSession({
      goal: "P0.1 lifecycle probe",
      projectRoots: [process.cwd()],
      allowedCapabilityRefs: [],
    });
    const listener = (): void => {};
    const unsubscribe = adapter.subscribe(adapterSession.sessionId, listener);
    let duplicateRefused = false;
    try {
      adapter.subscribe(adapterSession.sessionId, listener);
    } catch {
      duplicateRefused = true;
    }
    const listenersBeforeDispose = adapter.listenerCount(adapterSession.sessionId);
    unsubscribe();
    const listenersAfterUnsubscribe = adapter.listenerCount(adapterSession.sessionId);
    await adapter.dispose(adapterSession.sessionId);
    record(
      "subscribe-lifecycle",
      duplicateRefused && listenersBeforeDispose === 1 && listenersAfterUnsubscribe === 0
        ? "pass"
        : "fail",
      `distinct listeners registered: ${listenersBeforeDispose}; after unsubscribe: ${listenersAfterUnsubscribe}; duplicate registration refused: ${duplicateRefused}`,
      [
        "a leaked listener is the mechanism behind stale handlers after a reload (T25)",
        `adapter reports the SDK at version ${String(availability.sdkVersion ?? "unknown")}`,
      ],
    );

    /* 7. Disposal releases the session. */
    session.dispose();
    record("session-dispose", "pass", "session.dispose() completed without throwing", [
      "no listener was left attached",
    ]);

    /* 8. A real completion needs a credentialed model, so it runs only when asked for. */
    if (options.live) {
      await liveCompletion(options.model);
    } else {
      record(
        "live-model-completion",
        "blocked",
        "not attempted by the probe: a live completion would consume the operator's provider quota and requires an account this repository does not hold",
        [
          "unblock condition: run `pnpm probe:pi --live [--model <provider>/<id>]` with a configured provider credential",
        ],
      );
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const looksLikeAuth = /api[_ -]?key|credential|auth|no model|not authenticated|login/i.test(message);
    record(
      "live-session-creation",
      looksLikeAuth ? "blocked" : "fail",
      looksLikeAuth
        ? `session creation requires provider credentials that are not configured: ${message}`
        : `session creation failed for a reason that is not a missing credential: ${message}`,
      [
        looksLikeAuth
          ? "unblock condition: configure a provider credential (~/.pi/agent/auth.json) or an API-key environment variable, then re-run"
          : "this needs investigation before the SDK can be relied on",
      ],
    );
    record(
      "live-model-completion",
      "blocked",
      "skipped because session creation did not succeed",
      ["depends on: live-session-creation"],
    );
  }

  /* 9. Command-context resource reload is an extension-only API. */
  record(
    "command-context-ctx.reload",
    "blocked",
    "ctx.reload() is only available inside a Pi extension command handler; this probe runs as an embedded SDK consumer, so the step cannot be exercised from here",
    [
      "unblock condition: load an extension through DefaultResourceLoader that calls ctx.reload() from a registered command",
      "what the app relies on instead: DefaultResourceLoader.reload() plus session.setActiveToolsByName()",
    ],
  );

  const overall: StepStatus = results.some((step) => step.status === "fail")
    ? "fail"
    : results.some((step) => step.status === "blocked")
      ? "blocked"
      : "pass";

  const report: ProbeReport = {
    probe: "P0.1-pi-sdk-lifecycle",
    ranAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    sdkPackage: "@earendil-works/pi-coding-agent",
    sdkVersion: sdk,
    overall,
    steps: results,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }

  if (options.write) {
    const target = join(process.cwd(), "docs", "research", "compatibility-lock.md");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderMarkdown(report));
    process.stderr.write(`\nwrote ${target}\n`);
  }

  process.stderr.write(
    `\noverall: ${overall.toUpperCase()} (${results.filter((s) => s.status === "pass").length} pass, ${
      results.filter((s) => s.status === "blocked").length
    } blocked, ${results.filter((s) => s.status === "fail").length} fail)\n`,
  );

  // A blocked step is an honest outcome, not a build failure. Only a real failure
  // fails the command, so CI can run the probe continuously.
  process.exit(overall === "fail" ? 1 : 0);
}

function renderMarkdown(report: ProbeReport): string {
  const lines: string[] = [];
  lines.push("# P0.1 compatibility lock — Pi SDK lifecycle");
  lines.push("");
  lines.push(
    "Generated by `node packages/pi-adapter/src/probe-cli.ts --write`. Do not edit by hand:",
  );
  lines.push("re-run the probe so the recorded evidence matches the environment it was measured in.");
  lines.push("");
  lines.push(`- **Probe:** \`${report.probe}\``);
  lines.push(`- **Ran at:** ${report.ranAt}`);
  lines.push(`- **Package:** \`${report.sdkPackage}@${report.sdkVersion}\``);
  lines.push(`- **Environment:** Node ${report.nodeVersion} on ${report.platform}/${report.arch}`);
  lines.push(`- **Overall:** **${report.overall.toUpperCase()}**`);
  lines.push("");
  lines.push("## Steps");
  lines.push("");
  lines.push("| Step | Status | Detail |");
  lines.push("|---|---|---|");
  for (const step of report.steps) {
    lines.push(`| \`${step.step}\` | ${step.status.toUpperCase()} | ${escapePipes(step.detail)} |`);
  }
  lines.push("");
  lines.push("## Evidence per step");
  lines.push("");
  for (const step of report.steps) {
    lines.push(`### \`${step.step}\` — ${step.status.toUpperCase()}`);
    lines.push("");
    lines.push(step.detail);
    if (step.evidence.length > 0) {
      lines.push("");
      for (const item of step.evidence) lines.push(`- ${item}`);
    }
    lines.push("");
  }
  lines.push("## What a blocked step means here");
  lines.push("");
  lines.push(
    "`blocked` means the step could not be exercised in this environment and a specific condition is",
  );
  lines.push(
    "recorded for unblocking it. It is not a pass, and it is not a failure. Per",
  );
  lines.push(
    "`docs/implementation-plan.md` §17 a blocked step must be reported as blocked rather than renamed",
  );
  lines.push("to supported, so this file keeps the distinction visible.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/** One table cell: a pipe would end it and a line break would end the row. */
function escapePipes(text: string): string {
  return text.replaceAll("|", "\\|").replace(/\s*\r?\n\s*/g, " ");
}

let probeArguments: ProbeArguments;
try {
  probeArguments = parseArguments(process.argv.slice(2));
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.stderr.write("usage: node packages/pi-adapter/src/probe-cli.ts [--json] [--write] [--live [--model <provider>/<id>]]\n");
  process.exit(2);
}
await main(probeArguments);

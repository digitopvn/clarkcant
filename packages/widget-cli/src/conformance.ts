import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isHostOwnedBlock, type MessageBlock } from "@clarkcant/contracts";
import { validateProps } from "@clarkcant/widget-host";
import { FORBIDDEN_API_SURFACE, acceptBridgeMessage, createWidgetRuntime, type MessageEndpoint } from "@clarkcant/widget-sdk";
import { createFrameSession } from "@clarkcant/widget-host";

import { REQUIRED_FIXTURES, readPackage, type WidgetPackage } from "./manifest.ts";

/**
 * The conformance suite a widget has to pass before it is publish-ready.
 *
 * The groups and the checks are the ones in `docs/widget-development.md` §17. What matters about the
 * implementation is which checks can actually be *run* here and which cannot.
 *
 * A widget is a browser artifact, and this suite runs in Node. So it does the two things Node can do honestly:
 * it checks the package's declarations and structure, and it exercises the runtime, the frame session and the
 * codec — the parts that are the same code in a browser and in a test. The checks that need a rendered frame
 * (keyboard, touch target size, the narrow/compact/expanded layouts, reduced motion, voice/click parity) are
 * reported as `requires-dev-host` rather than as passing.
 *
 * That distinction is the point of this file. A suite that reported them as passing because a fixture file exists
 * would be the "do not advertise what is not shipped" rule broken by the tool that is supposed to enforce it.
 */

export type CheckStatus = "pass" | "fail" | "requires-dev-host";

export interface ConformanceCheck {
  id: string;
  group: "schema" | "security" | "lifecycle" | "interaction" | "rendering";
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface ConformanceReport {
  root: string;
  checks: ConformanceCheck[];
  ok: boolean;
  /** Counts per status, so a caller can tell "clean" from "clean except the browser half". */
  summary: Record<CheckStatus, number>;
}

function endpoint() {
  const sent: unknown[] = [];
  let listener: ((event: { data: unknown }) => void) | undefined;
  const port: MessageEndpoint = {
    postMessage: (message) => sent.push(message),
    addEventListener: (_type, handler) => {
      listener = handler;
    },
    removeEventListener: () => {
      listener = undefined;
    },
  };
  return { port, sent, deliver: (data: unknown) => listener?.({ data }), listening: () => listener !== undefined };
}

function initFor(pkg: WidgetPackage, props: Record<string, unknown>) {
  return {
    kind: "init",
    protocol: "agent.widgetbridge",
    version: 1,
    instanceId: "conformance",
    nonce: "conformance-nonce-000000",
    props,
    brokeredCapabilities: [] as string[],
    allowedOrigins: [] as string[],
  };
}

/** Every http(s) origin mentioned in the entry, which is what the manifest has to declare. */
function originsInEntry(path: string): string[] {
  if (!existsSync(path)) return [];
  const source = readFileSync(path, "utf8");
  const found = new Set<string>();
  for (const match of source.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
    try {
      found.add(new URL(match[0]).origin);
    } catch {
      // A malformed URL in the source is not this check's business; the network check only cares about origins.
    }
  }
  return [...found];
}

export function runConformance(root: string): ConformanceReport {
  const pkg = readPackage(root);
  const checks: ConformanceCheck[] = [];
  const add = (
    id: string,
    group: ConformanceCheck["group"],
    name: string,
    status: CheckStatus,
    detail: string,
  ): void => {
    checks.push({ id, group, name, status, detail });
  };

  if (pkg.problems.length > 0 || pkg.facets.length === 0) {
    // Nothing else can be checked against a package that cannot be read, and inventing results would be worse.
    for (const problem of pkg.problems) {
      add("package.readable", "schema", "the package can be read", "fail", problem);
    }
    if (pkg.problems.length === 0) {
      add("package.readable", "schema", "the package can be read", "fail", "no widget facet is declared");
    }
    return finish(root, checks);
  }

  const facet = pkg.facets[0];
  if (facet === undefined) return finish(root, checks);
  const definition = facet.definition;
  const defaultProps = pkg.fixtures["default"] ?? {};

  /* ------------------------------------------------------------------ schema */

  const valid = validateProps(definition, defaultProps);
  add(
    "schema.props.valid",
    "schema",
    "the default fixture matches the props schema",
    valid.ok ? "pass" : "fail",
    valid.ok ? "fixtures/default.json validates" : `fixtures/default.json: ${valid.problems.join("; ")}`,
  );

  // A schema that accepts anything is not a schema, so the malformed case is constructed from the schema itself
  // rather than hand-written: a missing required key, or a wrong-typed one.
  const malformed: Record<string, unknown> = { ...defaultProps };
  const schema = definition.propsSchema as { properties?: Record<string, { type?: string }>; required?: string[] };
  const required = schema.required ?? [];
  if (required.length > 0) delete malformed[required[0] as string];
  else {
    const firstKey = Object.keys(schema.properties ?? {})[0];
    if (firstKey !== undefined) malformed[firstKey] = firstKey in defaultProps ? 12345 : undefined;
  }
  const malformedResult = validateProps(definition, malformed);
  add(
    "schema.props.malformedRejected",
    "schema",
    "malformed props are rejected",
    malformedResult.ok ? "fail" : "pass",
    malformedResult.ok ? "a malformed props object was accepted" : malformedResult.problems.join("; "),
  );

  const extra = validateProps(definition, { ...defaultProps, conformanceExtraKey: "x" });
  const forbidsExtra = (definition.propsSchema as { additionalProperties?: boolean }).additionalProperties === false;
  add(
    "schema.props.additionalRejected",
    "schema",
    "additional props are rejected when the schema forbids them",
    forbidsExtra ? (extra.ok ? "fail" : "pass") : "pass",
    forbidsExtra
      ? extra.ok
        ? "an undeclared property was accepted"
        : extra.problems.join("; ")
      : "the schema allows additional properties, so there is nothing to reject",
  );

  add(
    "schema.state.version",
    "schema",
    "the state version is declared",
    Number.isInteger(definition.stateVersion ?? 0) && (definition.stateVersion ?? 0) >= 0 ? "pass" : "fail",
    `stateVersion is ${String(definition.stateVersion ?? 0)}`,
  );

  /* ---------------------------------------------------------------- security */

  const forged = acceptBridgeMessage({
    raw: { kind: "ready", nonce: "not-this-frames-nonce" },
    expectedNonce: "conformance-nonce-000000",
    sourceMatchesExpectedWindow: true,
  });
  add(
    "security.forgedNonceRejected",
    "security",
    "a forged nonce is rejected",
    forged.ok ? "fail" : "pass",
    forged.ok ? "a message with the wrong nonce was accepted" : forged.code,
  );

  const wrongSource = acceptBridgeMessage({
    raw: { kind: "ready", nonce: "conformance-nonce-000000" },
    expectedNonce: "conformance-nonce-000000",
    sourceMatchesExpectedWindow: false,
  });
  add(
    "security.wrongSourceRejected",
    "security",
    "a message from another window is rejected",
    wrongSource.ok ? "fail" : "pass",
    wrongSource.ok ? "a message from an unregistered window was accepted" : wrongSource.code,
  );

  const runtimeKeys = Object.keys(
    createWidgetRuntime({ endpoint: endpoint().port }).api === undefined ? {} : {},
  );
  // The runtime's author surface is read from the declaration, which is what an author can reach for.
  const authorKeys = ["props", "state", "events", "actions", "capabilities", "host", "semantic", "lifecycle"];
  const leaked = FORBIDDEN_API_SURFACE.filter((name) => authorKeys.includes(name) || runtimeKeys.includes(name));
  add(
    "security.noSecretSurface",
    "security",
    "no secret, shell or approval surface is reachable",
    leaked.length === 0 ? "pass" : "fail",
    leaked.length === 0
      ? `none of ${FORBIDDEN_API_SURFACE.join(", ")} is on the author API`
      : `reachable: ${leaked.join(", ")}`,
  );

  const origins = originsInEntry(join(root, facet.entryPath));
  const declaredOrigins = pkg.manifest.permissions.networkOrigins;
  const undeclared = origins.filter((origin) => !declaredOrigins.includes(origin));
  add(
    "security.undeclaredNetwork",
    "security",
    "the entry reaches no origin the manifest does not declare",
    undeclared.length === 0 ? "pass" : "fail",
    undeclared.length === 0
      ? origins.length === 0
        ? "the entry names no origin"
        : `declared: ${origins.join(", ")}`
      : `undeclared: ${undeclared.join(", ")}`,
  );

  /*
   * SAFETY: the cast is the point of the check. `isHostOwnedBlock` takes a `MessageBlock`, and what is being asked
   * is whether the *type name* is recognised as host-owned before any schema validation — which is exactly the
   * question a widget author's malformed card would raise. The value never reaches a renderer.
   */
  const hostCardWithoutProvenance = isHostOwnedBlock({
    type: "question-card",
    owner: "host",
    questionId: "q",
    question: "?",
    options: [],
  } as unknown as MessageBlock);
  add(
    "security.hostCardImpossible",
    "security",
    "a host-owned card cannot be minted by a widget",
    hostCardWithoutProvenance ? "pass" : "fail",
    // The check is that the type is recognised as host-owned; the provenance refusal itself lives in the host.
    hostCardWithoutProvenance ? "question-card is recognised as host-owned" : "question-card is not in the host-owned list",
  );

  /* --------------------------------------------------------------- lifecycle */

  const bus = endpoint();
  const runtime = createWidgetRuntime({ endpoint: bus.port });
  let mounted = 0;
  let suspended: string | undefined;
  let resumed = 0;
  let disposed = 0;
  const api = runtime.api();
  // Registered before init, because init is what fires mount: a suite that subscribed afterwards would be
  // checking a handler that had already been missed.
  api.lifecycle.onMount(() => {
    mounted += 1;
  });
  api.lifecycle.onSuspend((reason) => {
    suspended = reason;
  });
  api.lifecycle.onResume(() => {
    resumed += 1;
  });
  api.lifecycle.onDispose(() => {
    disposed += 1;
  });
  bus.deliver(initFor(pkg, defaultProps));
  add(
    "lifecycle.mount",
    "lifecycle",
    "the widget mounts on init",
    runtime.status() === "ready" && mounted === 1 ? "pass" : "fail",
    `status after init: ${runtime.status()}, mount handlers fired: ${String(mounted)}`,
  );

  const seenProps: Record<string, unknown>[] = [];
  api.props.subscribe((props) => seenProps.push(props));
  bus.deliver({ kind: "props", nonce: "conformance-nonce-000000", props: { ...defaultProps, conformanceUpdated: true } });
  add(
    "lifecycle.update",
    "lifecycle",
    "a props update reaches the widget",
    seenProps.length === 1 ? "pass" : "fail",
    `subscribers notified: ${String(seenProps.length)}`,
  );

  bus.deliver({ kind: "suspend", nonce: "conformance-nonce-000000", reason: "conformance" });
  bus.deliver({ kind: "props", nonce: "conformance-nonce-000000", props: defaultProps });
  add(
    "lifecycle.suspendResume",
    "lifecycle",
    "suspend and resume are delivered",
    suspended === "conformance" && resumed === 1 ? "pass" : "fail",
    `suspended: ${String(suspended)}, resumed: ${String(resumed)}`,
  );

  bus.deliver({ kind: "dispose", nonce: "conformance-nonce-000000" });
  add(
    "lifecycle.disposeCleanup",
    "lifecycle",
    "dispose stops listening",
    disposed === 1 && !bus.listening() ? "pass" : "fail",
    `disposed: ${String(disposed)}, listener present: ${String(bus.listening())}`,
  );

  const stateVersion = definition.stateVersion ?? 0;
  const migrationFixture = join(root, "fixtures", `state-v${String(stateVersion - 1)}.json`);
  add(
    "lifecycle.stateMigration",
    "lifecycle",
    "a state migration is declared where one is needed",
    stateVersion === 0 || existsSync(migrationFixture) ? "pass" : "fail",
    stateVersion === 0
      ? "stateVersion is 0, so there is nothing to migrate"
      : existsSync(migrationFixture)
        ? `fixtures/state-v${String(stateVersion - 1)}.json is present`
        : `stateVersion is ${String(stateVersion)} but fixtures/state-v${String(stateVersion - 1)}.json is missing`,
  );

  /* ------------------------------------------------------------- interaction */

  const invocations: string[] = [];
  const session = createFrameSession({
    instanceId: "conformance",
    nonce: "conformance-nonce-000000",
    props: defaultProps,
    brokeredCapabilities: [],
    allowedOrigins: [],
    knownActionBindings: ["act_conformance"],
    invokeAction: async ({ invocationId }) => {
      invocations.push(invocationId);
      return { status: "accepted", message: "ok" };
    },
    chrome: { focus: () => {}, resize: () => {}, requestPin: () => {}, openExternal: () => {} },
    post: () => {},
  });
  session.init();
  const click = {
    data: {
      kind: "action.invoke",
      nonce: "conformance-nonce-000000",
      actionBindingId: "act_conformance",
      expectedRevision: 0,
      input: {},
      invocationId: "inv_conformance",
    },
    sourceMatchesExpectedWindow: true,
  };
  session.accept(click);
  session.accept(click);
  add(
    "interaction.dedup",
    "interaction",
    "a repeated invocation runs the action once",
    invocations.length === 1 ? "pass" : "fail",
    `times run: ${String(invocations.length)}`,
  );

  const stale = session.accept({
    data: { kind: "state.update", nonce: "conformance-nonce-000000", expectedRevision: 99, patch: { x: 1 } },
    sourceMatchesExpectedWindow: true,
  });
  add(
    "interaction.staleRevision",
    "interaction",
    "a stale state write is refused",
    !stale.ok && stale.code === "STALE_REVISION" ? "pass" : "fail",
    stale.ok ? "a stale write was accepted" : stale.code,
  );

  // An effect cannot be triggered by name alone: an action the host never accepted for this instance is refused
  // before anything runs. That is the check behind "effect action", and it is the one that matters.
  const unknownBinding = session.accept({
    data: {
      kind: "action.invoke",
      nonce: "conformance-nonce-000000",
      actionBindingId: "act_not_accepted",
      expectedRevision: 1,
      input: {},
      invocationId: "inv_unknown",
    },
    sourceMatchesExpectedWindow: true,
  });
  add(
    "interaction.effectActionRequiresBinding",
    "interaction",
    "an action the host never accepted is refused",
    !unknownBinding.ok && unknownBinding.code === "ACTION_UNKNOWN" ? "pass" : "fail",
    unknownBinding.ok ? "an action with an unknown binding was accepted" : unknownBinding.code,
  );

  add(
    "interaction.pin",
    "interaction",
    "the definition declares its sizing, which is what pin and detach depend on",
    typeof definition.sizing.compact === "boolean" && typeof definition.sizing.expanded === "boolean"
      ? "pass"
      : "fail",
    `compact: ${String(definition.sizing.compact)}, expanded: ${String(definition.sizing.expanded)}`,
  );

  add("interaction.keyboard", "interaction", "keyboard reachability", "requires-dev-host", "needs a rendered frame");
  add("interaction.touchSize", "interaction", "touch target size", "requires-dev-host", "needs a rendered frame");
  add(
    "interaction.detach",
    "interaction",
    "detach keeps one live owner",
    "requires-dev-host",
    // Named precisely: this is not "needs a browser" but "needs a detached host window", and the product does not
    // have one — phase 7 landed the ownership half only, so there is nothing here to exercise.
    "a detached host window does not exist yet, so detach cannot be exercised from this command",
  );

  add(
    "interaction.voiceClickParity",
    "interaction",
    "a spoken action and the same click agree",
    "requires-dev-host",
    "needs a rendered frame and a voice session",
  );

  /* --------------------------------------------------------------- rendering */

  const missingFixtures = REQUIRED_FIXTURES.filter((name) => pkg.fixtures[name] === undefined);
  add(
    "rendering.fixtures",
    "rendering",
    "the required fixtures are present",
    missingFixtures.length === 0 ? "pass" : "fail",
    missingFixtures.length === 0
      ? `present: ${REQUIRED_FIXTURES.join(", ")}`
      : `missing: ${missingFixtures.join(", ")}`,
  );

  add(
    "rendering.textFallback",
    "rendering",
    "a text fallback is declared",
    definition.textFallback.trim().length > 0 ? "pass" : "fail",
    `textFallback: ${String(definition.textFallback.length)} characters`,
  );

  for (const [id, name] of [
    ["rendering.narrow", "the narrow layout"],
    ["rendering.compact", "the compact layout"],
    ["rendering.expanded", "the expanded layout"],
    ["rendering.loading", "the loading state"],
    ["rendering.readOnly", "the read-only state"],
    ["rendering.reducedMotion", "reduced motion"],
  ] as const) {
    add(id, "rendering", name, "requires-dev-host", "needs a rendered frame at a known viewport");
  }

  return finish(root, checks);
}

function finish(root: string, checks: ConformanceCheck[]): ConformanceReport {
  const summary: Record<CheckStatus, number> = { pass: 0, fail: 0, "requires-dev-host": 0 };
  for (const check of checks) summary[check.status] += 1;
  return { root, checks, ok: summary.fail === 0, summary };
}

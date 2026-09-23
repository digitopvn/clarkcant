/**
 * Implementation-status registry.
 *
 * One machine-readable source of truth for what this repository has actually built, what it has
 * only partly built, and what it cannot build here. It exists because the alternative — status
 * claims living as prose in a header comment, a `TODO`, a `*_STATUS` string or a conformance table
 * — drifts: a comment that said "stub" outlived the stub, and a table row that said "PASS" could
 * cite a test nobody ever wrote.
 *
 * Three rules make this registry worth trusting, and `tools/check-invariants.mjs` enforces all
 * three rather than trusting the reader to check by hand:
 *
 *   1. `implemented` requires at least one named test, and the named test must actually exist in
 *      the file it names. "The schema exists" is not evidence; a test that exercises the thing is.
 *   2. `partial`, `blocked` and `not-implemented` name the missing condition in `externalGate`.
 *      A gap with no name is not a status, it is a shrug.
 *   3. Source comments carry `@status-ref <capabilityId>` and nothing else. They do not restate a
 *      status, because a restated status is a second copy that can be wrong.
 *
 * Scope ids (`V01`–`V18`) are entries here too, and their status must agree with
 * `docs/conformance-traceability.md`. That agreement is checked, so a row cannot be quietly
 * promoted: changing one side alone fails `pnpm invariants`.
 *
 * External gates are named by issue number while the gate is waiting on something outside this
 * repository: #2 a live Calendar account, #3 Computer Use signing, #4 a live voice provider, #5 a
 * second NodeLink host. They stay open: a fixture that passes proves the wiring, never the external
 * account, signature, engine or second host the gate is waiting on.
 *
 * A gap that waits on nothing outside the repository is described by the gap itself rather than by an
 * issue number, so no wording here depends on an issue's state and none of it goes stale when one
 * closes. `tools/check-invariants.mjs` enforces that by rejecting an `externalGate.issue` outside the
 * four gates above.
 */

/** What the repository can honestly say about one capability or scope item. */
export type ImplementationStatus = "implemented" | "partial" | "blocked" | "not-implemented";

/** A test that exercises the capability. `test` is absent only where no named test exists. */
export interface ImplementationEvidence {
  /** Repository-relative path of the spec file. */
  file: string;
  /** The test's own title, exactly as written in that file. */
  test?: string;
}

/** The missing condition behind a gap, named. Never a value, never a guess at a workaround. */
export interface ExternalGate {
  /** The GitHub issue that owns the gate, when one does. */
  issue?: number;
  /** What is missing, in one sentence. */
  reason: string;
}

export interface ImplementationStatusEntry {
  /** `V<n>` for a blueprint scope item, otherwise a dotted capability id referenced by `@status-ref`. */
  capabilityId: string;
  /** What this entry is about, in one sentence. */
  summary: string;
  status: ImplementationStatus;
  /** The workspace package that owns the capability, by package name. */
  owningPackage: string;
  /** That package's `clarkcant.phase`. */
  phase: string;
  evidenceTests: ImplementationEvidence[];
  externalGate?: ExternalGate;
}

const CORE = "packages/core/test/core.spec.ts";
const STORAGE = "packages/storage/test/storage.spec.ts";
const CONTRACTS = "packages/contracts/test/contracts.spec.ts";
const NODE_LINK = "packages/node-link/test/node-link.spec.ts";
const SEAMS = "packages/widget-host/test/seams.spec.ts";
const RUNTIME = "apps/runtime/test";
const WEB_E2E = "apps/web/e2e";

export const IMPLEMENTATION_STATUS: readonly ImplementationStatusEntry[] = [
  /* ---------------------------------------------------------------- *
   * Scope items. The status here must match `docs/conformance-traceability.md`.
   * ---------------------------------------------------------------- */
  {
    capabilityId: "V01",
    summary: "Conversation client: one timeline, one composer, pins, attachments.",
    status: "implemented",
    owningPackage: "@clarkcant/app-web",
    phase: "P1",
    evidenceTests: [
      { file: `${WEB_E2E}/j1.spec.ts`, test: "pinning and unpinning keeps the widget data" },
      { file: `${WEB_E2E}/j1.spec.ts`, test: "a suggestion produces a labelled sample with a real widget" },
    ],
  },
  {
    capabilityId: "V02",
    summary:
      "Portable runtime: own identity and database, bearer-gated gateway, Unix-socket transport (the socket half is POSIX-only, and its own suite skips on Windows with the reason named).",
    status: "implemented",
    owningPackage: "@clarkcant/runtime",
    phase: "P1",
    evidenceTests: [
      { file: `${RUNTIME}/identity.spec.ts`, test: "is created with the node and reported as a fingerprint a person can read aloud" },
      { file: `${RUNTIME}/api.spec.ts`, test: "rejects every other route without a token" },
      { file: `${RUNTIME}/portable-runtime.spec.ts`, test: "serves a real request and keeps the file owner-only" },
    ],
  },
  {
    capabilityId: "V03",
    summary:
      "Persistent task/session runtime and the worker host that runs tasks out of process. A task the conductor " +
      "dispatches now runs: a bounded pool of worker processes, a lease per capability with fencing, root " +
      "confinement, a deadline and an output ceiling, and the run's evidence settling the task through the same " +
      "state machine every other path uses. `capability:project.read` — the one project-work tool this repository " +
      "actually implements — is the capability this proves against; the descriptors in `packs/project-work` use a " +
      "different ref (`project.file.read@1`) that no worker tool answers to yet, so a task dispatched against that " +
      "descriptor still runs a real worker and still fails honestly, for want of a matching tool rather than for " +
      "want of a worker.",
    status: "implemented",
    owningPackage: "@clarkcant/runtime",
    phase: "P1",
    evidenceTests: [
      {
        file: `${RUNTIME}/pack-load.spec.ts`,
        test: "marks the capability loaded once a worker has really loaded it, and says what is still missing",
      },
      {
        file: `${RUNTIME}/worker-process.spec.ts`,
        test: "runs it in a separate process and returns the record it produced",
      },
      {
        file: `${RUNTIME}/task-dispatch.spec.ts`,
        test: "succeeds and settles the task through verification when the run produces verified evidence",
      },
      {
        file: `${RUNTIME}/task-dispatch.spec.ts`,
        test: "runs a real worker child process, which honestly reports not-verified and fails the task",
      },
      {
        file: `${RUNTIME}/task-dispatch.spec.ts`,
        test: "refuses a project root this node does not own, without starting a worker",
      },
      {
        file: `${RUNTIME}/task-dispatch.spec.ts`,
        test: "kills a running worker on stop, and reports how many it stopped",
      },
    ],
  },
  {
    capabilityId: "V04",
    summary: "Trusted node linking: invitation, fingerprint, confirmation and envelope authentication.",
    status: "implemented",
    owningPackage: "@clarkcant/node-link",
    phase: "P4",
    evidenceTests: [
      {
        file: `${RUNTIME}/peers.spec.ts`,
        test: "records the peer as pending, and admits nothing until a person confirms it on both sides",
      },
      { file: NODE_LINK, test: "rejects an envelope whose claimed sender is not the authenticated peer" },
    ],
  },
  {
    capabilityId: "V05",
    summary: "Remote collaboration: delivery semantics, dedup, grant narrowing and a live delegation.",
    status: "implemented",
    owningPackage: "@clarkcant/node-link",
    phase: "P4",
    evidenceTests: [
      {
        file: `${RUNTIME}/peers.spec.ts`,
        test: "carries a delegation between two live hosts, and answers a replay with what was recorded",
      },
      {
        file: `${RUNTIME}/peers.spec.ts`,
        test: "reports a sequence gap instead of accepting it, and the delayed message still processes",
      },
    ],
  },
  {
    capabilityId: "V06",
    summary: "Workspace registry: node-qualified references, locality routing, lease serialization and artifact transfer.",
    status: "implemented",
    owningPackage: "@clarkcant/runtime",
    phase: "P1",
    evidenceTests: [
      {
        file: `${RUNTIME}/artifact-transfer.spec.ts`,
        test: "stores the bytes it was offered, and hashes them rather than trusting the offer",
      },
    ],
  },
  {
    capabilityId: "V07",
    summary: "Capability platform: registry, readiness and both MCP transports.",
    status: "implemented",
    owningPackage: "@clarkcant/mcp-adapters",
    phase: "P5",
    evidenceTests: [
      { file: "packages/mcp-adapters/test/stdio.spec.ts", test: "normalises a live server's tools into capabilities" },
      {
        file: "packages/mcp-adapters/test/streamable-http.spec.ts",
        test: "reports what the server said it speaks, and keeps the session it was given",
      },
    ],
  },
  {
    capabilityId: "V08",
    summary: "Conversational install: plan, consent, generation activation, quarantine, isolated build and dependency lock.",
    status: "partial",
    owningPackage: "@clarkcant/core",
    phase: "P1",
    evidenceTests: [
      {
        file: "packages/capability-host/test/dependency-lock.spec.ts",
        test: "pins a floating range to the exact version its metadata names",
      },
      {
        file: "packages/core/test/install-from-source.spec.ts",
        test: "refuses to join an existing plan whose closure is not the one resolved now, naming the dependency",
      },
    ],
    externalGate: {
      reason:
        "the runtime /packages/install route downloads and builds nothing, and no metadata source here turns a package's declared dependency range into an exact version, so it records an artifact-only lock; the dependency-closure build path (isolatedLockedBuild) is not called from production, and a build refuses that closure by name (LOCK_INCOMPLETE) rather than reading it as pinned",
    },
  },
  {
    capabilityId: "V09",
    summary: "Credential/auth setup: vault, redaction, PKCE, state comparison, scope verification, allowlisting, code exchange and refresh.",
    status: "partial",
    owningPackage: "@clarkcant/integration-sdk",
    phase: "P7",
    evidenceTests: [
      {
        file: "packages/integration-sdk/test/token-exchange.spec.ts",
        test: "sends the verifier whose challenge the provider recorded, and reads the grant back",
      },
    ],
    externalGate: {
      reason:
        "no registered OAuth client and no live account, so the endpoint a live connection would use has never been called",
    },
  },
  {
    capabilityId: "V10",
    summary: "Reference integration (Google Calendar): scope planning, time normalisation, agenda, conflicts, write outcome, freshness.",
    status: "partial",
    owningPackage: "@clarkcant/integration-sdk",
    phase: "P7",
    evidenceTests: [
      {
        file: "packages/integration-sdk/test/calendar-api.spec.ts",
        test: "asks for the range and reads the events back as live",
      },
      { file: SEAMS, test: "labels cached data as cached rather than live (T36)" },
      {
        file: "packs/google-calendar/test/connector.spec.ts",
        test: "reads a real range with a token the exchange issued, in the pack's own event shape",
      },
    ],
    externalGate: {
      issue: 2,
      reason:
        "no registered OAuth client, no enabled API and no Google account, so the provider endpoint has never been called",
    },
  },
  {
    capabilityId: "V11",
    summary: "Rich built-ins: every catalog definition has a family, a renderer and a text alternative.",
    status: "implemented",
    owningPackage: "@clarkcant/conversation-client",
    phase: "P1",
    evidenceTests: [
      {
        file: "packages/conversation-client/test/catalog-coverage.spec.ts",
        test: "has a renderer, so the client draws it instead of falling back to the text alternative",
      },
      {
        file: "packages/conversation-client/test/catalog-coverage.spec.ts",
        test: "covers every id the family map names, so the map and the catalog cannot drift apart",
      },
    ],
  },
  {
    capabilityId: "V12",
    summary: "Custom widgets: declarative composition, the isolated frame runtime and the conformance harness.",
    status: "partial",
    owningPackage: "@clarkcant/widget-cli",
    phase: "P6",
    evidenceTests: [
      {
        file: "packages/widget-cli/test/conformance.spec.ts",
        test: "answers the checks a frame can answer, and leaves the ones it cannot",
      },
      {
        file: "packages/widget-cli/test/conformance.spec.ts",
        test: "reports the browser checks as unverified rather than as passing",
      },
    ],
    externalGate: {
      issue: 4,
      reason:
        "the harness drives a browser dev host, which has no detached window to drive - the desktop's detached window is covered by the desktop and browser suites rather than by this check - and voiceClickParity needs a voice session, whose precondition is the provider account in #4",
    },
  },
  {
    capabilityId: "V13",
    summary: "Pins: persistence, one live owner, restore without autoplay, and a position that reaches the player.",
    status: "partial",
    owningPackage: "@clarkcant/conversation-client",
    phase: "P1",
    evidenceTests: [
      { file: "packages/conversation-client/test/media-embed.spec.ts", test: "reopens the player where it stopped" },
      { file: "packages/conversation-client/test/media-embed.spec.ts", test: "cannot express autoplay, whatever position it is given" },
    ],
    externalGate: {
      reason:
        "no live player vendor: the URL a browser would load is proven, not the vendor's own handling of the start parameter",
    },
  },
  {
    capabilityId: "V14",
    summary: "Browser Use: control contract, locator staleness, injection refusal, submit-once, takeover preview.",
    status: "partial",
    owningPackage: "@clarkcant/browser-playwright",
    phase: "P8",
    evidenceTests: [
      {
        file: "packs/browser-playwright/test/driver.spec.ts",
        test: "applies a click on a real element and reports it as observed",
      },
      { file: `${RUNTIME}/session-preview.spec.ts`, test: "believes the bytes rather than the declaration" },
      { file: `${RUNTIME}/session-preview-real.spec.ts`, test: "is served back from the route under its own digest, with the size it was captured at" },
      { file: "apps/web/e2e/browser-takeover.spec.ts", test: "a takeover changes who may act, and a stop ends the session" },
    ],
    externalGate: {
      reason:
        "no live site: every capture and every action so far is against a page this repository serves, so a third-party site behind a login — with its own consent and anti-automation boundaries — has never been driven. The preview path itself is real: the card's bytes are a Chromium capture of a served page, stored content-addressed and served from the authenticated route (phase 6)",
    },
  },
  {
    capabilityId: "V15",
    summary: "Computer Use: permission gating, containment labelling, target validation and the native binding seam.",
    status: "partial",
    owningPackage: "@clarkcant/execution-supervisor",
    phase: "P3",
    evidenceTests: [
      {
        file: "packages/execution-supervisor/test/native-binding.spec.ts",
        test: "names the signed bundle as what is missing when there is none",
      },
    ],
    externalGate: {
      issue: 3,
      reason:
        "no signed bundle and no container engine on this host, so the native binding has never run and the virtual-desktop containment claim is unsubstantiated",
    },
  },
  {
    capabilityId: "V16",
    summary: "Onboarding/personalisation: quick play labelled as sample, needs-based setup and preference undo.",
    status: "implemented",
    owningPackage: "@clarkcant/app-web",
    phase: "P1",
    evidenceTests: [
      {
        file: "packages/core/test/onboarding.spec.ts",
        test: "undoes what setup wrote and leaves the user's own changes alone",
      },
      {
        file: `${WEB_E2E}/onboarding.spec.ts`,
        test: "asks for nothing it does not need, and offers setup where the answer is used",
      },
    ],
  },
  {
    capabilityId: "V17",
    summary: "Live voice: transcript assembly, intent routing, media-focus arbitration, mute/end over the node-proxied socket.",
    status: "partial",
    owningPackage: "@clarkcant/voice-adapters",
    phase: "P9",
    evidenceTests: [
      { file: `${RUNTIME}/voice-live.spec.ts`, test: "names the provider account as what is missing" },
    ],
    externalGate: {
      issue: 4,
      reason: "no live provider account, so a real voice session has never opened; the live checks stay opt-in",
    },
  },
  {
    capabilityId: "V18",
    summary: "Operations/security: forward-only migrations, verifiable backup, restore compatibility, redaction, durable dedup.",
    status: "implemented",
    owningPackage: "@clarkcant/storage",
    phase: "P1",
    evidenceTests: [
      { file: STORAGE, test: "produces a verifiable backup with matching row counts" },
      { file: STORAGE, test: "leaves the schema at the last fully-applied version when a migration dies partway" },
    ],
  },

  /* ---------------------------------------------------------------- *
   * Capability claims. The sites that used to carry a self-asserting status marker in their header.
   * ---------------------------------------------------------------- */
  {
    capabilityId: "runtime.local-transport",
    summary: "The node's own transport: loopback HTTP with a bearer gate, and the Unix socket a desktop helper would attach to.",
    status: "partial",
    owningPackage: "@clarkcant/runtime",
    phase: "P1",
    evidenceTests: [
      {
        file: `${RUNTIME}/artifact-transfer.spec.ts`,
        test: "serves a stored blob to a confirmed peer, and refuses everyone else",
      },
      {
        file: `${RUNTIME}/portable-runtime.spec.ts`,
        test: "clears the file a node left behind when it did not shut down",
      },
    ],
    externalGate: {
      reason:
        "the Unix-socket half is POSIX-only: Node has no Unix domain sockets on Windows, so its suite is skipped there with the reason named and this capability has no executed evidence for that half on a non-POSIX runner, and no test drives the --socket flag that selects the listener",
    },
  },
  {
    capabilityId: "app.web.client",
    summary: "The browser client the node serves: Vite entry, HTML shell, gateway transport and the conversation surface.",
    status: "implemented",
    owningPackage: "@clarkcant/app-web",
    phase: "P1",
    evidenceTests: [
      { file: `${WEB_E2E}/j1.spec.ts`, test: "the client loads, reports a real connection, and asks what to do" },
      { file: `${WEB_E2E}/j1.spec.ts`, test: "typing a message works, and the answer comes back from the node" },
    ],
  },
  {
    capabilityId: "widget-sdk.runtime-and-host-session",
    summary: "The isolated-widget codec, the runtime a mini-app imports, and the host end of one frame.",
    status: "implemented",
    owningPackage: "@clarkcant/widget-sdk",
    phase: "P6",
    evidenceTests: [
      { file: "packages/widget-sdk/test/runtime.spec.ts", test: "refuses a host that speaks a different protocol" },
      {
        file: "packages/widget-host/test/session.spec.ts",
        test: "refuses a forged nonce, which is the check origin cannot make for an opaque frame",
      },
    ],
  },
  {
    capabilityId: "integration-sdk.token-exchange",
    summary: "The authorization-code exchange and the refresh loop, against an injected endpoint.",
    status: "implemented",
    owningPackage: "@clarkcant/integration-sdk",
    phase: "P7",
    evidenceTests: [
      {
        file: "packages/integration-sdk/test/token-exchange.spec.ts",
        test: "sends the verifier whose challenge the provider recorded, and reads the grant back",
      },
      {
        file: "packages/integration-sdk/test/token-exchange.spec.ts",
        test: "sends the refresh grant and reads the new access token back",
      },
    ],
  },
  {
    capabilityId: "nodelink.transport",
    summary: "The transport that carries envelopes between two nodes: HTTP against a peer's own gateway today.",
    status: "partial",
    owningPackage: "@clarkcant/node-link",
    phase: "P4",
    evidenceTests: [
      { file: NODE_LINK, test: "returns the recorded outcome for a resent envelope" },
      {
        file: `${RUNTIME}/peers.spec.ts`,
        test: "refuses a second claim of the same invitation, because it is single use",
      },
    ],
    externalGate: {
      issue: 5,
      reason:
        "the socket, reconnect-cursor and keepalive layer is not implemented, and two genuinely independent hosts are not available here; the in-repo peers run in one process",
    },
  },
  {
    capabilityId: "execution-supervisor.container-adapters",
    summary: "Container and VM execution adapters behind the profile model and its allowlist.",
    status: "blocked",
    owningPackage: "@clarkcant/execution-supervisor",
    phase: "P3",
    evidenceTests: [
      {
        file: "packages/execution-supervisor/test/native-binding.spec.ts",
        test: "names the container engine when the bundle is fine and the engine is not",
      },
    ],
    externalGate: {
      reason:
        "no container engine on any host here, so the process profile is what runs and the virtual-desktop profile's container containment has no test behind it",
    },
  },
  {
    capabilityId: "host-adapters.platform-capabilities",
    summary: "Host capability shape and the refusal logic that decides whether a driver pack may run.",
    status: "blocked",
    owningPackage: "@clarkcant/host-adapters",
    phase: "P3",
    evidenceTests: [
      { file: SEAMS, test: "refuses the macOS driver on a non-macOS host" },
      { file: SEAMS, test: "reports a Linux host without a display as unable to run a virtual desktop" },
    ],
    externalGate: {
      issue: 3,
      reason:
        "real macOS TCC permission state needs a signed bundle and a real desktop session, so permission is reported as unknown rather than read",
    },
  },
  {
    capabilityId: "pack.project-work",
    summary: "Project work pack: capability descriptors, effect classification, schemas and the git-worktree lock.",
    status: "partial",
    owningPackage: "@clarkcant/project-work",
    phase: "P2",
    evidenceTests: [
      { file: "packs/project-work/test/worktree.spec.ts", test: "catches HEAD moving under a running task" },
      { file: "packs/project-work/test/worktree.spec.ts", test: "refuses an uncommitted edit and names the file" },
    ],
    externalGate: {
      reason:
        "the functions that read a file or apply a patch are supplied by the worker host at run time; the pack declares and locks, it does not itself touch the tree",
    },
  },
  {
    capabilityId: "pack.browser-playwright",
    summary: "Browser Use driver: target description, locator resolution, operation support and the shared safety review.",
    status: "implemented",
    owningPackage: "@clarkcant/browser-playwright",
    phase: "P8",
    evidenceTests: [
      {
        file: "packs/browser-playwright/test/driver.spec.ts",
        test: "applies a click on a real element and reports it as observed",
      },
      {
        file: "packs/browser-playwright/test/driver.spec.ts",
        test: "invalidates the plan when the target version moves",
      },
      {
        file: "packs/browser-playwright/test/driver.spec.ts",
        test: "refuses an unapproved submit",
      },
    ],
  },
  {
    capabilityId: "pack.google-calendar",
    summary: "Calendar pack: scope verification, time normalisation, agenda building, conflict detection, write outcome, freshness.",
    status: "partial",
    owningPackage: "@clarkcant/google-calendar",
    phase: "P7",
    evidenceTests: [
      { file: SEAMS, test: "keeps an all-day date apart from a timed instant" },
      { file: SEAMS, test: "detects an overlap before the user confirms a move" },
      {
        file: "packs/google-calendar/test/connector.spec.ts",
        test: "reports a write that timed out as unknown, not as failed",
      },
    ],
    externalGate: {
      issue: 2,
      reason:
        "no registered OAuth client and no live account, so nothing in this pack has been pointed at a real calendar",
    },
  },
  {
    capabilityId: "pack.computer-macos",
    summary: "macOS native driver: the signed, packaged launch context the binding needs.",
    status: "blocked",
    owningPackage: "@clarkcant/computer-macos",
    phase: "P8",
    evidenceTests: [],
    externalGate: {
      issue: 3,
      reason:
        "no signed bundle with a stable identity: an unsigned binary loses its TCC grant on every rebuild, so real input has never been delivered",
    },
  },
  {
    capabilityId: "pack.computer-linux-desktop",
    summary: "Linux virtual desktop: runner image, display server startup and the short-lived authenticated preview transport.",
    status: "blocked",
    owningPackage: "@clarkcant/computer-linux-desktop",
    phase: "P8",
    evidenceTests: [],
    externalGate: {
      reason: "no container engine and no published runner image, so a virtual desktop session has never started",
    },
  },
  {
    capabilityId: "example.note-widget",
    summary: "Reference custom widget: manifest, declared capabilities and the revision-checked draft lifecycle.",
    status: "partial",
    owningPackage: "@clarkcant/note-widget",
    phase: "P6",
    evidenceTests: [
      { file: "examples/note-widget/test/editor.spec.ts", test: "persists on approve and clears the unsaved flag" },
      { file: "examples/note-widget/test/editor.spec.ts", test: "shows the committed text when another surface holds the draft" },
    ],
    externalGate: {
      reason:
        "the manifest and the draft lifecycle exist; the isolated build that would produce a shippable bundle for the example does not",
    },
  },
  {
    capabilityId: "example.media-widget-contract",
    summary: "Synthetic media fixture: one live owner per instance, and a restore that does not start playback.",
    status: "partial",
    owningPackage: "@clarkcant/media-widget-contract",
    phase: "P6",
    evidenceTests: [
      {
        file: "examples/media-widget-contract/test/fixture.spec.ts",
        test: "mounts once inline and once pinned, and refuses the second",
      },
      {
        file: "examples/media-widget-contract/test/fixture.spec.ts",
        test: "returns the stored position with playback stopped",
      },
    ],
    externalGate: {
      reason:
        "the ownership and restore state machine is implemented and tested, but the package holds no mountable component, so the fixture has never been mounted in a UI",
    },
  },
  {
    capabilityId: "example.mcp-app-fixture",
    summary: "MCP App fixture: the codec path a host brokers, and the requests a widget must not be able to make.",
    status: "partial",
    owningPackage: "@clarkcant/mcp-app-fixture",
    phase: "P6",
    evidenceTests: [
      { file: "examples/mcp-app-fixture/test/bridge.spec.ts", test: "refuses a message with the wrong nonce before any branch can act on it" },
      { file: "examples/mcp-app-fixture/test/bridge.spec.ts", test: "refuses a capability the fixture was not granted, by name" },
    ],
    externalGate: {
      reason:
        "there is no reference MCP Apps host in this repository, so the fixture UI has never run against one, and it is not presented as a vendor integration",
    },
  },
  {
    capabilityId: "core.one-live-owner",
    summary: "The ownership rule the widget fixtures lean on: one logical instance, at most one live owner.",
    status: "implemented",
    owningPackage: "@clarkcant/core",
    phase: "P1",
    evidenceTests: [
      { file: CORE, test: "refuses a second live owner for the same instance" },
      { file: CONTRACTS, test: "refuses to bind a capability the registry does not know" },
    ],
  },
];

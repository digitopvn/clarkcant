import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";

import type { ViteDevServer } from "vite";
import { closeDevModuleServer, createDevModuleServer } from "./dev-module-server.ts";
import { browserRuntime, sendPrebundledRuntime } from "./package-assets.ts";

import type { BrowserTokenDeclaration, ResourceRequest } from "@clarkcant/contracts";
import { readPackage } from "@clarkcant/core";
import { widgetToHostSchema } from "@clarkcant/widget-sdk";
import { catalogFrameHtml, catalogTarget } from "./catalog-target.ts";
import {
  applyShellAction,
  initialState,
  renderDetachedShell,
  renderShell,
  type DevShellAction,
  type DevShellState,
} from "./dev-shell.ts";
import { createDevArtifactBroker, readFixtureFiles, type DevArtifactEvent, type DevFixtureFile } from "./dev-artifacts.ts";
import { createDevJobBroker, type DevJobEvent } from "./dev-jobs.ts";
import { createDevTokenBroker, simulateResourceGrant, type DevTokenEvent } from "./dev-resources.ts";
import { openDevLeaseStore } from "./dev-lease.ts";
import {
  actionAvailability,
  actionResult,
  readServiceSimulator,
  readinessForStatus,
  serviceStatus,
  type ServiceBinding,
} from "./service-simulator.ts";
import { inspectSemanticProposal, type SemanticInspection } from "./dev-semantic.ts";
import {
  declaredCompositionEvents,
  declaredCompositionInputs,
  declaredWidgetEvents,
  validateCompositionEvent,
  validateDeclaredWidgetEvent,
} from "./dev-composition.ts";

/**
 * `clark widget dev` — the local isolated host.
 *
 * A dev host is a small server plus a page, and the two decisions that matter are both about not lying to the
 * author.
 *
 * **The frame gets the same sandbox the host gives it.** An opaque origin, no `allow-same-origin`. A dev host that
 * relaxed the policy would let an author build something that only works in development, which is the one failure
 * mode a dev host is supposed to prevent.
 *
 * **Nothing is served from outside the package.** A dev server that resolves a path without checking it is a
 * dev server that hands out the author's home directory, and it is the classic way a local tool becomes a way to
 * read files. Every path is resolved and then checked to be inside the root, and a refusal is a refusal rather
 * than a redirect.
 *
 * The shell's behaviour lives in `dev-shell.ts` as plain functions; this file only serves it and streams reloads.
 */

export interface DevHostOptions {
  /** The package directory to develop. Absent when `builtin` names a catalog definition instead. */
  root?: string;
  /**
   * A catalog definition id to develop in place of a package on disk.
   *
   * The frame is the same sandboxed frame, and the renderer is the same production renderer, so what an author sees
   * here is what the conversation would draw. Only where the definition and the frame's module come from differs.
   */
  builtin?: string;
  /** 0 asks the operating system for a free port, which is what a test wants. */
  port?: number;
  watchFiles?: boolean;
  /**
   * How a simulated service restart ends. By default its services report ready again two seconds later. `"held"`
   * keeps them loading until `finishServiceRestart()` is called, so a test can watch the restart on a machine too
   * slow to draw it inside two seconds.
   */
  serviceRestart?: "timed" | "held";
}

export interface DevHost {
  url: string;
  port: number;
  /** The shell's state, and the same transition the page performs, so a test drives the real model. */
  state: () => DevShellState;
  apply: (action: DevShellAction) => DevShellState;
  /** Reload notifications sent so far, so a test can prove the watcher fired without a browser. */
  reloads: () => number;
  /** What the simulated `artifacts@1` did — picks, creates, finalizes, exports, attaches — by name and size only. */
  artifactEvents: () => readonly DevArtifactEvent[];
  /** What the simulated `jobs@1` did — starts, steps, endings, cancels — by job id and status. */
  jobEvents: () => readonly DevJobEvent[];
  /** What the simulated `tokens@1` did — issues and refusals — by provider and code, never by value. */
  tokenEvents: () => readonly DevTokenEvent[];
  /** Ends a simulated service restart now, as its timer would. False when no restart is in progress. */
  finishServiceRestart: () => boolean;
  close: () => Promise<void>;
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

/** Only this host's own sandboxed frame may use the opaque-origin CORS exception. */
function isPackageFrameRequest(request: IncomingMessage, framePrefix: string): boolean {
  const host = request.headers.host;
  return request.headers.origin === "null"
    && host !== undefined
    && request.url?.startsWith(`${framePrefix}/`) === true
    && (host.startsWith("127.0.0.1:") || host.startsWith("localhost:"));
}

/**
 * The in-page script.
 *
 * It collects facts and forwards control changes; every decision is a function in `dev-shell.ts`. Kept small on
 * purpose: logic in a page cannot be tested without a browser, and the checks an author relies on most are the ones
 * most likely to be written as a badge that always passes.
 */
const SHELL_SCRIPT = `
const stateUrl = "/dev/api/state";
let state = await (await fetch(stateUrl)).json();

const width = state.viewportWidths[state.viewport];
document.documentElement.style.setProperty("--frame-width", width + "px");

const log = document.querySelector("[data-dev-log]");
const semantic = document.querySelector("[data-dev-semantic]");
const semanticDropped = document.querySelector("[data-dev-semantic-dropped]");
const semanticDelta = document.querySelector("[data-dev-semantic-delta]");
const semanticContext = document.querySelector("[data-dev-semantic-context]");
const semanticInspectUi = document.querySelector("[data-dev-semantic-inspect-ui]");
const semanticChurn = document.querySelector("[data-dev-semantic-churn]");
const compositionName = document.querySelector("[data-dev-composition-name]");
const compositionPayload = document.querySelector("[data-dev-composition-payload]");
const compositionResult = document.querySelector("[data-dev-composition-result]");
const findings = document.querySelector("[data-dev-findings]");

function appendLog(line) {
  log.textContent = (log.textContent ?? "") + line + "\\n";
}

async function send(action) {
  const response = await fetch("/dev/api/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  });
  state = await response.json();
  if (action.kind === "service-restart") setTimeout(() => location.reload(), 500);
  else location.reload();
}

for (const button of document.querySelectorAll("[data-dev-action][data-dev-value]")) {
  button.addEventListener("click", () => {
    if (button.tagName === "INPUT") return;
    void send({ kind: button.dataset.devAction, value: button.dataset.devValue });
  });
}
for (const input of document.querySelectorAll("input[data-dev-action]")) {
  input.addEventListener("change", () => {
    void send({ kind: input.dataset.devAction, value: input.dataset.devValue ?? input.checked });
  });
}
for (const select of document.querySelectorAll("select[data-dev-action='service-readiness']")) {
  select.addEventListener("change", () => {
    const reason = [...document.querySelectorAll("[data-dev-reason]")].find((input) => input.dataset.devReason === select.dataset.devValue)?.value ?? "";
    void send({ kind: "service-readiness", capabilityRef: select.dataset.devValue, status: select.value, reason });
  });
}
document.querySelector("[data-dev-action='service-restart']")?.addEventListener("click", () => {
  void send({ kind: "service-restart", value: true });
});
/* The controls are drawn before this script has read the state; a change made before now would go nowhere. */
document.body.dataset.devShellReady = "true";

compositionName?.addEventListener("change", () => {
  const option = compositionName.selectedOptions[0];
  try {
    compositionPayload.value = JSON.stringify(JSON.parse(option?.dataset.example ?? "{}"), null, 2);
    compositionResult.textContent = "";
  } catch {
    compositionResult.textContent = "Không đọc được ví dụ event đã khai báo.";
  }
});
document.querySelector("[data-dev-composition-send]")?.addEventListener("click", async () => {
  try {
    const response = await fetch("/dev/api/composition-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nonce: bridgeNonce,
        name: compositionName.value,
        payload: JSON.parse(compositionPayload.value),
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      compositionResult.textContent = "Từ chối event: " + result.problem;
      appendLog("composition event refused: " + result.problem);
      return;
    }
    const values = result.event.values ?? result.event.payload;
    const mode = result.event.values === undefined ? "đã được kiểm tra theo schema khai báo" : "đã được kiểm tra và áp dụng vào graph mô phỏng";
    compositionResult.textContent = "Event " + result.event.name + " " + mode + ":\\n" + JSON.stringify(values);
    appendLog("composition event " + result.event.name + " " + JSON.stringify(result.event.payload));
  } catch (error) {
    compositionResult.textContent = "Payload phải là JSON hợp lệ: " + String(error);
  }
});

/* The audit runs over facts collected here; the decision about what they mean lives in the CLI's tested code. */
function collectFacts(frame) {
  const doc = frame.contentDocument;
  const tabbable = [...doc.querySelectorAll("a[href], button, input, select, textarea, [tabindex]")]
    .filter((element) => element.tabIndex >= 0)
    .map((element) => ({
      name: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 40) ?? element.tagName,
      focusVisible: getComputedStyle(element).outlineStyle !== "none" || element.matches(":focus-visible"),
    }));
  const targets = [...doc.querySelectorAll("button, a[href], input[type=checkbox]")].map((element) => {
    const box = element.getBoundingClientRect();
    return { name: element.tagName, width: box.width, height: box.height };
  });
  const images = [...doc.querySelectorAll("img")].map((element) => ({
    src: element.getAttribute("src") ?? "",
    alt: element.getAttribute("alt") ?? "",
  }));
  return { tabbable, targets, images, textOverMotion: false, zeroDurationAnimation: false, declaredTextFallback: document.querySelector("[data-dev-frame]").title };
}

function renderFindings(list) {
  findings.innerHTML = "";
  if (list.length === 0) {
    const item = document.createElement("li");
    item.textContent = "không có phát hiện nào";
    findings.append(item);
    return;
  }
  for (const finding of list) {
    const item = document.createElement("li");
    item.dataset.severity = finding.severity;
    item.textContent = finding.severity + ": " + finding.message;
    findings.append(item);
  }
}

async function audit() {
  const frame = document.querySelector("[data-dev-frame]");
  try {
    const response = await fetch("/dev/api/a11y", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(collectFacts(frame)),
    });
    renderFindings((await response.json()).findings);
  } catch (error) {
    renderFindings([{ severity: "warning", message: "không đọc được frame: " + error.message }]);
  }
}

document.querySelector("[data-dev-action='a11y-audit']")?.addEventListener("click", () => void audit());
window.addEventListener("load", () => void audit());

/* Reload on change, so an author sees the edit rather than having to remember to refresh. */
const events = new EventSource("/dev/events");
events.addEventListener("reload", () => location.reload());

/* The frame speaks the bridge; a dev host shows what it said rather than silently accepting it. */
window.addEventListener("message", (event) => {
  if (event.source !== frameElement?.contentWindow || event.data?.nonce !== bridgeNonce) return;
  if (event.data.kind === "event") {
    void fetch("/dev/api/composition-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: bridgeNonce, name: event.data.name, payload: event.data.payload }),
    }).then(async (response) => {
      const result = await response.json();
      if (!response.ok) {
        const problem = result.problem ?? "event refused";
        appendLog("widget event " + String(event.data.name) + " refused: " + problem);
        compositionResult.textContent = "Từ chối widget event: " + problem;
        return;
      }
      const validatedFields = result.event.payload ?? result.event.values;
      appendLog("widget event " + result.event.name + " validated fields " + JSON.stringify(validatedFields));
      compositionResult.textContent = "Widget event " + result.event.name + " đã được kiểm tra:\\n" + JSON.stringify(validatedFields);
    }).catch((error) => {
      const problem = String(error);
      appendLog("widget event refused: " + problem);
      compositionResult.textContent = "Không đọc được widget event: " + problem;
    });
    return;
  }
  if (event.data.kind !== "semantic.publish") return;
  appendLog(new Date().toISOString() + " semantic.publish " + JSON.stringify(event.data).slice(0, 400));
  void fetch("/dev/api/semantic", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      nonce: bridgeNonce,
      proposal: {
        summary: event.data.summary,
        selectedIds: event.data.selectedIds,
        values: event.data.values,
      },
    }),
  }).then(async (response) => {
    const result = await response.json();
    if (!response.ok) {
      semantic.textContent = "Từ chối semantic.publish: " + (result.problems ?? []).join("; ");
      return;
    }
    semantic.textContent = JSON.stringify(result.doc, null, 2);
    semanticDropped.textContent = result.clippedOrDropped.length === 0 ? "Không có trường bị cắt hoặc loại bỏ." : result.clippedOrDropped.join("\\n");
    semanticDelta.textContent = result.delta.length === 0 ? "Không có thay đổi so với lần publish trước." : result.delta.join("\\n");
    semanticContext.textContent = result.contextNote || "(không có ngữ cảnh mới cho lượt tiếp theo)";
    semanticInspectUi.textContent = result.inspectUi;
    semanticChurn.textContent = result.churnWarning ? "Cảnh báo: widget publish hơn 4 lần trong 1 giây; việc này làm tăng delta cho lượt tiếp theo." : "";
  }).catch((error) => {
    semantic.textContent = "Không đọc được semantic.publish: " + String(error);
  });
});

/*
 * The bridge handshake, for a package's frame: the init a host sends, with a nonce minted for this page, the props of
 * the fixture on screen, the capabilities the simulator grants, and the artifacts@1 extension. Sent now and again on
 * every frame load, with the same nonce, because the frame may have loaded before this script ran; a runtime takes
 * the first and refuses the second as a duplicate, which is the behaviour the host relies on too.
 */
const frameElement = document.querySelector("[data-dev-frame]");
const bridgeNonce = state.bridgeNonce;
function sendInit() {
  if (state.bridge !== true) return;
  frameElement.contentWindow?.postMessage({
    kind: "init",
    protocol: "agent.widgetbridge",
    version: 1,
    instanceId: "dev-instance",
    nonce: bridgeNonce,
    props: state.props ?? {},
    state: {},
    revision: 0,
    stateRevision: 0,
    brokeredCapabilities: Object.entries(state.capabilities).filter(([, decision]) => decision === "granted").map(([ref]) => ref),
    allowedOrigins: [],
    extensions: ["artifacts@1", "jobs@1", "jobs.list@1", ...(state.browserTokens.length > 0 ? ["tokens@1"] : [])],
  }, "*");
}
frameElement?.addEventListener("load", sendInit);
sendInit();

function announceActions() {
  if (state.bridge !== true || !state.serviceBindings?.length) return;
  frameElement.contentWindow?.postMessage({ kind: "actions", nonce: bridgeNonce, actions: state.actionAvailability }, "*");
}
window.addEventListener("message", (event) => {
  if (event.source !== frameElement?.contentWindow || event.data?.kind !== "ready" || event.data?.nonce !== bridgeNonce) return;
  announceActions();
});
window.addEventListener("message", async (event) => {
  const data = event.data;
  if (event.source !== frameElement?.contentWindow || data?.kind !== "action.invoke" || data.nonce !== bridgeNonce) return;
  const response = await fetch("/dev/api/service-action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  frameElement.contentWindow?.postMessage(result, "*");
  appendLog("action " + String(data.actionBindingId) + " -> " + String(result.status));
  void renderJobs();
});

/*
 * artifacts@1, answered by the dev host's simulated broker. Only this frame's messages with this page's nonce are
 * relayed; the answer carries the same request id, as a host's does. The picker is the "File picker" control.
 */
window.addEventListener("message", async (event) => {
  const data = event.data;
  if (event.source !== frameElement?.contentWindow || !data || data.kind !== "artifact.request" || data.nonce !== bridgeNonce) return;
  let outcome;
  try {
    const response = await fetch("/dev/api/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data.request),
    });
    outcome = await response.json();
  } catch (error) {
    outcome = { status: "refused", code: "ARTIFACT_UNAVAILABLE", message: "the dev host did not answer: " + error.message };
  }
  frameElement.contentWindow?.postMessage({ kind: "artifact-result", nonce: bridgeNonce, requestId: data.requestId, ...outcome }, "*");
  appendLog("artifacts " + String(data.request?.op) + " -> " + outcome.status + (outcome.code ? " " + outcome.code : ""));
});

/*
 * jobs@1, answered by the dev host's simulated broker, and the shell's "Simulated jobs" list, which moves a job along.
 * A widget reads its job by polling, so a step taken here reaches it on its next read, as a node's progress would.
 */
const jobList = document.querySelector("[data-dev-job-list]");
async function renderJobs() {
  if (!jobList) return;
  const body = await (await fetch("/dev/api/jobs")).json();
  jobList.replaceChildren(...body.jobs.map((job) => {
    const item = document.createElement("li");
    item.dataset.devJob = job.jobId;
    item.dataset.devJobStatus = job.status;
    const progress = job.progress ? " " + String(job.progress.current) + (job.progress.total ? "/" + String(job.progress.total) : "") + (job.progress.message ? " " + job.progress.message : "") : "";
    const label = document.createElement("span");
    label.textContent = job.actionBindingId + " · " + job.status + progress;
    item.append(label);
    for (const control of ["advance", "complete", "fail"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = control === "advance" ? "Next step" : control === "complete" ? "Complete" : "Fail";
      button.dataset.devJobControl = control;
      button.disabled = !["queued", "running", "waiting"].includes(job.status);
      button.addEventListener("click", async () => {
        const response = await fetch("/dev/api/jobs/control", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId: job.jobId, control }),
        });
        const outcome = await response.json();
        appendLog("simulated job " + job.jobId + " " + control + " -> " + (outcome.job ? outcome.job.status : outcome.code));
        await renderJobs();
      });
      item.append(button);
    }
    return item;
  }));
  const empty = document.querySelector("[data-dev-job-empty]");
  if (empty) empty.hidden = body.jobs.length > 0;
}
window.addEventListener("message", async (event) => {
  const data = event.data;
  if (event.source !== frameElement?.contentWindow || !data || data.kind !== "job.request" || data.nonce !== bridgeNonce) return;
  let outcome;
  try {
    const response = await fetch("/dev/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data.request),
    });
    outcome = await response.json();
  } catch (error) {
    outcome = { status: "refused", code: "JOB_UNAVAILABLE", message: "the dev host did not answer: " + error.message };
  }
  frameElement.contentWindow?.postMessage({ kind: "job-result", nonce: bridgeNonce, requestId: data.requestId, ...outcome }, "*");
  if (data.request?.op === "cancel") {
    appendLog("simulated job " + String(data.request.jobId) + " cancel -> " + (outcome.job ? outcome.job.status : outcome.code));
    void renderJobs();
  }
});
void renderJobs();

/*
 * tokens@1, offered only when the package declared browser tokens, and answered by the dev host's simulated provider.
 * The log names the provider and the outcome; the value goes to the frame and is not written anywhere on this page.
 */
window.addEventListener("message", async (event) => {
  const data = event.data;
  if (event.source !== frameElement?.contentWindow || !data || data.kind !== "token.request" || data.nonce !== bridgeNonce) return;
  let outcome;
  try {
    const response = await fetch("/dev/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data.request),
    });
    outcome = await response.json();
  } catch (error) {
    outcome = { status: "refused", code: "TOKEN_UNAVAILABLE", message: "the dev host did not answer: " + error.message };
  }
  frameElement.contentWindow?.postMessage({ kind: "token-result", nonce: bridgeNonce, requestId: data.requestId, ...outcome }, "*");
  appendLog("simulated token " + String(data.request?.provider) + " -> " + (outcome.status === "ok" ? "issued" : outcome.code));
});

/*
 * The live-owner lease, claimed by this window and released before a detached window claims it — the same
 * ordering apps/desktop's shell follows: the shell releases first, so there is never a moment with two owners.
 * Every claim/release here is a real HTTP call into the server's lease store (dev-lease.ts, over the same
 * @clarkcant/core functions the runtime calls), not a local flag.
 */
const liveOwnerText = document.querySelector("[data-dev-live-owner]");
const ownerToken = "shell-" + crypto.randomUUID();
const detachChannel = new BroadcastChannel("clark-dev-detach");

async function claimInline() {
  const response = await fetch("/dev/api/live-owner", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerToken, surface: "inline" }),
  });
  const body = await response.json();
  liveOwnerText.textContent = body.ok ? "inline (this window)" : "held by another surface: " + JSON.stringify(body);
}

document.querySelector("[data-dev-detach='true']")?.addEventListener("click", async () => {
  await fetch("/dev/api/live-owner", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerToken }),
  });
  liveOwnerText.textContent = "detached (in a second window)";
  window.open("/detached", "clark-widget-detached", "width=480,height=640");
});

/* The detached window tells us it released and closed; we reclaim inline exactly like the shell does on reattach. */
detachChannel.addEventListener("message", (event) => {
  if (event.data && event.data.kind === "reattached") void claimInline();
});

void claimInline();
`;

/** The detached window's own in-page script: claims the lease for its surface and relays reattach. */
const DETACHED_SCRIPT = `
const ownerToken = "detached-" + crypto.randomUUID();
const detachChannel = new BroadcastChannel("clark-dev-detach");

await fetch("/dev/api/live-owner", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ownerToken, surface: "detached" }),
});

document.querySelector("[data-detached-reattach='true']")?.addEventListener("click", async () => {
  await fetch("/dev/api/live-owner", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerToken }),
  });
  detachChannel.postMessage({ kind: "reattached" });
  window.close();
});
`;

/** Where a shell's facts come from, once the choice between a package and the catalog has been made. */
interface ShellSource {
  /** The directory whose files may be served, or `undefined` for a catalog widget, which has no package. */
  root: string | undefined;
  packageId: string;
  definitionId: string;
  fixtures: readonly string[];
  requestedCapabilities: readonly string[];
  serviceCapabilities: readonly string[];
  serviceBindings: readonly ServiceBinding[];
  eventSchemas: Record<string, Record<string, unknown>>;
  entryUrl: string;
  definition: { textFallback: string; semanticDescription: string };
  /** Fixture name to its props, handed to the frame in the handshake. Empty for a catalog widget. */
  fixtureProps: Record<string, Record<string, unknown>>;
  /** Files in `fixtures/files/` the simulated picker offers. Empty for a catalog widget. */
  files: readonly DevFixtureFile[];
  /** The package's resource request and its widget's browser-token declaration. Absent for a catalog widget. */
  resources?: { request: ResourceRequest | undefined; browserTokens: readonly BrowserTokenDeclaration[] };
}

/** The widget-cli package directory, which is Vite's root when the frame is a catalog widget. */

function packageSource(requested: string): ShellSource {
  const root = resolve(requested);
  const pkg = readPackage(root);
  const facet = pkg.facets[0];
  if (facet === undefined) {
    throw new Error(`no widget facet is declared in ${root}, so there is nothing to develop`);
  }
  const serviceCapabilities = pkg.manifest.facets.flatMap((item) => item.kind === "tools" ? item.capabilities.map((capability) => capability.ref) : []);
  const jobCapabilities = pkg.manifest.facets.flatMap((item) =>
    item.kind === "tools" ? item.capabilities.filter((capability) => capability.execution?.kind === "job").map((capability) => capability.ref) : []);
  const simulator = readServiceSimulator(root, serviceCapabilities, jobCapabilities);
  const uiFacet = pkg.manifest.facets.find((item) => item.kind === "ui" && item.id === facet.facetId);
  return {
    root,
    packageId: pkg.manifest.id,
    definitionId: facet.facetId,
    fixtures: Object.keys(pkg.fixtures),
    requestedCapabilities: facet.definition.requestedCapabilities,
    serviceCapabilities: simulator.capabilities,
    serviceBindings: simulator.bindings,
    eventSchemas: facet.definition.eventSchemas,
    entryUrl: `/${facet.entryPath}`,
    definition: {
      textFallback: facet.definition.textFallback,
      semanticDescription: facet.definition.semanticDescription,
    },
    fixtureProps: pkg.fixtures,
    files: readFixtureFiles(root).files,
    resources: {
      request: pkg.manifest.resources,
      browserTokens: uiFacet?.kind === "ui" ? (uiFacet.browserTokens?.providers ?? []) : [],
    },
  };
}

function catalogSource(definitionId: string): ShellSource {
  // Resolved through the catalog rather than trusted, so an id the catalog does not have is refused here and not in
  // the browser, where the frame would have to report it.
  const target = catalogTarget({ definitionId, fixtureId: "" });
  if (target === undefined) {
    throw new Error(`${definitionId} is not a definition in the catalog, so there is nothing to develop`);
  }
  return {
    root: undefined,
    packageId: "catalog",
    definitionId: target.entry.definition.id,
    fixtures: target.entry.fixtures.map((fixture) => fixture.id),
    requestedCapabilities: target.entry.definition.requestedCapabilities,
    serviceCapabilities: [],
    serviceBindings: [],
    eventSchemas: target.entry.definition.eventSchemas,
    entryUrl: "/catalog-runtime.html",
    definition: {
      textFallback: target.entry.definition.textFallback,
      semanticDescription: target.entry.definition.semanticDescription,
    },
    // A catalog widget is drawn by the production renderer, not by a bridge-speaking frame, so it has neither.
    fixtureProps: {},
    files: [],
  };
}

export async function startDevHost(options: DevHostOptions): Promise<DevHost> {
  if (options.builtin !== undefined && options.root !== undefined) {
    throw new Error("a dev host takes either a package directory or a builtin definition id, not both");
  }
  if (options.builtin === undefined && options.root === undefined) {
    throw new Error("a dev host needs a package directory, or a builtin definition id");
  }

  const source = options.builtin === undefined ? packageSource(options.root ?? "") : catalogSource(options.builtin);
  const compositionEvents = declaredWidgetEvents(source.definitionId, source.eventSchemas);
  const compositionInputs = declaredCompositionInputs(source.definitionId);
  /*
   * The one discriminator for "this host serves a catalog widget": a package has a directory whose files may be
   * served, and a catalog widget does not, which is also exactly when Vite is needed to serve the frame's module.
   */
  const root = source.root;

  /*
   * Vite serves the catalog frame's module graph from the workspace source, so the preview is the production
   * renderer rather than a copy of it, and there is no build step to forget. It is created only for a catalog
   * widget: a package's frame is its own entry HTML, which this server already knows how to serve.
   */
  let vite: ViteDevServer | undefined;

  const fixtures = source.fixtures;
  const capabilities = source.requestedCapabilities;
  const files = source.files.map((file) => file.name);
  let state = initialState({ fixtures, requestedCapabilities: capabilities, serviceCapabilities: source.serviceCapabilities, files });
  let semanticInspection: SemanticInspection | undefined;
  let semanticPublishTimes: number[] = [];
  const bridgeNonce = randomBytes(16).toString("hex");
  const framePrefix = `/dev/frame/${bridgeNonce}`;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let vitePromise: Promise<ViteDevServer> | undefined;
  // Read on every pick, so switching the shell's picker control changes what the next pick returns.
  const artifacts = createDevArtifactBroker({ files: source.files, choosePick: () => state.pickFile });
  const jobs = createDevJobBroker();
  const declaredTokens = source.resources?.browserTokens ?? [];
  // Read on every request, so the shell's "Provider unavailable" control changes the next answer.
  const tokens = createDevTokenBroker({ declared: declaredTokens, mode: () => state.tokens });
  /*
   * The profile the simulated policy grants, decided by the node's own function. Not granted: no service is started,
   * so every action bound to one is unavailable with the node's sentence, exactly as a degraded package on a node.
   */
  const profileRefusal = (): string | undefined => {
    if (source.resources === undefined) return undefined;
    const grant = simulateResourceGrant({ request: source.resources.request, mode: state.profile });
    return grant.status === "degraded" ? grant.reason : undefined;
  };
  let reloadCount = 0;
  /*
   * One lease store per dev host process, over the same claimLiveOwner/releaseLiveOwner the runtime calls
   * (dev-lease.ts). A dev host shows one widget instance, so one store, closed with the server.
   */
  const lease = openDevLeaseStore();
  // Typed as the response itself rather than a structural lookalike: a cast here would be a comment about
  // Node's types instead of a fact about this code.
  const clients = new Set<ServerResponse>();
  let restarting = false;
  const finishServiceRestart = (): boolean => {
    if (!restarting) return false;
    if (restartTimer !== undefined) clearTimeout(restartTimer);
    restartTimer = undefined;
    restarting = false;
    state = { ...state, serviceReadiness: Object.fromEntries(source.serviceCapabilities.map((ref) => [ref, readinessForStatus("ready")])) };
    for (const client of clients) client.write("event: reload\ndata: {}\n\n");
    return true;
  };

  const getVite = async (): Promise<ViteDevServer> => {
    if (vite !== undefined) return vite;
    vitePromise ??= createDevModuleServer(true, server, port, {
      isolatedCache: true,
      // This middleware-only catalog server has no HTML entry to scan. Discovering dependencies from the whole
      // workspace source graph stalls cold-start optimization, so prebundle only React's runtime entry points. An
      // installed CLI serves self-contained bundles that import nothing, so there is nothing to prebundle.
      optimizeDeps: {
        noDiscovery: true,
        include: browserRuntime("dev-frame-runtime").prebundled ? [] : ["react", "react-dom/client"],
      },
    }).then(
      (created) => {
        vite = created;
        return created;
      },
      (error: unknown) => {
        vitePromise = undefined;
        throw error;
      },
    );
    return vitePromise;
  };

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const framePath = path.startsWith(`${framePrefix}/`) ? path.slice(framePrefix.length) : undefined;

    if (path === "/dev/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      response.write(": connected\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }

    if (path === "/dev/api/state") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ...state,
          viewportWidths: { "narrow-320": 320, conversation: 480, compact: 720, expanded: 1024 },
          // A package's frame speaks the bridge and is handed its fixture's props; a catalog frame is drawn directly.
          bridge: root !== undefined,
          bridgeNonce,
          props: source.fixtureProps[state.fixture] ?? {},
          serviceBindings: source.serviceBindings,
          actionAvailability: ((refusal) =>
            refusal === undefined
              ? actionAvailability({ bindings: source.serviceBindings, readiness: state.serviceReadiness, offline: state.offline })
              : source.serviceBindings.map((binding) => ({ actionBindingId: binding.actionBindingId, available: false, reason: refusal })))(
            profileRefusal(),
          ),
          browserTokens: declaredTokens.map((entry) => entry.provider),
        }),
      );
      return;
    }

    if (path === "/dev/api/semantic" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk: unknown) => {
        body += String(chunk);
        if (body.length > 32_768) request.destroy();
      });
      request.on("end", () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, problems: ["request must be JSON"] }));
          return;
        }
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed) ||
          (parsed as { nonce?: unknown }).nonce !== bridgeNonce
        ) {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, problems: ["frame nonce did not match this dev host"] }));
          return;
        }
        const result = inspectSemanticProposal({
          definitionId: source.definitionId,
          rawProposal: (parsed as { proposal?: unknown }).proposal,
          ...(semanticInspection === undefined
            ? {}
            : { previous: { doc: semanticInspection.doc, revision: semanticInspection.revision } }),
          revision: (semanticInspection?.revision ?? 0) + 1,
          recentPublishTimes: semanticPublishTimes,
          now: Date.now(),
        });
        if (!result.ok) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify(result));
          return;
        }
        semanticInspection = result.inspection;
        semanticPublishTimes = result.recentPublishTimes;
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(result.inspection));
      });
      return;
    }

    if (path === "/dev/api/composition-event" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk: unknown) => {
        body += String(chunk);
        if (body.length > 8_192) request.destroy();
      });
      request.on("end", () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, problem: "request must be JSON" }));
          return;
        }
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed) ||
          (parsed as { nonce?: unknown }).nonce !== bridgeNonce
        ) {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, problem: "frame nonce did not match this dev host" }));
          return;
        }
        const name = (parsed as { name?: unknown }).name;
        const rawPayload = (parsed as { payload?: unknown }).payload;
        if (typeof name === "string" && declaredCompositionEvents(source.definitionId).some((event) => event.name === name)) {
          const result = validateCompositionEvent(source.definitionId, name, rawPayload);
          response.writeHead(result.ok ? 200 : 400, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify(result));
          return;
        }
        const declaredSchema = typeof name === "string" ? source.eventSchemas[name] : undefined;
        if (declaredSchema !== undefined) {
          const validated = validateDeclaredWidgetEvent(declaredSchema, rawPayload);
          const result = validated.ok
            ? { ok: true, event: { name, payload: validated.payload } }
            : { ok: false, problem: validated.problem };
          response.writeHead(result.ok ? 200 : 400, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify(result));
          return;
        }
        const result = validateCompositionEvent(source.definitionId, name, rawPayload);
        response.writeHead(result.ok ? 200 : 400, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(result));
      });
      return;
    }

    /*
     * The simulated artifacts@1 broker. `POST` answers one request exactly as a host would answer the frame; `GET`
     * lists what it did, by name and size. Bounded like the other endpoints: one write chunk plus its envelope.
     */
    if (path === "/dev/api/artifacts") {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ events: artifacts.events() }));
        return;
      }
      if (request.method === "POST") {
        let body = "";
        request.on("data", (chunk: unknown) => {
          body += String(chunk);
          if (body.length > 400_000) request.destroy();
        });
        request.on("end", () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ status: "refused", code: "SCHEMA_INVALID", message: "the request must be JSON" }));
            return;
          }
          void artifacts.handle(parsed).then((outcome) => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(outcome));
          });
        });
        return;
      }
    }

    /*
     * The simulated jobs@1 broker. `POST /dev/api/jobs` answers one frame request as a host would; `GET` lists the held
     * jobs for the shell; `POST /dev/api/jobs/control` is the shell moving a job along. Nothing here runs a service.
     */
    if (path === "/dev/api/jobs" || path === "/dev/api/jobs/control") {
      if (path === "/dev/api/jobs" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jobs: jobs.list(), events: jobs.events() }));
        return;
      }
      if (request.method === "POST") {
        let body = "";
        request.on("data", (chunk: unknown) => {
          body += String(chunk);
          if (body.length > 4_096) request.destroy();
        });
        request.on("end", () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ status: "refused", code: "SCHEMA_INVALID", message: "the request must be JSON" }));
            return;
          }
          const control = parsed as { jobId?: unknown; control?: unknown } | null;
          const outcome = path === "/dev/api/jobs"
            ? jobs.handle(parsed)
            : typeof control?.jobId === "string" && (control.control === "advance" || control.control === "complete" || control.control === "fail")
              ? jobs.control(control.jobId, control.control)
              : { status: "refused", code: "SCHEMA_INVALID", message: "a control is { jobId, control: advance | complete | fail }" };
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(outcome));
        });
        return;
      }
    }

    /*
     * The simulated tokens@1 provider. `POST` answers one frame request as the node would, held to the package's
     * declaration; nothing is asked of a provider, and the value answered is random bytes that open nothing.
     */
    if (path === "/dev/api/tokens" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk: unknown) => {
        body += String(chunk);
        if (body.length > 8_192) request.destroy();
      });
      request.on("end", () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = undefined;
        }
        const outcome =
          declaredTokens.length === 0
            ? { status: "refused", code: "EXTENSION_NOT_OFFERED", message: "this package declares no browser tokens, so tokens@1 is not offered" }
            : tokens.handle(parsed);
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(outcome));
      });
      return;
    }

    if (path === "/dev/api/action" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk: unknown) => {
        body += String(chunk);
        // Bounded, because this endpoint is on a local port and an unbounded body is free memory for whoever
        // reaches it.
        if (body.length > 8_192) request.destroy();
      });
      request.on("end", () => {
        try {
          const action = JSON.parse(body) as DevShellAction;
          state = applyShellAction(state, action, { fixtures, capabilities, serviceCapabilities: source.serviceCapabilities, files });
          if (action.kind === "service-restart") {
            if (restartTimer !== undefined) clearTimeout(restartTimer);
            restartTimer = undefined;
            restarting = true;
            if (options.serviceRestart !== "held") restartTimer = setTimeout(finishServiceRestart, 2_000);
          }
        } catch {
          // A malformed action leaves the state alone and is reported, rather than resetting the shell.
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "action must be JSON" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(state));
      });
      return;
    }

    if (path === "/dev/api/service-action" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk: unknown) => {
        body += String(chunk);
        if (body.length > 8_192) request.destroy();
      });
      request.on("end", () => {
        let raw: unknown;
        try { raw = JSON.parse(body); }
        catch {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "action must be JSON" }));
          return;
        }
        const parsed = widgetToHostSchema.safeParse(raw);
        const action = parsed.success && parsed.data.kind === "action.invoke" ? parsed.data : undefined;
        if (action === undefined || action.nonce !== bridgeNonce) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "action must be a valid action.invoke message" }));
          return;
        }
        const binding = source.serviceBindings.find((candidate) => candidate.actionBindingId === action.actionBindingId);
        const readiness = binding === undefined ? undefined : state.serviceReadiness[binding.capabilityRef];
        const refusal = profileRefusal();
        const available =
          binding !== undefined && readiness !== undefined && serviceStatus(readiness) === "ready" && !state.offline && refusal === undefined;
        // A binding whose capability runs as a job answers with its JobRef, as a node does; the job is the shell's to move.
        const started = available && binding.job !== undefined
          ? jobs.start({ actionBindingId: binding.actionBindingId, capabilityRef: binding.capabilityRef, job: binding.job })
          : undefined;
        const outcome = !available
          ? { status: "refused", message: state.offline ? "the node is offline" : refusal ?? readiness?.blockedReason ?? "service is unavailable" }
          : binding.job === undefined
            ? binding.outcome
            : started === undefined
              ? { status: "refused", message: "the dev host already holds as many running simulated jobs as it allows" }
              : { status: "accepted", message: "Simulated job started (clark widget dev)", output: started.jobId };
        const answer = actionResult({ nonce: action.nonce, actionBindingId: action.actionBindingId, invocationId: action.invocationId, outcome });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(answer));
      });
      return;
    }

    if (path === "/dev/api/a11y" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk: unknown) => {
        body += String(chunk);
        if (body.length > 262_144) request.destroy();
      });
      request.on("end", () => {
        void import("./dev-shell.ts").then(({ auditFrame }) => {
          try {
            const facts = JSON.parse(body) as Parameters<typeof auditFrame>[0];
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ findings: auditFrame(facts, { reducedMotion: state.reducedMotion }) }));
          } catch {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "facts must be JSON" }));
          }
        });
      });
      return;
    }

    if (path === "/dev/shell.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(SHELL_SCRIPT);
      return;
    }

    if (path === "/dev/detached.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(DETACHED_SCRIPT);
      return;
    }

    if (framePath === "/widget-runtime.js") {
      if (isPackageFrameRequest(request, framePrefix)) {
        response.setHeader("access-control-allow-origin", "null");
        response.setHeader("vary", "Origin");
      }
      const runtime = browserRuntime("dev-frame-runtime");
      if (sendPrebundledRuntime(response, runtime.url)) return;
      const moduleServer = await getVite();
      request.url = runtime.url;
      moduleServer.middlewares(request, response, () => {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("widget runtime module not found\n");
      });
      return;
    }

    /*
     * The live-owner lease, read and written for real.
     *
     * `GET` answers with the current claim so a collector (or a test) can observe the handoff without guessing
     * from timing; `POST` claims and `DELETE` releases, both delegating straight to `lease`, which is `dev-lease.ts`
     * over `@clarkcant/core`'s real `claimLiveOwner`/`releaseLiveOwner`.
     */
    if (path === "/dev/api/live-owner") {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ current: lease.current() ?? null }));
        return;
      }
      if (request.method === "POST" || request.method === "DELETE") {
        let body = "";
        request.on("data", (chunk: unknown) => {
          body += String(chunk);
          if (body.length > 4_096) request.destroy();
        });
        request.on("end", () => {
          let parsed: { ownerToken?: unknown; surface?: unknown };
          try {
            parsed = JSON.parse(body) as { ownerToken?: unknown; surface?: unknown };
          } catch {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: false, refused: "body must be JSON" }));
            return;
          }
          const ownerToken = typeof parsed.ownerToken === "string" ? parsed.ownerToken : "";
          if (ownerToken === "") {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: false, refused: "ownerToken is required" }));
            return;
          }
          if (request.method === "DELETE") {
            const released = lease.release(ownerToken);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: true, released }));
            return;
          }
          const surface = parsed.surface === "pin" || parsed.surface === "detached" ? parsed.surface : "inline";
          const claimed = lease.claim({ ownerToken, surface });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(claimed));
        });
        return;
      }
    }

    /*
     * The detached window: the same sandboxed frame, opened by the shell's "Detach" button
     * (`window.open("/detached", ...)`), with its own claim on the lease.
     */
    if (path === "/detached") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        renderDetachedShell({
          definitionId: source.definitionId,
          entryUrl: root === undefined ? source.entryUrl : `${framePrefix}${source.entryUrl}`,
          definition: source.definition,
        }),
      );
      return;
    }

    /*
     * The frame's page for a catalog widget. Generated per request so it carries the fixture the shell is currently
     * showing: the shell reloads the frame on every control change, so the state read here is the state on screen.
     */
    if (path === "/catalog-runtime.html" && root === undefined) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(catalogFrameHtml({ definitionId: source.definitionId, fixtureId: state.fixture }, browserRuntime("catalog-runtime").url));
      return;
    }

    if (path === "/" || path === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        renderShell(
          {
            packageId: source.packageId,
            definitionId: source.definitionId,
            fixtures,
            requestedCapabilities: capabilities,
            serviceCapabilities: source.serviceCapabilities,
            entryUrl: root === undefined ? source.entryUrl : `${framePrefix}${source.entryUrl}`,
            definition: source.definition,
            compositionEvents,
            compositionInputs,
            ...(root === undefined ? {} : { files }),
            ...(source.resources === undefined
              ? {}
              : { resources: { request: source.resources.request, browserTokenProviders: declaredTokens.map((entry) => entry.provider) } }),
          },
          state,
        ),
      );
      return;
    }

    if (root === undefined) {
      /*
       * A catalog widget has no package files to serve: its module graph belongs to Vite, which resolves the
       * workspace's sources the way the app's own build does. Handing the request over rather than answering it is
       * what keeps the preview the production renderer instead of a second implementation of it. An installed CLI's
       * catalog runtime is already that graph, bundled, and is served as it is.
       */
      if (sendPrebundledRuntime(response, path)) return;
      const moduleServer = await getVite();
      moduleServer.middlewares(request, response, () => {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("not found\n");
      });
      return;
    }

    if (path.startsWith("/@fs/") || path.startsWith("/@id/") || path.startsWith("/node_modules/.vite/")) {
      if (isPackageFrameRequest(request, framePrefix)) {
        response.setHeader("access-control-allow-origin", "null");
        response.setHeader("vary", "Origin");
      }
      const moduleServer = await getVite();
      moduleServer.middlewares(request, response, () => {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("module not found\n");
      });
      return;
    }

    /*
     * Package files. Resolved, then checked to be inside the root: a dev server that serves whatever a path
     * resolves to hands out the author's home directory, and it is the ordinary way a local tool becomes a way to
     * read files.
     */
    const packagePath = framePath;
    if (packagePath === undefined) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found\n");
      return;
    }
    const candidate = resolve(join(root, normalize(packagePath)));
    const inside = candidate === root || candidate.startsWith(root + sep);
    if (!inside) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("refused: that path is outside the package\n");
      return;
    }
    try {
      if (!statSync(candidate).isFile()) throw new Error("not a file");
      // Sandboxed package frames have an opaque (`null`) origin and module scripts use CORS fetches. Permit that
      // exact origin for files already confined under this package root; never reflect a website's arbitrary origin.
      if (isPackageFrameRequest(request, framePrefix)) {
        response.setHeader("access-control-allow-origin", "null");
        response.setHeader("vary", "Origin");
      }
      response.writeHead(200, { "content-type": contentType(candidate) });
      const contents = readFileSync(candidate);
      if (candidate === resolve(root, source.entryUrl.slice(1)) && extname(candidate) === ".html") {
        const html = contents.toString("utf8");
        const entryDirectory = `${framePrefix}${dirname(source.entryUrl)}/`;
        const base = `<base href="${entryDirectory}">`;
        const runtime = `<script type="module" src="${framePrefix}/widget-runtime.js"></script>`;
        const injection = `${base}\n  ${runtime}`;
        const prepared = /<head\b[^>]*>/i.test(html)
          ? html.replace(/<head\b[^>]*>/i, (head) => `${head}\n  ${injection}`)
          : `${injection}\n${html}`;
        response.end(prepared);
      } else {
        response.end(contents);
      }
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found\n");
    }
  });

  let watcher: FSWatcher | undefined;
  if (root !== undefined && options.watchFiles !== false) {
    try {
      watcher = watch(root, { recursive: true }, () => {
        reloadCount += 1;
        for (const client of clients) client.write("event: reload\ndata: {}\n\n");
      });
    } catch {
      // A platform without recursive watching still gets a working host; it just needs a manual refresh, and the
      // shell is not told a reload happened because none did.
      watcher = undefined;
    }
  }

  const port = await new Promise<number>((resolvePort) => {
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      resolvePort(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

  return {
    url: `http://127.0.0.1:${String(port)}/`,
    port,
    state: () => state,
    apply: (action) => {
      state = applyShellAction(state, action, { fixtures, capabilities, serviceCapabilities: source.serviceCapabilities, files });
      return state;
    },
    reloads: () => reloadCount,
    artifactEvents: () => artifacts.events(),
    jobEvents: () => jobs.events(),
    tokenEvents: () => tokens.events(),
    finishServiceRestart,
    close: async () => {
      watcher?.close();
      if (restartTimer !== undefined) clearTimeout(restartTimer);
      for (const client of clients) client.end();
      clients.clear();
      lease.close();
      const activeVite = await vitePromise?.catch(() => undefined);
      await closeDevModuleServer(activeVite);
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

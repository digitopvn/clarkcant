/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { mkdirSync } from "node:fs";

import {
  type AutomationAction,
  type AutomationTarget,
  type Observation,
  observationIdSchema,
} from "@clarkcant/contracts";
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Locator,
  type Page,
  type Request,
  type Response,
} from "playwright";

import { SUPPORTED_OPERATIONS, managedProfileDescriptor, resolveLocator, reviewAction } from "./index.ts";

/**
 * Playwright-backed browser driver.
 *
 * The control contract lives in `@clarkcant/contracts` and the policy in this pack: this file
 * is only the mechanics. Three decisions are worth reading.
 *
 * 1. **A managed profile, never the user's browser.** `launchPersistentContext` with a
 *    profile directory this driver owns. Attaching to the operator's Chrome would inherit
 *    every logged-in session, which is the opposite of least privilege.
 * 2. **Element references are attributes this driver stamps, not coordinates.** An action
 *    targets `[data-cc-ref="…"]`. If the attribute is gone at action time the element has
 *    been replaced and the plan is stale, which turns "the page moved" from a wrong click
 *    into an explicit re-observation.
 * 3. **Navigation is checked against the profile's declared origins** before it happens, the
 *    page's own included: a link or a form pointing elsewhere is stopped before its request
 *    leaves, a document the page or a frame is about to load from elsewhere (a script's
 *    navigation, a redirect's hop) is answered on the spot inside the browser so the page
 *    stays put, a script cannot open a window and a new tab is closed, and a page that still
 *    ends up elsewhere (where a `goto` landed, or where an observation finds it) is taken
 *    back to a blank page. The model does
 *    not get to name a new destination, directly or by clicking one.
 * 4. **A click's outcome is the answer to what it sent.** A submit that was dispatched but
 *    never answered is `unknown`, not `applied` (`watchClickRequests`).
 */

export interface DriverProfile {
  target: AutomationTarget;
  allowedOrigins: string[];
  downloadRoot?: string;
}

/**
 * One element an observation stamped, as a planner can name it.
 *
 * Everything here except `ref` is read from the page, so it is the page's own words: data to plan with, never an
 * instruction to follow. `submits` is the driver's reading of the markup (a submit control, or a button that would
 * submit its form), which is what a caller classifies a click as consequential from.
 */
export interface ObservedElement {
  ref: string;
  tag: string;
  role: string | null;
  /** The accessible name, as far as the markup says: `aria-label`, then `name`, then the visible text. */
  name: string;
  /** The `type` attribute, for inputs and buttons. */
  type: string | null;
  submits: boolean;
}

export interface ObserveResult {
  observation: Observation;
  /** What each stamped reference is, in the order the page lists them. */
  elements: ObservedElement[];
  /** Where the page is now, so a caller can hold it to the declared origins. */
  url: string;
  title: string;
}

export interface ActResult {
  status: "applied" | "refused" | "failed" | "unknown";
  verification: "observed-applied" | "observed-absent" | "not-observed" | "not-applicable";
  message: string;
  requiresReobservation: boolean;
  /**
   * Whether the action sent something that can carry an effect outside: a request other than a read. Set by a click,
   * whatever the caller classified it as, so a click nobody marked consequential that turned out to submit is still
   * known to have submitted.
   */
  sentEffect?: boolean;
}

const REF_ATTRIBUTE = "data-cc-ref";

/** How long a click waits for the answers to the requests it sent, unless the profile says otherwise. */
const DEFAULT_ANSWER_TIMEOUT_MS = 5000;
/** How long after a click returns a request it started is still counted as the click's. */
const REQUEST_GRACE_MS = 250;

/** What came back for the requests one click sent. */
type ClickAnswer =
  | { kind: "none" }
  | { kind: "answered"; statuses: number[] }
  | { kind: "no-answer"; pending: number }
  | { kind: "failed"; reason: string };

/**
 * Follow the requests one click sends, and hear whether each was answered.
 *
 * A click resolves when the browser has dispatched it, not when the form it submitted was answered: a plain form POST
 * or a script's `fetch` returns control at once and the request is still on its way. "The click landed" then says
 * nothing about the submission, and a server that never answers would read as done. So the requests that can carry an
 * effect — anything but a read, and the page's own navigation — are followed until each has an answer or the deadline
 * passes, and one still waiting at the deadline, or one that broke after it left, is what the driver calls unknown.
 */
function watchClickRequests(
  page: Page,
  /** Requests the driver stops before they leave (`BrowserDriver.#blocks`): they send nothing and are not waited on. */
  blocks: (request: Request) => boolean,
): {
  settle: (timeoutMs: number) => Promise<ClickAnswer>;
  stop: () => void;
  /** Whether the click started a navigation of the page itself, which replaces every stamped reference. */
  navigated: () => boolean;
  /** How many requests other than reads the click started, answered or not. */
  sent: () => number;
  /** Where the click tried to take the page or one of its frames outside the declared origins, and was stopped. */
  blocked: () => string[];
} {
  const pending = new Set<Request>();
  let sent = 0;
  const statuses: number[] = [];
  const failures: string[] = [];
  const blocked: string[] = [];
  const mainFrame = page.mainFrame();
  let navigated = false;
  const isPageNavigation = (request: Request): boolean => {
    try {
      return request.isNavigationRequest() && request.frame() === mainFrame;
    } catch {
      // A service worker's request has no frame, and it is not the page's navigation.
      return false;
    }
  };
  const onRequest = (request: Request): void => {
    // A redirect is the same submission answered with "go there": the first request has its answer.
    const from = request.redirectedFrom();
    if (from !== null && pending.delete(from)) statuses.push(302);
    if (blocks(request)) {
      if (blocked.length < 5) blocked.push(request.url().slice(0, 200));
      return;
    }
    const pageNavigation = isPageNavigation(request);
    if (pageNavigation) navigated = true;
    const writes = !["GET", "HEAD", "OPTIONS"].includes(request.method());
    if (pageNavigation || writes) pending.add(request);
    // A redirect's follow-up is the same submission; a page's GET navigation is a read.
    if (writes && from === null) sent += 1;
  };
  // The status line is the site's answer. A body that is cut off after it (Chromium aborts a 204's) changes nothing.
  const onResponse = (response: Response): void => {
    if (pending.delete(response.request())) statuses.push(response.status());
  };
  const onFinished = (request: Request): void => {
    pending.delete(request);
  };
  const onFailed = (request: Request): void => {
    if (blocks(request)) return;
    if (pending.delete(request)) failures.push(request.failure()?.errorText ?? "the request failed");
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  const stop = (): void => {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfinished", onFinished);
    page.off("requestfailed", onFailed);
  };
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    stop,
    navigated: () => navigated,
    sent: () => sent,
    blocked: () => [...blocked],
    async settle(timeoutMs) {
      await sleep(REQUEST_GRACE_MS);
      const deadline = Date.now() + timeoutMs;
      while (pending.size > 0 && Date.now() < deadline) await sleep(50);
      stop();
      if (pending.size > 0) return { kind: "no-answer", pending: pending.size };
      const [failure] = failures;
      if (failure !== undefined) return { kind: "failed", reason: failure };
      return statuses.length === 0 ? { kind: "none" } : { kind: "answered", statuses };
    },
  };
}

export class BrowserDriver {
  readonly #profile: DriverProfile;
  readonly #profileDir: string;
  #context: BrowserContext | undefined;
  #page: Page | undefined;
  /** The browser start under way, shared by every caller that needs the page meanwhile and awaited by `close`. */
  #launching: Promise<Page> | undefined;
  #closed = false;
  #epoch = 0;
  #observations = new Map<string, Observation>();
  #stopped = false;
  #humanTakeover = false;
  /**
   * Action ids whose outcome is genuinely unknown.
   *
   * A timed-out click may or may not have landed. Retrying it is the one thing that turns
   * "maybe it submitted" into "it submitted twice", and a double submit is not a retry — it is a
   * second application, order or payment. An entry here is cleared only by a fresh observation,
   * which is the act of finding out what actually happened.
   */
  readonly #unresolved = new Set<string>();
  readonly #answerTimeoutMs: number;
  readonly #hostResolverRules: readonly string[];
  #targetVersion = "1";

  constructor(input: {
    profile: DriverProfile;
    profileDir: string;
    answerTimeoutMs?: number;
    /** Chromium `--host-resolver-rules` entries (`MAP host address`) that fix where a named site is found. */
    hostResolverRules?: readonly string[];
  }) {
    this.#profile = input.profile;
    this.#profileDir = input.profileDir;
    this.#answerTimeoutMs = input.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
    this.#hostResolverRules = input.hostResolverRules ?? [];
  }

  get target(): AutomationTarget {
    return this.#profile.target;
  }

  get leaseEpoch(): number {
    return this.#epoch;
  }

  /** Bumped on navigation, so a plan captured before it is refused rather than replayed. */
  get targetVersion(): string {
    return this.#targetVersion;
  }

  #originAllowed(parsed: URL): boolean {
    return this.#profile.allowedOrigins.some((origin) => parsed.origin === origin || parsed.hostname === origin);
  }

  /** Whether a page the browser is on, or is going to, is somewhere the profile declared. `about:blank` is nowhere. */
  #pageAllowed(url: string): boolean {
    if (url === "about:blank") return true;
    try {
      return this.#originAllowed(new URL(url));
    } catch {
      return false;
    }
  }

  /** Refuse to navigate anywhere the profile did not declare. */
  #assertOriginAllowed(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${url} is not an absolute URL`);
    }
    if (!this.#originAllowed(parsed)) {
      throw new Error(
        `navigation to ${parsed.origin} is outside this profile's declared origins [${this.#profile.allowedOrigins.join(", ")}]`,
      );
    }
  }

  /** Whether a document may load: somewhere declared, or a frame's own inline document. */
  #documentAllowed(url: string): boolean {
    return url === "about:srcdoc" || this.#pageAllowed(url);
  }

  /**
   * Whether the browser stopped this request before it left (`#stopForeignDocuments`): a document the page or one of its
   * frames was about to load from somewhere undeclared, a redirect's next hop included.
   */
  #blocks(request: Request): boolean {
    if (this.#documentAllowed(request.url())) return false;
    try {
      return request.isNavigationRequest() && request.frame().page() === this.#page;
    } catch {
      // A service worker's request has no frame, and is not a navigation of anything.
      return false;
    }
  }

  /**
   * Hold every document this page or its frames load at the browser, before it leaves, and answer one bound for
   * somewhere undeclared with `204 No Content`: a navigation answered that way does not happen, so the page stays where
   * it was. Only documents are held, through the page's own DevTools session, so a page's other requests are never
   * waited on — Playwright's `route` holds every request until the page's own thread is free to describe it, which
   * delays a submission a busy page sent. Redirect hops are held too.
   */
  async #stopForeignDocuments(page: Page, context: BrowserContext): Promise<void> {
    const session: CDPSession = await context.newCDPSession(page);
    session.on("Fetch.requestPaused", (event) => {
      const answer = this.#documentAllowed(event.request.url)
        ? session.send("Fetch.continueRequest", { requestId: event.requestId })
        : session.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 204 });
      // A request whose page closed or navigated on meanwhile has nobody left to answer.
      answer.catch(() => undefined);
    });
    await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] });
  }

  /**
   * The page, starting the browser the first time. Callers that arrive while it is starting share that one start, and
   * `close` waits for it: a browser still starting when the driver was closed is closed as soon as it is up, never
   * handed out, and nothing is started after a close.
   */
  #ensurePage(): Promise<Page> {
    if (this.#closed) return Promise.reject(new Error("this browser driver was closed; no browser will be started"));
    if (this.#page) return Promise.resolve(this.#page);
    this.#launching ??= this.#launch().finally(() => {
      this.#launching = undefined;
    });
    return this.#launching;
  }

  async #launch(): Promise<Page> {
    mkdirSync(this.#profileDir, { recursive: true });
    const context = await chromium.launchPersistentContext(this.#profileDir, {
      headless: true,
      ...(this.#hostResolverRules.length === 0
        ? {}
        : { args: [`--host-resolver-rules=${this.#hostResolverRules.join(",")}`] }),
    });
    this.#context = context;
    const [existing] = context.pages();
    const page = existing ?? (await context.newPage());
    /*
     * One page. A script cannot open a window, and a new tab that opens anyway (a link's `target`) is closed at once.
     * The page's documents are held to the declared sites before they load; where the page ended up is still checked
     * after every navigation and before every observation. A page these could not be set up on is never handed out.
     */
    try {
      await context.addInitScript(() => {
        window.open = () => null;
      });
      context.on("page", (opened) => {
        if (opened !== page) void opened.close().catch(() => undefined);
      });
      await this.#stopForeignDocuments(page, context);
      // Closed while it was starting: the close is waiting on this start, so the browser is shut here, before it
      // returns, rather than left running with nobody holding it.
      if (this.#closed) throw new Error("this browser driver was closed while its browser was starting");
    } catch (cause) {
      this.#context = undefined;
      await context.close().catch(() => undefined);
      throw cause;
    }
    this.#page = page;
    return page;
  }

  /**
   * Take the page back to a blank one when it ended up somewhere undeclared, however it got there. Returns where it was.
   * Nothing is read from or done on a page this profile was never allowed to be on.
   */
  async #leaveIfOutside(page: Page): Promise<string | undefined> {
    const url = page.url();
    if (this.#pageAllowed(url)) return undefined;
    await page.goto("about:blank").catch(() => undefined);
    this.#bumpTargetVersion();
    return url;
  }

  /**
   * Start a fresh lease epoch.
   *
   * Bumping the epoch invalidates every outstanding observation, which is what makes a
   * local stop effective against a plan that was captured before it.
   */
  startLease(): number {
    this.#epoch += 1;
    this.#stopped = false;
    this.#observations.clear();
    return this.#epoch;
  }

  /**
   * Stop. Local and immediate: it does not wait for a remote acknowledgement, and no
   * subsequent action can be sent under the previous epoch.
   */
  stop(reason: string): { epoch: number; reason: string } {
    this.#stopped = true;
    this.#epoch += 1;
    this.#observations.clear();
    return { epoch: this.#epoch, reason };
  }

  /** A human taking the keyboard pauses agent input rather than racing them. */
  setHumanTakeover(active: boolean): void {
    this.#humanTakeover = active;
    if (active) this.#observations.clear();
  }

  /**
   * Capture an observation.
   *
   * Element references are stamped onto the live DOM so an action can prove the element is
   * still the one that was planned against. The screenshot is a reference, not bytes: the
   * policy layer decides retention, and raw frames never enter the event log.
   */
  async observe(): Promise<ObserveResult> {
    // Re-observing is how an unknown outcome stops being unknown, so it is the only thing that
    // clears the retry block.
    this.#unresolved.clear();
    const page = await this.#ensurePage();
    await this.#leaveIfOutside(page);

    const elements: ObservedElement[] = await page.evaluate((attribute: string) => {
      const selector = 'a[href], button, input, select, textarea, [role], [data-testid]';
      const nodes = [...document.querySelectorAll(selector)].slice(0, 500);
      let index = 0;
      return nodes.map((node) => {
        index += 1;
        const ref = `el_${Date.now().toString(36)}_${index}`;
        node.setAttribute(attribute, ref);
        const element = node as HTMLElement;
        const tag = element.tagName.toLowerCase();
        const type = element.getAttribute("type");
        const name = (
          element.getAttribute("aria-label") ??
          element.getAttribute("name") ??
          (element instanceof HTMLInputElement && (type === "submit" || type === "button") ? element.value : null) ??
          (element.textContent ?? "")
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80);
        // What pressing it would submit: an input or button that is a submit control, where a button with no type is
        // one when it sits in a form. A script can make anything submit, which is why a caller may still say a click
        // is consequential when this says it is not; it can never say the opposite.
        const lowerType = (type ?? "").toLowerCase();
        const submits =
          (tag === "input" && (lowerType === "submit" || lowerType === "image")) ||
          (tag === "button" && (lowerType === "submit" || (lowerType === "" && element.closest("form") !== null)));
        return { ref, tag, role: element.getAttribute("role"), name, type, submits };
      });
    }, REF_ATTRIBUTE);

    const refs = elements.map((element) => element.ref);
    const containsSensitiveInput = await page.evaluate(() => {
      const active = document.activeElement;
      if (active === null) return false;
      return active.getAttribute("type") === "password";
    });

    const observation: Observation = {
      observationId: observationIdSchema.parse(`obs_${Date.now().toString(36)}_${refs.length}`),
      targetId: this.#profile.target.targetId,
      leaseEpoch: this.#epoch,
      capturedAt: new Date().toISOString() as Observation["capturedAt"],
      screenshotRef: `screenshot:${this.#profile.target.targetId}:${Date.now().toString(36)}`,
      viewport: await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        scale: window.devicePixelRatio,
      })),
      elementRefs: refs,
      // While a secret is on screen the driver stops capturing and stops accepting input,
      // rather than observing a password field on the model's behalf.
      containsSensitiveInput,
    };

    this.#observations.set(observation.observationId, observation);
    return { observation, elements, url: page.url(), title: await page.title() };
  }

  /**
   * Perform one action.
   *
   * The policy check runs before anything touches the page, so a refused action has no
   * observable side effect at all.
   */
  /**
   * Capture the frame as bytes.
   *
   * Deliberately separate from `observe`, and for the reason that function's own comment gives: raw frames never
   * enter the event log, so an observation carries a reference and the bytes are fetched only when somebody is
   * actually looking at a screen. A takeover preview is that occasion — and the bytes belong to whoever asked for
   * them now, not to an observation recorded earlier that nobody retained.
   */
  async capturePreview(): Promise<{
    bytes: Uint8Array;
    contentType: "image/png";
    viewport: { width: number; height: number };
  }> {
    const page = await this.#ensurePage();
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const bytes = await page.screenshot({ type: "png" });
    return { bytes, contentType: "image/png", viewport };
  }

  async act(action: AutomationAction, options: { approvalGranted: boolean }): Promise<ActResult> {
    // A stop and a human takeover outrank every operation, including navigation.
    if (this.#stopped) {
      return {
        status: "refused",
        verification: "not-applicable",
        message: "a stop was requested on this target; no further action will be sent",
        requiresReobservation: false,
      };
    }
    if (this.#humanTakeover) {
      return {
        status: "refused",
        verification: "not-applicable",
        message: "the user has takeover of this target; agent input is paused",
        requiresReobservation: false,
      };
    }

    if (this.#unresolved.has(action.actionId)) {
      return {
        status: "refused",
        verification: "not-observed",
        message: `${action.actionId} timed out earlier and may already have taken effect; observe the page to find out before sending it again`,
        requiresReobservation: true,
      };
    }

    if (action.operation === "navigate") {
      if (action.expectedTargetVersion !== this.#targetVersion) {
        return {
          status: "refused",
          verification: "not-applicable",
          message: `the plan expects target version ${action.expectedTargetVersion} but the target is at ${this.#targetVersion}; re-observe`,
          requiresReobservation: true,
        };
      }
      // The origin is checked before the browser is started. Validation that can be done without
      // launching anything belongs first: doing it after left a refused navigation waiting on a
      // cold Chromium start, which is slow enough under load to look like a hang.
      const url = String(action.arguments.url ?? "");
      try {
        this.#assertOriginAllowed(url);
      } catch (cause) {
        return {
          status: "refused",
          verification: "not-applicable",
          message: cause instanceof Error ? cause.message : String(cause),
          requiresReobservation: false,
        };
      }

      const page = await this.#ensurePage();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        // Navigation replaces every reference stamped on the previous document.
        this.#bumpTargetVersion();
        // Where the page ended, not where it was sent: a redirect or a script may have moved it on.
        const left = await this.#leaveIfOutside(page);
        if (left !== undefined) {
          return {
            status: "refused",
            verification: "not-applicable",
            message: `${url} ended on ${left.slice(0, 200)}, outside this profile's declared origins; the page was taken back to a blank page`,
            requiresReobservation: true,
          };
        }
        return {
          status: "applied",
          verification: "not-applicable",
          message: `navigated to ${url}`,
          requiresReobservation: true,
        };
      } catch (cause) {
        return {
          status: "refused",
          verification: "not-applicable",
          message: cause instanceof Error ? cause.message : String(cause),
          requiresReobservation: false,
        };
      }
    }

    const observation = this.#observations.get(action.observationId);
    if (!observation) {
      return {
        status: "refused",
        verification: "not-observed",
        message: `observation ${action.observationId} is no longer retained; observe again before acting`,
        requiresReobservation: true,
      };
    }

    const decision = reviewAction(action, {
      observation,
      currentLeaseEpoch: this.#epoch,
      currentTargetVersion: this.#targetVersion,
      humanTakeover: this.#humanTakeover,
      stopRequested: this.#stopped,
      approvalGranted: options.approvalGranted,
    });

    if (!decision.allowed) {
      return {
        status: "refused",
        verification: "not-applicable",
        message: decision.message,
        requiresReobservation: decision.code !== "STALE_LEASE_EPOCH",
      };
    }

    if (!SUPPORTED_OPERATIONS.includes(action.operation)) {
      return {
        status: "refused",
        verification: "not-applicable",
        message: `operation ${action.operation} is not implemented by this driver`,
        requiresReobservation: false,
      };
    }

    const page = await this.#ensurePage();

    try {
      switch (action.operation) {
        case "screenshot":
          return {
            status: "applied",
            verification: "not-applicable",
            message: "screenshot captured for the observation",
            requiresReobservation: false,
          };
        case "read-dom": {
          const left = await this.#leaveIfOutside(page);
          if (left !== undefined) {
            return {
              status: "refused",
              verification: "not-applicable",
              message: `the page had moved to ${left.slice(0, 200)}, outside this profile's declared origins, and was taken back to a blank page; nothing was read`,
              requiresReobservation: true,
            };
          }
          const text = (await page.textContent("body")) ?? "";
          return {
            status: "applied",
            verification: "observed-applied",
            message: text.slice(0, 2000),
            requiresReobservation: false,
          };
        }
        case "click":
        case "fill": {
          const locatorHint: { elementRef?: string; text?: string } = {};
          if (action.arguments.elementRef !== undefined) locatorHint.elementRef = String(action.arguments.elementRef);
          if (action.arguments.text !== undefined) locatorHint.text = String(action.arguments.text);
          const resolution = resolveLocator(observation, locatorHint);
          if (resolution.status === "needs-reobservation") {
            return {
              status: "refused",
              verification: "not-observed",
              message: resolution.reason,
              requiresReobservation: true,
            };
          }
          const locator = page.locator(`[${REF_ATTRIBUTE}="${resolution.elementRef}"]`);
          // The count check is the staleness guard: a ref that is no longer in the document
          // means the element was replaced and the plan must be re-derived.
          if ((await locator.count()) === 0) {
            return {
              status: "refused",
              verification: "not-observed",
              message: `element ${resolution.elementRef} is no longer in the document; observe again`,
              requiresReobservation: true,
            };
          }
          if (action.operation === "click") {
            return await this.#click(page, locator, action, resolution.elementRef);
          }
          await locator.first().fill(String(action.arguments.value ?? ""), { timeout: 5000 });
          // Reading the page back is what turns "the click landed" into an outcome claim.
          const stillThere = (await locator.count()) > 0;
          return {
            status: "applied",
            verification: stillThere ? "observed-applied" : "not-observed",
            message: `${action.operation} on ${resolution.elementRef} completed`,
            requiresReobservation: false,
          };
        }
        default:
          return {
            status: "refused",
            verification: "not-applicable",
            message: `operation ${action.operation} has no implementation yet`,
            requiresReobservation: false,
          };
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A timeout is an unknown outcome, never a failed one: the action may have landed.
      const timedOut = /timeout/i.test(message);
      if (timedOut) this.#unresolved.add(action.actionId);
      return {
        status: timedOut ? "unknown" : "failed",
        verification: "not-observed",
        message: timedOut
          ? `${action.operation} timed out; the outcome is unknown and must be observed before retrying`
          : message,
        requiresReobservation: true,
      };
    }
  }

  /**
   * Click, and hear what the click sent.
   *
   * The outcome is the answer to the requests the click started, not the click's own return (see
   * `watchClickRequests`): no answer by the deadline, or a request that broke after it left, is `unknown`, and the
   * action joins the ones that may not be sent again until the page is observed. A server that answered with a client
   * error refused it; one that answered with a server error or a 408 may have done part of it, so that is unknown as
   * well. A click that broke after it sent something is unknown whatever the error said; one that broke before sending
   * anything is thrown to the caller's handler, which calls a timeout unknown and anything else failed.
   */
  async #click(
    page: Page,
    locator: Locator,
    action: AutomationAction,
    elementRef: string,
  ): Promise<ActResult> {
    /*
     * Where the click would take the page, when the markup says: a link's address, or the address a submit control
     * sends its form to. Held to the declared origins before anything is pressed, so a link or a form on an allowed
     * page cannot become the model naming a destination by other means. A script can still send anywhere, which is
     * why the page is also checked after the click.
     */
    const destination = await locator
      .first()
      .evaluate((node: Element): string | null => {
        const anchor = node.closest("a[href]");
        if (anchor instanceof HTMLAnchorElement) return anchor.href;
        if (!(node instanceof HTMLButtonElement || node instanceof HTMLInputElement) || node.form === null) return null;
        const type = (node.getAttribute("type") ?? "").toLowerCase();
        const submits =
          node instanceof HTMLInputElement ? type === "submit" || type === "image" : type === "submit" || type === "";
        if (!submits) return null;
        const override = node.getAttribute("formaction");
        return override !== null && override !== "" ? new URL(override, document.baseURI).href : node.form.action;
      })
      .catch(() => null);
    if (destination !== null && !destination.startsWith("javascript:") && !this.#pageAllowed(destination)) {
      return {
        status: "refused",
        verification: "not-applicable",
        message: `click on ${elementRef} would go to ${destination.slice(0, 200)}, which is outside this profile's declared origins; nothing was pressed`,
        requiresReobservation: false,
      };
    }

    const watch = watchClickRequests(page, (request) => this.#blocks(request));
    try {
      await locator.first().click({ timeout: 5000 });
    } catch (cause) {
      watch.stop();
      // Broken after it sent something: whatever the error says, the submission left, and nothing says it was not kept.
      if (watch.sent() > 0) {
        this.#unresolved.add(action.actionId);
        const reason = cause instanceof Error ? cause.message : String(cause);
        return {
          status: "unknown",
          verification: "not-observed",
          message: `click on ${elementRef} sent a request and then broke (${reason.split("\n")[0]?.slice(0, 200) ?? ""}); the outcome is unknown and must be observed before retrying`,
          requiresReobservation: true,
          sentEffect: true,
        };
      }
      throw cause;
    }
    const answer = await watch.settle(this.#answerTimeoutMs);
    const sentEffect = watch.sent() > 0;
    const left = this.#pageAllowed(page.url()) ? undefined : page.url();
    if (left !== undefined) {
      // The page got somewhere undeclared some way the browser did not stop. It is taken back, so nothing further is
      // read from or done on a page this profile was never allowed to be on.
      await page.goto("about:blank").catch(() => undefined);
    }
    // A new document replaced every reference the plan was made against.
    if (watch.navigated() || left !== undefined) this.#bumpTargetVersion();
    const [firstBlocked] = watch.blocked();
    const leftNote =
      (left === undefined
        ? ""
        : `; the page ended on ${left.slice(0, 200)}, outside this profile's declared origins, and was taken back to a blank page`) +
      (firstBlocked === undefined
        ? ""
        : `; it tried to open ${firstBlocked}, outside this profile's declared origins, which was stopped before it left`);
    const unknown = (why: string): ActResult => {
      this.#unresolved.add(action.actionId);
      return {
        status: "unknown",
        verification: "not-observed",
        message: `click on ${elementRef} ${why}; the outcome is unknown and must be observed before retrying${leftNote}`,
        requiresReobservation: true,
        sentEffect,
      };
    };
    switch (answer.kind) {
      case "no-answer":
        return unknown(
          `sent ${String(answer.pending)} request(s) that had no answer after ${String(this.#answerTimeoutMs)} ms`,
        );
      case "failed":
        return unknown(`sent a request that broke after it left (${answer.reason.slice(0, 200)})`);
      case "answered": {
        const worst = Math.max(...answer.statuses);
        // A server error, or a timeout some server on the way answered with, does not say what the site kept.
        if (worst >= 500 || answer.statuses.includes(408)) {
          const status = worst >= 500 ? worst : 408;
          return unknown(`was answered with HTTP ${String(status)}, which does not say what was kept`);
        }
        if (worst >= 400) {
          return {
            status: "failed",
            verification: "observed-absent",
            message: `click on ${elementRef} was refused by the site with HTTP ${String(worst)}${leftNote}`,
            requiresReobservation: true,
            sentEffect,
          };
        }
        return {
          status: "applied",
          verification: "observed-applied",
          message: `click on ${elementRef} completed and the site answered (HTTP ${String(worst)})${leftNote}`,
          requiresReobservation: true,
          sentEffect,
        };
      }
      case "none": {
        const stillThere = left === undefined && (await locator.count()) > 0;
        return {
          status: "applied",
          verification: stillThere ? "observed-applied" : "not-observed",
          message: `click on ${elementRef} completed; it sent nothing that carries an effect${leftNote}`,
          requiresReobservation: left !== undefined,
          sentEffect: false,
        };
      }
    }
  }

  #bumpTargetVersion(): void {
    this.#targetVersion = `${Number.parseInt(this.#targetVersion, 10) + 1}`;
  }

  /**
   * Find the stamped reference for an element by its accessible name.
   *
   * A convenience for callers that plan in terms of what the user sees. It returns the
   * reference from the given observation, so a name that matches a different element after a
   * re-render simply will not be found and the caller re-observes.
   */
  async findRefByName(observation: Observation, name: string): Promise<string> {
    const page = await this.#ensurePage();
    const ref = await page.evaluate(
      (input: { attribute: string; wanted: string }) => {
        const nodes = [...document.querySelectorAll(`[${input.attribute}]`)];
        for (const node of nodes) {
          const element = node as HTMLElement;
          const label =
            element.getAttribute("aria-label") ??
            element.getAttribute("name") ??
            (element.textContent ?? "").trim();
          if (label.includes(input.wanted)) return element.getAttribute(input.attribute);
        }
        return null;
      },
      { attribute: REF_ATTRIBUTE, wanted: name },
    );
    if (ref === null) throw new Error(`no element matching "${name}" is present in this observation`);
    if (!observation.elementRefs.includes(ref)) {
      // A name that now resolves to a different element means the document moved on; the
      // caller must re-observe rather than act on a reference it never saw.
      throw new Error(
        `"${name}" now resolves to ${ref}, which is not part of observation ${observation.observationId}; observe again`,
      );
    }
    return ref;
  }

  /**
   * Close the browser, and for good: a start still under way is waited for and its browser closed, and nothing is
   * started afterwards. A closed driver is not reopened; a caller that needs a browser again makes a new driver.
   */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#launching?.catch(() => undefined);
    await this.#context?.close();
    this.#context = undefined;
    this.#page = undefined;
  }
}

/** Build a driver for a profile, or a refusal explaining why it cannot be used. */
export function createDriver(input: {
  profileName: string;
  nodeId: string;
  allowedOrigins: string[];
  profileDir: string;
  downloadRoot?: string;
  /** How long a click waits for the answers to what it sent before calling the outcome unknown. */
  answerTimeoutMs?: number;
  /** Chromium `--host-resolver-rules` entries (`MAP host address`) that pin where each named site is found. */
  hostResolverRules?: readonly string[];
}): { ok: true; driver: BrowserDriver } | { ok: false; refused: string } {
  for (const rule of input.hostResolverRules ?? []) {
    // One rule each, never a list smuggled into one: the switch takes a comma-separated list.
    if (!/^MAP [A-Za-z0-9.-]+ (?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9A-Fa-f:.]+\])$/u.test(rule)) {
      return { ok: false, refused: `${rule.slice(0, 120)} is not a host mapping this driver accepts` };
    }
  }
  const target = managedProfileDescriptor({
    profileName: input.profileName,
    nodeId: input.nodeId,
    allowedOrigins: input.allowedOrigins,
  });
  if ("refused" in target) return { ok: false, refused: target.refused };
  return {
    ok: true,
    driver: new BrowserDriver({
      profile: {
        target,
        allowedOrigins: input.allowedOrigins,
        ...(input.downloadRoot === undefined ? {} : { downloadRoot: input.downloadRoot }),
      },
      profileDir: input.profileDir,
      ...(input.answerTimeoutMs === undefined ? {} : { answerTimeoutMs: input.answerTimeoutMs }),
      ...(input.hostResolverRules === undefined ? {} : { hostResolverRules: input.hostResolverRules }),
    }),
  };
}

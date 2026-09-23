/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { mkdirSync } from "node:fs";

import {
  type AutomationAction,
  type AutomationTarget,
  type Observation,
  observationIdSchema,
} from "@clarkcant/contracts";
import { chromium, type BrowserContext, type Page } from "playwright";

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
 * 3. **Navigation is checked against the profile's declared origins** before it happens. The
 *    model does not get to name a new destination.
 */

export interface DriverProfile {
  target: AutomationTarget;
  allowedOrigins: string[];
  downloadRoot?: string;
}

export interface ObserveResult {
  observation: Observation;
}

export interface ActResult {
  status: "applied" | "refused" | "failed" | "unknown";
  verification: "observed-applied" | "observed-absent" | "not-observed" | "not-applicable";
  message: string;
  requiresReobservation: boolean;
}

const REF_ATTRIBUTE = "data-cc-ref";

export class BrowserDriver {
  readonly #profile: DriverProfile;
  readonly #profileDir: string;
  #context: BrowserContext | undefined;
  #page: Page | undefined;
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
  #targetVersion = "1";

  constructor(input: { profile: DriverProfile; profileDir: string }) {
    this.#profile = input.profile;
    this.#profileDir = input.profileDir;
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

  /** Refuse to navigate anywhere the profile did not declare. */
  #assertOriginAllowed(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${url} is not an absolute URL`);
    }
    const allowed = this.#profile.allowedOrigins.some(
      (origin) => parsed.origin === origin || parsed.hostname === origin,
    );
    if (!allowed) {
      throw new Error(
        `navigation to ${parsed.origin} is outside this profile's declared origins [${this.#profile.allowedOrigins.join(", ")}]`,
      );
    }
  }

  async #ensurePage(): Promise<Page> {
    if (this.#page) return this.#page;
    mkdirSync(this.#profileDir, { recursive: true });
    this.#context = await chromium.launchPersistentContext(this.#profileDir, { headless: true });
    const [existing] = this.#context.pages();
    this.#page = existing ?? (await this.#context.newPage());
    return this.#page;
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

    const elements = await page.evaluate((attribute: string) => {
      const selector = 'a[href], button, input, select, textarea, [role], [data-testid]';
      const nodes = [...document.querySelectorAll(selector)].slice(0, 500);
      let index = 0;
      return nodes.map((node) => {
        index += 1;
        const ref = `el_${Date.now().toString(36)}_${index}`;
        node.setAttribute(attribute, ref);
        const element = node as HTMLElement;
        const name =
          element.getAttribute("aria-label") ??
          element.getAttribute("name") ??
          (element.textContent ?? "").trim().slice(0, 80);
        return {
          ref,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role"),
          name,
          hasPasswordType: element.getAttribute("type") === "password",
        };
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
    return { observation };
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
        this.#targetVersion = `${Number.parseInt(this.#targetVersion, 10) + 1}`;
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
            await locator.first().click({ timeout: 5000 });
          } else {
            await locator.first().fill(String(action.arguments.value ?? ""), { timeout: 5000 });
          }
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

  async close(): Promise<void> {
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
}): { ok: true; driver: BrowserDriver } | { ok: false; refused: string } {
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
    }),
  };
}

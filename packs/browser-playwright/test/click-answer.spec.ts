import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { observationIdSchema, type AutomationAction } from "@clarkcant/contracts";

import { createDriver, type BrowserDriver, type ObserveResult } from "../src/driver.ts";

/**
 * A click's outcome is what its submission was answered with.
 *
 * A plain form POST, or a script's `fetch`, hands control back the moment the browser dispatched it. The click has
 * "completed" while the submission is still on its way, so a server that never answers must not read as done: that is
 * the lost submit a retry would send twice. These pages submit to a server that answers, refuses, errs, or never
 * answers at all, and one links to an origin the profile never declared.
 */

const ANSWER_TIMEOUT_MS = 1500;

function page(body: string): string {
  return `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`;
}

const PAGES: Record<string, string> = {
  "/form-hang": page(`<form method="post" action="/hang"><input name="q" value="x"><button>Send application</button></form>`),
  "/form-ok": page(`<form method="post" action="/ok"><input name="q" value="x"><button>Send application</button></form>`),
  "/form-refused": page(`<form method="post" action="/refused"><button>Send application</button></form>`),
  "/form-error": page(`<form method="post" action="/error"><button>Send application</button></form>`),
  "/form-timeout": page(`<form method="post" action="/timeout"><button>Send application</button></form>`),
  "/fetch-ok": page(
    `<button id="go" type="button">Save by script</button><p id="out"></p><script>document.querySelector("#go").addEventListener("click", () => { fetch("/saved", { method: "POST", body: "x" }).then(() => { document.querySelector("#out").textContent = "saved"; }); });</script>`,
  ),
  "/fetch-hang": page(
    `<button id="go" type="button">Send by script</button><script>document.querySelector("#go").addEventListener("click", () => { fetch("/hang", { method: "POST", body: "x" }).catch(() => undefined); });</script>`,
  ),
  "/quiet": page(`<button type="button" id="noop">Show more</button><a href="/ok-page">Next page</a>`),
  "/ok-page": page(`<p>next</p>`),
};

let server: Server;
let other: Server;
let origin: string;
let otherOrigin: string;
let dir: string;
const hits: Record<string, number> = {};

function listen(target: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", () => {
      const address = target.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port assigned"));
        return;
      }
      resolve(`http://127.0.0.1:${String(address.port)}`);
    });
  });
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    hits[path] = (hits[path] ?? 0) + 1;
    request.resume();
    if (path === "/hang") return; // never answered: the lost response
    if (path === "/ok") {
      response.writeHead(303, { location: "/ok-page" }).end();
      return;
    }
    if (path === "/refused") {
      response.writeHead(422, { "content-type": "text/html" }).end(page("<p>invalid</p>"));
      return;
    }
    if (path === "/error") {
      response.writeHead(500, { "content-type": "text/html" }).end(page("<p>error</p>"));
      return;
    }
    if (path === "/timeout") {
      response.writeHead(408, { "content-type": "text/html" }).end(page("<p>timeout</p>"));
      return;
    }
    if (path === "/saved") {
      response.writeHead(204).end();
      return;
    }
    if (path === "/redirect-away") {
      response.writeHead(302, { location: `${otherOrigin}/landing` }).end();
      return;
    }
    const away: Record<string, string> = {
      "/elsewhere": page(`<a href="${otherOrigin}/landing">Leave for another site</a>`),
      "/script-away": page(
        `<button type="button" id="go">Continue</button><script>document.querySelector("#go").addEventListener("click", () => { location.href = "${otherOrigin}/landing"; });</script>`,
      ),
      "/popup": page(
        `<button type="button" id="go">Open offer</button><script>document.querySelector("#go").addEventListener("click", () => { window.open("${otherOrigin}/landing"); window.open("/ok-page"); });</script>`,
      ),
      "/frame-away": page(`<p>framed</p><iframe src="${otherOrigin}/landing"></iframe>`),
    };
    const html = away[path] ?? PAGES[path];
    if (html === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" }).end(html);
  });
  other = createServer((request, response) => {
    hits["other"] = (hits["other"] ?? 0) + 1;
    request.resume();
    response.writeHead(200, { "content-type": "text/html" }).end(page("<p>elsewhere</p>"));
  });
  origin = await listen(server);
  otherOrigin = await listen(other);
  dir = mkdtempSync(join(tmpdir(), "clarkcant-click-answer-"));
});

afterAll(async () => {
  server.closeAllConnections();
  other.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => other.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function action(driver: BrowserDriver, observed: ObserveResult, overrides: Partial<AutomationAction>): AutomationAction {
  return {
    actionId: `act_${Math.random().toString(36).slice(2, 8)}`,
    targetId: driver.target.targetId,
    observationId: observationIdSchema.parse(observed.observation.observationId),
    leaseEpoch: driver.leaseEpoch,
    operation: "click",
    arguments: {},
    expectedTargetVersion: driver.targetVersion,
    consequential: true,
    ...overrides,
  };
}

async function onPage<T>(path: string, fn: (driver: BrowserDriver, observed: ObserveResult) => Promise<T>): Promise<T> {
  for (const key of Object.keys(hits)) delete hits[key];
  const created = createDriver({
    profileName: `answer-${Math.random().toString(36).slice(2, 9)}`,
    nodeId: "node_test",
    allowedOrigins: [origin],
    profileDir: join(dir, `profile-${Math.random().toString(36).slice(2)}`),
    answerTimeoutMs: ANSWER_TIMEOUT_MS,
  });
  if (!created.ok) throw new Error(created.refused);
  const driver = created.driver;
  try {
    driver.startLease();
    const navigated = await driver.act(
      {
        actionId: "nav",
        targetId: driver.target.targetId,
        observationId: observationIdSchema.parse("obs_none"),
        leaseEpoch: driver.leaseEpoch,
        operation: "navigate",
        arguments: { url: `${origin}${path}` },
        expectedTargetVersion: driver.targetVersion,
        consequential: false,
      },
      { approvalGranted: false },
    );
    if (navigated.status !== "applied") throw new Error(`the fixture did not load: ${navigated.message}`);
    return await fn(driver, await driver.observe());
  } finally {
    await driver.close();
  }
}

function refOf(observed: ObserveResult, name: string): string {
  const element = observed.elements.find((candidate) => candidate.name.includes(name));
  if (element === undefined) throw new Error(`no element named "${name}"`);
  return element.ref;
}

describe("a click is judged by the answer to what it sent", () => {
  it("calls a form POST the server never answers unknown, and blocks sending it again until the page is observed", async () => {
    await onPage("/form-hang", async (driver, observed) => {
      const first = action(driver, observed, { arguments: { elementRef: refOf(observed, "Send application") } });
      const result = await driver.act(first, { approvalGranted: true });
      // Either the click waited on the navigation and ran out of time, or it returned and the answer never came: both
      // are a submission that left and was never answered, and neither may read as done.
      expect(result.status).toBe("unknown");
      expect(result.message).toContain("must be observed before retrying");
      expect(result.sentEffect).toBe(true);
      expect(hits["/hang"]).toBe(1);

      const again = await driver.act(first, { approvalGranted: true });
      expect(again.status).toBe("refused");
      expect(hits["/hang"]).toBe(1);
    });
  }, 60_000);

  it("calls a script's fetch the server never answers unknown", async () => {
    await onPage("/fetch-hang", async (driver, observed) => {
      const result = await driver.act(
        action(driver, observed, { arguments: { elementRef: refOf(observed, "Send by script") } }),
        { approvalGranted: true },
      );
      expect(result.status).toBe("unknown");
      expect(hits["/hang"]).toBe(1);
    });
  }, 60_000);

  it("calls an answered submission applied, and the page it landed on a new document", async () => {
    await onPage("/form-ok", async (driver, observed) => {
      const version = driver.targetVersion;
      const result = await driver.act(
        action(driver, observed, { arguments: { elementRef: refOf(observed, "Send application") } }),
        { approvalGranted: true },
      );
      expect(result.status).toBe("applied");
      expect(result.verification).toBe("observed-applied");
      expect(hits["/ok"]).toBe(1);
      expect(driver.targetVersion).not.toBe(version);
    });
  }, 60_000);

  it("calls a client error refused by the site, and a server error unknown", async () => {
    await onPage("/form-refused", async (driver, observed) => {
      const result = await driver.act(
        action(driver, observed, { arguments: { elementRef: refOf(observed, "Send application") } }),
        { approvalGranted: true },
      );
      expect(result.status).toBe("failed");
      expect(result.message).toContain("422");
    });
    await onPage("/form-error", async (driver, observed) => {
      const result = await driver.act(
        action(driver, observed, { arguments: { elementRef: refOf(observed, "Send application") } }),
        { approvalGranted: true },
      );
      expect(result.status).toBe("unknown");
      expect(result.message).toContain("500");
    });
    await onPage("/form-timeout", async (driver, observed) => {
      const result = await driver.act(
        action(driver, observed, { arguments: { elementRef: refOf(observed, "Send application") } }),
        { approvalGranted: true },
      );
      expect(result.status).toBe("unknown");
      expect(result.message).toContain("408");
    });
  }, 60_000);

  it("says a click nobody marked as submitting sent something, when it did", async () => {
    await onPage("/fetch-ok", async (driver, observed) => {
      const element = observed.elements.find((candidate) => candidate.name.includes("Save by script"));
      expect(element?.submits).toBe(false);
      const result = await driver.act(
        action(driver, observed, { consequential: false, arguments: { elementRef: element?.ref ?? "" } }),
        { approvalGranted: false },
      );
      expect(result.status, result.message).toBe("applied");
      expect(result.sentEffect).toBe(true);
      expect(hits["/saved"]).toBe(1);
    });
  }, 60_000);

  it("stops a link to an undeclared origin before anything is sent there", async () => {
    await onPage("/elsewhere", async (driver, observed) => {
      const result = await driver.act(
        action(driver, observed, {
          consequential: false,
          arguments: { elementRef: refOf(observed, "Leave for another site") },
        }),
        { approvalGranted: false },
      );
      expect(result.status).toBe("refused");
      expect(result.message).toContain("outside this profile's declared origins");
      expect(hits["other"]).toBeUndefined();
    });
  }, 60_000);

  it("stops a script taking the page to an undeclared origin, and says so", async () => {
    await onPage("/script-away", async (driver, observed) => {
      const result = await driver.act(
        action(driver, observed, { consequential: false, arguments: { elementRef: refOf(observed, "Continue") } }),
        { approvalGranted: false },
      );
      expect(result.status, result.message).toBe("applied");
      expect(result.sentEffect).toBe(false);
      expect(result.message).toContain("which was stopped before it left");
      expect(hits["other"]).toBeUndefined();
      expect((await driver.observe()).url).toBe(`${origin}/script-away`);
    });
  }, 60_000);

  it("opens no pop-up a script asks for, on any site", async () => {
    await onPage("/popup", async (driver, observed) => {
      const result = await driver.act(
        action(driver, observed, { consequential: false, arguments: { elementRef: refOf(observed, "Open offer") } }),
        { approvalGranted: false },
      );
      expect(result.status, result.message).toBe("applied");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(hits["other"]).toBeUndefined();
      expect(hits["/ok-page"]).toBeUndefined();
      expect((await driver.observe()).url).toBe(`${origin}/popup`);
    });
  }, 60_000);

  it("loads no frame from an undeclared origin", async () => {
    await onPage("/frame-away", async (_driver, observed) => {
      expect(observed.url).toBe(`${origin}/frame-away`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(hits["other"]).toBeUndefined();
    });
  }, 60_000);

  it("refuses an address the server redirects to an undeclared origin, and sends nothing there", async () => {
    for (const key of Object.keys(hits)) delete hits[key];
    const created = createDriver({
      profileName: "redirect-away",
      nodeId: "node_test",
      allowedOrigins: [origin],
      profileDir: join(dir, "profile-redirect-away"),
    });
    if (!created.ok) throw new Error(created.refused);
    const driver = created.driver;
    try {
      driver.startLease();
      const result = await driver.act(
        {
          actionId: "nav_away",
          targetId: driver.target.targetId,
          observationId: observationIdSchema.parse("obs_none"),
          leaseEpoch: driver.leaseEpoch,
          operation: "navigate",
          arguments: { url: `${origin}/redirect-away` },
          expectedTargetVersion: driver.targetVersion,
          consequential: false,
        },
        { approvalGranted: false },
      );
      expect(result.status).toBe("refused");
      expect(hits["/redirect-away"]).toBe(1);
      expect(hits["other"]).toBeUndefined();
      // Wherever the refused load left the page, it is not on the other site: an observation finds it on neither.
      const after = (await driver.observe()).url;
      expect(after.startsWith(otherOrigin)).toBe(false);
      expect(after === "about:blank" || after.startsWith(origin), after).toBe(true);
    } finally {
      await driver.close();
    }
  }, 60_000);

  it("takes a host mapping only in the one form it passes to the browser", () => {
    const base = { profileName: "mapped", nodeId: "node_test", allowedOrigins: [origin], profileDir: join(dir, "profile-mapped") };
    expect(createDriver({ ...base, hostResolverRules: ["MAP shop.example 93.184.216.34", "MAP v6.example [2606:4700::1111]"] }).ok).toBe(true);
    for (const rule of ["MAP * 127.0.0.1", "MAP a.example 1.2.3.4,MAP b.example 127.0.0.1", "EXCLUDE shop.example"]) {
      const made = createDriver({ ...base, hostResolverRules: [rule] });
      expect(made.ok, rule).toBe(false);
    }
  });

  it("reports a click that sent nothing as applied without waiting out the deadline", async () => {
    await onPage("/quiet", async (driver, observed) => {
      const started = Date.now();
      const result = await driver.act(
        action(driver, observed, { consequential: false, arguments: { elementRef: refOf(observed, "Show more") } }),
        { approvalGranted: false },
      );
      expect(result.status).toBe("applied");
      expect(result.sentEffect).toBe(false);
      expect(Date.now() - started).toBeLessThan(ANSWER_TIMEOUT_MS);
    });
  }, 60_000);

  it("names what each reference is and which of them submit", async () => {
    await onPage("/form-ok", async (_driver, observed) => {
      const button = observed.elements.find((element) => element.name.includes("Send application"));
      const input = observed.elements.find((element) => element.tag === "input");
      expect(button?.submits).toBe(true);
      expect(input?.submits).toBe(false);
      expect(observed.url).toBe(`${origin}/form-ok`);
      expect(observed.title).toBe("Fixture");
      expect(observed.observation.elementRefs).toEqual(observed.elements.map((element) => element.ref));
    });
    await onPage("/quiet", async (_driver, observed) => {
      const link = observed.elements.find((element) => element.name.includes("Next page"));
      const plain = observed.elements.find((element) => element.name.includes("Show more"));
      expect(link?.submits).toBe(false);
      expect(plain?.submits).toBe(false);
    });
  }, 60_000);
});

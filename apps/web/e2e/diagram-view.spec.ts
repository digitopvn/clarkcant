import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("no local token");
  return parsed.localToken;
}

function authorized(): Record<string, string> {
  return { authorization: `Bearer ${token()}` };
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

async function say(page: Page, text: string): Promise<void> {
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill(text);
  await composer.press("Enter");
}

async function conversationId(page: Page): Promise<string> {
  const stored = await page.evaluate(() => sessionStorage.getItem("cc_conversation"));
  if (stored === null || stored === "") throw new Error("the app has not selected a conversation");
  return stored;
}

async function heldState(page: Page, conversation: string, instanceId: string): Promise<unknown> {
  const response = await page.request.get(`${GATEWAY}/conversations/${encodeURIComponent(conversation)}/timeline?after=0`, { headers: authorized() });
  expect(response.ok(), "the node gives the conversation timeline").toBe(true);
  const timeline = (await response.json()) as { instances?: { instanceId: string; state?: unknown }[] };
  return timeline.instances?.find((instance) => instance.instanceId === instanceId)?.state ?? {};
}

async function instanceOf(diagram: Locator): Promise<string> {
  const id = await diagram.evaluate((element) => element.closest("[data-widget-instance]")?.getAttribute("data-widget-instance") ?? "");
  expect(id, "the diagram is drawn for a saved widget instance").not.toBe("");
  return id;
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/**
 * Everything in the drawn diagram that could run, load or link: a script, a foreignObject, an embedded document or image,
 * an attribute that is an event handler, a link or a source, and a url() that points anywhere but a marker in the page.
 */
async function unsafeMarkup(diagram: Locator): Promise<string[]> {
  return diagram.evaluate((root) => {
    const found: string[] = [];
    for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
      const tag = element.tagName.toLowerCase();
      if (["script", "foreignobject", "iframe", "object", "embed", "img", "image", "use", "a", "style", "link"].includes(tag)) found.push(`<${tag}>`);
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith("on")) found.push(`${tag}[${name}]`);
        if (name === "href" || name === "xlink:href" || name === "src" || name === "srcset") found.push(`${tag}[${name}]`);
        if (/url\(\s*["']?(?!#)/iu.test(attribute.value)) found.push(`${tag}[${name}=${attribute.value.slice(0, 40)}]`);
      }
    }
    return found;
  });
}

test("the conversation diagram is drawn without script, moves along its edges by keyboard and keeps its selection", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openApp(page);
  await say(page, "đặt sơ đồ");

  const diagram = page.locator(".cc-diagram-root").last();
  await expect(diagram).toBeVisible({ timeout: 20_000 });
  const node = (id: string): Locator => diagram.locator(`[data-diagram-node='${id}']`);
  await expect(diagram.locator("[data-diagram-node]")).toHaveCount(6);
  await expect(diagram.locator("[data-diagram-node][tabindex='0']")).toHaveCount(1);
  expect(await unsafeMarkup(diagram)).toEqual([]);

  // A screen reader hears each node with the nodes it leads to and comes from.
  await expect(node("test")).toHaveAttribute("role", "button");
  const testName = (await node("test").getAttribute("aria-label")) ?? "";
  expect(testName).toContain("Kiểm thử đạt?");
  expect(testName).toContain("Tích hợp liên tục");
  for (const neighbour of ["Phát hành", "Sửa lỗi", "Xây dựng"]) expect(testName).toContain(neighbour);
  await expect(diagram.locator("svg")).toHaveAttribute("aria-describedby", /.+/u);

  // The keys follow the edges: down along the flow, up against it, Home and End to the ends.
  await node("plan").focus();
  await page.keyboard.press("ArrowDown");
  await expect(node("build")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(node("test")).toBeFocused();
  const ring = await node("test").locator(".cc-diagram-focus-ring").evaluate((element) => getComputedStyle(element).stroke);
  expect(ring, "the focused node shows a focus ring").not.toMatch(/^(none|transparent|rgba\(0, 0, 0, 0\))$/u);
  await page.keyboard.press("ArrowUp");
  await expect(node("build")).toBeFocused();
  await page.keyboard.press("End");
  await expect(node("docs")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(node("plan")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(node("test")).toBeFocused();

  // Selecting a node lights its edges and neighbours and is kept by the node.
  await page.keyboard.press("Enter");
  await expect(node("test")).toHaveAttribute("aria-pressed", "true");
  await expect(diagram.locator("[data-neighbour='true']")).toHaveCount(3);
  await expect(diagram.locator("[data-diagram-edge][data-lit='true']")).toHaveCount(3);
  await expect(diagram.locator("[data-diagram-selected-node='test']")).toBeVisible();
  const instanceId = await instanceOf(diagram);
  const conversation = await conversationId(page);
  await expect.poll(() => heldState(page, conversation, instanceId), { timeout: 10_000 }).toEqual({ selectedId: "test" });

  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  const restored = page.locator(".cc-diagram-root").last();
  await expect(restored.locator("[data-diagram-node='test']")).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
  await restored.locator("[data-diagram-node='test']").focus();
  await page.keyboard.press("Escape");
  await expect(restored.locator("[data-diagram-node='test']")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => heldState(page, conversation, instanceId), { timeout: 10_000 }).toEqual({});

  const motion = await restored.locator("[data-diagram-node='plan']").evaluate((element) => {
    const style = getComputedStyle(element);
    return { animation: style.animationName, transition: style.transitionDuration };
  });
  expect(motion.animation).toBe("none");
  expect(motion.transition.split(",").every((part) => Number.parseFloat(part) === 0)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("diagram-1280-dark.png"), fullPage: false });

  // On a phone the drawing keeps its size and scrolls inside its card; the page itself does not scroll sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  const scroller = restored.locator("[data-diagram-scroll]");
  const darkFill = await restored.locator("[data-diagram-node='plan'] .cc-diagram-shape").evaluate((element) => getComputedStyle(element).fill);
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"))).toBe(scheme);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    const sizes = await scroller.evaluate((element) => {
      const svg = element.querySelector("svg");
      return {
        drawn: svg?.getBoundingClientRect().width ?? 0,
        laidOut: Number(svg?.getAttribute("width") ?? "0"),
        scroll: element.scrollWidth,
        client: element.clientWidth,
        right: element.getBoundingClientRect().right,
      };
    });
    // The drawing keeps its laid-out size (labels stay readable) and whatever does not fit scrolls inside the card.
    expect(sizes.drawn).toBeCloseTo(sizes.laidOut, 0);
    expect(sizes.right).toBeLessThanOrEqual(390);
    expect(sizes.scroll).toBeGreaterThanOrEqual(Math.min(sizes.laidOut, sizes.client));
    await page.screenshot({ path: testInfo.outputPath(`diagram-390-${scheme}.png`), fullPage: false });
  }
  const lightFill = await restored.locator("[data-diagram-node='plan'] .cc-diagram-shape").evaluate((element) => getComputedStyle(element).fill);
  expect(lightFill, "the shapes follow the theme").not.toBe(darkFill);
  expect(dialogs).toEqual([]);
});

test("labels shaped like markup are drawn as text, with nothing that runs or loads", async ({ page }) => {
  test.setTimeout(60_000);
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await openApp(page);
  // Anything the drawing loads after this point, a label naming `x` as an image source included, is a request.
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol !== "data:" && !(url.pathname.startsWith("/conversations") || url.pathname.startsWith("/events") || url.pathname.startsWith("/widgets"))) requests.push(request.url());
  });
  await say(page, "đặt sơ đồ chữ như mã");
  const diagram = page.locator(".cc-diagram-root").last();
  await expect(diagram.locator("[data-diagram-node='script']")).toBeVisible({ timeout: 20_000 });
  expect(await unsafeMarkup(diagram)).toEqual([]);
  await expect(diagram.locator("[data-diagram-node='link']")).toHaveText("javascript:alert(1)");
  await expect(diagram.locator("[data-diagram-node='img']")).toHaveAttribute("aria-label", /<img src=x onerror=alert\(1\)>/u);
  await expect(diagram.locator(".cc-diagram-edge-label text")).toHaveText("<b>onclick</b>");
  await diagram.locator("[data-diagram-node='link']").click();
  await expect(diagram.locator("[data-diagram-node='link']")).toHaveAttribute("aria-pressed", "true");
  expect(dialogs).toEqual([]);
  expect(requests.filter((url) => /\/x$|alert/u.test(url))).toEqual([]);
});

test("a Mermaid flowchart is read on the node and drawn by the same renderer", async ({ page }) => {
  test.setTimeout(60_000);
  await openApp(page);
  await say(page, "đặt sơ đồ mermaid");
  const diagram = page.locator(".cc-diagram-root").last();
  await expect(diagram.locator("[data-diagram-node='review']")).toBeVisible({ timeout: 20_000 });
  await expect(diagram).toHaveAttribute("data-diagram-direction", "LR");
  await expect(diagram.locator("[data-diagram-node='review']")).toHaveAttribute("data-shape", "diamond");
  await expect(diagram.locator("[data-diagram-node='publish']")).toHaveAttribute("data-shape", "circle");
  await expect(diagram.locator("svg")).toHaveAttribute("aria-label", /Luồng duyệt/u);
  expect(await unsafeMarkup(diagram)).toEqual([]);
  // Left to right, the flow runs along Right.
  await diagram.locator("[data-diagram-node='draft']").focus();
  await page.keyboard.press("ArrowRight");
  await expect(diagram.locator("[data-diagram-node='review']")).toBeFocused();
});

test("the diagram refuses malformed graphs and forbidden Mermaid with the host's reason", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  const before = await page.locator(".cc-diagram-root").count();
  const cases: [string, RegExp][] = [
    ["trùng", /node ids repeat: plan/u],
    ["thiếu nút", /names "archive", which is not a node/u],
    ["quá lớn", /61 nodes; at most 60 are drawn/u],
    ["ký tự ẩn", /U\+202E/u],
    ["mermaid click", /"click" is not read/u],
    ["mermaid html", /holds HTML; labels are plain text/u],
  ];
  for (const [variant, reason] of cases) {
    await say(page, `đặt sơ đồ ${variant}`);
    await expect(page.getByText(reason).last()).toBeVisible({ timeout: 20_000 });
  }
  await expect(page.locator(".cc-diagram-root")).toHaveCount(before);
});

test("the Widget Library previews the diagram fixture with the production renderer", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await expect(page.locator("#cc-tab-developer")).toBeVisible({ timeout: 20_000 });
  await page.locator("#cc-tab-developer").click();
  await page.locator("[data-widget-library-open='develop']").click();
  await page.locator("[data-widget-card='canvas.diagram@1']").click();
  const preview = page.locator("[data-widget-preview='canvas.diagram@1']");
  const diagram = preview.locator(".cc-diagram-root");
  await expect(diagram).toBeVisible({ timeout: 20_000 });
  await expect(diagram.locator("[data-diagram-node='test']")).toHaveAttribute("aria-pressed", "true");
  expect(await unsafeMarkup(diagram)).toEqual([]);
  await page.locator("[data-widget-lab-fixture='true']").selectOption("diagram.empty");
  await expect(preview.locator("[data-diagram-empty='true']")).toBeVisible();
  await page.locator("[data-widget-lab-fixture='true']").selectOption("diagram.normal");
  await expect(diagram.locator("[data-diagram-node='plan']")).toBeVisible();
  await diagram.locator("[data-diagram-node='plan']").focus();
  await page.keyboard.press("ArrowDown");
  await expect(diagram.locator("[data-diagram-node='build']")).toBeFocused();

  await page.locator("[data-widget-lab-viewport='true']").selectOption("320");
  const frame = page.locator("[data-widget-preview-frame]");
  await expect(frame).toHaveCSS("width", "320px");
  await page.locator("[data-widget-lab-theme='true']").selectOption("dark");
  await expect(frame).toHaveAttribute("data-cc-theme", "dark");
  await page.locator("[data-widget-lab-reduced-motion='true']").check();
  await expect(frame).toHaveAttribute("data-cc-reduced-motion", "true");
  await page.screenshot({ path: testInfo.outputPath("diagram-library-dark-narrow.png") });
});

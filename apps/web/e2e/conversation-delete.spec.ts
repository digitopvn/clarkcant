import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { DEFAULT_EXECUTION_POLICY_CONFIG } from "@clarkcant/contracts";

const port = process.env.CC_E2E_NODE_PORT;
if (!port) throw new Error("CC_E2E_NODE_PORT is required");
const gateway = `http://127.0.0.1:${port}`;
const evidence = join(process.cwd(), "plans", "reports", "evidence", "343");
function headers() {
  const identity = JSON.parse(readFileSync(join(process.cwd(), ".data", "e2e", "identity.json"), "utf8")) as {localToken: string};
  return {authorization: `Bearer ${identity.localToken}`};
}
async function setPolicy(request: APIRequestContext, mode: "guarded" | "autonomous") {
  const result = await request.put(`${gateway}/preferences/execution.policy`, {headers: headers(), data: {value: {...DEFAULT_EXECUTION_POLICY_CONFIG, mode}}});
  expect(result.ok()).toBe(true);
}
async function say(page: Page, text: string) {
  await page.locator("[data-composer]").fill(text);
  await page.locator("[data-composer]").press("Enter");
}
async function open(page: Page) {
  const auth = headers().authorization.slice(7);
  await page.goto(`/?token=${auth}&gateway=${encodeURIComponent(gateway)}`);
  await expect(page.locator("[data-composer]")).toBeVisible();
  await page.locator("[data-attachment-input]").setInputFiles({name: "delete-me.txt", mimeType: "text/plain", buffer: Buffer.from("a real attachment to release")});
  await expect(page.locator("[data-attachment-chip]")).toHaveCount(1);
  await say(page, "mở settings");
  await expect(page.getByRole("dialog", {name: "Cài đặt"})).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", {name: "Cài đặt"})).toHaveCount(0);
  const id = await page.evaluate(() => sessionStorage.getItem("cc_conversation"));
  if (!id) throw new Error("no conversation");
  return id;
}

test.afterEach(async ({request}) => {
  await setPolicy(request, "autonomous");
  expect((await request.put(`${gateway}/preferences/experience.language`, {headers: headers(), data: {value: "vi"}})).ok()).toBe(true);
});

for (const width of [1280, 390]) for (const colorScheme of ["light", "dark"] as const) {
  test(`policy asks, keeps on decline and deletes once approved at ${width} ${colorScheme}`, async ({page, request}) => {
    mkdirSync(evidence, {recursive: true});
    await page.setViewportSize({width, height: 844});
    await page.emulateMedia({colorScheme, reducedMotion: "reduce"});
    await setPolicy(request, "guarded");
    const id = await open(page);
    await say(page, "xoá hội thoại này");
    const question = page.getByRole("region", {name: "Policy yêu cầu xác nhận xoá"});
    await expect(question).toBeVisible();
    expect(await question.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
    await expect(question).toContainText("Không thể Hoàn tác");
    await expect(question.getByRole("button")).toHaveCount(2);
    expect((await request.get(`${gateway}/conversations/${id}/timeline`, {headers: headers()})).ok()).toBe(true);
    await question.getByRole("button", {name: "Giữ hội thoại"}).click();
    await expect(question).toHaveCount(0);
    expect((await request.get(`${gateway}/conversations/${id}/timeline`, {headers: headers()})).ok()).toBe(true);
    await say(page, "xoá hội thoại này");
    await expect(question).toBeVisible();
    const approve = question.getByRole("button", {name: "Xoá hội thoại"});
    await approve.focus();
    await expect(approve).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.screenshot({path: join(evidence, `delete-question-${width}-${colorScheme}.png`)});
    await approve.press("Enter");
    await expect(question).toHaveCount(0);
    await expect(page.locator("[data-intent-notice]")).toContainText("Đã xoá hội thoại, 1 tệp đính kèm");
    expect((await request.get(`${gateway}/conversations/${id}/timeline`, {headers: headers()})).status()).toBe(404);
    expect(await page.evaluate(() => sessionStorage.getItem("cc_conversation"))).toBeNull();
    await page.screenshot({path: join(evidence, `delete-result-${width}-${colorScheme}.png`)});
    await page.reload();
    await expect(page.locator("[data-composer]")).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("cc_conversation"))).toBeNull();
    await say(page, "mở settings");
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("cc_conversation"))).not.toBeNull();
    expect(await page.evaluate(() => sessionStorage.getItem("cc_conversation"))).not.toBe(id);
  });
}

test("an explicit English request in autonomous mode deletes without adding a confirmation", async ({page, request}) => {
  await setPolicy(request, "autonomous");
  const id = await open(page);
  expect((await request.put(`${gateway}/preferences/experience.language`, {headers: headers(), data: {value: "en"}})).ok()).toBe(true);
  await page.reload();
  await expect(page.locator("[data-composer]")).toBeVisible();
  await say(page, "delete this conversation");
  await expect(page.locator("[data-intent-notice]")).toContainText("Deleted the conversation, 1 attachment");
  await expect(page.locator(".cc-delete-question")).toHaveCount(0);
  expect((await request.get(`${gateway}/conversations/${id}/timeline`, {headers: headers()})).status()).toBe(404);
});

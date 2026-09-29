import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * The generic action button, pressed for each kind of action the host can bind it to.
 *
 * The button is placed through the view a model's `show_view` uses, so the action is compiled by the host and the
 * button learns only its label. What a press does is then the host's: a `view` binding pins, an `agent` binding starts
 * a turn whose message is the label — with context the host read from its own records when the button names some — an
 * `invoke` binding calls the notes package's service in its container and can be stopped while it waits, and a
 * `workflow` binding runs its steps through that same service, each through the same gate.
 *
 * Needs a container engine that runs Linux containers for the `invoke` case, like the service-facet journey.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const PACKAGE = "com.example.notes";
const LIST = "com.example.notes.list@1";

function identity(): { token: string; nodeId: string } {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown; nodeId?: unknown };
  if (typeof parsed.localToken !== "string" || typeof parsed.nodeId !== "string") throw new Error("no identity");
  return { token: parsed.localToken, nodeId: parsed.nodeId };
}

function headers(): Record<string, string> {
  return { authorization: `Bearer ${identity().token}` };
}

async function install(request: APIRequestContext): Promise<void> {
  const listed = (await (await request.get(`${GATEWAY}/packages`, { headers: headers() })).json()) as {
    packages: { packageId: string }[];
  };
  if (listed.packages.some((entry) => entry.packageId === PACKAGE)) return;
  const installed = await request.post(`${GATEWAY}/packages/install`, {
    headers: headers(),
    data: { packageId: PACKAGE, version: "1.0.0", localDigest: "sha256:notes-service-digest" },
  });
  expect(installed.ok(), `install answered ${String(installed.status())}: ${await installed.text()}`).toBe(true);
}

/** Wait until the node says the notes service can answer; the first start fetches an image, which is slow. */
async function serviceReady(request: APIRequestContext): Promise<void> {
  await expect
    .poll(
      async () => {
        const listed = (await (await request.get(`${GATEWAY}/capabilities`, { headers: headers() })).json()) as {
          capabilities: { ref: string; usable: boolean }[];
        };
        return listed.capabilities.find((entry) => entry.ref === LIST)?.usable === true;
      },
      { timeout: 180_000, intervals: [1_000] },
    )
    .toBe(true);
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${identity().token}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

async function say(page: Page, text: string): Promise<void> {
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill(text);
  await composer.press("Enter");
}

/** Ask the fixture model to place a button of one kind, and return the newest button in the conversation. */
async function place(page: Page, kind: "view" | "agent" | "invoke" | "workflow" | "chậm" | `agent ngữ cảnh ${string}`): Promise<Locator> {
  const before = await page.locator("[data-action-widget]").count();
  await say(page, `đặt nút ${kind}`);
  await expect(page.locator("[data-action-widget]")).toHaveCount(before + 1, { timeout: 20_000 });
  // By position, not `.last()`: a later button must not move this locator onto itself.
  return page.locator("[data-action-widget]").nth(before);
}

/** Tag and attribute names only: what a button looks like structurally, with everything its props say removed. */
async function shape(widget: Locator): Promise<string> {
  return widget.evaluate((root) => {
    const walk = (element: Element): string =>
      `<${element.tagName.toLowerCase()} ${element
        .getAttributeNames()
        .filter((name) => name !== "d")
        .sort()
        .join(" ")}>${Array.from(element.children).map(walk).join("")}`;
    return walk(root);
  });
}

function serviceContainers(): string[] {
  const listed = execFileSync("docker", ["ps", "--quiet", "--filter", `label=clarkcant.node=${identity().nodeId}`], {
    encoding: "utf8",
  });
  return listed.split(/\s+/).filter((id) => id !== "");
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  await install(request);
  await serviceReady(request);
});

test("an agent button starts a turn whose message is exactly its label", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page);
  const button = await place(page, "agent");
  await expect(button).toHaveAttribute("data-action-actionable", "true");

  await button.getByRole("button", { name: "Tóm tắt cuộc trò chuyện" }).click();

  // The person's side of the conversation says what the button said, and nothing else.
  await expect(page.locator("[data-role='user'] [data-bubble='user']").last()).toHaveText("Tóm tắt cuộc trò chuyện", {
    timeout: 30_000,
  });
  // The reply is the turn's own, and it quotes the request the button was made with: the intent reached the model.
  const reply = page.locator("[data-role='assistant']").last();
  await expect(reply).toContainText('đã nhận yêu cầu từ nút "Tóm tắt cuộc trò chuyện"');
  await expect(reply).toContainText("Tóm tắt cuộc trò chuyện này trong ba dòng.");
  // The button says it too, in the status line a screen reader reads out.
  await expect(button.locator("[data-action-result='done']")).toContainText("đã nhận yêu cầu", { timeout: 10_000 });
});

test("a view button pins itself to the conversation", async ({ page }) => {
  test.setTimeout(60_000);
  await openApp(page);
  const button = await place(page, "view");
  await button.getByRole("button", { name: "Ghim nút này" }).click();

  await expect(button.locator("[data-action-result='done']")).toHaveText("Đã ghim khung nhìn này.", { timeout: 10_000 });
  // Named on the shelf by what the button says, not by its definition id.
  await expect(page.locator("[data-pin-shelf] [data-pin-definition='canvas.action@1']").first()).toHaveText(/Ghim nút này/u);
});

test("an invoke button calls the package's service and shows what it answered", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page);
  const agent = await place(page, "agent");
  const button = await place(page, "invoke");
  await expect(button).toHaveAttribute("data-action-actionable", "true");
  await button.getByRole("button", { name: "Tải ghi chú" }).click();

  // The service's own words, written by the process in its container: "No notes yet." or "N note(s): …".
  await expect(button.locator("[data-action-result='done']")).toHaveText(/No notes yet\.|note\(s\)/u, { timeout: 30_000 });

  // The same markup as a button bound to something else entirely, once both have been pressed: the renderer does not
  // know what it runs.
  await agent.getByRole("button", { name: "Tóm tắt cuộc trò chuyện" }).click();
  await expect(agent.locator("[data-action-result='done']")).toBeVisible({ timeout: 30_000 });
  expect(await shape(button)).toBe(await shape(agent));
});

test("a workflow button adds a note through the package's service and reads the list back", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page);
  const button = await place(page, "workflow");
  await expect(button).toHaveAttribute("data-action-actionable", "true");
  const pressed = page.waitForResponse((response) => response.request().method() === "POST" && /\/widgets\/[^/]+\/actions$/u.test(response.url()));
  await button.getByRole("button", { name: "Ghi rồi đọc ghi chú" }).click();

  // The last step's answer is the list the service keeps, which now holds the note the first step added.
  await expect(button.locator("[data-action-result='done']")).toContainText("từ quy trình", { timeout: 30_000 });
  const body = (await (await pressed).json()) as {
    outcome?: string;
    workflow?: { completed: boolean; steps: { stepId: string; status: string }[] };
  };
  expect(body.outcome).toBe("done");
  expect(body.workflow?.completed).toBe(true);
  expect(body.workflow?.steps.map((step) => [step.stepId, step.status])).toEqual([
    ["add", "done"],
    ["list", "done"],
  ]);
});

test("an agent button with a context reference gives the model what the host read, not what the frame said", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page);
  await say(page, "đặt thẻ chi tiết");
  const card = page.locator("[data-widget-instance]").filter({ hasText: "Nguyễn Thị Lan" }).last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  const instanceId = (await card.getAttribute("data-widget-instance")) ?? "";
  expect(instanceId, "the details card is drawn for an instance").not.toBe("");

  const button = await place(page, `agent ngữ cảnh ${instanceId}`);
  await expect(button).toHaveAttribute("data-action-actionable", "true");
  const pressed = page.waitForResponse((response) => response.request().method() === "POST" && /\/widgets\/[^/]+\/actions$/u.test(response.url()));
  await button.getByRole("button", { name: "Tóm tắt thẻ" }).click();

  // The person's message is the label alone; the card's facts reached the model through the host.
  await expect(page.locator("[data-role='user'] [data-bubble='user']").last()).toHaveText("Tóm tắt thẻ", { timeout: 30_000 });
  const reply = page.locator("[data-role='assistant']").last();
  await expect(reply).toContainText("Ngữ cảnh host đọc:");
  await expect(reply).toContainText("Nguyễn Thị Lan");
  const body = (await (await pressed).json()) as { context?: { ref: string; kind: string; instanceId: string }[] };
  expect(body.context).toEqual([{ ref: `widget:${instanceId}`, kind: "widget", instanceId }]);
});

test("Stop cancels an invoke still waiting on the service, and says whether it took effect is unknown", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page);
  /** Notices asking whether an effect took effect that were not there before this press. */
  const waitingBefore = new Set<string>();
  const asking = async (): Promise<{ noticeId: string; effectId: string }[]> => {
    const inbox = (await (await page.request.get(`${GATEWAY}/inbox`, { headers: headers() })).json()) as {
      notices: { noticeId: string; actions?: { id: string; effectId?: string }[] }[];
    };
    return inbox.notices.flatMap((notice) => {
      const effectId = notice.actions?.find((action) => action.id === "reconcile-failed")?.effectId;
      return effectId === undefined || waitingBefore.has(notice.noticeId) ? [] : [{ noticeId: notice.noticeId, effectId }];
    });
  };
  for (const question of await asking()) waitingBefore.add(question.noticeId);
  const button = await place(page, "chậm");
  await expect(button).toHaveAttribute("data-action-actionable", "true");
  const pressed = page.waitForResponse((response) => response.request().method() === "POST" && /\/widgets\/[^/]+\/actions$/u.test(response.url()));
  await button.getByRole("button", { name: "Ghi chậm" }).click();

  // While the call waits, the conversation's own Stop is the control that stops it.
  const stop = page.getByRole("button", { name: "Dừng trả lời (Esc)" });
  await expect(stop).toBeVisible({ timeout: 10_000 });
  await stop.click();

  const response = await pressed;
  expect(response.status()).toBe(409);
  const body = (await response.json()) as { code?: string; outcome?: string; mayHaveRun?: boolean; message?: string };
  expect(body).toMatchObject({ code: "SERVICE_CANCELLED", outcome: "uncertain", mayHaveRun: true });
  const result = button.locator("[data-action-result='refused']");
  // Said whole in the person's language: they stopped it after it was sent, so it is unknown, and it was not run again.
  await expect(result).toHaveText(
    "Bạn đã dừng nó sau khi yêu cầu đã được gửi, trước khi dịch vụ trả lời, nên chưa rõ việc này đã có hiệu lực hay chưa. Nó không được chạy lại; hộp thư sẽ hỏi bạn nó đã có hiệu lực chưa.",
    { timeout: 10_000 },
  );
  await expect(stop).toBeHidden();

  // The inbox asks whether it took effect, offering the answer for this call's own effect.
  await expect.poll(async () => (await asking()).length, { timeout: 10_000 }).toBe(1);
  // The service dropped the withdrawn request, so the honest answer is that it did not take effect. Answering it also
  // leaves nothing waiting for the journeys after this one.
  const [question] = await asking();
  const answered = await page.request.post(`${GATEWAY}/effects/${question?.effectId ?? ""}/reconcile`, {
    headers: headers(),
    data: { outcome: "failed" },
  });
  expect(answered.ok(), `reconcile answered ${String(answered.status())}: ${await answered.text()}`).toBe(true);
  await expect.poll(async () => (await asking()).length, { timeout: 10_000 }).toBe(0);
});

test("a press the node refuses shows the reason, and an unknown or stale binding is refused", async ({ page, request }) => {
  test.setTimeout(180_000);
  await openApp(page);
  const button = await place(page, "invoke");
  await expect(button).toHaveAttribute("data-action-actionable", "true");

  // The service goes away after the button was drawn as available: the press is checked again and refused.
  const running = serviceContainers();
  expect(running.length, "the node should be running the notes service in a container").toBeGreaterThan(0);
  execFileSync("docker", ["kill", ...running]);
  await page.waitForTimeout(300);
  const pressed = page.waitForRequest((sent) => sent.method() === "POST" && /\/widgets\/[^/]+\/actions$/u.test(sent.url()));
  await button.getByRole("button", { name: "Tải ghi chú" }).click();
  const refused = button.locator("[data-action-result='refused']");
  await expect(refused).toBeVisible({ timeout: 15_000 });
  await expect(refused).not.toHaveText("");

  // The node names what is wrong with a binding the button does not hold, and with one whose digest is not the one it
  // compiled. The press above says which conversation, button and binding these are.
  const press = await pressed;
  const url = press.url();
  const sentBody = press.postDataJSON() as { actionBindingId: string; expectedRevision: number };
  const attempt = async (actionBindingId: string, expectedBindingDigest: string): Promise<{ status: number; code?: string; message?: string }> => {
    const answered = await request.post(url, {
      headers: headers(),
      data: { actionBindingId, expectedRevision: sentBody.expectedRevision, expectedBindingDigest, input: {}, invocationId: `inv_${String(Date.now())}_${actionBindingId}` },
    });
    return { status: answered.status(), ...((await answered.json()) as { code?: string; message?: string }) };
  };
  const unknown = await attempt("act_not_here", "sha256:none");
  expect(unknown.status).toBeGreaterThanOrEqual(400);
  expect(unknown.message ?? "").not.toBe("");
  const stale = await attempt(sentBody.actionBindingId, "sha256:not-the-compiled-one");
  expect(stale.status).toBeGreaterThanOrEqual(400);
  expect(stale.code).toBe("BINDING_STALE");

  // The service comes back, and the next press works.
  await serviceReady(request);
  await button.getByRole("button", { name: "Tải ghi chú" }).click();
  await expect(button.locator("[data-action-result='done']")).toBeVisible({ timeout: 30_000 });
});

test("the buttons read at phone width without horizontal scrolling", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await openApp(page);
  await place(page, "agent");
  await place(page, "invoke");
  const workflow = await place(page, "workflow");
  await expect(workflow).toHaveAttribute("data-action-actionable", "true");
  await workflow.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await page.screenshot({ path: testInfo.outputPath("action-buttons-desktop.png") });

  await page.setViewportSize({ width: 375, height: 812 });
  const widget = page.locator("[data-action-widget]").last();
  await widget.scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // Stacked at phone width: the button takes the row instead of squeezing the label beside it.
  const box = await widget.boundingBox();
  const buttonBox = await widget.locator("button.cc-action").boundingBox();
  expect(box !== null && buttonBox !== null && buttonBox.width > box.width * 0.8).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("action-buttons-mobile.png") });
});

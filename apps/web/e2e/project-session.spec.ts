import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, test, type Page } from "@playwright/test";

/**
 * Starting a worker session in a directory the node chose.
 *
 * The plan's C-path asks for a project, and the part of it a browser can prove is the part that was
 * missing: when nothing matches, the user is asked for a directory, and the answer — a path — has to
 * work. Before this, a typed path was treated as a search query, so the node asked for the directory
 * again; a loop the user could never escape.
 *
 * The session itself is started by the `CC_SESSION_FIXTURE` starter, configured in
 * `playwright.config.ts`: it reports a session id without spawning a worker. Everything else is the
 * production path — the finder scans and indexes, the gateway verifies the directory, and the reply
 * the user reads is written by the gateway.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const EVIDENCE = join(process.cwd(), "plans", "reports", "evidence");

function token(): string {
  const path = join(DATA_DIR, "identity.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error(`no local token in ${path}`);
  }
  return parsed.localToken;
}

const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}

/**
 * Approve a root, the way a user would.
 *
 * The node's default approved root is the home directory, and this repository is not inside it — it
 * lives on another volume. A journey that typed a path under the repository would be refused as
 * outside the approved roots, which is the finder working correctly rather than a bug: a path is not
 * a way to reach outside what the user approved. So the test records the preference the same way the
 * runtime reads it, and nothing else about the flow is stubbed.
 */
function approveRoot(root: string): void {
  const identity = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as {
    ownerPrincipalId?: unknown;
  };
  const principalId = typeof identity.ownerPrincipalId === "string" ? identity.ownerPrincipalId : "";
  if (principalId === "") throw new Error("the e2e identity file has no owner principal");

  const db = new DatabaseSync(join(DATA_DIR, "node.sqlite"));
  try {
    db.prepare(
      `INSERT INTO preferences (principal_id, key, value, scope, source, revision, previous_value, created_at)
       VALUES (?, 'workspace.roots', ?, 'global', 'user', 1, NULL, ?)
       ON CONFLICT (principal_id, key, scope) DO UPDATE SET
         value = excluded.value,
         revision = preferences.revision + 1,
         created_at = excluded.created_at`,
    ).run(principalId, JSON.stringify([root]), new Date().toISOString());
  } finally {
    db.close();
  }
}

/**
 * Forget which directories were used, so a query that matches nothing is answered with a path request.
 *
 * The finder asks "did you mean the one you used last?" when nothing matched but something was used,
 * which is the better question when there is one to offer. Clearing the signal is what makes the
 * `needs-path` branch reachable on a node that has already run this journey.
 */
function forgetRecentUse(): void {
  const db = new DatabaseSync(join(DATA_DIR, "node.sqlite"));
  try {
    db.prepare("UPDATE project_index SET last_used_at = NULL").run();
  } finally {
    db.close();
  }
}

async function openApp(page: Page): Promise<void> {
  await page.goto(
    `/?token=${token()}&gateway=${encodeURIComponent(`http://127.0.0.1:${NODE_PORT}`)}`,
  );
  await expect(page.locator("textarea[aria-label='Nhập tin nhắn']")).toBeVisible();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

test("a project session is started from a path the user types", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });

  // A real directory inside the node's approved root (its home), named uniquely so a re-run against
  // the same persistent e2e database cannot be answered by an earlier run's index.
  const suffix = Date.now().toString(36);
  const projectName = `bieu-mau-${suffix}`;
  // One path, used for the directory that is created and the path that is typed. Two `Date.now()`
  // calls here would create one directory and ask the node about another, and the journey would fail
  // for a reason that has nothing to do with the feature.
  const projectPath = join(DATA_DIR, projectName);
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, "README.md"), `# ${projectName}\n`);

  // The directory is under the repository, so the repository has to be an approved root before a
  // typed path inside it can be used.
  approveRoot(process.cwd());
  forgetRecentUse();

  await openApp(page);
  await page.locator("[data-start-session-toggle]").click();

  // A name nothing matches: the node must ask for a directory rather than invent one. One token that
  // shares no word with anything indexed, because BM25 ORs its terms — "bieu-mau-…-khong-ton-tai"
  // matched earlier runs' fixture directories on "bieu"/"mau" alone, and resolved instead of asking.
  await page.locator("[data-start-session-input]").fill(`zzz${suffix}khongtontai`);
  await page.locator("[data-start-session-submit]").click();
  const status = page.locator("[data-start-session-status]");
  await expect(status).toHaveAttribute("data-start-session-status", "needs-path", { timeout: 30_000 });
  await expect(status).toContainText("đường dẫn thư mục");
  // The input is now asking for a path, which is what makes the question answerable.
  await expect(page.locator("[data-start-session-input]")).toHaveAttribute("aria-label", "Đường dẫn thư mục");

  // The answer is the path, and it is read from the user's own words.
  await page.locator("[data-start-session-input]").fill(projectPath);
  await page.locator("[data-start-session-submit]").click();
  await expect(status).toHaveAttribute("data-start-session-status", "started", { timeout: 30_000 });
  await expect(status).toContainText(projectName);
  // The gateway's own reply is in the transcript, so the flow is visible after a reload too. Host
  // replies are stored as assistant messages, which is the role the transcript renders.
  await expect(page.locator("[data-role='assistant']").last()).toContainText(projectName);

  await page.screenshot({ path: join(EVIDENCE, "session-01-started-from-typed-path.png"), fullPage: true });
});

test("the desktop shell picks a directory in an OS dialog instead of asking for a typed path", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  const suffix = Date.now().toString(36);
  const projectName = `bieu-mau-${suffix}`;
  const projectPath = join(DATA_DIR, projectName);
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, "README.md"), `# ${projectName}\n`);
  approveRoot(process.cwd());
  forgetRecentUse();

  // The shell installs this before the page script runs. It stands in for the OS dialog, which cannot
  // be driven headlessly; what this proves is the client's branch — a present bridge is used, and the
  // path it answers with takes exactly the route a typed one does.
  await page.addInitScript((picked) => {
    Object.assign(window, {
      clarkcant: { pickDirectory: async () => ({ ok: true, canceled: false, path: picked }) },
    });
  }, projectPath);

  await openApp(page);
  await page.locator("[data-start-session-toggle]").click();
  const picker = page.locator("[data-start-session-pick]");
  await expect(picker).toBeVisible();

  await picker.click();
  const status = page.locator("[data-start-session-status]");
  await expect(status).toHaveAttribute("data-start-session-status", "started", { timeout: 30_000 });
  await expect(status).toContainText(projectName);
  await expect(page.locator("[data-role='assistant']").last()).toContainText(projectName);

  await page.screenshot({ path: join(EVIDENCE, "session-03-picked-in-os-dialog.png"), fullPage: true });
});

test("the web build offers no directory picker", async ({ page }) => {
  await openApp(page);
  await page.locator("[data-start-session-toggle]").click();

  // Absent rather than inert: on the web the typed input is the only answer, and a control that
  // cannot open a dialog would be a promise the build cannot keep.
  await expect(page.locator("[data-start-session-pick]")).toHaveCount(0);
  await expect(page.locator("[data-start-session-input]")).toBeVisible();
});

test("an unknown name offers the directory used last instead of opening it", async ({ page }) => {
  const suffix = Date.now().toString(36);
  const projectName = `bieu-mau-${suffix}`;
  const projectPath = join(DATA_DIR, projectName);
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, "README.md"), `# ${projectName}\n`);
  approveRoot(process.cwd());

  await openApp(page);
  await page.locator("[data-start-session-toggle]").click();

  // Used first, so the node has something to offer.
  await page.locator("[data-start-session-input]").fill(projectPath);
  await page.locator("[data-start-session-submit]").click();
  const status = page.locator("[data-start-session-status]");
  await expect(status).toHaveAttribute("data-start-session-status", "started", { timeout: 30_000 });

  // Then a name nothing matches. The node must not open the recent directory silently: it asks,
  // because a directory is never invented and "the one you used last" is a proposal, not an answer.
  await page.locator("[data-start-session-input]").fill(`zzz${suffix}khongtontai`);
  await page.locator("[data-start-session-submit]").click();
  await expect(status).toHaveAttribute("data-start-session-status", "clarify", { timeout: 30_000 });
  // The wording depends on how many directories were used before — one recent candidate is offered by
  // name, several become a question with options — so the assertion is the property that matters: the
  // directory is proposed rather than opened, and it is one of the choices.
  const option = page.locator(`[data-start-session-option='.data/e2e/${projectName}']`);
  await expect(option).toBeVisible({ timeout: 30_000 });

  // Answering the question starts the session, so the question is not a dead end.
  await option.click();
  await expect(status).toHaveAttribute("data-start-session-status", "started", { timeout: 30_000 });
  await expect(page.locator("[data-role='assistant']").last()).toContainText(projectName);
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ATTACHMENT_LIMITS } from "@clarkcant/contracts";
import { FakePiAdapter } from "@clarkcant/pi-adapter";

import { attachmentRefsForLastUserMessage } from "../src/attachments.ts";
import { createModelTurn } from "../src/model-turn.ts";
import { handleRequest, type GatewayDeps } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * What the model is told about an attached file.
 *
 * This file exists because the claim "the file's content reaches the agent" has no honest place to be
 * checked anywhere else. A browser test can prove the chip, the timeline and the reload, and it cannot
 * prove the prompt: the fixture composer runs *before* the model turn and sees only the text a person
 * typed. The one boundary where the assembled prompt is observable is the adapter, so the assertions
 * live here, against the prompt the adapter was actually given.
 *
 * The security assertion is the one that matters most: no prompt may contain a path. Two of these tests
 * exist only to fail if someone later makes the brief more convenient by naming where the bytes live.
 *
 * The messages go through the real route rather than straight into the conductor, because the route is
 * where an id becomes an authorised ref, and a test that skipped it would be testing the half that has no
 * authorisation in it.
 */

const ENV = { CC_MODEL_PROVIDER: "test-provider", CC_MODEL_ID: "test-model" } satisfies NodeJS.ProcessEnv;
const AT = "2026-09-19T06:00:00.000Z";

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let conversationId: string;
let conversationSequence = 0;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-attach-turn-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  conversationSequence = 0;
  deps = {
    services,
    now: () => AT,
    // Two conversations are created in one test, so the id has to advance rather than being a constant
    // the second insert collides with.
    newConversationId: () => {
      conversationSequence += 1;
      return `conv_turn_${conversationSequence}`;
    },
  };
  conversationId = await createConversation("attachments in a turn");
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

function token(): string {
  return services.runtime.identity.localToken;
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return handleRequest(deps, {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${token()}` },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

async function createConversation(title: string): Promise<string> {
  const response = await call("POST", "/conversations", { title });
  expect(response.status).toBe(201);
  return (response.body as { conversationId: string }).conversationId;
}

async function upload(filename: string, mime: string, base64: string): Promise<string> {
  const response = await call("POST", "/attachments", { conversationId, filename, mime, contentBase64: base64 });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return (response.body as { attachmentRef: { attachmentId: string } }).attachmentRef.attachmentId;
}

function uploadText(filename: string, content: string): Promise<string> {
  return upload(filename, "text/plain", Buffer.from(content).toString("base64"));
}

/**
 * A node whose conversation turn runs against the fake adapter, wired the way the node wires it.
 *
 * The attachment reader is the node's own `attachmentRefsForLastUserMessage`, not a copy: a test that
 * reimplemented the lookup would prove that its own version works, and the thing under test is whether
 * the node's version reads back what was stored.
 */
async function turnWithModel(script: readonly string[] = ["Đã đọc tệp."]): Promise<FakePiAdapter> {
  const adapter = new FakePiAdapter({ script: [...script] });
  const turn = await createModelTurn({
    env: ENV,
    cwd: process.cwd(),
    adapter,
    attachments: {
      dataDir: dir,
      refsFor: (id) => attachmentRefsForLastUserMessage({ db: services.runtime.db, conversationId: id }),
    },
  });
  if (turn === undefined) throw new Error("the test environment did not configure a model");
  // The node's own conductor, with a model turn in the seat the composition root puts it in.
  services.conductor.respondWithModel = (input) => turn.answer(input);
  return adapter;
}

function send(text: string, attachmentIds: string[]): Promise<{ status: number; body: unknown }> {
  return call("POST", `/conversations/${conversationId}/messages`, { text, attachmentIds });
}

describe("a text attachment reaching the turn", () => {
  it("a text attachment's content reaches the model prompt", async () => {
    const adapter = await turnWithModel();
    const id = await uploadText("ghi-chu.md", "# Ghi chú\nNội dung rất riêng biệt.");
    expect((await send("đọc tệp này giúp tui", [id])).status).toBe(200);

    const prompts = adapter.allPrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Nội dung rất riêng biệt.");
    expect(prompts[0]).toContain("đọc tệp này giúp tui");
  });

  it("the prompt for a turn with attachments contains no disk path", async () => {
    const adapter = await turnWithModel();
    const id = await uploadText("ghi-chu.md", "nội dung");
    expect((await send("xem giúp", [id])).status).toBe(200);

    const prompt = adapter.allPrompts()[0] ?? "";
    expect(prompt).not.toContain(dir);
    expect(prompt).not.toContain("blobs");
    expect(prompt).not.toContain("blobPath");
    // A path is what must not appear, so the check is for path shapes rather than for "any slash": a mime
    // type is not a location, and `text/plain` contains a slash while naming the type is the whole point
    // of that line. What is refused is a drive letter, a filesystem root, or one of the node's own
    // directories anywhere in the prompt.
    expect(prompt).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(prompt).not.toMatch(/(^|[\s"'`(])\/(Users|home|tmp|var|opt|etc|private)\//);
  });

  it("an image attachment reaches the model as an opaque ref, not as pixels", async () => {
    const adapter = await turnWithModel();
    // A one-pixel PNG, so the bytes are a real image rather than a name claiming to be one.
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AP//AAA=";
    const id = await upload("anh.png", "image/png", png);
    expect((await send("ảnh này là gì", [id])).status).toBe(200);

    const prompt = adapter.allPrompts()[0] ?? "";
    expect(prompt).toContain(id);
    expect(prompt).toContain("read_attachment");
    // Not the image itself, and not a claim that the model can see it.
    expect(prompt).not.toContain(png);
    expect(prompt).not.toContain("iVBORw0KGgo");
  });

  it("the inline budget is shared across attachments in one turn", async () => {
    const adapter = await turnWithModel();
    // Eight files, each over the whole per-turn budget, so the ceiling is the turn's and not each file's.
    const ids: string[] = [];
    for (let index = 0; index < ATTACHMENT_LIMITS.maxPerMessage; index += 1) {
      ids.push(await uploadText(`tep-${index}.txt`, "A".repeat(ATTACHMENT_LIMITS.inlineBudgetBytesPerTurn)));
    }
    expect((await send("đọc hết", ids)).status).toBe(200);

    const prompt = adapter.allPrompts()[0] ?? "";
    const inlined = prompt.split("\n").filter((line) => line.startsWith("AAAA")).join("");
    expect(inlined.length).toBeLessThanOrEqual(ATTACHMENT_LIMITS.inlineBudgetBytesPerTurn);
    // Every file is still named, so the model can ask for the rest instead of not knowing it exists.
    for (const id of ids) expect(prompt).toContain(id);
  });

  it("a turn with no attachments gets exactly the prompt it got before", async () => {
    const adapter = await turnWithModel();
    expect((await send("chỉ có chữ thôi", [])).status).toBe(200);
    expect(adapter.allPrompts()[0]).toBe("chỉ có chữ thôi");
  });
});

describe("what a stored user message carries", () => {
  it("a stored user message carries one attachment block per attached file", async () => {
    await turnWithModel();
    const first = await uploadText("a.txt", "a");
    const second = await uploadText("b.txt", "b");
    expect((await send("hai tệp", [first, second])).status).toBe(200);

    const refs = attachmentRefsForLastUserMessage({ db: services.runtime.db, conversationId });
    expect(refs.map((ref) => ref.attachmentId)).toEqual([first, second]);
    // The timeline and the prompt read the same row, so the filename a person sees is the one the model was told.
    expect(refs.map((ref) => ref.filename)).toEqual(["a.txt", "b.txt"]);
  });

  it("a message carrying no attachments stores no attachment block", async () => {
    await turnWithModel();
    expect((await send("không có tệp", [])).status).toBe(200);
    expect(attachmentRefsForLastUserMessage({ db: services.runtime.db, conversationId })).toEqual([]);
  });

  it("the same file named twice is one attachment, not two", async () => {
    const adapter = await turnWithModel();
    const id = await uploadText("mot-lan.txt", "nội dung duy nhất");
    expect((await send("hai lần", [id, id])).status).toBe(200);
    expect(attachmentRefsForLastUserMessage({ db: services.runtime.db, conversationId })).toHaveLength(1);
    // Counted in the prompt too, since that is what the model is charged for.
    expect((adapter.allPrompts()[0] ?? "").split("mot-lan.txt")).toHaveLength(2);
  });
});

describe("authorising the ids a client sends", () => {
  it("refuses an id that does not exist without naming it back", async () => {
    const response = await send("kèm tệp", ["att_khong_ton_tai"]);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "ATTACHMENT_NOT_AVAILABLE" });
    expect(JSON.stringify(response.body)).not.toContain("att_khong_ton_tai");
  });

  it("refuses an attachment that belongs to another conversation", async () => {
    const other = await createConversation("nơi khác");
    const response = await call("POST", "/attachments", {
      conversationId: other,
      filename: "rieng.txt",
      mime: "text/plain",
      contentBase64: Buffer.from("riêng").toString("base64"),
    });
    const foreign = (response.body as { attachmentRef: { attachmentId: string } }).attachmentRef.attachmentId;

    const refused = await send("mượn tệp", [foreign]);
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: "ATTACHMENT_NOT_AVAILABLE" });
  });

  it("refuses more files than a message may carry, and a value that is not a list", async () => {
    const tooMany = await send(
      "quá nhiều",
      Array.from({ length: ATTACHMENT_LIMITS.maxPerMessage + 1 }, (_, index) => `att_${index}`),
    );
    expect(tooMany.status).toBe(400);
    expect(tooMany.body).toMatchObject({ code: "ATTACHMENT_NOT_AVAILABLE" });

    expect((await send("không phải mảng", "att_one" as unknown as string[])).status).toBe(400);
  });

  it("a message with no attachmentIds behaves exactly as it did before this existed", async () => {
    await turnWithModel();
    const response = await call("POST", `/conversations/${conversationId}/messages`, { text: "không kèm gì" });
    expect(response.status).toBe(200);
  });
});

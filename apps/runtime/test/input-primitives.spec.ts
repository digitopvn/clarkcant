import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CapabilityRef, type Instant, type MessageBlock, SNAPSHOT_TEXT_LIMIT } from "@clarkcant/contracts";
import { getActionBinding, getInstance, registerCapability } from "@clarkcant/core";
import { FORM, LIST } from "@clarkcant/data-canvas";
import { appendMessage } from "@clarkcant/storage";

import { type ActionBindingDeps } from "../src/application/action-bindings.ts";
import { invokeWidgetAction } from "../src/application/widget-actions.ts";
import { compileLayout } from "../src/compose-layout.ts";
import type { ServiceHost } from "../src/service-host.ts";
import { bootNodeServices, buildTimeline, type NodeServices } from "../src/services.ts";
import { buildViewCatalog } from "../src/view-catalog.ts";
import { removeTestDirectory } from "../../../tools/test-cleanup.ts";

/**
 * A form and a list, placed the way a model's `show_view` places them, and used the way a person uses them.
 *
 * What carries the weight is the node's side. The page checks a form as it is filled in, but the page can be bypassed:
 * every value a use sends is checked again by the node against the fields the form was made with, and a value that
 * does not fit is refused with the reason before anything runs. A list item's action accepts only the ids of the items
 * the list holds.
 */

const AT = "2026-09-29T05:00:00.000Z" as Instant;
const ADD = "com.example.notes.add@1" as CapabilityRef;
const PACKAGE = "com.example.notes";
const GENERATION = "com.example.notes@1.0.0:code_1";

let dir: string;
let services: NodeServices;
let conversationId: string;
let served: Map<string, { packageId: string; generationId: string }>;
let composed: { text: string; note: string | undefined }[];
let counter = 0;

function bindingDeps(): ActionBindingDeps {
  return {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    serviceHost: services.serviceHost,
    now: () => AT,
    newId: (prefix) => `${prefix}_${String(++counter)}`,
  };
}

function registerAdd(): void {
  registerCapability(
    { db: services.runtime.db, nodeId: services.runtime.identity.nodeId },
    {
      ref: ADD,
      providedBy: { packageId: PACKAGE, version: "1.0.0", digest: "sha256:notes", generation: GENERATION },
      executionNodeId: services.runtime.identity.nodeId,
      summary: "Add a note",
      resourceKinds: [],
      effectCategory: "local-write",
      supportsCancellation: false,
      requiresConnection: false,
      readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
      uiAffordances: [],
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" }, noteId: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  );
  served.set(ADD, { packageId: PACKAGE, generationId: GENERATION });
}

/** Place a widget through its `show_view` descriptor, in a message, so the timeline carries it. */
async function place(definitionId: string, props: Record<string, unknown>): Promise<string> {
  const view = buildViewCatalog(services.conductor, undefined, bindingDeps).find((entry) => entry.id === definitionId);
  if (view === undefined) throw new Error(`${definitionId} is not in the catalog`);
  const messageId = `msg_${String(++counter)}`;
  const block = (await view.build({
    props,
    caption: "",
    at: AT,
    principal: { principalId: services.runtime.identity.ownerPrincipalId, kind: "user", nodeId: services.runtime.identity.nodeId } as never,
    messageId,
    conversationId,
  })) as Extract<MessageBlock, { type: "surface" }>;
  appendMessage(
    services.runtime.db,
    {
      messageId,
      conversationId,
      role: "assistant",
      authorNodeId: services.runtime.identity.nodeId,
      delivery: "accepted",
      createdAt: AT,
      blocks: [block],
    } as never,
    counter,
  );
  return block.snapshot.instanceId ?? "";
}

async function use(instanceId: string, input: Record<string, unknown>, invocationId: string) {
  const instance = getInstance(services.conductor, instanceId);
  const bindingId = instance?.actionBindingIds[0] ?? "";
  const binding = getActionBinding(services.conductor, bindingId);
  return invokeWidgetAction(
    services,
    {
      conversationId,
      principalId: services.runtime.identity.ownerPrincipalId,
      instanceId,
      actionBindingId: bindingId,
      expectedRevision: instance?.revision ?? 0,
      expectedBindingDigest: binding?.bindingDigest ?? "",
      input,
      invocationId,
    },
    "click",
  );
}

function instanceRows(): number {
  return (services.runtime.db.prepare("SELECT COUNT(*) AS n FROM widget_instances").get() as { n: number }).n;
}

const MEETING = {
  title: "Đặt lịch họp",
  submitLabel: "Gửi cho Clark",
  fields: [
    { name: "topic", label: "Chủ đề", kind: "text", required: true, maxLength: 40 },
    { name: "span", label: "Khoảng ngày", kind: "date-range" },
    { name: "minutes", label: "Thời lượng", kind: "slider", min: 15, max: 120, step: 15 },
    {
      name: "people",
      label: "Người dự",
      kind: "chips",
      options: [
        { value: "an", label: "An" },
        { value: "binh", label: "Bình" },
      ],
    },
    { name: "agree", label: "Đồng ý ghi lại", kind: "checkbox", required: true },
  ],
  action: { kind: "agent", intent: "Ghi cuộc họp vào việc cần làm." },
};

const TASKS = {
  title: "Việc chờ",
  items: [
    { id: "t1", title: "Gửi báo giá" },
    { id: "t2", title: "Gọi lại khách" },
  ],
  itemActionLabel: "Nhờ Clark",
  action: { kind: "agent", intent: "Xử lý việc được chọn." },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-input-primitives-"));
  composed = [];
  served = new Map();
  services = bootNodeServices({
    dataDir: dir,
    label: "test node",
    composeFromIntent: async (input) => {
      composed.push({ text: input.text, note: input.note });
      const reply = `Đã làm: ${input.text}`;
      return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
    },
  });
  services.serviceHost = { serves: (ref: CapabilityRef) => served.get(ref) } as unknown as ServiceHost;
  conversationId = "conv_input_primitives";
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)")
    .run(conversationId, services.runtime.identity.nodeId, AT, AT);
});

afterEach(async () => {
  services.runtime.db.close();
  await removeTestDirectory(dir);
});

describe("the model's vocabulary", () => {
  it("offers a form and a list, and never a choice, an input or a search box on its own", () => {
    const ids = buildViewCatalog(services.conductor, undefined, bindingDeps).map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining([FORM.id, LIST.id]));
    expect(ids).not.toEqual(expect.arrayContaining(["canvas.choice@1"]));
    expect(ids).not.toContain("canvas.input@1");
    expect(ids).not.toContain("canvas.search@1");
    // A node that cannot bind an action offers no form: one would be a send button with nothing behind it.
    expect(buildViewCatalog(services.conductor).map((entry) => entry.id)).not.toContain(FORM.id);
  });
});

describe("placing a form", () => {
  it("records the form's own fields as the only input its action accepts", async () => {
    const instanceId = await place(FORM.id, MEETING);
    const instance = getInstance(services.conductor, instanceId);
    expect(instance?.props).not.toHaveProperty("action");
    const binding = getActionBinding(services.conductor, instance?.actionBindingIds[0] ?? "");
    expect(binding?.label).toBe("Gửi cho Clark");
    expect(binding?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["topic", "agree"],
      properties: { topic: { type: "string", maxLength: 40 }, agree: { type: "boolean", enum: [true] } },
    });
    const actions = buildTimeline(services, { conversationId }).instances.find(
      (entry) => entry.instanceId === instanceId,
    )?.actions;
    expect(actions?.[0]?.inputKeys).toEqual(["topic", "span", "minutes", "people", "agree"]);
  });

  it("refuses a form that asks for a secret, or whose fields could never be filled in, and stores nothing", async () => {
    const before = instanceRows();
    await expect(
      place(FORM.id, { ...MEETING, fields: [{ name: "password", label: "Mật khẩu", kind: "text" }] }),
    ).rejects.toThrow("asks for a secret");
    await expect(
      place(FORM.id, { ...MEETING, fields: [{ name: "pick", label: "Chọn", kind: "select" }] }),
    ).rejects.toThrow("needs options");
    await expect(
      place(FORM.id, { ...MEETING, fields: [MEETING.fields[0], MEETING.fields[0]] }),
    ).rejects.toThrow('two fields are named "topic"');
    await expect(place(FORM.id, { ...MEETING, action: undefined })).rejects.toThrow("needs props.action");
    await expect(
      place(FORM.id, { ...MEETING, action: { kind: "view", operation: "view.save", args: {} } }),
    ).rejects.toThrow("cannot go to a view operation");
    expect(instanceRows()).toBe(before);
  });

  it("binds each field to the capability argument of the same name, and refuses a field the capability does not take", async () => {
    registerAdd();
    const note = {
      submitLabel: "Lưu ghi chú",
      fields: [{ name: "text", label: "Nội dung", kind: "text", required: true }],
      action: { kind: "invoke", capabilityRef: ADD, args: {} },
    };
    const instanceId = await place(FORM.id, note);
    const binding = getActionBinding(services.conductor, getInstance(services.conductor, instanceId)?.actionBindingIds[0] ?? "");
    expect(binding?.proposal).toMatchObject({ kind: "invoke", bindings: [{ target: "text", source: "user-input" }] });

    await expect(
      place(FORM.id, { ...note, fields: [...note.fields, { name: "color", label: "Màu", kind: "text" }] }),
    ).rejects.toThrow(`${ADD} does not take color`);
  });
});

describe("sending a form", () => {
  it("starts a turn that says what was sent, in the fields' own words", async () => {
    const instanceId = await place(FORM.id, MEETING);
    const result = await use(
      instanceId,
      { topic: "Rà soát quý", span: { start: "2026-10-01", end: "2026-10-03" }, minutes: 45, people: ["an", "binh"], agree: true },
      "inv_form_1",
    );
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(composed).toHaveLength(1);
    expect(composed[0]?.text).toBe(
      "Gửi cho Clark\nChủ đề: Rà soát quý\nKhoảng ngày: 2026-10-01 – 2026-10-03\nThời lượng: 45\nNgười dự: An, Bình\nĐồng ý ghi lại: ✓",
    );
    expect(composed[0]?.note).toContain('"topic":"Rà soát quý"');
  });

  it.each([
    ["a required field left empty", { agree: true }, "Chủ đề: required"],
    ["text past its limit", { topic: "x".repeat(41), agree: true }, "Chủ đề: at most 40 characters"],
    ["a range that ends before it starts", { topic: "A", agree: true, span: { start: "2026-10-03", end: "2026-10-01" } }, "the end comes before the start"],
    ["a slider off its step", { topic: "A", agree: true, minutes: 50 }, "Thời lượng: in steps of 15"],
    ["an option the field does not offer", { topic: "A", agree: true, people: ["zoe"] }, "Người dự: expected options from the list"],
    ["a box that has to be ticked", { topic: "A", agree: false }, "Đồng ý ghi lại: required"],
    ["a key that is not a field", { topic: "A", agree: true, admin: true }, "admin: not a field of this form"],
  ])("refuses %s before anything runs", async (_case, input, reason) => {
    const instanceId = await place(FORM.id, MEETING);
    const refused = await use(instanceId, input, `inv_bad_${String(++counter)}`);
    expect(refused).toMatchObject({ ok: false, status: 400, code: "INVALID_INPUT" });
    if (refused.ok) throw new Error("unreachable");
    expect(refused.message).toContain(reason);
    expect(composed).toHaveLength(0);
  });

  it("refuses a value that does not fit before a capability is called", async () => {
    registerAdd();
    const instanceId = await place(FORM.id, {
      submitLabel: "Lưu",
      fields: [{ name: "text", label: "Nội dung", kind: "text", required: true, maxLength: 5 }],
      action: { kind: "invoke", capabilityRef: ADD, args: {} },
    });
    const refused = await use(instanceId, { text: "quá dài rồi" }, "inv_invoke_bad");
    expect(refused).toMatchObject({ ok: false, status: 400, code: "INVALID_INPUT" });
    if (refused.ok) throw new Error("unreachable");
    expect(refused.message).toContain("Nội dung: at most 5 characters");
  });
});

describe("a list and its item action", () => {
  it("accepts only an id the list holds, and says which item the person acted on", async () => {
    const instanceId = await place(LIST.id, TASKS);
    const actions = buildTimeline(services, { conversationId }).instances.find(
      (entry) => entry.instanceId === instanceId,
    )?.actions;
    expect(actions?.[0]).toMatchObject({ label: "Nhờ Clark", inputKeys: ["itemId"] });

    const refused = await use(instanceId, { itemId: "t9" }, "inv_list_bad");
    expect(refused).toMatchObject({ ok: false, status: 400, code: "INVALID_INPUT" });
    expect(composed).toHaveLength(0);

    const done = await use(instanceId, { itemId: "t2" }, "inv_list_ok");
    expect(done).toMatchObject({ ok: true });
    expect(composed[0]?.text).toBe("Nhờ Clark: Gọi lại khách");
  });

  it("places a list with no action, and refuses a label without an action or items that share an id", async () => {
    const plain = await place(LIST.id, { items: [{ id: "a", title: "A" }] });
    expect(getInstance(services.conductor, plain)?.actionBindingIds).toEqual([]);
    await expect(place(LIST.id, { ...TASKS, action: undefined })).rejects.toThrow("together");
    await expect(
      place(LIST.id, { items: [{ id: "a", title: "A" }, { id: "a", title: "B" }] }),
    ).rejects.toThrow("item ids repeat: a");
  });

  it("binds an invoke to the one argument the model names for the item's id", async () => {
    registerAdd();
    const bound = await place(LIST.id, {
      ...TASKS,
      action: { kind: "invoke", capabilityRef: ADD, args: { text: "xong" }, bindings: [{ target: "noteId", source: "selected-row" }] },
    });
    const binding = getActionBinding(services.conductor, getInstance(services.conductor, bound)?.actionBindingIds[0] ?? "");
    expect(binding?.inputSchema).toMatchObject({ required: ["noteId"], properties: { noteId: { enum: ["t1", "t2"] } } });

    await expect(
      place(LIST.id, { ...TASKS, action: { kind: "invoke", capabilityRef: ADD, args: { text: "xong" } } }),
    ).rejects.toThrow("name the one argument that takes the item's id");
    await expect(
      place(LIST.id, {
        ...TASKS,
        action: { kind: "invoke", capabilityRef: ADD, args: {}, bindings: [{ target: "text", source: "user-input" }] },
      }),
    ).rejects.toThrow("cannot come from user-input");
  });
});

describe("primitives in a layout", () => {
  const compile = (layout: unknown) =>
    compileLayout({
      proposal: layout,
      registry: services.compose.registry,
      rowsBySlot: { metrics: [{ label: "Xong", value: 3 }], table: [{ day: "01/10", completed: 3 }] },
      initialState: { period: "week", timezone: "UTC" },
    });
  const leaf = (widget: string, props: Record<string, unknown> = {}) => ({ kind: "widget", widget, props });

  it("compiles Grid(Metrics, Metrics, Card(Search, Table)) with no template for it", () => {
    const result = compile({
      kind: "grid",
      columns: 3,
      children: [
        leaf("canvas.metrics@1"),
        leaf("canvas.metrics@1"),
        { kind: "card", label: "Chi tiết", children: [leaf("canvas.search@1", { label: "Tìm" }), leaf("canvas.table@1")] },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.problems.join("; "));
    expect(result.sections.map((section) => section.slot)).toEqual(["metrics", "metrics", "search", "table"]);
    expect(result.layout).toMatchObject({
      kind: "grid",
      children: [{ kind: "widget" }, { kind: "widget" }, { kind: "card", children: [{ kind: "widget" }, { kind: "widget" }] }],
    });
  });

  it("refuses a form, a lone choice or input, and a list whose items would act, each with the reason", () => {
    const refused = compile({
      kind: "stack",
      children: [
        leaf("canvas.form@1", { submitLabel: "Gửi", fields: [{ name: "a", label: "A", kind: "text" }] }),
        leaf("canvas.choice@1", { label: "Chọn", kind: "toggle" }),
        leaf("canvas.list@1", { items: [{ id: "a", title: "A" }], itemActionLabel: "Làm" }),
        leaf("canvas.list@1", { items: [{ id: "a", title: "A" }, { id: "a", title: "B" }] }),
      ],
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.problems.join("\n")).toContain("a form is placed with its own show_view");
    expect(refused.problems.join("\n")).toContain("make it a field of a canvas.form@1");
    expect(refused.problems.join("\n")).toContain("a list whose items act is placed with its own show_view");
    expect(refused.problems.join("\n")).toContain("item ids repeat");
  });
});

describe("a list whose own words are longer than a snapshot keeps", () => {
  it("is stored with its text shortened and marked, and the conversation reads it back", async () => {
    // Twenty titles at their longest make about 4040 characters of text; nothing the model wrote is too long.
    const items = Array.from({ length: 20 }, (_, index) => ({ id: `i${String(index)}`, title: `${"t".repeat(197)}${String(index).padStart(3, "0")}` }));
    const instanceId = await place(LIST.id, { items });
    const timeline = buildTimeline(services, { conversationId });
    const text = timeline.snapshots.find((snapshot) => snapshot.instanceId === instanceId)?.textAlternative ?? "";
    expect(text.length).toBeLessThanOrEqual(SNAPSHOT_TEXT_LIMIT);
    expect(text.startsWith(`${items[0]?.title ?? ""}; ${items[1]?.title ?? ""}`)).toBe(true);
    expect(text.endsWith("… (shortened)")).toBe(true);
  });

  it("still refuses a caption the model wrote too long, in the same turn", async () => {
    const view = buildViewCatalog(services.conductor, undefined, bindingDeps).find((entry) => entry.id === LIST.id);
    const before = instanceRows();
    await expect(
      (async () =>
        view?.build({
          props: { items: [{ id: "a", title: "A" }] },
          caption: "x".repeat(SNAPSHOT_TEXT_LIMIT + 1),
          at: AT,
          principal: { principalId: services.runtime.identity.ownerPrincipalId, kind: "user", nodeId: services.runtime.identity.nodeId } as never,
          messageId: "msg_long_caption",
          conversationId,
        }))(),
    ).rejects.toThrow(
      new Error(
        `${LIST.id} cannot be shown: its caption is ${String(SNAPSHOT_TEXT_LIMIT + 1)} characters and at most ${String(SNAPSHOT_TEXT_LIMIT)} are kept; write one short sentence`,
      ),
    );
    expect(instanceRows()).toBe(before);
  });
});
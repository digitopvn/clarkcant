import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Instant } from "@clarkcant/contracts";
import { deleteLocalImage, findBundleForMessage, findCompositionByMessage, insertLocalImage, type Database } from "@clarkcant/storage";

import { type ComposeDeps, rowsBySlotOf } from "../src/compose-mini-app.ts";
import { compileLayout, composeLayout } from "../src/compose-layout.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { publishMiniAppData } from "../src/mini-app-data.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { buildViewCatalog } from "../src/view-catalog.ts";

/**
 * A composed surface whose widgets affect one another through declared state.
 *
 * What matters is that the node, not the page, decides what the state is: a rule the host cannot check is refused
 * before anything is stored, an event is applied again by the node under the surface's revision, and what the node
 * keeps is what the rules say, even when a page claims otherwise.
 */

const AT = "2026-09-29T05:00:00.000Z" as Instant;
const CONVERSATION = "conv_graph";

let dir: string;
let services: NodeServices;
let compose: ComposeDeps;
let owner: never;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-graph-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  compose = services.compose;
  owner = services.runtime.identity.ownerPrincipalId as never;
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)")
    .run(CONVERSATION, services.runtime.identity.nodeId, AT, AT);
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

function db(): Database {
  return services.runtime.db;
}

const leaf = (widget: string, props: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "widget",
  widget,
  props,
  ...extra,
});

const CHOICE_PROPS = {
  label: "Chỉ số trên biểu đồ",
  kind: "radio",
  options: [
    { value: "completed", label: "Việc xong" },
    { value: "created", label: "Việc tạo" },
  ],
};

const STATE = {
  metric: { type: "string", initial: "completed" },
  query: { type: "string", initial: "" },
};

/** The fixture's linked surface: a choice drives a chart's series, a search box drives a table's query. */
const LINKED = {
  kind: "stack",
  children: [
    {
      kind: "row",
      children: [
        leaf("canvas.choice@1", CHOICE_PROPS, { on: [{ event: "choice.change", steps: [{ op: "select-field", key: "metric", field: "value" }] }] }),
        leaf("canvas.search@1", { label: "Tìm trong bảng" }, { on: [{ event: "query.change", steps: [{ op: "select-field", key: "query", field: "query" }] }] }),
      ],
    },
    leaf("canvas.line@1", { title: "Xu hướng" }, { feed: [{ op: "filter-equals", field: "series", key: "metric" }] }),
    leaf("canvas.table@1", { title: "Số việc theo ngày" }, { feed: [{ op: "query", key: "query" }] }),
  ],
};

function compile(proposal: unknown, state?: unknown) {
  const published = publishMiniAppData(
    { db: db(), nodeId: services.runtime.identity.nodeId, dataDir: dir, now: () => AT, newId: compose.newId },
    { principalId: owner, period: "week", timezone: "UTC" },
  );
  return compileLayout({
    proposal,
    registry: compose.registry,
    rowsBySlot: rowsBySlotOf(published),
    initialState: { period: "week", timezone: "UTC" },
    ...(state === undefined ? {} : { state }),
  });
}

function problemsOf(proposal: unknown, state?: unknown): string {
  const result = compile(proposal, state);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.problems.join(" | ");
}

describe("compiling a layout with a state graph", () => {
  it("names each rule and feed by the section it was written on", () => {
    const result = compile(LINKED, STATE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.sections.map((section) => section.sectionId);
    expect(ids).toHaveLength(4);
    const [choice, search, line, table] = ids;
    expect(result.graph?.state).toEqual(STATE);
    expect(result.graph?.on.map((rule) => [rule.sectionId, rule.event])).toEqual([
      [choice, "choice.change"],
      [search, "query.change"],
    ]);
    expect(result.graph?.feed.map((feed) => [feed.sectionId, feed.op])).toEqual([
      [line, "filter-equals"],
      [table, "query"],
    ]);
  });

  it("refuses a choice or an input that writes no state, and a search box left out of a declared graph", () => {
    expect(problemsOf(leaf("canvas.choice@1", CHOICE_PROPS))).toContain('give it an "on" rule');
    expect(problemsOf(leaf("canvas.input@1", { label: "Ghi chú", kind: "text" }))).toContain('give it an "on" rule');
    const unwired = {
      kind: "stack",
      children: [
        leaf("canvas.choice@1", CHOICE_PROPS, { on: [{ event: "choice.change", steps: [{ op: "select-field", key: "metric", field: "value" }] }] }),
        leaf("canvas.search@1", { label: "Tìm" }),
        leaf("canvas.table@1"),
      ],
    };
    expect(problemsOf(unwired, STATE)).toContain("is a search box that writes no state");
  });

  it("refuses a rule that writes a key no one declared, with the reason, before anything is stored", () => {
    const wrong = leaf("canvas.choice@1", CHOICE_PROPS, { on: [{ event: "choice.change", steps: [{ op: "select-field", key: "chart", field: "value" }] }] });
    expect(problemsOf(wrong, STATE)).toContain('names state "chart", which the graph does not declare');
    const fed = { kind: "stack", children: [leaf("canvas.metrics@1", {}, { feed: [{ op: "query", key: "metric" }] })] };
    expect(problemsOf(fed, STATE)).toContain("canvas.metrics@1 reads nothing from a graph");
    expect(problemsOf(leaf("canvas.table@1", {}, { on: [] }), STATE)).toContain("on");
  });

  it("stores no graph for a search box placed without one, so it narrows its tables on the page only, as it always has", () => {
    const result = compile({ kind: "stack", children: [leaf("canvas.search@1", { label: "Tìm" }), leaf("canvas.table@1")] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.graph).toBeUndefined();
    const outcome = composeLayout(compose, {
      conversationId: CONVERSATION,
      messageId: "msg_plain_search",
      principalId: owner,
      intent: "",
      layout: { kind: "stack", children: [leaf("canvas.search@1", { label: "Tìm" }), leaf("canvas.table@1")] },
    });
    expect(outcome.ok).toBe(true);
    const spec = findCompositionByMessage(db(), "msg_plain_search", owner);
    expect(spec?.graph).toBeUndefined();
    expect(spec?.actions.some((action) => action.operation === "state.event")).toBe(false);
  });
});

describe("a person changing a linked surface", () => {
  const deps = (): GatewayDeps => ({ services, now: () => AT });
  const call = (method: string, path: string, body?: unknown): Promise<GatewayResponse> =>
    handleRequest(deps(), {
      method,
      path,
      query: {},
      headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
      body: body === undefined ? "" : JSON.stringify(body),
    });

  interface Live {
    revision: number;
    state: { graph?: Record<string, unknown> };
    semanticState: { values: Record<string, unknown>; summary: string } | null;
    spec: { graph?: { on: { sectionId: string }[] }; actions: { actionBindingId: string; sectionId: string; operation?: string }[] };
    bindings: { actionBindingId: string; bindingDigest: string }[];
    availability: Record<string, string>;
  }

  async function seed(): Promise<{ instanceId: string; live: Live }> {
    const outcome = composeLayout(compose, {
      conversationId: CONVERSATION,
      messageId: "msg_linked",
      principalId: owner,
      intent: "",
      layout: LINKED,
      state: STATE,
      title: "Bảng có liên kết",
    });
    expect(outcome.ok).toBe(true);
    const spec = findCompositionByMessage(db(), "msg_linked", owner);
    if (spec === undefined) throw new Error("no composition stored");
    const response = await call("GET", `/conversations/${CONVERSATION}/widgets/${spec.instanceId}/live`);
    expect(response.status).toBe(200);
    return { instanceId: spec.instanceId, live: response.body as Live };
  }

  function eventBinding(live: Live, sectionId: string) {
    const action = live.spec.actions.find((entry) => entry.sectionId === sectionId && entry.operation === "state.event");
    const binding = live.bindings.find((entry) => entry.actionBindingId === action?.actionBindingId);
    if (action === undefined || binding === undefined) throw new Error(`no state.event binding for ${sectionId}`);
    return binding;
  }

  it("binds one state.event action per wired leaf, and shows every section as live", async () => {
    const { live } = await seed();
    const wired = live.spec.graph?.on.map((rule) => rule.sectionId) ?? [];
    expect(wired).toHaveLength(2);
    for (const sectionId of wired) expect(() => eventBinding(live, sectionId)).not.toThrow();
    // A choice and a search box hold no rows, and that is not the same as their data being missing.
    for (const sectionId of wired) expect(live.availability[sectionId]).toBe("live");
    expect(live.semanticState?.values).toEqual({ metric: "completed", query: "" });
  });

  it("applies an event again on the node and keeps it across a reload, under the surface's revision", async () => {
    const { instanceId, live } = await seed();
    const choice = live.spec.graph?.on[0]?.sectionId ?? "";
    const binding = eventBinding(live, choice);
    const response = await call("POST", `/conversations/${CONVERSATION}/widgets/${instanceId}/actions`, {
      instanceId,
      actionBindingId: binding.actionBindingId,
      expectedRevision: live.revision,
      expectedBindingDigest: binding.bindingDigest,
      input: { event: "choice.change", payload: { value: "created" } },
      invocationId: "inv_choice_created",
    });
    expect(response.status).toBe(200);
    const acted = response.body as { revision: number; state: { graph?: Record<string, unknown> } };
    expect(acted.state.graph).toEqual({ metric: "created", query: "" });

    const reloaded = (await call("GET", `/conversations/${CONVERSATION}/widgets/${instanceId}/live`)).body as Live;
    expect(reloaded.state.graph).toEqual({ metric: "created", query: "" });
    expect(reloaded.semanticState?.summary).toContain('metric = "created"');

    // A second page that had not seen the change is told so, rather than overwriting it.
    const stale = await call("POST", `/conversations/${CONVERSATION}/widgets/${instanceId}/actions`, {
      instanceId,
      actionBindingId: binding.actionBindingId,
      expectedRevision: live.revision,
      expectedBindingDigest: binding.bindingDigest,
      input: { event: "choice.change", payload: { value: "completed" } },
      invocationId: "inv_choice_stale",
    });
    expect(stale.status).toBe(409);
  });

  it("keeps the picture a composed gallery picked, gives it to the carousel beside it, and says it to the model", async () => {
    for (const [index, altText] of ["Bến cảng", "Cánh đồng", "Ngọn hải đăng"].entries()) {
      insertLocalImage(db(), {
        imageId: `image_graph_${String(index)}`,
        ownerPrincipalId: owner,
        nodeId: services.runtime.identity.nodeId,
        artifactId: `art_graph_${String(index)}`,
        mimeType: "image/png",
        byteSize: 68,
        width: 1,
        height: 1,
        digest: `sha256:graph-${String(index)}`,
        altText,
        blobPath: `unused-graph-${String(index)}`,
        createdAt: new Date(Date.parse(AT) + index * 1000).toISOString() as Instant,
      });
    }
    const pick = [{ event: "media.select", steps: [{ op: "select-field", key: "picture", field: "selectedIndex" }] }];
    const outcome = composeLayout(compose, {
      conversationId: CONVERSATION,
      messageId: "msg_pictures",
      principalId: owner,
      intent: "",
      layout: { kind: "stack", children: [leaf("canvas.gallery@1", {}, { on: pick }), leaf("canvas.carousel@1", {}, { on: pick })] },
      state: { picture: { type: "number", initial: 0 } },
      title: "Ảnh đã nhập",
    });
    expect(outcome.ok).toBe(true);
    const spec = findCompositionByMessage(db(), "msg_pictures", owner);
    if (spec === undefined) throw new Error("no composition stored");
    const instanceId = spec.instanceId;
    const live = (await call("GET", `/conversations/${CONVERSATION}/widgets/${instanceId}/live`)).body as Live;
    expect(live.availability).toEqual({ "pictures-1": "live", "pictures-2": "live" });
    expect(live.semanticState?.values).toMatchObject({ picture: 0 });

    const binding = eventBinding(live, "pictures-1");
    const response = await call("POST", `/conversations/${CONVERSATION}/widgets/${instanceId}/actions`, {
      instanceId,
      actionBindingId: binding.actionBindingId,
      expectedRevision: live.revision,
      expectedBindingDigest: binding.bindingDigest,
      input: { event: "media.select", payload: { selectedIndex: 2 } },
      invocationId: "inv_picture_two",
    });
    expect(response.status).toBe(200);
    expect((response.body as { state: { graph?: Record<string, unknown> } }).state.graph).toEqual({ picture: 2 });
    const reloaded = (await call("GET", `/conversations/${CONVERSATION}/widgets/${instanceId}/live`)).body as Live;
    expect(reloaded.semanticState?.values).toMatchObject({ picture: 2 });

    // A picked picture that is not a number is not what the surface declared, and is refused.
    const wrong = await call("POST", `/conversations/${CONVERSATION}/widgets/${instanceId}/actions`, {
      instanceId,
      actionBindingId: binding.actionBindingId,
      expectedRevision: reloaded.revision,
      expectedBindingDigest: binding.bindingDigest,
      input: { event: "media.select", payload: { selectedIndex: "two" } },
      invocationId: "inv_picture_text",
    });
    expect(wrong.status).toBe(400);

    // Pictures the person removed are not drawn as broken images: the set says it is missing.
    for (const index of [0, 1, 2]) deleteLocalImage(db(), `image_graph_${String(index)}`, owner, AT);
    const emptied = (await call("GET", `/conversations/${CONVERSATION}/widgets/${instanceId}/live`)).body as Live;
    expect(emptied.availability).toEqual({ "pictures-1": "missing", "pictures-2": "missing" });
  });

  it("refuses an event its rules do not allow, and keeps nothing of it", async () => {
    const { instanceId, live } = await seed();
    const choice = live.spec.graph?.on[0]?.sectionId ?? "";
    const binding = eventBinding(live, choice);
    const attempt = (input: unknown, invocationId: string) =>
      call("POST", `/conversations/${CONVERSATION}/widgets/${instanceId}/actions`, {
        instanceId,
        actionBindingId: binding.actionBindingId,
        expectedRevision: live.revision,
        expectedBindingDigest: binding.bindingDigest,
        input,
        invocationId,
      });

    // The search box's event sent through the choice's binding: the node reads the section from the binding, not the page.
    const wrongEvent = await attempt({ event: "query.change", payload: { query: "acme" } }, "inv_wrong_event");
    expect(wrongEvent.status).toBe(400);
    expect((wrongEvent.body as { code: string }).code).toBe("INVALID_INPUT");
    // A list into a text key, a field the event does not carry, and a value the page claims directly.
    expect((await attempt({ event: "choice.change", payload: { value: ["a", "b"] } }, "inv_list")).status).toBe(400);
    expect((await attempt({ event: "choice.change", payload: { value: "x", extra: 1 } }, "inv_extra")).status).toBe(400);
    expect((await attempt({ event: "choice.change", payload: { value: "x" }, graph: { metric: "forged" } }, "inv_forged")).status).toBe(400);

    const after = (await call("GET", `/conversations/${CONVERSATION}/widgets/${instanceId}/live`)).body as Live;
    expect(after.state.graph ?? {}).not.toHaveProperty("metric", "forged");
    expect(after.semanticState?.values).toEqual({ metric: "completed", query: "" });
  });

  it("draws history with the graph as it was captured", async () => {
    await seed();
    const bundle = findBundleForMessage(db(), "msg_linked", owner);
    expect(bundle?.composition.graph?.state).toEqual(STATE);
  });

  it("tells a model how to wire state, through the composed view's notes", () => {
    const overview = buildViewCatalog(services.conductor, compose).find((view) => view.id === "canvas.overview@1");
    expect(overview?.notes).toContain("props.state");
    expect(overview?.notes).toContain("choice.change");
    expect(overview?.notes).toContain("filter-equals");
  });
});

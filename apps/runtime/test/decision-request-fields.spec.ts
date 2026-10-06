import { describe, expect, it } from "vitest";

import { SELECTOR_DATA_CLASSES, dataClassesOfText } from "@clarkcant/contracts";

import {
  type DecideDeps,
  decideContextFocus,
  decideModelRoute,
  decideProject,
  decideRuntimeTarget,
  decideSearchResult,
  decideSessionRebuild,
  decideToolFamily,
  decideTurnAction,
  guardOperation,
} from "../src/jev-decider.ts";
import { type JevConfig, type JevDeps, type JevTransport, createJevBudget, selectSections, selectTemplate } from "../src/jev-selector.ts";
import type { MiniAppCandidateSet } from "../src/mini-app-candidates.ts";

/**
 * Every field of every decision request, named and sorted into two kinds.
 *
 * `free` is text a person, a file or a record supplied. It must reach the provider within the selector's data classes,
 * which in practice means it went through `selectorText` / `sanitizeIntent` or a `selectorMayOffer` filter. `host` is
 * text the host wrote itself: ids, fixed instructions and option sentences, and catalogue descriptions (a model route's
 * `alias (provider/modelId)`, a template label, a narrowing description, a tool family's `about`). Those are exempt from
 * the data-class ceiling, because a dated model id reads as a phone number; the credential backstop still covers them.
 *
 * The list is exhaustive on purpose. A new field fails the shape assertion below until it is added here as one kind or
 * the other, so a free-text field cannot reach the provider without somebody deciding that it is held to the ceiling.
 */
type Kind = "free" | "host";

// Assembled here so no scanner reads a literal address in this file. Confidential, so above the selector's ceiling.
const ADDRESS = ["duy.nguyen", "mail.example.com"].join("@");
const PHONE = ["0912", "345", "678"].join("");
/** Free text carrying content above the ceiling, the way a person's message or a record would. */
const tainted = (prose: string): string => `${prose} gửi ${ADDRESS} hoặc gọi ${PHONE}`;

function config(): JevConfig {
  return {
    enabled: true,
    localOnly: false,
    apiKey: "sk-test-not-a-real-key",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    endpointRefusal: undefined,
    model: "jev-1.13.0",
    timeoutMs: 4000,
    maxCallsPerTurn: 4,
    policyVersion: "2026-09-17",
    confidenceFloor: 0.85,
    marginFloor: 0.2,
    noulOnFloor: 0.85,
    noulOffFloor: 0.15,
  };
}

/**
 * Records each request. A question named in `answers` gets that option decisively, so a decision that asks a second
 * question (a guardrail narrowing, a search's ambiguity check) is driven to it; anything else is a 529.
 */
function recording(answers: Readonly<Record<string, string>> = {}): { transport: JevTransport; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const transport: JevTransport = async (request) => {
    bodies.push(request.body);
    const questions = (request.body as { questions: Record<string, { criteria: Record<string, unknown> }> }).questions;
    const [questionId, question] = Object.entries(questions)[0]!;
    const choice = answers[questionId];
    if (choice === undefined) return { status: 529, body: undefined };
    const options = Object.keys(question.criteria);
    const probabilities = Object.fromEntries(options.map((option) => [option, option === choice ? 0.97 : 0.03 / (options.length - 1)]));
    return {
      status: 200,
      body: { model: "jev-1.13.0", answers: { [questionId]: { type: "choice", choice, probabilities, confidence: 0.97 } } },
    };
  };
  return { transport, bodies };
}

function decideDeps(transport: JevTransport): DecideDeps {
  const conf = config();
  return { jev: { config: conf, transport }, budget: () => createJevBudget(conf) };
}

function jevDeps(transport: JevTransport): JevDeps {
  return { config: config(), transport };
}

/** Each leaf of a request as a path: array items as `[]`, option keys as `*`, since both are lists the host builds. */
function leaves(value: unknown, path: string, out: Map<string, string[]>): void {
  if (Array.isArray(value)) {
    for (const item of value) leaves(item, `${path}[]`, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      const segment = path.endsWith(".criteria") || path === "questions" ? "*" : key;
      leaves(inner, path === "" ? segment : `${path}.${segment}`, out);
    }
    return;
  }
  const texts = out.get(path) ?? [];
  texts.push(String(value));
  out.set(path, texts);
}

interface Case {
  name: string;
  /** Makes the decision with every free-text input tainted, and returns the requests it sent. */
  run: () => Promise<unknown[]>;
  fields: Readonly<Record<string, Kind>>;
}

const candidateSet: MiniAppCandidateSet = {
  locale: "vi-VN",
  templates: [
    { templateId: "overview", templateVersion: "1.0.0", label: "Tổng quan", slots: ["metrics", "trend"] },
    { templateId: "board", templateVersion: "1.0.0", label: "Bảng việc", slots: ["list"] },
  ],
  definitions: [
    { id: "chart.bar", version: "1.0.0", family: "trend", fields: ["series:number[]"] },
    { id: "chart.line", version: "1.0.0", family: "trend", fields: ["series:number[]"] },
  ],
  data: [{ ref: "data:tasks", kind: "tasks", label: tainted("việc của tôi"), scale: "small", freshness: "live" }],
};

/** The parts every request has, whichever decision made it. */
const ENVELOPE: Readonly<Record<string, Kind>> = {
  model: "host",
  "questions.*.type": "host",
  "questions.*.instructions": "host",
};

/**
 * One case per decision function. The shape check only sees requests a case makes, so a new decision function (or a new
 * question an existing one asks) is unchecked until it has its own case here, driven far enough to send that request.
 */
const CASES: readonly Case[] = [
  {
    name: "runtime target",
    run: async () => {
      const { transport, bodies } = recording();
      const running = (id: string, describe: string) => ({ id, kind: "task" as const, label: tainted("nhãn"), capabilities: [], live: true, load: 0, describe });
      await decideRuntimeTarget(decideDeps(transport), {
        intent: tainted("dừng việc đang chạy"),
        candidates: [running("runtime:task:a", tainted("việc a")), running("runtime:task:b", tainted("việc b"))],
      });
      return bodies;
    },
    fields: {
      "state.intent": "free",
      "state.running[].id": "host",
      "state.running[].kind": "host",
      "state.running[].busy": "host",
      "questions.*.criteria.*": "free",
    },
  },
  {
    name: "project",
    run: async () => {
      const { transport, bodies } = recording();
      const project = (id: string) => ({ id, name: tainted("du-an"), relPath: tainted("code"), kind: "node", markers: [tainted("package.json")] });
      await decideProject(decideDeps(transport), { intent: tainted("mở dự án"), candidates: [project("project:a"), project("project:b")] });
      return bodies;
    },
    fields: {
      "state.intent": "free",
      "state.candidates[].id": "host",
      "state.candidates[].name": "free",
      "state.candidates[].kind": "host",
      "questions.*.criteria.*": "free",
    },
  },
  {
    name: "operation guard, both questions",
    run: async () => {
      const { transport, bodies } = recording({ "guard-operation": "constrain" });
      await guardOperation(decideDeps(transport), {
        intent: tainted("xoá thư mục tạm"),
        operation: tainted("rm -r build"),
        state: { effect: "destructive", cwdScope: tainted("project") },
        instructions: tainted("đừng xoá gì ngoài dự án"),
        constraints: [{ id: "only-build", description: "chỉ trong thư mục build" }],
      });
      expect(bodies).toHaveLength(2);
      return bodies;
    },
    fields: {
      "state.intent": "free",
      "state.operation": "free",
      // The caller's named facts, each sanitised as free text.
      "state.effect": "free",
      "state.cwdScope": "free",
      // Fixed lines, with the person's own rules appended through `selectorText`.
      "questions.*.instructions": "free",
      // Fixed option sentences, and the narrowing descriptions the host offers.
      "questions.*.criteria.*": "host",
    },
  },
  {
    name: "model route",
    run: async () => {
      const { transport, bodies } = recording();
      await decideModelRoute(decideDeps(transport), {
        task: tainted("tóm tắt báo cáo"),
        role: "worker",
        candidates: [
          { alias: "fast", description: "fast (anthropic/claude-haiku-4-5-20251001)" },
          { alias: "deep", description: "deep (anthropic/claude-sonnet-4-5-20250929)" },
        ],
      });
      return bodies;
    },
    fields: { "state.task": "free", "state.role": "host", "questions.*.criteria.*": "host" },
  },
  {
    name: "turn action",
    run: async () => {
      const { transport, bodies } = recording();
      await decideTurnAction(decideDeps(transport), { text: tainted("thôi dừng lại"), runningMs: 12_000 });
      return bodies;
    },
    fields: { "state.message": "free", "state.runningForSeconds": "host", "questions.*.criteria.*": "host" },
  },
  {
    name: "context focus",
    run: async () => {
      const { transport, bodies } = recording();
      await decideContextFocus(decideDeps(transport), {
        query: tainted("báo cáo tuần"),
        candidates: [
          { id: "memory:a", text: "báo cáo tuần gửi thứ sáu" },
          { id: "memory:b", text: "báo cáo tuần dùng mẫu mới" },
          { id: "memory:c", text: tainted("báo cáo tuần") },
        ],
      });
      return bodies;
    },
    fields: { "state.message": "free", "questions.*.criteria.*": "free" },
  },
  {
    name: "tool family",
    run: async () => {
      const { transport, bodies } = recording();
      await decideToolFamily(decideDeps(transport), {
        text: tainted("mở trang web"),
        families: { browser: "điều khiển trình duyệt", files: "đọc và sửa tệp" },
      });
      return bodies;
    },
    fields: { "state.message": "free", "questions.*.criteria.*": "host" },
  },
  {
    name: "session rebuild",
    run: async () => {
      const { transport, bodies } = recording();
      await decideSessionRebuild(decideDeps(transport), { idleSeconds: 900, contextTokens: 80_000, topicShift: 0.4, turns: 12 });
      return bodies;
    },
    fields: {
      "state.idleSeconds": "host",
      "state.contextTokens": "host",
      "state.newTermShare": "host",
      "state.turnsSoFar": "host",
      "questions.*.criteria.*": "host",
    },
  },
  {
    name: "search result, both questions",
    run: async () => {
      const { transport, bodies } = recording({ result: "none" });
      const result = (ref: string, snippet: string) => ({ ref, snippet, score: -0.000002, source: "message" });
      await decideSearchResult(decideDeps(transport), {
        query: tainted("lỗi đăng nhập"),
        results: [result("msg_a", "sửa lỗi đăng nhập"), result("msg_b", "lỗi đăng nhập lần hai"), result("msg_c", tainted("lỗi đăng nhập"))],
      });
      expect(bodies).toHaveLength(2);
      return bodies;
    },
    fields: { "state.query": "free", "state.resultCount": "host", "questions.*.criteria.*": "free" },
  },
  {
    name: "presentation template",
    run: async () => {
      const { transport, bodies } = recording();
      await selectTemplate(jevDeps(transport), {
        intent: tainted("cho xem tiến độ"),
        candidateSet,
        budget: createJevBudget(config()),
      });
      return bodies;
    },
    fields: {
      "state.intent": "free",
      "state.locale": "host",
      "state.templates[].id": "host",
      "state.templates[].label": "host",
      "state.templates[].slots[]": "host",
      "state.definitions[].id": "host",
      "state.definitions[].kind": "host",
      "state.definitions[].fields[]": "host",
      "state.data[].ref": "host",
      "state.data[].kind": "host",
      "state.data[].scale": "host",
      "state.data[].freshness": "host",
      "questions.*.criteria.*": "host",
    },
  },
  {
    name: "section renderers",
    run: async () => {
      const { transport, bodies } = recording();
      await selectSections(jevDeps(transport), {
        intent: tainted("cho xem tiến độ"),
        candidateSet,
        template: { templateId: "overview", templateVersion: "1.0.0", slots: ["metrics", "trend"] },
        budget: createJevBudget(config()),
      });
      return bodies;
    },
    fields: {
      "state.intent": "free",
      "state.locale": "host",
      "state.templates[].id": "host",
      "state.templates[].label": "host",
      "state.templates[].slots[]": "host",
      "state.definitions[].id": "host",
      "state.definitions[].kind": "host",
      "state.definitions[].fields[]": "host",
      "state.data[].ref": "host",
      "state.data[].kind": "host",
      "state.data[].scale": "host",
      "state.data[].freshness": "host",
      "questions.*.criteria.*": "host",
    },
  },
];

describe("every field of every decision request", () => {
  it.each(CASES)("$name: names each field, and holds each free-text one to the selector's ceiling", async ({ run, fields }) => {
    const bodies = await run();
    expect(bodies.length).toBeGreaterThan(0);

    const declared = { ...ENVELOPE, ...fields };
    const seen = new Map<string, string[]>();
    for (const body of bodies) leaves(body, "", seen);
    // A field nobody has classified fails here, before anything is said about its content.
    expect([...seen.keys()].sort()).toEqual(Object.keys(declared).sort());

    for (const [path, texts] of seen) {
      if (declared[path] !== "free") continue;
      for (const text of texts) {
        expect(text, path).not.toContain(ADDRESS);
        expect(text, path).not.toContain(PHONE);
        for (const dataClass of dataClassesOfText(text)) expect(SELECTOR_DATA_CLASSES, `${path}: ${text}`).toContain(dataClass);
      }
    }
    // Nothing above the ceiling travels anywhere in the request either, host fields included.
    for (const body of bodies) {
      expect(JSON.stringify(body)).not.toContain(ADDRESS);
      expect(JSON.stringify(body)).not.toContain(PHONE);
    }
  });
});

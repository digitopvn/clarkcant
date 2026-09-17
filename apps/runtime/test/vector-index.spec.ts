import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";
import {
  countEmbeddings,
  indexHistory,
  migrate,
  openDatabase,
  searchEmbedding,
  type Database,
} from "@clarkcant/storage";

import type { EmbeddingProvider } from "../src/embeddings-local.ts";
import {
  createVectorIndexService,
  embedMissingHistory,
  loadVectorExtension,
  semanticSearchFromEnv,
  vectorIndexStatus,
} from "../src/vector-index.ts";

/**
 * The vector index (Phase 10).
 *
 * What matters here is that the optional half of retrieval fails *legibly*: no extension, no model, a
 * model that changed, or a model that produces the wrong width must each produce a reason a node can
 * print, and none of them may throw or leave the index in a state that mixes models.
 */

const AT = "2026-09-17T05:00:00.000Z" as Instant;
const PRINCIPAL = "prin_owner";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-vector-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A dims-wide provider whose vector is the same for every input, which is enough for plumbing. */
function constantProvider(input: { dims: number; model?: string }): EmbeddingProvider {
  return {
    model: input.model ?? "test/embedder",
    dims: input.dims,
    digest: "sha256:embedding:test",
    embed: (texts) => Promise.resolve(texts.map(() => new Array<number>(input.dims).fill(0.5))),
  };
}

function seedHistory(refs: readonly string[]): void {
  for (const ref of refs) {
    indexHistory(db, {
      source: "message",
      ref,
      text: `nội dung của ${ref}`,
      principalId: PRINCIPAL,
      createdAt: AT,
    });
  }
}

describe("the semantic flag", () => {
  it("is off unless asked for by name", () => {
    expect(semanticSearchFromEnv({})).toBe(false);
    expect(semanticSearchFromEnv({ CLARKCANT_SEARCH_SEMANTIC: "0" })).toBe(false);
    expect(semanticSearchFromEnv({ CLARKCANT_SEARCH_SEMANTIC: "maybe" })).toBe(false);
    expect(semanticSearchFromEnv({ CLARKCANT_SEARCH_SEMANTIC: "1" })).toBe(true);
    expect(semanticSearchFromEnv({ CLARKCANT_SEARCH_SEMANTIC: "TRUE" })).toBe(true);
  });
});

describe("the extension", () => {
  it("loads and reports its version, or names what is missing", () => {
    const extension = loadVectorExtension(db);
    if (!extension.ok) {
      // On a machine without the optional dependency this is the expected outcome, and it is a
      // reported one: search stays lexical and the reason travels with it.
      expect(extension.reason.length).toBeGreaterThan(0);
      return;
    }
    expect(extension.version.startsWith("v")).toBe(true);
  });

  it("survives being loaded twice into the same connection", () => {
    const first = loadVectorExtension(db);
    if (!first.ok) return;
    const second = loadVectorExtension(db);
    expect(second.ok).toBe(true);
  });
});

describe("index status", () => {
  const deps = (overrides: Partial<Parameters<typeof vectorIndexStatus>[0]> = {}) => ({
    db,
    principalId: PRINCIPAL,
    enabled: true,
    provider: constantProvider({ dims: 4 }),
    now: () => AT,
    ...overrides,
  });

  it("says the flag is off rather than pretending to have no model", () => {
    const status = vectorIndexStatus(deps({ enabled: false }), { ok: true, version: "v0.1.9" });
    expect(status.enabled).toBe(false);
    expect(status.reason).toContain("off");
  });

  it("passes the extension's own reason through", () => {
    const status = vectorIndexStatus(deps(), { ok: false, reason: "sqlite-vec is not installed" });
    expect(status.enabled).toBe(false);
    expect(status.reason).toBe("sqlite-vec is not installed");
  });

  it("refuses to mix vectors from a different model", async () => {
    const extension = loadVectorExtension(db);
    if (!extension.ok) return;
    seedHistory(["msg_a"]);

    // Index with one model, then ask whether a second one may be used. It may not: 384 vectors from
    // one model next to 384 from another would rank by a distance that means nothing.
    await embedMissingHistory(deps({ provider: constantProvider({ dims: 4, model: "first/model" }) }), extension);
    const status = vectorIndexStatus(deps({ provider: constantProvider({ dims: 4, model: "second/model" }) }), extension);
    expect(status.enabled).toBe(false);
    expect(status.reason).toContain("reindex");
  });

  it("refuses a table whose width does not match the model", async () => {
    const extension = loadVectorExtension(db);
    if (!extension.ok) return;
    seedHistory(["msg_a"]);
    await embedMissingHistory(deps(), extension);
    const status = vectorIndexStatus(deps({ provider: constantProvider({ dims: 8 }) }), extension);
    expect(status.enabled).toBe(false);
    expect(status.reason).toMatch(/reindex|holds/);
  });

  it("reports how much of the index has a vector", async () => {
    const extension = loadVectorExtension(db);
    if (!extension.ok) return;
    seedHistory(["msg_a", "msg_b"]);
    const empty = vectorIndexStatus(deps(), extension);
    expect(empty.embedded).toBe(0);

    await embedMissingHistory(deps(), extension);
    const filled = vectorIndexStatus(deps(), extension);
    expect(filled.embedded).toBe(2);
    expect(countEmbeddings(db, PRINCIPAL)).toBe(2);
  });
});

describe("the embed pass", () => {
  it("embeds what is missing and does nothing the second time", async () => {
    const extension = loadVectorExtension(db);
    if (!extension.ok) {
      console.warn(`BLOCKED: ${extension.reason}`);
      return;
    }
    seedHistory(["msg_a", "msg_b", "msg_c"]);
    const first = await embedMissingHistory(
      { db, principalId: PRINCIPAL, enabled: true, provider: constantProvider({ dims: 4 }), now: () => AT },
      extension,
    );
    expect(first.embedded).toBe(3);

    const second = await embedMissingHistory(
      { db, principalId: PRINCIPAL, enabled: true, provider: constantProvider({ dims: 4 }), now: () => AT },
      extension,
    );
    // Resumable by construction: the pass takes what is missing, so a re-run is free.
    expect(second.embedded).toBe(0);
  });

  it("searches what it embedded", async () => {
    const extension = loadVectorExtension(db);
    if (!extension.ok) {
      console.warn(`BLOCKED: ${extension.reason}`);
      return;
    }
    seedHistory(["msg_a"]);
    await embedMissingHistory(
      { db, principalId: PRINCIPAL, enabled: true, provider: constantProvider({ dims: 4 }), now: () => AT },
      extension,
    );
    const hits = searchEmbedding(db, { values: [0.5, 0.5, 0.5, 0.5], limit: 3, principalId: PRINCIPAL });
    expect(hits.map((hit) => hit.ref)).toEqual(["msg_a"]);
  });

  it("does not read another principal's rows", async () => {
    const extension = loadVectorExtension(db);
    if (!extension.ok) return;
    indexHistory(db, {
      source: "message",
      ref: "msg_other",
      text: "của người khác",
      principalId: "prin_someone_else",
      createdAt: AT,
    });
    // The other principal's row IS in the vector index, so what this asserts is the filter rather
    // than the absence of data.
    const otherEmbedded = await embedMissingHistory(
      {
        db,
        principalId: "prin_someone_else",
        enabled: true,
        provider: constantProvider({ dims: 4 }),
        now: () => AT,
      },
      extension,
    );
    expect(otherEmbedded.embedded).toBe(1);

    const hits = searchEmbedding(db, { values: [0.5, 0.5, 0.5, 0.5], limit: 5, principalId: PRINCIPAL });
    expect(hits).toEqual([]);
  });
});

describe("the service", () => {
  it("loads the model once, even when several calls race", async () => {
    const extension = loadVectorExtension(db);
    if (!extension.ok) return;
    let loads = 0;
    const service = createVectorIndexService(
      { db, principalId: PRINCIPAL, enabled: true, now: () => AT },
      extension,
      () => {
        loads += 1;
        return Promise.resolve(constantProvider({ dims: 4 }));
      },
    );
    await Promise.all([service.ensure(), service.ensure(), service.ensure()]);
    expect(loads).toBe(1);
    expect(service.status().enabled).toBe(true);
  });

  it("turns a loader failure into a reason instead of an exception", async () => {
    const service = createVectorIndexService(
      { db, principalId: PRINCIPAL, enabled: true, now: () => AT },
      { ok: true, version: "v0.1.9" },
      () => Promise.reject(new Error("download failed")),
    );
    const status = await service.ensure();
    expect(status.enabled).toBe(false);
    expect(status.reason).toContain("could not be loaded");
    expect(service.semantic().reason).toContain("could not be loaded");
  });

  it("does not load a model when the flag is off", async () => {
    let loads = 0;
    const service = createVectorIndexService(
      { db, principalId: PRINCIPAL, enabled: false, now: () => AT },
      { ok: true, version: "v0.1.9" },
      () => {
        loads += 1;
        return Promise.resolve(constantProvider({ dims: 4 }));
      },
    );
    const status = await service.ensure();
    expect(loads).toBe(0);
    expect(status.enabled).toBe(false);
  });
});

import { createRequire } from "node:module";

import type { Database } from "@clarkcant/storage";
import {
  countEmbeddings,
  embeddingIndexState,
  ensureEmbeddingTable,
  historyMissingEmbedding,
  insertEmbedding,
  upsertEmbeddingMeta,
} from "@clarkcant/storage";

import type { EmbeddingProvider } from "./embeddings-local.ts";

/**
 * The vector index (Phase 10).
 *
 * Everything here is optional by design. A node without sqlite-vec, without the embedding runtime,
 * or with the semantic flag off must search lexically and say why — so every entry point returns a
 * *status* rather than throwing, and the only hard failure is a database that cannot be written.
 *
 * Two rules are load-bearing:
 *
 * - **The extension is loaded into the process that opens the database, once.** `vec0` is only
 *   available on a connection that loaded it, so a second connection that forgot to load it would
 *   see a table it cannot query.
 * - **Vectors from another model are refused, not mixed.** A model change means a reindex; silently
 *   adding 384-dimension vectors next to a different model's would corrupt every ranked result.
 */

export type VectorExtension =
  | { ok: true; version: string }
  | { ok: false; reason: string };

/**
 * Load sqlite-vec into this connection.
 *
 * The import is dynamic because the package is an optional dependency: on a machine that does not
 * have it, the import itself is the probe.
 */
export function loadVectorExtension(db: Database): VectorExtension {
  let path: string;
  try {
    // `createRequire` rather than `import`, because the package is CommonJS with a native artifact and
    // no ESM entry point: a static import would make the dependency mandatory, and this layer has to
    // work on a machine that never installed it.
    const loaded = createRequire(import.meta.url)("sqlite-vec") as { getLoadablePath?: () => string };
    if (typeof loaded.getLoadablePath !== "function") {
      return { ok: false, reason: "sqlite-vec is installed but exposes no library path" };
    }
    path = loaded.getLoadablePath();
  } catch {
    return { ok: false, reason: "sqlite-vec is not installed (optional dependency)" };
  }

  try {
    db.loadExtension(path);
    const row = db.prepare("SELECT vec_version() AS version").get() as { version?: string } | undefined;
    return { ok: true, version: String(row?.version ?? "unknown") };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, reason: `sqlite-vec could not be loaded: ${detail.slice(0, 160)}` };
  }
}

export interface VectorIndexDeps {
  db: Database;
  principalId: string;
  /** Absent when the node has no local embedder, which is a supported state. */
  provider?: EmbeddingProvider;
  /** Why there is no provider, when there is none. */
  providerReason?: string;
  /** Off unless the operator turned it on. */
  enabled: boolean;
  now: () => string;
}

export interface VectorIndexStatus {
  enabled: boolean;
  /** Always set when `enabled` is false: a reason, not a silent no-op. */
  reason?: string;
  extensionVersion?: string;
  model?: string;
  digest?: string;
  dims?: number;
  /** How many indexed history rows have a vector. */
  embedded: number;
  /** How many indexed history rows have none yet. */
  indexSize: number;
}

/** Resolve the current state of the vector index, including why it is off. */
export function vectorIndexStatus(deps: VectorIndexDeps, extension: VectorExtension): VectorIndexStatus {
  const state = embeddingIndexState(deps.db, deps.principalId);
  const indexSize = countEmbeddings(deps.db, deps.principalId);
  if (!deps.enabled) {
    return { enabled: false, reason: "semantic search is off for this node", embedded: state.count, indexSize };
  }
  if (!extension.ok) {
    return { enabled: false, reason: extension.reason, embedded: state.count, indexSize };
  }
  if (deps.provider === undefined) {
    return {
      enabled: false,
      reason: deps.providerReason ?? "this node has no local embedding model",
      extensionVersion: extension.version,
      embedded: state.count,
      indexSize,
    };
  }
  if (state.model !== undefined && (state.model !== deps.provider.model || state.dims !== deps.provider.dims)) {
    return {
      enabled: false,
      reason: `the index holds vectors from ${state.model}; reindex before using ${deps.provider.model}`,
      extensionVersion: extension.version,
      embedded: state.count,
      indexSize,
    };
  }
  return {
    enabled: true,
    extensionVersion: extension.version,
    model: deps.provider.model,
    digest: deps.provider.digest,
    dims: deps.provider.dims,
    embedded: state.count,
    indexSize,
  };
}

/** Whether the operator turned semantic search on. Off unless asked for by name. */
export function semanticSearchFromEnv(env: Record<string, string | undefined>): boolean {
  const value = (env.CLARKCANT_SEARCH_SEMANTIC ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export interface VectorIndexService {
  /** The current state, including why it is off. */
  status(): VectorIndexStatus;
  /** The shape `SessionSearchDeps` wants, read at call time so a late model load is picked up. */
  semantic(): { enabled: boolean; provider?: EmbeddingProvider; reason?: string };
  /** Load the model once, then embed whatever history has no vector yet. */
  ensure(): Promise<VectorIndexStatus>;
}

/**
 * The vector index as a service.
 *
 * The embedder is loaded on first use and held, because loading it is the expensive part and a node
 * should not pay for it on a search that will not happen. Boot calls `ensure()` without awaiting it:
 * a node that is still loading its model must still answer lexical searches.
 */
export function createVectorIndexService(
  deps: VectorIndexDeps,
  extension: VectorExtension,
  loader: () => Promise<EmbeddingProvider | undefined>,
): VectorIndexService {
  let provider = deps.provider;
  let providerReason = deps.providerReason;
  let loading: Promise<VectorIndexStatus> | undefined;

  // Spread conditionally: `exactOptionalPropertyTypes` distinguishes "absent" from "present and
  // undefined", and the deps type means "absent" for both of these.
  const current = (): VectorIndexDeps => ({
    ...deps,
    ...(provider === undefined ? {} : { provider }),
    ...(providerReason === undefined ? {} : { providerReason }),
  });

  return {
    status(): VectorIndexStatus {
      return vectorIndexStatus(current(), extension);
    },
    semantic() {
      const status = vectorIndexStatus(current(), extension);
      return {
        enabled: status.enabled,
        ...(provider === undefined ? {} : { provider }),
        ...(status.reason === undefined ? {} : { reason: status.reason }),
      };
    },
    ensure(): Promise<VectorIndexStatus> {
      loading ??= (async () => {
        if (deps.enabled && extension.ok && provider === undefined) {
          try {
            provider = await loader();
            if (provider === undefined) {
              providerReason ??= "this node has no local embedding model";
            }
          } catch (cause) {
            const detail = cause instanceof Error ? cause.message : String(cause);
            providerReason = `the local embedding model could not be loaded: ${detail.slice(0, 160)}`;
          }
        }
        if (vectorIndexStatus(current(), extension).enabled) {
          try {
            await embedMissingHistory(current(), extension);
          } catch (cause) {
            // A failed embed pass leaves the index behind the history, which is a state the status
            // reports; it does not make the node stop working.
            const detail = cause instanceof Error ? cause.message : String(cause);
            providerReason = `embedding history failed: ${detail.slice(0, 160)}`;
          }
        }
        return vectorIndexStatus(current(), extension);
      })();
      return loading;
    },
  };
}

export interface EmbedPassResult {
  embedded: number;
  reason?: string;
}

/**
 * Embed the history rows that have no vector yet.
 *
 * Resumable by construction: it takes whichever rows are missing rather than a cursor, so a pass
 * interrupted by a crash continues where it stopped, and a pass that runs twice does no work the
 * second time.
 */
export async function embedMissingHistory(
  deps: VectorIndexDeps,
  extension: VectorExtension,
  options: { batchSize?: number; limit?: number } = {},
): Promise<EmbedPassResult> {
  const status = vectorIndexStatus(deps, extension);
  if (!status.enabled || deps.provider === undefined) {
    return { embedded: 0, ...(status.reason === undefined ? {} : { reason: status.reason }) };
  }
  const batchSize = options.batchSize ?? 16;
  const limit = options.limit ?? 128;

  const missing = historyMissingEmbedding(deps.db, {
    principalId: deps.principalId,
    model: deps.provider.model,
    limit,
  });
  if (missing.length === 0) return { embedded: 0 };

  const guard = ensureEmbeddingTable(deps.db, deps.provider.dims);
  if (!guard.ok) return { embedded: 0, reason: guard.reason };

  let embedded = 0;
  for (let offset = 0; offset < missing.length; offset += batchSize) {
    const batch = missing.slice(offset, offset + batchSize);
    const vectors = await deps.provider.embed(
      batch.map((entry) => entry.text),
      "passage",
    );
    batch.forEach((entry, index) => {
      const vector = vectors[index];
      if (vector === undefined) return;
      const vecRowid = insertEmbedding(deps.db, vector);
      upsertEmbeddingMeta(deps.db, {
        source: entry.source,
        ref: entry.ref,
        principalId: deps.principalId,
        model: deps.provider?.model ?? "",
        dims: deps.provider?.dims ?? vector.length,
        digest: deps.provider?.digest ?? "",
        vecRowid,
        createdAt: entry.createdAt,
      });
      embedded += 1;
    });
  }
  return { embedded };
}

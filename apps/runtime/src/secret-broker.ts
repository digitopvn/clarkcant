import type { Instant } from "@clarkcant/contracts";
import {
  type Database,
  type SecretMetadata,
  getSecretMetadata,
  markSecretUsed,
  secretBackendFor,
} from "@clarkcant/storage";

/**
 * Just in time: the value exists for the length of one call and nowhere else.
 *
 * The rule this module exists to keep is that a secret is never *held*. Not by the broker, not by a turn, not by
 * the model: it goes from the backend into the thing that needs it, inside one invocation, and the only thing that
 * survives is the metadata — the name, what it was for, and the fact that it was used.
 *
 * That is why every method here takes a callback or returns the narrow shape its consumer needs rather than
 * returning the value. `withSecret` gives the value to a function that runs and returns; `environmentFor` builds a
 * child process's environment; `headersFor` builds request headers. There is no `read(name)` on purpose: a
 * general-purpose read is the function that ends up called from a log line.
 */

/**
 * How a secret is allowed to reach the thing that uses it.
 *
 * The order matters. `tool-only` is the floor and the default: the value goes into the call and is gone.
 * `process-env` and `http-header` are for callers that can only receive a value in one of those two shapes.
 * `agent-context` is the ceiling and the one that must be asked for by name, because it is the only mode that puts
 * a value somewhere it cannot be taken back from.
 */
export type SecretExposure = "tool-only" | "process-env" | "http-header" | "agent-context";

export const SECRET_EXPOSURES: readonly SecretExposure[] = ["tool-only", "process-env", "http-header", "agent-context"];

export interface SecretUseRequest {
  name: string;
  /**
   * Who is asking, in the vocabulary the metadata stores: `command:git`, `capability:github`.
   *
   * Required rather than optional, so every use is attributed. A blank consumer would make the allowlist
   * unenforceable for exactly the callers that forgot to say who they were.
   */
  consumer: string;
  exposure: SecretExposure;
}

export type SecretDenialCode =
  | "SECRET_NOT_FOUND"
  | "CONSUMER_NOT_ALLOWED"
  | "EXPOSURE_NOT_ALLOWED"
  | "BACKEND_UNAVAILABLE";

export type SecretDenial = { ok: false; code: SecretDenialCode; message: string };

export interface SecretBrokerDeps {
  db: Database;
  principalId: string;
  now: () => Instant;
  /**
   * Where a use is written down, when this node keeps a trail.
   *
   * Called with the secret's *name* and who used it — never the value, and never anything derived from it. That is
   * the whole reason a use is auditable at all: an operator can see that `github_token` was handed to `command:git`
   * without the record being another copy of the secret.
   */
  audit?: (event: { summary: string; ref: string }) => void;
}

/**
 * Whether this exposure reaches further than the metadata allows.
 *
 * `tool-only` is always permitted: it is what the policy means when it says nothing else. Beyond that the policy
 * has to name the mode — a policy of `process-env` does not authorise `http-header`, because the two are different
 * places for a value to exist and an operator who chose one did not choose the other. `agent-context` authorises
 * everything, since a policy that permits the widest exposure permits the narrower ones.
 */
function exposureAllowed(policy: string, requested: SecretExposure): boolean {
  if (requested === "tool-only") return true;
  if (policy === "agent-context") return true;
  return policy === requested;
}

function resolve(
  deps: SecretBrokerDeps,
  request: SecretUseRequest,
): { ok: true; metadata: SecretMetadata; value: string } | SecretDenial {
  const metadata = getSecretMetadata(deps.db, deps.principalId, request.name);
  if (metadata === undefined) {
    return { ok: false, code: "SECRET_NOT_FOUND", message: `node này chưa có secret “${request.name}”.` };
  }

  // An empty list means nobody recorded a consumer, which is how every secret stored before this existed looks. It
  // is treated as unrestricted rather than as "nobody may use it": a rule that quietly disables existing secrets
  // would be discovered as an outage rather than as a policy.
  const consumer = request.consumer.trim();
  if (metadata.allowedConsumers.length > 0 && !metadata.allowedConsumers.includes(consumer)) {
    return {
      ok: false,
      code: "CONSUMER_NOT_ALLOWED",
      message: `“${request.name}” không cho phép ${consumer === "" ? "consumer không tên" : consumer} dùng nó.`,
    };
  }

  if (!exposureAllowed(metadata.injectionPolicy, request.exposure)) {
    return {
      ok: false,
      code: "EXPOSURE_NOT_ALLOWED",
      message: `“${request.name}” chỉ cho phép ${metadata.injectionPolicy}, không cho phép ${request.exposure}.`,
    };
  }

  // No silent downgrade: a row that names a backend this build does not have is reported, not read from the node
  // store instead.
  const backend = secretBackendFor(deps.db, deps.principalId, metadata.backend);
  if (backend === undefined) {
    return { ok: false, code: "BACKEND_UNAVAILABLE", message: `Không có backend ${metadata.backend} trong build này.` };
  }
  const value = backend.read(metadata.backendRef);
  if (value === undefined) {
    return { ok: false, code: "SECRET_NOT_FOUND", message: `“${request.name}” có metadata nhưng không còn giá trị.` };
  }

  markSecretUsed(deps.db, deps.principalId, request.name, deps.now());
  deps.audit?.({
    summary: `dùng secret “${request.name}” cho ${request.consumer} qua ${request.exposure}`,
    ref: request.name,
  });
  return { ok: true, metadata, value };
}

export interface SecretBroker {
  /**
   * Run something with the value, and nothing else.
   *
   * The value lives on the stack of `use` and in whatever `use` builds. Note what is *not* returned: the value.
   * The result is whatever the caller produced, so a caller that wants the value in a payload has to write that
   * explicitly — and a reviewer can see it.
   */
  withSecret<T>(
    request: Omit<SecretUseRequest, "exposure"> & { exposure?: SecretExposure },
    use: (value: string, metadata: SecretMetadata) => T,
  ): { ok: true; result: T } | SecretDenial;

  /** The environment for one child process. The caller must not print it. */
  environmentFor(
    request: Omit<SecretUseRequest, "exposure">,
    variable: string,
  ): { ok: true; env: Record<string, string> } | SecretDenial;

  /** The header for one request. The caller must not print it. */
  headersFor(
    request: Omit<SecretUseRequest, "exposure">,
    header: string,
  ): { ok: true; headers: Record<string, string> } | SecretDenial;
}

export function createSecretBroker(deps: SecretBrokerDeps): SecretBroker {
  return {
    withSecret: (request, use) => {
      const exposure = request.exposure ?? "tool-only";
      const found = resolve(deps, { ...request, exposure });
      if (!found.ok) return found;
      return { ok: true, result: use(found.value, found.metadata) };
    },
    environmentFor: (request, variable) => {
      const found = resolve(deps, { ...request, exposure: "process-env" });
      if (!found.ok) return found;
      return { ok: true, env: { [variable]: found.value } };
    },
    headersFor: (request, header) => {
      const found = resolve(deps, { ...request, exposure: "http-header" });
      if (!found.ok) return found;
      return { ok: true, headers: { [header]: found.value } };
    },
  };
}

/**
 * The one place a value is allowed into a model's context.
 *
 * Written as a separate function rather than an option on `withSecret` so that the call site says what it is: this
 * is the exception, it is named, and it is the only function in the codebase whose return value contains a secret.
 * A caller that uses it has to have asked for `agent-context` in the metadata as well, which is the operator's
 * consent rather than the caller's.
 */
export function agentContextSecret(
  deps: SecretBrokerDeps,
  request: Omit<SecretUseRequest, "exposure">,
): { ok: true; value: string } | SecretDenial {
  const found = resolve(deps, { ...request, exposure: "agent-context" });
  return found.ok ? { ok: true, value: found.value } : found;
}

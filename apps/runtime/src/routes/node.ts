import { parseModelPool, validateProfileAgainstCatalogue } from "@clarkcant/contracts";
import {
  autonomySettingsFromPolicy,
  listCapabilitySummaries,
  readExecutionPolicy,
} from "@clarkcant/core";
import { credentialNames } from "@clarkcant/storage";
import { nowInstant } from "@clarkcant/contracts";

import { DEFAULT_NARROWING, readAutonomySettings, saveAutonomySettings } from "../autonomy-settings.ts";
import { cycleModelPool, readCurrentAlias, readModelPool, writeModelPool } from "../model-registry.ts";
import { availableCredentials } from "../readiness.ts";
import { PI_BUILTIN_TOOLS, nodeToolCatalogue } from "../tool-catalogue.ts";
import { type NodeServices } from "../services.ts";
import { storeModelChoice } from "../application/model-choice.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * The node's own description, and the configuration a person sets on it.
 *
 * Identity (`/node`), what it can do (`/capabilities`, `/tools`, `/readiness`, `/extensions`,
 * `/pi-settings`), and the settings that decide what it runs (`/model`, `/model-pool`, `/autonomy`).
 *
 * The route owns its own HTTP: parsing a write, mapping a refusal to a status, and the shape of the
 * answer. Every dependency is a parameter, narrowed to the node fields these routes read, so nothing
 * here reaches for state it was not handed.
 *
 * `undefined` means "not one of mine", which is how the dispatch keeps the route order it had when
 * these branches lived in the gateway.
 */
export interface NodeRouteDeps {
  services: Pick<
    NodeServices,
    "runtime" | "model" | "modelCatalogue" | "extensions" | "piSettings" | "turnControl"
  >;
  request: GatewayRequest;
  segments: string[];
  at: () => string;
}

/**
 * The node and settings family. `undefined` means the request is not one of these routes.
 */
export async function handleNodeRoutes(deps: NodeRouteDeps): Promise<GatewayResponse | undefined> {
  const { request, segments } = deps;
  const { runtime } = deps.services;

  if (request.method === "GET" && request.path === "/node") {
    return json(200, {
      nodeId: runtime.identity.nodeId,
      label: runtime.identity.label,
      createdAt: runtime.identity.createdAt,
      // The device key's fingerprint is what a peer compares when pairing, so it is reported here
      // rather than only inside the pairing flow: a person asked "is this the right machine?" needs
      // to be able to read it out from the node they are standing at.
      fingerprint: runtime.identity.fingerprint,
      // Reported here rather than inferred by the client, so the settings surface can say what
      // this node is configured for before it has answered anything. `null` means no model, which
      // is a state worth showing plainly: the node answers from scripts and capabilities only.
      model: deps.services.model,
    });
  }

  if (request.method === "GET" && request.path === "/model") {
    // The catalogue comes from the SDK, so a provider added by upgrading pi appears here without this node changing,
    // and the current selection is reported beside it rather than inferred from it: a node configured for a model its
    // installation no longer offers is a state worth showing plainly instead of hiding.
    const catalogue = await (deps.services.modelCatalogue?.() ?? Promise.resolve([]));
    return json(200, { current: deps.services.model, catalogue });
  }

  /*
   * A model a person chose.
   *
   * Stored, and applied to sessions created afterwards: the model is resolved when a session is created, which is the
   * only moment a choice can reach one, so the answer names that scope rather than implying a conversation already
   * running changed underneath somebody. A conversation that is open keeps the model it started with.
   *
   * The choice is still checked against the catalogue first: a stored model this installation cannot run would fail
   * every later turn with a message about a provider rather than about the choice that caused it.
   */
  if (segments.length === 1 && segments[0] === "model" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const provider = typeof parsed.value.provider === "string" ? parsed.value.provider.trim() : "";
    const id = typeof parsed.value.id === "string" ? parsed.value.id.trim() : "";
    if (provider === "" || id === "") {
      return fail(400, "INVALID_SCHEMA", "a model choice needs a provider and a model id");
    }
    const catalogue = await (deps.services.modelCatalogue?.() ?? Promise.resolve([]));
    const stored = storeModelChoice(
        {
          db: runtime.db,
          ownerPrincipalId: runtime.identity.ownerPrincipalId,
          catalogue,
          hasTurnControl: deps.services.turnControl !== undefined,
        },
      { provider, id },
    );
    if (!stored.ok) return fail(400, "INVALID_SCHEMA", stored.message);
    // When the choice takes effect, told rather than implied; the client turns either code into the
    // sentence beside the field.
    return json(200, { ok: true, stored: { provider, id }, applies: stored.applies });
  }

  /*
   * The autonomy settings, as the panel that predates the canonical policy reads and writes them.
   *
   * Both directions go through the one policy: the read projects it into the five legacy fields, and the write
   * translates those fields back into it — keeping the rules the legacy shape has no way to name, because a
   * write through a shape that cannot express a refusal must not delete one. Nothing here is a second copy of
   * the policy, and the narrowing table travels with the read because the panel shows what the guardrail is
   * allowed to ask for — a list the host owns and a model may only pick from.
   */
  if (request.method === "GET" && request.path === "/autonomy") {
    return json(200, {
      settings: readAutonomySettings(
        { db: runtime.db, now: () => nowInstant() },
        runtime.identity.ownerPrincipalId,
      ),
      policy: readExecutionPolicy(
        { db: runtime.db, now: () => nowInstant() },
        runtime.identity.ownerPrincipalId,
      ),
      narrowing: DEFAULT_NARROWING.map((entry) => ({ id: entry.id, description: entry.description })),
    });
  }

  if (request.method === "POST" && request.path === "/autonomy") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const saved = saveAutonomySettings(
      { db: runtime.db, now: () => nowInstant() },
      runtime.identity.ownerPrincipalId,
      parsed.value.settings ?? parsed.value,
    );
    /*
     * A refused write is answered as a refusal. The panel renders the answer as the state of the node, so
     * reporting `ok: true` with a policy the registry would not store would describe a change that did not
     * happen — and the fields it names are the ones the user has to fix.
     */
    if (!saved.ok) return fail(400, saved.code, saved.message);
    // The scope is stated rather than implied: this node reads the policy per command, so the next command
    // already runs under it, and a panel that said "restart to apply" would be lying about that.
    return json(200, {
      ok: true,
      settings: autonomySettingsFromPolicy(saved.stored),
      policy: saved.stored,
      applies: "the next command this node runs",
    });
  }

  if (segments.length === 1 && segments[0] === "capabilities" && request.method === "GET") {
    return json(200, {
      // Summaries only: dumping every tool schema into every turn is both expensive and a
      // prompt-injection surface, so a schema is loaded once a capability is chosen.
      capabilities: listCapabilitySummaries({ db: runtime.db, nodeId: runtime.identity.nodeId }),
    });
  }

  /*
   * The pool of models a person keeps.
   *
   * Read and written whole, like the autonomy settings, and checked against pi's own catalogue on the way in: a
   * stored profile this installation cannot run would fail every later turn with a message about a provider rather
   * than about the choice that caused it. The catalogue is not copied into the pool — it is consulted.
   */
  if (request.method === "GET" && request.path === "/model-pool") {
    const catalogue = await (deps.services.modelCatalogue?.() ?? Promise.resolve([]));
    const owner = runtime.identity.ownerPrincipalId;
    const pool = readModelPool(runtime.db, owner);
    return json(200, {
      pool,
      currentAlias: readCurrentAlias(runtime.db, owner),
      // Which profiles this node can actually run, so a panel can say so instead of leaving a row looking usable.
      checked: pool.profiles.map((profile) => ({
        alias: profile.alias,
        ...validateProfileAgainstCatalogue(profile, catalogue),
      })),
    });
  }

  if (request.method === "POST" && request.path === "/model-pool") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const catalogue = await (deps.services.modelCatalogue?.() ?? Promise.resolve([]));
    const pool = parseModelPool(parsed.value.pool ?? parsed.value);
    // Refused before it is stored: a profile this node cannot run is a promise it cannot keep, and the refusal names
    // which of the two identifiers was wrong.
    if (catalogue.length > 0) {
      for (const profile of pool.profiles) {
        const check = validateProfileAgainstCatalogue(profile, catalogue);
        if (!check.ok) return fail(400, "INVALID_SCHEMA", check.message);
      }
    }
    const stored = writeModelPool(runtime.db, runtime.identity.ownerPrincipalId, pool, nowInstant());
    return json(200, { ok: true, pool: stored });
  }

  /*
   * The hotkey: one press moves to the next enabled profile and writes what the next generation will run.
   *
   * What it deliberately does not do is touch the session underneath a running turn. Pi resolves a model when a
   * session is created, so the change is applied as a new generation at the next turn boundary — which is what the
   * answer says, rather than implying the running turn changed models mid-sentence.
   */
  if (request.method === "POST" && request.path === "/model-pool/cycle") {
    const cycled = cycleModelPool(runtime.db, runtime.identity.ownerPrincipalId, nowInstant());
    if (cycled.next === undefined) {
      return fail(409, "NO_MODEL_PROFILE", "pool này không có profile nào đang bật, nên không có gì để chuyển tới.");
    }
    return json(200, {
      ok: true,
      ...(cycled.current === undefined ? {} : { previous: cycled.current }),
      alias: cycled.next.alias,
      provider: cycled.next.provider,
      modelId: cycled.next.modelId,
      applies: "a new generation; the running turn is not touched",
    });
  }

  /*
   * What pi loads on this machine.
   *
   * Names and kinds, never contents: an extension can hold a credential, and a listing that read files would be the place
   * it leaked from. Reported apart from this harness's own tools for the same reason the tab reports two lists - a reader
   * deciding whether something is possible needs to know which half would do it.
   */
  if (segments.length === 1 && segments[0] === "extensions" && request.method === "GET") {
    return json(200, { extensions: await (deps.services.extensions?.() ?? Promise.resolve([])) });
  }

  /*
   * What this node has already been told.
   *
   * Built for the first run, which should not ask for a provider, a model and a key that are already configured - and it
   * says nothing an operator could not read out of their own .env file. Names only, never values, and never a length.
   */
  if (segments.length === 1 && segments[0] === "readiness" && request.method === "GET") {
    return json(200, {
      model: deps.services.model !== null,
      credentials: availableCredentials({
        env: process.env,
        vault: credentialNames(runtime.db, runtime.identity.ownerPrincipalId),
      }),
    });
  }

  /*
   * pi's own configuration.
   *
   * Scalars, with anything whose name sounds like a secret already redacted by the adapter, which is also where the
   * decision not to read auth.json lives. A panel showing configuration has no business near a credentials file, and the
   * redaction happens at the one place that can see the file rather than on the way out of here.
   */
  if (segments.length === 1 && segments[0] === "pi-settings" && request.method === "GET") {
    return json(200, { settings: await (deps.services.piSettings?.() ?? Promise.resolve([])) });
  }

  /*
   * What this node can do, and what the agent it drives can do.
   *
   * Two lists rather than one, because they are two different things and a reader needs to know which is which: the
   * harness's tools are this node's own, and the agent's are pi's. An extension's tools are not listed because they
   * depend on pi's own configuration, and a list that guessed at them would be wrong in the one direction that
   * matters - claiming a capability this node does not have.
   */
  if (segments.length === 1 && segments[0] === "tools" && request.method === "GET") {
    return json(200, {
      self: nodeToolCatalogue(),
      agent: PI_BUILTIN_TOOLS,
      agentNote: "Công cụ gốc của pi. Extension mà pi tự nạp thêm thì không liệt kê ở đây.",
    });
  }

  return undefined;
}

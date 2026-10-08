import { nowInstant } from "@clarkcant/contracts";
import type { ModelCatalogue, ProviderAuthEntry } from "@clarkcant/pi-adapter";
import { putPreference, readPreference } from "@clarkcant/storage";
import type { Database } from "@clarkcant/storage";

/**
 * Storing the model a person chose.
 *
 * A flow rather than parsing: the choice is checked against pi's own catalogue before it is stored, and the
 * answer says when it takes effect — which depends on whether this node has turns to control at all. Both
 * facts belong to the node's state, not to the HTTP request, so the route hands them in and maps the outcome
 * to a status.
 */
export interface ModelChoiceDeps {
  db: Database;
  ownerPrincipalId: string;
  /** Every provider and model this node can run, read when the choice is made rather than at boot. */
  catalogue: ModelCatalogue;
  /** Whether turns exist to control; it decides which scope the answer may name. */
  hasTurnControl: boolean;
  /**
   * Who is signed in, per provider, read when the choice is made. `undefined` when the node cannot say (no accounts,
   * or the read failed): the choice is then checked against the catalogue alone rather than refused on a guess.
   */
  providerAuth?: readonly ProviderAuthEntry[];
  /** The language a refusal is worded in: the node owner's. */
  locale: "vi" | "en";
}

export interface ModelChoice {
  provider: string;
  id: string;
}

/**
 * Where the choice lands, told rather than implied.
 *
 * A running turn reads the stored choice on every message, so a pick lands on the current conversation from its next
 * message: an open conversation switches in place. A node with no turn has nothing to read it yet: it starts with this
 * model the next time the node starts, and answering "from your next message" there would describe a change that is
 * not going to happen. (`next-session` is the wire name of the first answer and is kept for compatibility.)
 *
 * A refusal says which rule it broke: a model the catalogue does not offer, or one whose provider is signed out, which
 * every turn would fail on until the person signs in.
 */
export type ModelChoiceOutcome =
  | { ok: true; applies: "next-session" | "next-start" }
  | { ok: false; code: "not-offered" | "provider-signed-out"; message: string };

/**
 * The model the person chose, as stored: what a turn reads each time it starts, or nothing when no choice is stored.
 */
export function readModelChoice(db: Database, ownerPrincipalId: string): ModelChoice | undefined {
  const stored = readPreference(db, ownerPrincipalId, "model", "node") ?? "";
  // Split at the first slash only: a model id may hold slashes of its own (`openrouter` serves `anthropic/claude-…`),
  // and cutting it at the second would run a model nobody chose.
  const slash = stored.indexOf("/");
  const provider = slash < 0 ? "" : stored.slice(0, slash);
  const id = slash < 0 ? "" : stored.slice(slash + 1);
  return provider === "" || id === "" ? undefined : { provider, id };
}

/**
 * Check the choice against the catalogue, store it, and report the scope.
 *
 * The checks happen first: a stored model this installation cannot run would fail every later turn with a message
 * about a provider rather than about the choice that caused it. This is the one place a choice is checked, so the
 * picker, Settings, the API, the CLI and MCP all meet the same refusal.
 */
export function storeModelChoice(deps: ModelChoiceDeps, choice: ModelChoice): ModelChoiceOutcome {
  const offered = deps.catalogue.find((entry) => entry.id === choice.provider);
  if (deps.catalogue.length > 0 && (offered === undefined || !offered.models.some((model) => model.id === choice.id))) {
    return { ok: false, code: "not-offered", message: `provider "${choice.provider}" does not offer a model "${choice.id}"` };
  }
  // Only a provider the sign-in list names as signed out is refused: one it does not list needs no sign-in at all.
  const account = deps.providerAuth?.find((entry) => entry.providerId === choice.provider);
  if (account !== undefined && !account.configured) {
    return {
      ok: false,
      code: "provider-signed-out",
      message:
        deps.locale === "vi"
          ? `chưa dùng được ${choice.provider}/${choice.id} vì chưa đăng nhập ${account.name}; đăng nhập bằng /login rồi chọn lại`
          : `${choice.provider}/${choice.id} cannot be used yet because ${account.name} is signed out; sign in with /login, then choose it again`,
    };
  }
  putPreference(deps.db, {
    principalId: deps.ownerPrincipalId,
    key: "model",
    value: `${choice.provider}/${choice.id}`,
    scope: "node",
    source: "settings",
    at: nowInstant(),
  });
  return { ok: true, applies: deps.hasTurnControl ? "next-session" : "next-start" };
}

import { nowInstant } from "@clarkcant/contracts";
import type { ModelCatalogue } from "@clarkcant/pi-adapter";
import { putPreference } from "@clarkcant/storage";
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
}

export interface ModelChoice {
  provider: string;
  id: string;
}

/**
 * Where the choice lands, told rather than implied.
 *
 * A running turn reads the stored choice each time it creates a session, so a pick lands on the next
 * conversation. A node with no turn has nothing to read it yet: it starts with this model the next time the node
 * starts, and answering "the next conversation" there would describe a change that is not going to happen.
 */
export type ModelChoiceOutcome =
  | { ok: true; applies: "next-session" | "next-start" }
  | { ok: false; message: string };

/**
 * Check the choice against the catalogue, store it, and report the scope.
 *
 * The check happens first: a stored model this installation cannot run would fail every later turn with a message
 * about a provider rather than about the choice that caused it.
 */
export function storeModelChoice(deps: ModelChoiceDeps, choice: ModelChoice): ModelChoiceOutcome {
  const offered = deps.catalogue.find((entry) => entry.id === choice.provider);
  if (deps.catalogue.length > 0 && (offered === undefined || !offered.models.some((model) => model.id === choice.id))) {
    return { ok: false, message: `provider "${choice.provider}" does not offer a model "${choice.id}"` };
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

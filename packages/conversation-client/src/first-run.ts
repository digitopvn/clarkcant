/**
 * What a node says it already has.
 *
 * The shape the readiness route answers with. `model` is whether the node can run one at all; `credentials` names the
 * keys it already holds, from its vault or its environment, and never their values.
 */
export interface NodeReadiness {
  readonly model: boolean;
  readonly credentials: readonly string[];
}

/** The steps the first run can show, in the order it shows them. */
export type FirstRunStep = "welcome" | "provider" | "model" | "key";

/**
 * Which of them somebody actually has to walk.
 *
 * The question a first run asks is "what do I still need from you", and a node started from a filled-in environment
 * needs nothing: the provider, the model and the key were answered before the browser opened. Asking anyway is not
 * harmless - it asks somebody to retype a key this machine already has, and a key retyped into a page is a key in a
 * screenshot and in a clipboard history.
 *
 * The key step is about the TypeSafe key in particular, because that is the credential the interface itself can store.
 * If the node reports it, the step is skipped; a step that asked for something already present would be teaching people
 * to ignore the steps.
 */
export function firstRunSteps(readiness: NodeReadiness): FirstRunStep[] {
  const steps: FirstRunStep[] = ["welcome"];
  if (!readiness.model) steps.push("provider", "model");
  if (!readiness.credentials.includes("typesafe")) steps.push("key");
  return steps;
}

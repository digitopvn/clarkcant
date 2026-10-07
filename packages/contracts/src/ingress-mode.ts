import { z } from "zod";

/**
 * How something outside reaches this node: one vocabulary for every external source.
 *
 * Shared on purpose. An external messaging channel (#199) and a package's signal source (#525) both feed the one
 * durable intake (#197: verify, dedupe, persist); neither owns a scheduler, a dedupe store or a retry loop of its own,
 * and both describe how their deliveries arrive in these words.
 *
 * - `webhook`: the provider calls the node.
 * - `poll`: the node asks the provider on a timer.
 * - `long-poll`: the node asks and the provider holds the answer until something happens.
 * - `stream`: one long-lived response the provider writes events into (SSE, chunked HTTP).
 * - `gateway`: a long-lived, two-way session the node keeps open to the provider (a bot gateway socket).
 * - `relay`: a third party that holds the provider's connection and hands deliveries on.
 * - `local-watch`: something on this machine the node watches (a folder, a local process).
 *
 * A transport is never assumed to be a webhook: a node without a public address still receives through the others.
 */
export const INGRESS_MODE_VERSION = 1;
export const INGRESS_MODES = ["webhook", "poll", "long-poll", "stream", "gateway", "relay", "local-watch"] as const;
export const ingressModeSchema = z.enum(INGRESS_MODES);
export type IngressMode = z.infer<typeof ingressModeSchema>;

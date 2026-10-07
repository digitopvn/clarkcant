import { type ChannelDelivery, type ChannelEvent, type Instant, channelEventSchema } from "@clarkcant/contracts";
import { type TaskServiceDeps, channelEventSignal, channelThreadKey, ingestSignal, isClarkAuthored } from "@clarkcant/core";
import { findExternalMessageLink, getExternalConnection, recordChannelInput, transaction } from "@clarkcant/storage";

import { createSecretBroker } from "../secret-broker.ts";
import type { ChannelAdapterRegistry } from "./channel-adapter-registry.ts";

/**
 * A channel delivery, into the one durable intake every external source uses.
 *
 * There is no intake of its own here. The adapter verifies the delivery (before a byte of it is read) and normalizes
 * it into provider-neutral events; each event is recorded through `ingestSignal`, deduplicated per connection on its
 * own id exactly like a GitHub or webhook signal, and — in the same write, only when it was new — handed to the
 * channel-input branch as a pending input. So a provider that delivers twice records once, a node that stops after
 * recording finds the input still waiting, and persistent intents can match `channel.message.received` like any other
 * signal. What a message means for a conversation is decided after this returns (`channel-service.ts`).
 */

export type ChannelIntakeResult =
  | { ok: true; recorded: number; duplicates: number }
  | {
      ok: false;
      code: "CONNECTION_UNKNOWN" | "CONNECTION_REVOKED" | "ADAPTER_UNAVAILABLE" | "VERIFY_UNAVAILABLE" | "SIGNATURE_INVALID" | "DELIVERY_INVALID";
      message: string;
    };

export interface ChannelIntakeDeps {
  deps: TaskServiceDeps;
  registry: ChannelAdapterRegistry;
}

/** The consumer a connection's verification secret is released to, and to nothing else. */
export function channelSecretConsumer(connectionRef: string): string {
  return `channels:${connectionRef}`;
}

export async function receiveChannelDelivery(
  intake: ChannelIntakeDeps,
  input: { connectionRef: string; delivery: ChannelDelivery },
): Promise<ChannelIntakeResult> {
  const { deps } = intake;
  const connection = getExternalConnection(deps.db, input.connectionRef);
  if (connection === undefined) return { ok: false, code: "CONNECTION_UNKNOWN", message: "no channel is connected under this name" };
  if (connection.state === "revoked") return { ok: false, code: "CONNECTION_REVOKED", message: "this channel connection was revoked" };
  const adapter = intake.registry.get(connection.provider);
  if (adapter === undefined) {
    return { ok: false, code: "ADAPTER_UNAVAILABLE", message: `this node has no channel adapter for ${connection.provider}` };
  }

  // Verified before anything in the delivery is read. The secret goes from the store into the check and nowhere else.
  if (adapter.verify !== undefined) {
    let verified: ReturnType<NonNullable<typeof adapter.verify>>;
    if (connection.verifySecretName === undefined) {
      verified = adapter.verify(input.delivery, undefined);
    } else {
      const checked = createSecretBroker({ db: deps.db, principalId: connection.principalId, now: deps.now }).withSecret(
        { name: connection.verifySecretName, consumer: channelSecretConsumer(connection.connectionRef) },
        (secret) => adapter.verify?.(input.delivery, secret) ?? { ok: false as const, reason: "the adapter stopped verifying" },
      );
      if (!checked.ok) {
        return { ok: false, code: "VERIFY_UNAVAILABLE", message: `the secret this channel is verified with cannot be used (${checked.code})` };
      }
      verified = checked.result;
    }
    if (!verified.ok) return { ok: false, code: "SIGNATURE_INVALID", message: verified.reason };
  } else if (connection.verifySecretName !== undefined) {
    // A connection that names a secret expects every delivery checked; an adapter that cannot is not trusted with it.
    return { ok: false, code: "VERIFY_UNAVAILABLE", message: `the ${connection.provider} adapter cannot verify deliveries` };
  }

  let normalized: unknown[];
  try {
    normalized = await adapter.normalize(input.delivery, { connection, now: deps.now });
  } catch (cause) {
    return { ok: false, code: "DELIVERY_INVALID", message: cause instanceof Error ? cause.message.slice(0, 500) : "the adapter could not read it" };
  }
  // Every event is checked before any is recorded, so one malformed event never leaves a delivery half recorded.
  const events: ChannelEvent[] = [];
  for (const candidate of normalized) {
    const parsed = channelEventSchema.safeParse(candidate);
    if (!parsed.success) {
      return {
        ok: false,
        code: "DELIVERY_INVALID",
        message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ").slice(0, 500),
      };
    }
    events.push(parsed.data);
  }

  let recorded = 0;
  let duplicates = 0;
  for (const event of events) {
    const sentByClark =
      findExternalMessageLink(deps.db, {
        connectionRef: connection.connectionRef,
        externalSpaceId: event.space.externalSpaceId,
        externalMessageId: event.externalMessageId,
        direction: "outbound",
      }) !== undefined;
    const selfGenerated = isClarkAuthored({ event, connection, sentByClark });
    const ingested = transaction(deps.db, () => {
      const result = ingestSignal(deps, channelEventSignal(connection, event, selfGenerated));
      if (!result.ok) return result;
      if (result.created) {
        recordChannelInput(deps.db, {
          signalId: result.signalId,
          connectionRef: connection.connectionRef,
          threadKey: channelThreadKey(connection.connectionRef, event),
          receivedAt: deps.now() as Instant,
        });
      }
      return result;
    });
    // Events before this one stay recorded: each is its own fact, and a redelivery finds them already there.
    if (!ingested.ok) {
      return { ok: false, code: "DELIVERY_INVALID", message: `${ingested.message} (${String(recorded)} recorded before it)` };
    }
    if (ingested.created) recorded += 1;
    else duplicates += 1;
  }
  return { ok: true, recorded, duplicates };
}

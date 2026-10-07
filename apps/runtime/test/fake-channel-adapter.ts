import {
  CHANNEL_CONTRACT_VERSION,
  type ChannelAdapter,
  type ChannelAddress,
  type ChannelContent,
  type ChannelDelivery,
  type ChannelEvent,
  type ChannelSendOutcome,
} from "@clarkcant/contracts";

/**
 * An in-memory channel provider for tests: what a real adapter does, with nothing on the network.
 *
 * Inbound, a delivery's body is a JSON list of messages in the fake provider's own small shape, normalized into
 * provider-neutral events. Outbound, every send is recorded and answered with the next provider message id, unless a
 * test told it to refuse (`not-sent`) or to fail without an answer (a throw, which the host must call unknown).
 */

export interface FakeChannelMessage {
  id: string;
  space: string;
  kind?: "direct" | "group";
  thread?: string;
  from: string;
  name?: string;
  text: string;
  mentionsBot?: boolean;
  replyTo?: string;
  /** The provider's own delivery id; a redelivery repeats it. Defaults to the message id. */
  updateId?: string;
}

export interface FakeSend {
  address: ChannelAddress;
  content: ChannelContent;
  idempotencyKey: string;
  externalMessageId?: string;
}

export interface FakeChannelAdapter extends ChannelAdapter {
  readonly sends: FakeSend[];
  readonly typing: (address: ChannelAddress) => Promise<void>;
  /** How the next sends end: answered (the default), refused, or never answered. */
  sendMode: "sent" | "not-sent" | "throw";
}

export const FAKE_PROVIDER = "fake-chat";
export const FAKE_SIGNATURE_HEADER = "x-fake-signature";

export function fakeDelivery(messages: readonly FakeChannelMessage[], signature = "ok"): ChannelDelivery {
  return {
    via: "webhook",
    headers: { [FAKE_SIGNATURE_HEADER]: signature },
    rawBody: new TextEncoder().encode(JSON.stringify(messages)),
  };
}

export function createFakeChannelAdapter(options: { maxTextLength?: number } = {}): FakeChannelAdapter {
  const sends: FakeSend[] = [];
  let next = 0;
  const adapter: FakeChannelAdapter = {
    provider: FAKE_PROVIDER,
    ingressModes: ["webhook"],
    sends,
    sendMode: "sent",
    capabilities: () => ({ text: true, replies: true, threads: true, typing: true, ...(options.maxTextLength === undefined ? {} : { maxTextLength: options.maxTextLength }) }),
    verify(delivery) {
      return delivery.headers[FAKE_SIGNATURE_HEADER] === "ok" ? { ok: true } : { ok: false, reason: "the signature does not match" };
    },
    async normalize(delivery, context): Promise<ChannelEvent[]> {
      const messages = JSON.parse(new TextDecoder().decode(delivery.rawBody)) as FakeChannelMessage[];
      return messages.map((message) => ({
        version: CHANNEL_CONTRACT_VERSION,
        kind: "message",
        eventId: message.updateId ?? message.id,
        occurredAt: context.now(),
        space: { externalSpaceId: message.space, kind: message.kind ?? "group" },
        ...(message.thread === undefined ? {} : { externalThreadId: message.thread }),
        externalMessageId: message.id,
        actor: { externalActorId: message.from, ...(message.name === undefined ? {} : { displayName: message.name }) },
        content: { text: message.text, format: "plain" },
        ...(message.replyTo === undefined ? {} : { replyToExternalMessageId: message.replyTo }),
        mentionsClark: message.mentionsBot === true,
      }));
    },
    async send(address, content, sendOptions): Promise<ChannelSendOutcome> {
      if (adapter.sendMode === "throw") {
        sends.push({ address, content, idempotencyKey: sendOptions.idempotencyKey });
        throw new Error("the connection dropped before the provider answered");
      }
      if (adapter.sendMode === "not-sent") return { status: "not-sent", reason: "the provider refused the chat" };
      next += 1;
      const externalMessageId = `out-${String(next)}`;
      sends.push({ address, content, idempotencyKey: sendOptions.idempotencyKey, externalMessageId });
      return { status: "sent", externalMessageId };
    },
    typing: async () => undefined,
  };
  return adapter;
}

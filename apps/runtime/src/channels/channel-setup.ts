import {
  type ChannelAttentionPolicy,
  type ChannelAudiencePolicy,
  type ChannelBinding,
  type ChannelIngressMode,
  type ExternalConnection,
  type ExternalIdentity,
  type Instant,
  CHANNEL_CONTRACT_VERSION,
  channelBindingSchema,
  externalConnectionSchema,
  externalIdentitySchema,
} from "@clarkcant/contracts";
import {
  type Database,
  getConversation,
  getExternalConnection,
  putChannelBinding,
  putExternalConnection,
  putExternalIdentity,
} from "@clarkcant/storage";

/**
 * Writing down a channel connection, the spaces bound to conversations, and the provider accounts that are known
 * people. Every record is validated against its contract before it is stored.
 *
 * These are the host's own steps; the conversation-first connection mini app that walks a person through them, and the
 * provider sign-in behind it, are later work. Nothing here sends or receives.
 */

export interface ChannelSetupDeps {
  db: Database;
  now: () => Instant;
  newId: (prefix: string) => string;
}

export function createExternalConnection(
  deps: ChannelSetupDeps,
  input: {
    provider: string;
    providerAccountId: string;
    principalId: string;
    ingressMode: ChannelIngressMode;
    selfActorIds?: string[];
    verifySecretName?: string;
  },
): ExternalConnection {
  const at = deps.now();
  const connection = externalConnectionSchema.parse({
    version: CHANNEL_CONTRACT_VERSION,
    connectionRef: deps.newId("conn"),
    provider: input.provider,
    providerAccountId: input.providerAccountId,
    principalId: input.principalId,
    ingressMode: input.ingressMode,
    state: "connected",
    selfActorIds: input.selfActorIds ?? [input.providerAccountId],
    ...(input.verifySecretName === undefined ? {} : { verifySecretName: input.verifySecretName }),
    createdAt: at,
    updatedAt: at,
  });
  putExternalConnection(deps.db, connection);
  return connection;
}

/** Join a space (or one thread of it) to a conversation. A space with no binding starts nothing. */
export function bindChannelSpace(
  deps: ChannelSetupDeps,
  input: {
    connectionRef: string;
    externalSpaceId: string;
    externalThreadId?: string;
    spaceKind: "direct" | "group";
    conversationId: string;
    audiencePolicy?: ChannelAudiencePolicy;
    attentionPolicy?: Partial<ChannelAttentionPolicy>;
    grantRefs?: string[];
  },
): ChannelBinding {
  const connection = getExternalConnection(deps.db, input.connectionRef);
  if (connection === undefined) throw new Error(`there is no channel connection ${input.connectionRef}`);
  if (getConversation(deps.db, input.conversationId) === undefined) {
    throw new Error(`there is no conversation ${input.conversationId} to bind a channel to`);
  }
  const at = deps.now();
  const binding = channelBindingSchema.parse({
    version: CHANNEL_CONTRACT_VERSION,
    bindingId: deps.newId("chb"),
    connectionRef: connection.connectionRef,
    provider: connection.provider,
    providerAccountId: connection.providerAccountId,
    externalSpaceId: input.externalSpaceId,
    ...(input.externalThreadId === undefined ? {} : { externalThreadId: input.externalThreadId }),
    spaceKind: input.spaceKind,
    conversationId: input.conversationId,
    audiencePolicy: input.audiencePolicy ?? { kind: "space" },
    attentionPolicy: input.attentionPolicy ?? {},
    grantRefs: input.grantRefs ?? [],
    state: "active",
    createdAt: at,
    updatedAt: at,
  });
  putChannelBinding(deps.db, binding);
  return binding;
}

/** Map a provider account to a principal: the owner's own account to the owner, someone else to theirs. */
export function linkExternalIdentity(
  deps: ChannelSetupDeps,
  input: { connectionRef: string; externalActorId: string; principalId: string; displayName?: string },
): ExternalIdentity {
  const identity = externalIdentitySchema.parse({ ...input, linkedAt: deps.now() });
  putExternalIdentity(deps.db, identity);
  return identity;
}

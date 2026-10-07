import { type ChannelAdapter, channelCapabilitiesSchema, channelProviderSchema } from "@clarkcant/contracts";

/**
 * The channel adapters this node can use, by provider.
 *
 * Host-managed, like a driver: an adapter is registered by the host (a built-in, or later a package's `driver` facet
 * running in its `service` isolation), lives as long as the node, and is never owned by a Pi session — a channel keeps
 * receiving while no turn runs and across model and session hand-offs.
 */
export interface ChannelAdapterRegistry {
  register(adapter: ChannelAdapter): void;
  get(provider: string): ChannelAdapter | undefined;
  providers(): string[];
}

export function createChannelAdapterRegistry(): ChannelAdapterRegistry {
  const adapters = new Map<string, ChannelAdapter>();
  return {
    register(adapter) {
      const provider = channelProviderSchema.parse(adapter.provider);
      // Checked once, here, so a renderer can trust what an adapter says it can do.
      channelCapabilitiesSchema.parse(adapter.capabilities());
      if (adapters.has(provider)) throw new Error(`a channel adapter for ${provider} is already registered`);
      adapters.set(provider, adapter);
    },
    get: (provider) => adapters.get(provider),
    providers: () => [...adapters.keys()].sort(),
  };
}

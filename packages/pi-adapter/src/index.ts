/**
 * @clarkcant/pi-adapter
 *
 * The only package that imports the Pi SDK. Everything else depends on the
 * `PiAdapter` interface, so an SDK change is an adapter change rather than a
 * refactor of the core.
 *
 * `RealPiAdapter` is typed against the SDK's own declarations. `FakePiAdapter` is a
 * deterministic in-process implementation used by tests and CI, which is what lets
 * the whole application be exercised without a provider account.
 */

export * from "./types.ts";
export { FakePiAdapter } from "./fake.ts";
export {
  RealPiAdapter,
  READ_ONLY_TOOLS,
  REQUIRED_SDK_EXPORTS,
  mapPiEvent,
  sdkVersion,
  unsupportedCapability,
  type CompatibilityLock,
  type RealPiAdapterOptions,
} from "./real.ts";

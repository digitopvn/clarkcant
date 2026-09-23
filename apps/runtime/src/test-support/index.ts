/**
 * The deterministic fixtures, and nothing else.
 *
 * Everything in this directory exists so a journey can be verified without a provider account or a model: a scripted
 * composer, a session starter that starts nothing, and a voice provider that answers on a script rather than over the
 * network. Each one says out loud which half is scripted, because a fixture that cannot be told apart from the real
 * thing is worse than no fixture at all.
 *
 * Nothing in the production path imports this module. `bootstrap/fixtures.ts` reaches it with a dynamic import, and
 * only after one of the explicit `CC_*_FIXTURE` gates matched, so a node that sets no gate never loads it.
 */
export {
  FixtureLiveAdapter,
  type FixtureLiveAdapter as FixtureLiveAdapterType,
} from "./voice-fixture.ts";
export {
  applyScriptedBackgroundControl,
  applyScriptedTurnControl,
  arrangeModelNode,
  createModelComposer,
  type FixtureCompose,
  type FixtureModelDeps,
  type FixtureModelWiring,
} from "./fixture-model.ts";
export { fixtureProjectSessions } from "./fixture-session.ts";
export { createVoiceFixture, type VoiceFixture } from "./fixture-voice.ts";

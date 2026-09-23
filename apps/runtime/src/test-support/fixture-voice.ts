import { FixtureLiveAdapter } from "./voice-fixture.ts";

/**
 * The scripted voice provider, as the node publishes it.
 *
 * A provider that answers on a script rather than over the network, so the whole path from a real microphone in a
 * real browser, through the real node and the real socket, can be verified without a provider account. A node
 * running it says so at startup, and its audio and transcripts are plainly scripted, so a fixture is never read as
 * model output.
 *
 * Loaded only through `bootstrap/fixtures.ts`, and only when `CC_VOICE_FIXTURE=1`: the seam below exists exactly
 * when a fake is there to set words on, which is why a real node has no `/voice-fixture` route to reach at all.
 */
export interface VoiceFixture {
  /** The seam the node publishes, so a test can script what the next session will be understood to have heard. */
  service: { setWords(words: string): void };
  /** One adapter per session, carrying the words scripted for it and for no session after it. */
  createAdapter: () => FixtureLiveAdapter;
}

export function createVoiceFixture(): VoiceFixture {
  /**
   * The words the scripted provider will say.
   *
   * Read when a session opens rather than captured once, so a test can set them and then open one.
   */
  let words: string | undefined;

  return {
    service: {
      setWords: (next: string) => {
        words = next;
      },
    },
    /*
     * The scripted words apply to **the next session and no further**.
     *
     * Consumed here rather than read on every utterance, because the value lives on the node and the node outlives a
     * session. Reading it live leaked one suite's script into the next: voice.spec.ts, which scripts nothing and
     * expects the fixture's own sentence, failed after this suite had run - a failure that only appeared in a
     * whole-suite run, which is exactly why the whole suite is the gate.
     */
    createAdapter: () => {
      const scripted = words;
      words = undefined;
      return new FixtureLiveAdapter({ ...(scripted === undefined ? {} : { words: scripted }) });
    },
  };
}

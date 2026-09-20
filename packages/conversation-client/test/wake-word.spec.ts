import { describe, expect, it } from "vitest";

import {
  WAKE_STATUSES,
  WAKE_UNAVAILABLE_REASON,
  agentStateForWake,
  createFixtureWakeDetector,
  wakeAvailability,
  type WakeWordDetector,
} from "../src/wake-word.ts";

/**
 * The wake-word seam.
 *
 * There is no detector wired into this build, and that is the state under test as much as any other: the seam
 * exists so the decision can be revisited without a rewrite, and the honest answer — no local detector, and no
 * remote fallback — has to be what the surface is told. A toggle that could only reach a provider-side listener
 * would be a privacy decision disguised as a preference.
 *
 * The fixture exists because a wake word can only be exercised by something that fires it on command. A test
 * that waited for a real phrase would be testing a microphone.
 */

describe("what this build tells a surface about wake words", () => {
  it("says no, with a reason, when there is no detector", () => {
    const availability = wakeAvailability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toBe(WAKE_UNAVAILABLE_REASON);
    // The reason names the fallback that is not being taken, so nobody has to guess whether it was considered.
    expect(availability.reason ?? "").toContain("provider");
  });

  it("says yes and hands over the detector when there is one", () => {
    const detector = createFixtureWakeDetector();
    const availability = wakeAvailability({ detector });
    expect(availability.available).toBe(true);
    expect(availability.detector?.id).toBe("fixture-wake");
    // No reason when the answer is yes: a reason beside an available capability reads as a caveat.
    expect(availability.reason).toBeUndefined();
  });
});

describe("a detector reports what it is doing", () => {
  it("starts off", () => {
    expect(createFixtureWakeDetector().status()).toBe("off");
  });

  it("is listening once start resolves, not once it was asked to", async () => {
    /*
     * The distinction the interface exists for. `start` resolves when the microphone is actually open, so a
     * caller cannot report "đang nghe" for a listener that never began — a microphone shown as on while it is
     * off is the failure this whole feature has to avoid, in the one direction that matters.
     */
    const detector = createFixtureWakeDetector();
    const started = detector.start(() => undefined);
    await started;
    expect(detector.status()).toBe("listening");
  });

  it("calls back when the phrase arrives, and stops after stop", async () => {
    const detector = createFixtureWakeDetector();
    let woke = 0;
    await detector.start(() => {
      woke += 1;
    });

    detector.trigger();
    expect(woke).toBe(1);

    await detector.stop();
    expect(detector.status()).toBe("off");
    // A stopped listener that still fires is a wake word that works after being turned off.
    detector.trigger();
    expect(woke).toBe(1);
  });

  it("opens the microphone once per start, so a surface cannot accumulate listeners", async () => {
    const detector = createFixtureWakeDetector();
    await detector.start(() => undefined);
    expect(detector.starts()).toBe(1);
    await detector.stop();
    await detector.start(() => undefined);
    expect(detector.starts()).toBe(2);
  });

  it("carries a name, so a surface can say which detector is in use", () => {
    const detector: WakeWordDetector = createFixtureWakeDetector();
    expect(detector.id.length).toBeGreaterThan(0);
  });
});

describe("the vocabulary is closed", () => {
  it("names the five states a listener can be in", () => {
    expect([...WAKE_STATUSES]).toEqual(["unavailable", "off", "starting", "listening", "failed"]);
  });

  it("maps to the shared agent-state vocabulary rather than inventing a second one", () => {
    // The shell publishes one state; a wake listener does not get to add a parallel one.
    expect(agentStateForWake("listening")).toBe("listening");
    // Waiting for a wake phrase is not an active session, so it publishes nothing: an orb that reported
    // listening before anybody spoke would look like a conversation nobody started.
    expect(agentStateForWake("off")).toBeUndefined();
    expect(agentStateForWake("unavailable")).toBeUndefined();
    expect(agentStateForWake("failed")).toBeUndefined();
  });
});

describe("nothing here reaches a provider", () => {
  it("keeps the wake path local: the detector has no transport and takes no credential", async () => {
    /*
     * Asserted by shape rather than by inspection, because this is the rule that would be broken by adding a
     * field rather than by changing a line: the interface takes a callback and nothing else. A detector that
     * needed a token or an endpoint could only be a remote one, and ambient audio going to a provider is the
     * fallback the plan forbids.
     */
    const detector = createFixtureWakeDetector();
    expect(Object.keys(detector).sort()).toEqual(["id", "start", "starts", "status", "stop", "trigger"]);
    await detector.start(() => undefined);
    // The fixture records no audio and holds no transport; `start` is the whole of its input.
    expect(detector.start.length).toBe(1);
  });
});

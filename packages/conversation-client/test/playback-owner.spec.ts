import { describe, expect, it } from "vitest";

import { createPlaybackOwner, type PlaybackMedia, pressStillCurrent } from "../src/playback-owner.ts";

function media(): PlaybackMedia & { paused: boolean; pauses: number } {
  const element = {
    paused: true,
    pauses: 0,
    pause: () => {
      element.paused = true;
      element.pauses += 1;
    },
  };
  return element;
}

/** Stand-ins for the elements focus can be on; only their identity matters. */
const body = { id: "body" } as unknown as Element;
const player = { id: "player" } as unknown as Element;
const elsewhere = { id: "elsewhere" } as unknown as Element;

describe("one active playback owner", () => {
  it("pauses the player that was playing when another starts, and counts every start", () => {
    const owner = createPlaybackOwner();
    const first = media();
    const second = media();
    expect(owner.starts()).toBe(0);
    first.paused = false;
    owner.claim(first);
    second.paused = false;
    owner.claim(second);
    expect(first).toMatchObject({ paused: true, pauses: 1 });
    expect(second).toMatchObject({ paused: false, pauses: 0 });
    expect(owner.starts()).toBe(2);
  });

  it("does not pause a previous owner that already stopped, or the player that is starting again", () => {
    const owner = createPlaybackOwner();
    const first = media();
    const second = media();
    owner.claim(first);
    owner.claim(second);
    expect(first.pauses).toBe(0);
    second.paused = false;
    owner.claim(second);
    expect(second.pauses).toBe(0);
  });
});

describe("a press of Play that waited for the bytes", () => {
  it("still plays when nothing else started and the keyboard is with the player or nobody", () => {
    expect(pressStillCurrent({ pressedAt: 3, startsNow: 3, active: player, body, media: player })).toBe(true);
    expect(pressStillCurrent({ pressedAt: 3, startsNow: 3, active: body, body, media: player })).toBe(true);
    expect(pressStillCurrent({ pressedAt: 3, startsNow: 3, active: null, body, media: player })).toBe(true);
  });

  it("does not play once another player started after the press, however late the bytes arrive", () => {
    const owner = createPlaybackOwner();
    const pressedAt = owner.starts();
    const other = media();
    other.paused = false;
    owner.claim(other);
    expect(pressStillCurrent({ pressedAt, startsNow: owner.starts(), active: player, body, media: player })).toBe(false);
  });

  it("does not play when the person moved the keyboard elsewhere while waiting", () => {
    expect(pressStillCurrent({ pressedAt: 0, startsNow: 0, active: elsewhere, body, media: player })).toBe(false);
  });
});

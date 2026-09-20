import { describe, expect, it } from "vitest";

import { vendorEmbedUrl } from "../src/media-embed.ts";

/**
 * The vendor embed URL of a restored pin (V13).
 *
 * A pin restores a surface, not a session. `restorePinnedInstance` in core already returns the stored position with
 * `playing: false`; what was missing was that the position never reached the vendor's player, so a re-opened video
 * started from the beginning.
 *
 * The rule the second and third cases exist for is the one people describe as "it just started playing by itself":
 * the URL that reopens a player must be unable to ask for autoplay, so there is no parameter here that could turn
 * it on.
 */

describe("the vendor embed URL of a restored pin", () => {
  it("reopens the player where it stopped", () => {
    expect(vendorEmbedUrl({ videoId: "abc123", positionSeconds: 240 })).toBe(
      "https://www.youtube-nocookie.com/embed/abc123?start=240",
    );
  });

  it("leaves the parameter off when there is no position to restore", () => {
    // `start=0` is not wrong so much as noise, and a URL that carries it invites the reader to wonder what was
    // being resumed.
    expect(vendorEmbedUrl({ videoId: "abc123", positionSeconds: 0 })).toBe(
      "https://www.youtube-nocookie.com/embed/abc123",
    );
  });

  it("cannot express autoplay, whatever position it is given", () => {
    for (const positionSeconds of [0, 1, 240, 99_999, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const url = vendorEmbedUrl({ videoId: "abc123", positionSeconds });
      expect(url).not.toContain("autoplay");
      // A malformed position must not become a malformed URL: the vendor's player would do something unpredictable
      // with `start=NaN`, and the reader would have no way to tell that from a video that resumed oddly.
      expect(url).not.toContain("NaN");
      expect(url).not.toContain("Infinity");
      expect(url.startsWith("https://www.youtube-nocookie.com/embed/abc123")).toBe(true);
    }
  });

  it("floors a fractional position, because a player takes whole seconds", () => {
    expect(vendorEmbedUrl({ videoId: "abc123", positionSeconds: 240.9 })).toContain("start=240");
  });
});

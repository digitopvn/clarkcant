import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentAvatar, AgentAvatarProvider } from "../src/AgentAvatar.tsx";
import { resolveOrbProfile } from "../src/orb-profile.ts";
import { orbOptionsFromProfile } from "../src/orb-snapshot.ts";

/**
 * The agent's mark beside a reply: a square picture of the person's own orb, and — where WebGL cannot draw one, which
 * includes this node-only suite — the profile's colours as a round gradient rather than a flattened streak.
 */
describe("the agent avatar", () => {
  it("follows the chosen profile's colours rather than one fixed picture", () => {
    const profile = { ...resolveOrbProfile({ profile: "plasma" }), palette: { highlight: [1, 0, 0] } };
    const html = renderToStaticMarkup(createElement(AgentAvatarProvider, { profile, children: createElement(AgentAvatar) }));

    expect(html).toContain('data-orb="fallback"');
    expect(html).toContain("rgb(255 0 0)");
    // The old mark was a thin ellipse across a dark disc, which read as a squashed orb.
    expect(html).not.toContain("ellipse");
  });

  it("is still drawn without a provider, from the shipped palette", () => {
    const html = renderToStaticMarkup(createElement(AgentAvatar));

    expect(html).toContain('class="cc-avatar"');
    expect(html).toContain("radial-gradient(circle");
  });

  it("is taken from the same options the live orb is drawn with", () => {
    const profile = resolveOrbProfile({ profile: "jelly" });

    expect(orbOptionsFromProfile(profile)).toMatchObject({
      radius: profile.optical.radius,
      glow: profile.optical.glow,
      style: profile.style,
      physics: profile.physics,
    });
    expect(orbOptionsFromProfile(undefined)).toEqual({});
  });
});

import { describe, expect, it } from "vitest";

import { ORB_FRAGMENT_SHADER, ORB_PALETTE, ORB_SHAPE, ORB_VERTEX_SHADER } from "../src/orb-shader.ts";

/**
 * Orb shader source checks.
 *
 * These assert things about the source rather than about rendering, and they exist because the
 * shader lives inside a TypeScript template literal. That boundary is silent: a stray backtick
 * ends the string, and the failure then surfaces as a parse error somewhere else entirely. It
 * happened three times while this was being written, which is what a guard is for.
 */

describe("the shader is valid GLSL ES 1.00", () => {
  it("declares the precision the fragment stage requires", () => {
    // A fragment shader with no default float precision does not compile in GLSL ES.
    expect(ORB_FRAGMENT_SHADER).toContain("precision highp float;");
  });

  it("uses the WebGL1 entry points rather than the ES 3 ones", () => {
    // WebGL1 is the compatibility target on purpose; gl_FragColor and varying are what it has.
    expect(ORB_FRAGMENT_SHADER).toContain("gl_FragColor");
    expect(ORB_VERTEX_SHADER).toContain("varying");
    expect(ORB_VERTEX_SHADER).toContain("gl_Position");
    expect(ORB_VERTEX_SHADER).not.toContain("in vec2");
    expect(ORB_FRAGMENT_SHADER).not.toContain("out vec4");
  });

  it("passes the interpolated coordinate under one name in both stages", () => {
    const declared = /varying vec2 (\w+);/.exec(ORB_VERTEX_SHADER)?.[1];
    expect(declared).toBeDefined();
    expect(ORB_FRAGMENT_SHADER).toContain(`varying vec2 ${String(declared)}`);
  });

  it("closes every brace it opens", () => {
    for (const [name, source] of Object.entries({ ORB_VERTEX_SHADER, ORB_FRAGMENT_SHADER })) {
      const opens = (source.match(/\{/g) ?? []).length;
      const closes = (source.match(/\}/g) ?? []).length;
      expect(opens, `${name} has unbalanced braces`).toBe(closes);
    }
  });

  // There is deliberately no "every statement ends in a semicolon" check. A GLSL expression can
  // span lines, so the obvious regex reports every wrapped sum as a failure. A guard that needs
  // exemptions is one people learn to ignore, and the compiler is the real authority here: the
  // browser test fails loudly if the shader does not build.
});

describe("the shader source survives being embedded in TypeScript", () => {
  it("contains no backtick, which would end the template literal early", () => {
    for (const [name, source] of Object.entries({ ORB_VERTEX_SHADER, ORB_FRAGMENT_SHADER })) {
      expect(source.includes("`"), `${name} contains a backtick`).toBe(false);
    }
  });

  it("contains no interpolation sequence, which would be evaluated", () => {
    for (const [name, source] of Object.entries({ ORB_VERTEX_SHADER, ORB_FRAGMENT_SHADER })) {
      expect(source.includes("${"), `${name} contains an interpolation sequence`).toBe(false);
    }
  });
});

describe("the palette is the one the design asked for", () => {
  it("carries four band colours plus the shell and glow", () => {
    for (const key of ["colorA", "colorB", "colorC", "colorD", "shellMid", "shellEdge", "glowColor"] as const) {
      expect(ORB_PALETTE[key], `${key} is missing`).toHaveLength(3);
    }
  });

  it("keeps every channel inside the range the shader assumes", () => {
    for (const [name, channel] of Object.entries(ORB_PALETTE)) {
      for (const value of channel) {
        expect(value, `${name} has a channel below 0`).toBeGreaterThanOrEqual(0);
        expect(value, `${name} has a channel above 1`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("keeps the reference's shape values", () => {
    expect(ORB_SHAPE.radius).toBeCloseTo(0.72, 5);
    expect(ORB_SHAPE.chromatic).toBeCloseTo(0.42, 5);
    expect(ORB_SHAPE.exposure).toBeCloseTo(2, 5);
  });
});

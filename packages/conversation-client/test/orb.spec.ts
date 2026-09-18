import { describe, expect, it } from "vitest";

import { createOrbRenderer, orbPointerFromClient } from "../src/orb.ts";
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

describe("the orb answers the pointer", () => {
  it("declares the uniforms the renderer sets", () => {
    // The renderer looks these up by name, and a typo in either place is a uniform that is written
    // every frame and read by nothing — which draws perfectly and never reacts.
    for (const name of ["u_pointerStrength", "u_wobble"]) {
      expect(ORB_FRAGMENT_SHADER, `${name} is not declared`).toContain(`uniform float ${name};`);
    }
    expect(ORB_FRAGMENT_SHADER).toContain("uniform vec2  u_pointer;");
  });

  it("puts the pointer where the shader expects to find it", () => {
    const rect = { left: 100, top: 50, width: 200, height: 200 };
    const at = (clientX: number, clientY: number) => orbPointerFromClient({ ...rect, clientX, clientY });

    // The centre of the element is the origin, and a pointer on the sphere is at full strength.
    expect(at(200, 150).x).toBeCloseTo(0, 6);
    expect(at(200, 150).y).toBeCloseTo(0, 6);
    expect(at(200, 150).strength).toBe(1);

    // The page's y grows downwards and the shader's grows up, which is the sign that is easiest to
    // get wrong and hardest to see: the glow would light the opposite side of the orb.
    expect(at(200, 50).y).toBeCloseTo(1, 6);
    expect(at(200, 250).y).toBeCloseTo(-1, 6);
    expect(at(300, 150).x).toBeCloseTo(1, 6);

    // A pointer nowhere near the orb acts on it not at all.
    expect(at(1200, 150).strength).toBe(0);
  });

  it("scales x by the aspect ratio, so a wide canvas is not read as a stretched sphere", () => {
    // `p` is stretched to match the canvas, which keeps the sphere round on a canvas that is not:
    // four units wide and one tall means the right edge is at x = 4, not at x = 1.
    const wide = orbPointerFromClient({ left: 0, top: 0, width: 400, height: 100, clientX: 400, clientY: 50 });
    expect(wide.x).toBeCloseTo(4, 6);
    const square = orbPointerFromClient({ left: 0, top: 0, width: 100, height: 100, clientX: 100, clientY: 50 });
    expect(square.x).toBeCloseTo(1, 6);
  });

  it("does not divide by a collapsed canvas", () => {
    const sample = orbPointerFromClient({ left: 0, top: 0, width: 0, height: 0, clientX: 10, clientY: 10 });
    expect(Number.isFinite(sample.x)).toBe(true);
    expect(Number.isFinite(sample.y)).toBe(true);
  });

  it("sends the pointer position to the shader, and rings while it travels", () => {
    const { canvas, uniform } = fakeWebgl();
    const created = createOrbRenderer(canvas);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const renderer = created.renderer;

    // At rest in the middle: the shader is told where the pointer is, with no light and no ring.
    renderer.setPointer({ x: 0, y: 0, strength: 1 });
    renderer.frame(0);
    renderer.frame(16);
    expect(uniform("u_pointer")).toEqual([0, 0]);
    expect(uniform("u_pointerStrength")?.[0]).toBeCloseTo(1, 5);
    expect(uniform("u_wobble")?.[0]).toBe(0);
    // The shader's clock is the animation rate, not the pointer's: a still mouse must not stop the
    // band from drifting. It did once, because both were called `speed`.
    expect(uniform("u_time")?.[0] ?? 0).toBeCloseTo((16 / 1000) * 1.23, 5);

    // Moved across the orb, the pointer position reaches the shader on the same frame.
    renderer.setPointer({ x: 0.6, y: -0.4, strength: 1 });
    renderer.frame(32);
    expect(uniform("u_pointer")).toEqual([0.6, -0.4]);

    // And the pointer leaving takes the light with it.
    renderer.setPointer({ x: 0.6, y: -0.4, strength: 0 });
    for (let frame = 0; frame < 30; frame += 1) renderer.frame(400 + frame * 16);
    expect(uniform("u_pointerStrength")?.[0] ?? 1).toBeLessThan(0.1);

    renderer.dispose();
  });

  it("squashes like jelly while the pointer travels, and rings as it settles", () => {
    const { canvas, uniform } = fakeWebgl();
    const created = createOrbRenderer(canvas);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const renderer = created.renderer;

    // Dragged across the orb, one frame at a time, the way a hand moves.
    let peak = 0;
    for (let frame = 0; frame < 12; frame += 1) {
      renderer.setPointer({ x: -0.6 + frame * 0.1, y: 0.2, strength: 1 });
      renderer.frame(frame * 16);
      peak = Math.max(peak, Math.abs(uniform("u_wobble")?.[0] ?? 0));
    }
    expect(peak, "the shell barely deformed, so the squash is invisible").toBeGreaterThan(0.15);

    // Held still from here. The wobble must cross zero on the way back: that overshoot is the whole
    // difference between jelly and a value that merely decays towards its target.
    const samples: number[] = [];
    for (let frame = 1; frame <= 60; frame += 1) {
      renderer.frame(192 + frame * 16);
      samples.push(uniform("u_wobble")?.[0] ?? 0);
    }
    expect(samples.some((value) => value > 0)).toBe(true);
    expect(samples.some((value) => value < 0), "the spring never rang back past its rest shape").toBe(true);
    expect(Math.abs(samples.at(-1) ?? 1), "it never settled").toBeLessThan(0.05);

    renderer.dispose();
  });
});

/**
 * A WebGL context that behaves the way the real one does in the two ways that matter here: a
 * canvas hands out the same context to every caller, and a context that has been lost stays lost
 * and fails compilation with an empty log.
 *
 * A stub rather than a real context because the bug this guards against is about the lifecycle of
 * the object, not about what it draws. Node has no WebGL, and a headless browser cannot reach this
 * code path at all: React only runs the effect twice under StrictMode in development, and the
 * browser suite runs a production build.
 */
function fakeWebgl() {
  let lost = false;
  const compiled = new Map<object, boolean>();
  /**
   * The last value written to each uniform, keyed by name.
   *
   * The stub hands back the uniform's name as its location, which is what lets a test ask what the
   * shader was actually told — `getUniformLocation` returning null would make every write
   * unattributable, and a renderer that scaled the wrong value would look identical.
   */
  const uniforms = new Map<string, number[]>();
  const record = (name: string, values: number[]): void => {
    uniforms.set(name, values);
  };
  const gl = {
    ARRAY_BUFFER: 1,
    STATIC_DRAW: 2,
    FLOAT: 3,
    TRIANGLES: 4,
    VERTEX_SHADER: 5,
    FRAGMENT_SHADER: 6,
    COMPILE_STATUS: 7,
    LINK_STATUS: 8,
    BLEND: 9,
    ONE: 10,
    ONE_MINUS_SRC_ALPHA: 11,
    COLOR_BUFFER_BIT: 12,

    isContextLost: () => lost,
    getExtension: (name: string) =>
      name === "WEBGL_lose_context" ? { loseContext: () => { lost = true; } } : null,

    createShader: () => ({}),
    shaderSource: () => undefined,
    // A lost context fails to compile and says nothing about it, which is exactly what sent the
    // original investigation looking at the shader source.
    compileShader: (shader: object) => { compiled.set(shader, !lost); },
    getShaderParameter: (shader: object, parameter: number) =>
      parameter === 7 ? compiled.get(shader) === true : false,
    getShaderInfoLog: () => "",
    deleteShader: () => undefined,

    createProgram: () => ({}),
    attachShader: () => undefined,
    linkProgram: () => undefined,
    getProgramParameter: (_program: object, parameter: number) => parameter === 8 && !lost,
    getProgramInfoLog: () => "",
    useProgram: () => undefined,
    deleteProgram: () => undefined,

    createBuffer: () => ({}),
    bindBuffer: () => undefined,
    bufferData: () => undefined,
    deleteBuffer: () => undefined,
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => undefined,
    vertexAttribPointer: () => undefined,
    getUniformLocation: (_program: object, name: string) => name,
    uniform1f: (location: string, value: number) => record(location, [value]),
    uniform2f: (location: string, x: number, y: number) => record(location, [x, y]),
    uniform3f: (location: string, x: number, y: number, z: number) => record(location, [x, y, z]),
    enable: () => undefined,
    blendFunc: () => undefined,
    clear: () => undefined,
    clearColor: () => undefined,
    drawArrays: () => undefined,
    viewport: () => undefined,
  };

  const canvas = {
    width: 0,
    height: 0,
    getContext: () => gl,
    getBoundingClientRect: () => ({ width: 148, height: 148 }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };

  return {
    canvas: canvas as unknown as HTMLCanvasElement,
    isLost: () => lost,
    uniform: (name: string) => uniforms.get(name),
  };
}

/**
 * The dev-only failure.
 *
 * React's StrictMode runs an effect twice in development — mount, cleanup, mount — on the same DOM
 * node. The orb's cleanup disposed its renderer, and disposing used to release the WebGL context; a
 * canvas then handed that same dead context to the second renderer, whose shaders could not
 * compile. Every orb fell back to its CSS gradient in development while looking correct in a
 * production build, which is why nothing caught it.
 */
describe("an orb rebuilt on the same canvas", () => {
  it("still builds, because disposing must not leave the canvas with a dead context", () => {
    const { canvas, isLost } = fakeWebgl();

    const first = createOrbRenderer(canvas);
    expect(first.ok).toBe(true);
    if (first.ok) first.renderer.dispose();

    expect(isLost(), "disposing released the context, which the next orb on this canvas needs").toBe(false);

    const second = createOrbRenderer(canvas);
    expect(second.ok, second.ok ? "" : second.reason).toBe(true);
    if (second.ok) second.renderer.dispose();
  });

  it("names a lost context instead of blaming the shader", () => {
    const { canvas } = fakeWebgl();
    // Reaching in to lose the context the way a GPU reset would, without going through dispose.
    const gl = canvas.getContext("webgl") as unknown as { getExtension: (n: string) => { loseContext: () => void } | null };
    gl.getExtension("WEBGL_lose_context")?.loseContext();

    const created = createOrbRenderer(canvas);
    expect(created.ok).toBe(false);
    if (!created.ok) {
      // The point of the message: a reader must not be sent to the shader source for this.
      expect(created.reason).toContain("lost");
      expect(created.reason).not.toContain("did not compile");
    }
  });
});

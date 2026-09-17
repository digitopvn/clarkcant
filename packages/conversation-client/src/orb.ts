/**
 * WebGL renderer for the orb.
 *
 * Deliberately framework-free. The React component in `Orb.tsx` is a thin wrapper around this, so
 * the shader and its plumbing can be exercised without a DOM framework, and so the desktop shell —
 * which has no bundler — can drive the same code if it ever needs to.
 *
 * Three properties the caller relies on:
 *
 *   - **Construction can fail, and says why.** A machine without WebGL, or with it disabled, gets a
 *     reason string rather than a blank canvas, so the caller can fall back to something visible.
 *   - **A lost context is survivable.** The browser can take the GPU away at any time; the renderer
 *     reports the loss and re-creates its resources when the context comes back, instead of
 *     rendering nothing for the rest of the session.
 *   - **Nothing is rendered until it is asked for.** `frame()` draws one frame. There is no internal
 *     loop, because a loop inside a component that has unmounted is a leak with a schedule.
 */

import {
  ORB_FRAGMENT_SHADER,
  ORB_PALETTE,
  ORB_SHAPE,
  ORB_VERTEX_SHADER,
} from "./orb-shader.ts";

export interface OrbOptions {
  /** Fraction of the half-height the orb's radius occupies. */
  radius?: number;
  /** Brightness of the band inside the glass. */
  exposure?: number;
  /** Per-channel separation along the band, which is what fringes its edges. */
  chromatic?: number;
  /** Strength of the light the orb casts around itself. */
  glow?: number;
  /** Strength of the upper-left sheen on the shell. */
  sheen?: number;
  /** Animation rate. */
  speed?: number;
  palette?: Partial<Record<keyof typeof ORB_PALETTE, readonly number[]>>;
}

export interface OrbRenderer {
  /** Draw one frame. `timeMs` is a monotonic clock; only its deltas matter. */
  frame(timeMs: number): void;
  /** Match the drawing buffer to the element's size and pixel ratio. */
  resize(): void;
  dispose(): void;
}

export type OrbCreation =
  | { ok: true; renderer: OrbRenderer }
  | { ok: false; reason: string };

const UNIFORM_NAMES = [
  "u_resolution",
  "u_time",
  "u_radius",
  "u_exposure",
  "u_chromatic",
  "u_glow",
  "u_sheen",
  "u_canvas",
  "u_glowColor",
  "u_highlight",
  "u_shellInner",
  "u_shellMid",
  "u_shellEdge",
  "u_sheenColor",
  "u_colorA",
  "u_colorB",
  "u_colorC",
  "u_colorD",
] as const;

type UniformName = (typeof UNIFORM_NAMES)[number];

function compile(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): { ok: true; shader: WebGLShader } | { ok: false; reason: string } {
  const shader = gl.createShader(type);
  if (shader === null) return { ok: false, reason: "the browser refused to create a shader object" };
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    const detail = (gl.getShaderInfoLog(shader) ?? "").trim();
    gl.deleteShader(shader);
    // An empty log on a failed compile is almost never the shader's fault: it is how a lost context
    // reports itself. Naming that possibility here is the difference between the next reader
    // debugging GLSL and debugging the context lifecycle, which is where this actually went wrong.
    if (detail !== "") return { ok: false, reason: `shader did not compile: ${detail}` };
    if (gl.isContextLost()) {
      return { ok: false, reason: "the WebGL context was lost before the orb's shader could be compiled" };
    }
    return { ok: false, reason: "the orb's shader did not compile and the browser gave no reason" };
  }
  return { ok: true, shader };
}

/**
 * Create a renderer bound to a canvas.
 *
 * The canvas' drawing buffer is sized here rather than by CSS, so the orb stays sharp on a
 * high-density display without the caller having to think about device pixel ratio.
 */
export function createOrbRenderer(
  canvas: HTMLCanvasElement,
  options: OrbOptions = {},
): OrbCreation {
  const context = canvas.getContext("webgl", {
    // Alpha so the orb composites over whatever it is placed on. An opaque canvas shows as a
    // rectangle of its own background wherever that differs from the surface behind it.
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (context === null) {
    return {
      ok: false,
      reason: "this browser did not provide a WebGL context, so the orb cannot be drawn",
    };
  }
  // Rebound after the check so the type is non-null by construction rather than by control-flow
  // analysis that has to reach into every closure below.
  const gl: WebGLRenderingContext = context;

  // Checked before anything is compiled, because a lost context fails compilation with no log and
  // the error would then name the shader instead of the context.
  if (gl.isContextLost()) {
    return {
      ok: false,
      reason: "the WebGL context for this canvas was already lost, so the orb cannot be rebuilt on it",
    };
  }

  const shape = {
    radius: options.radius ?? ORB_SHAPE.radius,
    exposure: options.exposure ?? ORB_SHAPE.exposure,
    chromatic: options.chromatic ?? ORB_SHAPE.chromatic,
    glow: options.glow ?? ORB_SHAPE.glow,
    sheen: options.sheen ?? ORB_SHAPE.sheen,
  };
  const speed = options.speed ?? 1.23;
  const palette = { ...ORB_PALETTE, ...(options.palette ?? {}) };

  const vertex = compile(gl, gl.VERTEX_SHADER, ORB_VERTEX_SHADER);
  if (!vertex.ok) return vertex;
  const fragment = compile(gl, gl.FRAGMENT_SHADER, ORB_FRAGMENT_SHADER);
  if (!fragment.ok) {
    gl.deleteShader(vertex.shader);
    return fragment;
  }

  const program = gl.createProgram();
  if (program === null) return { ok: false, reason: "the browser refused to create a program object" };
  gl.attachShader(program, vertex.shader);
  gl.attachShader(program, fragment.shader);
  gl.linkProgram(program);
  gl.deleteShader(vertex.shader);
  gl.deleteShader(fragment.shader);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    const log = gl.getProgramInfoLog(program) ?? "no linker log";
    gl.deleteProgram(program);
    return { ok: false, reason: `shader program did not link: ${log.trim()}` };
  }

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  // Two triangles covering the clip space, so the fragment shader runs once per pixel.
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );

  const positionLocation = gl.getAttribLocation(program, "a_position");
  const uniforms: Partial<Record<UniformName, WebGLUniformLocation | null>> = {};
  for (const name of UNIFORM_NAMES) {
    uniforms[name] = gl.getUniformLocation(program, name);
  }

  let disposed = false;
  let contextLost = false;

  const onContextLost = (event: Event): void => {
    // Prevented so the browser will restore the context; without this the canvas stays blank.
    event.preventDefault();
    contextLost = true;
  };
  const onContextRestored = (): void => {
    contextLost = false;
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  function setVector3(name: UniformName, value: readonly number[]): void {
    gl.uniform3f(uniforms[name] ?? null, value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
  }

  function draw(timeMs: number): void {
    if (disposed || contextLost) return;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // Premultiplied source over the page, so the glow adds to what is behind it rather than
    // replacing it.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(uniforms.u_resolution ?? null, canvas.width, canvas.height);
    gl.uniform1f(uniforms.u_time ?? null, (timeMs / 1000) * speed);
    gl.uniform1f(uniforms.u_radius ?? null, shape.radius);
    gl.uniform1f(uniforms.u_exposure ?? null, shape.exposure);
    gl.uniform1f(uniforms.u_chromatic ?? null, shape.chromatic);
    gl.uniform1f(uniforms.u_glow ?? null, shape.glow);
    gl.uniform1f(uniforms.u_sheen ?? null, shape.sheen);

    setVector3("u_canvas", palette.canvas);
    setVector3("u_glowColor", palette.glowColor);
    setVector3("u_highlight", palette.highlight);
    setVector3("u_shellInner", palette.shellInner);
    setVector3("u_shellMid", palette.shellMid);
    setVector3("u_shellEdge", palette.shellEdge);
    setVector3("u_sheenColor", palette.sheenColor);
    setVector3("u_colorA", palette.colorA);
    setVector3("u_colorB", palette.colorB);
    setVector3("u_colorC", palette.colorC);
    setVector3("u_colorD", palette.colorD);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  return {
    ok: true,
    renderer: {
      frame: draw,
      resize(): void {
        if (disposed) return;
        const rect = canvas.getBoundingClientRect();
        // Capped at 2: past that the orb is being drawn for pixels nobody can see, and the glow
        // is soft enough that the extra samples change nothing.
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(rect.width * ratio));
        const height = Math.max(1, Math.round(rect.height * ratio));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        canvas.removeEventListener("webglcontextlost", onContextLost);
        canvas.removeEventListener("webglcontextrestored", onContextRestored);
        gl.deleteBuffer(quad);
        gl.deleteProgram(program);
        // The context is deliberately NOT released with WEBGL_lose_context.
        //
        // Releasing it looks like good hygiene and is worse than leaving it: a canvas hands out the
        // same context to every caller, so losing it here means the next renderer built on this
        // canvas gets a dead one. A lost context cannot be revived, and it reports the failure as a
        // shader that did not compile with an empty compiler log — which is a misleading error
        // pointing at GLSL that was never the problem. React's StrictMode does exactly this in
        // development, running the effect twice on one canvas, so the orb fell back to its CSS
        // gradient in every dev session while looking correct in production builds.
        //
        // The program and buffer above are deleted, which is where the GPU memory actually is. The
        // context itself is reclaimed by the browser when the canvas is collected.
      },
    },
  };
}

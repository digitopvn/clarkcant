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
  type OrbStyle,
  orbStyleIndex,
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
  /**
   * Ceiling on the drawing buffer's pixel ratio.
   *
   * Two by default, because past that the orb is drawn for pixels nobody can see. A very large orb can
   * afford to be lower still: it is a soft glow, and doubling the buffer on a 720 pixel orb quadruples
   * the fragments the shader runs per frame for a difference nobody can point at.
   */
  maxPixelRatio?: number;
  /** What is drawn inside the glass. The band, the signature orb, when absent. */
  style?: OrbStyle;
  palette?: Partial<Record<keyof typeof ORB_PALETTE, readonly number[]>>;
  /**
   * The shell's spring and its pointer gains.
   *
   * Every field is optional and every fallback is the shipped value, so this is a patch over the orb
   * rather than a description of it. Values are the caller's to bound: the profile resolver clamps them
   * against the contracts bounds before they arrive here.
   */
  physics?: OrbPhysicsOptions;
}

/**
 * The spring of the shell, and how strongly it answers a pointer.
 *
 * Underdamped on purpose: the damping ratio is below one, which is what makes it overshoot and ring
 * rather than approach its rest shape from one side. Stiff enough to answer a flick immediately, soft
 * enough that the ringing is visible as jelly rather than as a glitch.
 *
 * These are the shipped values rather than the only ones. A profile may change them within the bounds
 * the contracts package declares, and a profile that names none of them renders exactly as the orb
 * always has — which is what makes personalization additive instead of a new default.
 */
export const ORB_PHYSICS_DEFAULTS = {
  stiffness: 90,
  damping: 7.5,
  /** Scales how far a flick deforms the shell. Zero is a shell that never rings. */
  wobbleGain: 1,
  /** Scales how strongly the pointer lights the orb. */
  pointerResponse: 1,
} as const;

export interface OrbPhysicsOptions {
  stiffness?: number;
  damping?: number;
  wobbleGain?: number;
  pointerResponse?: number;
}

export interface OrbPointerSample {
  /** Pointer position in the shader's own space: 1 is half the canvas, y pointing up. */
  x: number;
  y: number;
  /** 1 while the pointer is over the orb, fading to 0 well outside it. */
  strength: number;
}

/** The part of a DOM rect this needs, so a test can pass four numbers instead of a DOM. */
export interface OrbPointerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Turn a pointer position on the page into the orb's own coordinates.
 *
 * Exported because it is the one part of the interaction that is pure arithmetic, and the arithmetic
 * has two traps in it that are invisible by reading the shader: the fragment coordinate's y points
 * up while the page's points down, and x is scaled by the aspect ratio, so a pointer over a wide
 * canvas is not at the x the shader would read from an unscaled value. Both mistakes show up only as
 * a glow that lights the wrong part of the orb — or the opposite side of it.
 */
export function orbPointerFromClient(input: OrbPointerRect & { clientX: number; clientY: number }): OrbPointerSample {
  // Guarded against a zero-sized canvas, which is what an orb inside a collapsed container reports.
  const width = Math.max(input.width, 1);
  const height = Math.max(input.height, 1);
  const u = (input.clientX - input.left) / width;
  const v = 1 - (input.clientY - input.top) / height;
  const aspect = width / height;

  const dx = u * width - width / 2;
  const dy = input.clientY - input.top - height / 2;
  const distance = Math.hypot(dx, dy);
  // The radius of the drawn sphere is `ORB_SHAPE.radius` of the half-height, not the whole element,
  // so the reaction starts before the pointer reaches the visible silhouette and fades out well
  // beyond it: light arriving from nearby is what this is, not a hover state on a box.
  const radius = (Math.min(width, height) / 2) * ORB_SHAPE.radius;
  const strength = Math.max(0, Math.min(1, (radius * 2.4 - distance) / (radius * 1.6)));

  return { x: (u - 0.5) * 2 * aspect, y: (v - 0.5) * 2, strength };
}

/**
 * Renderer names that mean WebGL is being drawn by the CPU rather than a GPU.
 *
 * Chromium and Electron fall back to SwiftShader everywhere; Mesa's llvmpipe, softpipe and lavapipe are what a
 * Linux machine without a working driver gets; Windows' WARP adapter reports itself as the Microsoft Basic Render
 * Driver; macOS names its own "Apple Software Renderer". A name that matches none of these — including no name at
 * all — is treated as a GPU, so an unknown machine keeps the orb exactly as designed.
 */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|lavapipe|basic render driver|apple software renderer/i;

export function isSoftwareRenderer(name: string | undefined): boolean {
  return name !== undefined && SOFTWARE_RENDERER.test(name);
}

/**
 * The name of whatever draws this context.
 *
 * `RENDERER` first, because Firefox and newer Chromium answer it with the real (if coarsened) name and Firefox warns
 * when the debug extension is asked for. Chromium still answers the masked "WebKit WebGL" there, and gives the real
 * name through `WEBGL_debug_renderer_info`.
 */
export function readWebglRenderer(gl: WebGLRenderingContext): string | undefined {
  const plain: unknown = gl.getParameter(gl.RENDERER);
  if (typeof plain === "string" && plain !== "" && !/^webkit webgl$/i.test(plain.trim())) return plain;
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const unmasked: unknown = debug === null ? undefined : gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
  return typeof unmasked === "string" && unmasked !== "" ? unmasked : undefined;
}

/**
 * How often, and at what resolution, the orb may be drawn.
 *
 * On a GPU nothing is held back: every animation frame, at the caller's own pixel-ratio ceiling. Without one, the
 * fragment shader runs on the CPU for every pixel of every frame, and the animated orb alone took three to seven
 * cores of an idle page. There it waits at least 50 ms between frames (about fifteen a second on a 60 Hz
 * display, since each one still lands on a display frame) and draws into a buffer of half the element's size, which
 * the browser scales up: the orb is a soft glow, so the picture is the same orb, still moving, for about a tenth of
 * the work. A small orb keeps its full resolution, because its few pixels cost nothing and halving them is what
 * would show.
 */
export interface OrbFrameBudget {
  /** Shortest time between two drawn frames. Zero draws on every animation frame. */
  minFrameIntervalMs: number;
  /** Ceiling on the drawing buffer's pixel ratio, applied under the caller's own `maxPixelRatio`. */
  pixelRatioCap: number;
  /** The cap above never takes the buffer below this many pixels across, nor above the caller's own ceiling. */
  minBufferPx: number;
}

export const ORB_GPU_BUDGET: OrbFrameBudget = {
  minFrameIntervalMs: 0,
  pixelRatioCap: Number.POSITIVE_INFINITY,
  minBufferPx: 0,
};
export const ORB_SOFTWARE_BUDGET: OrbFrameBudget = { minFrameIntervalMs: 50, pixelRatioCap: 0.5, minBufferPx: 128 };

/** The drawing buffer's pixel ratio for an element `sidePx` across, within a budget and the caller's ceiling. */
export function orbPixelRatio(budget: OrbFrameBudget, sidePx: number, devicePixelRatio: number, maxPixelRatio: number): number {
  const natural = Math.min(devicePixelRatio, maxPixelRatio);
  const floor = Math.min(natural, budget.minBufferPx / Math.max(sidePx, 1));
  return Math.max(Math.min(natural, budget.pixelRatioCap), floor);
}

export function orbFrameBudget(software: boolean): OrbFrameBudget {
  return software ? ORB_SOFTWARE_BUDGET : ORB_GPU_BUDGET;
}

/** The parts of `window` the frame scheduler uses, so a test can drive it with a fake clock. */
export interface OrbFrameClock {
  requestAnimationFrame(callback: (timeMs: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface OrbFrameScheduler {
  /**
   * Ask for one call of `callback` on an animation frame. `afterInterval` waits out the budget's interval first,
   * which is what the loop asks for after a frame it drew; the first frame of a (re)start is drawn at once.
   * A request while one is already pending is ignored.
   */
  request(callback: (timeMs: number) => void, afterInterval: boolean): void;
  cancel(): void;
  readonly pending: boolean;
}

/**
 * Schedule the orb's frames within a budget.
 *
 * With no interval this is `requestAnimationFrame`, exactly as before. With one, the wait is a timer and not a run of
 * skipped animation frames: a page that keeps asking for animation frames keeps the compositor producing them, and
 * without a GPU that alone cost half a core while the orb drew nothing. The draw itself still lands on an animation
 * frame, so it is in step with the display.
 */
export function createOrbFrameScheduler(clock: OrbFrameClock, minFrameIntervalMs: number): OrbFrameScheduler {
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onFrame = (callback: (timeMs: number) => void) => (timeMs: number): void => {
    frame = 0;
    callback(timeMs);
  };
  return {
    request(callback, afterInterval) {
      if (frame !== 0 || timer !== undefined) return;
      if (!afterInterval || minFrameIntervalMs <= 0) {
        frame = clock.requestAnimationFrame(onFrame(callback));
        return;
      }
      timer = clock.setTimeout(() => {
        timer = undefined;
        frame = clock.requestAnimationFrame(onFrame(callback));
      }, minFrameIntervalMs);
    },
    cancel() {
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
      if (frame !== 0) clock.cancelAnimationFrame(frame);
      frame = 0;
    },
    get pending() {
      return frame !== 0 || timer !== undefined;
    },
  };
}
export interface OrbRenderer {
  /**
   * Whether this context is drawn by the CPU. Decided once, when the renderer is built, from the renderer's name.
   * The caller reads `orbFrameBudget(software)` for how often to call `frame()`; `resize()` already applies its
   * resolution ceiling.
   */
  readonly software: boolean;
  /** Draw one frame. `timeMs` is a monotonic clock; only its deltas matter. */
  frame(timeMs: number): void;
  /** Match the drawing buffer to the element's size and pixel ratio. */
  resize(): void;
  /**
   * Where the pointer is and how strongly it is acting on the orb.
   *
   * Called once per frame rather than on every pointer event, so the smoothing below is a function
   * of time and not of how often the mouse reports. A renderer that never receives one draws at
   * rest, which is what a reduced-motion single frame and a touch device both want.
   */
  setPointer(sample: OrbPointerSample): void;
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
  "u_style",
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
  "u_pointer",
  "u_pointerStrength",
  "u_wobble",
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
  const style = orbStyleIndex(options.style);
  const speed = options.speed ?? 1.23;
  const physics = {
    stiffness: options.physics?.stiffness ?? ORB_PHYSICS_DEFAULTS.stiffness,
    damping: options.physics?.damping ?? ORB_PHYSICS_DEFAULTS.damping,
    wobbleGain: options.physics?.wobbleGain ?? ORB_PHYSICS_DEFAULTS.wobbleGain,
    pointerResponse: options.physics?.pointerResponse ?? ORB_PHYSICS_DEFAULTS.pointerResponse,
  };
  const palette = { ...ORB_PALETTE, ...(options.palette ?? {}) };
  const software = isSoftwareRenderer(readWebglRenderer(gl));
  const budget = orbFrameBudget(software);

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

  /*
   * Pointer state, all of it per renderer rather than per option.
   *
   * `strength` is eased and `wobble` is driven by how fast the pointer travelled since the previous
   * frame, with a fast attack and a slow release. That asymmetry is the whole behaviour: a bubble
   * answers a moving finger immediately and keeps ringing briefly after it stops, while a symmetric
   * filter would look like a value catching up with a target.
   */
  const pointer = { x: 0, y: 0 };
  let pointerTargetStrength = 0;
  let pointerStrength = 0;
  let wobble = 0;
  let wobbleVelocity = 0;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let lastFrameMs: number | undefined;

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

    // Clamped: a frame arriving after the tab was hidden for a minute is not a minute of motion,
    // and folding it in would spike the wobble the moment the user came back.
    const dt = lastFrameMs === undefined ? 0 : Math.min(Math.max((timeMs - lastFrameMs) / 1000, 0), 0.1);
    lastFrameMs = timeMs;

    const strengthEase = dt === 0 ? 1 : 1 - Math.exp(-dt / 0.10);
    /*
     * The pointer gain scales what the pointer asks for, and the result is clamped to 1.
     *
     * The gain is allowed above 1 so a profile can make the orb answer eagerly, but the shader's own
     * `u_pointerStrength` is a 0..1 amount: letting the product exceed it would make the glow clip
     * rather than grow, which reads as a bug in the shader instead of a setting.
     */
    const askedStrength = Math.max(0, Math.min(1, pointerTargetStrength * physics.pointerResponse));
    pointerStrength += (askedStrength - pointerStrength) * strengthEase;

    const travelled = Math.hypot(pointer.x - lastPointerX, pointer.y - lastPointerY);
    lastPointerX = pointer.x;
    lastPointerY = pointer.y;
    // In orb units per second: crossing the whole orb in a fifth of a second is 10. Deliberately not
    // called `speed`, which is the animation rate this renderer was built with: shadowing it here
    // would make the shader's clock follow the pointer, and the orb would stand still whenever the
    // mouse did.
    const travelSpeed = dt > 0 ? travelled / dt : 0;

    /*
     * The shell is a spring, not a filter.
     *
     * A value eased towards a target approaches it and stops, which is what a dent does. Jelly overshoots
     * and rings back the other way, and the difference between those two is entirely in whether the state
     * has a velocity: this one is integrated, underdamped, and pulled towards a target that is how fast
     * the pointer is moving right now. Stillness lets it settle on its own, so the ball comes to rest
     * without anything having to decide that it has.
     *
     * The target is kept below the clamp on purpose. A spring driven to its limit has nowhere to overshoot
     * to, and the overshoot — the part that goes past the rest shape and comes back — is the jelly.
     */
    const target = Math.min(0.6, travelSpeed * 0.10) * pointerTargetStrength * physics.wobbleGain;
    wobbleVelocity += ((target - wobble) * physics.stiffness - wobbleVelocity * physics.damping) * dt;
    wobble += wobbleVelocity * dt;
    // Clamped so a fast flick cannot turn the orb into something unrecognisable, and the velocity is
    // dropped with it so it does not bounce off the limit.
    if (wobble > 1 || wobble < -1) {
      wobble = Math.sign(wobble);
      wobbleVelocity = 0;
    }

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
    gl.uniform1f(uniforms.u_style ?? null, style);
    gl.uniform2f(uniforms.u_pointer ?? null, pointer.x, pointer.y);
    gl.uniform1f(uniforms.u_pointerStrength ?? null, pointerStrength);
    gl.uniform1f(uniforms.u_wobble ?? null, wobble);

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
      software,
      frame: draw,
      setPointer(sample: OrbPointerSample): void {
        if (disposed) return;
        pointer.x = sample.x;
        pointer.y = sample.y;
        pointerTargetStrength = Math.max(0, Math.min(1, sample.strength));
      },
      resize(): void {
        if (disposed) return;
        const rect = canvas.getBoundingClientRect();
        // Capped, and the cap is an option because the orb's size is not fixed: the docked orb is an
        // order of magnitude larger than the one in the header, and the same ratio is wasteful there.
        const ratio = orbPixelRatio(
          budget,
          Math.max(rect.width, rect.height),
          window.devicePixelRatio || 1,
          options.maxPixelRatio ?? 2,
        );
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

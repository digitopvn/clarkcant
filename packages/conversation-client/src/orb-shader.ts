/**
 * Glass-liquid orb shader.
 *
 * A dark glass sphere with a spectral lens across its equator, in the Siri "thinking" register.
 * The look and its parameter names follow the reference editor at
 * https://github.com/LerSent001/orb (MIT), which renders the same idea in WebGPU/WGSL. This is an
 * independent GLSL implementation of that appearance rather than a port of its shader: the
 * reference's 1200-line flow solver is not reproduced, and nothing here claims to match it
 * pixel for pixel. What it keeps is the structure that makes the orb read the way it does — a
 * glass shell, a lens-shaped spectral band with a blown-out core, a rim, and an outer glow — so
 * the two are recognisably the same family.
 *
 * Written for GLSL ES 1.00 on purpose. WebGL1 is available everywhere a browser is, while the
 * reference's WebGPU is not, and nothing here needs a feature WebGL2 adds. An interface that
 * renders for most of its users beats one that renders and looks better for some.
 *
 * The colours are the ones the reference URL specified. They are uniforms rather than literals so
 * a caller can theme the orb without editing the shader.
 */

export const ORB_VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const ORB_FRAGMENT_SHADER = `
precision highp float;

uniform vec2  u_resolution;
uniform float u_time;
uniform float u_radius;
uniform float u_exposure;
uniform float u_chromatic;
uniform float u_glow;
uniform float u_sheen;

  /**
   * Where the pointer is, how close it is, and how much the shell is still ringing from it.
   *
   * u_wobble is signed: it alternates as the spring rings, so the shell squashes and then stretches
   * rather than only ever squashing. These three are what make the orb answer to a mouse rather than
   * merely animate near it.
   */
  uniform vec2  u_pointer;
  uniform float u_pointerStrength;
  uniform float u_wobble;

uniform vec3  u_canvas;
uniform vec3  u_glowColor;
uniform vec3  u_highlight;
uniform vec3  u_shellInner;
uniform vec3  u_shellMid;
uniform vec3  u_shellEdge;
uniform vec3  u_sheenColor;
uniform vec3  u_colorA;
uniform vec3  u_colorB;
uniform vec3  u_colorC;
uniform vec3  u_colorD;

varying vec2 v_uv;

/**
 * The band's colour as a function of horizontal position.
 *
 * Sampled as a function rather than interpolated across vertices, because the dispersion below
 * needs it at three slightly different positions to separate the channels.
 */
vec3 spectrum(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(u_colorB, u_highlight, smoothstep(0.00, 0.28, t));
  c = mix(c, u_colorA, smoothstep(0.28, 0.52, t));
  c = mix(c, u_colorC, smoothstep(0.52, 0.76, t));
  return mix(c, u_colorD, smoothstep(0.76, 1.00, t));
}

void main() {
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  // y spans -1..1 with the origin at the centre, and x is stretched to match the real aspect so
  // the ball stays round whatever shape the canvas is.
  vec2 raw = (v_uv - 0.5) * vec2(aspect, 1.0) * 2.0;

  float R = u_radius;

  // --- the shape, before the light -------------------------------------
  //
  // A soft body with volume does not just wobble in place: pushed anywhere, it compresses along the
  // line of the push and bulges sideways, and it rings back and forth past its rest shape. That is what
  // this does — squash along the direction of the pointer, bulge across it — and the sign flip comes
  // from the spring in the renderer, which is what makes it jelly rather than a dent.
  vec2 direction = length(u_pointer) > 0.0001 ? normalize(u_pointer) : vec2(1.0, 0.0);
  float squash = clamp(u_wobble, -1.0, 1.0) * u_pointerStrength;
  float along = dot(raw, direction);
  vec2 sideways = raw - direction * along;
  vec2 p = direction * (along * (1.0 - 0.20 * squash)) + sideways * (1.0 + 0.14 * squash);
  float r = length(p);

  // --- what the pointer is doing to the shell --------------------------
  //
  // Measured in the undeformed space, because it is about where the pointer is rather than about where
  // the surface ended up: the ring travels outward from the touch, and the light gathers there.
  float pointerDist = length(raw - u_pointer);
  // A soft, local falloff. Steep enough that the far side of the ball is untouched, wide enough
  // that the lit area is a pool rather than a pixel.
  float touch = exp(-pointerDist * 2.4);
  float pointerLight = u_pointerStrength * (0.55 + 0.45 * abs(u_wobble));

  // A travelling ripple on top of the squash, so the surface itself reads as a membrane rather than
  // as a scaled shape. The wave runs outward from the touch point.
  float ripple = sin(pointerDist * 13.0 - u_time * 5.0) * 0.022 * abs(u_wobble) * exp(-pointerDist * 2.0);
  float R_local = R + ripple;

  // The shell boundary. The reference exposes this as edgeSoftness; it stays small because a
  // blurred silhouette reads as a smudge rather than as glass. Backticks are avoided inside these
  // shader strings because the GLSL lives in a TypeScript template literal and one would end it.
  float edge = 0.006;
  float inside = 1.0 - smoothstep(R_local - edge, R_local + edge, r);
  float outside = 1.0 - inside;

  // --- the band ---------------------------------------------------------
  // A lens: widest at the equator, tapering to nothing at the left and right of the silhouette.
  // The taper is what keeps the band from being clipped by the sphere edge.
  float nx = p.x / R;
  float lens = sqrt(max(0.0, 1.0 - nx * nx));

  // A slow drift, so the band breathes instead of sitting still. Two frequencies keep it from
  // looking like a single sine, and the lens weighting concentrates the movement towards the
  // middle: the band is anchored where it meets the glass and moves most where it is widest.
  float sway = pow(lens, 1.30);
  float drift = sin(nx * 3.2 + u_time * 1.15) * 0.045 * sway
              + sin(nx * 6.1 - u_time * 0.70) * 0.016 * sway;
  // The band is dragged towards the pointer's height, most strongly right under it: this is the
  // refraction a real bubble shows, where the thing behind it appears to bend towards the touch.
  // Capped, because an uncapped pull would fold the band onto itself and read as a glitch.
  float pull = clamp(u_pointer.y - p.y, -0.16, 0.16) * 0.9 * touch * u_pointerStrength;
  float y = p.y - drift - pull;

  // Two vertical profiles: a broad halo that lights the glass around the band, and a thin core
  // that is the bright line itself. The exponents matter more than the amplitudes — a low power
  // keeps the band the same thickness across the whole width, which reads as a stripe, while a
  // higher one tapers it towards the ends and reads as a lens. The exponents are kept just under
  // the exponent on the lens itself so the band is thickest in the middle.
  float haloH = 0.270 * pow(lens, 1.40);
  float coreH = 0.056 * pow(lens, 1.90);
  // Gated by the lens itself, fading out well before the silhouette. Without the gate the profiles
  // are evaluated with a vanishing denominator where the lens closes, so the gaussian is taken at
  // zero over a near-zero width and returns one — a bright hairline running off the equator. The
  // band also has to be gone by the edge rather than pinched at it: a coloured sliver sitting hard
  // against the silhouette reads as a stripe painted across the ball, not as light inside glass.
  float gate = step(abs(nx), 1.0) * smoothstep(0.30, 0.78, lens);
  float halo = exp(-pow(y / max(haloH, 1e-4), 2.0)) * gate;
  float core = exp(-pow(y / max(coreH, 1e-4), 2.0)) * gate;

  // Horizontal position along the band, and the per-channel separation that gives the edges their
  // colour fringing.
  float t = nx * 0.5 + 0.5;
  float disp = 0.055 * u_chromatic;
  vec3 band = vec3(spectrum(t + disp).r, spectrum(t).g, spectrum(t - disp).b);

  // --- composition ------------------------------------------------------

  // The glass body stays dark: barely above the surface it sits on, picking up the shell's violet
  // only near the equator. A lighter ball loses the glass and reads as a marble.
  vec3 body = u_canvas + u_shellEdge * (0.020 + 0.090 * lens);

  // Everything the band emits, gathered so the exposure uniform stays one real control over it
  // rather than being multiplied into three separate terms.
  vec3 emissive = band * halo * 0.42
                + band * core * 0.32
                // Raised to a high power so the centre concentrates into a line rather than
                // washing the whole ball out.
                + u_highlight * pow(core, 2.6) * 0.55;

  // A soft brightening just inside the silhouette, kept low: the edge should read as glass, not
  // as a neon tube. It brightens where the pointer is, which is the rim of the bubble catching the
  // light at the point it is being touched.
  float rim = smoothstep(R_local * 0.88, R_local, r) * inside;
  vec3 rimTint = mix(u_shellMid, u_shellEdge, 0.35) * rim * (0.14 + 0.55 * touch * u_pointerStrength);

  // A sheen where the shell catches the light, biased to the upper left as the reference does.
  float sheen = pow(max(0.0, 1.0 - length(p - vec2(-R * 0.42, R * 0.52)) / (R * 0.95)), 3.0);
  vec3 sheenTint = u_sheenColor * sheen * inside * u_sheen * 0.30;

  vec3 glass = body + emissive * inside * (u_exposure * 0.5) + rimTint + sheenTint;

  // The pool of light at the pointer. It is added on both sides of the silhouette, because a
  // highlight that stops dead at the edge reads as something painted inside the ball; what is
  // being drawn is light arriving from wherever the mouse is.
  vec3 flare = (u_highlight * 0.30 + u_glowColor * 0.45) * pow(touch, 1.5) * pointerLight;
  glass += flare;

  // --- alpha -------------------------------------------------------------
  //
  // The orb is composited rather than painted onto a background of its own. That matters wherever
  // it sits on something that is not the page: a rectangle of the page's colour behind a small orb
  // in the header is visible as a box, and hardcoding a background per usage makes the orb's
  // appearance depend on where it was put.
  //
  // Output is premultiplied, and the renderer blends with ONE, ONE_MINUS_SRC_ALPHA. The glow is
  // therefore additive — the colour it carries is added to whatever is behind it, which is what a
  // glow does.
  // The falloff is steep so the orb sits in its own light without washing purple over the whole
  // canvas — which is only visible at all now that the canvas is transparent.
  float glowMask = exp(-max(0.0, r - R) * 16.0) * outside;
  vec3 col = mix(u_glowColor * u_glow * 1.1 + flare, glass, inside);
  // The flare carries its own opacity outside the shell, or a premultiplied colour added where
  // alpha is zero is invisible: the light would be computed every frame and never drawn.
  float flareAlpha = clamp(dot(flare, vec3(0.3333)) * 1.8, 0.0, 0.85) * outside;
  float alpha = clamp(inside + glowMask * 0.9 + flareAlpha, 0.0, 1.0);

  gl_FragColor = vec4(col * alpha, alpha);
}
`;

/**
 * The palette the reference URL specified, as linear-ish RGB triples.
 *
 * Kept as data so a test can check the shader's uniforms against what the design asked for, and
 * so nothing has to be re-derived from the URL by hand.
 */
export const ORB_PALETTE = {
  canvas: [0.012, 0.016, 0.035],
  glowColor: [0.584, 0.424, 1.0],
  highlight: [1.0, 1.0, 1.0],
  shellInner: [1.0, 1.0, 1.0],
  shellMid: [0.608, 0.957, 1.0],
  shellEdge: [0.773, 0.663, 1.0],
  sheenColor: [0.918, 0.957, 1.0],
  colorA: [1.0, 0.847, 0.42],
  colorB: [0.51, 0.957, 1.0],
  colorC: [1.0, 0.482, 1.0],
  colorD: [0.557, 0.424, 1.0],
} as const;

export const ORB_SHAPE = {
  radius: 0.72,
  exposure: 2.0,
  chromatic: 0.42,
  glow: 0.30,
  sheen: 0.28,
} as const;

export const ORB_SHADER_STATUS = "implemented-glsl-es-1";

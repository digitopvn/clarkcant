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
 *
 * The interior has three styles, chosen by `u_style` (see `ORB_STYLES`): the spectral band above,
 * which is the signature orb; mother-of-pearl contour layers; and plasma filaments reaching from a
 * lit core to the glass. The last two take their idea from the orb catalogue at shadercn.run
 * ("mother-of-pearl contour bands", "plasma globe") and none of its code: that catalogue publishes
 * no licence, so both are written here from the description alone. Every style shares the same
 * shell, rim, sheen, glow, pointer response and alpha, so a style changes what is inside the glass
 * and never what the orb is.
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
// Which interior to draw: 0 the spectral band, 1 nacre contours, 2 plasma filaments. A whole number
// sent as a float, compared with a half-step margin so no rounding can land between two styles.
uniform float u_style;

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

/**
 * The signature interior: a lens-shaped spectral band across the equator.
 *
 * nx is the horizontal position as a share of the radius and lens the band's vertical allowance at
 * that position; both are also used by the glass body, so they are computed once by the caller.
 */
vec3 bandInterior(vec2 p, float nx, float lens, float touch) {
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

  return band * halo * 0.42
       + band * core * 0.32
       // Raised to a high power so the centre concentrates into a line rather than washing the
       // whole ball out.
       + u_highlight * pow(core, 2.6) * 0.55;
}

/**
 * A smooth scalar field over the disc that folds slowly: three waves, each bent by another, so the
 * contours drawn from it curl rather than run in straight stripes.
 */
float nacreField(vec2 q) {
  float t = u_time * 0.35;
  float v = sin(q.x * 3.1 + t + sin(q.y * 2.3 - t * 0.7));
  v += 0.60 * sin(q.y * 4.3 - t * 0.8 + sin(q.x * 3.7 + t * 0.5));
  v += 0.35 * sin((q.x + q.y) * 6.1 + t * 1.3);
  return v;
}

/** One contour layer's colour at a level of the field. */
vec3 nacreLayer(float level) {
  float layer = floor(level);
  float within = level - layer;
  // Each layer its own hue: a fixed stride through the spectrum, so neighbours never share one.
  vec3 hue = spectrum(fract(layer * 0.382 + 0.15));
  // A thin bright seam where one layer meets the next, which is what reads as nacre rather than as
  // a map of coloured regions.
  float seam = 1.0 - smoothstep(0.0, 0.09, min(within, 1.0 - within));
  return hue * (0.34 + 0.30 * within) + u_highlight * seam * 0.30;
}

/** Mother-of-pearl: contour layers of a folding field, wrapped over the sphere. */
vec3 pearlInterior(vec2 p, float R, float touch) {
  vec2 q = p / R;
  // The sphere's facing: 1 at the centre, 0 at the silhouette. Adding it to the level is what wraps
  // the contours around the ball instead of printing them flat across it.
  float facing = sqrt(max(0.0, 1.0 - dot(q, q)));
  // The pointer draws the contours towards itself, the way a lens bends what is behind it.
  q += (u_pointer / max(R, 1e-4) - q) * touch * 0.18 * u_pointerStrength;
  float level = nacreField(q) * 1.6 + facing * 1.4;
  // The same dispersion control as the band, so "chromatic fringe" means one thing in every style.
  float disp = 0.12 * u_chromatic;
  vec3 layers = vec3(nacreLayer(level + disp).r, nacreLayer(level).g, nacreLayer(level - disp).b);
  // Brightest where the surface faces the viewer, falling off towards the rim.
  return layers * (0.30 + 0.70 * facing);
}

/** The unsigned angle between two directions, in radians, wrapped to the short way round. */
float angleGap(float a, float b) {
  return abs(mod(a - b + 3.14159265, 6.28318531) - 3.14159265);
}

/** A plasma globe: filaments crawling from a lit core out to the glass, and one reaching for the pointer. */
vec3 plasmaInterior(vec2 p, float R) {
  vec2 q = p / R;
  float rad = length(q);
  // atan of the origin is undefined in GLSL and some drivers return NaN for it, which a later
  // multiplication by zero does not remove; both angles are therefore only taken away from zero.
  float ang = rad > 1e-4 ? atan(q.y, q.x) : 0.0;
  float t = u_time;
  // Filaments start clear of the core and reach the glass, where a real globe's discharge ends.
  float reach = smoothstep(0.06, 0.24, rad) * (1.0 - smoothstep(0.93, 1.0, rad));
  vec3 col = vec3(0.0);

  // A constant bound, as GLSL ES 1.00 requires of a loop.
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    // Six directions around the ball, each swinging slowly about its own place.
    float base = fi * 1.0471976 + sin(t * 0.45 + fi * 1.7) * 0.55;
    // The filament wanders as it travels out, more the further it has gone.
    float bend = sin(rad * 7.0 - t * 2.4 + fi * 2.3) * 0.28 * rad
               + sin(rad * 13.0 + t * 1.6 + fi) * 0.06 * rad;
    float gap = angleGap(ang, base + bend) * rad;
    float width = 0.018 + 0.030 * rad;
    // A gentle shimmer, well under what reads as flashing even at the fastest animation rate.
    float shimmer = 0.8 + 0.2 * sin(t * 5.0 + fi * 2.1);
    float strand = exp(-(gap * gap) / (width * width)) * shimmer * reach;
    col += spectrum(fract(fi * 0.23 + 0.1)) * strand * 0.55 + u_highlight * pow(strand, 3.0) * 0.35;
  }

  // The discharge a plasma globe sends to a finger on its glass, drawn only while the pointer is near.
  float towards = length(u_pointer) > 1e-4 ? atan(u_pointer.y, u_pointer.x) : 0.0;
  float gapP = angleGap(ang, towards + sin(rad * 9.0 - t * 3.0) * 0.12 * rad) * rad;
  float strandP = exp(-(gapP * gapP) / 0.0016) * reach * u_pointerStrength;
  col += (u_highlight * 0.6 + u_glowColor * 0.5) * strandP;

  // The lit core the filaments leave from.
  col += u_highlight * exp(-rad * 9.0) * 0.9 + u_shellEdge * exp(-rad * 3.0) * 0.22;
  return col;
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

  // --- the interior -----------------------------------------------------
  // A lens: widest at the equator, tapering to nothing at the left and right of the silhouette.
  // The band's taper follows it, which is what keeps the band from being clipped by the sphere
  // edge, and the glass body below uses it for its equatorial tint whichever interior is drawn.
  float nx = p.x / R;
  float lens = sqrt(max(0.0, 1.0 - nx * nx));

  // Everything the interior emits, gathered so the exposure uniform stays one real control over it
  // rather than being multiplied into separate terms. Only the chosen interior is evaluated.
  vec3 emissive;
  if (u_style > 1.5) {
    emissive = plasmaInterior(p, R);
  } else if (u_style > 0.5) {
    emissive = pearlInterior(p, R, touch);
  } else {
    emissive = bandInterior(p, nx, lens, touch);
  }

  // --- composition ------------------------------------------------------

  // How light the surface under the orb is, from its luminance: 0 on a dark page, 1 on a light one.
  // The edges sit far from both themes' canvases, so this is exactly 0 on the dark theme (and on the
  // palette's own default canvas) and every term it blends in below leaves the dark orb untouched.
  float surfaceLight = smoothstep(0.35, 0.75, dot(u_canvas, vec3(0.2126, 0.7152, 0.0722)));

  // The glass body stays dark: barely above the surface it sits on, picking up the shell's violet
  // only near the equator. A lighter ball loses the glass and reads as a marble.
  vec3 body = u_canvas + u_shellEdge * (0.020 + 0.090 * lens);

  // On a light surface the body cannot be the page. The interior is light added to the glass, and
  // light added to a near-white page can only clip to white, so every style became the same blank
  // disc. The ball keeps its own deep glass there instead - the same dark sphere the dark theme
  // shows, tinted a little more by the shell so it reads as coloured glass rather than a grey hole
  // (the shell colour is squared for that tint, which deepens its hue instead of greying it) - and
  // towards the silhouette it takes on the page and the shell's colour, the way a glass ball's edge
  // reflects the bright room around it. That edge is what seats the sphere on the page instead of
  // cutting a dark hole in it.
  float fresnel = pow(clamp(r / R, 0.0, 1.0), 6.0);
  vec3 deepGlass = vec3(0.018, 0.020, 0.045) + u_shellEdge * u_shellEdge * (0.050 + 0.110 * lens);
  deepGlass = mix(deepGlass, mix(u_canvas, u_shellEdge, 0.45), fresnel * 0.60);
  body = mix(body, deepGlass, surfaceLight);

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
  //
  // Which is also why it has to give way at the edge. Outside the shell this light is drawn as its own
  // additive layer, so a pointer taken to the rim paints a wide pool whose outer boundary is the canvas's -
  // the round edge that should never be visible. Reach is where the pointer is as a share of the shell's
  // radius: full light inside 60% of it, nothing at the rim, and what survives in between is concentrated
  // into a smaller pool rather than spread as wide as before.
  float pointerReach = clamp(length(u_pointer) / max(R, 0.0001), 0.0, 1.4);
  float reachFalloff = 1.0 - smoothstep(0.60, 0.97, pointerReach);
  vec3 flare =
    (u_highlight * 0.30 + u_glowColor * 0.45) *
    pow(touch, mix(1.5, 4.5, 1.0 - reachFalloff)) *
    pointerLight *
    reachFalloff;
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
  // On a light page a dim glow colour at high opacity is darker than the page, so the glow reads as
  // a grey shadow ring. There the glow is its own colour at an opacity set by the glow strength: a
  // tinted aura, which is what light looks like on a bright surface.
  vec3 haloColor = mix(u_glowColor * u_glow * 1.1, u_glowColor, surfaceLight);
  float haloOpacity = mix(0.9, clamp(u_glow * 1.5, 0.0, 0.9), surfaceLight);
  vec3 col = mix(haloColor + flare, glass, inside);
  // The flare carries its own opacity outside the shell, or a premultiplied colour added where
  // alpha is zero is invisible: the light would be computed every frame and never drawn.
  float flareAlpha = clamp(dot(flare, vec3(0.3333)) * 1.8, 0.0, 0.85) * outside;
  float alpha = clamp(inside + glowMask * haloOpacity + flareAlpha, 0.0, 1.0);

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

/**
 * The interiors the shader can draw, in `u_style` order: index 0 is sent as 0.0, and so on.
 *
 * "band" is the signature orb and the default for anything that names no style.
 */
export const ORB_STYLES = ["band", "pearl", "plasma"] as const;
export type OrbStyle = (typeof ORB_STYLES)[number];

/** The number `u_style` carries for a style. An unknown style draws the band. */
export function orbStyleIndex(style: OrbStyle | undefined): number {
  const index = style === undefined ? 0 : ORB_STYLES.indexOf(style);
  return index < 0 ? 0 : index;
}

export const ORB_SHADER_STATUS = "implemented-glsl-es-1";

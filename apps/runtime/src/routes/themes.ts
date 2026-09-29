import { type Database } from "@clarkcant/storage";

import { readThemeRegistry, resolveAppearance, type ThemeRegistryDeps } from "../application/themes.ts";
import { type GatewayRequest, type GatewayResponse, json } from "./http.ts";

/**
 * The theme family: the themes this node can draw, and the appearance the person's choice resolves to.
 *
 * Read-only. A theme is chosen by writing `experience.themeRef` through the preference routes, so the choice has the
 * provenance and Undo every other preference has, and a theme is installed, updated and removed through the package
 * routes. Nothing here is a second way to do either.
 */
export interface ThemeRouteDeps {
  services: {
    runtime: { db: Database; identity: { nodeId: string; ownerPrincipalId: string }; dataDir: string };
    conductor: { newId: (prefix: string) => string };
  };
  request: GatewayRequest;
  segments: string[];
}

export function handleThemeRoutes(deps: ThemeRouteDeps): GatewayResponse | undefined {
  const { request, segments } = deps;
  if (request.method !== "GET" || segments.length !== 1) return undefined;
  if (segments[0] !== "themes" && segments[0] !== "appearance") return undefined;

  const { runtime, conductor } = deps.services;
  const registryDeps: ThemeRegistryDeps = {
    db: runtime.db,
    nodeId: runtime.identity.nodeId,
    dataDir: runtime.dataDir,
    ownerPrincipalId: runtime.identity.ownerPrincipalId,
    newId: conductor.newId,
  };
  const registry = readThemeRegistry(registryDeps);

  /*
   * GET /themes — every theme that can be selected, with who provides it, plus the ones that could not be loaded.
   *
   * A broken theme is listed as a problem rather than left out, because "this package's theme is invalid" and "this
   * package has no theme" are different facts, and only one of them is something the person can act on.
   */
  if (segments[0] === "themes") {
    return json(200, { themes: registry.themes, problems: registry.problems, unchecked: registry.unchecked });
  }

  /*
   * GET /appearance — the theme to draw now, and why it is not the chosen one when it is not.
   *
   * The document is the validated one; the client compiles it into token values with the same compiler the host's
   * own stylesheet comes from, so nothing a package wrote reaches the page except values the contract accepts.
   */
  return json(200, resolveAppearance(registryDeps, registry));
}

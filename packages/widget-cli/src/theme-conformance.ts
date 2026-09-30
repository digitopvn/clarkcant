import { installedThemes, readPackage } from "@clarkcant/core";
import { compileAppearance, auditThemeDocument, themeDrawProblem } from "@clarkcant/design-tokens";
import { MOTION_DURATION_NAMES, MOTION_EASING_NAMES } from "@clarkcant/contracts";

import { packageFiles } from "./package-files.ts";
import { runConformance, type ConformanceCheck, type ConformanceReport } from "./conformance.ts";

/** Theme facets use the same compiler/audits as installed themes, never a private author palette. */
export function runThemeConformance(root: string): ConformanceReport {
  const checks: ConformanceCheck[] = [];
  const add = (id: string, group: ConformanceCheck["group"], name: string, ok: boolean, detail: string): void => {
    checks.push({ id, group, name, status: ok ? "pass" : "fail", detail });
  };
  const pkg = readPackage(root);
  add("theme-manifest", "schema", "Package manifest and declarations", pkg.problems.length === 0, pkg.problems.join("; ") || "Current generalized package manifest accepted");
  if (pkg.problems.length === 0) {
    const result = installedThemes({ source: { kind: "local", path: root } });
    add("theme-documents", "schema", "Contained Theme documents", result.ok && result.themes.length > 0 && result.problems.length === 0,
      result.ok ? result.problems.map((problem) => problem.message).join("; ") || `${String(result.themes.length)} checked theme facets` : result.message);
    if (result.ok) {
      for (const theme of result.themes) {
        const prefix = theme.facetId;
        const contrast = auditThemeDocument(theme.document);
        add(`${prefix}:contrast`, "rendering", `${prefix}: text and focus contrast in both schemes`, contrast.every((audit) => audit.failures.length === 0), JSON.stringify(contrast));
        const protectedProblem = themeDrawProblem(theme.document);
        add(`${prefix}:protected`, "security", `${prefix}: protected host semantics and visible boundaries`, protectedProblem === undefined, protectedProblem?.message ?? "Status, focus, disabled states, effects and Orb pass the production audit");
        for (const scheme of ["dark", "light"] as const) {
          const snapshot = compileAppearance({ scheme, theme: theme.document, themeRef: theme.themeRef, reducedMotion: true });
          add(`${prefix}:${scheme}:reduced`, "rendering", `${prefix}: ${scheme} equivalent reduced-motion path`,
            MOTION_DURATION_NAMES.every((name) => snapshot.tokens.motion[name] === "0ms") && MOTION_EASING_NAMES.every((name) => snapshot.tokens.motion[name] === "linear"),
            "Compiled reduced durations remain zero and easings linear regardless of theme motion");
          add(`${prefix}:${scheme}:typography`, "rendering", `${prefix}: ${scheme} bounded readable typography`, Object.values(snapshot.tokens.type).every((value) => Number.parseFloat(value.size) >= 0.6875), "Host type scale and closed system font profiles; no arbitrary CSS or external font URL");
        }
      }
    }
    const permissions = pkg.manifest.permissions;
    const themeOnly = pkg.manifest.facets.every((facet) => facet.kind === "themes");
    add("theme-execution", "security", "Themes have no executable styling or remote resources", !themeOnly || (
      pkg.manifest.requestedCapabilities.length === 0 && permissions.networkOrigins.length === 0 &&
      permissions.filesystem.length === 0 && !permissions.microphone && !permissions.camera && permissions.lifecycleScripts.length === 0
    ), themeOnly ? "Data-only theme packages require no capabilities, network, filesystem, device or lifecycle-script permissions" : "Theme documents are data-only; other declared facets retain their own trust lanes");
    if (pkg.facets.length > 0) checks.push(...runConformance(root).checks);
  }
  try {
    const files = packageFiles(root);
    add("theme-assets", "security", "Package assets stay inside the package", true, `${String(files.length)} regular files read through the production containment boundary; ThemeDocument accepts no raw CSS, HTML, script or remote asset references`);
    if (pkg.problems.length === 0 && pkg.manifest.facets.every((facet) => facet.kind === "themes")) {
      const executable = files.filter((file) => /\.(?:[cm]?js|[cm]?tsx?|jsx|html?|css|wasm|exe|dll|sh|ps1|bat|cmd|py|rb)$/i.test(file.path));
      add("theme-asset-execution", "security", "Data-only theme artifacts contain no executable styling payload", executable.length === 0, executable.map((file) => file.path).join(", ") || "No script, raw stylesheet or executable asset");
    }
  } catch (error) {
    add("theme-assets", "security", "Package assets stay inside the package", false, error instanceof Error ? error.message : String(error));
  }
  checks.push({ id: "theme-browser", group: "interaction", name: "Production preview at narrow/normal/compact widths, keyboard and reduced motion", status: "requires-dev-host", detail: "Run clark theme dev; schema and token audits do not prove browser layout or keyboard behavior" });
  const summary = { pass: 0, fail: 0, "requires-dev-host": 0 };
  for (const check of checks) summary[check.status] += 1;
  return { root, checks, summary, ok: summary.fail === 0 };
}

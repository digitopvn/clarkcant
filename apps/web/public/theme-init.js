/*
 * Apply the stored theme before the first paint.
 *
 * This is a plain script in `public/` rather than an inline <script> because the page's CSP is
 * `script-src 'self'`, and an inline one would simply not run — the theme would then flash on
 * every load for anyone who chose light, which is exactly what this file exists to prevent. It
 * is deliberately not part of the bundle: a module runs after the document has already been
 * painted, which is too late to decide what colour to paint it.
 *
 * The logic is duplicated from `packages/conversation-client/src/theme.ts`, and that is a
 * deliberate trade. The alternative is inlining it and weakening the CSP, and a flash of the
 * wrong theme is a smaller problem than an inline script exception. A test compares this file
 * against the module so the two cannot drift apart silently.
 */
(function () {
  try {
    var choice = localStorage.getItem("cc.theme");
    var light =
      choice === "light" ||
      (choice !== "dark" && matchMedia("(prefers-color-scheme: light)").matches);
    document.documentElement.dataset.ccTheme = light ? "light" : "dark";
  } catch {
    // A preference that cannot be read is not a reason to render nothing.
    document.documentElement.dataset.ccTheme = "dark";
  }
})();

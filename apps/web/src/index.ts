/**
 * @clarkcant/app-web
 *
 * Browser client for the runtime gateway.
 *
 * @status-ref app.web.client
 *
 * This header used to say the opposite: "stub", with a `TODO(P1)` claiming there was no Vite entry
 * point, no gateway transport and no HTML shell. All three exist and are exercised by the browser
 * suite in `apps/web/e2e/`, and the claim was left standing while the app was built around it —
 * the same failure the renderer comments had, where a written guarantee outlives the code it
 * described. That is why this file no longer states a status of its own.
 *
 * What is here, and no more than has been checked:
 *
 *   - `index.html` loads `public/theme-init.js` and then `src/main.tsx`; `main.tsx` mounts `App.tsx`.
 *   - `theme-init.js` applies the stored theme before the first paint, because a module runs after
 *     the document has been painted and a light preference would otherwise flash dark.
 *   - HTTP commands and the voice socket both go through `GatewayClient` in
 *     `@clarkcant/conversation-client`, which is the only component holding the bearer token.
 *
 * Note the deployment requirement the blueprint is explicit about: browser features that need a
 * secure context require HTTPS, and loopback development is not the same configuration as a
 * deployment.
 */

/** Routes the client renders. One conversation; no session picker by design. */
export const ROUTES = ["/", "/conversation/:conversationId"] as const;

/**
 * Whether the browser client is built.
 *
 * **Unused.** Nothing in this repository reads it, and it was previously `"not-implemented"`, which
 * was false. It is kept only because it is a published export of this package and changing or
 * removing a published value is a version-visible change that deserves its own decision rather
 * than being done quietly inside an unrelated branch.
 */
export const WEB_CLIENT_STATUS = "implemented";

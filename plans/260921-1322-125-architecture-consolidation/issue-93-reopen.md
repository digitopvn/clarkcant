Reopening: this issue was set to COMPLETED by an automated keyword match inside a pull-request body belonging to the #125 architecture-consolidation program — not because its work was done. A post-program advisory review then reproduced a live defect in this issue's scope, and its remaining checklist items are still present in the tree. Nothing else tracks them.

## Reproduced now, on main (P0)

`packages/core/src/package-files.ts:71-80` checks containment with `resolve()` plus `startsWith`, then calls `statSync`/`readFileSync`. `resolve()` is lexical and `statSync` follows symlinks, so a link placed **inside** the package root that points outside it is read successfully. Executing the real module with an inside-package `leak.txt -> ../secret.txt` returned the outside bytes instead of a refusal. Both authenticated routes reach it: `apps/runtime/src/routes/packages.ts:232` and `apps/runtime/src/routes/widget-serving.ts:41`. `readPackageFile` has **no test file anywhere**, which is why this shipped.

The comment at `package-files.ts:76-78` contrasts `resolve()` with `normalize()` in a way that reads as symlink-safe. It is not. Phase 2 of #125 fixed exactly this class in `packages/pi-adapter/src/scoped-fs.ts` by canonicalising with `realpath` and refusing when the canonical path leaves the canonical root; the same treatment belongs here.

## Still open, unchanged since this issue was filed

1. **Client-declared grants are still accepted.** `apps/runtime/src/routes/packages.ts:169-171` reads `grantedCapabilities` from request JSON, and `packages/core/src/install-from-entry.ts:69` passes them into the plan unchanged. A client must not be able to declare its own grants.
2. **Requested-vs-granted is still violated verbatim.** `packages/conversation-client/src/DesktopSurfaces.tsx:511` passes `live.frame.requestedCapabilities` as `brokeredCapabilities` — unchanged since #86.
3. **Network origins are still not threaded.** `widgetDocumentPolicy` accepts `allowedOrigins`, but both call sites pass only `{appOrigin, nonce}` (`routes/packages.ts:263`, `routes/widget-serving.ts:59`), so CSP is always `connect-src 'none'`. Latent today because every pack declares `networkOrigins: []`; unimplemented regardless.

## Suggested order

The symlink escape first, with the regression test whose absence is why it shipped, and the misleading comment corrected in the same change. Then the two grant-authority items, then the network-origin threading.

Note on scope: the #125 program was told not to duplicate this issue, so nothing above was its responsibility — but the accidental closure hid real, unstarted work, and that is what this reopening restores.

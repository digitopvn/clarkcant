# Blog delivery evidence — 2026-10-04

Website: https://github.com/digitopvn/clarkcant-web/pull/89, source f7594c8.
Product public widget host: b7f9e364 before integrating current main.
Related work: website #88; marketplace installation is explicitly deferred.

## Implemented and checked

- One bilingual, versioned block document; immutable history, atomic publication,
  optimistic concurrency, retry receipts, restore and unpublish.
- Visual editor, nested layouts, text/heading/code, media/carousel/video/YouTube,
  sandbox, canonical widgets and persisted anonymous surveys.
- Shared typed service for MCP, REST and CLI. GitHub session auth, membership,
  write/publish scopes, PKCE/resource-bound OAuth, revocation and bounded public
  auth registration. No personal Clark runtime authority is exposed.
- SSR HTML, Markdown, canonical/hreflang, BlogPosting, RSS, sitemap and llms
  discovery. Drafts are absent from public outputs. Readable widget fallbacks
  survive JavaScript being disabled.
- Website typecheck, 20 SQL/auth/protocol tests and production build passed.
- Three browser journeys passed: visual EN/VI edit/save/publish/history restore;
  public widget/sandbox/survey/mobile/reduced-motion/no-JS; draft privacy, real
  local R2 upload visibility and scoped CLI access.
- Independent code review fixed ID/slug collision, malformed URLs, OAuth grant
  injection/revocation, publication race, anonymous admission, client lifecycle,
  media access, reserved routes and editor unsaved-state defects. Final review
  found no security/publication blockers. Subsequent minor 404 and pagination
  alternate concerns were also fixed.

## Deployment receipt

Worker `clarkcant-blog`, version `a3d5bda0-3b8f-4748-b725-5f7a071cdb55`.
Production D1/R2 are newly created; D1 exported before migrations 0001 and 0002.
Only scoped routes in `wrangler.production.jsonc` are installed; Pages retains
the root landing/docs. Root and existing docs return 200. Blog EN/VI, OpenAPI,
OAuth discovery, llms, robots and sitemaps return 200. MCP rejects anonymous
requests with 401. Both new documentation pages follow Cloudflare's extensionless
redirect and return 200. Production article count is zero; no test fixtures were
published. Login returns 503 until the OAuth App is configured.

## Visual review

`ak-frontend-design/scripts/render-check.mjs` ran against a local, explicitly
labeled test article at 375×812, 768×1024 and 1440×900: **0 errors, 0 warnings**.
Screenshots and raw reports remain local in website `test-results/` (ignored).
The first run found a missing local-only font and small touch targets; those were
fixed. Canonical diagram theme colors were corrected before the final captures.

| Criterion | Score / 2 | Visible evidence |
|---|---:|---|
| Brief fidelity | 2 | Editorial, tactile, exploratory: Orb mark, quiet palette, interactive reading blocks |
| Hierarchy | 2 | Large serif article title, narrow prose, full-width experiments |
| Spacing | 2 | Distinct hero, tool strip and reading sections; related controls grouped |
| Alignment | 2 | Text column aligned; diagram/experiment use the wider grid |
| Typography | 1 | Clear serif/sans hierarchy; platform fallback fonts vary |
| Color | 2 | Restrained accent; readable light theme and canonical widget palette |
| Depth/shape | 2 | Consistent subtle borders and bounded radii |
| States | 2 | Disabled submitted survey, unsaved error, history dialog and hover/focus styles |
| Responsive | 2 | No page overflow; 44px touch targets; contained diagram scrolling |
| Decoration | 2 | No invented metrics, badges or decorative card grids |
| Copy | 2 | Test content labeled; production empty state does not invent articles |
| Craft | 1 | Consistent shell and controls; bespoke article art depends on authored blocks |

Total 22/24. Weakest areas are platform font variation, authored art direction,
and motion richness; reading stays primary and reduced motion takes precedence.

## External acceptance still pending

The user confirmed that no dedicated GitHub OAuth App exists. The app needs
homepage `https://clarkcant.cc/blog/`, callback
`https://clarkcant.cc/auth/callback`, and Cloudflare secrets `GITHUB_CLIENT_ID`
and `GITHUB_CLIENT_SECRET`. The in-app browser is at GitHub's sign-in page.
No user password or app secret was requested in chat.

After configuration, exercise GitHub login/invitation and the actual ChatGPT and
Claude MCP authorization flows, create/read/edit/publish with separate scopes,
and revoke access. SDK integration tests do not stand in for these provider
checks. Issue #88 must remain open until those acceptance steps are evidenced.

# Delivery detail

Use the accepted conversation specification and issue #88. Website ownership: src/, migrations/, scripts/, test/, public generation and package/build configuration in clarkcant-blog. Product ownership: a public-widget adapter in conversation-client using the canonical catalog and production renderer.

Implement a versioned block document and bilingual article. Keep revisions immutable and publish pointers atomic. Validate on every adapter boundary. Database migrations are additive; backup any existing database before applying. Keep OAuth, membership, content authorization and storage separate. Tokens are hashed at rest; executable blocks have opaque origins and no host credentials.

Render public semantic HTML and Markdown from the same document. Hydrate interactive blocks only. Editor shares preview output and offers bounded layout controls and keyboard ordering. Cloudflare Worker/D1/R2 are deployment adapters; local SQL tests use isolated temporary databases.

Validate contracts, conflict/retry behavior, scope enforcement, publication, draft privacy, sandbox boundaries, OAuth replay/PKCE and survey persistence first. Then type/build and browser journeys at mobile/desktop widths, reduced motion and no JavaScript. Review security/public interfaces independently. Preserve exact verification receipts.

Rollback: deploy prior code; restore prior published revision pointers through the application. Do not edit applied migrations. Do not rewrite existing site content or overwrite other worktrees.

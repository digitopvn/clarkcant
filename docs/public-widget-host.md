# Public document widget host

English · [Tiếng Việt](public-widget-host.vi.md)

The `@clarkcant/conversation-client/public-widget` source export lets a public
document render the canonical built-in widget catalog without a Clark runtime.
The website consumes this entry at a pinned product commit; it does not copy
widget renderers. See [website publishing](https://clarkcant.cc/docs/blog.html)
and [website issue #88](https://github.com/digitopvn/clarkcant-web/issues/88).

`mountPublicWidget(element, input)` mounts into a shadow root and returns a
cleanup function. Input contains `definitionId`, exact `version`, `props`,
`semantic`, optional `state`, optional static `rows`, and `locale` (`en` or `vi`).
The host validates catalog membership and props before rendering. It follows
the page's `data-theme`, system color scheme and reduced-motion preference.
Mount once per element; call cleanup before removing it.

This is the trusted built-in lane. It lends local view state and cached data,
with no `onAction`, runtime connection, tool dispatch, approval or credentials.
Controls needing runtime authority remain unavailable. A failed renderer shows
its semantic explanation. The surrounding document must also render that
explanation and data outside JavaScript for accessibility and crawlers.

Images accept HTTPS URLs without embedded credentials, or the website's
`/media/<uuid>` route. An embedding host is responsible for its media endpoint's
authorization and content policy. Shadow DOM isolates styles, not executable
third-party code. Marketplace installation is not enabled by this entry;
untrusted executable widgets still require the isolated extension lane.

The public catalog and validator are `publicWidgetCatalog()` and
`validatePublicWidget()`. Version migration remains the document owner's
responsibility; unknown versions degrade to text instead of guessing.

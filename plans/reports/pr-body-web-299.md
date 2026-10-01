Widget authors need the resolved host appearance in their existing frame, including live changes and reduced motion. The paired English/Vietnamese API guides document the read-only SDK snapshot and optional DOM adapter, bridge v2 compatibility, detached relay, adaptive/fixed disclosure and preservation of historical content.

Implementation landed in https://github.com/digitopvn/clarkcant/pull/367 (b589e906), addressing https://github.com/digitopvn/clarkcant/issues/299. Core CI passed on Windows, macOS, Ubuntu Node 22/24, both browser suites, service container and actual desktop smoke before merge.

Validation: eight documentation pages and 164 local links/anchors checked, matching EN/VI code sample, no duplicate IDs. Browser inspection at English 1280 and Vietnamese 390 in light/dark found zero horizontal page overflow after using the site's existing copy/scroll code component.

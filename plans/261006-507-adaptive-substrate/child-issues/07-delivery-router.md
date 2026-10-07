# feat(runtime): delivery router for canonical notices and results

Labels: `enhancement` · Parent: #507 (Phase 7)

## Summary

Route one canonical Notice / RunResult to the originating conversation, Inbox, OS notification, web push and
authorized external channels according to the standing intent's `deliveryTargets`, with external sends governed as
`communication` effects.

## Dependencies

- **#199** owns external messaging channels and providers; this issue consumes them as delivery targets.
- Phase 5 (envelope with delivery targets).
- Existing Inbox / actionable notifications (#196) and notices.

## Scope

- Per-intent delivery policy by outcome (`succeeded`, `failed`, `needs-input`, `report`).
- External sends as `communication` effects with evidence, idempotency and reconciliation.
- A connected channel is usable only where an envelope names it.

## Acceptance criteria

- [ ] One result routes to several targets without duplicating the underlying notice.
- [ ] Connecting a channel never lets every routine send there.
- [ ] External delivery failure is reported truthfully and does not silently retry an unknown effect.
- [ ] One Clark identity across channels; no per-channel Clark.
- [ ] Tests, `pnpm verify`, docs EN/VI.

## Non-goals

- TelegramClark / DiscordClark / WhatsAppClark.
- A second delivery/dedupe engine beside #197/#199.

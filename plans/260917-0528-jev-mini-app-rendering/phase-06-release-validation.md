---
title: "Phase 6: Release validation và evidence"
status: todo
---

# Phase 6: Release validation và evidence

## Overview
- P1; effort ~4 agent-hours + thời gian chờ user import dataset/ảnh; serial cuối (S1). Depends on Phase 5; gộp evidence Phase 9 nếu đã xong.
- Context: [report](../reports/analysis-260917-1211-jev-mini-app-rendering.md), [surface sketch](../../docs/mini-app/mini-app-surface.jpeg), [conversation sketch](../../docs/mini-app/mini-app-in-conversation.jpeg).
- Mục tiêu: chứng minh interactive mini-app trong conversation và expanded/pinned, không chỉ HTTP 200 hoặc snapshot đẹp.

## Related files
Root: `/Volumes/GOON/www/digitop/clarkcant/`.
- Create `apps/web/e2e/mini-app.spec.ts` (path xác nhận tồn tại): local-store interaction journeys.
- Modify `apps/web/e2e/widget.spec.ts`: non-vacuous missing-renderer fallback test.
- Modify `playwright.config.ts` khi cần isolate data/ports và opt-in live suite; không chạy paid provider theo mặc định CI.
- Modify `docs/conformance-traceability.md`: evidence-backed status, không blanket promote stub modules.
- Modify `docs/widgets-and-extensions.md`: current implemented behavior vs future isolated/mcp app scope.
- Modify `docs/mini-app/jev-configuration.md`: privacy/model/fallback/operator runbook.
- Create report dưới `plans/reports/` và PNG dưới `plans/reports/evidence/` theo timestamp implementation thực tế. PNG giữ local, không commit regenerated evidence.

## Validation design

CI tạo local records/files trong isolated DB bằng production API và assert production renderer/actions. Provider response parser/fault harness tests là riêng, không tính là model live evidence. Live release gate dùng key qua secret injection, endpoint thật, approved non-sensitive local dataset; thiếu key/model/data → blocked live evidence, không báo pass giả.

| Journey / failure | Assertions bắt buộc |
|---|---|
| Ask overview | Đủ metrics, dropdown, chart, calendar, image, CTA; values khớp local source |
| Week/month và calendar | Range/data đổi thật, event details đúng; không provider call mới |
| Save/open/expand/pin/unpin | Same instance, state durable, một owner; double click không duplicate |
| Snapshot vs live | Old screenshot/value giữ N sau live N+1 và restart |
| Unknown renderer | Inject legitimate unsupported definition vào test store; visible text fallback và không blank; không chỉ assert conversation rỗng |
| Provider timeout/disabled | New request fallback có lý do; stored view vẫn dùng được |
| Missing/deleted source | Empty/tombstone/error có provenance, không stale value giả fresh |
| Concurrent tabs | Conflict/recovery UX, không hai writer |
| Security | Wrong principal/refs/revision/digest từ chối; không secret trong browser/log/report |
| Accessibility | Keyboard dropdown/calendar/CTA, focus restore khi đóng expanded, labels, contrast, reduced motion |

## Implementation steps
1. Run narrow phase tests, `pnpm verify`, `pnpm build`, rồi `pnpm test:e2e` (Playwright dùng `.data/e2e`, ports 8876/4273 riêng theo `playwright.config.ts`; không reuse dev server/data).
2. Browser captures desktop 1440×900, mobile 390×844 và narrow conversation panel; light/dark theo app hiện có. So sánh semantic/layout/interaction với cả hai sketches; không pixel-perfect score khi fonts/content khác mà không nêu lý do.
3. Record source provenance, route, view mode, revision, viewport và assertions bên cạnh mỗi PNG. Không capture browser query token, keys, user private rows hoặc full diagnostic payload.
4. Run real Jev integration từ turn đến UI. Ghi model actual id, duration/tokens/fallback count và user-visible result; không đòi exact confidence equality giữa runs.
5. Calibration corpus ít nhất 30 intent Việt/Anh gồm ambiguity, missing data, explicit template và misleading requests. Human-label acceptable template sets; mục tiêu khởi đầu ≥90% acceptable-or-correctly-abstained, zero unauthorized refs/effects. Đo false confident selection riêng; không đạt → chỉnh policy và rerun, không đổi test labels để hợp output.
6. Báo latency distribution/provider failure rate trên sample size thực; đề xuất budget 4 giây phải enforce, chưa claim p95 SLA nếu chưa đủ mẫu. Freeze model/catalog/policy versions trong report.
7. Update traceability: T43/T44/T47/T49/T50 giữ PASS với evidence mới; không thêm ID mới ngoài blueprint. Run `pnpm invariants` sau docs changes. Independent review khi được user yêu cầu; không tự spawn agent. Không commit/push mặc định; nếu ship được yêu cầu, dùng feature branch/PR, không main.

## Todo
- [ ] Pass full deterministic tests/build/e2e trên isolated runtime.
- [ ] Capture đủ hai display modes và responsive/accessibility evidence.
- [ ] Pass opt-in live integration và calibration với model version xác định.
- [ ] Update docs/traceability, ghi residual risks và handoff.

## Success / release gate

M1 chỉ complete khi đủ UI **và** actions, snapshot correctness, ownership, restart, privacy/security và live provider integration evidence. CI-only/provider-only/visual-only pass không đủ. Local calendar chưa phải Google Calendar; catalog composition chưa phải custom iframe/MCP app runtime. Hai hạng mục sau được ghi rõ deferred theo lựa chọn user, không claim đã hoàn thành.

## Risks / unresolved
Exact model support, approved acceptance dataset/image và confidence calibration là gate còn phải giải quyết khi implement. Không cần thay toàn bộ task/session/multi-node architecture để release local save-view milestone; generic agent-action CTA cần separate task execution gate.

---
title: "Phase 6: Release validation và evidence"
status: blocked
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
- [x] Pass full deterministic tests/build/e2e trên isolated runtime. (`pnpm verify` 766 passed/5 skipped; `pnpm build` pass; `pnpm test:e2e` 20 passed, trong đó 3 journey mới của `apps/web/e2e/mini-app.spec.ts`)
- [x] Capture đủ hai display modes và responsive/accessibility evidence. (6 PNG mini-app: desktop 1440×900 light/dark, mobile 390×844 light/dark, live-vs-snapshot, ownership refused; xem bảng trong report)
- [ ] Pass opt-in live integration và calibration với model version xác định. — **BLOCKED**: thiếu `TYPESAFE_API_KEY` trong `.env` repo này; `jev-live.spec.ts` và `jev-calibration-live.spec.ts` in BLOCKED nêu tên biến. Default `search.decider="rank"` chốt bằng số đo lexical thay vì calibration chưa chạy.
- [x] Update docs/traceability, ghi residual risks và handoff. (`docs/conformance-traceability.md` T43/T44/T47/T49/T50, `docs/widgets-and-extensions.md` §4.1, `docs/mini-app/jev-configuration.md` runbook, `docs/manifest.json` re-hash)

## Trạng thái

**Blocked, không phải done.** Success gate của chính phase này ("M1 chỉ complete khi đủ UI **và** actions, snapshot correctness, ownership, restart, privacy/security **và live provider integration evidence**") chưa đạt: phần live provider không chạy được vì thiếu `TYPESAFE_API_KEY`. Toàn bộ phần xác minh tất định đã đạt và có evidence; hạng mục live được ghi BLOCKED kèm điều kiện còn thiếu, không được đọc thành pass.

## Kết quả

Report: [`plans/reports/verification-260917-1732-release-validation-mini-app.md`](../reports/verification-260917-1732-release-validation-mini-app.md).

Rework sau audit (2026-09-17, cùng ngày) đóng ba khoảng trống mà audit chỉ ra:

1. **Vùng ảnh (picture) chưa từng tới được người dùng.** Không template nào có slot `image`, `CompileInput.imageRef` không có caller, và `publishMiniAppData` trả `imageRefs: []`. Đã nối end to end: lấy ảnh mới nhất đã nhập → slot `image` (fixed, optional theo dữ liệu) → `compileTemplate` → renderer; text alternative của vùng nay mang **alt text của người dùng** thay vì câu chung của definition; có test đơn vị (có ảnh/không ảnh) và test browser (ảnh load thật, assert `naturalWidth`).
2. **CSP chặn đường ảnh có xác thực.** `img-src 'self' data:` không có `blob:`, nên mọi ảnh đã nhập render thành "Chưa tải được hình ảnh" dù node trả bytes đúng (kiểm chứng: vòng upload→download giống nhau từng byte, sha khớp, `content-type: image/png`). Đã thêm `blob:` vào `img-src` kèm giải thích; không nới `connect-src`, vì client không cần fetch blob URL. Đây là lỗi thật đầu tiên khiến vùng ảnh **không thể** hiển thị trong browser, và nó chỉ lộ ra khi có một vùng ảnh thật để render.
3. **Accessibility của expanded view chưa có contract.** `PinnedLiveSurface` nay nhận focus khi mở, là `role="region"` có `aria-label`, đóng bằng Escape hoặc nút hiển thị, và host trả focus về đúng control đã mở nó (fallback về transcript). Có journey bàn phím trong `mini-app.spec.ts` đi hết: mở bằng Enter → đổi kỳ bằng select → Enter vào một ngày lịch → Escape → focus về trigger.

Ngoài ra, việc quản lý object URL cho ảnh được gom vào một chỗ (`use-image-urls.ts`): trước đó transcript và pinned view mỗi bên tự fetch và tự revoke, nên một bên có thể thu hồi URL bên kia đang hiển thị — đúng triệu chứng `fetch(blob:)` thất bại trong lúc `<img>` vẫn trỏ vào URL đó.

Browser test tìm ra bảy lỗi thật mà unit test không thấy (dependency `datasets` bị thiếu trong `renderSurface`, container bị kiểm tra sau leaf renderer lookup, template `overview` không chọn renderer cho vùng `calendar`, `messageId` bị cấp hai lần trong nhánh composer khiến snapshot mồ côi, vùng không cần dữ liệu bị đánh "missing", read-only chặn sai phạm vi, client đọc `stale` từ document bất biến). Tất cả đã sửa kèm lý do trong code.

Restart thật (không phải reload browser) xác nhận snapshot giữ nguyên `capturedAt`/`bundleRef` sau khi live lên revision 2 và sau khi tiến trình node khởi động lại, còn live state `{"period":"month"}` sống qua restart.

## Success / release gate

M1 chỉ complete khi đủ UI **và** actions, snapshot correctness, ownership, restart, privacy/security và live provider integration evidence. CI-only/provider-only/visual-only pass không đủ. Local calendar chưa phải Google Calendar; catalog composition chưa phải custom iframe/MCP app runtime. Hai hạng mục sau được ghi rõ deferred theo lựa chọn user, không claim đã hoàn thành.

## Risks / unresolved
Exact model support, approved acceptance dataset/image và confidence calibration là gate còn phải giải quyết khi implement. Không cần thay toàn bộ task/session/multi-node architecture để release local save-view milestone; generic agent-action CTA cần separate task execution gate.

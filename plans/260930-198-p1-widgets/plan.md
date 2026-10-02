---
title: "#198 P1 widget: status, artifact, chart area/scatter, calendar week/agenda"
status: completed
created: 2026-09-30
issues: [198, 280, 281, 282, 283]
related: [200, 195, 226]
---

# #198 P1 widget

Nguồn: issue [#198](https://github.com/digitopvn/clarkcant/issues/198), mục "Suggested priority → P1", phase 10 phần 1
của [lộ trình](../260929-0002-open-issues-roadmap/phase-10-widget-platform-expansion.md). P0 đã xong
(sub-issue #220–#226).

## Kết quả cần đạt

Model đặt được thêm các primitive khai báo phổ biến mà không cần UI tuỳ biến: thẻ trạng thái, tiến độ và chi tiết;
trình xem artifact, file, code và diff; chart area và scatter; lịch dạng tuần và agenda. Mỗi primitive đi đủ đường
ống sẵn có: định nghĩa và schema, renderer production, fixture trong Widget Library, semantic state có giới hạn, text
fallback, a11y, theme sáng và tối, unit test, E2E và docs EN/VI.

## Không làm

- Timeline, Kanban, tree và semantic state media (P1 còn lại của #198) nằm ngoài sub-plan này.
- Không thêm executor hay broker mới; (I) chỉ trình bày dữ liệu inline hoặc ref do host sở hữu (#200 M1).
- Không đụng inbox, peers, orb, automation.

## Phase

Mỗi phase là một sub-issue của #198 và một PR riêng.

| Phase | Trạng thái | Phụ thuộc | Chi tiết |
| --- | --- | --- | --- |
| 01 (H) #280 Status, progress, details | done (PR #286) | — | [phase-01-status-progress-details.md](phase-01-status-progress-details.md) |
| 02 (I) #281 Artifact, file, code, diff | done (PR #288) | — (ref artifact thật chờ #200 M1) | [phase-02-artifact-file-code-diff.md](phase-02-artifact-file-code-diff.md) |
| 03 (J) #282 Chart area và scatter | done (PR #331) | — | [phase-03-area-scatter-charts.md](phase-03-area-scatter-charts.md) |
| 04 (K) #283 Calendar tuần và agenda | done (PR #339) | — | [phase-04-calendar-week-agenda.md](phase-04-calendar-week-agenda.md) |

Thứ tự an toàn: H trước (nhỏ nhất, dựng khuôn cho widget chỉ-hiển-thị có semantic theo props), rồi I, J, K. J và K
sửa widget sẵn có nên đi sau để không xung đột với H/I trong `renderers.tsx`.

## Tiêu chí chung

- Props có schema chặt (`additionalProperties: false`) và kiểm tra nghĩa trong `primitivePropsProblems`.
- Dữ liệu trong props là lời của model: không hiển thị như trạng thái live của host, không badge "live".
- Không có tiến độ giả: không có trạng thái indeterminate lấy từ props.
- Semantic document dựng từ props bằng một hàm dùng chung cho runtime và test, qua `normalizeSemanticDoc`.
- Widget Library preview qua renderer production; E2E gallery và E2E hội thoại.
- `pnpm verify`, `pnpm invariants`, E2E liên quan xanh; ảnh 1280 tối, 1280 sáng, 390.

## Rủi ro và rollback

Mỗi phase là một PR độc lập, revert được riêng. Không có migration.

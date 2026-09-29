---
phase: 5
title: "#195 semantic state của widget"
status: done
issues: [195]
---

# Phase 05 — #195 semantic state của widget

## Yêu cầu (theo issue)

- Hợp đồng `WidgetSemanticState` có giới hạn kích thước.
- Bảng `widget_semantic_state` (migration mới).
- Adapter semantic cho built-in widget và `semantic.publish` đã chuẩn hoá.
- Composition tree (dùng graph của phase 04).
- Cursor theo session với suffix-only injection để không phá prompt cache.
- Coalescing.
- Tool `inspect_ui`.
- Voice đọc cùng một nguồn sự thật.

## Các bước

Tạo plan con `plans/{date}-195-widget-semantic-state/`, rồi làm theo vòng lặp chuẩn. Có thể tách thành PR:
hợp đồng + storage → adapter → injection + cursor → `inspect_ui` và voice.

## Kiểm chứng

- Test chứng minh prefix prompt không đổi giữa các turn khi chỉ semantic state thay đổi (suffix-only).
- Test giới hạn kích thước và coalescing.
- E2E: tương tác với widget → agent thấy state trong turn tiếp theo.
- `pnpm verify:full`. Nếu có provider thật, đo token budget là tuỳ chọn; không có provider thì không tuyên bố số liệu.

## Rủi ro và rollback

Rò dữ liệu nhạy cảm từ widget vào prompt: redact theo hợp đồng và chỉ publish field được khai báo. Rollback: revert.

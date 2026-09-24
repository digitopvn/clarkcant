# Phase 1 — Lỗi có từ trước

## #174 — "mở hộp …" bị intent chọn tệp nuốt

Đã sửa và vào PR #175: `COMMAND_OPENERS` lấy `opener` riêng cho cụm "mở hộp thoại chọn tệp" thay vì hai từ đầu.

## #173 — từ chối chỉ để lại một câu chữ

- `apps/runtime/src/routes/conversations.ts`: nhánh từ chối ghi `tool-activity` `decide_approval` với
  `args: { approvalId, decision: "denied" }`.
- `packages/conversation-client/src/use-block-actions.ts`, `blocks.tsx`: thẻ đọc `deniedApprovals`, hiện
  "đã từ chối" và không còn nút.
- Test: `apps/runtime/test/api.spec.ts` ("records a refusal, and nothing runs"),
  `apps/web/e2e/approval.spec.ts` ("refusing runs nothing and says so").

Rủi ro: thẻ cũ (từ chối trước bản sửa) vẫn chỉ có câu chữ; chúng vẫn hết hạn theo TTL.

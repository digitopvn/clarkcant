---
phase: F
title: "Primitive input, choice, search, form và list"
status: done
issues: [198, 225]
---

# Phase F — primitive input, choice, search, form và list

## Bối cảnh

- Catalog chỉ có widget để đọc (biểu đồ, bảng, số liệu, lịch, media) và một nút hành động (`canvas.action@1`, phase D).
  Người dùng chưa có cách nào đưa thông tin cho Clark qua widget.
- Cây bố cục (phase E) chưa có lá search, nên "Card(Search, Table)" tạm dùng `canvas.filter@1`.
- Đường hành động (`POST …/widgets/{instanceId}/actions`) đã kiểm revision, digest và invocation id, nhưng chưa kiểm
  input theo widget.

## Thiết kế

Một mô hình trường duy nhất trong `packages/contracts/src/form-fields.ts`, dùng chung cho trang và node:

- 12 kiểu trường: choice (`chips`, `select`, `multiselect`, `radio`, `checkbox`, `toggle`) và input (`text`, `number`,
  `date`, `date-range`, `time`, `slider`).
- `checkField` từ chối trường hỏi bí mật (mật khẩu, token, khoá, PIN…) theo tên và nhãn, EN và VI.
- `checkFieldValue` / `checkFormValues` kiểm giá trị; `formInputSchema` dựng JSON Schema cho binding.
- Danh sách: tối đa 200 mục có id ổn định, trang 5–50 mục.

Năm định nghĩa trong `packs/data-canvas`:

- `canvas.form@1` và `canvas.list@1` được model đặt bằng `show_view`, kèm `props.action` (`agent` hoặc `invoke`). Host
  biên dịch action cùng đặc tả input (tên trường, hoặc id các mục) và bỏ nó khỏi props.
- `canvas.search@1` chỉ làm lá bố cục; nó lọc mọi bảng trong cùng bề mặt ngay trên trang, không gửi gì.
- `canvas.choice@1` và `canvas.input@1` không bao giờ đứng một mình (giá trị chẳng đi đâu); chúng là trường của form và
  có trong thư viện widget.

Node:

- `actionInputProblem` kiểm lại mỗi lần gửi theo binding; sai thì `400 INVALID_INPUT`, không có gì chạy.
- Biểu mẫu `agent` mở lượt với tin nhắn là nhãn nút gửi rồi từng `nhãn: giá trị`; `invoke` truyền mỗi trường làm tham số
  cùng tên.
- Lá list trong bố cục không được có nút cho từng mục (lá không gắn hành động).

Client:

- `FieldControl` vẽ mọi kiểu trường với nhãn thật, `aria-describedby`, `aria-invalid`; lỗi hiện khi rời trường hoặc khi
  thử gửi; gửi còn lỗi thì chuyển focus tới ô đầu tiên.
- Bản nháp, lựa chọn, trang và câu tìm là view state; lần gửi bị từ chối giữ bản nháp.
- Nút của từng mục chỉ bấm được khi host báo binding chạy được (`itemActionReady`).
- Ô tìm chốt sau 250 ms, Enter chốt ngay, Escape/nút xoá làm trống.

## File

- `packages/contracts/src/form-fields.ts` (mới), `index.ts`, `surface-composition.ts`, `period.ts`.
- `packs/data-canvas/src/index.ts`.
- `apps/runtime/src/application/action-bindings.ts`, `widget-actions.ts`, `view-catalog.ts`, `compose-layout.ts`,
  `services.ts`, `test-support/fixture-model.ts`.
- `packages/core/src/conductor.ts`: câu trả lời fixture chỉ có chữ không bị in hai lần.
- `packages/conversation-client/src/renderers.tsx`, `use-surface-renderer.tsx`, `mini-app-surface.tsx`, `api.ts`,
  `i18n/messages-timeline.ts`, `styles/cards.ts`, `styles/voice.ts` (nút 44 px trên màn hình cảm ứng).
- `packages/widget-catalog/src/registry.ts`, `fixtures.ts`.
- Docs `docs/widget-development*.md` §8.2, `docs/widgets-and-extensions*.md`, conformance ledger (V11).

## Kiểm chứng

- `packages/contracts/test/form-fields.spec.ts`, `apps/runtime/test/input-primitives.spec.ts`,
  `packages/conversation-client/test/input-primitives.spec.ts`.
- E2E `apps/web/e2e/input-primitives.spec.ts`: form bằng bàn phím, lỗi và focus, gửi qua binding agent, node từ chối
  input sai với `INVALID_INPUT`, form hỏi bí mật bị từ chối, list chia trang/chọn/nút mục, list trống, search lọc bảng
  trong cây "Grid(Metrics, Metrics, Card(Search, Table))", 375 px với cảm ứng và mục tiêu chạm ≥ 44 px.
- E2E `apps/web/e2e/layout-tree.spec.ts` kiểm card chứa slot `search` rồi `table`.
- `pnpm verify` và full E2E.

## Còn lại

- Trạng thái view (bản nháp, lựa chọn, câu tìm) do client giữ, chưa lưu trên node; thuộc graph state của phase G.

---
phase: D
title: "Action tổng quát canvas.action@1"
status: done
issues: [198, 223]
---

# Phase D — action tổng quát `canvas.action@1`

## Bối cảnh

- `canvas.cta@1` (`packs/data-canvas/src/index.ts`) gắn cứng với `view.save`: renderer
  (`packages/conversation-client/src/renderers.tsx` `CallToAction`) luôn phát `onAction("view.save", …)`.
- Khi model gọi `show_view` với `canvas.cta@1`, instance không có binding nào, nhưng `use-surface-renderer.tsx` vẫn
  truyền `onAction` (không làm gì), nên nút trông như bấm được. Đây là control giả.
- Binding chỉ được tạo trong sản phẩm ở `compose-mini-app.ts` (binding `view`) và trong fixture của #221 (binding
  `invoke`). Chưa có đường sản phẩm nào để model đặt một nút gắn với `invoke` hay `agent`.
- `invokeWidgetAction` (`apps/runtime/src/application/widget-actions.ts`) chuyển `invoke` sang `invokeCapability`, mọi
  loại khác sang `invokeMiniAppAction`; loại khác `view` bị từ chối là "không có executor".

## Thiết kế

Model đặt nút bằng `show_view` với `canvas.action@1`:

- `props` hiển thị: `label` (bắt buộc), `description`, `emphasis` (`primary|secondary`), `icon` (tập đóng).
- `props.action` là một `ActionProposal`. Host tách nó ra khỏi props trước khi tạo instance, nên renderer và timeline
  không bao giờ thấy proposal.

Host biên dịch proposal thành binding (một binding cho mỗi instance), theo loại:

- `view`: chỉ `view.save` (một nút không mang input). Thao tác khác bị từ chối kèm lý do.
- `invoke`: `capabilityRef` phải là capability do service của một package đang active phục vụ (`serviceHost.serves`).
  - `effectCategory` lấy từ registry, không lấy từ model.
  - `packageGeneration` là generation đang được phục vụ, nên bản cập nhật package làm binding stale.
  - Chỉ nhận binding field `literal`, vì nút không mang input.
- `agent`: `intent` tối đa 2.000 ký tự. `contextRefs` phải rỗng, vì host chưa resolve được context ref.
- `workflow`: kiểm tra cấu trúc như `compileActionBinding`. Binding được lưu nhưng hiển thị disabled với lý do thật:
  node chưa chạy được workflow.
- Model nhận lời từ chối ngay trong lượt nếu proposal không hợp lệ.

Tính sẵn sàng (availability) của binding:

- Host tính trong một hàm dùng chung, dùng cho cả timeline lẫn route frame (thay khối đang nằm trong `conversations.ts`).
- Timeline mang `actions: [{ actionBindingId, label, effectCategory, bindingDigest, available, unavailableReason? }]`
  cho instance có binding.

Thực thi, qua `invokeWidgetAction` (click và voice dùng chung):

- `view` → `invokeMiniAppAction`.
- `invoke` → `invokeCapabilityAction` (đường của B).
- `agent`: qua cổng chung (owner, binding, revision, digest, idempotency), rồi bắt đầu một lượt trong cùng cuộc trò
  chuyện:
  - text đúng bằng label của nút;
  - `note` nói với model rằng người dùng đã bấm nút mà nó đưa ra, kèm intent;
  - kết quả được ghi lại theo `invocationId`;
  - nếu đang có lượt chạy thì từ chối kèm lý do.
- `workflow` → từ chối với lý do thật (không có executor).

Renderer `ActionButton`:

- Chỉ biết label, description, emphasis, icon, và `state` (`pending`, `unavailableReason`, `message`, `tone`).
- Phát `onAction("activate", {})`.
- Không có nhánh nào theo loại binding.
- Hook `use-surface-renderer` ánh xạ `activate` thành lời gọi route action với revision và digest của binding, rồi đưa
  kết quả hoặc lời từ chối vào `state`.

`canvas.cta@1`:

- Bị bỏ khỏi từ vựng `show_view`. Vẫn nằm trong registry cho composition và cho lịch sử.
- Instance đứng riêng không có binding thì không nhận `onAction`, nên hiện đúng thông báo "chỉ xem".

## File

- `packs/data-canvas/src/index.ts`: `ACTION`, family.
- `packages/widget-catalog/src/registry.ts`, `fixtures.ts`.
- `apps/runtime/src/view-catalog.ts`: descriptor riêng cho `canvas.action@1` và biên dịch binding.
- `apps/runtime/src/bootstrap/runtime-bootstrap.ts`: truyền service host và registry.
- `apps/runtime/src/application/widget-actions.ts`: nhánh `agent`, hàm availability dùng chung.
- `packages/core/src/widget-service.ts`: cổng chung `checkBoundAction`; `checkInvokeAction` dùng lại cổng này.
- `apps/runtime/src/services.ts`: `actions` trong timeline.
- `apps/runtime/src/routes/conversations.ts`: dùng hàm availability dùng chung.
- `packages/conversation-client/src/renderers.tsx`, `use-surface-renderer.tsx`, `api.ts`, i18n EN/VI.
- Fixture model: câu lệnh đặt nút `view`, `agent`, `invoke`, `workflow`.
- Docs `docs/widgets-and-extensions*.md`, `docs/widget-development*.md`, conformance ledger.

## Kiểm chứng

- Unit test:
  - biên dịch theo từng loại, gồm các trường hợp bị từ chối;
  - availability;
  - `agent` bắt đầu một lượt với đúng label, và trả lại kết quả cũ khi cùng `invocationId`;
  - `workflow` bị từ chối kèm lý do;
  - renderer không có nhánh theo loại (cùng props và state cho ra cùng markup, dù binding thuộc loại nào).
- E2E:
  - `view` ghim widget;
  - `agent` tạo lượt có tin nhắn bằng đúng label;
  - `invoke` gọi service của package fixture;
  - binding stale hoặc không tồn tại bị từ chối và lý do hiện trong widget;
  - `workflow` hiện disabled kèm lý do.
- `pnpm verify` và `pnpm verify:full`.
- Ảnh chụp bằng chứng ở desktop và mobile.

# Phase 01 — Chiều sâu giao diện (#298)

Trạng thái: chờ review. Plan: [plan.md](plan.md).

## Phạm vi và file

1. Contract `packages/contracts/src/themes.ts`: `APPEARANCE_API_VERSION` 2, dải hỗ trợ 1–2; trường mới
   `typography`, `border`, `shadow`, `motion`, `recipes`, `effects`, `orb`, `radius.field` (chỉ khi
   `appearanceApi.min >= 2`); snapshot thêm nhóm `identity` (token contract 2); easing `steps(n)`; mã fallback
   `THEME_PROTECTED`.
2. `packages/design-tokens`: `identity.ts` (identity Clark, khai báo CSS từ recipe/hiệu ứng, diff so với Clark),
   `protected.ts` (audit ngữ nghĩa bảo vệ, OKLab), `compileAppearance` áp motion/identity, `themeStylesheet()` giữ
   nguyên cho Clark.
3. `packages/conversation-client/src/styles/*`: biến identity có fallback Clark; recipe và hiệu ứng; quy tắc bảo vệ.
   `appearance.ts` thêm khối identity và audit bảo vệ; Orb theo độ ưu tiên; `terminal-card.tsx` đổi theo theme.
4. Intent: `packages/contracts/src/app-intents.ts`, `packages/core/src/app-intents.ts`, runtime (`app-intents.ts`,
   `node-tools.ts`, fixture model), trang (`app-intents.ts`, `Conversation.tsx`, Settings), i18n VI/EN.
5. Runtime: audit bảo vệ khi liệt kê theme và khi PUT `experience.themeRef`.
6. Desktop: `apps/desktop/src/appearance-tokens.css` (sinh ra, có test), `shell.html`, `shell.css`.
7. Docs EN/VI: `docs/widgets-and-extensions*.md`, `DESIGN*.md`, `docs/open-interfaces*.md` nếu cần,
   `docs/conformance-traceability.md`.
8. E2E: fixture package theme mới trong `apps/web/e2e/fixtures`, digest trong `directory.json`, spec mới.

## Kiểm chứng

- Unit: contract từ chối selector/CSS/recipe lạ/tham số ngoài biên; audit bảo vệ từ chối theme che duyệt, Stop,
  focus hoặc chỉ dựa vào màu; Orb ưu tiên; reduced motion; intent chữ/giọng/click cùng một code.
- Mutation check các guard chính.
- Golden Clark giữ nguyên; CSS sau khi thay biến bằng fallback khớp CSS trước; ảnh Clark trước/sau khớp pixel.
- E2E, ảnh, log tràn ngang; `pnpm verify`, `pnpm invariants`, `pnpm verify:full`.

## Tiến độ

- [x] Contract v2, compiler identity, audit bảo vệ, CSS identity có fallback Clark, terminal.
- [x] Orb mặc định của theme (lựa chọn tường minh thắng, reduced motion thắng).
- [x] Intent appearance: chữ, giọng nói, click, `control_app` cùng một đường; i18n VI/EN.
- [x] Desktop: `appearance-tokens.css` sinh từ design-tokens, `shell.css` đọc cùng token, test đồng bộ.
- [x] Docs EN/VI (DESIGN, open-interfaces, widget-development), conformance T73, manifest.
- [x] Unit test và mutation check (11/11 bị bắt).
- [x] E2E (`appearance-depth.spec.ts`, `themes.spec.ts`), ảnh 1280/390 sáng/tối, không tràn ngang; so pixel Clark
  trước/sau: màn hội thoại trùng từng byte, Cài đặt chỉ khác ở lớp sáng theo con trỏ bị tắt khi giảm chuyển động.
- [x] `pnpm verify` (4379 test qua), toàn bộ E2E (271 qua, 3 bỏ qua), desktop smoke (22/22) sau khi rebase lên #344.
- [ ] PR, CI xanh (kể cả Windows), bình luận #298.

## Rủi ro

- CSS lớn (~2700 dòng): thay thế máy móc có thể đổi Clark. Giảm rủi ro bằng so sánh CSS đã thay fallback và so pixel.
- Tăng phiên bản appearance API làm vỡ theme v1: dùng dải hỗ trợ 1–2 thay vì một số.
- Intent chữ bắt nhầm câu hội thoại: cụm từ neo vào đầu câu, danh sách theme do node tiêm vào như widget target.

## Rollback

Revert PR; không có migration, preference cũ vẫn hợp lệ.

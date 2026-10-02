# Phase 02 — Widget còn lại của #198: P1 timeline, tree, kanban, media semantic; P2 map, diagram, media

Trạng thái: done (#326 qua #353, #327 qua #372, #328 qua #373, #329 qua #378, #322 qua #398, #325 qua #396, #324 qua
#399; #323 còn gated). Plan: [plan.md](plan.md).

## Phạm vi

P1 trước P2, tuần tự vì chung anchor catalog (`renderers.tsx`, `registry.ts`, `fixtures.ts`, `view-catalog.ts`):

1. #326 (O) timeline hoạt động.
2. #327 (P) tree/hierarchy.
3. #328 (Q) kanban board; di chuyển thẻ là state view trước, thay đổi dữ liệu ngoài widget chỉ qua binding `invoke`.
4. #329 (R) semantic state cho image, gallery, carousel, video (YouTube chỉ từ props); tạo helper trạng thái phát dùng
   chung.
5. #322 (L) map offline + tile policy → #323 (tile thật, gate ngoài).
6. #325 (M) diagram không chạy script.
7. #324 (N) audio + document preview, sau #313 và #329 (dùng lại helper phát).

Kiểm tra ngày 2026-09-30: không có issue đóng hay PR merge nào đã làm timeline, kanban, tree hay semantic state media
(tìm issue, PR và `git log origin/main`); các renderer media trên `main` chưa nhận `state`/`onStateChange`, và
`buildWidgetSemantic` chưa có nhánh media.

Mỗi issue đi đủ đường ống primitive của #280/#281: contract, registry và fixture, placement, renderer, semantic state,
sự kiện composition (#226), Widget Library.

## Kiểm chứng

- Unit: contract từ chối đầu vào xấu (id trùng, vòng lặp tree, vượt giới hạn, ký tự ẩn, URL trong props map, construct
  Mermaid bị cấm, MIME sai, host riêng tư).
- State: snapshot cũ vẫn render; thay đổi state có version và migration (#329); ghi vị trí video được gộp.
- Kanban: E2E di chuyển bằng bàn phím, chuột và cảm ứng; move có binding hiển thị chờ rồi xác nhận hoặc hoàn tác kèm lý
  do, không báo thành công trước khi capability trả lời.
- E2E: không có request ra ngoài node; DOM diagram không có `script`, `foreignObject`, thuộc tính event hay URL ngoài.
- Bàn phím, focus, reduced motion, theme sáng/tối, 390 px không tràn ngang.
- `pnpm verify`, `pnpm verify:full`, `pnpm invariants`; docs EN/VI và `clarkcant-web`.

## Rủi ro

- Bảy issue cùng anchor: xung đột rebase liên tục nếu chạy song song. Giữ tuần tự; nếu cần song song, tách phần
  contract và runtime trước, renderer sau.
- Kanban dễ phình (sửa thẻ, swimlane): giữ non-goal trong #328.
- Basemap đóng gói vượt ngân sách kích thước: dùng graticule thay thế.
- Thư viện layout hoặc bản đồ mới: ưu tiên tự viết có giới hạn; nếu thêm, pin cứng và qua supply-chain policy.
- Node tải media hoặc tile là bề mặt SSRF: chặn địa chỉ riêng/loopback, giới hạn redirect trong origin allowlist.

## Rollback

Mỗi widget là một PR độc lập; revert PR, catalog bỏ primitive tương ứng. #329 thêm state version mới: rollback giữ
migration state để snapshot đã ghi vẫn đọc được.

---
phase: C
title: "Hợp đồng đầy đủ của canvas.table@1"
status: pending
issues: [198]
---

# Phase C — hợp đồng đầy đủ của `canvas.table@1`

## Bối cảnh

Descriptor (`packs/data-canvas/src/index.ts` `TABLE`) hứa sort, filter, page, export và selection. Renderer
(`packages/conversation-client/src/renderers.tsx` `DataTable`) hiện chỉ vẽ toàn bộ dòng, tự suy cột từ dòng đầu, chọn
được một dòng, và phát `row.select` kèm **nguyên object dòng**. `columns`, `pageSize` và export không được dùng. Với
widget đứng riêng, `use-surface-renderer.tsx` đang nuốt mọi `onAction`.

## Yêu cầu (tương thích ngược, vẫn giữ `@1`)

Props (chỉ thêm field optional):

- `columns`: mỗi phần tử là `string` (như cũ) hoặc
  `{ key, label?, type?: text|number|date|datetime|boolean, format?: { decimals?, unit?, style?: percent }, align? }`.
  Có `columns` thì renderer tuân theo thứ tự, nhãn và tập cột. Không có thì suy cột như cũ.
- `pageSize`: số nguyên 5–200, mặc định 25.
- `rowIdField`: field làm ID ổn định. Mặc định là `id` nếu dòng có field này. Không có thì dùng chỉ số trong dataset, và
  semantic state ghi rõ ID đó không ổn định.
- `selection`: `none|single|multi`, mặc định `single` như hành vi hiện tại.
- `totals`: `[{ column, fn: sum|avg|min|max|count }]`, hiển thị thành một dòng tổng.
- `searchable`: boolean.

State (bổ sung optional, không đổi `stateVersion`): `sort {column, direction}`, `page`, `query`,
`filters {column: value}` (điểm nối cho state graph ở phase G), `selectedIds`.

Events:

- `row.select` chỉ mang `{ rowIds }`, không mang object dòng.
- `export.requested` đi tới host.

Hàm view thuần dùng chung (contracts):

- `tableView(rows, { columns, sort, query, filters, page, pageSize })` trả về các dòng của trang, tổng số dòng,
  tổng số trang và totals. Client và host dùng cùng một hàm, nên CSV khớp đúng với những gì người dùng thấy.
- `tableSemanticState(...)` trả về summary, `selectedIds`, sort, query và page cho #195.

Export CSV qua host:

- Route chỉ dành cho person (person-only), xác thực như route dataset.
- Host tự resolve dataset từ `props.datasetRef` của instance, rồi áp `tableView` với sort, query và filter do client gửi.
- CSV quote theo RFC 4180. Chống formula injection: ô bắt đầu bằng `= + - @`, tab hoặc CR thì được thêm tiền tố `'`.
- Có `Content-Disposition`. Client tải file qua Blob.
- Snapshot lịch sử (read-only) hiển thị nút export ở trạng thái disabled kèm lý do, cùng mẫu với CTA.

Renderer:

- Header sort được bằng chuột và bàn phím, có `aria-sort`.
- Phân trang có nhãn, kiểu "Trang 2/7 · 153 dòng".
- Ô tìm kiếm có nhãn.
- Checkbox cho chế độ multi.
- Số và ngày định dạng theo locale.
- Dòng tổng.
- Giới hạn số node DOM bằng `pageSize`.
- Tuân theo DESIGN.md: focus, touch target và reduced motion.

## File

- `packs/data-canvas/src/index.ts`
- `packages/contracts/src/` (hàm view mới cùng test)
- `packages/conversation-client/src/renderers.tsx`, `use-surface-renderer.tsx`, `mini-app-surface.tsx`, `api.ts`,
  i18n EN/VI
- Route export ở `apps/runtime/src/routes/`
- Fixture `packages/widget-catalog/src/fixtures.ts`
- Docs `docs/widgets-and-extensions*.md` (§4.1) và conformance ledger

## Kiểm chứng

- Unit test cho `tableView`, cho escape CSV và cho route (auth, instance không tồn tại, snapshot).
- Test renderer.
- E2E: sort, page, search, multi-select và export (CSV tải về có ô công thức đã được escape).
- `pnpm verify`.
- Ảnh chụp bằng chứng ở desktop và mobile.

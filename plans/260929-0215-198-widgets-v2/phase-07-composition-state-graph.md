---
phase: G
title: "State/event graph của composition"
status: done
issues: [198, 226, 195]
---

# Phase G — state/event graph của composition

## Bối cảnh

- Cây bố cục (phase E) chỉ sắp xếp; các lá không nói chuyện với nhau. Lá search (phase F) lọc mọi bảng của bề mặt bằng
  một quy tắc ngầm trên trang, không lưu gì.
- Node đã có state bền vững theo instance (`widget_state`, kèm `state_revision`) và đường view action
  (`period.change`, `date.select`, `view.save`) kiểm input rồi ghi state trong một transaction.
- #195 cần một hình dạng state ngữ nghĩa, có giới hạn, để tiêm vào lượt sau của agent.

## Thiết kế

Hợp đồng mới `packages/contracts/src/composition-graph.ts`, thuần, dùng chung cho node và trang:

- `state`: tối đa 16 khoá, mỗi khoá có kiểu (`string`, `number`, `boolean`, `string-list`) và giá trị đầu.
- `on`: lá nào, sự kiện nào, chạy những bước nào. Sự kiện là tập đóng theo definition (search `query.change`, choice
  `choice.change`, input `input.change`, list `selection.change`, table `row.select`, calendar `date.select`).
  Các bước ghi state: `set`, `toggle`, `copy`, `append`, `remove`, `select-field`, `map-field`, `take`, `count`.
- `feed`: state đi vào lá nào, bằng phép gì. Tập đóng theo definition: bảng nhận `query` và `filter-equals` theo
  cột; list nhận `query` và `filter-equals`; biểu đồ nhận `filter-equals` trên `series`.
- Không có callback JS. Lá không tham chiếu lá anh em: lá chỉ nói nó ghi và đọc khoá state nào.
- `checkCompositionGraph` từ chối khoá state lạ, phép lạ, sự kiện mà definition không phát, feed mà definition không
  nhận, và kiểu không khớp. Chạy lúc biên dịch và lúc lưu.
- `applyGraphEvent` và `graphFeeds` là hàm thuần: trang chạy để phản hồi ngay, node chạy lại để có giá trị gốc.
- `graphSemanticState` cho #195: các giá trị hiện tại, có giới hạn, dạng dữ liệu, không phải chỉ dẫn.

Node:

- Model đề xuất graph qua `show_view` (tham số `state`, và `on` / `feed` trên lá). Compiler đọc, kiểm, gắn vào spec
  version 2 (`graph`). Lá choice/input được đặt trong bố cục khi graph dùng giá trị của nó; không thì vẫn bị từ chối.
- Bố cục có lá search mà không khai báo graph được biên dịch thành graph ngầm tương đương hành vi phase F, nên chỉ có
  một đường trên trang.
- Mỗi lá có `on` nhận một view binding `state.event`. Node áp sự kiện bằng `applyGraphEvent` lên state đã lưu,
  trong transaction của view action, tăng revision; input sai thì `INVALID_INPUT`.
- Route live trả `state.graph` và `semanticState`; bundle giữ giá trị lúc chụp, nên lịch sử vẽ đúng state đã chụp.

Client:

- `MiniAppSurface` giữ giá trị graph, áp sự kiện tại chỗ, đưa feed vào state của từng lá.
- Bề mặt live gửi sự kiện tuần tự, mỗi lần dùng revision mới nhất, rồi đọc lại.

## Kiểm chứng

- Unit: hợp đồng graph (mọi phép, giới hạn, từ chối), compiler, node áp sự kiện và từ chối input sai.
- E2E: một Mini App có search lọc bảng và choice lọc biểu đồ; bản live lưu state qua reload; lịch sử vẽ state đã chụp.
- `pnpm verify` và full E2E.

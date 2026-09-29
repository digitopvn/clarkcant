---
title: "#195 Semantic state của widget cho agent chính, không phá prompt cache"
status: done
created: 2026-09-29
issues: [195]
related: [198, 226, 225]
---

# #195 Semantic state của widget cho agent chính

Nguồn: issue [#195](https://github.com/digitopvn/clarkcant/issues/195), phase 05 của
[lộ trình](../260929-0002-open-issues-roadmap/plan.md). Dựa trên đồ thị state của #226 (`graphSemanticState`).

## Kết quả cần đạt

Người dùng tương tác với Mini App (chọn chuỗi, tìm, đổi kỳ, chọn ngày, widget cô lập publish), rồi nói một câu trỏ
tới cái đang thấy. Agent chính hiểu state hiện tại mà người dùng không cần nhắc lại. Tương tác không gọi model, prefix
prompt không đổi, chỉ thêm một hậu tố ngắn vào lượt mới, và `inspect_ui` đọc được bản đầy đủ khi cần.

## Phase

| Phase | Trạng thái | Chi tiết |
| --- | --- | --- |
| 01 Semantic state và ghi chú UI | xong | [phase-01-semantic-state.md](phase-01-semantic-state.md) |

## Tiêu chí (theo issue) và bằng chứng dự kiến

| Tiêu chí | Test |
| --- | --- |
| Tương tác không gọi model | runtime: POST action không tạo prompt nào |
| Lượt sau thấy state hiện tại | runtime và E2E |
| Không sửa history | runtime: `textOfMessage` và JSON message không đổi |
| Session mới nhận full, session cũ nhận delta | runtime (FakePiAdapter) |
| Thay đổi không semantic không tăng revision | runtime: `view.save` và cùng một giá trị |
| Lựa chọn, bộ lọc hay tập hành động đổi thì tăng revision | runtime |
| Gõ nhanh gộp lại, lượt sau thấy giá trị mới nhất | runtime |
| Có giới hạn, loại widget không liên quan | contracts và runtime |
| `inspect_ui` đọc bản đầy đủ | runtime |
| Nội dung frame là dữ liệu không tin cậy, không tự đặt ra hành động | contracts và runtime |
| Voice và text cùng nguồn | runtime |
| Prefix không đổi, chỉ thêm hậu tố (lịch sử dài) | runtime |

---
title: "#197 Signal → Intent → Effect: tự động hoá phản ứng"
status: completed
created: 2026-09-29
issues: [197]
related: [137, 172, 196, 170]
---

# #197 Tự động hoá phản ứng

Nguồn: epic [#197](https://github.com/digitopvn/clarkcant/issues/197), phase 06 và 11 của
[lộ trình](../260929-0002-open-issues-roadmap/plan.md).

## Kết quả cần đạt

Người dùng nói "khi X xảy ra thì làm Y" trong hội thoại. Clark lưu ý định đó, nhận signal sau này, đối chiếu bằng
matcher tất định, rồi chạy một task Clark bình thường, có provenance, resource riêng của task, lệnh qua broker của host,
Stop, audit và recovery. Người dùng không phải học signal, worker, node, webhook hay rule engine.

## Phase

| Phase | Nội dung | Phụ thuộc | Trạng thái |
| --- | --- | --- | --- |
| 01 | [Ngữ nghĩa thực thi: provenance, resource theo task, lệnh qua broker cho worker](phase-01-execution-semantics.md) | #137 (đã xong) | done (#240) |
| 02 | [Lõi Signal và persistent intent](phase-02-signal-intent-core.md) | 01 | done (#241) |
| 03 | [Adapter GitHub](phase-03-github-adapter.md) | 02 | done (#242) |
| 04 | [Hành trình code trọn vẹn (fixture)](phase-04-coding-journey.md) | 03 | done (#243) |
| 05 | [Signal từ peer và nguồn thứ hai](phase-05-peer-and-sources.md) | 02 | done (#244; phần còn lại ở #253) |

Mỗi phase là một PR, một sub-issue của #197. Hai phase cùng thêm migration thì xếp hàng theo thứ tự merge.

## Quyết định chung

- Matcher lưu dạng dữ liệu (topic cộng danh sách điều kiện `equals`/`in`/`contains`/`exists` trên đường dẫn), không
  gọi LLM lúc chạy. Model chỉ dịch câu nói thành intent có cấu trúc lúc tạo hoặc sửa.
- Persistent intent là ý định rõ ràng của người dùng nhưng có phạm vi: nó mang danh sách effect category đã được giao.
  Effect rủi ro ngoài phạm vi đó thì hỏi, trong mọi chế độ.
- Task tự động không nhận toàn bộ `projects.roots()` của node. Không nêu resource thì bị từ chối (fail closed).
- Repository được làm việc trong worktree do node quản lý dưới `dataDir`, không bao giờ trong cây làm việc của người dùng.
- Không hứa exactly-once với effect bên ngoài. Delivery là at-least-once, cộng dedupe bền vững.
- Hành trình trực tiếp với GitHub thật (webhook công khai hoặc polling trên repo thật) là việc bị gate bên ngoài,
  tách thành sub-issue `blocked,external-gate`.

## Tiêu chí của epic, phân theo phase

| Tiêu chí | Phase |
| --- | --- |
| Tạo, sửa, tạm dừng, xoá intent qua hội thoại | 02 |
| Delivery riêng của provider được chuẩn hoá thành Signal trước khi match | 02, 03 |
| Sống sót qua restart, không tạo task trùng | 02 |
| Match tất định | 02 |
| GitHub là adapter, không nằm trong lõi | 03 |
| Signal gắn nhãn issue khởi động task không cần người dùng (Autonomous) | 03, 04 |
| Task gói trong đúng repository hoặc worktree | 01, 04 |
| Lệnh của worker đi qua preflight, policy, Jev, Secret Broker, audit và giám sát của host | 01 |
| Pi dùng CLI thông thường (`git`, test, `gh`) | 01, 04 |
| Hành trình GitHub đầy đủ tới draft PR có evidence | 04 (fixture), sub-issue gated (thật) |
| Không tự kích hoạt vòng lặp | 03 |
| Intent chuyển task sang Clark khác qua NodeLink | 05 |
| Không lộ khái niệm kỹ thuật trong hành trình thường | 02, 04 |
| Stop, audit, provenance, recovery như việc tương tác | 01, 02 |
| Consent OAuth/OS/provider chỉ khi thật sự cần | 03 |
| Docs, kiến trúc, conformance cập nhật | mọi phase |

# Báo cáo Stage C — gợi ý từ việc gần đây và Memory

Phạm vi: phase 9 → phase 11. Gồm contract gợi ý và bộ sinh ở node, route đọc, client đọc kèm fallback, rồi Memory
bền vững (bảng, service, tool `remember`, hai route) và tab Memory trong Settings.

## Đã kiểm

| Điều được claim | Test chạy được | File |
| --- | --- | --- |
| Node không có gì thì gợi ý không bịa ra gì | `apps/runtime/test/suggestions.spec.ts` — "suggests nothing rather than inventing something" | `apps/runtime/src/suggestions.ts` |
| Hai gợi ý không bao giờ trỏ cùng một record | `apps/runtime/test/suggestions.spec.ts` — "never offers the same record twice" | `apps/runtime/src/suggestions.ts` |
| Danh sách là màn hình đầu, không phải menu | `apps/runtime/test/suggestions.spec.ts` — "offers a first screen rather than a menu" | `apps/runtime/src/suggestions.ts` |
| Cùng một gợi ý giữ cùng một tên | `apps/runtime/test/suggestions.spec.ts` — "gives the same offer the same name…" | `apps/runtime/src/suggestions.ts` |
| Node không trả lời được thì màn hình vẫn mở | `packages/conversation-client/test/suggestions.spec.ts` (4) | `packages/conversation-client/src/suggestions.ts` |
| Chip nói được nó đến từ đâu | `apps/web/e2e/suggestions.spec.ts` — "a chip drawn from the node's own records says where it came from" | `packages/conversation-client/src/Conversation.tsx` |
| Câu chip hiện chính là câu được gửi | `apps/web/e2e/suggestions.spec.ts` — "pressing a suggestion sends the sentence it showed" | `packages/conversation-client/src/Conversation.tsx` |
| Bí mật bị gỡ trước khi được ghi nhớ | `apps/runtime/test/memory.spec.ts` — "a secret is redacted before it is written down" | `apps/runtime/src/memory.ts` |
| Ghi nhớ quá dài thì bị từ chối và nói rõ giới hạn | `apps/runtime/test/memory.spec.ts` — "a note too long to be a memory is refused…" | `apps/runtime/src/memory.ts` |
| Brief chỉ mang record của node và của chính phiên này | `apps/runtime/test/memory.spec.ts` — "carries this conversation's decisions and the node's own records, but not another conversation's" | `apps/runtime/src/memory.ts` |
| Brief bị chặn trần và **nói ra** phần bị bỏ | `apps/runtime/test/memory.spec.ts` — "is capped, and says how much was left out…" | `apps/runtime/src/memory.ts` |
| Xoá một điều thì lượt sau không còn thấy nó | `apps/runtime/test/memory.spec.ts` — "a record that is deleted is gone from the next turn's brief" | `apps/runtime/src/memory.ts` |
| Xoá record của người khác không làm gì | `apps/runtime/test/memory.spec.ts` — "deleting somebody else's record does nothing" | `apps/runtime/src/memory.ts` |
| Nhãn thời gian được tính, không viết cứng | `packages/conversation-client/test/memory-groups.spec.ts` — "how long ago is computed rather than written down" | `packages/conversation-client/src/memory-groups.ts` |
| Nguồn chỉ nêu id, không chép nội dung | `packages/conversation-client/test/memory-groups.spec.ts` — "the source names where it came from without quoting it" | `packages/conversation-client/src/memory-groups.ts` |
| Node chưa nhớ gì thì nói vậy | `apps/web/e2e/memory.spec.ts` — "a node that has remembered nothing says so" | `packages/conversation-client/src/memory-panel.tsx` |
| Một điều đã nhớ hiện loại và nguồn của nó | `apps/web/e2e/memory.spec.ts` — "a remembered thing shows its source and its kind" | `packages/conversation-client/src/memory-panel.tsx` |
| Xoá là xoá thật, không phải ẩn | `apps/web/e2e/memory.spec.ts` — "deleting a remembered thing removes it rather than hiding it" | `packages/conversation-client/src/memory-panel.tsx` |

Ảnh: `plans/reports/evidence/memory-empty-light.png`, `plans/reports/evidence/memory-populated-dark.png`.

Journey xoá mở lại tab sau khi xoá, vì một dòng biến mất khỏi màn hình rồi quay lại ở lần đọc sau trông giống hệt
nhau trong một bức ảnh — và đó đúng là khác biệt giữa một memory người dùng kiểm soát được và một memory chỉ bị ẩn.

## Chưa kiểm được

| Điều chưa kiểm | Điều kiện còn thiếu |
| --- | --- |
| Việc model **quyết định** ghi nhớ | Fixture gọi đúng hàm mà tool `remember` gọi, nên nó chứng minh đường ống: redaction, ghi, brief, tab Memory đọc lại. Nó không chứng minh model chọn ghi nhớ. Điều kiện còn thiếu: một provider thật; các check live-provider là opt-in và cần tài khoản. |
| Gợi ý xếp hạng theo mức liên quan | Xếp hạng hiện là tất định theo thứ tự nguồn, không theo embeddings. Kế hoạch cấm đọc `history_embeddings` và cấm gọi model ở đường này (chi phí, và để gợi ý không thể nhớ thứ người dùng không đọc được). |
| Nguồn `memory` trong gợi ý | Phase 9.3 bước 3 ghi chú việc thêm nguồn `memory` sau khi phase 10 xong. Nó **chưa** được thêm: `suggestionSourceSchema` có `memory` nhưng `buildSuggestions` không sinh ra nguồn này. Đây là gap có tên, không phải tính năng đã xong. |

## Sai lệch so với kế hoạch

1. **Nguồn `conversation` không mang mốc thời gian.** Kế hoạch muốn nhãn nguồn nêu mốc ("từ phiên hôm qua").
   `listConversations` chỉ trả id, không trả instant, nên nhãn là "phiên gần nhất". Viết "hôm qua" mà không có mốc
   sẽ là điều duy nhất file đó tồn tại để tránh.
2. **`buildSuggestions` nhận thêm `nodeId`.** Kế hoạch ghi deps chỉ có `db, principalId, now, limit`, nhưng
   `listProjects` cần nodeId — dự án là của node, không của conversation.
3. **Thứ tự ghi file trong một lần làm bị sai hai lần**: sửa chuỗi rồi chỉ `append` mà quên ghi lại, và lần sau ghi
   đè lên chính phần vừa append. Hậu quả là hai commit có lỗi type đã lọt qua vì pipeline báo exit code của `tail`
   chứ không của lệnh kiểm. Từ đó các lần kiểm được đọc bằng `echo $?` ngay sau lệnh.
4. **`j1.spec.ts` phải ghim `/suggestions` về rỗng.** Khi chip đầu tiên trở thành gợi ý của node, các journey demo
   của j1 sẽ bấm vào một chip phụ thuộc dữ liệu tích luỹ. Sửa mỗi con số đếm là chưa đủ — nội dung mới là nguyên
   nhân — nên suite đó ghim danh sách về rỗng và journey của gợi ý động nằm ở file riêng.

## Cổng hồi quy của stage

`pnpm verify` xanh tại 1198 test. Các journey mới xanh khi chạy riêng: `suggestions.spec.ts` 2,
`memory.spec.ts` 3. `j1.spec.ts` 10 xanh và 1 đỏ — test đỏ là "a selected passage can be sent to a background
session", đã đo là đỏ sẵn ở commit gốc `7f3127f` trong Stage A, không phải do stage này.

# Báo cáo: đóng chín dòng conformance còn lại

Ngày: 2026-09-20. Nhánh: `mrgoonie/feat-file-attachments-minimal-voice-bar-voice-co`.
Chín dòng: V02, V08, V09, V10, V12, V13, V14, V15, V17. Mỗi dòng một PR riêng, CI xanh rồi merge.

## Kết quả theo dòng

| Dòng | Trạng thái | Lớp đã xây | Ranh giới còn lại |
| --- | --- | --- | --- |
| V02 | PASS | Unix-socket transport (`--socket`, mode `0o600`, hỏi socket sống trước khi xoá), định nghĩa image OCI, probe engine | — (không nói về dịch vụ live) |
| V08 | PARTIAL | Quarantine download (digest kiểm trước khi ghi), unpack có chặn escape + symlink, isolated build (env allowlist, `shell: false`, timeout) | dependency locking chưa xây |
| V09 | PARTIAL | Authorization-code exchange + refresh loop, PKCE được fixture kiểm thật | không có OAuth client đã đăng ký và tài khoản thật |
| V10 | PARTIAL | `readAgenda` + `writeEvent` với Calendar API fixture dạng Google | không có tài khoản Google |
| V12 | PARTIAL | `clark widget test --frames` trả lời 8/10 check cần frame qua chính `auditFrame` | MCP Apps dùng chung đường này; script dev host chỉ chạy trong browser |
| V13 | PARTIAL | Vị trí đã lưu tới được player vendor qua `start`, autoplay không thể diễn đạt | player YouTube thật chưa được kiểm |
| V14 | PARTIAL | `capturePreview` trả byte thật, lưu blob store, card mang `previewFrame` và render | đường node dùng PNG fixture; capture thật chỉ chạy trong test của driver |
| V15 | PARTIAL | Seam native binding + probe `requires-signed-bundle` / `requires-container-engine` | cả hai nguồn lực vẫn thiếu |
| V17 | PARTIAL | `probeLiveVoice` trả `requires-live-account`, nêu tên và không nêu giá trị | không có tài khoản provider |

Chỉ V02 lên PASS, và claim của nó không nói về dịch vụ live. Bốn dòng có claim về dịch vụ live
(V09, V10, V17, và nửa native của V15) ở lại PARTIAL với dây nối đã chứng minh và phần thiếu nêu tên.

## Defect thật mà việc xây dựng tìm ra

1. **GNU tar đọc `C:` trong đường dẫn Windows là remote host** và từ chối chạy. Pipeline quarantine
   chạy được trên Linux và hỏng trên Windows; nay tên artifact là tương đối so với đích.
2. **Đường timeout resolve theo tín hiệu, không theo lúc child đóng** — bên gọi có thể xoá thư mục
   mà child còn giữ (gặp dưới dạng `EPERM`).
3. **`statSync` đi theo symlink nên check escape không bao giờ bắn** — CI trên runner Linux bắt được;
   `lstatSync` hỏi đúng về entry.
4. **Một trường hai nghĩa trên card**: `preview` vốn là **trạng thái** node báo, và bản đầu của V14
   đặt cùng tên đó cho object byte. Đổi thành `previewFrame`.
5. **`eventsUrl` gọi `new URL` trước khi endpoint được validate** — pi-lens bắt được; base URL hỏng
   phải trả về một câu trả lời chứ không ném ra khỏi helper.
6. **`screenshotRef` không mang vị trí**: V13 render player mà bỏ qua `positionSeconds`, nên pin
   "mở lại đúng chỗ" thực ra phát từ giây 0.
7. **Ledger bị commit rỗng 0 byte** trong commit V15 (139 dòng bị xoá) trong khi working copy còn
   nội dung — CI báo thiếu mọi T-id từ T48 và checker đúng. Fix `326ebcc`; từ đó kích thước blob
   ledger được kiểm sau mỗi commit thay vì giả định.

## Gate

- `pnpm run invariants` → **8/8**.
- `pnpm verify` → **exit 0**, 2000 passed / 13 skipped.
- `pnpm test:e2e` → **exit 0**, 118 passed / 1 skipped (chạy ở lệnh riêng, sau khi dọn listener cũ).
- Mỗi PR #114–#123: verify (node 22.19), verify (node 24), secret scan, e2e (browser suite),
  desktop smoke (xvfb) — xanh hết; nhánh đồng bộ với `origin/main` sau mỗi lần merge (behind 0).

## Defect thứ tám, tìm ra ở chính bước gate này

Hai test trong `mini-app.spec.ts` đỏ khi e2e chạy lúc 23:0x Chủ nhật và xanh vào buổi chiều cùng
ngày. Gốc nằm trong **setup của chính chúng**: chúng tạo event lịch ở `now + 1h`, và sau 23:00 thì
mốc đó rơi sang ngày — và qua Chủ nhật thì rơi sang **tuần** — kế tiếp, ra ngoài khoảng "tuần này"
mà composition hỏi node. Region calendar chỉ được vẽ **khi có hàng**, nên nó biến mất và assertion
không tìm thấy `[data-calendar-month]`. CI xanh vì chạy trước mốc đó. Fix `44aed7b` neo event vào
hôm nay 09:00 theo timezone của event, giữ nguyên mọi assertion — sửa setup chứ không sửa kỳ vọng.

## Câu hỏi chưa ngã ngũ

Câu hỏi đã hỏi ở lượt đầu và người dùng chưa trả lời: V14 nên đóng hẳn (card + e2e) hay chấp nhận
PARTIAL với producer đã thật. Tôi đã chọn đóng hẳn vì contract của task ghi rõ "card render được",
và dòng V14 vì thế vẫn ở PARTIAL nhưng vì lý do khác — capture thật chỉ chạy trong test của driver.

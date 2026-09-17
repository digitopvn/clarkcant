# Calibration Jev cho search và routing (Phase 9)

Ngày: 2026-09-17. Phạm vi: quyết định `search.decider` mặc định, và ghi lại phần **chưa đo được**.

## Trạng thái: BLOCKED (thiếu credential)

Calibration so `jev` với `rank` **chưa chạy**. Điều kiện chạy: `CLARKCANT_JEV_LIVE=1` **và**
`TYPESAFE_API_KEY` trong môi trường của node. Repo này không giữ key (`.env` bị gitignore, key nằm ở
repo demo khác trong workspace theo ghi chú pre-flight của plan), nên không có số liệu provider nào
được tạo ra trong lần implementation này.

Test `apps/runtime/test/jev-calibration-live.spec.ts` in ra dòng BLOCKED và nêu đúng biến còn thiếu,
thay vì pass im lặng. Trong `pnpm verify` nó báo:

```
[calibration] BLOCKED: jev-vs-rank calibration was not produced.
Set CLARKCANT_JEV_LIVE=1 and TYPESAFE_API_KEY to run it. The default is "rank" until it is measured.
```

## Harness đã dựng (chạy được ngay khi có key)

- `apps/runtime/test/calibration-corpus.ts` — **34 truy vấn search** có nhãn (20 tiếng Việt, 14 tiếng
  Anh; 24 ca lexical, 10 ca chỉ giống nghĩa, 5 ca đáp án đúng là "không có gì") và **16 tình huống
  điều phối** (11 ca phải chọn một trong sáu thứ đang chạy, 3 ca đáp án đúng là "không có gì").
  Nhãn nằm ngoài file test để đọc và review được như một artifact.
- Search: cùng một danh sách đã xếp hạng được đưa cho cả hai nhánh (`rank` và `decideSearchResult`),
  nên phép so là công bằng; một lần `clarify` được tính đúng chỉ khi bản `rank` cũng sai — hỏi lại
  tốt hơn trả lời sai.
- Routing: `decideRuntimeTarget` trên sáu candidate (`lease` × 2, `voice-session`, `task`,
  `live-owner`, `node`), so với thứ tự quyết định của `rankRuntimeCandidates`.
- Mỗi ca in một dòng `rank=ok|miss jev=<status> ok|miss`, vì tổng số của cả corpus không nói được ca
  nào bị phá.

## Default đã chọn, và căn cứ

`search.decider = "rank"` (qua `CLARKCANT_SEARCH_DECIDER`, giá trị lạ → `rank`).

Căn cứ **không** phải "Jev tệ" mà là số đo sẵn có:

- Baseline Phase 8 (`plans/reports/verification-260917-1615-fts5-retrieval-baseline.md`): lớp lexical
  trả đúng **96.8%** (30/31) truy vấn có nhãn. Các ca trượt là **thiếu từ vựng**, không phải "có
  nhiều kết quả gần nhau" — và chọn giữa các kết quả không sửa được việc thiếu từ vựng.
- Nhóm semantic-only chỉ đạt **25%** (2/8); đó là việc của lớp semantic (Phase 10) và của lớp rank
  hợp nhất, không phải của bước chọn kết quả.
- Vì vậy bật `jev` cho search sẽ tốn 1 call mỗi truy vấn gần nhau mà chưa có bằng chứng cải thiện.
  Điều kiện đổi default đã ghi rõ trong code: khi calibration cho thấy jev **rõ ràng** tốt hơn.

Đường A (điều phối runtime) không có default tắt/tương đương: decider ở đó được gọi khi có >1
capability dùng được, và nó chỉ có thể chọn trong `usable`; nếu không có decider thì giữ nguyên thứ tự
cũ. Nghĩa là hành vi hôm nay giống hệt trước Phase 9 khi không cấu hình gì.

## Điều đã kiểm chứng được (không cần provider)

- 0 candidate → không gọi; 1 candidate → không gọi (không tốn request để xác nhận điều đã biết).
- Chọn xong **verify lại** trạng thái: lease có thể đã release, tab có thể đã đóng → rơi về `rank`,
  không dispatch vào target đã biến mất.
- Không rõ ràng (dưới floor/margin), chọn `none`, hoặc provider unavailable → `fallback`/`rank`.
- `clarify` chỉ khi Noul nói "cần hỏi lại"; Noul vùng giữa (0.15–0.85) không bị ép thành boolean.
- State gửi đi chỉ có intent đã redact + id/kind của candidate; **không** nhãn, không path, không goal.
  (Kiểm tra này bắt được một lỗ thật: redactor dùng chung chưa che path home, đã bổ sung pattern
  `home-path`/`windows-path` trong `packages/contracts/src/redaction.ts`.)
- Đường B chỉ gọi provider khi có ≥2 kết quả **và** khoảng cách tương đối giữa hai điểm BM25 đầu
  < 25% (ngưỡng tuyệt đối vô nghĩa vì điểm BM25 rất nhỏ — đã sửa trong lần implementation này).

## Việc còn lại (khi có key)

1. Chạy `CLARKCANT_JEV_LIVE=1 pnpm exec vitest run apps/runtime/test/jev-calibration-live.spec.ts`.
2. Nếu jev ≥ rank một cách rõ ràng trên corpus → đặt `CLARKCANT_SEARCH_DECIDER=jev` làm default và
   ghi lại số mới vào file này; nếu không, giữ `rank` và ghi lý do.
3. Thay corpus bằng log thật khi có, vì 34 truy vấn do người viết trong repo không đo được độ chệch
   của người viết nhãn.

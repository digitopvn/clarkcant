# Baseline retrieval FTS5 + temporal parser (Phase 8)

Ngày: 2026-09-17. Phạm vi: lớp **Lexical retrieval** + **Structured filters** của Memory & Search,
trước khi có semantic retrieval (Phase 10) và trước khi Jev tham gia chọn kết quả (Phase 9).

## Cách đo

- Corpus 39 truy vấn có nhãn người: **31 ca lexical** (từ trong truy vấn có mặt trong message đích,
  cùng ngôn ngữ) và **8 ca semantic-only** (đồng nghĩa hoặc khác ngôn ngữ). Nhãn là "message nào một
  người sẽ chọn", không phải "message nào chứa từ khoá".
- 14 message được seed qua đúng đường ghi production (`appendMessage` + `indexMessages`), 9 tiếng
  Việt và 5 tiếng Anh, trải từ 2026-09-03 đến 2026-09-16.
- Một truy vấn được tính là đạt khi message đích nằm trong **top 3** kết quả BM25; với ca âm (đáp án
  đúng là "không có gì") thì đạt khi không có kết quả nào.
- Chạy bằng `pnpm exec vitest run apps/runtime/test/session-search.spec.ts`; số liệu được test in ra
  (`[fts-baseline]`) nên không tách rời khỏi lần chạy thật.

## Kết quả

| Nhóm | Đạt | Tỷ lệ |
|---|---|---|
| Lexical (31 ca) | 30 | **96.8%** |
| Semantic-only (8 ca) | 2 | **25.0%** |
| Âm (nằm trong nhóm lexical, 5 ca) | 4 | 80% |

Ghi chú quan trọng:

- **Tỷ lệ 96.8% là của lớp lexical, không phải của "search nói chung".** Các ca khác ngôn ngữ
  ("login bug" hỏi một message tiếng Việt) nằm trong nhóm semantic-only và **không** được tính vào
  ngưỡng; nếu gộp lại thì con số là 82%. Đây là ranh giới thật của BM25 và là lý do Phase 10 tồn tại.
- Một ca lexical trượt: `"phân tích cảm xúc khách hàng"` (đáp án đúng là không có gì) trả về
  `msg_meeting` vì trùng token "khách"/"hàng". Đây là false positive do trùng từ vựng bộ phận, không
  phải lỗi cài đặt; nó được giữ nguyên trong corpus làm bằng chứng rằng lớp lexical cần lớp rank/verify
  phía trên chứ không nên được tin tuyệt đối.
- Truy vấn chỉ gồm mốc thời gian ("hôm qua") trả về đúng nội dung trong cửa sổ, sắp theo thời gian —
  trường hợp mà xếp hạng BM25 không áp dụng được.

## Temporal parser

- Nhận cả tiếng Việt có dấu và không dấu, tiếng Anh, ISO date, "N ngày/tuần trước", "N ngày qua".
- Ranh giới ngày là **local calendar** trong timezone của node (Asia/Saigon trong test): "hôm qua"
  là 2026-09-15T17:00Z → 2026-09-16T17:00Z, "tháng trước" là 2026-07-31T17:00Z → 2026-08-31T17:00Z.
- Cụm thời gian được **loại khỏi** phần text đem đi tìm, nếu không "hôm"/"qua" sẽ khớp mọi message
  trong ngày đó và lấn át kết quả thật.
- Không nhận ra thì trả `none` và giữ nguyên truy vấn; không mặc định về "hôm nay", vì một cửa sổ bị
  thu hẹp âm thầm trông giống hệt một index rỗng.

## Giới hạn đã biết

- Corpus do người viết trong repo, không phải log người dùng thật; 39 truy vấn là mẫu nhỏ và không đo
  được độ chệch của chính người viết nhãn.
- Chưa đo p95 latency trên corpus lớn; chỉ số trong test là thời gian chạy test, không phải SLO.
- Chưa có dữ liệu tiếng Việt không dấu ở phía **nội dung** (message viết không dấu) — chỉ kiểm tra
  truy vấn không dấu trên nội dung có dấu, dù tokenizer `remove_diacritics 2` xử lý cả hai chiều.

## Hệ quả cho Phase 9

- Quyết định bật `search.decider = jev` phải dựa trên nhóm **semantic-only**, không phải con số 96.8%:
  lớp lexical đã đủ tốt cho truy vấn trùng từ, và Jev không sửa được điều đó.
- 8 ca semantic-only hiện đạt 25% là mốc so sánh cho Phase 10 (hybrid RRF) và cho calibration Phase 9.

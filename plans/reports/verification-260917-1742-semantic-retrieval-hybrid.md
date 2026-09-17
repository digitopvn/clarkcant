# Xác minh Phase 10 — semantic retrieval, RRF và quyết định giữ FTS-only

- **Loại:** verification
- **Ngày:** 2026-09-17 (Asia/Saigon)
- **Branch:** `feat/jev-mini-app-rendering`
- **Kế hoạch:** `plans/260917-0528-jev-mini-app-rendering/phase-10-semantic-retrieval.md`
- **Baseline để so:** `plans/reports/verification-260917-1615-fts5-retrieval-baseline.md`

## Kết luận

Đã triển khai đủ lớp semantic theo kế hoạch: `sqlite-vec` (KNN exact) + E5-small ONNX local, hợp nhất với FTS5 bằng RRF k=60, có ceiling khoảng cách, có verify biên (không trộn vector khác model, không đọc dữ liệu của principal khác). Toàn bộ là **optional**: không có extension hoặc không có model thì node tìm bằng lexical và **nói rõ lý do**.

**Nhưng đo trên corpus Phase 8 thì hybrid không cải thiện, và làm giảm precision nếu nới ceiling.** Vì vậy `CLARKCANT_SEARCH_SEMANTIC` mặc định **tắt**, và `CLARKCANT_SEARCH_DECIDER` vẫn là `rank`. Đây là kết quả đúng như kế hoạch cho phép: "hoặc ghi rõ không cải thiện và giữ FTS-only". Code hybrid vẫn ở đó sau flag để đo lại khi có corpus lớn hơn hoặc model tốt hơn.

## Môi trường và version đóng băng

| Hạng mục | Giá trị |
|---|---|
| Máy | macOS darwin arm64, Node v24.19.0, `corepack pnpm` 12.4.2 |
| Vector index | `sqlite-vec` 0.1.9 (`sqlite-vec-darwin-arm64`, `vec0.dylib`), `vec_version()` = `v0.1.9` |
| Embedding runtime | `@huggingface/transformers` 4.3.0 + `onnxruntime-node` 1.30.0 (postinstall được cho phép trong `allowBuilds`) |
| Model | `Xenova/multilingual-e5-small`, dtype `q8`, 384 chiều |
| Model digest (khai báo) | `sha256:embedding:065a8ffb239039ee` = sha256(`Xenova/multilingual-e5-small@q8`) |
| RRF | k = 60 |
| Ceiling cosine mặc định | 0.1 (lấy từ sweep bên dưới) |
| Đo trên | corpus Phase 8: 15 history row, 34 query đã gán nhãn (22 lexical, 12 semantic-only, 5 có đáp án "không có gì") |

Đo thời gian trên máy này: nạp model + batch 3 passage **435 ms**, một passage lúc đã ấm **50 ms**, cosine giữa query "sửa lỗi không đăng nhập được" và passage đăng nhập **0,8669** (passage migration 0,7832) — model trả về đúng thứ tự ngữ nghĩa, đây không phải embedder giả. Kích thước file ONNX **không đo được** trên máy này: cache của thư viện không nằm ở `~/.cache/huggingface` và tôi không tìm thấy artifact, nên báo cáo không ghi một con số không quan sát được. Thứ hữu ích cho vận hành là thời gian nạp, và nó đã đo.

## Kết quả đo: hybrid vs FTS thuần

Cùng corpus, cùng nhãn, cùng cách tính như baseline. Chỉ khác việc vector có tham gia hay không.

| Đường | top-1 đúng | subset semantic-only (12) | query "không có đáp án" trả về kết quả |
|---|---|---|---|
| FTS5 thuần (baseline Phase 8) | 31/34 | 9/12 | 0/5 |
| Hybrid, ceiling 0.1 | 31/34 | 9/12 | 0/5 |
| Hybrid, ceiling 0.15 | 30/34 | 8/12 | 0/5 |
| Hybrid, ceiling 0.2 | 26/34 | 8/12 | 4/5 |
| Hybrid, ceiling 0.25 | 25/34 | 8/12 | 5/5 |
| Hybrid, ceiling 0.4–1.0 | 25/34 | 8/12 | 5/5 |

Đọc bảng này: **không có ceiling nào làm hybrid tốt hơn FTS**, và từ 0.2 trở lên nó tệ đi rõ rệt. Lý do nằm ở bản chất KNN: một truy vấn vector **luôn** trả về k hàng xóm gần nhất, kể cả khi câu hỏi không có kết quả đúng trong lịch sử. RRF trộn những hàng xóm đó vào danh sách, nên câu hỏi mà câu trả lời trung thực là "không có gì" lại nhận được một kết quả gần đúng — đúng 5/5 trường hợp khi ceiling ≥ 0.25. Ceiling chặt (0.1) chặn được việc đó nhưng cũng chặn luôn phần đóng góp của vector, nên kết quả bằng FTS thuần.

Hai chi tiết đáng ghi lại vì chúng chỉ ra giới hạn của phép đo, không phải của ý tưởng:

- Một ca **mất kết quả đúng** khi bật hybrid: "đưa bản dựng lên máy chủ thử" (semantic-only, đáp án `msg_deploy`) — FTS thuần trả đúng, hybrid đổi sang `msg_image`.
- Subset semantic-only **không tăng**: 9/12 ở cả hai đường. Đây chính là loại câu hỏi mà vector được kỳ vọng sẽ cứu, và trên corpus này nó không cứu được. Nguyên nhân khả dĩ: E5-small lượng tử hoá (q8) trên tiếng Việt, corpus chỉ 15 dòng nên mỗi hàng xóm gần như luôn "gần" về mặt vector, và không có bước rerank.

Latency đường hybrid: **p50 2,7–2,8 ms, p95 3,6–7,0 ms, max 4,2–10,8 ms** cho 34 query (đã gồm embed query). So với budget 4 s thì rất xa, nhưng chi phí thật của semantic là lúc **ingest**, không phải lúc query.

## Quyết định

| Quyết định | Lý do |
|---|---|
| `CLARKCANT_SEARCH_SEMANTIC` mặc định **tắt** | Đo được: hybrid không cải thiện top-1, và giảm precision khi nới ceiling |
| `CLARKCANT_SEARCH_DECIDER` giữ `rank` | Như Phase 9: chọn giữa các kết quả không sửa được vấn đề từ vựng thiếu |
| Ceiling mặc định **0.1** | Giá trị đo được duy nhất không tạo kết quả cho câu hỏi không có đáp án; 0.2+ tạo 4–5/5 |
| Bảng vector tạo **lazy**, không trong migration | `vec0` chỉ tạo được khi connection đã load extension; migration chạy trên mọi máy, kể cả máy thiếu extension |
| Đổi model ⇒ **reindex**, không trộn | Index ghi `model`/`dims`/`digest` từng vector và từ chối khi model hiện tại khác |

## Đã triển khai

| File | Nội dung |
|---|---|
| `packages/storage/src/migrate.ts` | Migration 15: `history_embeddings_meta` (SQL thuần, luôn áp dụng được) |
| `packages/storage/src/repositories.ts` | `embeddingIndexState`, `ensureEmbeddingTable` (tạo `history_vec` lazy, `distance_metric=cosine`), `insertEmbedding`, `upsertEmbeddingMeta`, `embeddingIndexState`, `historyMissingEmbedding`, `searchEmbedding` (KNN, lọc principal trong SQL), `historyEntry` |
| `packages/storage/src/db.ts` | `allowExtension: true` lúc mở DB; không load gì ở tầng này |
| `apps/runtime/src/embeddings-local.ts` | Loader E5-small, prefix `query:`/`passage:`, `modelDigest`, mọi lỗi trả `reason` |
| `apps/runtime/src/hybrid-rank.ts` | `rrfFuse` (thuần), `SEMANTIC_DISTANCE_CEILING`, `applySemanticFusion` (đọc lại text cho kết quả chỉ có ở vector, `rankedBy: "rrf"`) |
| `apps/runtime/src/vector-index.ts` | `loadVectorExtension`, `vectorIndexStatus`, `embedMissingHistory` (resumable), `createVectorIndexService` (nạp model một lần, không chặn boot) |
| `apps/runtime/src/session-search.ts` | Đường hybrid sau `deps.semantic`; `rankedBy`, `semantic` trong outcome |
| `apps/runtime/src/services.ts` | Service `vectors`, `semantic` là getter (model nạp sau boot vẫn được thấy), `void vectors.ensure()` không await |
| `pnpm-workspace.yaml` | `allowBuilds: onnxruntime-node: true` (có comment lý do) |
| `README.md`, `docs/research-and-decisions.md`, `docs/mini-app/jev-configuration.md` | Native deps là optional; ADR ghi quyết định + số đo; runbook vận hành cho flag/ceiling/khi nào không nên bật |

Test: `apps/runtime/test/hybrid-rank.spec.ts` (13), `vector-index.spec.ts` (14), `embeddings-local.spec.ts` (3 + 1 opt-in), `hybrid-calibration-live.spec.ts` (opt-in, in bảng sweep). `pnpm verify`: **56 file, 796 passed / 7 skipped (803)**.

## BLOCKED và giới hạn

| Hạng mục | Điều kiện | Trạng thái |
|---|---|---|
| Đo hybrid trên corpus lớn | Corpus Phase 8 chỉ 15 row / 34 query; cần history thật vài trăm dòng để kết luận về chất lượng, không chỉ về plumbing | Chưa đo; kết luận hiện tại chỉ đúng cho corpus này |
| Kích thước artifact model | Không tìm thấy cache của thư viện trên máy này | Không ghi số |
| Rerank (cross-encoder) | Ngoài scope phase; nhưng đây là bước có khả năng sửa đúng thất bại đã đo | Chưa có |

Một lưu ý vận hành đã gặp và không phải lỗi sản phẩm: chạy script đo bằng `tsx` thì `createRequire(import.meta.url)("sqlite-vec")` không resolve được, nên extension bị coi là thiếu và phép đo đầu tiên cho ra "hybrid" thực chất là FTS thuần (`0 embedded of 0`). Phép đo đúng phải chạy dưới vitest hoặc `node` trực tiếp. Đây là lý do harness đo nằm trong `apps/runtime/test/`, không phải trong một script rời.

## Residual risks

1. Kết luận "hybrid không cải thiện" dựa trên 34 query đã gán nhãn và 15 history row. Trên lịch sử lớn, việc trả về một hàng xóm gần đúng thay vì không có gì có thể là hành vi mong muốn — khi đó phải đo lại, không suy luận.
2. `searchEmbedding` lấy `k = limit * 4` rồi lọc principal trong SQL. Với nhiều principal trên cùng node, tỉ lệ lọc bỏ có thể làm thiếu kết quả; cần đo khi có nhiều principal thật.
3. `embedMissingHistory` chạy một lượt có giới hạn (`limit` 128) mỗi lần `ensure()`. History lớn cần một tiến trình ingest nền, hiện chưa có.
4. Model nạp trong tiến trình node (vài trăm MB RAM). Chưa đo ảnh hưởng lên thời gian boot khi node có nhiều việc.

## Câu hỏi chưa giải quyết

- Có nên bật semantic mặc định khi history vượt một ngưỡng nào đó (ví dụ vài nghìn dòng), thay vì một flag tĩnh?
- Có nên thêm một bước rerank bằng cross-encoder nhỏ trước khi kết luận hybrid không đáng dùng không?
- Corpus calibration nên mở rộng tới đâu để đủ mạnh cho quyết định về retrieval (hiện 34 query là quá ít để nói về chất lượng, chỉ đủ để nói về plumbing)?

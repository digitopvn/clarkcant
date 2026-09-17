# Xác minh live integration & calibration — Jev với model thật

- **Loại:** verification
- **Ngày:** 2026-09-17 (Asia/Saigon)
- **Branch:** `feat/jev-mini-app-rendering`
- **Kế hoạch:** `plans/260917-0528-jev-mini-app-rendering/phase-06-release-validation.md`, bước 4–6
- **Liên quan:** `plans/reports/verification-260917-1630-jev-decider-calibration.md` (baseline chạy bằng code tất định)

## Kết luận

Release gate của Phase 6 — "opt-in live integration và calibration với model version xác định" — **đã chạy và ĐẠT** với model thật `jev-1.13.0`: selector trả lời được, chọn đúng template được offer, Noul trả xác suất trong khoảng, và từ chối một model id khác.

Đo được hai điều quyết định default:

1. **Search: selector không thắng ranking.** `rank` 31/34 (91,2%) so với `jev` 31/34 (91,2%) trên cùng corpus. Vì vậy `CLARKCANT_SEARCH_DECIDER` **giữ `rank`** — quyết định này giờ dựa trên số đo live, không phải trên suy luận từ baseline.
2. **Routing: 8/16 (50%).** Selector chọn đúng ở các ca "việc đang chạy dở xong chưa", "close the microphone", "there is a surface open somewhere", "the docs workspace again please", và **abstain đúng** ở các ca ngoài phạm vi ("thời tiết hôm nay thế nào", "write me a poem about rain", "kể chuyện cười đi"). 50% chưa đủ để bật làm mặc định, nhưng nó cũng cho thấy hành vi abstain hoạt động: 3/3 ca ngoài phạm vi đều `none`, không đoán bừa.

**Đính chính một kết luận sai trước đó:** các report trước ghi hạng mục này là BLOCKED vì "thiếu `TYPESAFE_API_KEY`". Điều đó **sai**: key nằm trong workspace đúng như `plan.md` dòng 126 nói, và gate này đã chạy được ngay từ đầu. Việc ghi BLOCKED mà không kiểm tra đã khiến một gate có thể chạy bị coi là không thể chạy. Không có lý do kỹ thuật nào cho việc đó; đây là lỗi của người thực thi, không phải của môi trường.

## Provenance

| Hạng mục | Giá trị |
|---|---|
| Endpoint | `https://api.typesafe.ai/v1/systemone` (mặc định của adapter) |
| Model trả về | `jev-1.13.0` (alias `jev-latest` resolve về cùng id, đã kiểm ở smoke 14:40) |
| Policy version | `2026-09-17` (stamp vào telemetry và provenance của composition) |
| Key | từ environment của operator (`TYPESAFE_API_KEY` export trong shell), không ghi vào file nào của repo |
| Flag opt-in | `CLARKCANT_JEV_LIVE=1` (bắt buộc, để một key có trong máy không làm mọi lần chạy test gọi provider) |
| Corpus | 34 query search + 16 tình huống routing, nhãn người viết, nằm trong `apps/runtime/test/calibration-corpus.ts` |
| State gửi đi | tổng hợp (synthetic), không chứa dữ liệu người dùng hay tên tài nguyên thật trên máy |

## Live smoke — `apps/runtime/test/jev-live.spec.ts`

Chạy: `CLARKCANT_JEV_LIVE=1 pnpm exec vitest run apps/runtime/test/jev-live.spec.ts` → **3 passed** (1 skipped là nhánh không có key), 1,79 s.

| Kết quả | Số đo |
|---|---|
| Chọn template | `selected overview@1`, confidence 1.000, margin 1.000 |
| Noul | `0.980`, verdict `on` |
| Model khác được yêu cầu | provider trả HTTP 400 → adapter coi là không khả dụng, không chấp nhận (đúng hành vi `model_drift`/refusal) |

## Calibration — `apps/runtime/test/jev-calibration-live.spec.ts`

Chạy: `CLARKCANT_JEV_LIVE=1 pnpm exec vitest run apps/runtime/test/jev-calibration-live.spec.ts` → **2 passed** (1 skipped), 6,76 s.

| Đường | Kết quả | Ghi chú |
|---|---|---|
| Search — `rank` (baseline) | **31/34 (91,2%)** | Dùng chính corpus của Phase 8 |
| Search — `jev` | **31/34 (91,2%)** | Không hơn; có ca chọn `chosen` đúng ("the login problem we hit"), có ca `rank` giữ nguyên vì ranking đã tách bạch |
| Routing — `jev` | **8/16 (50,0%)** | Có abstain đúng 3/3 ca ngoài phạm vi |

Ca đáng chú ý ở routing: các câu hỏi trạng thái mơ hồ ("máy này đang thế nào", "what is mounted right now") đều rơi về `fallback`/`none` — selector không đoán, đúng tinh thần "không suy diễn trạng thái sống từ văn bản". Ca thắng là những câu nêu rõ đối tượng ("there is a surface open somewhere, which one", "close the microphone", "the docs workspace again please").

## Telemetry — `9` call thật

Chạy: `CLARKCANT_JEV_LIVE=1 npx tsx .pi/tmp/jev-telemetry.ts` (script đo, không nằm trong repo).

| Số đo | Giá trị |
|---|---|
| Số call | 9 |
| Model | `jev-1.13.0` (duy nhất) |
| Kết quả chọn template | 3 selected / 1 fallback (câu ngoài phạm vi: "kể chuyện cười đi" → khước từ, không chọn bừa) |
| Trạng thái call | 8 `answered`, 1 `abstained` |
| Token | 3 110 input, 231 output cho cả 9 call |
| Độ trễ | p50 **322 ms**, p95 **824 ms**, max **824 ms** |

Đối chiếu budget: `CLARKCANT_JEV_TIMEOUT_MS` mặc định 4 000 ms cho **toàn bộ** selector call trong một turn. p95 824 ms nghĩa là một batch 2 call vẫn nằm trong budget với biên rộng; chưa có ca nào chạm trần trong lần đo này. Đây là mẫu nhỏ (9 call) nên không được đọc thành SLA.

## Quyết định sau khi có số live

| Quyết định | Lý do |
|---|---|
| `CLARKCANT_SEARCH_DECIDER` giữ **`rank`** | Selector không hơn baseline (31/34 = 31/34) và tốn thêm một call cho mỗi lần search |
| Chưa bật Jev cho routing làm mặc định | 8/16 trên corpus nhỏ; hành vi abstain thì đúng nhưng độ phủ còn thấp |
| Giữ exact-model gate | Một request tới model khác bị provider từ chối HTTP 400 và adapter không chấp nhận kết quả — đúng như thiết kế |
| Giữ ngưỡng confidence/margin hiện tại (0,85 / 0,20) | Chưa có đủ ca để biện minh cho việc chỉnh; lần đo này selector đạt 1.000/1.000 ở ca rõ ràng và khước từ ở ca ngoài phạm vi |

## Giới hạn

- **34 query và 16 tình huống là corpus nhỏ**, viết trong repo này, không phải mẫu ngẫu nhiên từ người dùng thật. Kết luận đúng cho corpus này, không phải cho "chất lượng của Jev" nói chung.
- **9 call telemetry** không đủ để nói về p95 hay tỉ lệ lỗi của provider; nó chỉ đủ để nói đường này chạy được và chi phí/latency ở mức chấp nhận cho một batch.
- Token usage lấy từ chính response của provider; nếu provider không trả `usage` thì adapter không tự đếm, nên con số này chỉ có khi provider báo.
- Chưa đo hành vi khi provider chậm hoặc lỗi giữa một compose thật (đã có test đơn vị cho timeout/refusal ở tầng adapter, chưa có lần chạy live nào chạm trần budget).

## Câu hỏi chưa giải quyết

- Ngưỡng confidence/margin 0,85/0,20 có nên giữ khi corpus routing mở rộng? Hiện chưa có ca nào rơi vào vùng 0,5–0,85 để kiểm chứng ngưỡng.
- Có nên thêm một corpus routing lớn hơn (≥50 tình huống) trước khi cân nhắc bật Jev cho routing không?
- Có nên ghi lại usage vào telemetry của node để một release sau đọc được chi phí theo thời gian, thay vì phải đo bằng script rời?

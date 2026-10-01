# Chẩn đoán: lượt chat trả về "không có văn bản" (deepseek/deepseek-v4-flash)

Ngày: 2026-09-26 · Hội thoại: `conv_6742c658_muhy9p7z` · Phạm vi: chỉ đọc, cộng vài lời gọi model rất nhỏ để xác minh (tổng chi phí khoảng 0,00003 USD).

## Kết luận

Credential không thiếu, và model id cũng không sai. DeepSeek đã nhận request rồi từ chối nó với
**HTTP 402 "Insufficient Balance"**, tức tài khoản DeepSeek đã hết số dư. Lỗi này nằm trong transcript của Pi,
nhưng ClarkCant lại báo là "ended the turn without producing any text". Đây là một **bug phân loại lỗi có thật**:
adapter bỏ qua `stopReason: "error"` cùng `errorMessage` của assistant message, nên runtime chỉ còn thấy một lượt
chạy xong mà không có segment nào.

## Dòng thời gian (UTC)

| Thời điểm | Sự kiện | Nguồn |
|---|---|---|
| 05:29:24.876 | Tin nhắn người dùng được chấp nhận | `GET /conversations/conv_6742c658_muhy9p7z/timeline` |
| 05:29:51.338 | Pi session được tạo, `model_change deepseek/deepseek-v4-flash`, `thinkingLevel high` | `.data/sessions/2026-09-26T05-29-51-338Z_01a0dc30-….jsonl` |
| 05:29:52.323 | Prompt người dùng được ghi vào session, kèm `custom_message` `agentkit-hook` | cùng file |
| 05:29:53.370 | Assistant `stopReason=error`, `errorMessage="402: {\"message\":\"Insufficient Balance (request_id: ac6c1849-…)\"…}"`, usage 0 | cùng file |
| ≈05:29:53.8 | System card "model-turn-failed … after 28949 ms" (24.876 s + 28.949 s ≈ 53.825 s) | timeline |

Khoảng 26,5 giây trong số 29 giây trôi qua **trước khi** Pi session được tạo. Phần gọi DeepSeek chỉ mất khoảng 1 giây.

## 1. Cách resolve provider, model và credential

- `modelFromEnv` đọc `CC_MODEL_PROVIDER` và `CC_MODEL_ID` (`packages/pi-adapter/src/env-file.ts:152-162`). Lựa chọn lưu
  trong Settings được ưu tiên hơn, và được đọc lại cho mỗi session mới
  (`apps/runtime/src/bootstrap/model-bootstrap.ts:73-79`).
- `RealPiAdapter.#resolveModel` kiểm tra provider và model trong catalogue của SDK, rồi ném lỗi có tên cụ thể nếu
  không thấy (`packages/pi-adapter/src/real.ts:227-255`). Model `deepseek-v4-flash` **có trong catalogue**:
  `GET /model` trả về provider `deepseek` gồm `deepseek-v4-flash, deepseek-v4-flash-vision-exp, deepseek-v4-pro,
  deepseek-flash`. Nhánh này vì vậy không ném lỗi.
- Credential do `sdk.ModelRuntime.create({})` resolve (`real.ts:238`). Probe `getProviderAuthStatus` (chỉ in tên và
  nguồn) cho kết quả:
  - `deepseek` → `{"configured":true,"source":"stored"}`, tức key lấy từ `~/.pi/agent/auth.json`, mục `deepseek`
    (`type,key`).
  - `DEEPSEEK_API_KEY` có trong biến môi trường **User** của Windows (không nằm trong `.env`). Tiến trình thừa kế biến
    này, nhưng khi có `auth.json` thì biến này bị ghi đè.
  - `google` → `environment`/`GEMINI_API_KEY`; `openrouter` → `environment`/`OPENROUTER_API_KEY`.
- Tên biến môi trường Pi mong đợi cho DeepSeek là `DEEPSEEK_API_KEY` (pi-ai `dist/env-api-keys.js:80`, và
  `PROVIDER_KEY_VARIABLES` ở `env-file.ts:87-96`).
- Comment ở `real.ts:234-237` khẳng định "env is the contract", nhưng thực tế SDK vẫn đọc credential lưu trong
  `~/.pi/agent/auth.json` của người dùng và ưu tiên nó hơn env. Comment này sai so với hành vi thật.
- `/readiness` trả `{"model":true,"credentials":["gemini","typesafe"]}`. `model:true` chỉ có nghĩa là đã cấu hình
  một model (`routes/node.ts:267-275`), còn `KNOWN_CREDENTIALS` chỉ biết `gemini` và `typesafe`
  (`apps/runtime/src/readiness.ts:11-16`). Vì vậy readiness không nói gì về DeepSeek, dù là có hay thiếu key.

Xác minh trực tiếp: gọi `completeSimple` tới `deepseek/deepseek-v4-flash` bằng key trong auth.json trả về 402
Insufficient Balance. Đổi sang key `DEEPSEEK_API_KEY` trong env (qua `setRuntimeApiKey`) cũng trả về 402, nên cả hai
key đều trỏ tới tài khoản không còn số dư.

## 2. Vì sao lỗi hiện ra là "no text"

Chuỗi bằng chứng:

1. pi-ai không throw khi provider trả lỗi. Nó ghi một assistant message với `stopReason:"error"` và `errorMessage`
   (transcript nói trên).
2. Pi không retry lỗi này. Chuỗi "Insufficient Balance" không khớp `RETRYABLE_PROVIDER_ERROR_PATTERN` (pi-ai
   `dist/utils/retry.js:20-77`), nên `session.prompt()` kết thúc bình thường.
3. `RealPiAdapter.prompt` chỉ `await session.prompt(); await agent.waitForIdle()` rồi trả về. Nó không kiểm tra
   assistant message cuối cùng (`real.ts:664-692`).
4. `mapPiEvent` chỉ chuyển tiếp `text_delta`, `thinking_delta`, tool, `turn_end` và `agent_settled`. `message_end` và
   `errorMessage` đều bị bỏ (`real.ts:737-771`).
5. `model-turn.ts:1067-1071` thấy `segments.length === 0` nên ném thông báo chung "ended the turn without producing
   any text".

Vậy đây là bug thật: nguyên nhân cụ thể và có thể sửa được (402, hết số dư) bị đổi thành một thông báo mơ hồ, trái
với quy tắc "Error copy must say what failed" trong AGENTS.md. Log runtime cũng không ghi dòng nào về lượt lỗi này
(log chỉ có 18 dòng khởi động), nên người vận hành không thấy lỗi ở đâu ngoài transcript.

Hướng sửa (chưa làm vì phạm vi là chẩn đoán): sau `waitForIdle`, adapter đọc assistant message cuối cùng. Nếu
`stopReason === "error"` thì ném lỗi mang `errorMessage` (đã rút gọn và không chứa secret), và phân loại 401/402/403
thành "credential/billing" thay cho "no text". Nên thêm một test dùng fake SDK phát ra assistant message lỗi.

## 3. Cấu hình chạy được với các key hiện có

Đã chạy thử `completeSimple` với prompt "2+3=?":

| provider / model | Kết quả | Chi phí |
|---|---|---|
| `openrouter` / `deepseek/deepseek-v4-flash` | `"5"`, 1047 ms | ~0,0000013 USD |
| `google` / `gemini-3.5-flash-lite` | `"5"`, 1639 ms | ~0,0000055 USD |
| `google` / `gemini-3.5-flash` | `"5"`, 1619 ms | ~0,000024 USD |
| `google` / `gemini-2.5-flash-lite` | 404 "no longer available to new users" | 0 |
| `deepseek` / `deepseek-v4-flash` | 402 Insufficient Balance | 0 |

Lựa chọn gần với ý định ban đầu nhất là `CC_MODEL_PROVIDER=openrouter` và `CC_MODEL_ID=deepseek/deepseek-v4-flash`
(dùng `OPENROUTER_API_KEY`). Cũng có thể chọn model đó trong Settings (`POST /model`); lựa chọn này áp dụng cho
session mới mà không cần khởi động lại. Cách còn lại là nạp tiền vào tài khoản DeepSeek.
`TYPESAFE_API_KEY` không phải key provider của Pi: nó chỉ dùng cho selector Jev (`apps/runtime/src/jev-selector.ts:146`).

## 4. Transcript

Như đã nêu ở trên, file `.data/sessions/2026-09-26T05-29-51-338Z_01a0dc30-f5e9-734d-a516-f22da0ce2e5a.jsonl` chứa lỗi gốc 402.

## Giả thuyết đã loại

- Thiếu credential DeepSeek: loại, vì auth status là `stored` và provider đã trả 402 chứ không phải 401.
- Model id không tồn tại: loại, vì có trong catalogue và `#resolveModel` không ném lỗi.
- Hết thời gian hoặc retry làm kéo dài lượt chạy: loại, vì lỗi đến sau khoảng 1 giây và 402 không thuộc nhóm lỗi được retry.

## Quan sát phụ (chưa chứng minh nguyên nhân)

- Khoảng 26,5 giây trước khi tạo session là độ trễ "cold start". Session nạp extension và package từ
  `~/.pi/agent` toàn cục của người dùng (`real.ts:367-369` dùng `sdk.getAgentDir()`), trong đó có `agentkit-*`,
  `pi-mcp-adapter` và `pi-subagents`. `custom_message agentkit-hook` trong transcript cho thấy các extension này đã
  chạy trong session của ClarkCant. Cần đo riêng.

## Câu hỏi còn mở

- Key trong `auth.json` và `DEEPSEEK_API_KEY` trong env có cùng một tài khoản DeepSeek không? (Cả hai đều trả 402.)
- Việc ClarkCant nạp credential, extension và retry settings từ `~/.pi/agent` của cá nhân có phải chủ ý không?
- Nguyên nhân chính xác của 26,5 giây trước khi tạo session.

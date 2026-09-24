# ADR-002 — Gemini 3.8 Flash TTS làm provider seam cho speech ngoài live session

**Status:** accepted · **Date:** 2026-09-24 · **Liên quan:** [ADR-001](adr-001-gemini-live-provider.md)

## Bối cảnh

ADR-001 chốt Gemini Live cho hội thoại thoại thời gian thực: browser mở một phiên live, nói và
nghe qua cùng một socket, và `GeminiLiveAdapter.speak(text)` đọc lại một câu trả lời bằng cách gửi
văn bản vào phiên live đang mở. Đó là toàn bộ đường phát-thoại hiện có trong repo này; không có
đường "đọc văn bản thành audio" nào không phụ thuộc một phiên live đang chạy.

Google phát hành hai model TTS GA mới, `gemini-3.8-flash-tts` (độ trung thực cao, 130 ngôn ngữ,
voice design/replication) và `gemini-3.8-flash-lite-tts` (nhanh/rẻ, 101 ngôn ngữ, kế nhiệm chính
thức của `gemini-3.1-flash-tts-preview`), qua **Interactions API**
(`POST /v1beta/interactions`) — không phải `generateContent`. Đây là một lời gọi request/response
trả về một clip hoàn chỉnh, khác hẳn hình dạng phiên hai chiều của Gemini Live.

## Quyết định

Thêm `GeminiTtsClient` (`packages/voice-adapters/src/gemini-tts.ts`) như một provider seam độc
lập, **không** implement `VoiceProviderAdapter`. Ép một lời gọi request/response vào một interface
mô tả phiên sống (`connect`/`sendAudio`/trạng thái liên tục) sẽ buộc phải giả `connect`/`disconnect`
quanh một lời gọi HTTP, hoặc để phần lớn adapter throw — cả hai đều là một "phiên" nói dối về bản
chất của nó.

`gemini-3.8-flash-lite-tts` là default (`DEFAULT_TTS_MODEL`); `gemini-3.8-flash-tts` là lựa chọn độ
trung thực cao mà caller chọn tường minh bằng cách truyền `GEMINI_TTS_FLASH_MODEL`. Client parse
response bằng cách duyệt đệ quy toàn bộ cây JSON và lấy audio block cuối cùng, đúng như spec ghi:
audio content nằm lồng trong `steps`/`outputs` và có thể xuất hiện nhiều lần trong một response.

## Vì sao chưa có UI

`AGENTS.md` cấm thêm một control "trông như dùng được" trước khi hành động thật của nó tồn tại.
Hiện tại không có đường sản phẩm nào gọi text-to-speech ngoài live session — Clark nói bằng cách
gửi văn bản vào phiên Gemini Live đang mở, không phải bằng một lời gọi synthesis riêng. Thêm một
dòng chọn "TTS voice" vào Devices & Voice hôm nay sẽ là một control không có gì đứng sau nó.

Vì vậy phần này dừng ở provider module cộng test, đúng theo "nếu không có điểm tích hợp UI hợp lý,
implement module tối thiểu cộng test cộng docs note thay vì bịa UI". Khi có một caller thật — ví dụ
đọc một câu trả lời trong lúc không có phiên live nào mở — `GeminiTtsClient` là seam nó gọi vào, và
`packages/voice-adapters/test/gemini-tts.spec.ts` là bằng chứng rằng seam đó hoạt động đúng với
Interactions API trước khi có bất kỳ UI nào phụ thuộc vào nó.

## Hệ quả

**Giữ nguyên:** `VoiceProviderAdapter`, `GeminiLiveAdapter` và toàn bộ đường live không đổi.

**Thêm:**

- `packages/voice-adapters/src/gemini-tts.ts` — `GeminiTtsClient`, hằng số model
  (`GEMINI_TTS_FLASH_MODEL`, `GEMINI_TTS_FLASH_LITE_MODEL`, `DEFAULT_TTS_MODEL`), export từ
  `packages/voice-adapters/src/index.ts`.
- Credential được truyền vào `synthesize(apiKey, request)` tại thời điểm gọi, không giữ trong field
  — cùng lý do `tokenProvider` của `VoiceProviderAdapter.connect` được thiết kế theo cách đó.

**Chưa làm, có chủ đích:** không có settings row, không có fixture provider mới trong
`apps/runtime/src/test-support`, không có endpoint gateway mới. Tất cả ba thứ đó đòi một caller
thật quyết định trước, và quyết định đó chưa tồn tại.

## Bằng chứng

`packages/voice-adapters/test/gemini-tts.spec.ts` — 10 test: model mặc định, chọn model/voice/style,
key không lọt vào request body, lấy đúng audio block cuối khi response có nhiều block, từ chối
input rỗng/rate không hỗ trợ mà không gọi mạng, và báo lỗi HTTP/response-không-audio thay vì trả về
bytes rỗng.

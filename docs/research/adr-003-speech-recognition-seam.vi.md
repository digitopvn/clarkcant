# ADR-003 — Nhận dạng giọng nói là một seam riêng, và transcript được chuẩn hóa một cách tất định

**Trạng thái:** accepted · **Ngày:** 2026-10-06 · **Liên quan:** [ADR-001](adr-001-gemini-live-provider.md), [ADR-002](adr-002-gemini-tts-flash.md), issue #468 · Bản tiếng Anh (chuẩn): [adr-003-speech-recognition-seam.md](adr-003-speech-recognition-seam.md)

## Bối cảnh

Lời người dùng chỉ tới được runtime như một hệ quả phụ của phiên hội thoại live: Gemini Live tự chép lại audio nó
nghe, và bản chép đó là nguồn duy nhất. Một model hội thoại không được tinh chỉnh cho câu tiếng Việt chứa định danh
tiếng Anh. Thực tế, "sửa lỗi stale closure trong useEffect" tới nơi thành "stale closer trong use effect". "pnpm"
thành "p n p m". Symbol bị tách thành chữ rời, và mất chữ hoa. Agent khi đó trả lời một câu mà người dùng không hề
nói.

ADR-001 cấm âm thầm biến speech-to-text cộng text-to-speech thành một cuộc hội thoại live. ADR này không làm điều đó:
phiên live vẫn là giọng nói. Điều thay đổi là lời người dùng đến từ đâu, và được xử lý thế nào trước khi mang nghĩa.

## Quyết định

1. **Hai seam bên cạnh seam live.**
   - `SpeechRecognitionAdapter` (`packages/voice-adapters/src/recognition.ts`) bao gồm start, PCM16 streaming,
     utterance interim và final, cập nhật context, cùng metadata ngôn ngữ và confidence theo span. Metadata đó chỉ có
     khi provider thật sự trả về, và không bao giờ được bịa ra.
   - `SpeechSynthesisAdapter` là seam request/response cho giọng nói ngoài phiên live; client của ADR-002 là
     implementation đầu tiên.
   - Các contract (`RecognitionContext`, `RecognizedUtterance`, `SpeechRecognitionCapabilities`,
     `RecognitionProvenance`) nằm ở `packages/contracts/src/voice.ts`.
2. **Một recognizer chuyên dụng, phải bật chủ động.**
   - `GeminiTranscribeLiveAdapter` implement seam này theo model transcription Live đã được tài liệu hóa,
     `gemini-3.5-transcribe-live`
     ([tài liệu](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe), kiểm tra ngày 2026-10-06):
     - `inputAudioTranscription` ở chế độ `VERBATIM`, kèm `customVocabulary`;
     - `languageCodes` để trống, để provider tự phát hiện việc chuyển ngôn ngữ;
     - `interimInputTranscription` là giả thuyết thay thế, `inputTranscription` là bản final;
     - `audioStreamEnd` để chốt.
   - Credential là key phía node mà phiên live đang dùng, đi trong URL kết nối, không bao giờ nằm trong thân message.
   - Bật theo node bằng `CC_VOICE_RECOGNIZER=gemini-transcribe`. Khi đã bật:
     - audio đi tới cả hai;
     - Live vẫn nói và vẫn nghe barge-in;
     - interim của recognizer được hiển thị, và chỉ bản final đã chốt mới được dispatch.
   - Recognizer không mở được, hoặc hỏng giữa phiên, sẽ trả câu đang nói dở lại cho transcription của phiên live.
3. **Một vocabulary phiên có giới hạn, được xếp hạng và đã redact.**
   - Vocabulary được dựng trên node từ:
     - các project;
     - manifest và branch đang dùng;
     - symbol, path và issue được nhắc trong hội thoại;
     - skill, extension, cùng model và provider hiện tại;
     - một glossary lập trình có sẵn, với các lỗi nghe sai đã biết làm alias.
   - Mọi term đi qua `redactSecrets` dùng chung, và bị loại nếu redaction chạm vào nó. Không có bộ pattern secret thứ
     hai nào.
   - Văn bản hội thoại chỉ dùng để xếp hạng term và không bao giờ rời khỏi node.
   - Adapter của từng provider dịch vocabulary sang field riêng của mình. Gemini chỉ nhận cách viết chuẩn, vì kéo
     recognizer về phía một lỗi nghe sai đã biết thì đi ngược mục đích.
4. **Một normaliser tất định, không phải model.**
   - Các quy tắc là casing, khoảng cách, alias và near-match cách một lỗi. Mỗi quy tắc cần bằng chứng: câu có tiếng
     Việt, hoặc có một mốc kỹ thuật nằm ngoài đoạn được sửa.
   - Casing không bao giờ hạ chữ hoa.
   - Lệnh không bao giờ bị đổi, ngoại trừ casing.
   - Một đoạn có thể là hai term thì được giữ nguyên như đã nghe, và việc abstain được ghi lại.
   - Mỗi thay đổi được ghi thành provenance có giới hạn.
5. **Chốt một lần, và chỉ thử lại khi có chủ đích.**
   - Một utterance final được chốt trên một hàng đợi có thứ tự và dispatch một lần cho mỗi utterance id, qua cùng
     đường `ask` mà transcript live đi. Vì vậy phê duyệt, câu hỏi, app intent và widget action đều thấy văn bản chuẩn.
   - Một đoạn kỹ thuật mơ hồ hoặc có confidence thấp có thể được nhận dạng lại riêng utterance đó từ bộ đệm audio có
     giới hạn của chính nó, với context tập trung vào các ứng viên.
   - Hai cách đọc được so sánh theo một quy tắc cố định. Bản gốc thắng khi hòa, và cũng thắng khi lần thử lại nghe
     thành một câu khác.
   - Lần thử lại bị giới hạn thời gian. Không transcript nào được gửi tới Jev; Jev chọn giữa các phương án có giới hạn,
     không phải bộ viết lại transcript.

## Vì sao recognizer chuyên dụng chưa là mặc định

Recognizer nào nghe giọng nói lập trình Việt–Anh tốt nhất là câu hỏi thực nghiệm. Môi trường này không trả lời được
nếu không có audio và key, nên benchmark harness tồn tại để trả lời nó. Cho tới khi một lượt chạy audio nói khác,
mặc định vẫn là đường đã hoạt động. Normaliser cũng cải thiện đường đó: trên corpus văn bản bên dưới, baseline live
nhận phần lớn những gì chuẩn hóa có thể mang lại. Một bộ chọn provider trong giao diện sẽ bắt người dùng đưa ra một
quyết định họ không thể đánh giá, nên không có bộ chọn nào.

## Bằng chứng

`corepack pnpm --filter @clarkcant/voice-adapters bench:transcription` chạy bộ chấm điểm trên
`packages/voice-adapters/bench/vi-en-coding-corpus.json`. Corpus có 68 utterance (tiếng Việt chuyển sang tiếng Anh, và
tiếng Anh có ngữ cảnh tiếng Việt) và 94 thuật ngữ kỹ thuật. Đầu ra recognizer trong đó là giả lập: các lỗi
transcription live điển hình được viết tay, không phải bản ghi âm.

| Giai đoạn | WER | CER | Tỷ lệ lỗi thuật ngữ kỹ thuật | Utterance khớp hoàn toàn | Thay đổi | Abstain | Hồi quy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| thô | 27.2% | 4.5% | 80.9% | 16.2% | - | - | - |
| đã chuẩn hóa | 4.5% | 1.0% | 16.0% | 75.0% | 62 | 1 | 0 |

Lệnh và phiên bản không bao giờ tệ hơn sau chuẩn hóa (9/11 và 2/2 ở cả trước lẫn sau); symbol từ 0/19 lên 15/19, path
từ 0/6 lên 5/6, từ viết tắt từ 0/9 lên 9/9. Phần còn sót là có chủ đích:

- `git stash` bị nghe thành `git status` không được sửa, vì lệnh không bao giờ bị đoán;
- số issue không bị viết lại;
- tên ngoài vocabulary được giữ nguyên;
- văn xuôi tiếng Anh không có mốc kỹ thuật được giữ nguyên;
- đoạn mơ hồ `voiceSession` / `voice_session` được abstain.

Cùng lệnh đó với `--audio <manifest> --recognizer gemini-transcribe-live|gemini-live` nhận dạng bản ghi âm thật, chấm
điểm chúng bên cạnh corpus, và báo độ trễ chốt câu. Lượt chạy đó cần `GEMINI_API_KEY`, và dừng với thông báo
"external gate" nếu không có key.

## Hệ quả

**Giữ nguyên:**

- `VoiceProviderAdapter`, `GeminiLiveAdapter` và đường live mặc định;
- wire tới browser: interim là frame `transcript` của user thông thường chưa final, còn câu chuẩn là một frame final;
- mute, end và media focus, giờ tới được cả recognizer.

**External gate:**

- kiểm chứng live `gemini-3.5-transcribe-live` với audio thật;
- so sánh provider ở mức audio.

**Việc tiếp theo:** thêm recognizer khác (ví dụ Soniox hay Deepgram, hoặc một recognizer chạy cục bộ) chỉ là thêm một
adapter và một mục trong benchmark CLI cho mỗi cái.

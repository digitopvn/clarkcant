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
   - Một câu bị giới hạn phiên mười phút của provider cắt đôi vẫn là một utterance: cách đọc của phiên mở lại được nối
     vào những gì phiên đã đóng nghe được, và audio nói trong lúc mở lại được giữ rồi gửi tiếp. Nếu phiên kết thúc
     đúng lúc câu kết thúc và ngay sau đó không ai nói thêm, các từ được mang sang là cả câu, không phải phần đầu của
     câu kế tiếp.
   - Recognizer không mở được trong một khoảng thời gian có giới hạn, hoặc hỏng giữa phiên, sẽ trả phần nó chưa gửi lại
     cho transcription của phiên live. Cách đọc live được giữ đúng như phiên live cắt câu, không bao giờ tách ở chỗ
     ngừng, và một con trỏ đánh dấu recognizer đã gửi tới đâu: một bản final dời con trỏ khi các từ của nó, đúng thứ
     tự và chỉ lệch vài ký tự, là phần đầu của những gì cách đọc live có tiếp theo, nên một bản final có thể chỉ phủ phần
     đầu của một utterance live. Bản final ngắn hơn ba từ không bao giờ dời con trỏ, và bản final mà cách đọc live của
     nó không tới sớm sẽ hết hạn. Khi việc đối chiếu không rõ, mọi câu live sau câu cuối cùng đã được phủ trọn đều
     được trả lời, nguyên câu và theo thứ tự, nên một câu bị phiên live tách thành hai utterance không bị mất. Mọi quy
     tắc đều ưu tiên trả lời một số từ hai lần hơn là làm mất chúng.
3. **Một vocabulary phiên có giới hạn, được xếp hạng và đã redact.**
   - Vocabulary được dựng trên node từ:
     - các project;
     - manifest và branch đang dùng;
     - symbol, path và issue được nhắc trong hội thoại;
     - skill, extension, cùng model và provider hiện tại;
     - một glossary lập trình có sẵn, với các lỗi nghe sai đã biết làm alias.
   - Mọi term đi qua `redactSecrets` dùng chung, và bị loại nếu redaction chạm vào nó. Không có bộ pattern secret thứ
     hai nào.
   - Khi recognizer chuyên dụng được bật, các term - kể cả định danh, path, tên branch và số issue trích từ hội thoại -
     được gửi tới nó làm vocabulary. Các câu trong hội thoại chỉ dùng để xếp hạng term và không bao giờ rời khỏi node.
   - Adapter của từng provider dịch vocabulary sang field riêng của mình. Gemini chỉ nhận cách viết chuẩn, vì kéo
     recognizer về phía một lỗi nghe sai đã biết thì đi ngược mục đích.
4. **Một normaliser tất định, không phải model.**
   - Các quy tắc là casing, khoảng cách, alias và near-match cách một lỗi. Mỗi quy tắc cần bằng chứng: câu có tiếng
     Việt, hoặc có một mốc kỹ thuật nằm ngoài đoạn được sửa.
   - Near-match chỉ sửa một lỗi nói nhầm ở một từ của tên glossary, provider hoặc model. Nó không bao giờ chạm tới
     symbol, path, branch hay package, vốn có hàng xóm cách một lỗi là những tên thật khác (`setUser` và `getUser`),
     không bao giờ chạm tới một từ có chữ số ("claude opus 3" là một phiên bản khác, không phải lỗi nói nhầm của
     `claude-opus-4`), và không áp dụng cho văn bản đã được viết dạng code.
   - Một phần của một từ viết dài hơn (`live` trong `gemini-live.tsx`) không bao giờ bị động tới, và dấu câu mà một
     cách viết đã mang sẵn không bị viết hai lần.
   - Một từ thật hoặc tên người không bao giờ là alias: "Jeff" vẫn là "Jeff".
   - Casing không bao giờ hạ chữ hoa.
   - Lệnh không bao giờ bị đổi, ngoại trừ casing, và không từ nào được viết lại để ghép với các từ bên cạnh thành một
     lệnh ("git re base" được giữ nguyên như đã nghe).
   - Một đoạn có thể là hai term thì được giữ nguyên như đã nghe, và việc abstain được ghi lại.
   - Một câu đã chuẩn được trả lại đúng như cũ. Benchmark kiểm tra điều này trên mọi câu tham chiếu, kể cả các mục âm
     dựng từ tên hàng xóm gần, tên nằm trong từ dài hơn, tên người và các phiên bản model khác.
   - Mỗi thay đổi được ghi thành provenance có giới hạn.
5. **Chốt một lần, và chỉ thử lại khi có chủ đích.**
   - Một utterance final được chốt trên một hàng đợi có thứ tự và dispatch một lần cho mỗi utterance id, qua cùng
     đường `ask` mà transcript live đi. Vì vậy phê duyệt, câu hỏi, app intent và widget action đều thấy văn bản chuẩn.
   - Một đoạn kỹ thuật mơ hồ hoặc có confidence thấp có thể được nhận dạng lại riêng utterance đó từ bộ đệm audio có
     giới hạn của chính nó, với context tập trung vào các ứng viên.
   - Hai cách đọc được so sánh theo một quy tắc cố định. Bản gốc thắng khi hòa, và cũng thắng khi lần thử lại nghe
     thành một câu khác.
   - Lần thử lại bị giới hạn thời gian, và lần thử lại vượt quá giới hạn sẽ bị hủy, đóng luôn phiên nó đã mở. Không transcript nào được gửi tới Jev; Jev chọn giữa các phương án có giới hạn,
     không phải bộ viết lại transcript.

## Vì sao recognizer chuyên dụng chưa là mặc định

Recognizer nào nghe giọng nói lập trình Việt–Anh tốt nhất là câu hỏi thực nghiệm. Môi trường này không trả lời được
nếu không có audio và key, nên benchmark harness tồn tại để trả lời nó. Cho tới khi một lượt chạy audio nói khác,
mặc định vẫn là đường đã hoạt động. Normaliser cũng cải thiện đường đó: trên corpus văn bản bên dưới, baseline live
nhận phần lớn những gì chuẩn hóa có thể mang lại. Một bộ chọn provider trong giao diện sẽ bắt người dùng đưa ra một
quyết định họ không thể đánh giá, nên không có bộ chọn nào.

## Bằng chứng

`corepack pnpm --filter @clarkcant/voice-adapters bench:transcription` chạy bộ chấm điểm trên
`packages/voice-adapters/bench/vi-en-coding-corpus.json`. Corpus có 76 utterance (tiếng Việt chuyển sang tiếng Anh, và
tiếng Anh có ngữ cảnh tiếng Việt, gồm tám mục âm phải được trả lại nguyên vẹn) và 100 thuật ngữ kỹ thuật. Đầu ra
recognizer trong đó là giả lập: các lỗi transcription live điển hình được viết tay, không phải bản ghi âm. Normaliser
không đổi câu tham chiếu chuẩn nào.

| Giai đoạn | WER | CER | Tỷ lệ lỗi thuật ngữ kỹ thuật | Utterance khớp hoàn toàn | Thay đổi | Abstain | Hồi quy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| thô | 24.9% | 4.2% | 77.0% | 23.7% | - | - | - |
| đã chuẩn hóa | 4.0% | 0.9% | 16.0% | 76.3% | 61 | 1 | 0 |

Lệnh và phiên bản không bao giờ tệ hơn sau chuẩn hóa (9/12 và 2/2 ở cả trước lẫn sau); symbol từ 1/20 lên 17/20, path
từ 3/9 lên 8/9, từ viết tắt từ 0/9 lên 9/9. Phần còn sót là có chủ đích:

- `git stash` bị nghe thành `git status` không được sửa, vì lệnh không bao giờ bị đoán;
- "git re base" không được ghép thành `git rebase`, cùng lý do đó;
- "Jeff" không bị viết lại thành Jev, vì đó cũng là tên người;
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
- wire tới browser: interim là frame `transcript` của user thông thường chưa final, còn câu chuẩn là một frame final.
  Phần gộp của trang dùng frame final để chốt dòng đang nói dở, nên một interim và bản sửa của nó là một dòng;
- mute và end, giờ tới được cả recognizer (mute cũng chốt câu trước đó). Media focus không đổi và không liên quan tới
  recognizer.

**Đường mặc định:** normaliser cũng chạy trên transcription live mặc định, với cùng vocabulary phiên. Khi không có
recognizer chuyên dụng, không có gì được gửi tới nơi mới: vocabulary ở lại trên node.

**External gate:**

- kiểm chứng live `gemini-3.5-transcribe-live` với audio thật;
- so sánh provider ở mức audio.

**Việc tiếp theo:** thêm recognizer khác (ví dụ Soniox hay Deepgram, hoặc một recognizer chạy cục bộ) chỉ là thêm một
adapter và một mục trong benchmark CLI cho mỗi cái.

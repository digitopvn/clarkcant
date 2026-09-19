---
phase: 8
title: "Thanh voice tối giản, intent cửa sổ và phiên sống qua hai chiều"
status: done
priority: P1
effort: "5h"
dependencies: [5, 7]
---

# Phase 8: Thanh voice tối giản, intent cửa sổ và phiên sống qua hai chiều

## Context Links

- Issue #17 §2: "Ở dạng minimal: chỉ còn icon voice bar (trạng thái listening/thinking/speaking) và icon expand; kéo được để di chuyển" và "Thu nhỏ không được làm mất voice session, không được nhả mic/speaker ngầm"
- `packages/conversation-client/src/VoiceOverlay.tsx` — start/mute/end; `data-voice-*` attribute
- `packages/conversation-client/src/voice-session.ts` — state machine của phiên ở client
- `packages/contracts/src/voice.ts` — `voiceStateSchema`, `mediaFocusStateSchema`, `releaseMediaFocus`
- `playwright.config.ts:33` — suite chỉ chạy browser; **không** có `window.clarkcant` trong browser
- Phase 5 (`runAppIntent` + intent `window.*`), Phase 7 (`setCompactMode`, `MINIMAL_BAR`)

## Ranh giới harness (đọc trước khi viết test)

Thanh tối giản chỉ hiện khi `compact`, và `compact` chỉ đến từ bridge desktop. Suite Playwright chạy
**browser**, nơi không có bridge. Vì vậy:

- **Hành vi của thanh** (ba trạng thái, mute/end còn bấm được, phiên sống qua đổi chỗ render) chứng minh
  bằng suite browser qua hook test-only `?cc-compact=1`.
- **Chuyển đổi cửa sổ thật** (bounds, sàn 20×50, expand khôi phục, always-on-top) chứng minh bằng smoke
  Electron ở Phase 7, đọc state thật của Electron.
- Không test nào được giả vờ làm việc của harness kia.

## Files to Create / Modify

- Create: `packages/conversation-client/src/use-voice-session.ts` (state phiên nằm **trên** cả hai chỗ render)
- Create: `packages/conversation-client/src/voice-bar.tsx`
- Create: `packages/conversation-client/test/voice-bar.spec.ts`
- Modify: `packages/conversation-client/src/VoiceOverlay.tsx` (dùng hook; nút "Thu nhỏ")
- Modify: `packages/conversation-client/src/Conversation.tsx` (chọn overlay/bar; đọc `?cc-compact=1`)
- Modify: `packages/conversation-client/src/app-intents.ts` (host hiện thực `window.*` qua bridge)
- Modify: `packages/conversation-client/src/voice-session.ts` (mute/end dùng chung với thanh)
- Modify: `packages/conversation-client/src/styles.ts`
- Create: `apps/web/e2e/voice-bar.spec.ts`

## Tests Before (viết trước, phải đỏ)

1. `packages/conversation-client/test/voice-bar.spec.ts` (thuần, không render):
   - `"the bar shows the session's own state"` — map `VoiceState` → nhãn/`data-voice-state`.
   - `"mute in the bar is a local control and does not end the session"`.
   - `"end in the bar releases both microphone and speaker"` — dùng `releaseMediaFocus` từ contracts.
   - `"a compact request without the bridge does not put the client into compact"`.
   - `"the bar's size matches the constant the shell uses"` — đọc `data-minimal-bar` do shell render.
2. `apps/web/e2e/voice-bar.spec.ts`:
   - `"the compact view keeps mute and end reachable"` — hai nút có `aria-label`, không `display:none`.
   - `"the voice session survives the switch to the compact view"` — `data-voice-audio-frames` tiếp tục
     tăng **sau** khi chuyển sang `?cc-compact=1` (nghĩa là stream chưa bị nhả).
   - `"ending the session in the compact view releases the microphone"` — `data-voice-state="ended"` và
     `data-voice-mic="released"`.
   - `"leaving the compact view returns to the full overlay with the same session"` — cùng
     `data-voice-session-id` trước và sau.
   - `"a window intent in a browser is refused honestly"` — `window.minimal` không có bridge → thông báo
     rõ, không im lặng, không đổi gì.

## Tasks & Steps

### Task 8.1 — Tách `useVoiceSession`

- **Goal**: đổi chỗ render không unmount phiên, nên mic không bị nhả ngầm.
- **Target files and symbols**: `packages/conversation-client/src/use-voice-session.ts` —
  `useVoiceSession(options): { state, sessionId, muted, audioFrames, start, mute, end, focus }`.
- **Steps**:
  1. Chuyển state phiên (MediaStream, audio element, WebSocket, counters) từ `VoiceOverlay.tsx` sang hook.
  2. `Conversation.tsx` gọi hook **một lần** ở component cha và truyền xuống `VoiceOverlay` **hoặc**
     `VoiceBar`. Ẩn overlay không được gọi `end`/`stream.stop()`.
  3. `end` gọi `releaseMediaFocus` cho microphone + speaker, đặt `data-voice-mic="released"`.
  4. **Regression gate của phase này**: chạy `apps/web/e2e/voice.spec.ts` (suite voice hiện có) — nó
     phải vẫn xanh. Nếu đỏ, phase chưa xong.
- **Success criteria**: `pnpm test:e2e -- apps/web/e2e/voice.spec.ts` xanh.
- **Verify**: `pnpm test:e2e -- apps/web/e2e/voice.spec.ts` exits 0.

### Task 8.2 — Thanh voice tối giản

- **Goal**: thanh chỉ còn icon trạng thái, expand, mute, end; kéo được.
- **Target files and symbols**: `packages/conversation-client/src/voice-bar.tsx` —
  `VoiceBar(props: { state; muted; audioFrames; onExpand(); onMute(); onEnd() })`.
- **Steps**:
  1. Icon trạng thái đổi theo `state` (listening/thinking/speaking/idle/ended/failed); không dùng thư
     viện icon.
  2. `data-voice-bar="true"`, `data-voice-state`, `data-voice-mic`, `data-voice-session-id`.
  3. Bốn nút với `aria-label`: "Mở rộng", "Tắt tiếng", "Kết thúc", và vùng kéo `-webkit-app-region: drag`.
  4. Thanh không tự đo: nó render trong khung `MINIMAL_BAR` mà shell đặt; shell render
     `data-minimal-bar="<w>x<h>"` để test so được hai bên.
- **Success criteria**: 4 test helper xanh; journey 1 xanh.
- **Verify**: `pnpm exec vitest run packages/conversation-client/test/voice-bar.spec.ts` exits 0.

### Task 8.3 — Hook test-only `?cc-compact=1`

- **Goal**: suite browser chạm được thanh tối giản mà không giả vờ có shell.
- **Target files and symbols**: `packages/conversation-client/src/Conversation.tsx` (đọc query param),
  ghi rõ trong comment đây là đường **chỉ để test**.
- **Steps**:
  1. `?cc-compact=1` → state trình bày bắt đầu ở compact; `?cc-compact=0`/không có → như cũ.
  2. Không gọi bridge, không đổi cửa sổ: nó **chỉ** đổi cách render, nên nó không thể che một lỗi
     chuyển đổi cửa sổ.
  3. Ghi trong spec một dòng: chuyển đổi cửa sổ thật do smoke Phase 7 chứng minh, không phải test này.
- **Success criteria**: journey 2, 4 xanh và **đỏ** nếu `useVoiceSession` bị gỡ (stream bị nhả khi đổi chỗ render).
- **Verify**: `pnpm test:e2e -- apps/web/e2e/voice-bar.spec.ts` exits 0.

### Task 8.4 — Intent cửa sổ đi qua bridge

- **Goal**: "kết thúc voice / expand / thu nhỏ / thu nhỏ tối thiểu" điều khiển được cửa sổ thật.
- **Target files and symbols**: `packages/conversation-client/src/app-intents.ts` (`AppIntentHost`
  hiện thực `minimiseWindow`, `setMinimal`, `quit` qua `desktop-compact.ts`).
- **Steps**:
  1. `window.minimal` → `setCompactMode({ compact: true })`; `window.expand` → `{ compact: false }`;
     `window.minimise` → bridge trả `{ ok: false, reason: "not-supported-yet" }` **hoặc** thêm
     `desktop:minimise` — chọn cách thứ hai nếu rẻ, và nếu không thì nói rõ lý do trong comment.
  2. `voice.end` → `host.endVoice()`; nếu không có phiên nào thì trả lời rằng chưa có phiên nào đang chạy.
  3. Mọi kết quả `{ ok: false }` phải thành một câu người dùng đọc được, không im lặng.
- **Success criteria**: journey 5 xanh; nhóm lệnh cửa sổ trong `voice-control.spec.ts` (Phase 5) trả lời
  trung thực trong browser và thật trong desktop.
- **Verify**: `pnpm test:e2e -- apps/web/e2e/voice-bar.spec.ts apps/web/e2e/voice-control.spec.ts` exits 0.

### Task 8.5 — Evidence

- **Goal**: ảnh chứng minh thanh tối giản.
- **Target files and symbols**: `apps/web/e2e/voice-bar.spec.ts` → `plans/reports/evidence/voice-bar-dark.png`.
- **Steps**:
  1. Chụp ở trạng thái `listening` để thấy icon trạng thái thật.
  2. Ghi vào report Stage B rằng ảnh này là **render trong browser**; kích thước cửa sổ thật là evidence
     JSON của smoke.
- **Success criteria**: file tồn tại; report Stage B nêu đúng giới hạn.
- **Verify**: `ls plans/reports/evidence/voice-bar-*.png` không lỗi.

## Refactor

Nếu `Conversation.tsx` phình vì chọn overlay/bar, tách `packages/conversation-client/src/voice-layer.tsx`
nhận `session` + `compact`. Chạy lại **cùng** test, gồm `voice.spec.ts`.

## Tests After

`"a spoken 'thu nhỏ tối thiểu' puts the window into the minimal bar"` (ghi nhận là **BLOCKED trong CI**;
chạy trong smoke/live check và ghi lại cách chạy).

## Regression gate

```bash
pnpm verify && pnpm test:e2e
```

## Failure Protocol

Nếu bất kỳ bước Verify nào không đạt đúng điều kiện đã ghi, DỪNG phase này.
Không tự sửa kiểu đoán, không retry mù, không suy luận vòng qua thất bại.
Gọi subagent `kongming` để xin chỉ dẫn bước kế tiếp và truyền:
- phase và task id,
- những gì đã làm (các bước đã chạy),
- đúng lệnh đã chạy và toàn bộ output,
- điều kiện pass mà nó không đạt.
Áp dụng chỉ dẫn của kongming rồi chạy lại bước Verify.
Nếu không gọi được `kongming` trong môi trường này, DỪNG và báo lại đúng bằng chứng thất bại cho
người dùng. Không bao giờ tiếp tục bằng cách tự suy luận.

## Risk Assessment

- **Rủi ro**: tách `useVoiceSession` làm hỏng suite voice hiện có. **Giảm thiểu**: chạy
  `apps/web/e2e/voice.spec.ts` như regression gate của Task 8.1, trước mọi việc khác.
- **Rủi ro**: ẩn overlay làm React đóng `MediaStream`. **Giảm thiểu**: stream nằm trong hook ở component
  cha; journey 2 khẳng định `data-voice-audio-frames` vẫn tăng sau khi chuyển.
- **Rủi ro**: hook test-only `?cc-compact=1` bị hiểu là tính năng. **Giảm thiểu**: comment nêu rõ, và
  tài liệu Phase 12 ghi nó là đường test.
- **Rủi ro**: kích thước thanh lệch với hằng số của shell. **Giảm thiểu**: shell render
  `data-minimal-bar`, test so hai bên thay vì so với một bản sao trong test.

## Security Considerations

- Mic vẫn do host local kiểm soát qua `MediaFocusService`; không thêm quyền OS.
- Thanh chỉ đọc state của phiên; không gửi trạng thái UI lên provider.
- `voice.end` local, không phụ thuộc remote node hay model.

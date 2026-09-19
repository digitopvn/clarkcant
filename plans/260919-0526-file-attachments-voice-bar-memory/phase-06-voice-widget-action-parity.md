---
phase: 6
title: "T66 — voice và click chạm cùng một widget action state"
status: done
priority: P1
effort: "4h"
dependencies: [5]
---

# Phase 6: T66 — voice và click chạm cùng một widget action state

> **Tiêu chí của phase này ĐÃ ĐẠT.** T66 chuyển `NOT-IMPLEMENTED` → `PASS` với tên test
> `apps/web/e2e/voice-widget-action.spec.ts` — "a spoken action and the same click reach the same state", và journey
> từ chối đi kèm; cả hai xanh và nằm trong suite.
>
> Nguyên nhân đã đo được, và ghi chú cũ trong file spec đoán sai: câu nói **có** được resolve và action **có**
> chạy — node báo `ok`, revision 7 → 8, "Đã Đổi khoảng thời gian" — nhưng trang **không có** handler cho frame
> `widget-action-result`, nên surface vẫn hiển thị period cũ. Câu nói còn phải mang tham số: action này nhận một
> period, và một câu chỉ nêu tên action thì không chọn được period nào.

## Context Links

- Issue #17 §3: "T66 ('Voice and click reach the same widget action state') phải chuyển từ
  NOT-IMPLEMENTED sang PASS kèm tên test."
- `docs/conformance-traceability.md:85` — T66 đang `NOT-IMPLEMENTED`
- `docs/implementation-plan.md:281` — định nghĩa T66
- `packages/contracts/src/voice.ts` — `voiceIntentSchema` có `kind: "widget-action"` với `actionProposal`
  và `focusedSurface`; `routeVoiceIntent` trả `{ effect: "widget-invocation" }`
- `packages/contracts/src/widgets.ts` — `actionProposalSchema`, `semanticViewSchema`
- `apps/runtime/src/gateway.ts:1170` — route `/conversations/:id/widgets/:instanceId/actions`
- `apps/runtime/test/mini-app-actions.spec.ts` — hành vi action đã có test; T43 (double click = một effect)
- `packages/core/src/widget-service.ts:890-894` — nơi semantic view liệt kê action khả dụng

## Goal

Một hành động của widget chạy được bằng **giọng nói** và chạm **đúng** action state mà một cú click
chạm tới: cùng action binding, cùng revision, cùng một bản ghi invocation, và hai lần thử không tạo hai
effect. Sau phase này T66 được nâng thành `PASS` kèm tên test thật.

## Vì sao không mượn T66 cho test panel Settings

T66 nói về **widget action state**. Phase 5 có một test chứng minh trạng thái panel Settings giống nhau
giữa voice và click, nhưng đó là màn hình, không phải widget action state. Test đó có T-id riêng (T73);
T66 chỉ được nâng ở phase này và chỉ bằng một test chạy qua action binding của một widget thật.

## Files to Create / Modify

- Modify: `apps/runtime/src/voice-session.ts` (đường `widget-action` đi qua hàm resolve action dùng chung)
- Create: `apps/runtime/src/widget-voice-action.ts` (resolve utterance → action proposal cho instance đang focus)
- Modify: `apps/runtime/src/gateway.ts` (dùng lại **cùng** hàm invoke action cho cả hai nguồn)
- Modify: `packages/conversation-client/src/voice-session.ts` (gửi semantic view của instance đang focus)
- Create: `apps/runtime/test/widget-voice-action.spec.ts`
- Create: `apps/web/e2e/voice-widget-action.spec.ts`
- Modify: `docs/conformance-traceability.md` (T66 → PASS, kèm tên test)

## Tests Before (viết trước, phải đỏ)

1. `apps/runtime/test/widget-voice-action.spec.ts`:
   - `"a spoken action names an action the focused instance actually offers"` — utterance + semantic view
     → `actionProposal` có `actionId` nằm trong danh sách action khả dụng.
   - `"an utterance naming no offered action is refused rather than guessed"` — không có proposal.
   - `"the same instance and revision go to the same invoke path as a click"` — gọi hàm invoke dùng
     chung với `actionId` lấy từ đường voice và từ đường click; hai kết quả giống nhau ở
     `instanceId`/`revision`/`invocation` shape.
   - `"a spoken action with a stale revision is refused exactly as the click is"` (T43 vẫn giữ).
2. `apps/web/e2e/voice-widget-action.spec.ts`:
   - **`"a spoken command and the same click reach one widget action state"`** — đây là test mang tên T66.
     Trình tự: mở một surface có action `period.change` (đã có fixture trong
     `apps/web/e2e/mini-app.spec.ts`), đọc `data-widget-state` và `data-action-revision`; thực hiện đường
     click → đọc lại state; reset; thực hiện đường voice (fixture voice provider) → khẳng định **cùng**
     giá trị `data-widget-state` và **một** invocation được ghi cho mỗi đường.
   - `"a spoken action that the widget does not offer changes nothing"` — state trước và sau giống nhau,
     và không có invocation mới.

## Tasks & Steps

### Task 6.1 — Resolve utterance thành action proposal

- **Goal**: một chỗ duy nhất biến câu nói thành lời gọi action, giới hạn trong action mà instance đang
  focus thực sự có.
- **Target files and symbols**: `apps/runtime/src/widget-voice-action.ts` —
  `resolveVoiceWidgetAction(input: { utterance: string; focused: SemanticView }): ActionProposal | { refused: string }`.
- **Steps**:
  1. Bảng từ khoá hẹp ánh xạ câu nói → `operation` trong `view` action của instance ('kỳ trước',
     'kỳ sau', 'tháng này', 'chọn ngày <d>'). Không gọi model.
  2. `actionId` **lấy từ** `focused.availableActions`; câu nói không khớp action nào → `{ refused }` với
     câu nói lại. Không đoán, không tự sinh action.
  3. Trả `ActionProposal` đúng schema `actionProposalSchema` (kind `view`), kèm `expectedRevision` lấy
     từ semantic view.
- **Success criteria**: 2 test đầu xanh.
- **Verify**: `pnpm exec vitest run apps/runtime/test/widget-voice-action.spec.ts` exits 0.

### Task 6.2 — Một hàm invoke cho cả hai nguồn

- **Goal**: voice không có đường tắt; nó gọi đúng hàm mà route click gọi.
- **Target files and symbols**: `apps/runtime/src/gateway.ts` — tách thân của route
  `/conversations/:id/widgets/:instanceId/actions` (dòng ~1170) thành
  `invokeWidgetAction(deps, input: { principalId; conversationId; instanceId; actionId; expectedRevision; input })`
  rồi cho **cả** route và đường voice gọi hàm này.
- **Steps**:
  1. Tách hàm, giữ nguyên mọi kiểm tra hiện có (owner, revision, binding, dedup theo invocation id).
  2. Đường voice (`voice-session.ts`) gọi `invokeWidgetAction` với proposal vừa resolve; ghi cùng loại
     `action_invocations`, không thêm loại bản ghi thứ hai.
  3. Trả về client một frame `{ type: "widget-action-result", instanceId, revision, ok, reason? }` để
     client cập nhật state qua **cùng** đường cập nhật mà click dùng.
  4. Test 3 và 4 của file runtime.
- **Success criteria**: hai đường cho cùng shape invocation; test T43 (double click) vẫn xanh.
- **Verify**: `pnpm exec vitest run apps/runtime/test/widget-voice-action.spec.ts apps/runtime/test/mini-app-actions.spec.ts` exits 0.

### Task 6.3 — Client gửi semantic view của instance đang focus

- **Goal**: node biết đang nói về widget nào, nên câu nói không cần tự đoán.
- **Target files and symbols**: `packages/conversation-client/src/voice-session.ts`,
  `packages/conversation-client/src/mini-app-surface.tsx` (nơi có state của instance đang mở).
- **Steps**:
  1. Khi một surface đang mở và là live owner, gửi kèm semantic view của nó trong frame audio/control
     đầu tiên của mỗi lượt nói (đúng khuôn frame hiện có, không mở socket thứ hai).
  2. Không có surface nào đang focus → không gửi view, và node trả lời rằng chưa có widget nào đang mở.
  3. Chỉ gửi id/ nhãn/ action khả dụng; không gửi dữ liệu người dùng hay nội dung surface.
- **Success criteria**: journey 1 xanh.
- **Verify**: `pnpm test:e2e -- apps/web/e2e/voice-widget-action.spec.ts` exits 0.

### Task 6.4 — Nâng T66 kèm tên test

- **Goal**: đổi trạng thái conformance chỉ khi test thật đã xanh.
- **Target files and symbols**: `docs/conformance-traceability.md` (dòng T66).
- **Steps**:
  1. Chạy journey 1 trước; chỉ sau khi xanh mới sửa file.
  2. Evidence của T66:
     `e2e/voice-widget-action.spec.ts: "a spoken command and the same click reach one widget action state" — both paths produce the same data-widget-state and one action invocation each`.
  3. Giữ nguyên ghi chú về WebRTC/provider ở cột V17; phase này không nâng V17.
  4. Chạy `pnpm run invariants` để chắc bảng vẫn hợp lệ.
- **Success criteria**: `pnpm run invariants` xanh; `grep -n "^| T66" docs/conformance-traceability.md` in ra dòng có `PASS`.
- **Verify**: `pnpm run invariants` exits 0.

## Refactor

Nếu `voice-session.ts` phình vì nhánh widget, giữ nhánh đó trong `widget-voice-action.ts` và để
`voice-session.ts` chỉ gọi một hàm. Chạy lại **cùng** test.

## Tests After

`"a spoken action on an instance held by another surface is refused with the holder named"`.

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

- **Rủi ro**: registry câu nói khớp nhầm một câu hỏi bình thường thành hành động widget. **Giảm thiểu**:
  chỉ khớp action mà instance **đang focus** thực sự có, và chỉ trong bảng từ khoá hẹp; không khớp thì
  từ chối.
- **Rủi ro**: đường voice tạo bản ghi invocation thứ hai cho cùng một hành động. **Giảm thiểu**: một hàm
  invoke duy nhất + test đếm một invocation mỗi đường; T43 vẫn phải xanh.
- **Rủi ro**: nâng T66 dựa trên test không thật sự chạy hai đường. **Giảm thiểu**: test phải reset state
  giữa hai đường và so giá trị đọc từ DOM, không so giá trị do test tự tính.

## Security Considerations

- Semantic view chỉ chứa id/nhãn/action khả dụng, không chứa dữ liệu người dùng.
- Voice dùng đúng authorization của click: binding, revision, owner, lease.
- Không có action nào mới được sinh từ câu nói; chỉ những action instance đã công bố.

## Ghi chú thực thi (cập nhật sau khi làm)

T66 vẫn là `NOT-IMPLEMENTED`. Phần cài đặt đã xong ở cả hai phía: node dùng chung `invokeWidgetAction` cho cả
đường click lẫn đường nói, resolver có 10 test đơn vị, khung `focus` chỉ mang một instance id, và phía client có
`VoiceSession.focus`. Hành trình trình duyệt để chứng minh T66 thì chưa có, và lý do đã được thu hẹp bằng đo lường
chứ không phải suy đoán:

- Instance đang được focus có thật trong `.data/e2e/node.sqlite` và mang ba binding id.
- Nhãn của binding bộ lọc là `Đổi khoảng thời gian`; `normaliseIntentText` biến nó thành `doi khoang thoi gian`,
  đúng bằng khoá trong bảng phrasing (đã so từng code point).
- `xem theo tháng` chuẩn hoá thành `xem theo thang`, đúng cặp mà test đơn vị của resolver giải được.
- Câu người dùng nói tới được client: nó xuất hiện như một bubble trong timeline.

Nghĩa là nhãn, câu nói, phép so khớp và đường dây đều đúng. Việc còn lại là tại sao nhánh widget không hành động
theo câu đó trong phiên thoại thật. `[data-intent-notice]` không phải chỗ hiển thị câu trả lời thoại (đọc ở đó
trả về rỗng), nên bước kế tiếp là đọc câu trả lời từ chính overlay.

Một thay đổi đã thử và **hoàn nguyên**: cho fixture chỉ trả lời một lần mỗi phiên (`e350a69`). Nó không làm hành
trình parity xanh, và nó làm hành trình từ chối đỏ, nên việc fixture trả lời lặp lại là có vai trò thật trong luồng
transcript, không phải hiện tượng thừa.

Bốn sai lệch so với kế hoạch cần ghi nhận:

1. Hành động nói dùng revision và binding digest của chính node, không nhận con trỏ từ trang: một câu nói không
   mang theo cursor, còn một cú click thì có.
2. Resolver so khớp theo **nhãn** mà instance đang mời, không theo `actionId`, vì `actionProposal` không có trường
   đó.
3. Khung `focus` chỉ mang instance id; node tự dựng view bằng `semanticViewOf`, nên trang không thể mô tả một
   instance không tồn tại.
4. Không có route nào đọc bảng `action_invocations`, nên yêu cầu "mỗi đường đúng một lần gọi" không thể đếm được
   từ một lần chạy trình duyệt. Hành trình tương lai chỉ khẳng định được trạng thái cuối, và phần đếm được ghi rõ
   là thiếu.

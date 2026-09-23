---
title: "Dev app: ba lỗi câm — node:crypto, picker model rỗng, và phiên voice không bao giờ kết thúc"
date: 2026-09-20
summary: "Ba lỗi đều có dạng 'im lặng': app trắng vì Vite externalize node:crypto, picker model rỗng vì catalogue chỉ publish khi có model turn, và voice không trả lời vì setup thiếu silenceDurationMs — mỗi lỗi đều có số đo đối chứng, không phải suy luận"
---

# Dev app: ba lỗi câm

**Ngày**: 2026-09-20 16:45 (Asia/Saigon)
**Mức độ**: High — cả ba đều làm tính năng chết hẳn mà không báo lỗi
**Component**: `apps/web` (dev), `apps/runtime` (model turn, voice gateway), `packages/conversation-client`, `packages/voice-adapters`
**Trạng thái**: Resolved — cả ba đã merge, gate xanh trên `main`

## What Happened

Ba báo lỗi liên tiếp từ người dùng, cả ba đều có cùng hình dạng: một tính năng không làm gì cả và
không nói vì sao. Mỗi lần, việc đầu tiên là tái hiện bằng số đo chứ không sửa theo phỏng đoán.

### 1. App trắng trong dev — `node:crypto` (PR #95, `33f9493`)

`WidgetFrame` import `@clarkcant/widget-host`, một barrel trộn có phần catalog registry tính digest
bằng `createHash`. Trong bundle thì Rollup tree-shake helper đó đi, nên **build, CI và toàn bộ e2e
xanh**; chỉ dev chết, vì Vite phục vụ từng module và hoist phép đọc interop `createHash` lên dòng 1,
ném ngay khi nạp.

Sửa: gói khai báo entry an toàn cho browser (`"./session"`) và client import đúng entry đó. Kèm một
invariant mới đi theo entry browser và fail nếu module nào chạm tới được import `node:` — đã kiểm cả
hai chiều (hoàn nguyên import → FAIL nêu đúng chuỗi; giữ fix → PASS).

### 2. Picker model rỗng — vòng lặp chết (PR #99, `ad4c157`)

`services.modelCatalogue` chỉ được gán **cùng lúc** với model turn, mà model turn chỉ dựng khi có
`CC_MODEL_PROVIDER` + `CC_MODEL_ID`. Nên node không có hai biến đó thì: không turn → không catalogue
→ picker rỗng → **không thể chọn model**, và `POST /model` lưu một preference mà chỉ model turn đọc
được. Đo được: pi trên máy có **40 provider**, node trả `{"current":null,"catalogue":[]}`.

Sửa ba mắt xích: catalogue đọc được mà không cần model (trừ node fixture, vốn cố ý không có model và
không có catalogue); lựa chọn đã lưu đủ để node chạy model; và runtime được mở ở entry point **trước**
khi dựng turn để đọc được lựa chọn — một file DB, một connection.

Hai lỗi của chính tôi trong quá trình này, ghi lại vì không gate nào bắt được: (a) phiên bản đầu gọi
getter lựa chọn trong `createModelTurn`, chạy trước khi container tồn tại →
`ReferenceError: Cannot access 'services' before initialization`, typecheck và unit suite vẫn xanh,
chỉ chạy node mới thấy; (b) publish catalogue vô điều kiện làm node fixture đọc pi của máy, phá hợp
đồng mà `appearance.spec.ts` đang khẳng định.

### 3. Voice không trả lời — lượt nói không bao giờ kết thúc (PR #103, `fafae9f`)

Người dùng đã đặt Gemini key nhưng voice vẫn không hoạt động. Chuỗi bằng chứng:

- Key **có** trong vault (`/readiness` trả `["gemini","typesafe"]`) và node đọc nó **mỗi lần mở
  phiên**, nên key không phải vấn đề.
- Phiên mở được, surface báo "Đang nghe", browser gửi **103 frame audio không im lặng**
  (`nonZeroBytes` 780…4048), node forward (`sent: 51, dropped: 0`).
- Gọi adapter trực tiếp: credential ✓, setup ACK ✓, và **một lượt text trong cùng phiên được trả lời
  ngay** (transcript + 105 600 byte audio) → model, credential, đường nhận đều tốt.
- Vậy hỏng ở đâu: setup **không định nghĩa khi nào một lượt nói kết thúc**. Đo trên endpoint thật,
  cùng audio, cùng model:

  | setup | message từ server | transcript vào | model trả lời |
  |---|---|---|---|
  | không có (bản đang ship) | 2 | không | không |
  | `silenceDurationMs: 400` | 65 | có | có |

  Chỉ field đó có tác dụng: hai gợi ý sensitivity không đổi gì khi đứng một mình (2 message), nên
  chúng được cố ý **không** gửi.

Sửa: một field trong setup. Kiểm qua chính đường sản phẩm, chỉ có tiếng nói, không silence thủ công:
`TRANSCRIPT: user "Hello, Clark."` → `TRANSCRIPT: assistant "Hello! How can I "`. Và trong app thật,
surface nhận `{"type":"transcript","role":"user","text":"Hello, Clark."}` — trước đó là không có gì.

Hai điều chỉnh kèm theo: dòng log khởi động thôi khẳng định sai ("no GEMINI_API_KEY, so a voice
session will be refused" trên node vừa điền credential card — vault mới là chỗ key của người dùng
desktop nằm), và `POST /model` nói thật khi nào lựa chọn có hiệu lực (`next-session` khi đã có turn
đọc được, `next-start` khi chưa).

## Điều đáng nhớ

**Ba lỗi, ba lần "xanh" đều là xanh giả.** Lần thứ nhất: build xanh vì tree-shaking, dev chết. Lần
thứ hai: mọi gate xanh trong khi control trong Settings lưu một giá trị không ai đọc. Lần thứ ba:
không có gate nào chạm tới provider thật, nên adapter "đã test" vẫn có thể chưa từng gửi audio đúng.

**Thứ phân biệt được các giả thuyết luôn là một con số.** `nonZeroBytes` để biết audio có rời
browser; `sent/dropped` để biết adapter có gửi; số message từ server (2 so với 65) để biết field nào
chịu tải. Không có mấy con số đó thì cả ba lần đều rất dễ "sửa" vào chỗ không phải nguyên nhân.

**Một chi tiết dễ đọc sai:** phiên voice đầu tiên của người dùng vẫn **đang sống** (có socket mở và
kết nối TLS tới Google), nên mọi lần thử sau bị từ chối `VOICE_SESSION_BUSY`. Từ chối đó **đúng**
(một phiên một lúc) — nó chỉ trông như bế tắc vì phiên đang giữ chỗ lại không làm gì cả.

## Verification

- `pnpm verify` exit 0 — 8 invariant, 1700 passed / 7 skipped (136 file).
- `pnpm test:e2e` exit 0 — 110 passed / 1 skipped.
- Ba PR đã merge vào `main`: #95 `33f9493`, #99 `ad4c157`, #103 `fafae9f`.

## Còn lại

- Chưa có người thật nói vào micro thật qua app; bằng chứng dùng file giọng nói tổng hợp làm mic —
  cùng đường đi, nhưng người dùng nên tự xác nhận.
- `silenceDurationMs: 400` là số đo trên endpoint này, model này; nếu provider đổi mặc định thì con
  số này cần đo lại chứ không phải suy ra.

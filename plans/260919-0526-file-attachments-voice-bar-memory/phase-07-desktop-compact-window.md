---
phase: 7
title: "Cửa sổ desktop compact, shell load client và bridge có tên"
status: pending
priority: P1
effort: "6h"
dependencies: []
---

# Phase 7: Cửa sổ desktop compact, shell load client và bridge có tên

## Context Links

- Issue #17 §2 "Desktop thu nhỏ tối thiểu còn icon voice bar"
- **Sự thật phải sửa trước tiên**: cửa sổ Electron đang load `file://…/shell.html`, một trang demo
  posture; **không** có mã client nào chạm `window.clarkcant` (`apps/desktop/src/main.mjs:36-39`,
  `apps/desktop/src/shell.html:46`). Nếu không sửa, Stage B có thể xanh mà người dùng không bao giờ
  tới được thanh voice.
- `apps/desktop/src/security.mjs:65-77` — CSP hiện tại: `default-src 'none'`, `connect-src 'self'`
- `apps/desktop/src/security.mjs:110-130` — `reviewIpcCall` so `frame.url !== rendererUrl` **chính xác**
- `apps/desktop/src/preload.cjs` — 6 method tên rõ, **không** có `invoke(channel,…)`
- `apps/desktop/src/main.mjs` `runSmokeTest()` — nơi assert bridge thật trong renderer thật
- `apps/web/src/App.tsx:20-46` — token hiện được đọc từ `?token=` rồi giữ trong `sessionStorage`
- `packages/conversation-client/src/Conversation.tsx` — nơi conversation UI sống

## Quyết định bắt buộc (viết ra, không để người thi hành tự đoán)

**Cửa sổ shell load conversation client, và client nhận token qua bridge có tên.**

- `electron . --renderer-url <client-url> --data-dir <node data dir>`; thiếu `--renderer-url` thì giữ
  hành vi cũ (load `shell.html`, dùng cho smoke posture).
- CSP **suy ra từ origin** thay vì hardcode: `contentSecurityPolicy({ appOrigin, nodeOrigin, devOrigin })`
  trả `script-src appOrigin`, `connect-src nodeOrigin` (cả `http(s)` và `ws(s)`), `img-src 'self' data: blob:`
  (cần cho ảnh mini-app và attachment), `style-src appOrigin`, giữ `default-src 'none'`,
  `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`.
- Token **không** đi vào argv (argv hiện trong danh sách tiến trình của OS). Thêm **một** method tên rõ
  `getSession()` → `{ baseUrl, token }`, đọc `localToken` từ `<dataDir>/identity.json` (file runtime
  đã ghi; **kiểm tên trường thật trong `apps/runtime/src/node.ts` trước khi viết code**). Client gọi
  bridge này khi `window.clarkcant` tồn tại, thay cho `?token=`.
- Đánh đổi được ghi nhận: token tới renderer, đúng như đường web hiện tại đã làm (`App.tsx:20-22` gọi
  nó là development affordance). Khác biệt là nó **không còn** nằm trong argv hay browser history.
  Token phiên có scope hẹp là câu trả lời đúng về lâu dài; việc đó thuộc một phase khác và được ghi
  thành gap có tên ở Phase 12.

## Files to Create / Modify

- Create: `apps/desktop/src/window-mode.mjs` (hàm thuần: hằng số, bounds, vị trí)
- Create: `apps/desktop/test/window-mode.spec.ts`
- Modify: `apps/desktop/src/security.mjs` (`IPC_CHANNELS` thêm 2 channel; `contentSecurityPolicy({...})`)
- Modify: `apps/desktop/src/preload.cjs` (`setCompactMode`, `getSession`)
- Modify: `apps/desktop/src/main.mjs` (frameless, `createNodeServer`-style options, handler đọc lại state thật)
- Modify: `apps/desktop/src/shell.html` + `shell.mjs` + `shell.css` (nút compact cho smoke posture)
- Create: `packages/conversation-client/src/desktop-chrome.tsx` (dải kéo + nút thu nhỏ/đóng, chỉ khi có bridge)
- Modify: `packages/conversation-client/src/desktop-compact.ts` (bridge + `getSession`)
- Create: `packages/conversation-client/test/desktop-compact.spec.ts`
- Modify: `packages/conversation-client/src/Conversation.tsx` (render `desktop-chrome` khi có bridge)

## Tests Before (viết trước, phải đỏ)

1. `apps/desktop/test/window-mode.spec.ts` (vitest, node env):
   - `"the allowed minimum leaves room for a twenty by fifty bar"` — `COMPACT_MIN_SIZE` deep-equals `{ width: 20, height: 50 }`.
   - `"compact bounds keep the current position when it still fits the work area"`.
   - `"compact bounds move into the work area when the remembered position is off-screen"`.
   - `"expanding restores the remembered bounds exactly"` — round-trip qua `nextWindowMode`.
   - `"always-on-top follows the user's choice and defaults to off"`.
2. `packages/conversation-client/test/desktop-compact.spec.ts`:
   - `"a browser without the bridge refuses compact mode instead of pretending"`.
   - `"the compact state is derived from the shell's answer, not from the request"`.
   - `"a session handed over by the bridge is used instead of a url token"`.
   - `"a bridge that refuses the session leaves the token field empty rather than inventing one"`.
3. Trong `runSmokeTest()` (Electron thật), thêm các check **đọc state thật của Electron**:
   - `"the bridge exposes exactly the expected named methods"` (cập nhật danh sách: 8 method).
   - `"compact mode reads back the bounds Electron actually has"` — so `window.getBounds()` **sau** khi gọi.
   - `"the minimum size Electron reports is the twenty by fifty floor"` — `window.getMinimumSize()`.
   - `"expanding restores the bounds Electron had before compact"`.
   - `"always on top is reported by the window, not by the model"` — `window.isAlwaysOnTop()`.

## Tasks & Steps

### Task 7.1 — Shell load client + CSP theo origin + token qua bridge

- **Goal**: cửa sổ desktop thật sự hiển thị conversation client, và client gọi được node.
- **Target files and symbols**: `apps/desktop/src/main.mjs` (`rendererUrl` từ `--renderer-url`,
  `applyContentSecurityPolicy({ appOrigin, nodeOrigin })`), `apps/desktop/src/security.mjs`
  (`contentSecurityPolicy(input)`), `apps/desktop/src/preload.cjs` (`getSession`),
  `packages/conversation-client/src/desktop-compact.ts` (`desktopBridge()` + `sessionFromBridge()`).
- **Steps**:
  1. `--renderer-url` đã có; thêm `--data-dir`. `appOrigin` = origin của `rendererUrl` (khi là `file:`
     thì `'self'`), `nodeOrigin` = origin của `--node-url` (mặc định `http://127.0.0.1:<port>` nếu có
     `--node-url`; không có thì bỏ qua khối `connect-src` mở rộng).
  2. `contentSecurityPolicy` nhận tham số và sinh policy; **giữ nguyên output cũ** khi gọi không tham
     số, để smoke posture và test hiện có không đổi.
  3. `getSession()` → `{ baseUrl, token }`; `baseUrl` từ `--node-url`, `token` đọc
     `<dataDir>/identity.json` (`localToken`). File thiếu/không đọc được → `{ ok: false, refused }`;
     **không** bịa token.
  4. Client: `readToken()` trong `apps/web/src/App.tsx` hỏi bridge trước, rồi mới tới URL/sessionStorage.
  5. `shell.html` giữ `<meta>` CSP hiện tại (dùng cho smoke posture); document client nhận CSP từ
     response header, nên **không** dựa vào meta của shell.
- **Success criteria**: operator chạy `electron . --renderer-url <vite preview url> --data-dir .data`
  thấy conversation UI; smoke posture cũ vẫn xanh.
- **Verify**: `pnpm --filter @clarkcant/app-desktop run smoke` exits 0 và output JSON có `failed: []`.

### Task 7.2 — Hàm thuần quyết định chế độ cửa sổ

- **Goal**: số học của compact/expand test được bằng vitest, không cần Electron.
- **Target files and symbols**: `apps/desktop/src/window-mode.mjs` —
  `COMPACT_MIN_SIZE = Object.freeze({ width: 20, height: 50 })`,
  `MINIMAL_BAR = Object.freeze({ width: 68, height: 56 })`,
  `nextWindowMode(state, action)`, `fitIntoWorkArea(bounds, workArea)`.
- **Steps**:
  1. Ghi comment: 20×50 của issue được đọc là **sàn** `setMinimumSize`; `MINIMAL_BAR` là kích thước
     thanh (icon 20×50 + icon expand + padding). Con số cuối cần nghiệm thu trên display thật, và trên
     Windows còn sàn tracking size của OS mà chỉ máy thật mới đo được.
  2. `nextWindowMode(state, { type: "enter-compact" })`: lưu `state.bounds` vào `state.normalBounds`,
     trả bounds `MINIMAL_BAR` đã `fitIntoWorkArea`.
  3. `nextWindowMode(state, { type: "expand" })`: trả **đúng** `state.normalBounds`, không hardcode 1100×760.
  4. `nextWindowMode(state, { type: "set-always-on-top", value })`: giữ nguyên mode và bounds.
- **Success criteria**: 5 test xanh.
- **Verify**: `pnpm exec vitest run apps/desktop/test/window-mode.spec.ts` exits 0 và in `5 passed`.

### Task 7.3 — Bridge `setCompactMode` đọc lại state thật

- **Goal**: compact mode có thật, và test không thể xanh nếu chỉ số học đúng mà cửa sổ không đổi.
- **Target files and symbols**: `apps/desktop/src/security.mjs` (`IPC_CHANNELS`),
  `apps/desktop/src/preload.cjs`, `apps/desktop/src/main.mjs` (`handle("desktop:setCompactMode", …)`).
- **Steps**:
  1. Input `{ compact: boolean, alwaysOnTop?: boolean }`; `compact` không phải boolean → `{ ok: false, refused }`.
  2. Handler: hạ `setMinimumSize` xuống sàn **trước**, rồi `setBounds`, rồi `setAlwaysOnTop` nếu có.
  3. **Trả về giá trị đọc từ cửa sổ sau khi gọi**: `window.getBounds()`, `window.getMinimumSize()`,
     `window.isAlwaysOnTop()`, `window.isMinimized()`. Không trả giá trị do `nextWindowMode` tính.
     Đây là chỗ bản trước sai: so hàm thuần với chính nó thì xoá `setBounds` vẫn xanh.
  4. Trả `{ ok: true, mode, bounds, minimumSize, alwaysOnTop }` với mọi trường lấy từ Electron.
- **Success criteria**: smoke check "reads back the bounds Electron actually has" xanh.
- **Verify**: `pnpm --filter @clarkcant/app-desktop run smoke` exits 0.

### Task 7.4 — Frameless, vùng kéo và chrome của client

- **Goal**: cửa sổ xuống được cỡ 20×50 (cửa sổ có frame không xuống được trên Windows) mà vẫn đóng/kéo được.
- **Target files and symbols**: `apps/desktop/src/main.mjs` (`createShellWindow`), `shell.css`, `shell.mjs`,
  `packages/conversation-client/src/desktop-chrome.tsx`.
- **Steps**:
  1. `frame: false`, `show: false` rồi `ready-to-show` → `show()`.
  2. Ghi comment nêu lý do frameless (Windows áp chiều rộng tối thiểu cho cửa sổ có frame).
  3. `window.on("resize")` cập nhật `normalBounds` **chỉ khi** không ở compact, để lần expand sau trả
     về đúng chỗ người dùng vừa kéo.
  4. `desktop-chrome.tsx`: dải `-webkit-app-region: drag` cao 32px + nút thu nhỏ/đóng
     (`-webkit-app-region: no-drag`), **chỉ render khi `window.clarkcant` tồn tại** nên bản web không đổi.
  5. `shell.html`/`shell.mjs`: thêm nút `#enter-compact` / `#leave-compact` để smoke posture chạm được
     cùng handler.
- **Success criteria**: `pnpm test:e2e` vẫn xanh (chrome không xuất hiện trong browser suite).
- **Verify**: `pnpm test:e2e -- apps/web/e2e/appearance.spec.ts` exits 0.

### Task 7.5 — Smoke đọc state Electron thật

- **Goal**: chứng minh bounds/expand/always-on-top bằng Electron, không bằng mô hình của chính test.
- **Target files and symbols**: `runSmokeTest()` trong `apps/desktop/src/main.mjs`.
- **Steps**:
  1. Trong probe: gọi `setCompactMode({ compact: true })`, đọc `bounds` từ response (đã là
     `getBounds()`), so với `MINIMAL_BAR`; gọi `setCompactMode({ compact: false })`, so với bounds ghi
     **trước** khi compact.
  2. Thêm một ca đối nghịch: gọi `setCompactMode({ compact: true })` rồi khẳng định
     `minimumSize.width === 20 && minimumSize.height === 50` — nếu ai đó xoá `setMinimumSize`, ca này đỏ.
  3. Ghi `mode` vào output JSON để người vận hành đọc được.
  4. **Ghi nhận trong report**: `pnpm --filter @clarkcant/app-desktop run smoke` là cổng **do người vận
     hành chạy trên máy có display**; CI không có display nên không nằm trong `pnpm verify`. Thêm job
     `xvfb-run` là việc tiếp theo, ghi tên ở Phase 12.
- **Success criteria**: smoke `failed: []` với các check mới.
- **Verify**: `pnpm --filter @clarkcant/app-desktop run smoke` exits 0 và output JSON chứa
  `"compact mode reads back the bounds Electron actually has"`.

## Refactor

Nếu `main.mjs` quá dài, tách `runSmokeTest` sang `apps/desktop/src/smoke.mjs`. Chạy lại **cùng** smoke;
output JSON phải giữ nguyên tên check (đây là evidence của phase).

## Tests After

`"a refused channel is still refused after compact mode exists"` trong `apps/desktop/test/security.spec.ts`,
và `"the client renders no desktop chrome when no bridge is present"` trong
`packages/conversation-client/test/desktop-compact.spec.ts`.

## Regression gate

```bash
pnpm verify && pnpm --filter @clarkcant/app-desktop run smoke
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

- **Rủi ro**: nới CSP để load client làm yếu posture của shell. **Giảm thiểu**: CSP suy ra từ **đúng**
  hai origin (app + node), không dùng `*`, không `unsafe-inline`, không `unsafe-eval`; giữ
  `default-src 'none'`, `object-src 'none'`, `frame-ancestors 'none'`; `contentSecurityPolicy()` không
  tham số giữ nguyên output cũ.
- **Rủi ro**: `getSession` thành đường phát token. **Giảm thiểu**: `reviewIpcCall` chỉ cho document đã
  load gọi; không log; token vẫn chỉ nằm trong `sessionStorage` của tab như hiện nay; ghi gap "scoped
  session token" vào Phase 12.
- **Rủi ro**: `frame: false` làm mất nút đóng trên Windows. **Giảm thiểu**: client vẽ chrome khi có
  bridge, `shell.html` vẫn có nút cho smoke; `keepRunningOnWindowClose` giữ nguyên nghĩa.
- **Rủi ro**: smoke cần display nên không chạy trong CI. **Giảm thiểu**: ghi rõ là cổng do người vận
  hành chạy, lưu output JSON làm evidence; không thay bằng một assert giả trong CI.

## Security Considerations

- Không secret nào trong argv; token đọc từ file do runtime ghi.
- Một method mới cho credential nhưng vẫn là tên rõ, không có passthrough `invoke(channel, …)`.
- `setAlwaysOnTop` chỉ nhận boolean, mặc định tắt.
- Không thêm quyền OS nào (không capture, không input).

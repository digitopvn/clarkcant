# Ghi chú bàn giao: nối preview vào card takeover (V14)

Trạng thái goal: 3/10 task xong. Đã merge lượt này: V02 (#114 `bdf1572`),
V08 (#115 `1a2536b`), V12 (#116 `3cfc4cd`), V14 phần producer (#117 `145dce9`).
Sổ hiện **10 PASS / 8 PARTIAL** (PASS: V01, V02, V03, V04, V05, V06, V07, V11, V16, V18).

## Phần V14 đã thật

- `BrowserDriver.capturePreview()` trong `packs/browser-playwright/src/driver.ts` trả PNG bytes thật,
  tách khỏi `observe` (raw frame không vào event log).
- `apps/runtime/src/session-preview.ts` lưu bytes vào blob store: **byte quyết định loại**
  (`NOT_AN_IMAGE` cho capture không phải ảnh, kể cả khi nó khai là `image/png`), **viewport đi cùng byte**,
  và trần kích thước. Test: `apps/runtime/test/session-preview.spec.ts` (5 test).

## Phần còn thiếu, với anchor chính xác

1. **Contract** — `packages/contracts/src/surfaces.ts:111` `browserSessionCardSchema` (hiện là
   `z.strictObject` với `type`, `owner`, `cardId`, `sessionId`, `label`, `driver`, `status`,
   `leaseEpoch`, `updatedAt`). Thêm một trường `preview` optional:
   `{ blobRef, digest, viewport: {width, height}, capturedAt }`. Vì là `strictObject`, client và node
   dùng chung schema nên hai bên phải đổi cùng lúc; `packages/contracts/test/contracts.spec.ts` là nơi
   thêm test round-trip (có preview và không có preview đều parse được).
2. **Node dựng card** — `apps/runtime/src/main.ts:491` là chỗ dựng `browser-session-card` (nhánh fixture).
   Ở đó gọi `storeSessionPreview({dataDir, capture})` với capture lấy từ driver (fixture thì capture
   trả bytes cố định, kèm chú thích rằng fixture chứng minh dây nối chứ không chứng minh browser).
   Chỉ gắn `preview` khi `ok === true`; capture hỏng thì card **không** có preview và phải nói vì sao.
3. **Phục vụ byte cho client** — chưa tìm thấy route blob cho client. Các GET hiện có trong
   `apps/runtime/src/gateway.ts`: `/health`, `/widget-runtime.js` + `/assets/`, `/frame/`,
   `/peers/artifacts/` (chỉ peer token), `/peers`, `/node`, `/model`, `/autonomy`, `/model-pool`.
   Cần đọc tiếp `packages/conversation-client/src/use-attachment-urls.ts` (hàm `useAttachmentUrls`)
   để biết attachment lấy byte bằng đường nào — preview nên đi **đúng đường đó** thay vì mở đường thứ hai.
4. **Render** — `packages/conversation-client/src/blocks.tsx:1527` dispatch cả `browser-session-card` và
   `computer-session-card` vào **một** `ControlSessionCardBlock` (khai báo ở `blocks.tsx:1830`). Thêm
   phần hiển thị preview trong component đó, kèm alt text và nhãn thời điểm chụp; tuyệt đối không
   trình bày như ảnh live (AGENTS.md), và giữ nguyên leaseEpoch/owner trên card.
5. **e2e** — thêm assert preview hiển thị và restore-without-autoplay vẫn đúng, trong spec browser
   session hiện có (tìm `apps/web/e2e/` theo `browser-session-card` hoặc `control-takeover`).
6. **Sổ** — dòng V14 trong `docs/conformance-traceability.md`: đổi câu "Chưa có: nối preview vào card"
   thành mô tả phần đã nối, và giữ lại phần thật sự còn thiếu nếu còn (ví dụ capture thật từ driver
   chưa chạy trong đường node, chỉ chạy trong test của driver).

## Ghi chú kỹ thuật sẽ cần lại

- `pnpm verify` và `pnpm test:e2e` **không được chạy chung một lệnh**; trước Playwright phải kill
  listener cũ ở `:8876`/`:4273` rồi `sleep 5`.
- `detectImageFormat` cần **≥ 24 byte** cho PNG (đọc width/height ở offset 16 và 20) — fixture PNG
  12 byte sẽ bị từ chối.
- `ImageFormat` **không có** trường `extension`; suy ra từ `mimeType`.
- GitGuardian quét **mọi commit trong PR**, không phải diff cuối: literal đọc như credential trong
  commit cũ giữ check đỏ, cách sửa là squash.
- Lint: `preserve-caught-error` (dùng `new Error(msg, { cause })`), `no-unused-vars` fail build,
  `no-unknown-returns`, `no-non-null-assertion`.

## Câu hỏi chưa ngã ngũ

V14 nên đóng hẳn (card + e2e) trong goal này, hay chấp nhận PARTIAL với producer đã thật? Người dùng
chưa trả lời; tôi đã chọn đóng hẳn vì một producer không có đường hiển thị thì người dùng chưa thấy gì,
và contract của task ghi rõ "card render được".

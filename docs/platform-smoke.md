# Smoke chỉ chạy được trên macOS

Tài liệu này tồn tại vì ba thứ trong dự án **không kiểm được trên máy Windows đã dùng để phát triển**, và cách xử lý
đúng là nói ra chứ không phải im lặng bỏ qua. Không có mục nào ở đây được ghi là "đã pass".

**Điều kiện còn thiếu: một máy macOS có màn hình thật (và một người ngồi trước nó để trả lời hộp thoại của hệ
điều hành).** Không có runner macOS trong repo này.

## Ba thứ không kiểm được ở nơi khác

1. **TCC (quyền riêng tư của macOS).** Quyền ghi màn hình và micro do hệ điều hành sở hữu, và hộp thoại xin quyền
   chỉ xuất hiện trên macOS. Trên Windows, node báo `needs-permission` — đúng, nhưng đó là *cùng một trạng thái* được
   tạo bởi một hệ điều hành khác, nên nó không chứng minh được đường macOS.
2. **Window bounds trên macOS.** `electron . --smoke-test` đọc `getBounds()` và `getMinimumSize()` từ cửa sổ thật.
   Windows có tracking floor riêng của nó; macOS (NSWindow) có cái khác, nên con số 20×50 trong
   `COMPACT_MIN_SIZE` chỉ được xác nhận trên Windows cho tới khi có người chạy trên macOS.
3. **Wake-word detector local.** Bản ship hiện tại **không có** detector nào, và toggle trong Settings không dùng
   được kèm lý do (phase 8). Nếu một ngày có detector dùng AVFoundation/on-device thì nó cũng chỉ chạy được trên
   macOS, nên đây là chỗ phải kiểm lại — hiện tại không có gì để kiểm, và đó là lý do nó nằm trong danh sách này chứ
   không phải trong một test bị skip.

## Lệnh cho người vận hành macOS

```bash
# 1. Cài đặt
corepack enable
pnpm install

# 2. Smoke của desktop shell — mong đợi: exit 0 và JSON có "failed": []
pnpm --filter @clarkcant/app-desktop run smoke

# 3. Node chạy thật, để nhìn cửa sổ
node apps/runtime/src/main.ts --data-dir ./.data --label macos-smoke

# 4. Bộ e2e đầy đủ (cần port trống)
pnpm test:e2e

# 5. Toàn bộ cổng kiểm tra
pnpm verify:full
```

Hai chỗ cần bàn tay người, vì chúng là hộp thoại của hệ điều hành:

```bash
# 6. Phiên desktop: mở một phiên điều khiển màn hình, rồi bật quyền cho ClarkCant
#    System Settings → Privacy & Security → Screen Recording → ClarkCant → bật
#    Sau đó chạy lại (2) và xác nhận phiên chuyển từ "needs-permission" sang "available".
#    Card phải nói rõ quyền thuộc hệ điều hành, và node không tự cấp được.

# 7. Voice: bật micro cho ClarkCant
#    System Settings → Privacy & Security → Microphone → ClarkCant → bật
#    Rồi chạy: pnpm exec playwright test apps/web/e2e/voice.spec.ts
```

## Khi có kết quả

Ghi lại vào PR hoặc vào mục này: phiên bản macOS, phiên bản Electron, output JSON của smoke, và bounds mà
`getMinimumSize()` trả về. Nếu `COMPACT_MIN_SIZE` sai trên macOS thì đó là một finding, và sửa nó là việc của một
change riêng — không phải chỉnh con số cho vừa máy.

## Vì sao không có test bị skip

Một test `skip` trên máy này sẽ khiến bộ kiểm tra nói "xanh" trong khi thứ nó định kiểm chưa từng chạy. Thứ đúng
là: không có test nào tồn tại cho ba mục trên, và tài liệu này nói rõ điều kiện còn thiếu cùng cách chạy chúng ở
nơi chạy được.

# Cài đặt và onboarding ClarkCant

> [English](installation.md) (mặc định) · Tiếng Việt

Tài liệu này hướng dẫn cài một node ClarkCant trên macOS, Linux hoặc Windows, chạy trực tiếp
bằng Node.js hoặc trong Docker, kể cả trên VPS có tên miền và HTTPS. Mọi con đường đều đi qua
cùng một bước onboarding tương tác: `tools/setup.mjs`.

> Đây vẫn là bản bootstrap, chưa phải bản phát hành. Những gì chạy được và chưa chạy được được
> ghi trong [README](../README.md) và [bảng conformance](conformance-traceability.md).

## Yêu cầu

| Thành phần | Chạy local | Chạy Docker | Ghi chú |
|---|---|---|---|
| Node.js 22.19+ (khuyên dùng 24) | bắt buộc | cần để chạy onboarding | Runtime chạy TypeScript trực tiếp |
| pnpm 12 qua Corepack | bắt buộc | không | Installer tự chạy `corepack enable` |
| git | cần khi clone | cần khi clone | |
| Docker + Compose plugin 2.24+ | không | bắt buộc | |

Cách cài Node.js theo nền tảng (installer không tự cài Node hay Docker, vì đó là quyết định của
người sở hữu máy):

- **macOS:** `brew install node@24`, hoặc fnm/nvm, hoặc bộ cài từ nodejs.org.
- **Linux:** `curl -fsSL https://fnm.vercel.app/install | bash && fnm install 24`, hoặc gói Node 24 của bản phân phối.
- **Windows:** `winget install OpenJS.NodeJS.LTS` rồi mở terminal mới.

## Cài nhanh bằng một lệnh

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/digitopvn/clarkcant/main/tools/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/digitopvn/clarkcant/main/tools/install.ps1 | iex
```

Installer kiểm tra git và phiên bản Node, clone repository vào `./clarkcant` (đổi bằng biến
`CLARKCANT_DIR`, chọn nhánh/tag bằng `CLARKCANT_REF`), bật pnpm qua Corepack rồi chuyển sang
onboarding. Nếu chạy installer bên trong một checkout có sẵn, nó dùng luôn checkout đó.

Nên đọc script trước khi chạy: tải về, đọc, rồi chạy `sh install.sh`.

## Từ một checkout có sẵn

```sh
git clone https://github.com/digitopvn/clarkcant
cd clarkcant
node tools/setup.mjs          # hoặc: pnpm onboard (khi pnpm đã có)
```

## Các bước onboarding

Onboarding có năm bước và không ghi gì cho tới bước tóm tắt; `Ctrl+C` ở bất kỳ đâu để máy
nguyên như cũ.

1. **Cách chạy node**: `local` (Node.js trên máy này), `docker` (Docker, chỉ loopback) hoặc
   `docker-public` (Docker sau Caddy với HTTPS tự động, cho VPS có tên miền).
2. **Kiểm tra máy**: Node, pnpm/Corepack, git, Docker Compose. Thiếu thành phần bắt buộc cho
   cách chạy đã chọn thì dừng lại và không thay đổi gì.
3. **Model trả lời hội thoại**: DeepSeek, Google Gemini, OpenAI, OpenRouter hoặc "chưa dùng
   model". Provider và model phải đi cùng nhau; node không tự chọn model thay bạn. API key được
   nhập ẩn và không hiện lại ở bất kỳ đâu; bỏ trống để giữ key đã có hoặc thêm sau.
4. **Danh tính và lưu trữ**: nhãn node, cổng gateway (không hỏi ở docker-public vì Caddy nhận
   80/443), thư mục dữ liệu (local) hoặc tên miền (docker-public).
5. **Tóm tắt**: xác nhận rồi ghi `.env` (quyền `600` trên macOS/Linux), sau đó tuỳ chọn cài phụ
   thuộc và web client (`pnpm install`, `pnpm run build`) hoặc dựng image Docker. Cuối cùng in
   đúng lệnh khởi động node.

Chạy lại onboarding là an toàn: giá trị trong `.env` hiện có được dùng làm mặc định, còn các dòng
và chú thích khác trong file được giữ nguyên.

### Không tương tác (CI, script bootstrap VPS)

```sh
DEEPSEEK_API_KEY=... node tools/setup.mjs --yes --mode docker \
  --provider deepseek --model deepseek-v4-flash --label "vps clark"
```

Với `--yes`, key được đọc từ biến môi trường của provider nên không phải xuất hiện trên dòng
lệnh. `node tools/setup.mjs --help` liệt kê mọi tuỳ chọn; `--dry-run` chỉ in tóm tắt.

## Chạy local

```sh
node apps/runtime/src/main.ts --data-dir ./.data --label "my clark" --port 8765
```

Node chỉ phục vụ gateway (`/health`, API, runtime widget), không phục vụ giao diện. Kiểm tra bằng
`curl http://127.0.0.1:8765/health`, rồi mở web client ở terminal khác:

```sh
pnpm dev:web    # mở http://127.0.0.1:5173/?gateway=http://127.0.0.1:8765
```

Bearer token nằm trong `./.data/identity.json` (trường `localToken`). Node mặc định chỉ bind
loopback và từ chối bind địa chỉ công khai nếu thiếu `--allow-public-bind`.

## Chạy bằng Docker

Template: [`docker-compose.yml`](../docker-compose.yml),
[`docker/compose.public.yml`](../docker/compose.public.yml), [`docker/Caddyfile`](../docker/Caddyfile).

```sh
node tools/setup.mjs --mode docker
docker compose up -d
docker compose exec clarkcant cat /data/identity.json   # bearer token
docker compose logs -f clarkcant
```

- Cổng chỉ publish trên `127.0.0.1`. Node trong container bind `0.0.0.0` vì loopback của
  container không truy cập được từ host; chính địa chỉ publish giữ node ở chế độ riêng tư.
- `.env` được đọc lúc chạy qua `env_file`, không bao giờ nằm trong image (`.dockerignore` loại nó).
- Dữ liệu (danh tính, database, blob, transcript) nằm trong volume `clarkcant-data`. Mất volume là
  mất danh tính node; sao lưu nó trước khi xoá hay di chuyển.

### VPS với tên miền và HTTPS

1. Trỏ bản ghi DNS của tên miền về IP server; mở cổng 80 và 443.
2. Chạy `node tools/setup.mjs --mode docker-public` (hỏi tên miền, lưu vào `CLARKCANT_DOMAIN`).
3. Khởi động:

   ```sh
   docker compose -f docker-compose.yml -f docker/compose.public.yml up -d
   ```

Overlay này gỡ cổng của node khỏi host và chỉ cho vào qua Caddy (TLS tự cấp và tự gia hạn). Mọi
route trừ `/health` vẫn yêu cầu bearer token; TLS bảo vệ token trên đường truyền.

## Cập nhật

```sh
git pull
node tools/setup.mjs            # giữ nguyên .env, cài lại phụ thuộc hoặc dựng lại image
docker compose up -d --build    # với Docker
```

## Xử lý sự cố

| Hiện tượng | Nguyên nhân và cách xử lý |
|---|---|
| Không tìm thấy `corepack` | Node.js 25+ không còn kèm Corepack: `npm install -g corepack`. |
| `corepack enable` thất bại | Cần quyền ghi vào thư mục Node: chạy bằng `sudo` (macOS/Linux) hoặc PowerShell quyền admin. |
| `pnpm install` từ chối một gói mới | Chính sách `minimumReleaseAge` (24 giờ) trong `pnpm-workspace.yaml`, không phải lỗi mạng. |
| Node báo model không truy cập được | Thiếu key của provider trong `.env`; chạy lại onboarding và nhập key. |
| `Refusing to bind ...` | Node chạy trực tiếp với `--host` công khai. Dùng Docker/Caddy hoặc tự đặt TLS phía trước rồi thêm `--allow-public-bind`. |
| Cổng 8765 đã bị chiếm | Tìm tiến trình cũ (`lsof -i :8765`, `ss -ltnp`, `netstat -ano` trên Windows) và dừng nó, hoặc đổi cổng trong onboarding. |
| Caddy không cấp được chứng chỉ | DNS chưa trỏ đúng hoặc cổng 80/443 bị chặn; xem `docker compose logs caddy`. |
| Windows chặn chạy script | `powershell -ExecutionPolicy Bypass -File tools\install.ps1`. |

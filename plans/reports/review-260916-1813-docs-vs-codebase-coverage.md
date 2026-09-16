# Review — docs vs codebase: độ phủ thực tế và phần còn phải làm

**Ngày:** 2026-09-16 · **Repo:** `/Volumes/GOON/www/digitop/clarkcant`
**Commit nền đã review:** `cd4e801` · **Commit xuất hiện giữa lúc review:** `55cd7e4` (đã đối chiếu: chỉ đụng `conversation-client` + 4 file runtime về settings surface, **không** đụng vòng lặp thực thi — kết luận §3 vẫn đúng)
**Câu hỏi:** đọc `docs/`, so với codebase xem đã cover bao nhiêu %, còn phải làm gì.
**Định nghĩa "hoàn thành" dùng trong báo cáo này:** một scope item V được coi là hoàn thành khi *mọi* hành vi trong cột "acceptance boundary" của `docs/scope-lock.md` §4 chạy được end-to-end trên môi trường thật. Không có item nào đạt định nghĩa đó.

---

## 1. Kết luận ngắn

Câu một dòng: **tầng nền (layer) là thật và đã tự kiểm chứng, nhưng đường đi trung tâm của sản phẩm chưa chạy end-to-end — nên 484 test xanh không nâng được mức độ sẵn sàng của sản phẩm.**

Ba con số đo ba thứ khác nhau, đừng đọc gộp:

| Trục đo | Cách đo | Kết quả | Nguồn |
|---|---|---|---|
| Acceptance test T01–T72 | đếm theo ledger | **64 PASS, 4 BLOCKED, 4 NOT-IMPLEMENTED** → 89%, hoặc coi blocked là "chưa xác định" thì khoảng **89–94%** | `docs/conformance-traceability.md` |
| Scope item V01–V18 | đánh giá thủ công theo acceptance boundary | **18/18 PARTIAL, 0 hoàn thành** — không có item nào 0%, không có item nào đủ | §5 |
| Golden journey J1–J6 | chạy thật | **1/6**, và J1 chỉ đi trên nhánh hẹp không cần execution loop | §4 |

**Hình dạng phân bố quan trọng hơn con số trung bình.** Nếu phải tóm bằng một phân loại:

- **Nền tảng đã chạy thật (≈5 item):** V01 conversation client, V11 phần renderer đã có, V13 pins, V14 browser driver, V16 quick play — có test chạy trong browser/node thật.
- **Contract + logic đã có, transport chưa (≈10 item):** V04, V05, V07 (trừ MCP stdio đã thật), V08, V09, V10, V12, V15, V17, V18.
- **Chưa có gì chạy (≈3 item ở mức lõi):** V02 phần đóng gói/OCI, V03 phần worker pool, V06 phần file transfer.

Nếu vẫn muốn một con số đơn: trung bình cộng không trọng số của §5 là **≈53%**. Đây là trung bình của các thang bậc định tính trên 18 hạng mục rất khác nhau (một cái là type contract, một cái là native driver macOS), **không phải** ước lượng công sức và **không phải** ước lượng giá trị người dùng. Cách dùng đúng là đọc phân bố ở trên, không đọc 53%.

---

## 2. Bằng chứng đã tự chạy trong session này

Lệnh chạy trực tiếp binary trong `node_modules` (lý do ở §6):

| Gate | Lệnh | Kết quả |
|---|---|---|
| Repository invariants | `node tools/check-invariants.mjs` | **7/7 PASS** — đây là kiểm tra **tĩnh** (hash manifest, metadata phase, cú pháp Node type-stripping, không có secret), không phải kiểm tra hành vi runtime |
| Typecheck (node + web) | `tsc -p tsconfig.json && tsc -p tsconfig.web.json` | PASS, không lỗi |
| Lint | `eslint .` | Sạch |
| Test | `vitest run` | **484 passed / 484**, 32 file spec |
| E2E J1 trong Chromium thật | `playwright test` | **8 passed / 8** — production build của `apps/web` + node headless thật |
| P0.1 Pi SDK probe | `node packages/pi-adapter/src/probe-cli.ts` | 7 PASS, 2 BLOCKED, 0 FAIL — chứng minh **SDK hoạt động**, không chứng minh app dùng SDK đúng trên đường có tool |

**8 e2e test không chạm vào vòng lặp thực thi.** Chúng kiểm tra: client load và báo kết nối thật, recipe cho ra sample có nhãn host-owned, gõ tin nhắn nhận trả lời từ node, pin/unpin giữ dữ liệu, mở lại resume đúng conversation, composer dùng được bằng bàn phím, token không lọt vào page, và client chưa auth được báo đúng. Không có test nào dispatch một task, spawn một worker, hay cài một capability.

---

## 3. Vòng lặp thực thi đang hở — phát hiện quan trọng nhất

1. **`apps/runtime` không bao giờ spawn `apps/worker`.** `grep -rn "child_process\|spawn" apps/runtime/src/` chỉ khớp **một comment** trong `model-turn.ts`. `git log -S"spawn" -- apps/runtime/src` không có commit nào từng thêm spawn. Hệ quả: nhánh `task-dispatched` trong `packages/core/src/conductor.ts` chỉ ghi một message "Đang chạy trên …" rồi dừng; không có gì chạy tiếp.
2. **Capability không bao giờ `usable`.** `apps/runtime/src/services.ts` đăng ký mọi capability với `readiness` toàn `false` và `blockedReason: "the pack is declared but no worker has loaded it on this node"`. `listCapabilitySummaries({usableOnly:true})` lọc theo `isUsable(readiness)`, nên luôn trả rỗng. Nhánh dispatch vì thế gần như không đạt tới được.
3. **Không có route để thoát khỏi trạng thái park.** `apps/runtime/src/gateway.ts` phục vụ `/health`, `/node`, `/capabilities`, `/command`, `/conversations*`, `/datasets/:id`. Thiếu route cho `GET /tasks/:id`, cancel/resume, `POST /approvals/:id/decide`, `GET/POST /install-plans`. Task đang park không có đường được trả lời.
4. **P5 pipeline còn là `TODO(P5)`** ở `packages/capability-host/src/index.ts:185` (quarantine download, lock dependency, verify checksum, isolated build).

Về **khả năng bị khai thác**, không phải chỉ là thiếu tính năng: pipeline install hiện **inert**, không phải lỗ hổng đang mở — không có route và không có caller nào gọi nó. Cùng lý do, đường approval (`packages/core/src/consent.ts` + bảng `approvals`) chưa từng được chạy ở runtime dù logic đã có test. Đây là **khoảng trống năng lực**, không phải đường tấn công. Nhưng nó cũng có nghĩa: phần lớn cơ chế an toàn của blueprint đã được viết mà **chưa từng bị chạy thật lần nào**.

---

## 4. J1 đang chạy tới đâu

J1 trong `docs/scope-lock.md` §7 là "tò mò": mở app → thử ngay → tương tác chart/map/note mẫu → pin → hiểu cách chat, không cần API key. 8 e2e test phủ đúng đường đó, cộng thêm kiểm tra token và trạng thái chưa auth.

Điều J1 **không** phủ: J1 không cần execution loop, nên nó chạy được dù §3 chưa xong. J2 (calendar thật), J3 (cài thứ đang thiếu), J4 (nhiều máy), J5 (custom mini-app), J6 (browser/computer) đều phụ thuộc vào loop hoặc transport chưa có. Báo cáo "1/6 journey" nên đọc là: **chỉ J1 có ý nghĩa, và nó là journey duy nhất không cần thứ đang thiếu.**

---

## 5. Độ phủ theo từng scope item (V01–V18)

Đối chiếu cột "acceptance boundary" của `docs/scope-lock.md` §4 với file thật.

| ID | Feature | % | Đã có thật | Còn thiếu |
|---|---|---|---|---|
| V01 | Conversation client | 70 | Timeline, composer, pins, 10 host-owned block, React dùng chung, 8 e2e pass | Voice trong client; desktop shell chưa nối vào node thật |
| V02 | Portable runtime | 60 | Boot, identity, SQLite + 7 migration, health/node/capabilities, backup `VACUUM INTO` + verify + version guard | OCI image non-root, native service installer, Unix-socket transport, HTTPS |
| V03 | Persistent task/session runtime | 45 | State machine đầy đủ, success gating, evidence, conductor đã wire, worker CLI + budget + env allowlist | **Runtime không spawn worker**; không có worker pool; không route cancel/resume/steer |
| V04 | Trusted node linking | 40 | Envelope validation, sender-mismatch refusal, invite single-use, revoke | **Không có transport** (chỉ HTTP loopback, không TLS listener/client); không có flow pair trong chat; chưa chạy 2 node |
| V05 | Remote collaboration | 45 | At-least-once + dedup, sequence gap, grant narrowing, outbox/inbox | Chưa delegation giữa 2 process thật; chưa blob/artifact transfer |
| V06 | Workspace registry | 60 | Node-qualified ref, locality routing, lease + fencing epoch, git worktree lock/dirty-tree (T15/T16, test trên repo thật) | Alias/root registry chưa đủ; **chưa có explicit file transfer** |
| V07 | Capability platform | 65 | Registry + readiness độc lập, lazy schema, node resolution, **MCP stdio transport thật** (14 test, server chạy như child process thật) | MCP HTTP/SSE transport; native facet execution |
| V08 | Conversational install | 45 | Manifest validation, ranking candidate, plan digest, join-or-create, consent bound, generation/rollback | **Quarantine download + isolated build (`TODO(P5)`)**, healthcheck, route gateway để chạy từ chat |
| V09 | Credential/auth setup | 55 | Vault AES-256-GCM không có getter plaintext, redaction, PKCE, constant-time state, scope subset, endpoint allowlist | Token exchange live; UI consent/host field; route revoke/reauth |
| V10 | Reference integration (Calendar) | 50 | Scope planning, timezone, agenda, conflict, write-outcome, freshness labeling | Account thật (blocked: cần OAuth client đã đăng ký) |
| V11 | Rich built-ins | 25 | 5 renderer (line, bar, donut→bar, table sortable, note) + text fallback + a11y + freshness | **13/18 nhóm catalog chưa có** (Layout, Choice, Form, Lists, Diagram, Map, Calendar, Timeline, Files, Media, Call, Browser/computer, Conversation-view) |
| V12 | Custom widgets | 45 | Bridge codec, nonce, sandbox/CSP policy, props validation, mcp-app fixture + note-widget editor | Runtime mini-app trong sản phẩm; composition do chat sinh; install boundary |
| V13 | Pins | 65 | Persistence, single-live-owner, restore không autoplay, browser-verified | Media surface thật (đang là fixture tổng hợp) |
| V14 | Browser Use | 65 | Playwright driver thật: managed profile, origin policy, staleness, local stop, takeover input, 22 test (driver/injection/submit-once) | Preview/takeover UI; approve download end-to-end; install engine theo nhu cầu |
| V15 | Computer Use | 25 | Contract, permission tách capture/input, containment label, target validation, local stop | **Không có native binding** (cần signed bundle + TCC); Linux virtual desktop + preview |
| V16 | Onboarding/personalization | 60 | Quick play + nhãn sample host-owned, checkpoint, needs, preference undo, 18 test | UI cho nhánh setup theo nhu cầu; install plan tối thiểu |
| V17 | Live voice | 30 | State machine, transcript assembly, intent routing, media focus, mute/end semantics, barge-in routing | **WebRTC/GPT-Live transport** (cần provider account) |
| V18 | Operations/security | 55 | 7 migration, backup/restore có version guard, budget/ceiling, redaction, dedup, secret scan trong CI | Upgrade/drain, failure injection, soak, telemetry, release artifact |

Trung bình không trọng số ≈ **53%**. Quy mô repo: 21 990 dòng `src`, 7 909 dòng test, 14 commit.

**Tầng dữ liệu (bổ sung sau review):** `packages/storage/src/migrate.ts` tạo **hơn 30 bảng** (tasks, runs, evidence, effects, approvals, leases, install_plans, package_generations, capabilities, connections, auth_transactions, widget_instances, snapshots, pins, action_bindings, action_invocations, messages, artifacts, datasets, preferences, onboarding_checkpoints, usage_counters, emergency_stops, voice_sessions, …) với **7 migration forward-only**, và `storage.spec.ts` (18 test) phủ idempotency, backup/restore, single-writer lease, home authority. Tầng này vững hơn mức trung bình của repo.

---

## 6. Docs đang lệch khỏi code ở đâu

**Tài liệu quy chiếu cho độ phủ là `docs/conformance-traceability.md`** (bảng T và V). README, `manifest.json` và báo cáo verification cũ chỉ là mô tả phụ trợ — chúng lệch, còn bảng T/V thì khớp commit `b9d62c3`.

| Tài liệu | Nói gì | Sự thật trong code |
|---|---|---|
| `README.md` §Status | "44 pass, 4 blocked, 24 not-implemented"; "184 tests" | 64/4/4 và 484 test |
| `README.md` §What does not work yet | "React conversation client … conductor and a live worker pool" chưa có | `packages/conversation-client` (≈3.3k LOC) + `apps/web` + `apps/desktop` + `apps/worker` đã có, e2e 8/8 pass |
| `plans/reports/verification-260916-p0-p10-bootstrap.md` | "`apps/web`, `apps/desktop`, `apps/worker` và cả 3 `examples/` không có source file"; "`pnpm build` không build gì" | Tất cả đều có source; `apps/web` build ra 297 kB JS |
| `docs/manifest.json` `status` | "Architecture/design documents; no application implementation" | Đã có implementation |
| `docs/conformance-traceability.md` cột diễn giải V | V01 "Voice and the desktop host are not built"; V03 "conductor … not wired"; V14 "injection fixture not built"; V16 "preference undo not built" | Desktop shell có + 20 test bảo mật; conductor đã wire (`gateway.ts:231`); `injection.spec.ts` có 6 test; `preferences.ts` có `undoPreference`/`undoOnboardingChanges` |
| `apps/web/src/index.ts` | `@implementation-status stub`, `WEB_CLIENT_STATUS = "not-implemented"` | App đã implement và chạy |
| `apps/runtime/src/node.ts:133` | `@implementation-status stub` cho Unix-socket transport | Đúng một nửa: HTTP loopback đã wire, socket thật sự chưa |

Riêng T44 ghi thêm "e2e asserts the text fallback renders" — trong `apps/web/e2e/j1.spec.ts` không có assertion nào cho text fallback. Evidence chính (`seams.spec`) vẫn đúng; phần e2e là nói quá.

**Lỗi cấu hình:** `pnpm-workspace.yaml` `allowBuilds` có hai giá trị còn là placeholder. Đã xác nhận `allowBuilds` **là key hợp lệ** trong pnpm 12.4.2 (`corepack pnpm config list` hiển thị nó, cùng `blockExoticSubdeps`, `minimumReleaseAge`, `dangerouslyAllowAllBuilds`), và nó chấp nhận string làm giá trị:

```yaml
'@google/genai': set this to true or false
protobufjs: set this to true or false
```

Comment ngay trên nói hai package này "deliberately left unlisted", nên **nhiều khả năng cách sửa đúng là xoá hai dòng đó**, không phải điền `true`. Chưa reproduce được vì không chạy `pnpm install` — xem §7.

**Vấn đề môi trường:** `pnpm` self-switch sang `12.4.2` hỏng (`.../.tools/pnpm/12.4.2/bin/pnpm ENOEXEC`), nên `pnpm verify` và `pnpm test:e2e` fail ngay ở bước khởi động — **không phải lỗi code**. Đã chạy thẳng binary trong `node_modules`; riêng e2e cần một shim `pnpm` trỏ về `corepack pnpm` để `webServer.command` trong `playwright.config.ts` chạy được. Đây là **giới hạn độ tin cậy**: bất kỳ ai khác (kể cả CI) cũng không reproduce được kết quả xanh này bằng lệnh chuẩn.

---

## 7. Chưa xác minh — đọc trước khi trích số

- **Chưa chạy `pnpm install`**, nên tác động thật của placeholder `allowBuilds` chưa được reproduce. Cố ý không chạy để không ghi đè `node_modules` trong khi một agent khác đang làm việc trong repo này.
- **Chưa chạy một lượt live model có chủ đích** (`.env` cấu hình `deepseek/deepseek-v4-flash`; tốn quota của operator). Evidence hiện có là `plans/reports/evidence/app-10-live-model-in-app.png`. Vì vậy "live provider smoke" là **inferred từ cấu hình + evidence sẵn có**, không phải tự kiểm chứng trong session này.
- **Chưa đối chiếu từng dòng evidence của 64 test PASS** trong ledger với spec tương ứng. Đã spot-check T15/T16 (worktree), T53–T56 (browser), T49/T62 (e2e) — khớp. Các dòng còn lại lấy nguyên theo ledger.
- **Chưa chạy được `pnpm verify` / `pnpm test:e2e`** như lệnh chính thức (xem §6).
- **Con số LOC/commit** là ảnh chụp tại `55cd7e4`; agent đang commit song song nên chúng sẽ cũ đi.
- **Không kết luận gì về hiệu năng.** `docs/implementation-plan.md` §16 có 10 chỉ tiêu p95 nhưng repo không có benchmark nào; mọi chỉ tiêu đều "chưa phải số đo" theo đúng câu chữ của tài liệu.

---

## 8. Việc còn phải làm — xếp theo đòn bẩy

### Nhóm A — Mở khoá vòng lặp thực thi (đòn bẩy lớn nhất)

1. **Runtime spawn worker + worker pool.** Route dispatch → spawn/giữ worker → ghi `runs`/`evidence` → `checkSuccessPreconditions`. Không có bước này thì mọi thứ khác chỉ là contract.
2. **Gateway route cho task/approval/install:** `GET /tasks/:id`, `POST /tasks/:id/cancel|resume`, `POST /approvals/:id/decide`, `GET/POST /install-plans`. Không có route thì consent/install UI không thể tồn tại.
3. **Install pipeline thật (P5).** Quarantine download, lock dependency, verify digest, isolated build, healthcheck, activate. Đây là điều kiện để capability trở thành `usable` lần đầu.
4. **Event streaming thay polling.** `packages/conversation-client/src/api.ts` chỉ dùng `fetch` + cursor. P1.5 yêu cầu WSS với reconnect snapshot/cursor.

### Nhóm B — Transport giữa các node (P4, mở J4)

5. HTTPS/TLS listener + client cho `NodeLink` (hiện chỉ là receive path thuần logic, 271 LOC).
6. Pairing/inspect/revoke bằng chat; chạy thật local + 2 VPS (gate P4).
7. Blob/artifact transfer có digest, scope, quota (V06).
8. Unix-socket transport cho desktop helper (`TODO(P1)` ở `apps/runtime/src/node.ts`).

### Nhóm C — Integration và auth thật (P7, mở J2)

9. OAuth token exchange + system-browser flow (T32 blocked).
10. Google Calendar live (T72 blocked).
11. UI consent/credential host field + revoke/reauth.
12. T34: kênh nhập secret an toàn đầu-cuối trong chat.

### Nhóm D — Compute surface (P8, mở J6)

13. macOS native driver: bundle có ký + TCC (Accessibility và Screen Recording tách biệt).
14. Linux virtual desktop + preview/takeover + isolation (T61 not-implemented).
15. Preview/takeover UI cho browser.
16. T23 blocked: cần artifact native extension thật để chứng minh chặn sai OS/arch.

### Nhóm E — Widget catalog (P6, mở J5)

17. 13 nhóm catalog còn lại; mỗi nhóm ít nhất một fixture chạy được (gate P6).
18. Mini-app runtime trong sản phẩm: build cách ly → preview/test/approve → install.
19. Composition do chat sinh (agent ghép component + action descriptor).
20. Media/call surface thật thay fixture.

### Nhóm F — Voice (P9, mở T66, T68)

21. GPT-Live adapter + transport; barge-in/correction thật; semantic action thống nhất giữa voice và click (T66); mute/end dừng capture/playback thật (T68).

### Nhóm G — Release hardening (P10)

22. OCI image non-root + native service packaging; signing/notarization macOS; release artifact + checksum + SBOM.
23. Failure injection qua GUI/main/runtime/worker/peer/tool/iframe; soak test; upgrade/drain.
24. Telemetry + redaction, supported-platform matrix, known-limitations.

### Nhóm H — Vệ sinh tài liệu và môi trường (rẻ, nên làm ngay)

25. Cập nhật `README.md` §Status và §What does not work yet theo số thật.
26. Cập nhật cột diễn giải V của `docs/conformance-traceability.md` (V01, V03, V14, V16 sai); bỏ clause e2e sai ở T44.
27. Sửa `status` trong `docs/manifest.json` — lưu ý file này có sha256 trong manifest nên phải cập nhật cả hai.
28. Bỏ `@implementation-status stub` / `WEB_CLIENT_STATUS` trong `apps/web/src/index.ts`.
29. Xoá hai dòng placeholder trong `pnpm-workspace.yaml`.
30. Đánh dấu `plans/reports/verification-260916-p0-p10-bootstrap.md` là lỗi thời, hoặc thay bằng lần verify mới.
31. Sửa vấn đề `pnpm` self-switch để `pnpm verify` / `pnpm test:e2e` chạy được không cần shim.

---

## 9. Câu hỏi chưa giải quyết

1. **Ai đang commit song song?** `55cd7e4` xuất hiện giữa lúc review; có work list "item 6, group 1/2" không nằm trong repo. Cần biết danh sách item để không trùng việc.
2. **Placeholder `allowBuilds`** là do một lần sửa dở, và có cần chạy `pnpm install` sạch để xác nhận trước khi xoá không?
3. **Có muốn chạy một lượt live model** để có evidence trong session này thay vì dựa vào screenshot `app-10` không?
4. **Thứ tự ưu tiên:** nhóm A (spawn worker + route + install pipeline) hay nhóm B (transport 2 node) trước? Gate P4 ghi cần transport, nhưng nhóm A mở được nhiều T/V hơn với cùng công sức.

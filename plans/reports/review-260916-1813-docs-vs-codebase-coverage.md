# Review — docs vs codebase: độ phủ thực tế và phần còn phải làm

**Ngày:** 2026-09-16 · **Repo:** `/Volumes/GOON/www/digitop/clarkcant` · **Commit khi review:** `55cd7e4` (có thay đổi chưa commit)
**Câu hỏi:** đọc `docs/`, so với codebase xem đã cover bao nhiêu %, còn phải làm gì.

---

## 1. Kết luận ngắn

| Trục đo | Blueprint yêu cầu | Thực tế | % |
|---|---|---|---|
| Acceptance test T01–T72 | 72 | 64 PASS, 4 BLOCKED, 4 NOT-IMPLEMENTED | **89%** |
| Scope item V01–V18 | 18 mục "đầy đủ trong v0.2 beta" | 18 mục đều PARTIAL, **0 mục hoàn thành** | **≈55%** (trung bình có trọng số, xem §4) |
| Golden journey J1–J6 | 6 hành trình end-to-end | J1 chạy thật trong browser; J2–J6 chưa | **≈17%** |
| Phase P0–P10 | 11 phase có gate | P0–P3 gần đủ, P4–P9 chỉ có contract/logic, P10 chưa | **≈40%** |

Con số cần nhấn mạnh: **89% acceptance test không có nghĩa 89% sản phẩm**. 64 test PASS phần lớn là unit/integration test của từng layer, viết để đúng theo luật của chính repo ("a status is never upgraded without the corresponding test appearing alongside it"). Rào cản lớn nhất còn lại không phải là luật nghiệp vụ mà là **transport và vòng lặp thực thi thật**: chưa có node nào tự tìm ra capability còn thiếu → cài → chạy → trả kết quả.

**Vòng lặp cốt lõi đang hở.** `apps/runtime` không spawn `apps/worker` (không có `spawn`/`fork` nào trong `apps/runtime/src`). Capability đăng ký với `readiness` toàn `false` và `blockedReason: "the pack is declared but no worker has loaded it on this node"`, nên `listCapabilitySummaries({usableOnly:true})` luôn rỗng. Hệ quả: mọi task đi vào nhánh `task-parked` hoặc do model trả lời bằng chữ; nhánh `task-dispatched` gần như không đạt tới được, và không có route nào để cài capability hay trả lời một task đang park. J3 ("cài thứ đang thiếu") vì thế chưa thể chạy.

---

## 2. Bằng chứng đã tự chạy trong session này

| Gate | Lệnh | Kết quả |
|---|---|---|
| Repository invariants | `node tools/check-invariants.mjs` | **7/7 PASS** |
| Typecheck (node + web) | `tsc -p tsconfig.json && tsc -p tsconfig.web.json` | PASS, không lỗi |
| Lint | `eslint .` | Sạch |
| Test | `vitest run` | **484 passed / 484**, 32 file spec |
| E2E J1 trong Chromium thật | `playwright test` | **8 passed / 8** (production build + node thật) |
| P0.1 Pi SDK probe | `node packages/pi-adapter/src/probe-cli.ts` | 7 PASS, 2 BLOCKED, 0 FAIL |

Ghi chú về môi trường: `pnpm` self-switch sang `12.4.2` bị hỏng (`.../.tools/pnpm/12.4.2/bin/pnpm ENOEXEC`), nên `pnpm verify` và `pnpm test:e2e` fail ở bước khởi động — **không phải lỗi code**. Đã chạy thẳng binary trong `node_modules`; riêng e2e cần một shim `pnpm` trỏ về `corepack pnpm` để `webServer.command` trong `playwright.config.ts` chạy được. Đáng sửa để CI/lệnh chuẩn không phụ thuộc tình trạng máy.

---

## 3. Docs đang lệch khỏi code ở đâu

Đây là phần quan trọng nhất của câu hỏi "đọc docs rồi so với codebase", vì **docs mô tả một phiên bản cũ hơn chính repo**.

| Tài liệu | Nói gì | Sự thật trong code |
|---|---|---|
| `README.md` §Status | "44 pass, 4 blocked, 24 not-implemented"; "184 tests" | 64/4/4 và 484 test |
| `README.md` §What does not work yet | "React conversation client … conductor and a live worker pool" chưa có | `packages/conversation-client` (≈3.3k LOC) + `apps/web` + `apps/desktop` + `apps/worker` đã có, e2e 8/8 pass |
| `plans/reports/verification-260916-p0-p10-bootstrap.md` | "`apps/web`, `apps/desktop`, `apps/worker` và cả 3 `examples/` không có source file"; "`pnpm build` không build gì" | Tất cả đều có source, `apps/web` build ra `dist/` 297 kB JS |
| `docs/manifest.json` `status` | "Architecture/design documents; no application implementation" | Đã có implementation |
| `docs/conformance-traceability.md` cột "What is real and what is not" | V01 "Voice and the desktop host are not built"; V03 "conductor … not wired"; V14 "injection fixture not built"; V16 "preference undo not built" | Desktop shell có + 20 test bảo mật; conductor đã wire (`apps/runtime/src/gateway.ts:231`); `injection.spec.ts` có 6 test; `preferences.ts` có `undoPreference`/`undoOnboardingChanges` |
| `apps/web/src/index.ts` | `@implementation-status stub`, `WEB_CLIENT_STATUS = "not-implemented"` | App đã implement và chạy |
| `apps/runtime/src/node.ts:133` | `@implementation-status stub` cho Unix-socket transport | Đúng một nửa: HTTP loopback đã wire, socket thật sự chưa |

Bảng T01–T72 và summary 64/4/4 thì khớp với commit `b9d62c3`. Chỉ có phần diễn giải V01–V18 là cũ. Riêng T44 ghi thêm "e2e asserts the text fallback renders" — trong `apps/web/e2e/j1.spec.ts` không có assertion nào cho text fallback; evidence chính (`seams.spec`) vẫn đúng, phần e2e là nói quá.

**Lỗi cấu hình thật:** `pnpm-workspace.yaml` `allowBuilds` có hai giá trị còn là placeholder:

```yaml
'@google/genai': set this to true or false
protobufjs: set this to true or false
```

Comment ngay trên nói hai package này "deliberately left unlisted", nên cách sửa đúng là xoá hai dòng đó, không phải điền `true`. Giá trị string nằm ở chỗ pnpm mong boolean. Chưa xác minh được tác động lúc install (không chạy `pnpm install` để tránh ghi đè `node_modules` khi có agent khác đang làm việc trong repo này).

---

## 4. Độ phủ theo từng scope item (V01–V18)

Đánh giá dựa trên "acceptance boundary" ở `docs/scope-lock.md` §4, đối chiếu file thật.

| ID | Feature | % | Đã có thật | Còn thiếu |
|---|---|---|---|---|
| V01 | Conversation client | 70 | Timeline, composer, pins, blocks host-owned, React dùng chung, 8 e2e pass | Voice trong client; desktop host chưa nối vào node thật |
| V02 | Portable runtime | 60 | Boot, identity, SQLite + 7 migration, health/node/capabilities, backup `VACUUM INTO` + verify | OCI image non-root, native service installer, Unix-socket transport, HTTPS |
| V03 | Persistent task/session runtime | 55 | State machine đầy đủ, success gating, evidence, conductor đã wire, worker + budget + env allowlist | **Runtime không spawn worker**; không route cancel/resume/steer; không worker pool |
| V04 | Trusted node linking | 40 | Envelope validation, sender mismatch, invite single-use, revoke | **Không có transport** (chỉ HTTP loopback, không TLS listener/client); không có flow pair trong chat; chưa chạy 2 node |
| V05 | Remote collaboration | 45 | At-least-once + dedup, sequence gap, grant narrowing, outbox/inbox | Chưa delegation giữa 2 process thật; chưa blob/artifact transfer |
| V06 | Workspace registry | 60 | Node-qualified ref, locality routing, lease + fencing epoch, git worktree lock/dirty-tree (T15/T16) | Alias/root registry chưa đủ; **chưa có explicit file transfer** |
| V07 | Capability platform | 65 | Registry + readiness độc lập, lazy schema, node resolution, **MCP stdio transport thật** (14 test với server child-process) | MCP HTTP/SSE transport; native facet execution |
| V08 | Conversational install | 45 | Manifest validation, ranking candidate, plan digest, join-or-create, consent bound, generation/rollback | **Quarantine download + isolated build (`TODO(P5)`)**, healthcheck, và route gateway để chạy từ chat |
| V09 | Credential/auth setup | 55 | AES-256-GCM vault không có getter plaintext, redaction, PKCE, constant-time state, scope subset, endpoint allowlist | Token exchange live; UI consent/host field; revoke/reauth route |
| V10 | Reference integration (Calendar) | 50 | Scope planning, timezone, agenda, conflict, write-outcome, freshness labeling | Account thật (blocked OAuth client) |
| V11 | Rich built-ins | 25 | 5 renderer (line, bar, donut→bar, table sortable, note) + text fallback + a11y + 10 host card | **13/18 nhóm catalog chưa có** (Layout, Choice, Form, Lists, Diagram, Map, Calendar, Timeline, Files, Media, Call, Browser/computer, Conversation-view) |
| V12 | Custom widgets | 45 | Bridge codec, nonce, sandbox/CSP policy, props validation, mcp-app fixture + note-widget editor | Runtime mini-app trong sản phẩm; composition do chat sinh; install boundary |
| V13 | Pins | 65 | Persistence, single-live-owner, restore không autoplay, browser-verified | Media surface thật (đang là fixture tổng hợp) |
| V14 | Browser Use | 65 | Playwright driver thật: managed profile, origin policy, staleness, local stop, takeover input, 22 test (driver/injection/submit-once) | Preview/takeover UI; approve download end-to-end; install engine theo nhu cầu |
| V15 | Computer Use | 25 | Contract, permission tách capture/input, containment label, target validation, local stop | **Không có native binding** (cần signed bundle + TCC); Linux virtual desktop + preview |
| V16 | Onboarding/personalization | 60 | Quick play + nhãn sample host-owned, checkpoint, needs, preference undo, 18 test | UI cho nhánh setup theo nhu cầu; install plan tối thiểu |
| V17 | Live voice | 30 | State machine, transcript assembly, intent routing, media focus, mute/end semantics, barge-in routing | **WebRTC/GPT-Live transport** (cần provider account) |
| V18 | Operations/security | 55 | 7 migration, backup/restore có version guard, budget/ceiling, redaction, dedup, secret scan CI | Upgrade/drain, failure injection, soak, telemetry, release artifact |

Trung bình ≈ **52–55%**. Nếu tính theo LOC: 21 990 dòng `src` + 7 909 dòng test, 14 commit.

---

## 5. Việc còn phải làm — xếp theo đòn bẩy

### Nhóm A — Mở khoá vòng lặp thực thi (đòn bẩy lớn nhất, mở nhiều V và T cùng lúc)

1. **Runtime spawn worker + worker pool.** Hiện `task-dispatched` chỉ là một message; chưa có gì chạy `apps/worker`. Cần: route dispatch → spawn/giữ worker → ghi `runs`/`evidence` → `checkSuccessPreconditions`.
2. **Gateway route cho task/approval/install.** Hiện chỉ có `/health`, `/node`, `/capabilities`, `/command`, `/conversations*`, `/datasets/*`. Thiếu: `GET /tasks/:id`, `POST /tasks/:id/cancel|resume`, `POST /approvals/:id/decide`, `GET/POST /install-plans`. Không có route thì consent/install UI không thể tồn tại.
3. **Install pipeline thật (P5).** Quarantine download, lock dependency, verify digest, isolated build, healthcheck, activate — đang là `TODO(P5)`. Đây là điều kiện để capability trở thành `usable` và để nhánh dispatch chạy lần đầu.
4. **Event streaming thay polling.** `packages/conversation-client/src/api.ts` chỉ dùng `fetch` + cursor. P1.5 yêu cầu WSS với reconnect snapshot/cursor.

### Nhóm B — Transport giữa các node (P4, mở J4)

5. HTTPS/TLS listener + client cho `NodeLink` (`packages/node-link` mới chỉ là receive path thuần logic).
6. Pairing/inspect/revoke bằng chat, và chạy thật local + 2 VPS (gate P4).
7. Blob/artifact transfer có digest, scope, quota (V06).
8. Unix-socket transport cho desktop helper (đã ghi `TODO(P1)` ở `apps/runtime/src/node.ts`).

### Nhóm C — Integration và auth thật (P7, mở J2)

9. OAuth token exchange + system-browser flow (T32 blocked: cần OAuth client đã đăng ký).
10. Google Calendar live (T72 blocked: cần vendor account).
11. UI consent/credential host field + revoke/reauth.
12. T34: kênh nhập secret an toàn đầu-cuối trong chat.

### Nhóm D — Compute surface (P8, mở J6)

13. macOS native driver: bundle có ký + TCC (Accessibility/Screen Recording tách biệt).
14. Linux virtual desktop + preview/takeover + isolation (T61 not-implemented).
15. Preview/takeover UI cho browser.
16. T23 blocked: cần artifact native extension thật để chứng minh chặn sai OS/arch.

### Nhóm E — Widget catalog (P6, mở J5)

17. 13 nhóm catalog còn lại; ít nhất mỗi nhóm một fixture chạy được (gate P6).
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

25. Cập nhật `README.md` §Status và §What does not work yet theo số thật (484 test, client đã có).
26. Cập nhật cột "What is real and what is not" của `docs/conformance-traceability.md` (V01, V03, V14, V16 sai), và bỏ clause e2e sai ở T44.
27. Sửa `status` trong `docs/manifest.json` (đang ghi "no application implementation") — lưu ý file này có hash trong manifest nên phải cập nhật cả sha256.
28. Sửa `apps/web/src/index.ts`: bỏ `@implementation-status stub`, `WEB_CLIENT_STATUS = "not-implemented"`.
29. Xoá hai dòng placeholder trong `pnpm-workspace.yaml` `allowBuilds`.
30. Đánh dấu `plans/reports/verification-260916-p0-p10-bootstrap.md` là đã lỗi thời, hoặc thay bằng lần verify mới.
31. Sửa luôn vấn đề `pnpm` self-switch để `pnpm verify` / `pnpm test:e2e` chạy được không cần shim.

---

## 6. Câu hỏi chưa giải quyết

1. **Ai đang commit song song?** Trong lúc review, `55cd7e4` xuất hiện và các file uncommitted đổi giữa hai lần đọc, kèm evidence `app-11-settings.png` (18:10). Có một work list "item 6, group 1/2" không nằm trong repo. Cần biết danh sách item đó để không trùng việc.
2. **`pnpm-workspace.yaml` placeholder** có từ trước hay do một lần sửa dở? Cần xác nhận trước khi xoá.
3. **Live model path**: `deepseek/deepseek-v4-flash` được cấu hình trong `.env` (đã gitignore). Chưa chạy một lượt thật có chủ đích vì tốn quota; evidence hiện có là `plans/reports/evidence/app-10-live-model-in-app.png`. Có muốn tôi chạy một lượt live để có evidence trong session này không?
4. **Thứ tự ưu tiên**: nhóm A (spawn worker + route + install pipeline) hay nhóm B (transport 2 node) trước? Gate P4 ghi cần transport, nhưng nhóm A mở được nhiều T/V hơn với cùng công sức.

# Review PR #157: cài package từ xa (git/npm) và suy ra capability được cấp

Checkout: `.claude/worktrees/agent-aa36d1943279c7e27`, diff so với origin/main, 20 file, +1013/-49.
Test focused (package-fetch, install-consent, package-install-route): 32/32 pass. Test chỉ phủ happy path và digest mismatch. Không có test nào cho URL độc hại, symlink, tar độc hại, timeout hay việc render sau khi cài.

## Critical

### C1. Chèn tham số vào `git fetch` qua URL, dẫn tới RCE
`packages/core/src/package-fetch.ts:132`: `spawnSync("git", ["-C", dest, "fetch", "--quiet", "--depth", "1", input.url, input.ref])`. Không có `--` phân cách, và `url` chỉ được validate là `z.string().min(1).max(1000)` (`packages/contracts/src/directory.ts:35`). `ref` bị regex 40-hex chặn nên an toàn, còn `url` thì không.
- Đã kiểm chứng thực tế (git 2.54): `git fetch --quiet --depth 1 "--upload-pack=touch X;false" <sha>` tạo ra file X. Nghĩa là lệnh tùy ý chạy với quyền của runtime.
- Kịch bản: một entry trong directory (curated index, publisher ghi) có `source: {kind:"git", url:"--upload-pack=sh -c '…'", ref:"<40 hex>"}`. User nói "install X" ở chế độ Autonomous, `installPackage` cho chạy luôn, và lệnh chạy trước khi digest được so sánh.
- Cũng không có allowlist cho scheme: `file://`/đường dẫn local (test dùng chính cái này), `ssh://`, `ext::` (bị chặn chỉ nhờ default `protocol.allow` của git).
- Cách sửa: thêm `"--"` trước url; refuse url bắt đầu bằng `-`; chỉ cho `https:` (có thể thêm `file:` sau cờ dev); truyền `-c protocol.allow=never -c protocol.https.allow=always -c core.hooksPath=/dev/null -c core.symlinks=false`; tắt LFS smudge bằng `GIT_LFS_SKIP_SMUDGE=1` và `-c filter.lfs.smudge= -c filter.lfs.process=`.

### C2. `digestOfDirectory` đi theo symlink, trái với comment "symlinks skipped"
`package-fetch.ts:79-81` dùng `statSync`, mà `statSync` follow link, nên `isSymbolicLink()` luôn false (đã kiểm chứng: symlink tới `/` cho ra `isSymbolicLink=false, isDirectory=true`). Git checkout tạo symlink thật (`core.symlinks` mặc định true trên macOS/Linux), bsdtar/GNU tar cũng extract symlink entry.
- Kịch bản 1 (DoS): repo hoặc tarball chứa `x -> /`. Lúc cài, runtime hash toàn bộ filesystem một cách đồng bộ, event loop treo.
- Kịch bản 2: `a -> .` tạo vòng lặp, đệ quy tới khi ENAMETOOLONG/ELOOP. Lỗi này không phải ENOENT nên `throwIfNoEntry:false` không nuốt, exception bị throw ra khỏi `installPackage` thay vì trả về refusal có tên.
- Kịch bản 3: digest bao cả byte nằm ngoài package (`~/.ssh/...`), trái với yêu cầu "digest computed over exactly the bytes installed". Việc serve file vẫn an toàn nhờ `readPackageFile` có kiểm tra containment. Nhưng digest không còn mô tả artifact nữa, và publisher có thể làm digest phụ thuộc vào máy.
- Cách sửa: dùng `lstatSync` và refuse (không bỏ qua) mọi symlink hoặc hardlink trong artifact từ xa. Với tar, cân nhắc refuse entry type symlink/hardlink trước khi extract.

## High

### H1. Package cài từ xa không render được, nên tính năng không thực sự ship
`fetchRemoteArtifact` chỉ đổi `source` thành `local` trong bộ nhớ (`apps/runtime/src/application/package-install.ts:416,485`). Index trên đĩa vẫn giữ `git`/`npm`. Hai chỗ phía sau đều đọc lại index:
- `findIsolatedFrame` làm `if (entry.source.kind !== "local") continue;` (`packages/core/src/widget-frame.ts:69`);
- route files `GET /packages/:id/:v/files/*` đọc `readDirectoryIndex` rồi gọi `readPackageFile`, hàm này refuse `NOT_A_LOCAL_PACKAGE` (`apps/runtime/src/routes/packages.ts:218-235`).
- Kịch bản: cài `git` thành công, trả 200 và activate generation. Sau đó widget báo "no package declares" hoặc 409, không bao giờ mở được frame. User bị báo cài xong mà không dùng được, vi phạm "never invent success". Test route chỉ assert kết quả install, không render.
- Cách sửa: lưu một mapping `packageId@version -> cache path + digest` đã verify (ví dụ trong generation hoặc bảng riêng), và cho `findIsolatedFrame` cùng route files resolve qua mapping đó.

### H2. Grant được suy từ `requestedCapabilityRefs` do client gửi lên, không từ manifest
`package-install.ts:504-510` truyền `requested: request.requestedCapabilityRefs`, giá trị này lấy thẳng từ body POST (`routes/packages.ts:164-169`). Manifest trong artifact vừa fetch không hề được đọc.
- Kịch bản: ở Autonomous, lane `isolated-ui` thuộc category `local-write` nên được execute. Client gửi `requestedCapabilityRefs: ["<ref bất kỳ>"]` thì ref đó thành `grantedCapabilities` của plan và generation (`install-lifecycle.ts:236`). Đây đúng là kiểu "client forge grant" mà issue #93 muốn chặn, chỉ đi qua một field khác.
- Được giảm nhẹ một phần: frame nhận `requested(manifest) ∩ granted` (`widget-frame.ts:710-716`, `conversations.ts:158`), nên ref manifest không xin thì không tới được frame. Nhưng generation, plan và audit vẫn ghi grant giả. Mọi consumer tương lai đọc `generation.grantedCapabilities` sẽ tin nó.
- Theo chiều ngược lại: client không gửi gì thì granted rỗng, và manifest xin gì frame cũng không có gì. Hành vi thật do client quyết định, không do policy.
- Cách sửa: `requested = readPackage(resolvedEntry.source.path).manifest.requestedCapabilities`, bỏ field trong body hoặc chỉ dùng nó để thu hẹp.

### H3. `riskTier` lấy từ lời khai của directory, không phải lane tính từ artifact
`package-install.ts:506` dùng `riskTier: entry.riskTier`. Chỉ một dòng khai `riskTier:"isolated-ui"` trên một package có facet `service`/`trusted-native` là hạ category từ `destructive` xuống `local-write`, và capability được grant tự động ở Autonomous. Comment trong `install-consent.ts:32` còn tự ghi `riskLaneFor(entry.isolations)`. Cách sửa: tính lane từ `entry.isolations`, tốt nhất là từ manifest đã fetch, rồi đối chiếu với `riskTier` và refuse nếu lệch.

### H4. `spawnSync` git không có timeout, chặn toàn bộ gateway
`package-fetch.ts:128-147`: clone chạy đồng bộ trong request handler nay đã là async. Một remote chậm hoặc treo (hoặc SSH đang hỏi host key hay password) làm đứng event loop của cả node: mọi conversation, stream và voice đều dừng. Cách sửa: dùng `spawn` async với `timeout`, thêm `GIT_TERMINAL_PROMPT=0` và `GIT_SSH_COMMAND` với `BatchMode=yes`.

### H5. Tarball npm: không giới hạn kích thước, không timeout
`package-fetch.ts:171,196,203`: `fetch` không có `AbortSignal.timeout`, `arrayBuffer()` không giới hạn byte, và sau khi verify thì `tar -xzf` không có giới hạn độ lớn khi giải nén (gzip bomb). Integrity chỉ đảm bảo byte khớp với packument, không đảm bảo byte vô hại. Cách sửa: giới hạn Content-Length/stream (ví dụ 50 MB), giới hạn tổng kích thước và số entry khi extract, refuse entry symlink/hardlink/device.
- Ghi chú đã kiểm tra: integrity được verify trước khi extract (dòng 205 chạy trước 223). Redirect sang host khác không phá integrity vì hash đến từ cùng một packument. Path traversal `..`/absolute bị bsdtar/GNU tar chặn theo mặc định, nhưng đó là hành vi của tar chứ không phải code tự kiểm tra, và C2 vẫn đúng cho symlink.

## Medium

### M1. `needsApproval`/`denied` được tính rồi bỏ đi
`deriveGrantedCapabilities` trả về 3 tập, nhưng `package-install.ts:413` chỉ dùng `granted`. Ở Guarded/Ask, install vẫn 200 và activate, capability bị âm thầm loại, không tạo approval và response không nói gì. Frame chạy thiếu capability mà không ai biết lý do, vi phạm "never invent permission state" và yêu cầu error copy. Cách sửa: trả `needsApproval`/`denied` trong response, hoặc gọi `requestApproval` cho từng capability.

### M2. Generation cũ không có `grantedCapabilities` nên mất capability sau khi nâng cấp
Schema bắt buộc field này (`contracts/src/install.ts:647`), nhưng `activeGeneration` chỉ `parseJson` không validate (`install-lifecycle.ts:296`), nên với row cũ thì giá trị là `undefined`, và `brokeredCapabilities(req, undefined)` trả `[]`. Không crash (fail-closed). Nhưng mọi widget đã cài trước PR này, vốn nhận đủ `requestedCapabilities`, sẽ mất toàn bộ capability ngay lúc nâng cấp, không có migration hay thông báo. Rollback về generation cũ cũng cho kết quả tương tự. Cần quyết định: backfill hoặc thông báo reinstall, hoặc ghi rõ trong changelog. Consumer nào dùng `packageGenerationSchema.parse` trên row cũ sẽ throw.

### M3. Cache key chung giữa các package, và `rmSync` xóa artifact đang dùng
Cache git đặt tại `cacheRoot/git/<ref>` (`package-fetch.ts:121`), không kèm URL. Hai package từ hai URL khác nhau mà cùng commit (fork/mirror) dùng chung thư mục. Lần fetch sau `rmSync` rồi ghi đè thư mục mà plan hoặc generation trước đang trỏ vào (source.path). Nếu H1 được sửa bằng cách serve từ cache path, việc cài lại hay cài package kia sẽ xóa hoặc thay byte của package đang live dưới cùng digest. Tương tự, `npm/<name>-<version>` bị xóa mỗi lần cài lại. Cách sửa: key theo digest (content-addressed), ghi vào thư mục tạm rồi `rename` nguyên tử, không bao giờ xóa thư mục đang được tham chiếu.

### M4. Effect được ghi "executed" trước khi fetch có thể fail
`recordEffectExecution` (`package-install.ts:334-343`) chạy trước `fetchRemoteArtifact` (482). Fetch hoặc digest mismatch trả 400/409 nhưng audit vẫn ghi install đã thực thi, không có bản ghi kết quả. Nên ghi outcome (refused) hoặc fetch trước rồi mới ghi.

## Low

- L1. `exclude: [".git"]` loại theo *tên ở mọi cấp* (`package-fetch.ts:77`), nên file hoặc thư mục `.git` lồng bên trong artifact không được hash nhưng vẫn nằm trên đĩa. Nên chỉ loại `.git` ở gốc.
- L2. Message lỗi echo `stderr` của git và URL nguyên văn ra response (`package-fetch.ts:137`). URL có credential (`https://user:token@…`) sẽ lộ ra client. Nên redact userinfo.
- L3. `requestedCapabilityRefs` được cast mà không validate (`package-install.ts:505`). Ref sai định dạng làm `capabilityRefSchema.parse` throw trong `install-from-source.ts:118` thay vì trả 400. Lỗi có từ trước, nhưng nay chạy trong async nên trở thành promise rejection.

## Câu hỏi findEntry (`package-sources.ts:80,95,148-150`)
`findEntry` so `entry.packageId === source.url` (git) hoặc `=== source.name` (npm). Với remote install trong PR này, lỗi này **không bị kích hoạt**: `installPackage` tự preflight rồi đổi entry sang `local` trước khi gọi `installFromEntry` (comment ở dòng 432-442). Nhánh local không dùng `findEntry`. Tuy nhiên nó **vẫn là bug thật cho mọi caller khác** của `resolvePackageSource` với source git/npm, ví dụ `installFromSource` trực tiếp hoặc tool agent. Một entry git có `packageId:"acme.chart"` và `url:"https://github.com/acme/chart"` luôn nhận `NOT_IN_DIRECTORY`. Với npm, nó chỉ đúng khi packageId trùng tên npm, và không hỗ trợ scoped name hay packageId khác tên. Tệ hơn: một entry có `packageId` bằng đúng chuỗi URL của package khác sẽ được chọn nhầm. Nên sửa thành so sánh `entry.source.kind` cộng url/ref hoặc name/version, hoặc xóa nhánh này nếu không còn caller. Chưa chặn merge vì đường install hiện tại né được nó.

## Checklist
- Concurrency: M3, H4 (sync block). Không có interleave trong process vì đoạn từ rm tới digest chạy đồng bộ.
- Error boundary: C2 (throw ELOOP), L3.
- Authz/consent: H2, H3, M1.
- Back-compat: M2.
- Data leak: L2.

## Status
Status: DONE_WITH_CONCERNS. Không nên merge trước khi xử lý C1, C2, H1, H2.

Xếp hạng:
1. C1: chèn tham số vào git fetch qua `url` (RCE, đã kiểm chứng)
2. C2: digest follow symlink (DoS, ELOOP throw, digest không phản ánh đúng byte)
3. H1: package git/npm cài xong không render hoặc serve được (index trên đĩa vẫn remote)
4. H2: grant suy từ body client, không từ manifest
5. H3: riskTier lấy từ lời khai của directory thay vì lane thật
6. H4: git spawnSync không timeout, treo gateway
7. H5: npm không giới hạn kích thước hay timeout, không lọc entry tar
8. M1: needsApproval/denied bị bỏ, không báo cho user
9. M2: generation cũ mất toàn bộ capability sau nâng cấp
10. M3: cache key chung theo ref, rmSync xóa artifact đang dùng
11. M4: audit ghi executed trước khi fetch có thể fail
12. L1-L3: exclude `.git` lồng nhau, lộ URL có credential, ref sai định dạng gây throw

Câu hỏi chưa giải quyết:
- Directory index do ai ghi, có được coi là trusted không? Mức độ của C1/H3 phụ thuộc vào câu trả lời, nhưng C1 vẫn phải sửa vì trái với mô hình trust "isolated widget".
- Với M2, chọn backfill (grant = requested) hay bắt reinstall?

---

## Re-review (commit 8156fbe, 2026-09-23 22:30 +07)

Kiểm chứng: test focused 8 file/119 test pass. `pnpm typecheck` FAIL tại `apps/runtime/test/package-install-capability-approval.spec.ts:163` (TS2769), file **untracked**, có lẽ là commit M1/M4 đang viết dở. Cần re-run khi commit đó land.

### Trạng thái từng finding

| ID | Kết quả | Bằng chứng |
|----|---------|------------|
| C1 | **FIXED** | Chạy lại repro `--upload-pack=touch …`: ra `GIT_SOURCE_NOT_ALLOWED`, không tạo file (`package-fetch.ts:215`). Có `--` trước url (`:362`), `protocol.allow=never` + allow đúng 1 scheme (`:246-248`), hooksPath=/dev/null, tắt LFS, `GIT_TERMINAL_PROMPT=0`. `file://` bị refuse mặc định. |
| C2 | **FIXED** | Repo có symlink `root -> /`: fetch trả `ARTIFACT_SYMLINK_ESCAPE`, không có dir tạm sót lại. Dùng `lstatSync` (`:127`), refuse hardlink `nlink>1` (`:137`). |
| H1 | **FIXED (có điều kiện, xem N2)** | `resolveLocalSource` (`:192`) được dùng ở `findIsolatedFrame` (`widget-frame.ts:74`) và route files (`routes/packages.ts:238`). |
| H2 | **FIXED** | Grant lấy từ manifest trong artifact (`package-install.ts:417-423`), không từ body. |
| H3 | **FIXED** | `riskLaneFor([...isolations, riskTier])`: claim của directory chỉ nâng được lane, không hạ được. |
| H4 | **FIXED** | `spawn` async, timeout 30s, SIGKILL (`:239-300`). |
| H5 | **PARTIAL** (N3) | Timeout, cap 64 MB compressed và 512 MB decompressed, cap entry count, tar reader tự viết refuse symlink/hardlink/device/`..`. |
| M1 | **KHÔNG FIXED** (N1) | |
| M2 | **KHÔNG FIXED với ca thường gặp** (N4) | |
| M3 | **FIXED** | Cache key theo url+ref / name+version, ghi vào dir tạm rồi rename, cache hit không `rmSync`. |
| M4 | **FIXED** | `recordEffectExecution` chuyển xuống sau khi fetch thành công (`package-install.ts:378`). |
| L1 | FIXED | Chỉ exclude `.git` ở gốc (`:125`). |
| L2 | FIXED | `redactCredentials` áp vào URL. Lưu ý: stderr của git vẫn được echo (`:294`) và git có thể in URL chứa credential trong stderr. Mức Low. |
| L3 | FIXED | Manifest refs dùng `safeParse`, body không còn dùng làm grant. |
| findEntry | **FIXED** | Match theo `source.kind` + url+ref / name (`package-sources.ts:80-98,159`). |

### Vấn đề mới hoặc còn lại

**N1 (High, M1 chưa xong): pending/denied không tới được client, approval tạo ra là dead record.**
- `installPackage` trả `pendingCapabilities`/`deniedCapabilities` (`package-install.ts:503-504`), nhưng route 200 chỉ serialize `installed/generationId/state/verified/lock` (`routes/packages.ts:186-201`). Client vẫn không biết capability nào bị giữ lại.
- Grep cả `apps/` và `packages/` không có consumer nào xử lý approval `${digest}:${ref}`. User approve xong thì generation `grantedCapabilities` không đổi.
- Hệ quả: đây là control "trông như dùng được" nhưng không có hành động thật, vi phạm AGENTS.md ("Do not add a control that looks usable before its real action exists"). Ngoài ra mỗi lần cài lại ở Guarded lại sinh thêm approval record mới.
- Cần một trong hai: (a) wire approve thành cập nhật grant của generation và trả các field này trong response; (b) bỏ `requestApproval`, chỉ trả `pending` cùng lý do là chưa có đường approve.

**N2 (Medium): cache phục vụ byte chưa qua verify/cài đặt.**
- `fetchGitArtifact`/`fetchNpmArtifact` rename vào `dest` *trước khi* caller so digest (`package-install.ts` `fetchRemoteArtifact` → `artifactMatchesPlan`).
- Kịch bản: directory publish digest X, còn repo ở url+ref cho ra Y. Install trả 409 `DIGEST_MISMATCH`, nhưng cache vẫn giữ dir. Sau đó `GET /packages/:id/:v/files/*` và `findIsolatedFrame` serve đúng các byte đã bị refuse, vì `resolveLocalSource` chỉ kiểm tra `existsSync`.
- Tương tự, package fetch xong nhưng install fail ở bước sau (lock, plan) vẫn được serve.
- Cách sửa: chỉ cho resolve cache khi có generation active với digest khớp; hoặc để caller truyền expected digest vào fetch và rename chỉ khi khớp.

**N3 (Medium): tar reader tự viết.**
- (a) Pax (`x`/`g`) và GNU longname (`L`/`K`) đều bị refuse là "unsupported type" (`:608`). Đây là fail-closed, an toàn. Nhưng mọi package npm có path >100 byte mà không tách được prefix, hoặc tên non-ASCII (node-tar khi đó sẽ ghi PaxHeader), sẽ không cài được, và message không nói rõ lý do. Hoặc hỗ trợ pax `path`/`size`, hoặc ghi rõ giới hạn trong message và docs.
- (b) Không kiểm tra magic `ustar`, nên archive v7 có rác ở vùng prefix sẽ bị ghép sai tên. Mức Low.
- (c) Entry xung đột, ví dụ file `a` rồi `a/b`, hoặc dir `a` rồi file `a`: `mkdirSync`/`writeFileSync` throw ENOTDIR/EISDIR. Khối `try/finally` ở `:517-541` không có `catch`, nên exception thoát ra khỏi `installPackage` thành 500 thay vì refusal có tên.
- (d) Kích thước: không có `Content-Length` (chunked) thì `arrayBuffer()` (`:485`) đọc hết vào RAM rồi mới so cap. Cap 64 MB không bảo vệ bộ nhớ. Nên stream và abort khi vượt. Thêm nữa, `gunzipSync` 512 MB chạy đồng bộ, cộng `Buffer.from(content)` copy từng entry, nên peak có thể khoảng 1 GB và chặn event loop. Tarball URL lấy từ packument nên có thể ở host khác registry. Integrity chỉ được check *sau khi* đã tải hết.
- Size accounting (octal, NaN, size vượt archive, padding 512) đúng. Base-256 thì bị refuse, chấp nhận được.

**N4 (Medium, M2): migration 22 backfill từ nguồn sai.**
- Backfill lấy `install_plans.document.requestedCapabilityRefs` (`migrate.ts:1121-1131`). Trước PR này, field đó đến từ *body HTTP của client* (`routes/packages.ts` bản cũ), không từ manifest. Grep cho thấy không client nào trong repo gửi field này (`apps/web`, `conversation-client`, `widget-cli`).
- Hệ quả 1: gần như mọi generation cũ được backfill `[]`, nên widget cũ vẫn mất toàn bộ capability. M2 không được giải quyết.
- Hệ quả 2: nếu một client đã từng gửi ref tùy ý thì ref đó giờ thành "granted". Rủi ro bị chặn một phần vì frame lấy giao với manifest.
- Comment ở migration nói "an install granted whatever the package's manifest requested outright" là sai: code cũ ghi `grantedCapabilities: []`, và thứ frame được broker là `manifest.requestedCapabilities`.
- Ngoài ra truy vấn plan không lọc `target_node_id`/`owner_principal_id`, và `ORDER BY created_at DESC` có thể lấy plan *mới hơn* generation.
- Cách sửa: backfill bằng `manifest.requestedCapabilities` đọc từ `source.path` của package tại thời điểm migrate. Nhưng migration trong storage không nên đọc filesystem, nên có thể làm ở runtime khi đọc generation thiếu field (lazy). Hoặc chấp nhận `[]` và thông báo reinstall. Đây là quyết định sản phẩm, cần user chọn. Migration đã chạy ở máy dev thì không được sửa, phải thêm migration 23.

**N5 (Low): `CC_ALLOW_LOCAL_GIT_SOURCES`.** Mặc định tắt, chỉ bật khi đúng `"1"`, và được đọc ở mỗi request (`package-install.ts:227`). Ổn. Lưu ý: bật cờ này thì bare path và `file://` được phép. Cờ chỉ nên dùng cho dev/test, và docs `widget-development.md:803` đã ghi như vậy. Không có vấn đề.

**N6 (Low):** timeout SIGKILL chỉ kill tiến trình `git`, còn process con `git-remote-https` có thể sống thêm tới khi gặp EPIPE. Nên spawn với `detached` rồi kill cả process group.

## Status (re-review)
Status: DONE_WITH_CONCERNS

Merge verdict: **CHƯA MERGE.** Hai lỗi critical (C1, C2) đã fix và đã chạy lại repro để xác nhận. Còn chặn:
1. N1 (High): M1 chưa hoàn thành. Pending/denied không có trong response, approval không có consumer.
2. N4 (Medium): migration 22 backfill từ body client cũ, nên không đạt mục tiêu M2. Cần user chọn chiến lược.
3. N2 (Medium): cache serve artifact đã bị refuse digest.
4. N3 (Medium): tar reader throw 500 khi entry xung đột, đọc toàn bộ body khi thiếu Content-Length, refuse pax mà không nói rõ lý do.
5. Typecheck đang fail do file test untracked (commit follow-up chưa land). Phải `pnpm verify` xanh trên HEAD cuối.
6. N5, N6, L2 (stderr): Low, không chặn merge.

---

## Re-review 2 (HEAD 9fae6cb, 2026-09-23 22:45 +07)

Commit mới: 7aab51d, b617af5, 9fae6cb. Kiểm chứng:
- `pnpm typecheck` sạch (0 lỗi TS).
- vitest trên core fetch/sources, toàn bộ `apps/runtime/test` và `packages/storage/test`: 81 file pass, 889 test pass, 7 skip.
- Chưa chạy `pnpm verify:full`/e2e.

### Chạy lại repro
- C1 `--upload-pack=touch …` → `GIT_SOURCE_NOT_ALLOWED`, không tạo file pwned. **Vẫn fixed.**
- C2 repo có symlink `root -> /` → `ARTIFACT_SYMLINK_ESCAPE`, không sót dir tạm. **Vẫn fixed.**

### Kết quả từng N-item

| ID | Kết quả | Bằng chứng |
|----|---------|------------|
| N1 | **FIXED, nhưng route mới có lỗi (R1)** | Response 200 có `pendingCapabilities`/`deniedCapabilities`/`note` (`routes/packages.ts:431-446`). Cài lại thì dùng lại approval đang pending. Approve thì cập nhật generation và ghi audit. |
| N2 | **FIXED** | So `expectedDigest` trên thư mục tạm trước khi rename vào cache (npm `package-fetch.ts:662-670`, git tương tự). Route files đòi có generation active với `digest === entry.digest` (`routes/packages.ts:511-522`). |
| N3 | **PARTIAL (R3, R4)** | Đọc body theo stream với cap (`:600-612`). Kiểm tra magic ustar. Xử lý pax `x`/`g` và GNU `L`/`K`. Tên trùng bị refuse. |
| N4 | **FIXED (thiết kế lại)** | Migration 22 đánh dấu `null`. `resolveGenerationGrantedCapabilities` resolve lười từ manifest và lưu lại một lần (`package-install.ts:311-343`). |
| Low (L2 stderr, N6) | Không re-verify sâu, không chặn merge | |

### Soát các phần mới

**R1 (Medium): `POST /packages/approvals/:id/decision` quyết định cả những approval không phải capability.**
- `decideInstallCapabilityApproval` gọi `decideApproval` và commit quyết định *trước*, rồi mới `parseCapabilityOperationDigest` (`package-install.ts:189-234`). Approval sai loại vẫn bị đánh `granted`/`denied`, sau đó route mới trả 400 `NOT_A_CAPABILITY_APPROVAL`.
- Kịch bản: gửi id của approval `run_command` trong một conversation, hoặc approval của chính bản cài (`operationDigest = entry.digest`, chỉ có 1 dấu `:`) cùng digest đúng. Approval chuyển sang `granted`, nhưng logic của route conversation (tìm approval card, chạy payload, `appendHostReply` ở `conversations.ts:1124-1149`) không chạy. Card của user giờ báo "already decided", nên lệnh không bao giờ chạy được và cũng không có reply.
- Không phải leo thang quyền, vì route cần bearer token owner. Nhưng đây là đường thứ hai quyết định approval, bỏ qua ngữ cảnh conversation.
- Cách sửa: đọc row trước, refuse nếu `task_id IS NOT NULL` hoặc digest không parse ra capability, rồi mới gọi `decideApproval`. Nên thêm cột hoặc tag loại approval.

**R2 (Low-Medium): grant và decision không atomic, và bản replay không bù.**
- `decideApproval` commit transaction riêng. UPDATE generation và audit chạy sau, ngoài transaction (`:241-258`). Nếu process chết hoặc throw giữa hai bước thì approval đã `granted` mà grant chưa ghi.
- Client retry thì rơi vào nhánh `alreadyDecided` (`:197-221`), nhánh này trả `ok:true` mà **không** áp lại grant. Capability mất vĩnh viễn trong khi API nói đã grant.
- Cách sửa: nhánh replay kiểm tra ref đã có trong generation chưa, nếu chưa thì áp (idempotent). Hoặc gộp cả hai bước vào cùng transaction bằng một biến thể `decideApproval` không tự mở transaction.
- Các trường hợp liên quan:
  - Không có generation active cho digest (đã bị supersede bởi version mới): trả `ok:true`, không có `generationId`, và grant không được áp ở đâu cả. Đây là thành công giả.
  - Cài lại cùng digest tạo generation mới từ derivation mới. Approval cũ đã `granted` không còn `pending`, nên lại tạo approval mới và bỏ qua quyết định cũ.
- Scoping: `findGenerationByDigest` lọc theo `node_id` và `superseded_at IS NULL` nên đúng node. Owner là `runtime.identity.ownerPrincipalId`, không lấy từ body, OK.
- Expected revision: chỉ có `seenOperationDigest`, không có revision riêng. Chấp nhận được, vì digest gắn với artifact và ref.
- Double-submit: tuần tự, đồng bộ, và nhánh `alreadyDecided` xử lý đúng khi quyết định trùng.
- Widget/frame không gọi được route này: frame grant chỉ áp cho `GET /frame/…` (`gateway.ts:101-103`), còn POST cần bearer token và frame không giữ token.

**R3 (Medium): bỏ qua pax `size` tạo chênh lệch parser, cho phép giấu entry.**
- Trong `extractUstarTarball` (`package-fetch.ts:752+`, dòng 66-69 và 104-108 trong hàm), `size` được parse ra (`parsePaxRecords`) nhưng không dùng. Offset luôn tính theo `size` của header ustar. Theo POSIX, GNU tar, bsdtar và node-tar thì pax `size` *đè* header size.
- Kịch bản: tarball có pax `size=4096` trong khi header ghi `size=0`, và 4096 byte kế tiếp chứa một header ustar hợp lệ `package/evil.js`.
  - tar chuẩn, npm và các scanner registry coi 4096 byte đó là nội dung file, nên không thấy `evil.js`.
  - Reader này bỏ qua pax size nên parse `evil.js` thành entry thật và cài nó.
  - Chiều ngược lại (pax size lớn hơn thực tế) giấu entry khỏi reader này.
- Không thoát sandbox, vì mỗi entry vẫn qua kiểm tra traversal/symlink/type, và digest được tính trên những gì reader này extract. Nhưng mã node chạy khác mã mà công cụ review hay scanner chuẩn nhìn thấy. Nếu publisher tính digest bằng tool chuẩn thì install fail, còn publisher độc hại thì tự tính digest theo reader này.
- Integrity sha512 không giúp được gì, vì nó hash cả tarball.
- Cách sửa: nếu pax `size` có mặt và khác header size thì refuse (npm không bao giờ cần). Tương tự với `g` (global): hiện nó được merge vào `pendingOverrides` và chỉ áp cho entry kế tiếp, lệch chuẩn. Nên refuse `path`/`size` trong `g`.

**R4 (Medium, còn sót từ N3c): xung đột file/thư mục vẫn throw ra ngoài.**
- `seenNames` chỉ bắt tên trùng tuyệt đối. File `a` rồi file `a/b`: tên khác nhau nên lọt qua, sau đó `mkdirSync(join(target,".."),{recursive:true})` gặp `a` là file và throw ENOTDIR (`:653`).
- Vòng ghi nằm trong `try/finally` không có `catch` (`:642-676`), và `fetchRemoteArtifact`/`installPackage` cũng không bắt, nên thành 500 hoặc promise rejection thay vì `NPM_TARBALL_UNSAFE_ENTRY`.
- Cách sửa: kiểm tra mọi prefix của tên với tập file đã thấy, hoặc bọc vòng ghi bằng catch và trả refusal có tên.
- Ghi chú: trên APFS/NTFS không phân biệt hoa thường, `A.js` và `a.js` ghi đè nhau. Digest sẽ lệch và bị refuse, fail-closed nên chấp nhận được.

**R5 (Low): lazy grant resolution.**
- Code đồng bộ, một process, nên không có race trong process. Lần gọi đầu ghi lại mảng và các lần sau đọc thẳng. Đạt yêu cầu "persists once".
- Hai lưu ý:
  - (a) `decideInstallCapabilityApproval` coi `null` là `[]` (`:240`) rồi ghi `[ref]`. Nếu user approve một capability *trước* lần mount đầu, generation cũ mất vĩnh viễn toàn bộ grant từ manifest.
  - (b) `UPDATE` ở `:339` không có điều kiện `json_extract(document,'$.grantedCapabilities') IS NULL`, nên hai process cùng DB (ví dụ runtime và CLI) có thể ghi đè grant vừa approve. Rủi ro thấp.
- Migration 22 bị sửa tại chỗ. Chấp nhận được *chỉ vì* chưa từng lên main hay release. DB dev nào đã chạy bản 22 cũ vẫn giữ mảng backfill từ plan và sẽ không chạy lại, nên cần xóa hoặc migrate lại DB dev đó.

**R6 (Câu hỏi, chưa xác minh được breakage): route files giờ đòi generation active.**
- Route files từ chối package local có trong `CC_DIRECTORY_INDEX` nhưng chưa được *cài*, trả 409 `NOT_INSTALLED`.
- Grep không thấy e2e hay `widget-cli` nào gọi `/packages/:id/:v/files`. Fixture `com.example.frame-widget` không được spec nào mở frame. `widget-cli dev` dùng dev host riêng.
- Nếu có luồng phát triển nào dựa vào "liệt kê trong directory local là render được ngay" thì nó hỏng. Thông báo lỗi nói rõ lý do, nên hành vi là đúng về mặt sản phẩm, nhưng cần xác nhận và ghi vào `docs/widget-development.md`.
- Ngoài ra, package local bị sửa sau khi cài vẫn được serve vì chỉ so digest của entry, không so byte thật trên đĩa. Có từ trước, ngoài phạm vi.

## Status (re-review 2)
Status: DONE_WITH_CONCERNS

Merge verdict: **CHƯA MERGE, nhưng đã gần xong.** C1/C2/H*/M* giữ nguyên là fixed, N1/N2/N4 fixed. Cần sửa trước khi merge:
1. R3 (Medium, bảo mật): refuse khi pax `size` khác header size, và không áp `g` cho path/size. Sửa nhỏ.
2. R1 (Medium): route decision phải refuse approval không phải capability *trước khi* gọi `decideApproval`.
3. R4 (Medium): xung đột file/thư mục trong tar phải thành refusal có tên, không throw.
4. R2 (Low-Medium): nhánh replay phải áp lại grant còn thiếu, và không trả `ok:true` khi không có generation nhận grant.

Không chặn merge: R5, R6 (cần xác nhận luồng dev local), cùng L2/N6 từ vòng trước. Trước khi báo xong phải chạy `pnpm verify:full`, vì route files thay đổi hành vi hiển thị.

# Handoff: lộ trình hoàn thiện mọi issue mở của clarkcant

- **Ngày:** 2026-09-30. Bản nháp viết lúc 11:43; phần "Trạng thái cuối" ở cuối file được cập nhật khi các việc nền kết thúc.
- **Lý do handoff:** hạn mức sử dụng hằng tuần của tài khoản hiện tại sắp hết (hơn 80%). Người tiếp nhận làm tiếp ở một tài khoản khác.
- **Plan gốc:** [`plans/260929-0002-open-issues-roadmap/plan.md`](../260929-0002-open-issues-roadmap/plan.md). Plan này có outcome contract đã khoá và bảng phase.
- **Plan con của phase 10:** [`plans/260930-0200-widget-platform-expansion/plan.md`](../260930-0200-widget-platform-expansion/plan.md).

---

## 1. Hợp đồng đã khoá (không được đổi nếu user chưa đồng ý)

- **Kết quả phải đạt:** mọi issue mở không bị gate bên ngoài của `digitopvn/clarkcant` được triển khai, merge vào `main`, rồi đóng kèm bằng chứng.
- **Ngoài phạm vi:** #2, #3, #4, #5, #193, #194, #199, #209, cùng mọi live journey cần tài khoản, phần cứng hoặc host bên ngoài.
- **Phần bị gate:** tách thành sub-issue có nhãn `blocked,external-gate`, rồi đóng issue gốc khi phần làm được trong repo đã đạt.
- **Thứ tự:** bảo mật trước.
- **Mỗi issue chỉ được đóng khi có đủ:**
  - PR đã merge, required CI xanh (kể cả Windows);
  - `pnpm verify` pass, cộng thêm `pnpm verify:full` hoặc E2E khi chạm UI;
  - comment đóng đối chiếu từng acceptance criterion;
  - docs trên `clarkcant-web` (EN và VI) đã merge, hoặc một issue fallback có nhãn `ai-handle`.
- **Chỉ dẫn của user:**
  - Kiểm thử trực tiếp và sửa lỗi UI/UX ngay khi thấy. Phải có evidence, không được chỉ giả định.
  - Được dùng browser use và computer use.
  - Không hỏi lại user. Nếu thiếu thông tin thì tạo issue riêng, ghi rõ lý do, cách giải quyết và những gì cần, rồi làm tiếp.
  - Trang landing `index.html` của web chỉ có tiếng Anh. Trang docs thì có cả EN và VI.
- **Quyền đã được cấp:** merge PR khi CI xanh, đóng issue, tạo issue và sub-issue. PR docs trên web chỉ merge **sau khi** PR tính năng đã merge.
- **Bảo mật hội thoại:** không in token, key hay JWT ra hội thoại. Token node E2E nằm ở `.data/e2e/identity.json` (`localToken`); URL frame-grant cũng được coi là credential.

## 2. Quy tắc repo hay bị quên

- Chỉ dùng pnpm.
- Không dùng `enum`, `namespace` hay `declare global`, và không dùng constructor parameter property.
- Migration bất biến và phải liên tục. `main` hiện đang ở **38** (`artifact_refs_and_grants`, từ #345), nên migration mới là 39.
- Chỉ `packages/pi-adapter` được import Pi SDK.
- Docs nội bộ song ngữ EN và VI; riêng `docs/conformance-traceability.md` chỉ có tiếng Anh. Không được ghi hành vi mục tiêu như thể đã ship.
- Commit:
  - dùng conventional commit bằng tiếng Anh, kết thúc bằng trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  - agent con hay quên trailer này, nên bổ sung khi rebase: `git rebase origin/main --exec "git commit --amend --no-edit --trailer 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'"`.
- PR body:
  - kết thúc bằng `🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
  - chỉ ghi "Addresses #N". **Không** dùng closing keyword, vì invariant `pr-bodies-close-nothing` sẽ chặn; issue được đóng tay kèm bằng chứng.
- Không làm yếu test, không `--no-verify`, không `git stash`.

## 3. Quy trình thao tác (Windows, PowerShell)

- **Shell:**
  - Bash của harness lỗi `ENAMETOOLONG`, nên dùng PowerShell với `git -C <dir>`.
  - Viết commit message và PR body ra file UTF-8 không BOM, ví dụ `$env:TEMP\cc-msg.txt` và `$env:TEMP\cc-body.txt`, bằng `[IO.File]::WriteAllText(path, text, (New-Object Text.UTF8Encoding $false))`, rồi dùng `git commit -F` hoặc `gh ... --body-file`.
- **Sửa PR body:** đừng gán `gh pr view --json body --jq .body` vào biến PowerShell rồi nối chuỗi. Kết quả là một mảng dòng, nên khi nối, các dòng bị gộp bằng dấu cách. Hãy dùng `| Out-String` và thay `\r\n` bằng `\n`. Nếu body lỡ hỏng, bản cũ lấy lại được qua GraphQL `pullRequest.userContentEdits.nodes[].diff`.
- **Test hẹp:** `pnpm exec vitest run <đường dẫn cụ thể>`. Có thể truyền mảng bằng `@f`.
- **Kiểm CI:**
  - Chạy ``gh pr checks N --repo digitopvn/clarkcant | Select-String -NotMatch "`tpass`t|`tskipping`t"``. Không in ra dòng nào nghĩa là mọi check đều xanh.
  - Muốn chờ thì chạy nền một vòng lặp tối đa 9 phút, poll chuỗi `` `tpending`t `` mỗi 40 giây.
- **Merge:** `gh pr merge N --squash --match-head-commit <sha> --body "Addresses #N.`n`nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.
- **Rebase khi xung đột `docs/manifest.json`:** lặp các bước sau cho đến khi rebase xong:
  1. `git checkout --ours docs/manifest.json`
  2. `node tools/check-invariants.mjs --fix-manifest`
  3. `git add docs/manifest.json`
  4. `$env:GIT_EDITOR="true"; git rebase --continue`
- **Sau mỗi lần rebase:** chạy `pnpm run typecheck`, `pnpm run lint`, `node tools/check-invariants.mjs` và các test hẹp, rồi `git push --force-with-lease`. Cập nhật SHA trong PR body nếu body có nhắc tới.
- **Cổng E2E cho mỗi worktree** (`CC_E2E_NODE_PORT` / `WEB` / `NPM_REGISTRY`), để các worktree chạy song song không đụng cổng nhau:

  | Worktree | Cổng |
  |---|---|
  | chính | 9876 / 5373 / 9878 |
  | wt341 | 9576 / 4973 / 9578 |
  | wt326 | 9276 / 4673 / 9278 |
  | wt298 | 9676 / 5073 / 9678 |
  | wt349 | 9476 / 4873 / 9478 |
  | wt350 | 9176 / 4573 / 9178 |

- **Chụp ảnh docs web:** các script chưa được track nằm trong worktree chính, chạy từ worktree chính.
  - `shot-web-el.tmp.mjs` chụp một phần tử của `docs/api.html`.
  - `shot-web-index.tmp.mjs` chụp trang landing.
  - `shot-web-range.tmp.mjs <webdir> <outdir> '<startSel>' '<endSel>' <prefix>` chụp một đoạn giữa hai phần tử, ở EN và VI, rộng 1280 và 390, đồng thời in ra độ tràn ngang.
- **Worktree web:** tạo trong `D:\webNNN` từ `D:\www\digitop\clarkcant-web`, với branch `docs/<issue>-<slug>`.

## 4. Đã hoàn thành (từ 2026-09-28)

**PR đã merge (squash):**

| PR | Commit | Nội dung |
|---|---|---|
| #354 | ac50790 | Cài gói dưới chế độ "hỏi trước": lần cài chờ duyệt trong hộp thư (`install-approval`); `POST /packages/install` thành `PERSON_ONLY` (#341). Web #56 (db70e38) |
| #352 | 7006721 | Inbox: "Copy details" trong menu More của thông báo (#349). Web #55 (6724b44) |
| #353 | acc0605 | Widgets v2 (O): `canvas.timeline@1`. PR này kèm luôn bản sửa typecheck của main sau khi #347 và #351 cùng merge (`preferredAppIntentLocale` chỉ nhận `db` và `now`). Web #57 (3769616) |
| #347 | 2a0127b | Theme M3: giao diện theme vượt ra ngoài màu sắc, kiểm tra trạng thái được bảo vệ, appearance intents; web #51 (9f4e903) |
| #351 | 97420ca | từ chối browser task khi không model nào gọi được tool; web #54 (fa3bbcc) |
| #348 | 86123db | task worker chạy trên model đã cấu hình |
| #345 | 4bcff63 | ArtifactRef broker |
| #344 | 67476d9 | browser pack chạy từ task |
| #342 | a299d33 | notice.act từ mọi bề mặt |
| #339 | b4bdd38 | lịch: dạng tuần và agenda |
| #338 | 9b4e11a | action executor |
| #337 | c77f718 | |
| #336 | 93426ad | |
| #331 | a187a96 | biểu đồ area và scatter |
| #330 | d7033d4 | |
| #312 | 4052a19 | |
| #309 | 080b99b | |
| #308 | 3660ea7 | |
| #307 | bfdc76f | |
| #306 | 15cb13a | |
| #305 | 8eaf8b2 | |
| #304 | d65153b | |
| #303 | 44705ce | |
| #295 | 734b0e2 | |
| #293 | e04032b | |
| #292 | b63e904 | |
| #291 | f056b73 | |
| #290 | aa80aab | |
| #289 | da82bd8 | |
| #288 | 3c099e0 | |
| #287 | 51cb3b8 | |
| #286 | 62568d3 | |
| #285 | 99db0fa | |
| #284 | 07ebfc5 | |
| #279 | af007bf | |
| #278 | ab3f8d9 | |
| #276 | ec5913c | |
| #272 | 341abd7 | |
| #271 | 6e99168 | |
| #268 | 7130dcb | |
| #265 | 1f8c256 | |
| #262 | 495f8aa | |
| #261 | fda13d3 | |
| #260 | d42fe2a | |
| #259 | b790e24 | |
| #258 | 0cc3f45 | |
| #257 | 719ddf8 | |
| #256 | 12c5698 | |
| #254 | 6ab37fe | |
| #252 | 944cff3 | |
| #249 | 49edef1 | |
| #247 | fed42dc | |
| #245 | 5ec2a9d | |
| #239 | f3d85c9 | |
| #238 | c9fc00a | |
| #237 | bdc2ec4 | |
| #236 | 1d00297 | |
| #235 | 7ce93e4 | |
| #234 | 230163b | |
| #229 | e8af33a | |
| #228 | dc07be5 | |
| #227 | 7abff30 | |
| #219 | 197c450 | |
| #217 | 3a4aaad | |
| #216 | a062891 | |

**Issue đã đóng kèm bằng chứng:**
- #341, #349, #326, #350, #298, #346, #314, #313, #311, #310, #297, #296, #294
- #283, #282, #281, #280, #277, #275, #273, #270, #269
- #264, #263, #253, #251, #248, #246, #244, #243, #242, #241, #240
- #233, #232, #231, #230, #226, #225, #224, #223, #222, #221, #220
- #215, #212, #210, #197, #196, #195, #192, #191, #190
- #174, #173, #172, #171, #170, #169, #137, #129, #93

**Issue web đã đóng:**
- #53: Copy details (qua web #55);
- #47: widget files;
- #52: tool-capable model;
- #34 và #37: các dòng landing đã có trên main qua web #33 và #36.

**Issue mới tạo ra trong lúc làm:**
- #355 (`blocked`): cần owner quyết định xem relay và MCP có được gọi các route ghi artifact của widget hay không. Nếu owner chọn phương án 1, đề xuất mặc định là từ chối machine surface. Chi tiết trong issue.
- #358 (`bug`): trong thẻ kết quả marketplace, nguồn, trust lane và digest dính liền nhau vì `.cc-marketplace-meta` không có style. Việc nhỏ.
- #359 (`bug`): test E2E lịch dạng tuần ở 390 px bị flaky. Thao tác tap có thể rơi vào header cố định; cách sửa được ghi trong issue.
- PR #357 (sửa typecheck của main) đã được **đóng, không merge**, vì bản sửa đã nằm trong #353.
- #356 (`bug`): race giữa timer deadline của workflow và timeout của service trong `workflow-executor.ts`. Nó làm test "says a read step that ran out of time…" thỉnh thoảng đỏ trên CI (lần gặp là ở PR #347). Issue đã ghi nguyên nhân và cách sửa. Việc nhỏ, nên làm sớm vì nó làm CI của mọi PR chập chờn.

## 5. Đang dở (dừng lúc 2026-09-30 14:05 theo yêu cầu user)

**Ba PR đã mở, CI đang chạy; chưa có check nào đỏ lúc dừng.** Cả ba là PR nhỏ, không đổi hành vi nên **không cần docs web**.

| PR | Issue | Branch / worktree | Head | Nội dung | Bằng chứng local |
|---|---|---|---|---|---|
| [#360](https://github.com/digitopvn/clarkcant/pull/360) | #356 | `fix/356-workflow-deadline-race`, `D:/wt356` | 7006e690 | `workflow-executor.ts`: thêm `DEADLINE_SLACK_MS = 25`. Một `SERVICE_TIMED_OUT` xảy ra khi ngân sách của run đã gần hết (`nowMs() - started >= deadlineMs - 25`) được coi là `WORKFLOW_DEADLINE`. Thêm 3 test dùng clock inject: đọc ở 5000/5000, ghi ở 4990 (uncertain, `recorded: true`), đọc ở 1000/5000 (vẫn là `SERVICE_TIMED_OUT`). | vitest xanh, mutation đã kiểm, `pnpm verify` xanh |
| [#361](https://github.com/digitopvn/clarkcant/pull/361) | #358 | `fix/358-marketplace-meta-spacing`, `D:/wt358` | c1f68191 | `styles/cards.ts`: style cho `.cc-marketplace-meta` (flex-wrap, gap, `overflow-wrap:anywhere`). E2E mới trong `package-install.spec.ts` ở 1280 dark, 390 light, 390 dark: 3 phần cách nhau ≥ 8 px hoặc xuống dòng, không tràn ngang. | E2E xanh, ảnh chụp trong `plans/reports/evidence/358/` của wt358, `pnpm verify` xanh |
| [#362](https://github.com/digitopvn/clarkcant/pull/362) | #359 | `fix/359-calendar-week-phone-tap`, `D:/wt359` | 0840c3ef | Chỉ sửa test `calendar-views.spec.ts`: cuộn event ra giữa màn hình, chờ `elementFromPoint` ở tâm trúng chính event rồi mới tap. Không đổi sản phẩm (`.cc-header` nằm trong flex flow, không đè `.cc-scroll`). | calendar-views 9/9, repeat-each 10/10, `pnpm verify` exit 0 |

**Việc tiếp theo cho mỗi PR:** chờ CI xanh (kể cả Windows) và `mergeStateStatus` là CLEAN. Nếu PR bị DIRTY vì PR khác merge trước thì rebase theo mục 3. Sau đó merge `--squash --match-head-commit <sha>`. Cuối cùng đóng issue tương ứng, kèm comment đối chiếu từng acceptance criterion (PR, commit, test, CI run). Nếu CI đỏ vì flaky thì ghi run id vào issue flaky, rồi `gh run rerun <runId> --failed` sau khi cả run đã xong.

**Worktree đã tạo nhưng chưa có code (agent đã bị dừng trước khi sửa gì):**
- `D:/wt343`, branch `feat/343-conversation-delete` từ ac50790. Đã `pnpm install`, **chưa có thay đổi**. Kế hoạch cho #343 nằm ở mục 6.
- `D:/wt299`, branch `feat/299-appearance-snapshot` từ ac50790. Chỉ có file brief chưa track `plans/reports/brief-299-appearance-snapshot.md`, là đề bài đầy đủ cho #299: scope, ràng buộc, cổng kiểm chứng, port E2E 9276/4673/9278. **Không commit file này.**
- `D:/webdocs69` (repo clarkcant-web), branch `docs/web-6-9-backlog` từ db70e38. **Chưa có thay đổi.** Dành cho web #6–#9.

**Bài học mới:** một subagent `fullstack-developer` từng bị lỗi `ENAMETOOLONG: uv_spawn` ở **mọi** lệnh Bash, trong khi agent khác vẫn chạy bình thường. Cách tránh: ghi đề bài dài ra file, rồi giao cho agent một prompt ngắn trỏ tới file đó. Nếu Bash vẫn lỗi thì bảo agent dùng tool PowerShell.
## 6. Việc còn lại, theo thứ tự nên làm

1. **Chốt 3 PR ở mục 5:** #360 (#356), #361 (#358), #362 (#359). Merge khi xanh, rồi đóng issue.
2. **#343: xoá conversation, giải phóng attachment và file của widget** (worktree `D:/wt343` đã sẵn). Yêu cầu, gồm cả các comment của issue:
   - Tạo **một** capability có kiểu để xoá conversation. Gọi được từ hội thoại (gõ và voice, cùng ngữ nghĩa action) và từ REST.
   - Đây là việc phá huỷ nên đi qua Jev/policy, không tự đặt confirm riêng.
   - Là **person-only** trên MCP, relay WebSocket và `clarkcant api`: xem `isPersonOnlyRoute` trong `packages/contracts/src/machine-surfaces.ts`, và cách #354 làm với `POST /packages/install`.
   - Gọi `releaseConversationAttachments` (`apps/runtime/src/attachments.ts`) và `releaseConversationArtifacts` (`apps/runtime/src/artifact-broker.ts`) cùng việc xoá các row của conversation, trong **một transaction**.
   - **Migration 39** (main đang ở 38 `artifact_refs_and_grants` trong `packages/storage/src/migrate.ts`). Bốn bảng tham chiếu `conversations` mà không có `ON DELETE CASCADE`, trong khi `PRAGMA foreign_keys=ON`. Quyết định cách xử lý từng bảng và ghi lý do.
   - Câu báo lỗi hoặc kết quả nói rõ cái gì đã xoá, cái gì được giữ, điều gì xảy ra tiếp (VI và EN).
   - Xem xét cửa sổ Undo. Nếu xoá ngay thì phải giải thích lý do.
   - Tuỳ chọn: một lượt đối soát khi khởi động, dọn blob mồ côi quá hạn grace. Không làm "stop sharing" và #355.
   - Docs: sửa ghi chú "No conversation delete route yet" trong `docs/widgets-and-extensions{,.vi}.md` và câu retention ở `docs/widget-development{,.vi}.md` §10.1.
   - Kiểm chứng: E2E ở 1280 và 390, sáng và tối, reduced motion, bàn phím; port 9176/4573/9178. Mutation check cho person-only, transaction, migration và policy. Sau đó `pnpm verify`, `verify:full` và docs web.
   - Việc này mở khoá được phần retention "Partly" còn treo của #313.
3. **#355:** chờ owner quyết định, rồi làm theo phương án được chọn (việc nhỏ).
4. **Theme platform (#201), sau #298:**
   - #299 M4: AppearanceSnapshot trong widget bridge và Widget SDK appearance API. Worktree `D:/wt299` và brief đầy đủ đã có (mục 5). Nền M1–M3 nằm ở PR #304, #305 và #347.
   - #300 M5: Theme Lab, theme settings và `clark theme` CLI; trỏ lại `appearance.open-theme-gallery` sang Theme Lab.
   - #302 M7: theme mẫu Pixel Arcade và Neo Brutalism. Font đóng gói kèm cần một hợp đồng font-asset.
   - #301 M6 bị gate trên #194.
5. **Widgets v2 (#198), sau #326:**
   - Làm theo chuỗi #327 (tree), #328 (kanban), #329 (semantic state cho media), #322 (map offline), #325 (diagram), #324 (audio và document).
   - #323 bị gate.
6. **Widget platform (#200):**
   - #315 JobRef, sau #313 và #314 (cả hai đã xong);
   - #316 resource profile và token broker (bảo mật, nên làm sớm);
   - các app mẫu #317–#320;
   - #332 connected-app template;
   - #334 và #335 cho dev host.
   - #321 và #333 bị gate.
7. **Đóng epic #198, #200 và #201** khi mọi con không bị gate đã đóng. Phần gated vẫn giữ lại dưới dạng sub-issue.
8. **Phase 13: đối soát cuối.**
   - Rà lại toàn bộ issue mở.
   - Cập nhật bảng phase trong `plan.md` và `docs/conformance-traceability.md`.
   - Dọn worktree.

**Issue bị gate, giữ mở, không làm:** #340, #333, #323, #321, #301, #274, #267, #266, #255, #250, #218. Ngoài phạm vi: #2, #3, #4, #5, #193, #194, #199, #209.

**Issue web cũ cần kiểm tra rồi đóng hoặc làm** (worktree `D:/webdocs69` đã sẵn):
- **web #6:** kiểm tra lại câu "Read the full, honest ledger" trong `index.html`. Trên `/vi/docs/*`, ghi rõ link sổ trạng thái là tiếng Anh (ví dụ "Sổ trạng thái (tiếng Anh)"), và không trỏ tới `.vi.md`.
- **web #7:** docs về inbox, approval do task đang chạy tạo ra (`POST /tasks/:taskId/approvals/:approvalId/decide`, person-only với `403 PERSON_ONLY`), thông báo ngoài app (Settings → Control) và update check. Nguồn: `docs/system-architecture.md` §7.5.1, `DESIGN.md` §6.7 và `docs/open-interfaces.md`.
- **web #8:** trạng thái inline ở Settings → Control khi OS từ chối hiện thông báo.
- **web #9:** Terminal card và mục của nó trong Widget Library. Thêm một dòng ở `docs/websocket.html` (và bản VI) nói `/terminal` là socket của Terminal card, không phải bề mặt tích hợp công khai.
- **web #5:** chỉ còn mục "cập nhật docs khi CLI lên npm", mục này phụ thuộc #193 (ngoài phạm vi). Ghi comment rồi giữ mở, hoặc gắn nhãn gated.
- Làm tất cả trong một PR với cả EN và VI. Trước khi viết, kiểm tra xem main của web đã có nội dung đó chưa. Nếu có rồi thì đóng issue kèm bằng chứng.
## 7. Quyết định còn mở

- **#355:** machine surface có được gọi các route ghi artifact của widget hay không. Đề xuất là từ chối, giống cách các route chỉ dành cho người đang được đánh dấu.
- **#350:** catalogue model của pi không bao giờ báo "model này không gọi được tool". Vì vậy lời từ chối trước khi bắt đầu chỉ xảy ra khi node chắc chắn biết. Trường hợp phổ biến vẫn là worker báo rõ "the model answered without using any of its tools". Nếu muốn từ chối chắc chắn hơn thì cần một nguồn dữ liệu năng lực model ở pi-adapter; đây là follow-up tuỳ chọn.

## 8. Dọn dẹp

- **Đã gỡ:**
  - worktree `wt298`, `web298`, `wt313`, `web313`, `wt350`, `web350`, `wtfix`, `wtcheck`, `wt326`, `web326`, `wt349`, `web349`, `wt341`, `web341` và `wt196-web`;
  - worktree agent `agent-a542fdba452e9dd4e` (PR #307 đã merge). Git đã bỏ đăng ký nó, nhưng thư mục chưa xoá được vì Windows báo "Filename too long" trong `node_modules`. User cần tự xoá thư mục `D:\www\digitop\clarkcant\.claude\worktrees\agent-a542fdba452e9dd4e`, bằng một công cụ hỗ trợ đường dẫn dài.
- **Còn lại, cần user quyết định:**
  - `agent-a8bf089cc8d523caa` có 2 file chưa track: `apps/web/e2e/desktop-notification-click.spec.ts` và `plans/reports/verification-260929-0033-phase-02-done-issues.md`. Xem nội dung trước khi gỡ.
  - Thư mục `D:/wt298-notes` bị tool chặn xoá. Nội dung đã được chép sang `plans/reports/pr-body-347.md`, nên user có thể tự xoá.
- **Worktree đang dùng, giữ lại:**
  - `D:/wt356`, `D:/wt358` và `D:/wt359`: gỡ sau khi PR của từng cái merge.
  - `D:/wt343`, `D:/wt299` và `D:/webdocs69`: dùng cho việc kế tiếp.
  - Gỡ bằng `git worktree remove`; branch đã merge thì xoá luôn.
- **Không** động vào các worktree của user hoặc phiên khác: `D:/orca/...`, `brave-chaum-*`, `peaceful-clarke-*`, `sweet-greider-*`, `clarkcant-web-table-export`, và checkout gốc `D:/www/digitop/clarkcant` (branch `fix/desktop-dev-window`).
- **File chưa track trong worktree chính:**
  - Báo cáo và PR body được giữ lại để tham khảo: `plans/reports/` (`pr-body-*.md`, `review-*.md`, `web-docs-*.md`, `mutations-341.md`).
  - Evidence nằm trong `plans/reports/evidence/{326,341,349,...}` và **không** được commit.
  - `shot-web-*.tmp.mjs` là tiện ích chụp ảnh, xoá khi không cần nữa.
  - Không commit `packages/conversation-client/test/calendar-layout.spec.ts`.
  - Worktree chính vẫn detached ở 93426ada. Phiên mới nên `git fetch` rồi tạo worktree mới từ `origin/main`.

## 9. Câu mở đầu gợi ý cho phiên mới

> Đọc `plans/reports/handoff-260930-1143-open-issues-roadmap.md` (nhất là mục 5 và 6) và `plans/260929-0002-open-issues-roadmap/plan.md`, rồi tiếp tục goal "hoàn thiện và đóng mọi issue mở không bị gate của digitopvn/clarkcant". Việc đầu tiên: chốt ba PR đang chờ CI là #360, #361 và #362. Merge khi xanh, rồi đóng #356, #358 và #359 kèm comment đối chiếu. Sau đó làm #343 trong `D:/wt343`, #299 trong `D:/wt299` (brief có sẵn) và web #6–#9 trong `D:/webdocs69`, rồi tiếp mục 6 theo thứ tự. Tuân thủ hợp đồng và quy trình ở mục 1–3. Không hỏi lại user; nếu thiếu thông tin thì tạo issue riêng, ghi rõ lý do, cách giải quyết và những gì cần, rồi làm tiếp.

## Trạng thái cuối (2026-09-30 14:05, Asia/Saigon)

- **`main` của clarkcant:** ac50790. **`main` của clarkcant-web:** db70e38. Không có tác vụ nền hay agent nào còn chạy.
- **Trong phiên cuối:**
  - Đã merge #353, #352 và #354, cùng web #57, #55 và #56.
  - Đã đóng #326, #349, #341 và web #53, mỗi issue kèm comment đối chiếu từng acceptance criterion.
  - Đã đóng PR #357 vì bị thay thế.
  - Đã mở PR #360, #361 và #362 cho #356, #358 và #359. CI đang chạy; chưa merge (mục 5).
- **Issue mở của clarkcant: 45.**
  - **22 việc làm được:**
    - bug #356, #358, #359, đã có PR;
    - #343;
    - theme #299, #300, #302;
    - widgets #322, #324, #325, #327, #328, #329;
    - platform #315–#320, #332, #334, #335.
  - **1 chờ owner quyết định:** #355.
  - **3 epic:** #198, #200 và #201.
  - **19 bị gate hoặc ngoài phạm vi:** #2–#5, #193, #194, #199, #209, #218, #250, #255, #266, #267, #274, #301, #321, #323, #333, #340.
- **Issue mở của clarkcant-web:** #5–#9, xem mục 6.
- **Chưa đạt:** goal "đóng hết mọi issue không bị gate" **chưa xong**. Phần còn lại ở mục 5 và mục 6, theo đúng thứ tự.
# Phân tích kiến trúc quản lý process của ClarkCant

**Ngày:** 24/09/2026 · **Phạm vi:** `apps/runtime`, `apps/worker`, `apps/desktop`, `packages/core`, `packages/storage`, `packages/pi-adapter`, `packages/execution-supervisor`, `packages/mcp-adapters`, `packages/capability-host` · **Commit:** `34fe9eb`

## Kết luận

Người dùng chỉ thấy một hội thoại và một Clark, nhưng phía sau runtime đang chạy **bảy loại việc** (lượt main session, background Pi session, lệnh shell, task worker, terminal pty, MCP stdio server, build cô lập). Mỗi loại tự giữ một `Map` riêng, không có chỗ nào biết toàn bộ những gì đang chạy. Hệ quả cụ thể:

1. **Tắt node (SIGTERM/SIGINT) không dừng hết việc.** Lệnh shell (chạy trong process group riêng) và task worker không bị kill khi shutdown, còn background session không bị dispose.
2. **Không có "hỏi Clark đang làm gì".** Main Pi không có tool để liệt kê hay huỷ việc nền. Chỉ có `POST /stop` dừng *toàn bộ* node.
3. **Restart node làm mất việc mà không báo.** Việc nền và task đang chạy biến mất, hội thoại không nhận được dòng nào báo "đã bị gián đoạn". Task trong DB vẫn nằm ở trạng thái `running` mãi.
4. **Lệnh do model chạy thừa hưởng toàn bộ `process.env` của runtime**, gồm cả provider key. Allowlist môi trường mà README mô tả thực ra chỉ áp dụng cho task worker.

Đề xuất trung tâm là **một Work Supervisor duy nhất trong runtime**: mọi đơn vị việc đăng ký vào đó, và các thao tác stop, shutdown, liệt kê cho UI hoặc model, khôi phục sau restart đều đi qua cùng một chỗ. Hướng này khớp với mô hình tinh gọn: người dùng vẫn chỉ nói chuyện với một Clark, còn Clark thì biết chính xác mình đang chạy gì.

## 1. Hiện trạng: bản đồ các đơn vị việc

| Đơn vị việc | Nơi sở hữu | Registry | `POST /stop` | Shutdown | Deadline | Giới hạn số lượng |
|---|---|---|---|---|---|---|
| Lượt main session (Pi in-process) | `model-turn.ts:591` `turns` | Map theo conversation | interrupt | `dispose()` **không await** | `maxWallClockMs` (`model-turn.ts:930`) | 1/hội thoại, không giới hạn toàn node |
| Background Pi session | `model-turn.ts:598` `backgroundSessions` | Map **theo conversationId** | abort + dispose | **không** | **không** | **không** |
| Lệnh shell `run_command` | `run-command.ts` `liveCommands` | có | có | **không** | 120 s | **không** |
| Task worker (`apps/worker`) | `task-dispatch.ts:126` `liveChildren` | có | SIGKILL | **không** | 120 s | 2 song song, hàng đợi **không giới hạn** |
| Terminal pty | `terminal-sessions.ts` | có | có | có (`main.ts:372`) | không (theo thiết kế) | 12 đang chạy |
| MCP stdio server | `mcp-adapters` `StdioMcpTransport` | theo transport | không | không có đường chung | 15 s/request | không |
| Build cô lập (tar, build cmd) | `capability-host/quarantine.ts:183,368` | cục bộ trong promise | không | không | 60/120 s | không |

`application/emergency-stop.ts` là nơi duy nhất cố gom mọi thứ lại, và chính comment trong file đó thừa nhận vấn đề: *"Dispatched task workers are their own child processes, outside `stopRunningCommands`'s registry … and outside the turn control"*. Mỗi loại việc mới lại phải nhớ tự nối vào stop, shutdown và UI. MCP và build hiện chưa được nối.

## 2. Thiếu sót đã kiểm chứng

Mọi mục dưới đây đều đã được đối chiếu với code tại commit `34fe9eb`.

### Mức cao

**H1. Shutdown bỏ sót việc đang chạy và không chờ dọn xong.**
`main.ts:368-379` chỉ gọi `voice.close()`, `terminals.stopAll()`, `terminalGateway.close()`, sau đó `modelTurn.dispose()` (không await) rồi `process.exit(0)`. Có ba vấn đề:
- Không gọi `stopRunningCommands()` hay `taskDispatch.stopAll()`. Lệnh shell được spawn với `detached: true` (`run-command.ts:159`), tức là nằm trong process group riêng, nên **sống tiếp sau khi node thoát** và trở thành process mồ côi (đúng failure mode "ghost process").
- `dispose()` (`model-turn.ts:1011-1017`) chỉ duyệt `turns` mà bỏ qua `backgroundSessions`.
- `void modelTurn?.dispose()` chạy ngay trước `process.exit(0)`, nên việc dọn không có cơ hội chạy xong.
- Không có handler cho `uncaughtException`/`unhandledRejection`, nên khi crash cũng không có đường dọn nào chạy.

**H2. Hai việc nền trong cùng một hội thoại ghi đè lên nhau.**
`backgroundSessions.set(input.conversationId, handle.sessionId)` (`model-turn.ts:851`) dùng conversationId làm khoá. Khi hội thoại A khởi động việc nền thứ hai, entry của việc thứ nhất bị ghi đè. Sau đó việc thứ nhất kết thúc và `delete(conversationId)` (`:860`) xoá luôn entry của việc thứ hai. Từ lúc đó `POST /stop` **không còn với tới** việc thứ hai (`stopBackgroundSessions` chỉ duyệt map này). Thêm nữa, id hiển thị trên UI (`bg-…`, `routes/conversations.ts:501`) khác với id Pi session, nên không có cách nào huỷ theo id.

**H3. Lệnh do model chạy thấy được provider key.**
`run-command.ts:163`: khi `options.env` vắng mặt thì child thừa hưởng nguyên `process.env`. Khi có secret được inject, `:305` còn trộn `{ ...process.env, ...request.env }`. Terminal pty cũng copy nguyên `process.env` (`terminal-sessions.ts:591-594`), và model có thể điều khiển terminal qua `terminal-tools.ts`. Chỉ `worker-process.ts:110` áp dụng `buildEnvironment(WORKER_ENV_PROFILE)`. Vì vậy câu README *"an environment allowlist that drops … provider keys before spawning a child"* chỉ đúng với task worker. Một lệnh `env` do model chạy sẽ in ra key của runtime.

**H4. Không có khôi phục khi boot.**
`bootRuntime()` (`node.ts:206-219`) chỉ chạy migration. Hàm `unsettledEffects()` (`storage/src/repositories/effects.ts:79`) tồn tại nhưng không được gọi ở đâu. Task ở trạng thái `running`/`dispatched` của lần chạy trước giữ nguyên trạng thái đó mãi, dù state machine đã có sẵn `uncertain`/`reconciling` (`contracts/src/tasks.ts:148-156`). `docs/distributed-runtime.md` §8 yêu cầu "Executor restart: recover task/effect ledger" nhưng phần này chưa được implement.

### Mức trung bình

**M1. Main Pi không biết và không điều khiển được việc nền.** Tool của Main Pi gồm `control_app`, `read_attachment`, `run_command`, `search_files`, `remember`, `search_directory`, `ask_user` (`node-tools.ts`), không có tool nào kiểu list/cancel work. Điều này trái với AGENTS.md: *"Any important action should be reachable through conversation"*. Người dùng nói "dừng việc tóm tắt kia đi" thì Clark không làm được, chỉ có thể dừng toàn bộ.

**M2. Stop chỉ có một mức: toàn node.** `routes/control.ts:50-60` gọi `performEmergencyStop` cho mọi hội thoại, mọi terminal, mọi task. Không có cách dừng theo hội thoại hay theo một đơn vị việc.

**M3. Việc nền không có deadline và không có trần số lượng.** `runInBackground` (`model-turn.ts:839-864`) không có `maxWallClockMs`, trong khi lượt foreground có. Một provider treo sẽ giữ session vô thời hạn. Việc nền cũng không có trần toàn node.

**M4. Main session không bao giờ được thu hồi khi rảnh.** `turns` chỉ bị `delete` khi lượt thất bại (`model-turn.ts:968`). Mỗi hội thoại từng có lượt sẽ giữ một Pi session sống (gồm context và subscription) cho tới khi process tắt. `generationModels` cũng tăng không giới hạn.

**M5. Hàng đợi task không có biên và stop không có SIGTERM trước.** `task-dispatch.ts:125` `queue: QueuedRun[]` không giới hạn độ dài. `stopAll()` gửi `SIGKILL` ngay (`:306`), và worker không chạy trong process group riêng nên process cháu của nó có thể sống sót.

**M6. Fencing epoch có nhưng không được kiểm tra.** `mayActUnderLease()` (`core/src/coordination.ts:180-193`) chỉ được định nghĩa mà không được gọi ở đâu ngoài package. Lease hết hạn chỉ được thu hồi một cách lười biếng, lúc có lần acquire tiếp theo (`coordination.ts:66-101`). Cách này đúng về mặt loại trừ, nhưng UI và model có thể thấy lease "sống" đã chết từ lâu.

**M7. Build và MCP server nằm ngoài mọi quota và mọi stop.** Build (`quarantine.ts:368`) chạy song song với 2 task worker mà không ai tính chung. MCP stdio server không nằm trong emergency stop.

**M8. Bộ quyết định steer/interrupt/background thiếu dữ liệu.** `routes/conversations.ts:656` tự ghi chú: *"A turn's elapsed time is not tracked yet, so the decider is told zero"*. Jev chọn giữa steer, interrupt và background mà không biết lượt hiện tại đã chạy bao lâu.

### Mức thấp

- **L1.** Việc nền bị dừng được ghi thành `failed` (`BackgroundSession.status` không có `stopped`), trong khi §7.4 của kiến trúc nói rõ *"stopped chứ không phải failed"*.
- **L2.** Client ngắt kết nối giữa lượt thì lượt vẫn chạy tiếp (`server.ts:168-195`). Đây là hành vi đúng cho mô hình một hội thoại vì kết quả vẫn vào timeline, nhưng chưa được ghi lại như một quyết định trong DESIGN.md.
- **L3.** Outbox chỉ tăng bộ đếm lần thử (`storage/src/repositories/outbox.ts:22-24`), chưa có backoff hay dead-letter. Cancel cũng không được truyền sang peer khi task đã được ủy quyền cho node khác (`core/src/task-service.ts:504-526`).
- **L4.** `task.budget` (`contracts/src/tasks.ts:308-314`) được khai báo nhưng không được enforce trong lúc chạy.

### Nhận định của subagent đã bác bỏ sau khi kiểm chứng

- *"Pi worker process vẫn chạy sau restart"*: sai. Pi chạy **in-process** (`system-architecture.md` §7.3), nên session chết cùng node. Vấn đề thật là kết quả biến mất mà không có thông báo (H4 và mục P1-3 bên dưới), không phải process Pi mồ côi.
- *"MCP child có thể bỏ qua SIGKILL"*: sai. SIGKILL không thể bị chặn hay bỏ qua.
- *"Electron đọc identity.json bị race"*: không đủ bằng chứng, nên không đưa vào.

## 3. Đề xuất cải thiện

### 3.1 Kiến trúc đích: Work Supervisor

```text
                      ┌──────────────── Work Supervisor (apps/runtime/src/work-supervisor.ts) ───────────────┐
 Main Pi tool ───────►│ list(scope)  cancel(workId|conversationId, reason)  drain(reason, graceMs)           │
 UI chrome count ────►│ registry: Map<workId, WorkUnit>                                                       │
 POST /stop ─────────►│ WorkUnit = { workId, kind, conversationId?, title, startedAt, deadlineAt?,            │
 SIGTERM/crash ──────►│              pid?/pgid?, state, cancel(reason), onSettled }                           │
                      │ quota per kind + global; hàng đợi có biên; ghi durable vào bảng work_runs            │
                      └───────▲────────▲───────────▲──────────▲──────────▲───────────▲──────────▲──────────────┘
                           turn   background   command    task worker  terminal   MCP server   build
```

Các nguyên tắc cho Work Supervisor:

- **Một nguồn sự thật cho "đang chạy gì".** `emergency-stop.ts`, shutdown, `GET /background-sessions` và tool của model đều đọc từ registry, không tự ghép nhiều map.
- **Không đổi mô hình người dùng.** Supervisor là chi tiết implementation. UI vẫn chỉ hiện số việc nền trong chrome khi số đó khác 0 (theo DESIGN.md), và chi tiết là progressive disclosure.
- **Kế thừa cơ chế tốt đang có**, không viết lại: `killTree` theo process group của `run-command.ts`, lease/epoch của `packages/core`, retention có biên của `background-sessions.ts`.
- Mô hình này tương ứng với supervision tree của Erlang/OTP: mỗi con có một cha chịu trách nhiệm, có chiến lược dừng và có thời hạn shutdown [1].

### 3.2 Lộ trình theo mức ưu tiên

**P0: sửa ngay, rủi ro thấp, không cần supervisor**

1. **Shutdown dùng lại emergency stop rồi mới đóng.** `shutdown()` gọi `await performEmergencyStop(...)` (đường này đã phủ commands, turns, background, tasks, terminals), sau đó `await modelTurn.dispose()`, `await voice.close()`, `await terminalGateway.close()`, rồi `runtime.close()`. Thêm hard-timeout (khoảng 5 s) để tránh treo. Đăng ký thêm `uncaughtException`/`unhandledRejection` để chạy cùng đường này, và đảm bảo shutdown chỉ chạy một lần.
2. **`dispose()` dọn cả `backgroundSessions`.**
3. **Sửa khoá `backgroundSessions`**: dùng `Map<workId, {conversationId, sessionId}>`, và trả về đúng id mà UI đang hiển thị để có thể huỷ theo id.
4. **Áp allowlist env cho `run_command` và terminal do model điều khiển.** Dùng `buildEnvironment(profile)` thay cho `process.env`, và chỉ cộng thêm secret đã được broker cấp. Terminal do người dùng tự mở có thể giữ env đầy đủ nếu đó là quyết định sản phẩm (xem câu hỏi mở). Cần sửa câu trong README cho đúng với hành vi thật.

**P1: Work Supervisor và khả năng quan sát qua hội thoại**

1. Tạo `work-supervisor.ts` và cho 7 loại việc đăng ký vào đó. Chuyển `emergency-stop.ts` sang `supervisor.cancelAll()` và thêm `cancel(conversationId)` và `cancel(workId)`. Thêm route `POST /work/{id}/cancel`.
2. **Hai tool cho Main Pi: `list_work` và `stop_work`.** Kết quả trả về đã được sanitize: tiêu đề, loại, thời gian đã chạy, trạng thái, không có pid hay path. Voice và text đi cùng một action path, đúng quy tắc voice trong AGENTS.md.
3. **Bản ghi durable `work_runs`** (migration mới, không sửa migration cũ). Bảng có các cột `work_id, kind, conversation_id, title, pid, pgid, proc_start_time, boot_id, state, started_at, ended_at`. Khi boot:
   - Mọi dòng `running` của `boot_id` cũ chuyển sang `interrupted`, và **một host reply được thêm vào đúng hội thoại**, ví dụ: *"Việc 'X' bị gián đoạn vì node khởi động lại; kết quả chưa có. Bạn muốn chạy lại không?"*. Đây là cách báo sự thật theo AGENTS.md: nói điều gì đã hỏng, điều gì còn giữ, và người dùng làm gì được.
   - Với các dòng có `pgid`, chỉ kill khi `/proc/<pid>/stat` starttime khớp với giá trị đã ghi (để tránh kill nhầm PID đã được tái sử dụng). Bước này dọn các lệnh shell mồ côi còn sót từ lần crash trước.
   - Task `running`/`dispatched` chuyển sang `uncertain`, và gọi `unsettledEffects()` để đưa effect vào reconcile.
4. **Deadline và quota:** việc nền có `maxWallClockMs` riêng (có thể cấu hình), trần N việc nền trên toàn node, hàng đợi task có biên, và khi hàng đợi đầy thì trả lời rõ trong hội thoại thay vì âm thầm xếp hàng. Build tính chung quota với worker.
5. **Dừng theo hai bậc:** SIGTERM, chờ grace (khoảng 1,5 s), rồi SIGKILL cả process group. Task worker cũng chạy `detached` để kill được cả process cháu. Trên Linux có thể cân nhắc thêm `PR_SET_PDEATHSIG` qua một wrapper nhỏ để con tự chết khi cha chết đột ngột [3]. Không bắt buộc nếu đã có bước dọn khi boot.

**P2: vệ sinh tài nguyên và ngữ nghĩa**

1. Thu hồi Main Pi session khi rảnh: dùng LRU/TTL (ví dụ 30 phút không có lượt). Không mất dữ liệu vì transcript nằm trong DB và lượt đầu của session mới đã có recap 12 message (`model-turn.ts:225-241`).
2. Theo dõi thời gian đã chạy của lượt và truyền `runningMs` thật cho `decideTurnAction` (M8).
3. Thêm trạng thái `stopped` cho việc nền (L1).
4. Có bộ quét định kỳ nhẹ cho lease hết hạn, và gọi `mayActUnderLease()` trước khi effect chuyển `prepared → submitted` (M6).
5. Outbox có backoff và dead-letter, cancel được truyền sang peer, và `task.budget` được enforce (L3, L4).
6. Mọi `setInterval` (`pi-session-watch.ts:334`, `server.ts:181`, `voice-session.ts:1031`) đăng ký vào supervisor để được dọn khi drain.

### 3.3 Kiểm chứng cần có khi implement

- Unit (`apps/runtime/test/*.spec.ts`): hai việc nền trong cùng hội thoại đều bị stop với tới; shutdown kill được lệnh `sleep 60` (kiểm tra pgid không còn); boot với `work_runs` có trạng thái `running` thì sinh ra đúng một host reply; env của `run_command` không chứa biến key giả lập.
- E2E (`apps/web/e2e`): hỏi "đang chạy gì?" và nhận câu trả lời đúng, nói "dừng việc X" thì chỉ việc X dừng. Cần theo UI definition of done trong AGENTS.md.
- Cập nhật `docs/system-architecture.md` §7.3/§7.4/§10 (đoạn "danh sách background session sống trong bộ nhớ" sẽ đổi) và `docs/conformance-traceability.md` khi có test thật.

## Câu hỏi còn mở

1. Terminal do **người dùng** tự mở có nên giữ env đầy đủ như một shell thật không, trong khi terminal do **model** điều khiển thì bị lọc? Hay lọc cả hai?
2. Sau restart, Clark nên **tự chạy lại** việc nền bị gián đoạn, hay chỉ báo và hỏi? Đề xuất mặc định là chỉ báo và hỏi, vì việc chạy lại có thể có side effect.
3. Trần việc nền toàn node nên là bao nhiêu? Đề xuất là 3, cấu hình được qua Settings > Control.

## Nguồn tham khảo

1. Erlang/OTP — Supervisor Behaviour (supervision tree, shutdown strategy): https://www.erlang.org/doc/system/sup_princ.html
2. Node.js — `child_process` `options.detached` và process group: https://nodejs.org/api/child_process.html#optionsdetached
3. Linux man-pages — `prctl(2)`, `PR_SET_PDEATHSIG`: https://man7.org/linux/man-pages/man2/prctl.2.html
4. Linux man-pages — `proc_pid_stat(5)` (trường `starttime` để chống PID reuse): https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
5. Node.js — `process` signal events (`SIGTERM`, `SIGINT`): https://nodejs.org/api/process.html#signal-events

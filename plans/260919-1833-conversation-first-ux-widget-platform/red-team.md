# Red-team answers

Plan `260919-1833-conversation-first-ux-widget-platform`, mục "Red-team questions bắt buộc trước khi
bắt đầu mỗi Stage". Mỗi stage trả lời những câu thuộc stage đó **trước khi** bắt đầu, và câu trả lời
phải dựa trên code đã ship chứ không dựa trên ý định.

Quy ước: mỗi câu trả lời nêu kết luận trước, rồi tới bằng chứng, rồi tới những chỗ **không** đạt kèm
việc đã sửa. Một câu trả lời chỉ nói "không sao" mà không chỉ ra chỗ đã kiểm thì không tính là trả lời.

---

## Stage A — Phase 1 (preference registry) và Phase 2 (execution policy)

### Câu 2 — Có tạo execution path thứ hai thay vì reuse action/policy path không?

**Kết luận: không. Một resolver duy nhất, và chỗ dễ sinh đường thứ hai nhất đã bị soi lại.**

`decideExecution` là một hàm thuần trong `packages/core/src/execution-policy.ts`, và ba seam gọi nó thay vì
tự quyết định:

- `run_command` (apps/runtime/src/run-command.ts) — hỏi policy trước khi chạy.
- widget action — route `/actions` trả `POLICY_REFUSED` thay vì tự chạy effect.
- install — `install-from-source.ts` đi qua cùng policy trước khi stage.

Bằng chứng: [execution-policy.spec.ts](../../packages/core/test/execution-policy.spec.ts) và
[install-from-source.spec.ts](../../packages/core/test/install-from-source.spec.ts).

Chỗ dễ sinh đường thứ hai nhất xuất hiện **sau** Stage A, ở Phase 12 khi cửa sổ detached cần tự hành động. Nó
**không** tạo đường thứ hai: `detached:intent` gọi đúng route `/conversations/:id/widgets/:instanceId/actions`
mà shell gọi, nên policy áp dụng y hệt, và host chỉ thay credential chứ không thay quyết định.

### Câu 3 — Có fake “Autonomous” bằng cách chỉ ẩn approval card nhưng backend vẫn waiting không?

**Kết luận: không, và có một cơ chế khiến việc fake trở nên bất khả thi về mặt cấu trúc.**

Điều đáng kiểm không phải là "có ẩn card không" mà là "effect không có card thì để lại gì". Ở đây:
`recordEffectExecution` ghi một bản ghi audit cho mỗi effect chạy mà không qua approval card, và tham số `audit`
là **bắt buộc** — khi node không có nó thì `createNodeTools` không đăng ký `run_command`, tức là node **hỏi**
thay vì tự chạy. Một effect không ai duyệt và không ai tìm lại được là thứ tệ hơn một câu hỏi, nên nó không
được phép tồn tại.

Bằng chứng: execution-policy.spec.ts (bao gồm nhánh `audit` absent → ask), và `apps/runtime/test/node-tools.spec.ts`
cho phần đăng ký tool.

**Điều Autonomous KHÔNG làm, và đây là chỗ dễ hiểu sai nhất:** nó không vượt qua biên giới của OS, OAuth,
browser hay vendor. Những biên giới đó nằm ngoài `ExecutionRule` — policy chỉ chọn giữa "tự làm", "hỏi theo
luật" và "luôn hỏi" cho những việc mà host vốn được phép làm. Một hộp thoại xin quyền ghi màn hình của hệ điều
hành không phải là approval card mà Autonomous được phép bỏ qua.

---

## Stage B — Phase 3–6 (Orb, Settings IA, personal instructions, voice)

### Câu 4 — Orb personalization có thể gây GPU runaway/unbounded physics/CSS injection không?

**Kết luận: bounded ở cả bốn đường, và mỗi đường có test riêng.**

1. **Giá trị bị chặn trong range.** `orb-profile.spec.ts` kiểm từng trường số bị clamp, và `profileKey` ổn
   định. Không có trường nào là chuỗi tự do đi vào physics.
2. **Không có đường CSS injection.** Các giá trị được ghi thành CSS custom property từ **số đã validate**,
   không từ chuỗi người dùng. Đây là lý do `custom` vẫn là một profile có kiểu, không phải một stylesheet.
3. **Vòng lặp pointer nằm ngoài React state.** `Orb.tsx` dùng `useRef` + rAF; `apps/web/e2e/orb.spec.ts` đếm
   số WebGL context qua 20 pointer event để chứng minh canvas **không** bị dựng lại khi gõ phím hay di chuột —
   đây là bài kiểm cho "GPU runaway", và nó fail nếu ai đó đưa pointer vào state.
4. **Reduced motion thắng.** Đến từ tập token rút gọn (`MOTION_REDUCED`) chứ không phải hệ số ×0, nên không có
   chuyện spinner vô hạn với duration 0. `packages/design-tokens/test/motion.spec.ts` kiểm điều này.

Chỗ chưa đạt, nói rõ: `maxPixelRatio` được giới hạn (1.25 ở orb onboarding) chứ không đo trên GPU thật. Một
máy yếu vẫn có thể thấy orb nặng hơn mong muốn; đây là con số đánh đổi, không phải một phép đo.

### Câu 5 — Personal instruction có thể override product/security/tool semantics ngoài precedence dự kiến không?

**Kết luận: instruction ảnh hưởng tới *lời nói*, không thay đổi được *quyền*. Ranh giới đó là ranh giới thật.**

`personal-instructions.ts` chạy qua `before_agent_start`, nhận `event.systemPrompt` và trả về `{systemPrompt}`
đã ghép thêm phần của người dùng. Nó **chỉ** có thể viết thêm văn bản vào system prompt. Nó không sửa được
định nghĩa tool, không sửa được policy, không sửa được registry capability — những thứ đó nằm trong runtime,
không nằm trong prompt.

Bằng chứng: [personal-instructions.spec.ts](../../packages/pi-adapter/test/personal-instructions.spec.ts) và
[personal-instructions-wiring.spec.ts](../../packages/pi-adapter/test/personal-instructions-wiring.spec.ts).
`sdk-compatibility.spec.ts` ghim API thật của SDK, vì bản SDK 0.85.1 **không** có `systemPromptOptions.sections`
mà bản plan giả định.

Chỗ một reviewer nên phản đối nếu thấy chưa đủ: instruction nằm trong prompt nên nó **vẫn** lái được lựa chọn
của model (đó là mục đích), kể cả những lựa chọn mà người viết không lường trước. Thứ nó không lái được là thứ
runtime cho phép. Nói cách khác: nó thay đổi *ý định*, không thay đổi *quyền*.

### Câu 6 — Voice option có đang hardcode Gemini vào component không?

**Kết luận: không hardcode; component đọc capability. Nhưng chỉ có **một** adapter ship, nên danh sách chọn
hiện rất mỏng — và điều đó được nói ra thay vì che.**

`voiceCapabilitiesSchema` nằm trong contracts, `VoiceProviderAdapter.capabilities` trả nó, gateway phơi
`GET /voice/capabilities`, và picker trong `DevicesVoiceSettings` render từ câu trả lời đó. `buildSetupMessage`
nhận `voiceName` đã chọn, nên session dùng đúng giọng người dùng chọn.

Bằng chứng: [voice-capabilities.spec.ts](../../packages/voice-adapters/test/voice-capabilities.spec.ts) và
`apps/runtime/test/voice-gateway.spec.ts` (fixture chứng minh wiring chứ không chứng minh provider — `CC_VOICE_FIXTURE=1`).

Hai chỗ chưa đạt, nói rõ:

- Chỉ Gemini Live có adapter. Interface là thật, tập implementation là một phần tử.
- Preview **không** được giả: adapter trả `supportsPreview: false` kèm lý do, nên không có nút nghe thử.

---

## Stage C — Phase 7 và Phase 8 (app intents, desktop modes, detach, wake word)

### Câu 7 — Detached widget có tạo second live owner/subscription/media playback không?

**Kết luận: không, và đây chính là câu hỏi mà cửa sổ detached được dựng lên để trả lời.**

Bốn đường, mỗi đường đóng bằng cấu trúc chứ không bằng thiện chí:

1. **Không có owner thứ hai.** Node từ chối owner thứ hai (core.spec: "refuses a second live owner for the
   same instance"), và handoff là **release trước, claim sau**: shell release lease rồi host mới claim surface
   `detached`. Nếu cửa sổ không mở được, lease được claim lại chứ không bỏ trống. Một yêu cầu detach thứ hai
   trong lúc đã có cửa sổ bị từ chối thẳng ("a widget is already detached") thay vì mở owner thứ hai.
2. **Không có subscription thứ hai.** Cửa sổ detached **không fetch** gì cả: composition đến trong bootstrap,
   và `detached-window.spec.ts` kiểm rằng bootstrap không thể bị mở rộng thêm token/gateway/conversation id.
   Không có fetch thì không có subscription thứ hai để rò.
3. **Không có media playback.** `DetachedWidgetSurface` không có đường autoplay; nó vẽ composition được đưa.
4. **Không có credential trong cửa sổ.** `reviewIpcCall` quyết định theo **document**: shell không hỏi được
   `detached:bootstrap`, và cửa sổ detached không hỏi được `desktop:getSession` (tức là không lấy được token).
   Đây là điều được kiểm trong desktop smoke test.

**Chỗ chưa đạt, và nó nằm trong chính câu trả lời này:** journey mở/đóng cửa sổ detached **không** được kiểm
bằng e2e tự động cho tới lượt sửa này — trước đó chỉ có contract test + smoke test. Contract (b) đòi e2e cho
visible journey change, nên đây là một thiếu sót thật, và nó được bù bằng `apps/web/e2e/detach.spec.ts`.

---

## Stage D — Phase 9 (JIT onboarding) và Phase 10 (P0 agentic widget catalog)

### Câu 1 — Feature này có đang leak Pi/Jev/node concept lên default UI không?

**Kết luận: có, ba chỗ. Cả ba đã sửa trong cùng change này.** Đây là câu hỏi có kết quả thật, không
phải câu hỏi để tick.

Ba chỗ leak:

1. **Thẻ phiên browser/desktop in ra "Lease epoch"** — một con số giao thức. Tệ hơn, nó do chính
   Phase 10 này thêm vào, kèm một lý lẽ nghe hợp lý ("không thấy epoch thì không biết takeover có hiệu
   lực không"). Lý lẽ đó sai chỗ: thứ người đọc cần biết là **kết quả** — hành động agent đã lên kế
   hoạch đã bị từ chối — và câu đó đã có sẵn trong thông báo. Con số vẫn còn, nhưng là
   `data-control-epoch` cho test đọc, không phải chữ cho người đọc.
2. **Thẻ artifact in `từ <originNodeId>`** — node id thô. Nay là "từ một node khác": cùng thông tin
   hữu ích, không lộ tên nội bộ.
3. **Thẻ task fallback về node id thô** khi node không có label. Nay cũng là "một node khác".

Những chỗ đã đúng và được xác nhận lại:

- Settings theo 6 tab do người dùng đặt tên; Pi internals chỉ còn trong tab Developer (Phase 4).
- Onboarding mới không hỏi node: setup card nói provider/model/key, là ba thứ người dùng sở hữu.
- Thẻ hội thoại hiển thị nội dung, không hiển thị id trừ khi id **là** nội dung (ví dụ task id trong
  thông báo dừng task, nơi người dùng cần nó để đối chiếu).

Điều còn lại chưa làm, nói rõ: các thẻ vẫn hiện **digest** trong khối artifact khi mở lại. Digest là
dữ kiện của node, nhưng nó cũng là thứ duy nhất trả lời được "có đúng file này không", nên nó ở lại;
đây là chỗ một reviewer có thể phản đối và nên phản đối nếu thấy chưa đủ lý do.

### Câu 10 — Một design target chưa implement có bị UI/docs quảng cáo như shipped không?

**Kết luận: UI thì không; có ba khoảng trống được ghi lại thay vì quảng cáo.**

UI không nói dối ở những chỗ đã ship:

- Wake word: không có detector local nào ship, nên toggle **không dùng được và nói rõ lý do** (Phase 8).
- Voice preview: adapter trả `supportsPreview: false` kèm lý do, không có nút giả (Phase 6).
- Phiên desktop: mặc định `needs-permission`, thẻ nói quyền thuộc hệ điều hành và node không tự cấp
  được; không vẽ preview giả (Phase 10).
- `WIDGET_RUNTIME_STATUS` khi đó vẫn là `bridge-codec-implemented-runtime-pending`, tức là nó nói thật là chưa
  có runtime. Phase 11 đã đổi thành `runtime-and-host-session-implemented` (PR #44), và giá trị mới cũng nói rõ
  hai điều **chưa** đúng: chưa có mini-app nào ship, và conversation client chưa mount frame nào.

Ba khoảng trống, ghi lại chứ không quảng cáo:

1. **Artifact chưa có producer thật.** Bảng, route, control đều thật; không có gì trong sản phẩm tạo
   ra artifact, nên đường này chỉ tới được bằng fixture. Đã nêu trong PR #37 và trong commit.
2. **Phiên browser/desktop chưa có launcher thật.** Mô hình quyền (lease, takeover, stop) là thật và
   có test; không có chỗ nào trong sản phẩm **mở** một phiên, nên hiện chỉ fixture tạo được. Đã nêu
   trong PR #39 và #40.
3. **DESIGN.md mô tả target, không mô tả shipped.** AGENTS.md cho phép điều đó, và chưa có câu nào
   trong DESIGN.md được viết như thể Phase 11–13 đã xong.

Hệ quả cho Stage D: stage này đóng được, nhưng hai khoảng trống (1) và (2) là **nợ kỹ thuật có tên**,
không phải chi tiết bỏ qua. Nếu Phase 11–13 ship runtime mà không có producer nào chạm tới ba widget
đó, thì catalog P0 sẽ mãi là thứ chỉ fixture chạm tới.

---

## Stage E — Phase 11 (Widget SDK runtime) và Phase 12 (Widget CLI)

### Câu 9 — Widget author API có thêm quyền generic chỉ vì dev convenience không?

**Trả lời trước khi bắt đầu (contract h), và đây là điều Phase 11–12 sẽ bị soi lại:**

Không, và có ba chỗ dễ trượt mà tôi cam kết giữ:

1. **Không có `invoke` generic.** Frame chỉ gửi được những message **có tên** trong codec đã có, và mỗi
   message đi qua một hàm host validate riêng. Một `{type: "invoke", method, args}` sẽ biến bridge
   thành RPC tới mọi thứ host làm được — đó chính là thứ Phase 12 dễ muốn thêm vì test cho nhanh.
2. **Quyền nằm trong manifest, không nằm trong lời gọi.** Capability phải khai báo trước và được duyệt
   như dữ liệu; runtime không cấp thêm quyền vì widget "cần". Capability simulator trong dev host mô
   phỏng **quyền đã khai báo**, không phải quyền tùy ý.
3. **Dev host không nới quyền so với production.** Cùng codec, cùng sandbox policy; chỉ khác nguồn
   bundle và có inspector. Nếu `npm run dev` cho widget làm được điều mà bản pack không làm được thì
   đó là bug của dev host.

Cách kiểm: test bị từ chối là test ngang hàng với test thành công — forged nonce, sai source window,
message không có trong codec, capability chưa khai báo, và vượt budget đều phải **fail** có tên. Nếu
Phase 11–12 chỉ có test happy path thì câu này coi như chưa trả lời.

---

## Stage F — Phase 13 (Package Marketplace & directory)

### Câu 8 — Marketplace có đang bypass exact digest/generation/rollback không?

**Trả lời trước khi bắt đầu (contract h), và đây là điều Phase 13 sẽ bị soi lại:**

Không, và có bốn chỗ dễ trượt mà tôi cam kết giữ:

1. **Không installer thứ hai.** Mọi nguồn — local path, git exact ref, npm exact version — đều đi qua
   `joinOrCreatePlan` → `advanceInstall` → `activateGeneration` như hiện có. Marketplace chỉ là một
   **nguồn resolve**: nó tạo ra cùng một `InstallPlan`, không tạo ra đường cài riêng.
2. **Digest không được nới.** Một nguồn chỉ được chấp nhận khi resolve ra đúng digest đã công bố.
   "Cài từ marketplace" không phải lý do để bỏ qua kiểm tra digest, và một lần cài không có digest
   phải bị từ chối chứ không phải được mặc định.
3. **Generation/rollback giữ nguyên.** Cài xong vẫn tạo generation mới và vẫn rollback được khi
   healthcheck fail. Marketplace không được phép "cài trực tiếp" để tránh bước stage.
4. **Risk lane được label, không bị trộn.** Isolated UI, tool/service và native Pi extension là ba
   lane khác nhau; UI phải nói rõ lane nào, vì native extension là code chạy cùng tiến trình còn
   isolated widget thì không.

Cách kiểm: test cho một nguồn có digest sai phải **fail**, và test rằng rollback đưa về generation

## Stage G — Phase 14 (motion, accessibility, performance, release gates)

### Câu 10 — Một design target chưa implement có bị UI/docs quảng cáo như shipped không?

**Kết luận: ở lượt này thì không, vì docs được sửa trong cùng change với code — và ba khoảng trống vẫn được
ghi lại thay vì quảng cáo.**

Đã đối chiếu lại ở cuối dự án:

- `DESIGN.md` §2.2 nay nói rõ phần detach **đã ship**, kèm ràng buộc thật (không token, relay qua host, lease
  chuyển chứ không nhân bản). Trước đó mục này mô tả target.
- `AGENTS.md` có thêm hard rule cho cửa sổ detached, để người sửa sau không vô tình đưa credential vào đó.
- Ledger chỉ được nâng khi test được nêu tên đã tồn tại (T47 nhận thêm bằng chứng detached-window + smoke).
- 18 tiêu chí release trong `plan.md` được tick kèm bằng chứng chạy được, không tick suông.

Ba khoảng trống, vẫn ghi lại:

1. **`platformSchema` không có giá trị cho Windows** (chỉ darwin/linux/web) trong khi chính app desktop của
   repo là Electron trên Windows. Một package không khai được platform nó chạy. Đây là finding, không phải thứ
   được nới ra cho vừa fixture.
2. **Conversation client vẫn chưa mount frame widget cách ly nào.** Runtime, session và conformance suite là
   thật và có test, nhưng đường executable widget mới tới được ở mức package, chưa tới được từ hội thoại.
3. **Detach mới có một instance tại một thời điểm**, và journey của nó chỉ được kiểm e2e sau khi bổ sung
   `apps/web/e2e/detach.spec.ts`; đường mở cửa sổ thật vẫn cần một lần thử tay trên máy có màn hình.

---

trước đó. Nếu Phase 13 chỉ có test happy path của install thì câu này coi như chưa trả lời.

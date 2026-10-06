# Nền tảng agent thích ứng — kiến trúc mục tiêu

> [English](adaptive-substrate.md) (mặc định) · Tiếng Việt

**Ngày:** 06/10/2026 · **Trạng thái:** kiến trúc mục tiêu, **chưa ship**. Chủ sở hữu: epic [#507](https://github.com/digitopvn/clarkcant/issues/507). Hiện chỉ có các typed contract liệt kê ở §9; chưa có runtime nào đọc chúng, và chưa có hành vi nào người dùng thấy được trong tài liệu này. [system-architecture.vi.md](system-architecture.vi.md) cùng [sơ đồ](system-architecture.png) mô tả những gì đang chạy; khi tài liệu này và một trong hai tài liệu đó khác nhau về hiện trạng, tài liệu đó thắng.

## 1. Vì sao

Model, agent runtime và công cụ tiến bộ nhanh hơn tốc độ ClarkCant tự xây lại chúng. Clark nên giỏi lên bằng cách **tìm, kết nối, điều phối và thay thế** những năng lực tốt nhất đang có, chứ không phải tự sở hữu thêm mọi năng lực. Triết lý sản phẩm trong `AGENTS.md` ("Built for stronger models and better tools") nói điều này; tài liệu này biến nó thành kiến trúc.

Mô hình phía người dùng không đổi: **một Clark, một cuộc hội thoại.** Runtime, session, provider, nguồn khám phá, signal, lịch chạy và package generation vẫn là chi tiết triển khai, chỉ hiện ra như chi tiết kỹ thuật khi có người hỏi.

## 2. Lõi tối thiểu, trí tuệ thay thế được

Code chuyên biệt phía host chỉ hợp lý khi nó sở hữu điều mà không thể tin model tự bảo đảm: quyền hạn, bảo mật, trạng thái tất định, độ bền, idempotency, cô lập, phục hồi, khả năng tương tác giao thức, khả năng quan sát, bằng chứng, hoặc UX và hiệu năng then chốt.

| Lõi Clark luôn giữ thẩm quyền về | Thay thế được sau một contract |
|---|---|
| Danh tính principal và node | Model và provider |
| Ý định người dùng, danh tính Task và Run | Planner và bộ suy luận |
| Grant và quyền sở hữu tài nguyên | Jev / decision provider |
| Secret và credential | Chiến lược ngữ cảnh và xếp hạng |
| Execution policy và đồng ý mở rộng phạm vi | Model router |
| Effect ledger và reconciliation | Agent runtime |
| Trạng thái bền vững, Signal và persistent intent | Bộ đánh giá |
| Package generation và rollback | Provider năng lực và khám phá |
| Artifact | Phần triển khai MCP / API / CLI |
| Stop và huỷ | Driver trình duyệt và máy tính |
| Audit, provenance và bằng chứng; phục hồi | Phần triển khai skill |
| Mô hình hội thoại phía người dùng | Marketplace và provider tìm kiếm |

Model có thể quyết định; host kiểm chứng. Runtime có thể thực thi; Clark giữ quyền hạn và ngữ nghĩa kết quả. Marketplace có thể gợi ý; runtime cục bộ kiểm chứng artifact và grant. Agent có thể tự nhận thành công; bằng chứng mới quyết định Clark Task có thành công hay không.

## 3. Hình dạng

```text
Người dùng ─▶ Clark (một hội thoại) ─▶ ý định ─▶ planner (thay thế được)
                                                    │
                                          capability resolver
                                                    │
                                  resource & capability graph
                 (đã cấp · cục bộ · runtime · peer · package · directory · endpoint · Internet)
                                                    │
                                     có sẵn trong grant hiện có?
                                       có │             │ không
                                          │   khám phá → reach-expansion plan → một lần đồng ý
                                          └──────┬──────┘
                                     Clark Task / Run (một execution owner)
                                                 │
                                        agent runtime fabric
                                                 │
                                         effect + bằng chứng
                                   ┌─────────────┴─────────────┐
                          hội thoại / delivery          improvement observer
                                                                 │
                                                    giả thuyết → skill evolution

Timer · webhook · signal source · kênh · peer ─▶ persistent intent ─▶ cùng Clark Task / Run đó
```

Chỉ có đúng một scheduler, một hệ effect và một vòng đời task. Việc nền và việc định kỳ đi vào cùng đường Task/Run như một yêu cầu của người dùng.

### Vị trí trong sơ đồ hiện tại

Không thêm tầng nào vào [system-architecture.png](system-architecture.png). Runtime fabric tổng quát hoá "Pi Session" và "Worker Management" trong tầng Core Runtime; capability graph mở rộng "Capability Registry"; các discovery provider lấy dữ liệu từ tầng Ecosystem (Package Manager, Marketplace); reach-expansion gate là một phần của Jev/policy; delivery và improvement observer nằm cạnh timeline hội thoại. Khi runtime fabric ship, ô "Pi Session" trong sơ đồ nên đổi sang một nhãn trung lập với runtime.

## 4. Agent runtime fabric

Clark chạy việc qua nhiều agent runtime — runtime đi kèm hiện nay, các coding agent khác cài sẵn về sau — mà không giả định chúng ngang nhau.

- Mỗi runtime được mô tả bằng một `RuntimeDescriptor`: id mờ của Clark, tên hiển thị chỉ là dữ liệu, node chứa nó, cách Clark tích hợp, và một bản ghi `RuntimeFeatures`. Mỗi đặc tính (spawn, attach, observe, resume, fork, steer, stop, event stream, session history, model catalogue, model switching, usage, provider quota, kiểm kê extension/skill/MCP, host approval bridge) được trả lời độc lập là `supported`, `unsupported` hoặc `unknown`. `unknown` không bao giờ được coi là hỗ trợ.
- Thứ tự ưu tiên tích hợp, có cấu trúc nhất trước: native SDK, native protocol (RPC / app server), CLI có cấu trúc, đọc session đã lưu, đọc terminal chỉ khi không còn cách nào khác.
- Quyền hạn trên session là tường minh: `managed` (Clark khởi chạy), `attached` (tham gia qua giao thức điều khiển của runtime), `observed` (đọc có giới hạn, không điều khiển). Một file session vừa được ghi là lịch sử, không phải bằng chứng session còn sống.
- **Mỗi Clark Run chỉ có một execution backend sở hữu.** Fabric tổng quát hoá seam backend của [#402](https://github.com/digitopvn/clarkcant/issues/402); nó không thêm process manager hay recovery stack cho từng runtime. Mọi việc về vòng đời phải chờ ngữ nghĩa sở hữu backend của #402.

## 5. Năng lực: graph, khoảng trống và phạm vi

**Resource & capability graph.** Một mô hình do host sở hữu cho mọi thứ Clark có thể dùng: capability và package đã cài, project và tài nguyên của máy, plugin/skill/MCP server do runtime cung cấp, tóm tắt năng lực của peer ([#264](https://github.com/digitopvn/clarkcant/issues/264)), danh mục directory và Marketplace ([#194](https://github.com/digitopvn/clarkcant/issues/194)), endpoint đã biết và kết quả Internet. "Graph" là mô hình miền; SQLite cùng typed provider là đủ. Main agent hỏi một câu — "cái gì giúp được việc X?" — thay vì gọi một tool tìm kiếm cho mỗi provider.

**Candidate không bao giờ cấp quyền.** Một `CapabilityCandidate` mang provenance (provider, nguồn gốc, độ tin cậy: `verified`, `publisher-claimed` hoặc `unverified`) và dữ kiện để xếp hạng, nhưng không có trường nào cấp quyền, bật hay cài đặt. Nó chỉ có thể được thu nhận ở dạng kiểm chứng được: package chính xác (đường dẫn cục bộ, git revision đã ghim, version registry chính xác), artifact có digest, version CLI package chính xác, MCP/WebMCP endpoint đã biết hoặc tài liệu OpenAPI. Không có dạng nào cho "chạy lệnh này", nên `curl … | sudo bash` từ một trang web không thể thành cách thu nhận.

**Khoảng trống năng lực, tò mò có giới hạn.** Thiếu một năng lực là khoảng trống cần giải, không phải ngõ cụt. Việc giải đi từ ít phạm vi mới nhất đến nhiều nhất — đã cấp, cục bộ, runtime đã cài, node đã ghép cặp, package đã cài, directory, endpoint đã biết, Internet — và sau độ phù hợp thì ưu tiên: đã có sẵn, không cần credential mới, không cần cài, phạm vi filesystem/mạng/dữ liệu nhỏ hơn, provenance mạnh hơn, tương thích, chi phí, độ trễ. Việc khám phá chỉ bắt đầu khi có lý do (thiếu năng lực, cách làm thất bại, độ tin cậy thấp, runtime không sẵn sàng, kết quả chưa đủ, người dùng yêu cầu, khoảng trống lặp lại, standing intent) và bị giới hạn bởi ngân sách (thời gian, số provider, số candidate, token, chi phí, nguồn xa nhất). Khám phá thường trực là một standing intent do người dùng thiết lập, không bao giờ là một crawler vô hình.

**Reach-expansion gate.** *Tự chủ trong phạm vi đã cấp; xin đồng ý rõ ràng trước khi mở rộng.* Khi lấp khoảng trống cần phạm vi mới — một thư mục mới trên máy, cài hoặc bật code, kết nối server hay tài khoản, origin mạng hay bên nhận dữ liệu mới, quyền mới cho runtime hoặc node khác — mọi bước được gom vào một `ReachExpansionPlan`: mục tiêu, lựa chọn khuyến nghị và các phương án thay thế thực sự, các bước của từng lựa chọn, phạm vi filesystem, origin mạng, bên nhận dữ liệu, credential (theo tên, không bao giờ theo giá trị), grant cho runtime/node và trust lane, cùng các phạm vi đồng ý được đưa ra (`once`, `task`, `standing`). Sự đồng ý gắn với từng mục phạm vi đó: yêu cầu sau vươn xa hơn là một câu hỏi mới, yêu cầu ít hơn thì đã được bao. Có cần hỏi hay không vẫn do Jev/policy quyết. Sau khi được đồng ý, host thu nhận qua các đường install/connection hiện có, kiểm chứng năng lực, rồi tiếp tục task ban đầu mà người dùng không phải nói lại.

## 6. Việc định kỳ, signal và delivery

- **Standing intent v2** tái sử dụng lõi Signal → Intent → Effect của [#197](https://github.com/digitopvn/clarkcant/issues/197). Lịch chạy chuyển sang dạng lịch tất định (RRULE cùng timezone, giới hạn đầu cuối, xử lý lần lỡ tường minh); ngôn ngữ tự nhiên được biên dịch sang dạng đó một lần.
- **Execution envelope.** Việc của một standing intent bị giới hạn bởi một `ExecutionEnvelope`: thư mục khi thật sự có thư mục, capability, kết nối tài khoản, effect được phép, data class, ràng buộc executor (node và đặc tính runtime cần có, không bao giờ là tên runtime), ngân sách và đích delivery. "Tóm tắt email quan trọng mỗi sáng" không cần thư mục giả. Một run, lần thử lại hay delegation bắt đầu từ một envelope có thể thu hẹp nó, không bao giờ mở rộng.
- **Signal source** trở thành một package facet chỉ nhận, kiểm chứng và chuẩn hoá thành Signal; dedupe, matching, retry, tạo Task và phục hồi vẫn ở lõi.
- **Delivery router.** Một notice hoặc kết quả chuẩn được định tuyến tới hội thoại, Inbox, thông báo hệ điều hành, web push hoặc một kênh bên ngoài ([#199](https://github.com/digitopvn/clarkcant/issues/199)). Gửi tới một kênh là effect `communication`, và một kênh đã kết nối chỉ dùng được cho standing intent khi envelope của nó nêu tên kênh đó.

## 7. Ngữ cảnh và UX điều phối

Main Clark giữ một `RuntimeSessionSynopsis` có giới hạn cho mỗi session runtime (quyền hạn, trạng thái và nơi đọc được trạng thái, mục tiêu, task, usage, quota, kết quả gần nhất, artifact, data class), mặc định không bao giờ là transcript. Context planner của [#433](https://github.com/digitopvn/clarkcant/issues/433) quyết định khi nào một session có liên quan và nạp chi tiết đã che dữ liệu nhạy cảm theo nhu cầu. Việc song song hiện ra như một mini app Work Plan tạm thời mô tả công việc, không mô tả runtime; định danh runtime, model và session là chi tiết kỹ thuật chỉ hiện khi cần.

## 8. Tự cải thiện

- **Improvement observer** đọc bằng chứng quan sát được (kết quả, lần người dùng sửa, lỗi, fallback, retry, phê duyệt lặp lại, effect không rõ, thiếu ngữ cảnh, chi phí/độ trễ bất thường), không bao giờ đọc suy luận ẩn, và chỉ đề xuất `ImprovementHypothesis` khi đủ bằng chứng.
- **Skill evolution** đi qua các bản sửa ứng viên bất biến: giả thuyết, ứng viên, bộ eval so với đối chứng, canary, promote, theo dõi, rollback. Một ứng viên mở rộng quyền, mạng hay phạm vi dữ liệu phải đi đường phê duyệt package/phạm vi thông thường.
- **Tự cải thiện lõi** chỉ qua branch/worktree, test, review, PR, CI và đường release thông thường. Lõi tin cậy không bao giờ bị vá nóng.

## 9. Các contract đã có hôm nay

Đây là các contract thuần, được kiểm tra lúc chạy, nằm trong `packages/contracts`, có unit test. Chúng có version (`version: 1`) và không chứa tên runtime, vendor hay model nào.

| Contract | File | Mục đích |
|---|---|---|
| `RuntimeDescriptor`, `RuntimeFeatures`, `RuntimeStatus`, `AgentRuntimeAdapter`, `SessionAuthority`, `RuntimeSessionSynopsis` | [`runtime-fabric.ts`](../packages/contracts/src/runtime-fabric.ts) | Mô tả runtime và session mà không giả vờ ngang nhau |
| `CapabilityCandidate`, `AcquisitionSource`, `DiscoveryBudget`, `CapabilityQuery`, `CapabilityProvider` | [`capability-discovery.ts`](../packages/contracts/src/capability-discovery.ts) | Candidate có provenance và không cấp quyền gì |
| `ReachExpansionPlan`, `AcquisitionPlan`, `ReachConsent`, `reachWidening`, `consentDoesNotCover` | [`reach-expansion.ts`](../packages/contracts/src/reach-expansion.ts) | Một câu hỏi mạch lạc; đồng ý gắn với phạm vi |
| `ExecutionEnvelope`, `DeliveryTarget`, `envelopeWidening` | [`execution-envelope.ts`](../packages/contracts/src/execution-envelope.ts) | Ranh giới quyền hạn của việc định kỳ (bản phác) |

Chưa contract nào nằm trên một bề mặt công khai; [open-interfaces.vi.md](open-interfaces.vi.md) không đổi cho tới khi có.

## 10. Thứ tự công việc

Contract và kiểm kê chỉ-đọc có thể tiến hành song song với #402. Mọi thứ có thể tạo execution owner thứ hai, scheduler, cơ chế checkpoint/phục hồi, hay vòng đời trực tiếp từ hội thoại tới runtime đều phải chờ #402. Việc phụ khác project ([#495](https://github.com/digitopvn/clarkcant/issues/495)) đi qua fabric thay vì một đường riêng cho một runtime. Tính liên tục nhiều node ([#209](https://github.com/digitopvn/clarkcant/issues/209)) vẫn tương thích nhưng không chặn các phase cục bộ. Các phase và phụ thuộc của chúng được theo dõi bằng các child issue của #507.

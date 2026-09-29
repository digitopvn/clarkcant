# Distributed Runtime & Deployment

> [English](distributed-runtime.md) (mặc định) · Tiếng Việt

**Baseline:** blueprint v2, 16/09/2026. NodeLink là protocol đề xuất cho các installation của app. Không tuyên bố Pi hoặc A2A đã cung cấp mọi semantics này.

## 1. Mô hình cộng tác: nodes tự chủ, conversation thống nhất

Chọn **federation có kiểm soát**, không distributed shared-memory và không swarm tự trò chuyện vô hạn. Mỗi node chạy độc lập. Một conversation có home node giữ ordered user timeline; node khác được giao task có scope và trả events/artifacts.

Ví dụ:

```text
Desktop conversation client
    -> Home runtime trên VPS A
         -> Desktop node: đọc file đã được cho phép
         -> VPS A: tổng hợp dữ liệu và giữ timeline
         -> VPS B: build/test trong workspace tại B
```

Hoặc desktop local là home, VPS A/B là executors. Không cần user chọn topology mỗi prompt; onboarding/explicit request đặt home, router chọn executor theo permissions/locality. User vẫn có thể hỏi “đang chạy ở máy nào?” hoặc “đừng gửi source ra khỏi laptop”.

Scope đầu: same owner, nhiều machines. Không có implicit trust transitive: A pair B và B pair C không tự cho A quyền C. Không tự forward raw user prompts/secrets tới toàn mạng để hỏi ai nhận việc.

## 2. Giao thức nào dùng cho việc gì?

| Protocol | Vai trò trong app | Không thay thế |
|---|---|---|
| App command/event API | Client ↔ runtime, state/surface/actions | OAuth vendor hay OS isolation |
| Native NodeLink | Node ↔ node delegation, grants, correlated events, artifacts | Shared filesystem/multi-master database |
| MCP | Gọi tools/resources từ service có sẵn | Quản lý toàn bộ conversation/runtime |
| MCP Apps | UI resource + host bridge cho tool apps [R06–R08] | Pin lifecycle và data ownership riêng của app |
| A2A | Adapter tới agent ngoài ecosystem, roadmap [R10] | App-specific UI/state replay/permissions/installation |
| Tailscale/private network | Một lựa chọn reachability và encrypted network [R28] | App identity/grants hoặc approval của user |

Không tự implement đầy đủ tất cả chuẩn ở milestone đầu. MCP/MCP Apps nằm trong baseline; external A2A adapter giữ extension seam nhưng chưa bắt buộc certified release.

## 3. Deployment profiles

### 3.1 Local desktop

App bundle chứa runtime và UI. Socket local private + authenticated handshake. Không public port, không account cloud bắt buộc. Node pairing chỉ bật khi người dùng yêu cầu kết nối máy.

### 3.2 Headless server

OCI core image non-root, data volume persistent, loopback/private bind default. TLS ingress và application auth phải được kiểm tra trước remote use. Người dùng mở web chat hoặc attach bằng desktop client; server không cần monitor/GPU/browser engine cho text/runtime.

Native alternative: signed/checksummed release bundle, unprivileged service account, systemd unit với hardening được test. Config/secrets không nhét vào world-readable flags hoặc shell history. Không bắt user cài Node/Pi globals; launcher sử dụng runtime bundled.

### 3.3 Browser worker

Browser driver/binary thêm khi cần; version engine ghép với Playwright đã pin. Managed profiles nằm ở encrypted/restricted volume phù hợp; không share profile directory giữa hai browser processes. CDP chỉ private và authenticated qua broker, không expose raw port.

### 3.4 Virtual desktop worker

Optional Linux image có desktop/display server và input/screenshot adapter. Không phải một flag “headless=false” trên server không display. Preview/human takeover qua authenticated short-lived transport. Default không mount host home, host display hoặc Docker socket; restrict egress/CPU/memory/PIDs. Container không được coi tương đương VM trước host-kernel adversary.

## 4. Bootstrap và pairing

Cài binary/image là một bước bootstrap ngoài model khi chưa có app. Mục tiêu: installer hoặc command mẫu ngắn do release thực cung cấp, sau đó toàn bộ setup qua chat. Không yêu cầu user học terminal vận hành hằng ngày.

Pairing flow:

1. Node đích tạo device identity và một invite single-use, expiry ngắn; chưa mở quyền tài nguyên.
2. Người dùng đưa endpoint/invite vào chat hoặc scan QR trên một client trusted. Secrets của invite không được lưu nguyên văn vào transcript dài hạn.
3. Client hiển thị host fingerprint/node name và network reachability. TLS/mTLS hoặc signed app handshake xác minh key; endpoint DNS không đủ để tin node.
4. Owner xác nhận cặp nodes và grants ban đầu: ví dụ chỉ `projects.read`, `build.run` trên workspace cụ thể, không host filesystem/root shell.
5. Receiver policy kiểm tra own limits; lưu trust relationship + bounded delegation permissions.
6. Probe, capability negotiation và status card thật. “Paired” khác “có thể chạy Browser Use” hoặc “đã có credentials”.

Invite/QR không phải OAuth access token lâu dài. Replay invite bị reject; key rotation cần authenticated transition; lost device/revoke làm mất quyền từ lần gọi tiếp theo và ngừng nhận delegation mới. Already submitted effects có thể cần reconciliation.

**Trạng thái đã ship (2026-09-20).** Pairing đã chạy thật giữa hai node sống: hai node, hai cổng, hai database, HTTP thật giữa chúng. Device key là Ed25519 sinh tại chỗ, lưu trong `identity.json` với quyền chỉ chủ sở hữu đọc được; fingerprint là sha256 của public key in thành từng nhóm bốn ký tự để một người đọc được thành tiếng. Invite là single-use và hết hạn sau 10 phút; claim ghi peer ở trạng thái **pending**, và pending bị từ chối envelope chứ không được xếp hàng đợi. Chỉ khi một người xác nhận ở **cả hai** phía thì kênh mới mở.

Token mà mỗi node trình cho peer được **suy ra** bằng `HMAC(localToken, peerNodeId)`. Nghĩa là không có credential nào đi qua dây trong lúc pairing (hai bên chỉ trao nhau sha256), và chỉ có sha256 nằm trong database — nên một bản sao database không replay được ở peer. Transport là HTTP tới gateway của chính peer đó (`/peers/messages`), có outbox bền (ghi ý định trước khi gửi) và dedup theo message id ở phía nhận.

**Signal giữa các node đã ghép cặp (issue #244).** Một node báo cho peer đã xác nhận rằng một việc vừa xảy ra bằng `POST /peers/{nodeId}/signals` trên gateway của chính nó; signal được đưa vào outbox dưới dạng message NodeLink `signal`, và một lượt chuyển trên node mang outbox tới các peer — ngay khi có gì được xếp hàng, và sau đó cứ 30 giây một lần, với backoff và dead-letter của chính outbox. `signal` là một sự việc, không bao giờ là một mệnh lệnh: nó không mang grant nào và không đòi hỏi gì. Bên nhận ghi nó với bên gửi mà kênh đã xác thực nêu tên, không bao giờ theo bên gửi mà envelope tự khai, dưới topic `peer.<topic>`, nên peer không thể làm tin của mình trông như một lần giao của GitHub, một webhook đã ký hay một timer; chỉ những yêu cầu lâu dài mà chủ của node nhận đã đặt ở đó mới quyết định nó khởi động gì. Cùng một sự việc gửi lại chỉ được ghi một lần. Node không gửi gì cho peer chưa biết, đang chờ hay đã bị thu hồi.

**Task giữa các node đã ghép cặp (issue #244).** Một automation dạng task có thể nêu một peer đã xác nhận làm node chạy nó (`executor`, chọn từ `list_peers`). Khi automation được đặt, chủ của node gửi viết một task grant đúng cho các thư mục, repository và effect của nó, và grant đó đi sang bằng `pair.confirm`; mỗi lần chạy sau đó xếp một `delegate` có brief là mục tiêu, các tài nguyên và effect ấy, dưới một task id do bên gửi chọn, nên một lần giao gửi lại sẽ tìm thấy đúng task đó thay vì khởi động task thứ hai. Node nhận không chạy gì mà chủ của chính nó chưa cho phép: chủ node cho phép một peer bằng `allow_peer_tasks` (thư mục, repository, effect — `stop` rút lại), lần giao được kiểm tra với grant đã lưu **giao** với allowance đó, tài nguyên phải khớp chính xác, và task được tạo với origin `delegated` và chỉ các effect mà cả hai bên cho phép. Mọi effect khác đều chờ chủ node nhận quyết định ở mọi chế độ thực thi, kể cả một lần ghi local mà một rule chung sẽ cho qua. Mọi kết quả đều quay về bằng `result`: xong, thất bại, bị từ chối (kèm lý do, báo ở cả hai bên), đã dừng, hoặc chưa rõ vì bên nhận khởi động lại giữa chừng. Bên gửi chỉ nhận nó từ đúng node đã được giao task, ghi run của peer và biên nhận của nó làm evidence trên task của chính mình, và mỗi chủ node nghe kết quả trong hội thoại nơi họ đã đặt việc. Lệnh dừng ở bên gửi đi sang bằng `cancel.request`: bên nhận dừng worker đang chạy task đó, và câu trả lời của nó — đã dừng, hoặc chưa rõ khi worker vẫn chạy xong — xác nhận lệnh dừng. Một lần giao dưới grant đã hết hạn hoặc đã bị thu hồi được trả lời kèm đúng lý do đó. Một lần giao hoặc lệnh dừng mà bên gửi bỏ cuộc không gửi được vẫn chốt task của bên gửi: thất bại khi peer từ chối, chưa rõ khi peer không hề trả lời. Một `pair.confirm` mang grant do chính chủ của node nhận viết, hoặc dùng lại một grant id đang giữ cho một cặp node khác, bị từ chối. **Phần tiếp theo (issue #253).** Trong lúc task chờ chủ node nhận duyệt, bên nhận gửi `status` (`waiting_approval`, và `running` khi đã được cho phép); chủ node gửi nghe điều đó trong hội thoại và inbox, còn task ở bên gửi vẫn là `running`, vì chỉ chủ node nhận mới quyết định được. Một lần từ chối, hoặc một yêu cầu duyệt để hết hạn, kết thúc task ở bên nhận và quay về bằng một `result` cho biết nó chưa hề chạy, nên task của bên gửi được chốt thay vì chờ mãi. Mỗi automation có executor ghi lại grant riêng của nó (`grantId` trên action), và các lần chạy chỉ đi dưới grant đó; tạm dừng hoặc gỡ automation sẽ rút grant đó ở cả hai node bằng `revoke`, còn tiếp tục lại thì viết một grant mới. Giới hạn thời gian cho mỗi lần chạy (`maxMinutesPerRun`) đi theo grant dưới dạng `budget.maxWallClockMs`; bên nhận áp budget của grant, giao với allowance của chính nó, lên task nó tạo (thời gian và token), và từ chối lần giao vượt quá `maxRuns` của grant. Các tệp một lần chạy ghi ra chỉ về lại bên gửi trong hạn mức byte mà chủ của nó đặt (issue #263, xem §5).

**Peer chạy được gì cho node này (issue #264).** Trước khi giao một task, node gửi có thể hỏi một peer đã xác nhận xem nó chạy được gì cho mình: `GET /peers/capabilities` trên gateway của peer, với peer token dẫn xuất, chỉ được trả lời cho một peer đã ghép cặp (mọi trường hợp khác là `401`) và chỉ được hỏi ở một peer có quảng bá `capabilities`. Câu trả lời là một bản tóm tắt nghiêm ngặt có phiên bản `{ version: 1, allowed, waits, capabilities: [{ ref, ready }] }` (tối đa 32 mục), dựng hoàn toàn từ allowance `allow_peer_tasks` mà chủ node nhận đã đặt cho peer đó: các capability ref mà allowance bao (`project.file.read@1`, thêm `project.code.change@1` khi nó cho ghi), mỗi ref kèm việc node đó hiện có chạy được nó không — đúng phép kiểm tra dùng để quyết định một lần giao — cùng `waits`, cho biết một lượt chạy peer hỏi giao sang mà node chưa bắt đầu được sẽ chờ ở đó (`true`) hay bị từ chối ngay (`false`, vì node chưa nghe rằng peer hỏi có quảng bá `capabilities`). Không thư mục nào, không capability nào khác mà node chạy và không lý do nào rời khỏi node, và một peer không được cho phép gì chỉ nghe `allowed: false`, không hơn. `list_peers` hiện câu trả lời của từng peer, và `create_automation` có `executor` thêm một cảnh báo — không bao giờ là từ chối — khi chủ peer chưa cho phép node này, không cho phép capability mà task cần, hoặc peer hiện chưa chạy được nó — chỉ nói lượt chạy sẽ chờ ở đó khi `waits` của câu trả lời là `true`, còn không thì nói mỗi lượt chạy bị từ chối ngay ở đó cho tới khi nó chạy được; một peer không hỏi được (bản dựng cũ, không trả lời trong 5 giây, câu trả lời không phải một bản tóm tắt) được nói là chưa rõ. Câu trả lời là một ảnh chụp tại thời điểm hỏi và chỉ để cảnh báo: phép kiểm tra của chính node nhận khi task tới vẫn là thứ quyết định. Khi một lần giao tới một node cho phép nó nhưng chưa chạy được capability của nó (ví dụ pack còn đang nạp) và bên gửi có quảng bá `capabilities`, bên nhận giữ task ở `waiting_capability` thay vì từ chối, báo cho chính chủ của mình, và gửi ngay `status` `waiting_capability` nêu `capabilityRef`; chủ node gửi nghe trong hội thoại và inbox rằng việc đang chờ capability nào, còn task ở bên gửi vẫn là `running`. Việc chờ không có giới hạn thời gian: task cứ chờ cho tới khi capability dùng được hoặc có người dừng nó, và cả hai chủ node đều được báo khi nó bắt đầu chờ. Khi capability dùng được, task tự chạy và bên nhận gửi `status` `running` kèm `capabilityRef` đó; lệnh dừng từ bên gửi kết thúc ngay một task đang chờ. Một lần giao từ bên gửi không quảng bá `capabilities` — bản dựng có trước thay đổi này — bị từ chối ngay như trước. Route và cả hai status đi trên envelope hiện có ở phiên bản giao thức 1: chính feature được quảng bá là thứ đánh phiên bản cho chúng, và không cần migration lưu trữ nào. Mỗi node biết features của bên kia từ lời mời ghép cặp và từ câu trả lời cho những gì nó giao, nên với một cặp đã ghép trước bản dựng này, peer được hiện là chưa rõ, và một lần giao nó chưa chạy được vẫn bị từ chối như trước, cho tới khi mỗi node đã giao được một thứ gì đó cho bên kia.

**Thông báo giữa các node đã ghép cặp (issue #170).** Một node đưa một thông báo vào inbox của peer đã xác nhận bằng message NodeLink `notice`: lời và một khóa, không gì hơn. Hiện nguồn tạo là `POST /peers/{nodeId}/notices`, để các công cụ cục bộ báo cho một Clark đã ghép cặp và chịu nhận thông báo; không node nào tự gửi, và một task mà peer đã nhận giao báo lại cho bên gửi qua `result` của nó, không qua thông báo. Chỉ một quyết định do chính chủ của node nhận đưa ra mới cho phép nhận thông báo của một peer: một grant còn hiệu lực do bên nhận viết cho peer đó, hoặc một allowance `allow_peer_tasks` còn hiệu lực dành cho nó. Grant do bên gửi viết, hay chỉ riêng việc ghép cặp, không tính. Mọi trường hợp khác bị từ chối kèm một mã (`PEER_NOT_ALLOWED`, `RATE_LIMITED`, `NOTICE_UNREADABLE`, `NOTICES_OFF`) và lý do, và lời từ chối đó là cuối cùng: đó là một câu trả lời, không phải một lần giao thất bại, nên bên gửi không gửi lại. Vì route đã trả `202` từ trước, bên gửi ghi lời từ chối lên dòng outbox của message đó và báo cho chính chủ của mình trong inbox — mỗi peer và mỗi lý do một lần — thông báo nào không tới, vì sao, rằng không có gì được ghi ở bên kia và nó sẽ không được gửi lại, và điều gì sẽ thay đổi được việc đó (ví dụ chủ bên kia cho phép làm việc với Clark này). Bên nhận nhận tối đa 30 thông báo mỗi phút từ một peer và từ chối phần còn lại theo cùng cách; nó giữ tối đa 20 thông báo chưa bỏ qua từ một peer, bỏ cái cũ nhất của chính peer đó và không bao giờ bỏ thông báo của chính node hay của peer khác. Thông báo được ghi là của peer (`sourceKind` `peer`, `originNodeId` là bên gửi mà kênh đã xác thực nêu tên, subject `peer`) dưới khóa `peer:<senderNodeId>:<key>`, nên giao ít nhất một lần hay replay vẫn chỉ thành một thông báo. Title và body bị giới hạn theo contract và được coi là dữ liệu (bỏ ký tự điều khiển, ký tự bidi và ký tự độ rộng bằng không), và bên gửi không bao giờ đóng góp được action: việc có thể làm với một thông báo do host bên nhận quyết định. Thông báo của peer chỉ liên kết tới một hội thoại ở node nhận khi nó nói về task mà chính node đó đã giao cho đúng peer ấy. Mục đang chờ được xóa ở cả hai bên: thông báo "đang chờ chủ máy kia duyệt" ở bên gửi được đóng khi bên nhận báo `running`, khi một `result` từ node chạy việc về tới (kể cả từ chối hay hết hạn), hoặc khi bên gửi bỏ cuộc không gửi được và chốt task. Việc quyết định yêu cầu duyệt của bên nhận **từ bên gửi** chưa được làm: việc đó cần một capability grant cho quyết định từ xa, có xác minh chủ node và gắn quyết định với digest của thao tác (#274).

**Peer cho biết nó nhận gì.** Một node chỉ gửi thông báo tới peer đã cho biết nó nhận thông báo. Mọi phản hồi `200` từ `POST /peers/messages` đều mang `features` (hiện là `["notice", "skip", "capabilities", "artifacts"]`) và `label` của node trả lời, phản hồi `409` `SEQUENCE_GAP` cũng vậy, và lời mời ghép cặp cũng mang chúng; bên gửi ghi cả hai cho peer đó, và chỉ từ hai nơi này. Feature lạ bị bỏ và chỉ đọc tối đa 16 mục; label được coi là dữ liệu (bỏ ký tự điều khiển, ký tự bidi và ký tự độ rộng bằng không, gộp khoảng trắng, tối đa 64 ký tự, rỗng nghĩa là không có). Một câu trả lời không có `features` — từ bản dựng có trước thay đổi này — xóa những gì peer đã nói, nên một node bị hạ phiên bản không nhận thông báo, và `POST /peers/{nodeId}/notices` trả `409` `NOTICES_UNSUPPORTED`, kèm việc cần làm: một node ghép cặp từ trước khi có features sẽ biết chúng từ câu trả lời của peer cho bất cứ thứ gì nó giao, nên gửi cho peer đó một signal trước là làm mới được, còn peer chạy bản dựng cũ thì cần được cập nhật. Mọi message NodeLink khác vẫn hoạt động như trước với peer như vậy. Hai cột này đến từ migration lưu trữ 34. Câu trả lời được đọc trong giới hạn: một lần giao có 30 giây, tính cả câu trả lời, và chỉ đọc tối đa 16 KiB của câu trả lời. Quá một trong hai, câu trả lời bị bỏ qua — message vẫn được xác nhận khi mã là `200`, còn lần giao không được trả lời kịp thì được thử lại như mọi lần khác — nên một câu trả lời chậm, bị ngừng giữa chừng hay quá lớn từ một peer không giữ được lượt gửi, các peer xếp sau nó, hay bước kiểm tra mất liên lạc sau đó.

**Một peer không liên lạc được.** Khi việc gửi tới một peer đã xác nhận thất bại liên tục hơn 10 phút, node ghi một thông báo cho mỗi lần mất liên lạc. Lần mất liên lạc được đọc từ chính trạng thái thử lại của outbox, không phải một bản ghi thứ hai: một message vẫn đang được thử lại mà lần thử cuối thất bại sau lần peer xác nhận gần nhất. Nội dung thông báo theo lần thất bại cuối. Nếu peer không trả lời, nó nói thiết bị không trả lời từ một thời điểm, những gì cần gửi vẫn nằm trong outbox và còn được thử lại tự động một thời gian, và hãy bật thiết bị lên hoặc ghép cặp lại nếu nó đã tắt hoặc đổi địa chỉ. Nếu peer trả lời bằng một mã `4xx`, nó nói thiết bị vẫn trả lời nhưng từ chối, kèm mã, và hãy kiểm tra việc ghép cặp hoặc cập nhật ClarkCant — không bảo bật gì lên. Nếu peer trả lời bằng một mã `5xx`, nó nói thiết bị đang chạy nhưng ClarkCant trên đó chưa xử lý được, các message vẫn được thử lại, và hãy xem ClarkCant trên thiết bị đó rồi khởi động lại hoặc cập nhật nó. Khi mọi thứ cần gửi đều đã bị bỏ (dead-lettered) kể từ lần xác nhận gần nhất, nó nói việc gửi đã dừng và các message đó sẽ không được gửi lại, không hứa thử lại, rằng việc đã giao cho thiết bị đó được chốt trong hội thoại của từng việc, và hãy gửi lại những gì còn cần khi thiết bị đó hoạt động lại. 10 phút chỉ tính thời gian tiến trình này theo dõi: đồng hồ bắt đầu từ thời điểm muộn nhất trong lần thất bại cũ nhất, lúc tiến trình khởi động, và lần thức dậy gần nhất sau khi ngủ (một nhịp gửi đến trễ hơn hai lần chu kỳ của nó), nên khởi động lại hay mở nắp laptop không làm hiện thông báo ngay vì một lỗi cũ; khi điều đó dời mốc bắt đầu, thông báo nói "ít nhất từ lúc". Thời gian được hiển thị theo múi giờ của chính node, kèm múi giờ. Một lần mất liên lạc — mọi thứ giữa hai lần xác nhận — mỗi lúc chỉ có một thông báo đang hiện: mỗi lần điều đang sai thay đổi là một thông báo mới dưới bước kế tiếp trong khóa của lần mất liên lạc đó (`peer-offline:<peer>:<lastAck|never>:<step>:<situation>`), thay cho thông báo trước, nên một tình huống quay lại (không trả lời, đã bỏ, rồi không trả lời lại) được báo lại chứ không bị lẫn vào một dòng đã đóng. Khi tình huống vẫn như cũ thì vẫn là thông báo đó, nên thông báo người dùng đã bỏ qua vẫn bị bỏ qua, và lần mất liên lạc sau là một thông báo mới. Thông báo được đóng ngay khi peer xác nhận lại bất cứ thứ gì, và khi việc ghép cặp bị thu hồi. Một message đã bị bỏ vẫn chốt task như trước. Thông báo gọi peer bằng label nó đã đưa, hoặc bằng node id khi nó không đưa.

**Một message bị bỏ (issue #277).** Vì bên nhận từ chối mọi thứ nằm sau một gap, trước đây một message bị bỏ khiến mọi message sau đó tới peer ấy bị từ chối mãi mãi. Giờ một node bỏ một message sẽ gửi cho peer có quảng bá `skip` một message NodeLink `skip` thay cho nó, và những gì theo sau được giao. Skip liệt kê những gì đã bị bỏ (số thứ tự, message id, kind và task id, tối đa 50 cho mỗi skip), chỉ bao các message nằm trên số thứ tự cao nhất mà peer đã xác nhận và dưới số thấp nhất còn đang nợ, và chiếm số thứ tự của message cuối cùng nó bao, nên nó không bao giờ bỏ qua một message peer đang được nợ mà chưa gửi, một message peer đã xác nhận, hay một message chưa vào hàng đợi. Bên nhận chỉ xử lý nó khi nó nằm trước cursor và dời cursor tới nó; nó bỏ ra những gì rốt cuộc đã nhận được, và một skip mà mọi số thứ tự nó bao đều đã tới được trả lời là cũ (stale) và không thay đổi gì. Một lần gửi lại được trả lời từ inbox. Bên gửi chỉ xác nhận một skip khi đã đọc được câu trả lời của peer: nó báo cho chủ trước, rồi ghi xác nhận cùng audit trong một lần, nên một câu trả lời không đọc được hay một lần sập ở giữa sẽ khiến skip được gửi lại, và câu trả lời cho lần gửi lại chỉ báo cho chủ một lần. Cả hai bên ghi audit cho skip (audit kind `peer`, outcome `failed`), và mỗi chủ nhận một thông báo trong inbox cho mỗi skip, nói cái gì thất bại, rằng các message sau vẫn được giữ và đi tiếp theo thứ tự, các task liên quan sẽ ra sao và nên làm gì (gửi lại hoặc nhờ gửi lại), rồi mới liệt kê cái gì bị mất và thuộc task nào, được rút gọn cho vừa thông báo. Thông báo chỉ nói một task đã được chốt khi một lần giao việc hay yêu cầu dừng bị mất; một câu hỏi, câu trả lời hay quyết định duyệt bị mất sẽ không được gửi lại, và bên đang chờ nó sẽ chờ tới khi yêu cầu hết hạn. Một `result` bị mất chốt task đã giao là chưa rõ ở bên nhận, trong hội thoại của task, vì không ai ở đó bảo đảm được nó đã kết thúc ra sao; một lần giao việc hay yêu cầu dừng bị mất vẫn chốt task ở bên gửi như trước. Bên nhận báo cho chủ tối đa 30 lần một phút cho mỗi peer, và vượt quá thì vẫn bỏ qua và ghi audit. Một chuỗi hơn 50 message bị bỏ cần nhiều skip, và tất cả được gửi trước khi gửi lại bất cứ thứ gì chỗ hổng sẽ từ chối. Với peer nhận skip, các message đi theo số thứ tự thấp nhất trước và từng cái một, nên những gì chờ sau một message bị từ chối không bị từ chối theo; khi hoàn toàn không có gì trả lời (hoặc peer lỗi ở phía nó, từ chối token hay bảo chờ), mỗi message đang chờ được tính là thất bại mỗi khi tới hạn, theo lịch của chính nó, kể cả khi message đứng trước đang chờ hết thời gian lùi của mình, nên nó bị bỏ không muộn hơn so với khi chính nó được gửi. Một message bị bỏ theo cách đó chưa từng rời node, nên một lần giao việc trong số đó chốt task là thất bại (việc không chạy ở đó), chứ không phải chưa rõ. Một peer không quảng bá `skip` — bản dựng có trước thay đổi này — giữ hành vi cũ, và khi một message đã bỏ vẫn còn thiếu ở đó, chủ của bên gửi được báo một lần cho mỗi quãng không có xác nhận rằng ghép cặp đang bị kẹt: thiết bị đó chưa cho biết nó bỏ qua được tin đã mất, và cập nhật ClarkCant trên đó sẽ gỡ kẹt; thông báo đó tự đóng khi peer xác nhận lại một thứ gì. Một peer trả lời một skip bằng `400` với bất kỳ mã nào khác `SKIP_INVALID` được coi là không nhận skip cho tới khi một câu trả lời quảng bá lại nó. Một peer đã cập nhật cho biết nó nhận skip trong `409` `SEQUENCE_GAP` kế tiếp, và skip được gửi ngay sau đó. Envelope vẫn ở phiên bản giao thức 1: chính feature được quảng bá là thứ đánh phiên bản cho kind mới, và không cần migration lưu trữ nào.

**Chưa có.** `NodeLinkTransport` trong `packages/node-link` vẫn là stub cho một transport dạng socket: chưa có TLS/mTLS, chưa có WebSocket, chưa có keepalive hay reconnect cursor. Bước 3 nói TLS/mTLS hoặc signed app handshake để xác minh key — hiện tại việc xác minh key là **so fingerprint**, và kênh là HTTP, nên một node chỉ reachable qua plain HTTP mới pair được hôm nay. Bước 4 (grants ban đầu) và bước 6 (probe, capability negotiation, status card) vẫn thuộc P4; phần của bước 6 đã có hôm nay là bản tóm tắt capability theo từng peer ở trên, chưa phải probe hay status card. Đường delegation thì đã nối: owner viết một grant (`POST /grants`), grant đó đi sang peer bằng envelope `pair.confirm`, và từ đó một envelope `delegate` nêu đúng grant ấy được nhận còn nêu một delegation lạ bị từ chối bằng `DELEGATION_UNKNOWN`. Chính sách nhận của bên nhận là **phép giao** của các grant còn sống từ sender đó — theo đúng luật của contract rằng grant chỉ bị thu hẹp chứ không được mở rộng bằng cách giữ thêm grant khác; một grant không đặt `maxArtifactBytes` thì cho **không** byte nào. Một `artifact.offer` không thuộc task nào vẫn chỉ được **xét**: không có gì tạo ra nó, và một node chỉ phục vụ byte của một tệp (`GET /peers/artifacts/{digest}`) cho đúng peer mà nó đã đề nghị gửi tệp đó cho một task, nên byte duy nhất đi giữa các node là các tệp mà một task được giao mang về (§5). Gap sequence được báo bằng `SEQUENCE_GAP` và cursor của peer chỉ tiến liền mạch, nên message đến muộn vẫn xử lý được thay vì bị coi là regression; chỉ một `skip` (ở trên) mới dời cursor qua một gap.

Nếu cả hai node không reachable, app giải thích cần private-network adapter hoặc một reachable gateway. Chọn Tailscale adapter hoặc TLS endpoint của operator; **không hứa kết nối xuyên mọi firewall khi không có hạ tầng hỗ trợ**. Không build bespoke relay/NAT traversal trong foundation beta. Public client/browser qua Tailscale vẫn cần network access và HTTPS cấu hình phù hợp.

## 5. Trust và delegation grants

Một grant tối thiểu có owner, senderNodeId, receiverNodeId, permitted capability IDs, resource refs, expiry, budget, allowed data classes và delegation depth. Receiver dùng phép giao với policy local; sender không nâng quyền receiver bằng prompt.

Principal của invocation gồm verified peer identity và delegated origin user; không tin trường identity tự khai trong JSON. Pack không được tự mint grant hoặc dùng credentials của một connection ngoài scope.

Delegation chuyển task brief/context cần thiết. Không copy toàn bộ Pi session nếu chỉ cần một build command. Artifact transfer là request riêng có source/destination, MIME/size/digest, classification và user grant. Workspace remote phải đã tồn tại hoặc được clone/create bằng task rõ ràng.

**Các tệp một task được giao mang về (issue #263).** Khi một task do peer giao đã chạy xong, node nhận đề nghị gửi lại cho bên gửi từng tệp mà worker của nó ghi bằng `write_project_file`, đúng như lần cuối worker ghi: tệp đã đổi sau đó, không còn, hoặc vượt giới hạn — tối đa 8 tệp, 4 MiB mỗi tệp và 16 MiB mỗi task — bị bỏ ra, và lời nhắn của `result` nói tệp nào và vì sao. Mỗi tệp được đề nghị gửi được lưu thành blob và đi trong một `artifact.offer` riêng cho `taskId` đó (tên tương đối với thư mục nơi nó được ghi, digest, kích thước, MIME type suy từ phần mở rộng, classification `internal`), được xếp hàng trong cùng lần ghi với `result` và đi trước nó; `evidence.artifacts` của result nêu tên chúng bằng đúng id, digest, tên, kích thước và MIME type đó. Lời đề nghị không mang đường dẫn nào trên node nhận. Bên gửi tự quyết định từng lời đề nghị, chỉ dựa trên grant của chính chủ nó cho task đó — grant mà automation đã ghi lại (`grantId`), không bao giờ là grant do peer nêu: grant phải còn sống, task còn mở, tệp nằm trong các lớp dữ liệu của grant và thuộc loại `text/`, `image/` hoặc `application/` (contract vẫn từ chối loại thực thi và markup), trong 8 tệp, và trong `maxArtifactBytes` của grant, tính dồn qua các tệp của task. **Tệp chỉ về khi chủ của bên gửi đã đặt hạn mức byte**: grant không có `maxArtifactBytes`, hoặc bằng 0, không nhận tệp nào. `create_automation` đặt nó bằng `maxArtifactBytes` (0 đến 16 MiB, chỉ khi có `executor`), câu trả lời lúc thiết lập nói tệp có về hay không, và tạm dừng rồi chạy lại vẫn giữ nó. Quyết định được ghi lại (storage migration 37), nên một lời đề nghị được gửi lại được trả lời y như trước. Tệp được nhận sẽ được kéo về khi lời đề nghị của nó đã được xác nhận, từ `GET /peers/artifacts/{digest}` bằng token peer dẫn xuất: node đề nghị chỉ phục vụ một digest cho đúng peer nó đã đề nghị (mọi trường hợp khác là cùng `404` như một digest không biết), phần thân chỉ được đọc tới kích thước đã nhận, và digest được tính lại trước khi lưu bất cứ thứ gì. Sau đó tệp được giữ làm artifact có nguồn gốc là peer đó, gắn vào lần chạy task của bên gửi làm bằng chứng `file-version` (`artifact:<id>` kèm digest), và hiện trong cuộc trò chuyện của task thành một khối artifact cùng với result — hoặc ngay sau nó, trong một câu trả lời riêng, khi byte về sau result, và tệp không tải về được cũng vậy. Mỗi tệp bị từ chối được nói cùng với result, kèm lý do. Tệp đã nhận nhưng chưa về khi node dừng sẽ được tải lại khi nó khởi động. Bên gửi không quảng bá `artifacts` — bản build từ trước thay đổi này — không được đề nghị tệp nào và nhận `result` như trước. Envelope vẫn ở protocol version 1: feature được quảng bá là thứ đánh version cho các lời đề nghị mới và `evidence.artifacts`. Các tệp một lần chạy tạo ra theo cách khác, như qua một lệnh shell, không được đề nghị gửi.

## 6. NodeLink envelope đề xuất

```typescript
// Internal app schema proposal, validate with discriminated unions in code.
interface PeerEnvelope {
  protocol: 'agent.nodelink';
  version: 1;
  messageId: string;
  correlationId: string;
  senderNodeId: string;
  recipientNodeId: string;
  kind: 'delegate' | 'accepted' | 'status' | 'input.request'
      | 'input.response' | 'cancel.request' | 'result' | 'artifact.offer';
  delegationId: string;
  taskId: string;
  expectedTaskRevision?: number;
  runId?: string;
  executionEpoch?: number;
  sourceSequence?: number;
  payload: unknown; // Mandatory per-kind runtime validation, never passed through.
}
```

Headers/signatures/auth channel bind actual sender. `senderNodeId` alone không là identity proof. Resource reference là `(nodeId, opaqueResourceId, resourceVersion)`; không remote `file://` hay local absolute path do model tự ghép.

Transport mặc định HTTPS request/response cho commands và WSS cho events. Keepalive/backpressure/rate/size limits, reconnect with cursor. Không dùng một connection mở vô hạn làm nguồn truth; data durable ở DB.

## 7. Delivery semantics

**At-least-once delivery + durable dedup**, không tuyên bố exactly-once external effects. Sender ghi intent/outbox trước send. Receiver transaction ghi inbox dedup và accepted task, rồi mới ack. Worker start đi từ receiver outbox.

Nếu sender mất ack, resend cùng command/delegation ID. Receiver trả accepted/outcome đã biết, không tạo run mới. Event sourceSequence tăng đơn điệu theo node/stream; home dedup và project chúng vào timeline của mình. Không có một “global order” được tạo bằng đồng hồ wall clock giữa các máy.

Mỗi peer event giữ provenance gốc; home summary không được làm mất trạng thái unknown/waiting_approval. Worker token deltas có thể coalesce/transient; approvals/effects/result commits durable.

## 8. Failure matrix

| Tình huống | Hành vi đúng |
|---|---|
| Desktop client đóng, home ở VPS | Home/jobs tiếp tục; reconnect replay |
| Home desktop ngủ, worker ở VPS | Worker tiếp tục trong grant/budget đã cấp; không giả home đang online; cần input thì chờ |
| Peer mất mạng trước accepted | Sender pending, retry cùng ID; không tạo job ở node khác |
| Mất mạng sau external effect | Receiver reconcile; home hiển thị unknown, không repeat effect |
| Home restart | Load snapshot/outbox/inbox, reconcile peers trước new risky dispatch |
| Executor restart | Recover task/effect ledger; process cũ/status cần verify, không chỉ nhìn JSONL |
| Two nodes cùng remote Git repo | Local worktree locks không đủ; push dựa expected remote ref / conflict handling, không force tự động |
| Key revoke khi task đang chạy | Chặn new commands/delegations; cancel/reconcile theo scope đã cấp, báo rõ effects đã ra ngoài |
| Package version mismatch | Negotiate capability version hoặc unavailable; không đổi schema âm thầm |
| No supported auth/OS driver | Task waiting setup hoặc chuyển phương án sau consent; không giả ready |

**Không automatic home failover trong v0.2.** Chuyển home là explicit export/migration/drain gate tương lai. Không để hai nodes cùng append authoritative timeline do network partition. “Mượt” không có nghĩa giấu mất sự cố.

## 9. Cross-node approvals và input

Executor phát `input.request`/`approval.request` đã ràng buộc exact operation, account/node/resource/digest và expiry. Home render **host-owned** card; user decision được authenticated và trả đúng request. Executor revalidates request còn hiện hành trước thực thi.

Pairing consent không đồng nghĩa approve tất cả deployments/chuyển tiền/gửi tin. Widget có thể đề xuất invocation, nhưng không tự phát grant mới. Secrets cần ở node nào thì secure auth channel kết thúc ở vault node đó; home model chỉ nhận connectionRef/status.

## 10. Budgets và tránh agent chatter

Default executor pool 2 workers mỗi node, config theo máy; conductor slot riêng. Global conversation budget, per-task depth/hops cap (đề xuất depth 2, nodes đã approve), timeout và token limits. Numeric defaults là targets cần đo, không benchmark.

Không cho subagent tự broadcast cả mạng tìm việc. Worker yêu cầu capability qua scheduler; scheduler chọn người thực thi. Progress polling deterministic, không tạo LLM ping-pong. Cross-node plans có bounded subtasks và tiêu chí complete rõ.

## 11. Ops, backup, upgrade

- Quotas separate sessions/artifacts/browser profiles/images; disk full cần stop safe không corrupt success state.
- DB consistent backup + content manifest; key backup có chính sách riêng. Không live copy WAL files bằng script tùy tiện rồi gọi là backup hợp lệ.
- Upgrade drain affected runs, verify protocol compatibility, snapshot DB, migrate transactionally khi phù hợp, boot healthcheck. Rollback package activation khác rollback irreversible DB migration; migration failure cần restore tested path.
- Peer reconnect theo negotiated version window; incompatible node giữ read/status nếu supported, không tiếp nhận new effects.
- Logs có trace task/run/peer/connection/widget nhưng redact secret/token/content mặc định.
- Server uninstall không xóa project/remote account dữ liệu; token revoke và runtime-data removal là các lựa chọn riêng.

## 12. Release proof bắt buộc

Clean macOS + hai Linux VPS/namespaces độc lập chạy J4. Thử một real network topology với TLS/private networking; local mock không đủ chứng minh NAT/reachability. Đo reconnect, duplicate delivery, revoked grants, unknown effects, dependency/version mismatch và node restart.

Nguồn cho protocol/tool separation và connectivity: [R06–R10, R28](research-and-decisions.vi.md). Những semantics ownership/delivery/policy ở đây là lựa chọn thiết kế của app.

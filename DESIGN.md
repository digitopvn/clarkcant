# ClarkCant Design System & UX Operating Model

> Trạng thái: canonical design direction cho UI/UX.
> Cập nhật: 2026-09-19.
> Phạm vi: web, desktop, conversation client, voice, host-owned cards, built-in widgets, custom widgets và marketplace.

## 0. North Star

ClarkCant phải cảm thấy **đơn giản hơn hệ thống đang chạy bên dưới**.

Người dùng chỉ cần học hai thứ:

1. **Một khung hội thoại duy nhất** — nơi giao việc, xem kết quả, thao tác widget, thay đổi cài đặt, quản lý integrations và điều khiển app.
2. **Một voice agent duy nhất** — cùng Clark, cùng context, cùng actions, không phải một sản phẩm khác.

Pi session, Jev routing/decision, memory, node topology, tool registry, capability host, worker, package generation và policy engine là hạ tầng. Chúng không được biến thành navigation model mà user phải học.

Luật sản phẩm quan trọng nhất:

> **Don't make me think. Đừng bắt user hiểu kiến trúc để hoàn thành công việc.**

Nếu một tác vụ có thể được diễn đạt bằng chat hoặc voice thì user không nên phải tìm đúng tab, đúng tool hoặc đúng node trước.

---

## 1. Design principles bắt buộc

### 1.1 Conversation is the app

- Không thêm sidebar cố định chỉ để chứa navigation.
- Không thêm session picker vào main UI.
- Không biến widgets thành một dashboard song song.
- Settings là surface phụ, mở trên conversation và đóng lại về đúng vị trí cũ.
- Marketplace có thể có browser surface, nhưng phải mở từ chat/settings và không trở thành home screen thứ hai.
- Mọi action quan trọng phải có đường chat và voice tương đương.

### 1.2 Progressive disclosure

Default UI chỉ hiển thị điều cần cho bước hiện tại. Chi tiết kỹ thuật chỉ xuất hiện khi:

- user hỏi;
- có lỗi cần hành động;
- user mở Settings/Advanced;
- hoặc widget cần provenance/freshness để không gây hiểu nhầm.

Không đưa node ID, digest, package generation, action binding, token budget hoặc provider internals lên main surface nếu user không cần chúng.

### 1.3 User-owned autonomy

Default execution policy là **Autonomous**.

Clark thực thi tác vụ user đã yêu cầu mà không hỏi lại từng tool call hoặc từng side effect. User chịu trách nhiệm về policy họ chọn và có thể đổi mode bất cứ lúc nào.

| Mode | Hành vi |
| --- | --- |
| Autonomous | Default. Không hỏi lại với tác vụ user đã giao. Jev + policy rules tự quyết route/guardrail. Hiển thị activity, hỗ trợ Stop/Undo khi có thể. |
| Guarded | Tự chạy thao tác low-risk; hỏi trước các hành động irreversible, external-public, destructive hoặc sensitive theo policy. |
| Ask every time | Hỏi trước mọi action effectful; local view actions không hỏi. |

Các ranh giới hệ điều hành/provider không thể giả lập là “đã cho phép”: OAuth consent, macOS TCC, browser microphone/camera permissions, vendor confirmation và OS secure dialogs vẫn phải đi qua UI do platform sở hữu.

**Không được dùng security làm lý do để thêm confirmation trùng lặp sau khi user đã biểu đạt intent rõ ràng.** Thay vào đó dùng:

- policy mode;
- visible activity;
- provenance;
- bounded execution;
- Stop;
- Undo/rollback khi có thể;
- audit log;
- Jev configurable instructions.

### 1.4 Honest UI

- Không có nút trông usable nhưng không có handler.
- Không claim live cho snapshot/cached/sample.
- Không claim success nếu chỉ biết process đã dừng.
- Không ẩn blocked reason trong tooltip.
- Không render approval/credential chrome từ untrusted widget.
- Không fake progress phần trăm nếu backend không có dữ liệu đó.

### 1.5 Motion is feedback, not decoration

Mọi thay đổi trạng thái nhìn thấy nên transition mượt, nhưng animation phải giải thích quan hệ nhân-quả:

- bấm → phản hồi ngay;
- element được tạo → xuất hiện từ nơi hợp lý;
- element biến mất → thu về/nhạt đi;
- panel mở → liên tục với control đã mở nó;
- agent đổi state → ambient UI đổi nhẹ;
- voice nghe/nói → waveform/orb phản ánh audio thật.

Không chạy animation chỉ để màn hình “sống động”.

### 1.6 Input modality aware

UI phản hồi khác nhau theo cách tương tác:

- **Pointer:** hover, proximity, pointer-following glow nhẹ.
- **Keyboard:** focus ring rõ, shortcut hint, không phụ thuộc hover.
- **Touch:** không có hover-only affordance; press state lớn và rõ.
- **Voice:** focused element/widget có semantic context để Clark thao tác thay user.
- **Agent activity:** ambient state phản ánh thinking/tool/answering/error nhưng không lấn át nội dung.

---

## 2. Application shape

### 2.1 Các trạng thái cửa sổ desktop

Desktop host cần hỗ trợ bốn presentation modes, tất cả điều khiển được bằng click, keyboard, chat và voice:

1. normal — conversation đầy đủ.
2. expanded — conversation rộng/cao hơn cho task nhiều nội dung.
3. compact — thanh nhỏ cho composer/voice status/pinned widget controls.
4. orb — minimal icon/orb luôn sẵn sàng gọi Clark.

Ví dụ lệnh tự nhiên:

- “thu nhỏ cửa sổ lại”
- “phóng to Clark”
- “chỉ để icon thôi”
- “mở lại cửa sổ”
- “ghim cái lịch này”
- “tách biểu đồ ra cửa sổ riêng”

Desktop bridge nên expose host-owned commands có schema rõ: window.setMode, window.resizePreset, window.restore, window.focus, widget.detach, widget.attach.

Không cho widget tự gọi generic Electron IPC.

### 2.2 Pin vs detach

- **Pin:** giữ widget trong không gian conversation; là presentation preference.
- **Detach:** đưa cùng logical widget instance sang host-owned floating window.
- **Inline snapshot:** lịch sử bất biến.
- **Một live owner:** inline/pin/detached không được tạo nhiều effect owners cho cùng instance.
- Detach không tạo session mới.
- Close detached window không xóa widget state.
- Voice có thể focus widget đang pin/detach bằng semantic ID và label.

### 2.3 Wake phrase

Target UX: local wake phrase **“Hey Clark”** mở voice mode.

Yêu cầu:

- wake-word detection chạy local nếu platform/provider cho phép;
- indicator rõ khi wake listener đang bật;
- toggle trong Settings;
- command voice “tắt voice”, “dừng nghe”, “về chat” phải kết thúc mode;
- local mute/end là host action, không phụ thuộc model;
- không gửi ambient audio tới remote provider chỉ để phát hiện wake phrase;
- wake listener không đồng nghĩa active transcription.

---

## 3. Motion & micro-interaction system

Các token hiện có micro, normal, panel, orb, enter, exit, glow và bounce là nền tảng tốt. Tiếp tục dùng token thay vì hard-code duration.

### 3.1 Motion grammar

| Event | Motion |
| --- | --- |
| Hover | 120–180 ms, đổi border/background/opacity nhẹ |
| Press | scale 0.98–0.985 trong 70–100 ms |
| Release | spring/bounce nhẹ về 1.0 |
| Chip/card enter | fade + translateY 4–8 px, 180–280 ms |
| Panel/modal | opacity + scale 0.985→1, 220–280 ms |
| Popover/menu | transform-origin từ trigger |
| Hero transition | existing staged exit; giữ continuous orb motion |
| Widget pin | morph/fly từ inline card tới pin shelf |
| Widget detach | card nâng nhẹ rồi host window xuất hiện cùng geometry |
| Success | một pulse rất nhỏ, không confetti mặc định |
| Error | shake ngang 2–4 px một lần; không loop |
| Agent thinking | ambient orb breathing chậm |
| Tool running | deterministic progress affordance; không spinner nếu có trạng thái cụ thể |
| Voice listening | orb/waveform theo RMS input |
| Voice speaking | orb/waveform theo playback level |

### 3.2 Bounce

Bounce phải tinh tế:

- chỉ dùng ở end-state của press/release, pin/drop, modal settle;
- overshoot nhỏ;
- không bounce body text;
- không bounce khi reduced motion;
- không chain bounce nhiều element cùng lúc.

### 3.3 Global transition rule

Không dùng transition: all.

Mỗi component chỉ transition các property có chủ đích: opacity, transform, background-color, border-color, box-shadow, filter.

Không animate layout property width/height/top/left mỗi frame nếu có thể dùng transform/FLIP.

### 3.4 Reduced motion

prefers-reduced-motion là hard requirement:

- duration về 0 hoặc gần 0 theo token;
- không giữ infinite spinner với duration 0;
- feedback trạng thái vẫn phải tồn tại bằng icon/text/color/shape.

---

## 4. Ambient behavior theo input và agent state

Root conversation surface nên có state machine hiển thị bằng data attributes thay vì component tự đoán:

    data-input-modality = pointer | keyboard | touch | voice
    data-agent-state    = idle | listening | thinking | tooling | responding | success | error
    data-window-mode    = normal | expanded | compact | orb
    data-policy-mode    = autonomous | guarded | ask

### 4.1 Pointer

- Orb flare theo pointer proximity.
- Card hover nâng tối đa 1–2 px hoặc đổi border, không dùng shadow lớn.
- Icon button chỉ hiện tooltip sau delay; label quan trọng phải visible hoặc accessible name rõ.

### 4.2 Keyboard

- Keyboard navigation không kích hoạt hover-only decoration.
- Focus ring dùng token riêng, không dùng accent làm tín hiệu duy nhất.
- Esc đóng surface gần nhất và restore focus.
- Cmd/Ctrl+K: focus composer / command intent.
- Cmd/Ctrl+.: cycle model trong favorites.
- Cmd/Ctrl+Shift+V: toggle voice.
- Shortcuts phải configurable và không capture khi đang nhập text nếu gây xung đột.

### 4.3 Agent state

Background của app chỉ thay đổi rất nhẹ:

- idle: neutral;
- thinking: ambient gradient/orb movement tăng nhẹ;
- tooling: một directional trace/ring nhẹ;
- responding: trở lại neutral khi token bắt đầu;
- success: một soft settle;
- error: accent danger rất nhỏ gần status/orb, không flash toàn màn hình.

Nội dung luôn có contrast ưu tiên cao hơn ambient effect.

---

## 5. Onboarding redesign

Mục tiêu: user vào app và làm được việc trong vài giây.

### 5.1 Không dùng wizard dài

Onboarding mới nên có tối đa hai khoảnh khắc.

**A. Welcome**
- ClarkCant + orb.
- Một câu: “Nói điều bạn muốn làm.”
- CTA Bắt đầu.
- Secondary text nhỏ: “Clark mặc định tự thực thi việc bạn giao. Có thể đổi trong Settings.”

**B. First useful action**
- vào thẳng conversation;
- nếu model chưa có, sample/local capabilities vẫn dùng được;
- khi user cần model thật, inline setup card xuất hiện đúng lúc;
- khi user mở voice lần đầu, inline/host setup voice xuất hiện đúng lúc;
- khi cần secret, host-owned credential prompt xuất hiện đúng lúc.

Không hỏi provider/model/TypeSafe key trước khi user biết vì sao họ cần chúng.

### 5.2 Model setup

Provider + model là một control nhóm:

- searchable combobox;
- recent/favorite models ở đầu;
- current model có check;
- context window/cost/speed chỉ hiện secondary;
- lưu ngay sau selection, không cần nút Save nếu mutation reversible;
- toast/status “Đã chuyển sang …”;
- conversation command “đổi sang Claude/Gemini/…” làm cùng action.

### 5.3 Policy setup

Không block onboarding bằng permission questionnaire.

Default Autonomous, với one-line disclosure có link Đổi chế độ.

Nếu build phân phối cần explicit legal acknowledgement, chỉ hỏi một lần bằng copy ngắn, không hỏi theo từng tool.

### 5.4 Resume

Onboarding/setup checkpoint phải resumable. Đóng app giữa OAuth/key setup không làm user quay lại từ đầu.

---

## 6. Main conversation UX

### 6.1 Header

Header mặc định chỉ nên có:

- Clark mark/name — click về fresh session;
- current model pill nhỏ — click mở quick model switcher;
- connection/activity indicator chỉ nổi bật khi cần;
- settings icon;
- window-mode control chỉ ở desktop khi discoverability cần.

Không hiển thị tool count, node ID hoặc Pi internals thường trực.

Background task count chỉ xuất hiện khi >0.

### 6.2 Hero

Giữ orb + prompt, nhưng suggestion chips nên là **dynamic recent intents** thay vì bốn câu cố định lâu dài:

- recent work;
- contextual project suggestions;
- sample actions khi chưa có history.

Mỗi chip phải cho biết nếu là demo/sample.

Hero biến mất khi user bắt đầu làm việc, nhưng logo/home cho phép về lại.

### 6.3 Composer

Composer là control quan trọng nhất.

Bắt buộc:

- multiline auto-grow;
- attachment button;
- paste/drag-drop;
- mic/voice button;
- send/stop cùng vị trí;
- file chip states;
- status/error gần field liên quan;
- typewriter placeholder chỉ khi empty/idle;
- command autocomplete khi user gõ slash là optional enhancement, không phải navigation chính.

Khi turn đang chạy:

- send button morph thành Stop;
- user vẫn được phép gõ turn kế tiếp;
- nếu gửi giữa task, Jev quyết định steer/interrupt/background theo instruction;
- UI nói ngắn gọn kết quả quyết định khi nó có tác động lớn.

### 6.4 Selection actions

Text selection toolbar nên có:

- Ask about this
- Explain
- Continue from here
- Run in background

Toolbar xuất hiện cạnh selection, keyboard accessible, mất đi khi selection mất.

### 6.5 Streaming

Giữ chronology:

    text → reasoning → tool → text

Tool activity mặc định compact. Expand khi user muốn xem arguments/result.

Thinking state kết thúc ngay khi content/tool event đầu tiên xuất hiện.

### 6.6 Undo

Action reversible nên tạo ephemeral Undo affordance trong timeline/status:

- unpin/pin;
- theme/model switch;
- local note edit;
- file move khi underlying capability hỗ trợ rollback.

Không hứa Undo cho irreversible external actions.

---

## 7. Voice agent UX

Voice là cùng Clark, không phải tab Settings hoặc app con.

### 7.1 Entry

- mic button trong composer;
- Hey Clark;
- configurable shortcut;
- chat command “bật voice”.

### 7.2 Surface

Voice surface có 3 mức:

1. **Expanded:** orb, live state, transcript, waveform, controls.
2. **Compact voice bar:** trạng thái + mute + end + expand.
3. **Orb mode:** chỉ visual listening/speaking indicator; transcript mở khi user yêu cầu.

### 7.3 Voice commands điều khiển app

Voice phải có semantic commands cho:

- mở/đóng Settings;
- đổi model/provider;
- đổi policy mode;
- resize/minimize/restore window;
- pin/unpin/detach/focus widget;
- scroll/focus conversation;
- mute/end voice;
- mở marketplace và cài widget;
- hỏi user question / trả lời panel đang mở.

Không implement bằng raw voice strings ở frontend. Voice transcript đi qua cùng intent/action layer với text.

### 7.4 Voice + widgets

Widget đang focus publish semantic summary:

- title;
- selected item;
- available local actions;
- available effect actions.

Clark có thể nói “chọn ngày mai trên lịch” và gọi local view action, hoặc “tạo event ngày mai” và gọi server effect action.

---

## 8. Widget UI architecture

### 8.1 Bốn trust lanes

1. **Host-owned UI**  
   Approval/policy/credential/device/OS/trust indicators. Không cho third party giả.

2. **Built-in catalog**  
   Trusted React components, JSON props + datasets.

3. **Declarative compositions**  
   Không executable payload. Ghép built-ins + bound actions.

4. **Custom isolated widgets / MCP Apps**  
   Iframe/origin sandbox, typed bridge, CSP, bounded capabilities.

Tất cả lane dùng chung instance/state/action model ở host.

### 8.2 Widget chrome

Widget chrome tối giản:

- title;
- freshness/provenance khi cần;
- overflow menu;
- pin/detach action khi hợp lệ;
- loading/error/missing states;
- optional compact action row.

Không lặp title nếu widget nằm trong card đã có title.

### 8.3 Interaction states

Mọi widget phải định nghĩa:

- loading;
- empty;
- partial;
- live;
- cached;
- offline;
- error;
- read-only snapshot;
- disabled action reason.

### 8.4 Local vs effect actions

Local view actions không cần hỏi:

- filter;
- sort;
- zoom;
- select;
- playhead;
- tab;
- expand/collapse.

Effect actions đi qua host:

- invoke tool;
- agent intent;
- workflow;
- external mutation.

UI phải nhìn khác nhau đủ để user hiểu “đang xem” vs “đang làm”.

---

## 9. Default widget catalog: audit và đề xuất

Hiện repo đã có: overview/layout, metrics, filter, line/bar/donut, table, calendar, image, carousel, gallery, YouTube/video, CTA và note fixture.

Đây là nền tốt nhưng chưa đủ cho “làm mọi thứ trong conversation”.

### 9.1 P0 — phải bổ sung

#### ui.question@1

Panel Q&A / ask-user:

- single choice;
- multi choice;
- text;
- number;
- date/time;
- confirm;
- optional freeform other;
- keyboard first;
- voice agent đọc câu hỏi và submit câu trả lời bằng cùng action schema;
- support nhiều câu hỏi trong một panel khi hợp lý, nhưng không biến thành form dài.

#### ui.form@1

Schema-driven form:

- text/password/number/select/search-select/date/time/toggle;
- field validation inline;
- draft preservation;
- submit effect rõ;
- secret fields route host credential flow nếu marked sensitive.

#### ui.task@1

Một card hợp nhất progress + steps + current operation + Stop.

Không duplicate task progress/summary thành nhiều component rời nếu một component có thể morph theo lifecycle.

#### ui.artifact@1

Preview/download/open cho:

- text;
- image;
- PDF;
- code;
- generated file.

Có provenance + version.

#### ui.diff@1

Nâng cấp code diff:

- collapse unchanged;
- file navigator;
- copy hunk;
- optional apply/revert khi capability có;
- keyboard navigation.

#### ui.browser@1 / ui.computer@1

Host-mediated screenshot/live preview:

- focus target;
- take over;
- stop;
- status;
- current action cue.

Không embed privileged browser origin.

### 9.2 P1 — high value

- ui.timeline@1
- ui.kanban@1
- ui.map@1
- ui.diagram@1
- ui.keyvalue@1
- ui.log@1
- ui.search-results@1
- ui.model-picker@1
- ui.package@1
- ui.marketplace-results@1
- ui.connection@1
- ui.audio@1
- ui.player@1
- ui.call@1

### 9.3 Improve widgets hiện tại

**Charts**
- hover/focus datum;
- legend toggles;
- selected point state;
- accessible summary;
- responsive labels;
- tránh SVG text collision.

**Table**
- sticky header;
- sort/filter;
- column visibility;
- horizontal scroll affordance;
- row selection;
- virtualization khi lớn.

**Calendar**
- month/week/agenda;
- keyboard date navigation;
- event pills;
- timezone visible khi khác local;
- selected date persists as local view state.

**Media**
- unified media controls;
- one active playback owner;
- poster/error/offline states;
- keyboard media shortcuts khi widget focused.

**CTA**
- dùng button hierarchy đúng;
- pending state;
- success/error;
- action label mô tả operation, không dùng generic Continue.

**Note/editor**
- autosave status;
- conflict state;
- checklist;
- markdown/rich text vừa đủ;
- không cố clone Notion.

---

## 10. Widget Marketplace

### 10.1 Bài học từ Pi

Pi giữ core nhỏ và mở rộng bằng package có nhiều resource facets: extension, skill, prompt, theme. Package có thể đến từ npm, git hoặc local path; catalog có thể index packages nhưng install mechanism vẫn đơn giản và portable.

Nguồn tham khảo:

- https://pi.dev/docs/latest/extensions
- https://pi.dev/docs/latest/packages
- https://pi.dev/packages

ClarkCant nên học **package ergonomics** đó, nhưng không copy trust model của native Pi extension. Pi extension có full process permissions; Clark widget executable mặc định phải isolated.

### 10.2 Marketplace không cần backend khổng lồ ở V1

V1 có thể dùng:

- npm package hoặc git repo làm distribution;
- manifest chuẩn clarkcant;
- catalog index đọc metadata;
- screenshots/video preview;
- version/digest;
- compatibility;
- facets;
- capability declarations;
- source/repository/license;
- install count/rating có thể deferred.

Không cần payment/review social network ngay.

### 10.3 Package facets

Một package có thể chứa:

    {
      "clarkcant": {
        "widgets": ["dist/widgets/weather"],
        "compositions": ["compositions/dashboard.json"],
        "skills": ["skills/weather.md"],
        "tools": ["dist/service/index.js"],
        "themes": ["themes/cloud.json"],
        "recipes": ["recipes/setup.json"]
      }
    }

Các facet activation độc lập. UI-only update không restart Pi.

### 10.4 Marketplace UX

User có thể nói:

- “tìm widget theo dõi giá”
- “cài widget calendar đẹp hơn”
- “có widget nào cho Home Assistant không?”

Clark trả ui.marketplace-results@1.

Mỗi item:

- preview;
- name + one-line value proposition;
- author/source;
- facet chips;
- compatibility;
- capability/risk chips;
- install/update button;
- View source;
- Try nếu package hỗ trợ ephemeral preview.

Trong Autonomous, explicit user intent “cài X” là đủ để install. Không hỏi confirmation lần hai. Jev/policy vẫn có thể chặn theo user-configured rule hoặc hard platform boundary.

### 10.5 Risk levels

Marketplace hiển thị risk, không biến mọi install thành modal:

- **UI-only:** isolated, no network → low.
- **UI + declared network:** isolated, scoped origins → medium.
- **Tool/service:** separate executor, filesystem/network capabilities → elevated.
- **Native Pi extension:** trusted code with process-level access → high/trusted mode.

Autonomous mode có thể thực thi theo user policy; visual activity/audit bắt buộc.

### 10.6 Developer experience

Target CLI:

    clark widget init
    clark widget dev
    clark widget test
    clark widget pack
    clark widget publish

Template gồm:

- manifest;
- schema;
- preview fixture;
- accessibility tests;
- bridge harness;
- example data;
- icon/preview image.

clark widget dev chạy isolated preview host có hot reload.

Publish gate:

- schema validation;
- package size;
- CSP;
- forbidden bridge calls;
- keyboard accessibility;
- reduced motion;
- text fallback;
- action dedup;
- state migration;
- snapshot/reopen behavior.

### 10.7 Personalization

Widget instances có:

- size preference;
- compact/expanded;
- pin position;
- theme token overrides giới hạn;
- saved filters/view state;
- default actions;
- voice aliases.

Package không được tự thay global app theme hoặc global shortcuts nếu chưa có user preference rõ.

---

## 11. Settings redesign

Settings vẫn là modal/surface trên conversation. Không biến thành admin console.

Đề xuất 5 nhóm.

### 11.1 Experience

Dùng segmented controls, toggles và swatches:

- Appearance: System / Light / Dark.
- Accent.
- Motion: Full / Reduced / Follow system.
- Density: Comfortable / Compact.
- Window behavior: remember size, start mode.
- Wake phrase: on/off + local-listening status.
- Keyboard shortcuts: mở subpanel.

Không hiển thị contrast debugging cho consumer; đưa vào Developer section.

### 11.2 AI & Routing

- Current model as searchable picker.
- Favorites/recent models.
- Shortcut order cho model cycling.
- Automatic routing by Jev toggle.
- Main session model preference.
- Background-session routing preference: Auto / Same model / Cheap / Fast / Quality.
- Jev model/adapter settings trong Advanced.
- Context/memory strategy chỉ dùng user-friendly terms.

Provider/model switch nên autosave sau selection.

### 11.3 Control

Đây là tab quan trọng mới.

**Execution policy**

- Autonomous (default)
- Guarded
- Ask every time

Mỗi option có 1–2 dòng mô tả cụ thể.

**Jev guardrails**

- editable instruction text;
- presets;
- reset;
- test policy bằng example action không thực thi.

**Safety controls**

- Emergency stop all active tasks;
- irreversible-action history;
- undoable recent actions;
- per-capability overrides.

Không dùng checkbox matrix 50 permissions làm default view. Per-capability rules nằm Advanced.

### 11.4 Extensions & Widgets

Gộp những thứ hiện nằm rải ở Tools/Pi extensions:

- Marketplace button/search.
- Installed packages.
- Updates available.
- Enabled/disabled.
- Widget packages.
- Pi extensions.
- Tool/service packs.
- Capability status.
- per-package details.

Tool references kỹ thuật nằm trong expandable details, không phải list chính.

### 11.5 Devices & Voice

- microphone status/test;
- voice provider status;
- wake phrase;
- input/output device;
- paired nodes/devices;
- current device label;
- voice credential status;
- device pairing.

Secret value không hiển thị lại.

### 11.6 Credentials

Không cần top-level tab riêng nếu credentials ít. Credential rows xuất hiện đúng domain và có một Manage credentials subpanel để xem danh sách names/status.

Host-owned credential UI:

- name;
- purpose;
- connected/not connected;
- Replace;
- Remove.

Không render stored value.

### 11.7 Developer / Advanced

Ẩn sau disclosure:

- node ID;
- Pi settings raw view;
- capability refs;
- package digests;
- token/time ceilings;
- connection diagnostics;
- contrast/debug specimens.

---

## 12. Elements & component standards

### Buttons

- Primary chỉ một trên mỗi local decision area.
- Icon-only cần accessible label.
- Press state ngay lập tức.
- Destructive cần danger semantics, nhưng Autonomous không đồng nghĩa mọi destructive action phải hỏi.

### Toggles

Dùng cho immediate boolean preference. Không dùng toggle cho action một lần.

### Segmented control

Dùng cho 2–4 mutually exclusive modes: theme, policy, window mode, density.

### Search select

Dùng provider/model/package danh sách dài.

### Command palette

Chỉ là accelerator; không phải route bắt buộc.

### Toast

Chỉ cho reversible/lightweight success. Error cần ở gần object gây lỗi hoặc trong timeline.

### Modal

Dùng cho focused configuration/decision. Không nest modal. Settings là modal; package details có thể là inner view trong cùng surface thay vì modal mới.

### Context menu

Dùng cho secondary widget operations: pin, detach, duplicate view, remove, package details.

### Tooltip

Chỉ giải thích icon/shortcut. Không chứa thông tin user buộc phải biết để ra quyết định.

---

## 13. Memory UX

Memory không được trở thành một database admin user phải chăm sóc.

Trong conversation:

- Clark có thể nói ngắn gọn khi một remembered preference materially ảnh hưởng hành vi.
- User có thể nói “đừng nhớ cái này”, “đổi preference X”.

Settings:

- Memory summary;
- types/sources;
- enable/disable categories;
- review recent memory-derived preferences;
- clear/manage route.

Không show embeddings/vector internals.

---

## 14. Error & recovery UX

Error hierarchy:

1. recover silently nếu deterministic;
2. inline retry nếu user action thất bại;
3. conversation message nếu task bị ảnh hưởng;
4. modal chỉ khi host/device/security boundary đòi focus.

Copy phải nói:

- cái gì không làm được;
- cái gì vẫn an toàn/đã giữ;
- user có thể làm gì tiếp.

Không dùng generic “Something went wrong” nếu backend có bounded reason.

---

## 15. Accessibility

- Minimum target nên hướng tới 40–44 px cho primary touch controls; token 24 px chỉ dùng dense desktop affordance có spacing đủ.
- Focus visible.
- Full keyboard path.
- Text alternatives cho charts/images/complex widgets.
- State không chỉ bằng màu.
- Voice transcript accessible.
- Live regions không spam token-by-token screen reader.
- Reduced motion.
- Contrast tests tiếp tục là release gate.

---

## 16. Performance

UX mượt yêu cầu:

- composer interaction không bị block bởi widget;
- heavy widgets lazy mount;
- offscreen widget suspend;
- charts downsample có disclosure;
- image/video lazy load;
- animation dùng transform/opacity;
- bounded ResizeObserver work;
- no global rerender per pointer move;
- detached widget không duplicate subscriptions nếu không phải owner.

Target cảm nhận:

- press feedback dưới 100 ms;
- local view action immediate;
- panel open frame đầu không blank;
- streaming token không làm scroll jank.

---

## 17. Implementation priority

### Phase A — polish core shell

- policy mode + Control settings;
- model quick switch + favorites;
- composer send/stop;
- window modes;
- unified motion primitives;
- input modality state;
- voice compact/orb mode;
- wake phrase contract.

### Phase B — widget UX foundation

- question/form/task/artifact/diff widgets;
- pin morph + detach;
- semantic widget focus for voice;
- unified widget chrome and empty/error states.

### Phase C — marketplace

- package manifest;
- catalog index;
- search/results/package detail widgets;
- install/update/remove;
- dev CLI + conformance;
- npm/git/local sources.

### Phase D — richer catalog

- map/diagram/timeline/kanban/browser/computer/call;
- package themes/personalization;
- marketplace discovery/ranking.

---

## 18. Design review checklist

Một UI change không complete nếu câu trả lời cho bất kỳ câu nào sau đây là “không”:

1. User có thể hoàn thành bằng chat hoặc voice không?
2. Main conversation vẫn là surface chính không?
3. Có tránh thêm navigation concept mới không cần thiết không?
4. Control có phản hồi press/focus/loading/error rõ không?
5. Transition có mượt và có lý do không?
6. Reduced motion có đường tương đương không?
7. Keyboard có làm được mọi thao tác quan trọng không?
8. Widget có loading/empty/error/read-only states không?
9. Freshness/provenance có trung thực không?
10. Action local và external effect có bị nhập nhằng không?
11. Autonomous mode có tránh confirmation lặp lại không?
12. Guarded/Ask mode có vẫn enforce được không?
13. Có Stop/Undo/recovery hợp lý không?
14. Voice có thể thao tác surface này bằng semantic action không?
15. Feature có tránh lộ Pi/Jev/node internals không cần thiết không?
16. Có tránh thêm button/tab/card chỉ vì dễ code thay vì tốt cho UX không?

Nếu câu 15 hoặc 16 là “không”, thiết kế lại trước khi merge.

---

## 19. Source-of-truth rule

- DESIGN.md định nghĩa product interaction, visual behavior và UX invariants.
- AGENTS.md định nghĩa quy tắc agent phải tuân thủ khi sửa repo.
- Code + tests định nghĩa behavior đã thực sự implement.
- Architecture docs định nghĩa trust/state/runtime boundaries.

Nếu DESIGN.md mô tả target chưa implement, code không được claim feature đã có. Nếu code intentionally thay đổi UX direction, cập nhật DESIGN.md trong cùng change.

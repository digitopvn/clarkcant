# Browser Use & Computer Use — Decision and Driver Architecture

> [English](browser-computer-use.md) (mặc định) · Tiếng Việt

**Ngày:** 16/09/2026. Browser Use là capability chung; project `browser-use` là một implementation có thể dùng. Không đồng nhất hai nghĩa.

## 1. Quyết định: core quản trị, packs thực thi

**Đưa control contract, permissions, observation/action correlation, target leases và emergency stop vào core. Đưa browser/OS implementation, model adapters và binaries vào installed driver packs.**

Browser pack được đề xuất sớm cho nhu cầu phù hợp, có thể bundled metadata nhưng binary cài theo nhu cầu. Computer pack optional, xin quyền nâng cao rõ ràng. Cả hai đều thuộc release scope, không phải “có thể nghiên cứu sau”.

| Core | Driver pack |
|---|---|
| Capability schema và target identity | Playwright/browser engine/OS automation CLI |
| Per-node/profile/window/display resource lease | DOM/accessibility/screenshot implementation |
| Consent, input/capture indicator, stop | Vendor vision/computer-action adapter |
| Actions/effects ledger và evidence | Linux virtual desktop image, macOS helper integration |
| Takeover, pause, audit, retention | Driver-specific setup/healthcheck |
| Security/data egress/budget | Site/app knowledge recipes |

Không để một browser extension tự mở root shell/full-disk access hoặc bypass node policy. Cũng không ép mọi người tải Chromium và virtual desktop dù chỉ dùng note/calendar API.

## 2. Lựa chọn implementation

| Candidate | Đánh giá cho sản phẩm | Quyết định |
|---|---|---|
| Playwright trực tiếp, TS | DOM/locator, browser contexts; giữ Pi làm planner, dễ typed adapter | **First-party browser driver mặc định**; pin browser/library pair |
| Playwright MCP | Tái dùng tools/accessibility snapshots qua MCP; plugin interop tốt | Certified alternative path; không chạy thêm autonomous planner [R11] |
| Browser Use | Agent-oriented browser stack, có SDK/CLI/hosted lựa chọn | Optional pack/backend, không bắt buộc Python/cloud hay agent loop thứ hai [R12] |
| Native computer model tools | Có thể mạnh trên screenshot tasks nhưng vendor schema khác Pi tools | Adapter riêng khi đã test; không giả Pi hiểu nguyên mọi vendor protocol [R13–R14] |
| Peekaboo macOS driver | Screenshot/accessibility/input automation phù hợp macOS | Candidate mặc định cho macOS pack, pin/version/TCC/signing spike [R15–R16] |
| Linux virtual desktop + input adapter | Chạy GUI app trên VPS có display environment riêng | **First-party isolated runner profile**; adapter nhỏ, reuse existing engines [R14] |

Playwright MCP tuyên bố không là security boundary. Không xem browser context hoặc chạy headless là security sandbox [R11]. Browser process/container phải có own isolation policy. Chữ “API-first” ở đây là lựa chọn kỹ thuật, không promise mọi website có API.

## 3. Escalation policy

1. Structured API/MCP capability đúng chức năng và có grant.
2. Browser DOM/accessibility tools khi cần workflow web không có connector phù hợp.
3. Screenshot/vision trong managed browser cho canvas/visual-only regions.
4. Computer Use cho native app hoặc desktop-level interaction thật sự cần.

Mỗi bước mở thêm quyền/đích cần consent tương ứng. API 403, CAPTCHA, OAuth denied hoặc protected content không phải tín hiệu để tự chuyển sang computer driver lách hạn chế. Tác vụ không thể làm hợp lệ thì explain limitation và giữ user control.

## 4. Unified observe-act contract

```typescript
interface AutomationTarget {
  targetId: string;
  nodeId: string;
  kind: 'browser-profile' | 'native-desktop' | 'virtual-desktop';
  resourceVersion: string;
  sessionId: string;
}
interface Observation {
  observationId: string;
  targetId: string;
  leaseEpoch: number;
  capturedAt: string;
  accessibilityRef?: string;
  screenshotRef?: string;
  viewport?: { width: number; height: number; scale: number };
  foregroundWindowRef?: string;
}
interface AutomationAction {
  actionId: string;
  targetId: string;
  observationId: string;
  leaseEpoch: number;
  operation: string; // Typed action union in implementation.
  arguments: object;
  expectedTargetVersion: string;
}
```

Target/observation/lease do host cấp, không tự tin vào coordinates do model gửi mà không context. Typed commands gồm navigate/read/snapshot/click/fill/scroll/key/input/capture, nhưng sensitive effects vẫn đi qua policy.

Browser: prefer stable locator/element reference từ recent observation; locator not found thì observe lại, không random click fallback. Native: validate window/display/scale trước input; nếu target changed/observation expired thì refresh. OS không enforce được app-only containment phải nói rõ capture/input grant thực tế rộng hơn app selection.

## 5. Managed browser profiles

Mỗi profile gắn node, purpose, account/trust scope. Không tự attach user Chrome hoặc đọc hệ cookies cá nhân. Native profile import là future explicit workflow nếu làm, không mặc định.

Download/upload cho phép theo approved roots; archive/file payload scan/type/size and execution boundaries. Screenshots, DOM snapshots, console logs có thể chứa secrets hoặc content nhạy cảm; default bounded retention/redaction. Agent nhìn webpage là input không tin cậy, không phải system instructions.

Login có **human takeover state**. User thao tác trong managed preview/browser; agent input dừng. Với secret entry/OAuth/2FA, suspend agent observations/capture theo flow, không ghi keystrokes hoặc đưa password vào model. Restore control sau user action rõ, không quan sát ngầm while waiting.

Browser preview không reuse main conversation WebContents. Link/redirect đi qua URL policy; raw CDP endpoint không đưa cho widget hoặc peer không có session grant. Embedded mini-app và browser automation target là hai security contexts khác nhau.

## 6. Computer Use trên macOS

App phải dẫn user cấp Accessibility và capture-related permissions qua OS-supported flow. Không dùng computer tool tự bấm cấp quyền. Signing/update có thể ảnh hưởng TCC, phải test binary đúng distribution, không chỉ CLI trong terminal dev [R15–R16].

Thiết kế:

- One foreground-input lease mặc định. Local human can stop/revoke independent of model/network.
- Host indicator “Đang điều khiển máy này”, target app/window và nút stop rõ.
- User input/window focus change mà driver detect được → pause/re-observe/takeover theo policy. Ghi detection coverage; không hứa phát hiện mọi human action.
- Read-only capture permission khác input permission. Cho capture không tự cấp click/type.
- Remote node chỉ điều khiển laptop khi explicit session grant và local policy cho; pairing không đủ.
- Shell/test automation độc lập không bị pause chỉ vì user ngắt voice; stop scope có lựa chọn rõ.

## 7. Computer Use trên VPS

Server headless không có “desktop đang mở sẵn”. Pack khởi virtual display + desktop/apps riêng trong container hoặc VM. User thao tác nhìn vào remote preview đúng session, không màn hình cá nhân trên laptop.

No arbitrary host display mount; isolated clipboard; file transfer explicit. Preview input channel short-lived session-scoped authenticated; optional streaming optimization không expose VNC naked. Initial frame previews có thể dùng screenshots, live WebRTC channel thêm nếu cần và test; không đưa video frames vào event persistence.

Linux runner không chạy native macOS apps. Muốn thao tác app macOS phải delegate tới Mac node đã pair. Driver capability discovery ghi platform/app availability, không model đoán.

## 8. Effects và meaningful confirmation

“Click” tự nó không luôn vô hại: có thể gửi email, submit form, xóa file hoặc đặt mua. Broker ghi target/action và yêu cầu user xác nhận với consequential operations trong flow hỗ trợ. Khi arbitrary website/script có effect khó phân loại, isolation hạn chế tài sản và human-review gate quan trọng hơn LLM risk classifier.

Observe sau action để verify outcome; screenshot không có toast success không đủ kết luận failed/success. Khi app API/DOM có receipt/state tốt hơn thì dùng. Timeout sau submit là unknown, không tự click submit lần nữa. Không hứa exactly-once trên một GUI không có operation IDs.

Computer Use giới hạn observation retention; audit có metadata+selected evidence theo consent. Agent không tự record toàn màn hình liên tục để “có đủ context”.

## 9. Security residuals cần nói thẳng

Browser prompt injection có thể hướng model làm sai; core consent và isolation giảm rủi ro chứ không chứng minh an toàn tuyệt đối. Native OS control có quyền rộng, website/app visuals có thể giả prompts. Một sign-in click thành công không chứng minh OAuth đúng account.

Docker rootless/container policies tăng containment nhưng host-kernel exploits là risk khác; hostile code cần stronger VM isolation khi threat model yêu cầu. Không mount broad secrets/tool sockets rồi gắn nhãn sandbox. Untrusted extension code trong Pi worker có thể đọc memory/context đã được cấp; sandbox không giữ bí mật dữ liệu đã chủ động giao cho nó.

## 10. Acceptance gates

Browser: DOM fixture, visual canvas fixture, popup/navigation, profile isolation, downloads/uploads, human takeover, stale locator, prompt injection fixture, stopped session cannot act, post-submit timeout does not duplicate.

macOS: clean signed app permission grant/deny/revoke, screen variants/DPI, multiwindow focus race, local stop during remote command, accessibility unavailable, capture withheld during secrets.

Linux: fresh VPS optional runner install, display startup, isolated files/network, preview auth, reconnect, session cleanup, resource limits, non-root proof.

Cross-cutting: same policy/action/effect pipeline as API tools, install-and-resume once, no stolen focus during ordinary chat, pending tasks remain understandable when driver blocked.

Nguồn và lý do lựa chọn: [R11–R16](research-and-decisions.md).

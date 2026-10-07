# Browser Use & Computer Use — Decision and Driver Architecture

> English (default) · [Tiếng Việt](browser-computer-use.vi.md)

**Date:** 16/09/2026. Browser Use is a general capability; the `browser-use` project is one implementation that may be used. Do not conflate the two meanings.

## 1. Decision: core governs, packs execute

**Put the control contract, permissions, observation/action correlation, target leases and emergency stop in core. Put browser/OS implementations, model adapters and binaries in installed driver packs.**

The browser pack is proposed early for suitable needs; its metadata may be bundled but the binary is installed on demand. The computer pack is optional and asks for elevated permissions explicitly. Both belong to the release scope, not "may be researched later".

| Core | Driver pack |
|---|---|
| Capability schema and target identity | Playwright/browser engine/OS automation CLI |
| Per-node/profile/window/display resource lease | DOM/accessibility/screenshot implementation |
| Consent, input/capture indicator, stop | Vendor vision/computer-action adapter |
| Actions/effects ledger and evidence | Linux virtual desktop image, macOS helper integration |
| Takeover, pause, audit, retention | Driver-specific setup/healthcheck |
| Security/data egress/budget | Site/app knowledge recipes |

Do not let a browser extension open a root shell/full-disk access on its own or bypass node policy. Also do not force everyone to download Chromium and a virtual desktop when they only use note/calendar APIs.

## 2. Implementation choices

| Candidate | Assessment for the product | Decision |
|---|---|---|
| Playwright directly, TS | DOM/locator, browser contexts; keeps Pi as the planner, easy typed adapter | **Default first-party browser driver**; pin the browser/library pair |
| Playwright MCP | Reuses tools/accessibility snapshots over MCP; good plugin interop | Certified alternative path; does not run an extra autonomous planner [R11] |
| Browser Use | Agent-oriented browser stack, with SDK/CLI/hosted options | Optional pack/backend; does not require Python/cloud or a second agent loop [R12] |
| Native computer model tools | Can be strong on screenshot tasks but the vendor schema differs from Pi tools | Separate adapter once tested; do not pretend Pi understands every vendor protocol as-is [R13–R14] |
| Peekaboo macOS driver | Screenshot/accessibility/input automation suited to macOS | Default candidate for the macOS pack, pin/version/TCC/signing spike [R15–R16] |
| Linux virtual desktop + input adapter | Runs GUI apps on a VPS with its own display environment | **First-party isolated runner profile**; small adapter, reuse existing engines [R14] |

Playwright MCP states that it is not a security boundary. Do not treat a browser context or headless mode as a security sandbox [R11]. The browser process/container must have its own isolation policy. "API-first" here is a technical choice, not a promise that every website has an API.

## 3. Escalation policy

1. A structured API/MCP capability with the right function and a grant.
2. Browser DOM/accessibility tools when a web workflow has no suitable connector.
3. Screenshot/vision in the managed browser for canvas/visual-only regions.
4. Computer Use for native apps or desktop-level interaction that is genuinely needed.

Each step that opens more permissions/targets needs the corresponding consent. An API 403, CAPTCHA, denied OAuth or protected content is not a signal to switch to the computer driver on its own to get around the restriction. When a task cannot be done legitimately, explain the limitation and keep the user in control.

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

Target/observation/lease are issued by the host; coordinates sent by the model without context are not trusted on their own. Typed commands include navigate/read/snapshot/click/fill/scroll/key/input/capture, but sensitive effects still go through policy.

Browser: prefer a stable locator/element reference from a recent observation; if the locator is not found, observe again, no random click fallback. Native: validate window/display/scale before input; if the target changed/observation expired, refresh. Where the OS cannot enforce app-only containment, state clearly that the actual capture/input grant is wider than the app selection.

## 5. Managed browser profiles

Each profile is bound to a node, purpose, and account/trust scope. Never attach to the user's Chrome or read the system's personal cookies on its own. Native profile import is a future explicit workflow if it is done at all, not a default.

Download/upload is allowed within approved roots; archive/file payload scan/type/size and execution boundaries. Screenshots, DOM snapshots and console logs can contain secrets or sensitive content; bounded retention/redaction by default. A webpage the agent sees is untrusted input, not system instructions.

Login has a **human takeover state**. The user operates in the managed preview/browser; agent input stops. For secret entry/OAuth/2FA, suspend agent observations/capture per the flow, do not record keystrokes or pass passwords to the model. Restore control after an explicit user action, with no covert observation while waiting.

The browser preview does not reuse the main conversation WebContents. Links/redirects go through URL policy; the raw CDP endpoint is not handed to a widget or a peer without a session grant. An embedded mini-app and a browser automation target are two different security contexts.

## 6. Computer Use on macOS

The app must guide the user to grant Accessibility and capture-related permissions through the OS-supported flow. Never use the computer tool to click through permission grants itself. Signing/updates can affect TCC; test the binary from the actual distribution, not only the CLI in a dev terminal [R15–R16].

Design:

- One foreground-input lease by default. A local human can stop/revoke independently of the model/network.
- Host indicator "Controlling this machine", the target app/window and a clear stop button.
- User input/window focus changes that the driver can detect → pause/re-observe/takeover per policy. Record detection coverage; do not promise detection of every human action.
- Read-only capture permission is different from input permission. Granting capture does not grant click/type.
- A remote node controls the laptop only with an explicit session grant and when local policy allows it; pairing is not enough.
- Independent shell/test automation is not paused just because the user interrupted voice; stop scope has clear options.

## 7. Computer Use on a VPS

A headless server has no "desktop already open". The pack starts a virtual display + its own desktop/apps in a container or VM. The user watches the remote preview of the correct session, not the personal screen on the laptop.

No arbitrary host display mount; isolated clipboard; explicit file transfer. The preview input channel is short-lived, session-scoped and authenticated; optional streaming optimization does not expose naked VNC. Initial frame previews can use screenshots, with a live WebRTC channel added if needed and tested; video frames are not put into event persistence.

The Linux runner does not run native macOS apps. Operating a macOS app requires delegating to a paired Mac node. Driver capability discovery records platform/app availability; the model does not guess it.

## 8. Effects and meaningful confirmation

A "click" on its own is not always harmless: it can send an email, submit a form, delete a file or place an order. The broker records the target/action and asks the user to confirm consequential operations in flows that support it. When an arbitrary website/script has effects that are hard to classify, isolation that limits assets and a human-review gate matter more than an LLM risk classifier.

Observe after an action to verify the outcome; a screenshot without a success toast is not enough to conclude failure/success. When the app API/DOM has a better receipt/state, use it. A timeout after submit is unknown; do not click submit again on its own. Do not promise exactly-once on a GUI that has no operation IDs.

Computer Use limits observation retention; audit keeps metadata+selected evidence according to consent. The agent does not continuously record the whole screen on its own to "have enough context".

### 8.1 Browser tasks as implemented today

What the node does now, as distinct from the target design above:

- **Entry point.** The model tool `start_browser_task` starts a background task for the managed browser. It is offered to the model only on a node that runs background tasks and has a model configured, because the task's worker runs that model; a node without one does not offer the tool. Every site it passes, and every web address written in the goal, must be a host the person wrote in this conversation, in a message they typed into this node's page or said by voice. Messages posted through MCP, the WebSocket relay, `clarkcant api` or a peer do not count, and neither do messages stored before the node recorded where a message came from. Only text the person wrote is read. A plain `http` address needs the person to have written `http://` in front of that host; otherwise only `https` is accepted. An address with a user name or password in front of its host is refused. A request that, together with its addresses, would not fit in a task is refused rather than shortened. A site the model or a page names is refused and nothing starts. There is no automation-step entry point yet.
- **Sites.** The checked list of sites is stored on the task itself (`origin.sites` on an `interactive` origin). The dispatcher gives the browser that list and never reads sites back out of the goal's text. Before a worker exists, it refuses a browser task that was not started by a person in the conversation, that carries no list, or whose goal reads as different sites than the list (or holds a disguised address).
- **Consent.** The task is dispatched to `browser.playwright@1`, an `external-write` capability the conductor never chooses for a message on its own. The dispatcher asks the owner's execution policy before a worker exists: `deny` refuses, and `ask` parks the task for the person's approval in the inbox. The approval names the sites and the request. Only then does a worker start. A browser task the policy was never asked about (the capability is unknown on the node) is refused. Every click asks the policy again, and a `deny` stops any click. On an `ask`, a consequential click goes ahead only when the person granted this task at dispatch; a task the policy let on by itself is refused rather than pressed. Every click that sent something is audited as an executed effect.
- **The worker's model.** The worker runs the node's model, chosen the way other background work is: the policy layer's pick among the node's model pool when it makes one, otherwise the model the node runs. The provider key is the one stored for the provider on the node when there is one, otherwise the provider's variable in the node's environment. It reaches the worker process once, over its standard input. It is never a command-line argument, never in the worker's environment and never written to a file, and anything the worker prints has the key cut out. The node's audit trail records which model the worker was started on, how it was chosen and where its key came from, never the key itself. A turn the provider refuses, for example over a rejected key, fails the task and gives the provider's reason. If that reason quotes the key, the key is cut out before anything is shortened. A node with no model refuses the task before any worker starts. The worker loads nothing from the machine into its session: no Pi extension, skill, prompt template or instructions file (`AGENTS.md`, `CLAUDE.md`). It starts in an empty directory of its own. A task that sets no budget of its own gets the node's worker budget: 500 000 tokens and 10 minutes, set by `CC_WORKER_MAX_TOKENS` and `CC_WORKER_MAX_WALL_CLOCK_MS`. This is separate from a conversation turn's budget, because a worker's count sums every model call's input, output and cache tokens, as the provider bills them. The worker stops at the end of the turn that takes it over its token budget, and the task is not accepted. When the time budget runs out, the worker is stopped and the task says so. A Stop ends the worker process, and with it the call to the provider.
- **Tool calling.** A browser task is done only through `use_browser`, so the node reads whether a model can call tools from its model catalogue. The Pi adapter marks a model as able to call tools (`toolCalls: true`, also in the catalogue `GET /model` returns) only when pi's own built-in catalogue lists it unchanged: same provider, id, API and endpoint. pi's model library lists only models that can call tools. The adapter never marks a model as unable. A model added or changed through `models.json`, or one the catalogue does not list, is unknown. When work needs tools, background routing leaves out a pool profile the catalogue states cannot call them. The dispatcher refuses a browser task whose chosen model is stated not to call tools, before the policy is asked and before any worker starts. `start_browser_task` refuses before it creates a task when every model a worker could start on is stated not to call tools; those models are the node's own model and the pool's enabled profiles. Its answer tells the person, in the interface language (Vietnamese or English), to choose another model in Settings → AI & Routing → Choose provider and model. An unknown model is allowed. If its worker ends without calling a single tool, the task fails with "the model answered without using any of its tools (use_browser), so nothing was done", not a general "no evidence".
- **What the worker gets.** The worker gets the `use_browser` tool and nothing that runs commands or reads the node's projects. Its requests cross the worker channel to a broker on the node, which drives a Playwright profile of its own under the node's data directory (never the person's browser). The profile only reaches the task's stored sites. A site named by its host name is looked up once before the browser starts. It is refused when the name points at this machine or a private network, and is otherwise pinned to the checked address. A site the person typed as an IP address or as `localhost` is used as written. The browser works in one page. A navigation of the page or of its frames to another site, a server redirect included, is stopped inside the browser before it leaves, and the page stays where it was. Scripts cannot open windows, and a new tab a link opens is closed. A page that still ends up elsewhere is taken back to a blank page before anything is read from it, and the step is refused. The profile is removed when the run ends. At boot, the node also removes any profile a previous process left behind. Page text reaches the model as data, never as instructions.
- **Ledger.** A click on a submit control, or one the model marks consequential, is written to the task's effect ledger as `submitted` before the browser presses it. It is then settled from what the page answered: `confirmed`; `failed` (the site refused it, or the press sent nothing at all); or `unknown` when the answer never came, the page answered 408 or 5xx, or the press broke after it sent a request. A click nobody marked but which still sent a request is written down the same way, after the fact.
- **Unknown outcome.** An `unknown` row turns the task `uncertain` and raises the same inbox notice the reconcile flow uses. The press is recorded as data (the control's name and the page's host and path, never a typed value) and worded only where it is shown. The notice names it in the same Vietnamese as the node's other notices (for example `bấm “Gửi” trên shop.example/apply`) and asks the person to check on that site. The Control tab's list of effects run without asking, and the reply to a typed or spoken "it took effect", word it in the language the person chose (`click “Gửi” on shop.example/apply` in English). While the row is unknown, no further click of that task reaches the browser, so the submit is never pressed twice; the task can still open, read and observe pages. A person's Stop reaches the browser at once, and nothing not yet handed to it is sent. Only the person answers the notice, through `POST /effects/:id/reconcile`; a second answer is refused.

Limitations today:

- Tokens are counted when a turn ends, so a worker can go over its token budget by up to one turn before it stops.
- pi's catalogue never states that a model cannot call tools, so on a node that reads only that catalogue the early refusal and the routing exclusion do not act today. They act only on a catalogue that states it. A model that cannot call tools is then found out by its worker, and the task says the model answered without using the browser.
- A key that the node holds neither in its environment nor as a stored credential is read by the worker from the model runtime's own configuration (`PI_CODING_AGENT_DIR`). Neither the node nor the worker then knows the key, so it is not cut out of what the worker prints.
- Only requests the page itself sends within 250 ms of a click are counted as that click's. A request a script sends later, or an autosave a form does while it is being filled in, is not observed. A WebSocket message or a write through a third-party frame can also go unseen.
- Hosts are compared only in the form the URL parser gives them. For an internationalized domain name that is its punycode form (`xn--…`), so a site the person typed in its Unicode spelling is not recognized as named, and the task is refused.
- A request other than a page navigation, such as a script's `fetch`, may still reach other sites.
- A new tab a link opens can reach its site once before it is closed. When a page of one allowed site frames another allowed site, that frame runs in its own browser process, and a navigation inside it is not held.
- A POST that only reads can still be held as `unknown`.
- There is no human takeover or live preview for these tasks yet.
- Where Chromium is not installed, the task's browser requests are refused with the driver's reason.
- The mark that a message came from the node's page is the composer's own header. A client holding the node's token can send it too; that token already carries the person's full authority.

## 9. Security residuals to state plainly

Browser prompt injection can steer the model wrong; core consent and isolation reduce risk but do not prove absolute safety. Native OS control has broad rights, and website/app visuals can fake prompts. A successful sign-in click does not prove OAuth used the right account.

Docker rootless/container policies increase containment, but host-kernel exploits are a different risk; hostile code needs stronger VM isolation when the threat model requires it. Do not mount broad secrets/tool sockets and then label it a sandbox. Untrusted extension code in a Pi worker can read memory/context that has been granted; a sandbox does not keep secret the data that was deliberately handed to it.

## 10. Acceptance gates

Browser: DOM fixture, visual canvas fixture, popup/navigation, profile isolation, downloads/uploads, human takeover, stale locator, prompt injection fixture, stopped session cannot act, post-submit timeout does not duplicate.

macOS: clean signed app permission grant/deny/revoke, screen variants/DPI, multiwindow focus race, local stop during remote command, accessibility unavailable, capture withheld during secrets.

Linux: fresh VPS optional runner install, display startup, isolated files/network, preview auth, reconnect, session cleanup, resource limits, non-root proof.

Cross-cutting: same policy/action/effect pipeline as API tools, install-and-resume once, no stolen focus during ordinary chat, pending tasks remain understandable when driver blocked.

Sources and rationale for the choices: [R11–R16](research-and-decisions.md).

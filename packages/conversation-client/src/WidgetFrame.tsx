import { type ReactElement, useEffect, useRef, useState } from "react";

import { createFrameSession, type FrameActionOutcome, type FrameSession } from "@clarkcant/widget-host";

/**
 * A widget running in its own frame.
 *
 * The whole of the isolation story is in one line of markup — `sandbox="allow-scripts"`, with no
 * `allow-same-origin` — and the rest of this file is what makes that line usable. An opaque-origin frame cannot be
 * reached by script, so everything crosses by `postMessage`, and `createFrameSession` is what decides whether a
 * message is allowed: the nonce it issued, the window it came from, the schema, the size, the budget.
 *
 * Nothing here re-implements any of that. The component's job is to be the two things a session cannot be: it owns
 * the element, and it owns the browser's message event. A second copy of the checks would be a second answer to
 * "is this frame allowed to say this", and the two would disagree the first time one was tightened.
 */

export interface WidgetFrameProps {
  instanceId: string;
  /** Where the widget's document is served. Under the package path, so its own relative imports resolve. */
  url: string;
  /** What the frame is a view of, for assistive technology and for the text a loading frame shows. */
  title: string;
  /** The document's declared type, used for the monospace-ish width a widget preview wants. */
  props: Record<string, unknown>;
  state?: Record<string, unknown>;
  /** Capabilities the host will broker for this frame. Empty unless something granted them. */
  brokeredCapabilities: readonly string[];
  /** Origins the document may reach. Enforced by its policy; declared here because the protocol says so. */
  allowedOrigins: readonly string[];
  /** The bindings this instance holds. The frame may name one of these and nothing else. */
  knownActionBindings: readonly string[];
  invokeAction: (input: {
    actionBindingId: string;
    input: Record<string, unknown>;
    expectedRevision: number;
    invocationId: string;
  }) => Promise<FrameActionOutcome>;
  chrome: {
    focus: () => void;
    resize: (height: number) => void;
    requestPin: () => void;
    openExternal: (url: string) => void;
  };
  revision: number;
}

/**
 * A nonce for one frame.
 *
 * Per mount, not per session: a frame that reloaded must not be able to replay the messages it was entitled to
 * before, and a nonce that outlived the document would let it.
 */
function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function WidgetFrame(input: WidgetFrameProps): ReactElement {
  const element = useRef<HTMLIFrameElement>(null);
  const session = useRef<FrameSession | undefined>(undefined);
  const nonce = useRef<string>(newNonce());
  /*
   * The parts that change on every parent render, kept in refs.
   *
   * A session is created for one frame identity and lives as long as that frame does. Rebuilding it whenever the
   * parent re-rendered — which is what depending on `props` or `chrome` did, since both are fresh objects each time —
   * tore down a session mid-handshake and disposed the one that had already been introduced to the frame. The
   * identity is the instance and its document; everything else is read from these refs at the moment it is needed.
   */
  const latest = useRef(input);
  latest.current = input;
  const [status, setStatus] = useState<"loading" | "ready" | "refused">("loading");
  const [notice, setNotice] = useState<string | undefined>(undefined);

  useEffect(() => {
    const frame = element.current;
    if (frame === null) return;

    const live = createFrameSession({
      instanceId: input.instanceId,
      nonce: nonce.current,
      props: latest.current.props,
      ...(latest.current.state === undefined ? {} : { state: latest.current.state }),
      brokeredCapabilities: latest.current.brokeredCapabilities,
      allowedOrigins: latest.current.allowedOrigins,
      knownActionBindings: latest.current.knownActionBindings,
      // The revision the surface was last told, so the widget's first action is not refused as stale.
      revision: latest.current.revision,
      // Read through the ref, so a newer callback is used without rebuilding the session that owns the handshake.
      invokeAction: (intent) => latest.current.invokeAction(intent),
      chrome: {
        focus: () => latest.current.chrome.focus(),
        resize: (height) => latest.current.chrome.resize(height),
        requestPin: () => latest.current.chrome.requestPin(),
        openExternal: (url) => latest.current.chrome.openExternal(url),
      },
      // The frame is reached only this way: an opaque origin has no address to call, so `postMessage` is the whole
      // transport and `"*"` is correct — the session checks the window the message came from, not the target.
      post: (message) => frame.contentWindow?.postMessage(message, "*"),
    });
    session.current = live;

    const onMessage = (event: MessageEvent): void => {
      const matches = frame.contentWindow !== null && event.source === frame.contentWindow;
      const accepted = live.accept({ data: event.data, sourceMatchesExpectedWindow: matches });
      if (accepted.ok) {
        // `ready` is the frame saying it has the init message, which is later than the element's `load` and is the
        // only signal that means the widget is actually running.
        if (accepted.kind === "ready") setStatus("ready");
        return;
      }
      /*
       * Shown, not swallowed. A refusal is the difference between a widget that is quiet and a widget whose
       * messages are being dropped, and only one of those is worth a person's time.
       */
      setStatus("refused");
      setNotice(accepted.message);
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      live.dispose();
      session.current = undefined;
    };
    /*
     * The document's identity, and nothing else.
     *
     * Every other value here is a fresh array or object on each parent render, so depending on them rebuilt the
     * session on a re-render, disposed the one the frame was already speaking to, and left a frame that reported
     * `ready` and then refused every action with "frame đã dispose" — a session that has been disposed cannot be
     * revived, because a runtime that has already said `ready` ignores a second `init`. The session belongs to the
     * document: it is created when the document is, and gone when the document is. The values that merely *feed* it
     * are read from the ref above at the moment they are needed, so a busy parent can re-render all it likes.
     */
  }, [input.instanceId, input.url]);

  /**
   * The init message, sent when the document has loaded.
   *
   * On `load` rather than on mount: a message posted at a frame whose document is not there yet is dropped by the
   * browser, and the widget would wait for a handshake that was never going to arrive.
   */
  const start = (): void => {
    const live = session.current;
    const frame = element.current;
    if (live === undefined || frame === null) return;
    frame.contentWindow?.postMessage(live.init(), "*");
  };

  return (
    <div className="cc-widget-frame" data-widget-frame={input.instanceId} data-frame-status={status}>
      <iframe
        ref={element}
        className="cc-widget-frame-document"
        src={input.url}
        onLoad={start}
        /*
         * The line the whole feature rests on. `allow-scripts` lets the widget run; the *absence* of
         * `allow-same-origin` gives it an opaque origin, so it cannot read this document, its storage or its
         * cookies even though the host served both.
         */
        sandbox="allow-scripts"
        title={input.title}
        data-frame-url={input.url}
      />
      {status === "loading" && <p className="cc-freshness">Đang mở widget…</p>}
      {notice !== undefined && (
        <p className="cc-freshness" data-frame-notice="true">
          {notice}
        </p>
      )}
    </div>
  );
}

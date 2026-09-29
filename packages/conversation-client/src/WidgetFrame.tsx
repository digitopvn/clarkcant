import { type ReactElement, useEffect, useRef, useState } from "react";

import type { SemanticProposal } from "@clarkcant/contracts";

/*
 * The session entry, not the package root.
 *
 * The root is a mixed barrel: alongside the frame session it carries the node-side catalog registry, whose digest
 * helper imports `node:crypto`. A bundled build tree-shakes that away, which is why this only ever failed in dev —
 * where Vite serves modules one to one and hoists the interop read of `createHash` to the top of the module, so
 * importing the root threw before anything rendered. The browser lane wants the frame session and nothing else, and
 * this subpath is that boundary made explicit rather than a bundle happening to remove the rest.
 */
import {
  createFrameSession,
  type FrameActionAvailability,
  type FrameActionOutcome,
  type FrameSession,
  type FrameStateOutcome,
} from "@clarkcant/widget-host/session";

import { useT } from "./i18n/locale-context.tsx";

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

/** A URL a frame can load its document from, and when the grant it carries stops working. */
export interface FrameSource {
  url: string;
  /** Epoch ms in this client's clock. Absent when the node did not say, and then there is no expiry to act on. */
  urlExpiresAt?: number | undefined;
}

export interface WidgetFrameProps {
  instanceId: string;
  /** Where the widget's document is served. Under the package path, so its own relative imports resolve. */
  url: string;
  /** When the grant in `url` stops working (`FrameSource.urlExpiresAt`). */
  urlExpiresAt?: number | undefined;
  /**
   * Re-read the instance for a fresh URL to the same document.
   *
   * The URL's grant is short-lived and the frame is not: a frame that has to load its document again after the grant
   * has lapsed — mounted again from a kept answer, or reloaded by the browser — asks for a fresh one here instead of
   * being refused. Absent, the frame loads what it was given and nothing more.
   */
  renewUrl?: () => Promise<FrameSource>;
  /** What the frame is a view of, for assistive technology and for the text a loading frame shows. */
  title: string;
  /** The document's declared type, used for the monospace-ish width a widget preview wants. */
  props: Record<string, unknown>;
  /** The durable state the node holds for this instance, already migrated to what this widget version expects. */
  state?: Record<string, unknown>;
  /** The state's own revision — separate from `revision`, which is the instance's and what actions are checked against. */
  stateRevision?: number;
  /** Keys the widget keeps as view state: kept in the frame, never sent to the node. */
  ephemeralStateKeys?: readonly string[];
  /**
   * Commit a state write on the node. Resolves with what the node answered; the widget is told its write succeeded
   * only when this says so.
   */
  persistState?: (write: { expectedRevision: number; patch: Record<string, unknown> }) => Promise<FrameStateOutcome>;
  /**
   * Send what the widget says it shows to the node, for the next turn and for voice. Called with the last of a burst
   * only (`SEMANTIC_SETTLE_MS`), so a widget that publishes on every keystroke costs one request when it settles.
   */
  publishSemantic?: (proposal: SemanticProposal) => void;
  /** Capabilities the host will broker for this frame. Empty unless something granted them. */
  brokeredCapabilities: readonly string[];
  /** Origins the document may reach. Enforced by its policy; declared here because the protocol says so. */
  allowedOrigins: readonly string[];
  /** The bindings this instance holds. The frame may name one of these and nothing else. */
  knownActionBindings: readonly string[];
  /** Which service-backed bindings can run right now, as the node last said. Told to the frame when it changes. */
  actionAvailability?: readonly FrameActionAvailability[];
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

/** The height a frame opens at, before its widget has said how tall it is. */
export const DEFAULT_FRAME_HEIGHT = 200;
/** How long a widget's semantic publishes must be quiet before the last one is sent to the node. */
export const SEMANTIC_SETTLE_MS = 250;
const MIN_FRAME_HEIGHT = 80;
const MAX_FRAME_HEIGHT = 1200;

/**
 * The height a widget's resize request gets.
 *
 * Bounded both ways: the widget is untrusted, so it may ask for its content's height but not for a frame that covers
 * the conversation or collapses to nothing. A value that is not a number keeps the default.
 */
export function frameHeight(requested: number): number {
  if (!Number.isFinite(requested)) return DEFAULT_FRAME_HEIGHT;
  return Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.round(requested)));
}

/**
 * Whether a URL's grant has lapsed by `nowMs`.
 *
 * The node refuses every request whose grant has lapsed, so a document loaded from such a URL after this is true was
 * refused — which is what makes this a fact to act on rather than a guess. A URL with no known expiry has none.
 */
export function grantLapsed(urlExpiresAt: number | undefined, nowMs: number): boolean {
  return urlExpiresAt !== undefined && nowMs >= urlExpiresAt;
}

/**
 * Which URL the frame loads, for the document the parent handed over.
 *
 * `source` is undefined while a fresh URL is being read, and nothing is loaded meanwhile: loading a URL known to be
 * refused would only put the node's refusal on screen. `renewed` is the one re-read a refused load is allowed before
 * the failure is shown; it is spent until the widget next says `ready`, so a URL that keeps being refused ends in the
 * failure and never in a loop.
 */
interface FrameMount {
  /** The URL the parent handed over. A different one is a different document, and the mount starts over. */
  given: string;
  source: FrameSource | undefined;
  renewed: boolean;
  /** Present once loading has failed for good: the reason, possibly empty. */
  failure: string | undefined;
}

/** A new mount. A URL whose grant has already lapsed is not loaded: a fresh one is read first, and that is the re-read. */
export function startFrameMount(
  input: Pick<WidgetFrameProps, "url" | "urlExpiresAt" | "renewUrl">,
  nowMs: number,
): FrameMount {
  const lapsed = input.renewUrl !== undefined && grantLapsed(input.urlExpiresAt, nowMs);
  return {
    given: input.url,
    source: lapsed ? undefined : { url: input.url, urlExpiresAt: input.urlExpiresAt },
    renewed: lapsed,
    failure: undefined,
  };
}

/**
 * What a finished load of the frame's document means for the mount.
 *
 * A load of a URL whose grant had lapsed was refused by the node: it gets one re-read for a fresh URL, or, when that
 * re-read has been spent, it is the failure. Anything else is left alone — the widget says `ready` when it is running.
 */
export function afterFrameLoad(mount: FrameMount, canRenew: boolean, nowMs: number): FrameMount {
  if (mount.source === undefined || mount.failure !== undefined) return mount;
  if (!grantLapsed(mount.source.urlExpiresAt, nowMs)) return mount;
  if (canRenew && !mount.renewed) return { ...mount, source: undefined, renewed: true };
  return { ...mount, failure: "" };
}

export function WidgetFrame(input: WidgetFrameProps): ReactElement {
  const t = useT();
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
  const [height, setHeight] = useState(DEFAULT_FRAME_HEIGHT);
  const semanticTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /*
   * The URL the frame actually loads.
   *
   * It starts as the one handed over and changes only when a document has to be loaded after that URL's grant lapsed —
   * never because the parent re-read a running frame, which would reload it. A new URL from the parent is a new
   * document, and the mount starts over (set during render, so the stale URL is never put on the element).
   */
  const [storedMount, setMount] = useState<FrameMount>(() => startFrameMount(input, Date.now()));
  let mount = storedMount;
  if (storedMount.given !== input.url) {
    mount = startFrameMount(input, Date.now());
    setMount(mount);
  }
  const currentMount = useRef(mount);
  currentMount.current = mount;

  /*
   * The re-read, when the mount has no URL to load. The session is kept across it: the new document is the same
   * widget, and the session already holds the state it has committed since the parent's read.
   */
  const needsUrl = mount.source === undefined && mount.failure === undefined;
  const given = mount.given;
  useEffect(() => {
    if (!needsUrl) return;
    const renew = latest.current.renewUrl;
    if (renew === undefined) {
      setMount((current) => (current.given === given ? { ...current, failure: "" } : current));
      return;
    }
    let cancelled = false;
    setStatus("loading");
    renew().then(
      (fresh) => {
        if (!cancelled) setMount((current) => (current.given === given ? { ...current, source: fresh } : current));
      },
      (cause: unknown) => {
        if (cancelled) return;
        const reason = cause instanceof Error ? cause.message : String(cause);
        setMount((current) => (current.given === given ? { ...current, failure: reason } : current));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [needsUrl, given]);

  useEffect(() => {
    const frame = element.current;
    if (frame === null) return;

    const live = createFrameSession({
      instanceId: input.instanceId,
      nonce: nonce.current,
      props: latest.current.props,
      ...(latest.current.state === undefined ? {} : { state: latest.current.state }),
      ...(latest.current.stateRevision === undefined ? {} : { stateRevision: latest.current.stateRevision }),
      ...(latest.current.ephemeralStateKeys === undefined ? {} : { ephemeralStateKeys: latest.current.ephemeralStateKeys }),
      ...(latest.current.persistState === undefined
        ? {}
        : {
            persistState: (write: { expectedRevision: number; patch: Record<string, unknown> }) =>
              latest.current.persistState?.(write) ??
              Promise.resolve<FrameStateOutcome>({ ok: false, code: "STATE_NOT_SAVED", message: "the host stopped saving state" }),
          }),
      // Settled here rather than sent per publish: the node only needs what the widget says once it stops changing.
      publishSemantic: (proposal) => {
        if (semanticTimer.current !== undefined) clearTimeout(semanticTimer.current);
        semanticTimer.current = setTimeout(() => {
          semanticTimer.current = undefined;
          latest.current.publishSemantic?.(proposal);
        }, SEMANTIC_SETTLE_MS);
      },
      brokeredCapabilities: latest.current.brokeredCapabilities,
      allowedOrigins: latest.current.allowedOrigins,
      knownActionBindings: latest.current.knownActionBindings,
      // The revision the surface was last told, so the widget's first action is not refused as stale.
      revision: latest.current.revision,
      // Read through the ref, so a newer callback is used without rebuilding the session that owns the handshake.
      invokeAction: (intent) => latest.current.invokeAction(intent),
      chrome: {
        focus: () => latest.current.chrome.focus(),
        // The frame is sized here, within bounds, because the widget cannot see its own box from inside an opaque
        // origin and a request nobody acts on leaves its content cut off at the browser's default iframe height.
        resize: (requested) => {
          setHeight(frameHeight(requested));
          latest.current.chrome.resize(requested);
        },
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
        if (accepted.kind === "ready") {
          setStatus("ready");
          // Running again, so a later lapse of this URL gets its own re-read.
          setMount((current) => (current.renewed ? { ...current, renewed: false } : current));
        }
        return;
      }
      // A write that lost a race is a conflict, not misbehaviour: the session already answered the widget with the
      // committed state, and it is the widget's to show. Marking the whole frame refused would say it broke.
      if (accepted.code === "STALE_REVISION") return;
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
      if (semanticTimer.current !== undefined) clearTimeout(semanticTimer.current);
      semanticTimer.current = undefined;
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

  /*
   * What the node last said about the service-backed bindings, passed on as it changes. The session holds it until
   * the frame is initialized and drops a repeat, so this can run on every read without the widget hearing it twice.
   */
  const availabilityKey = JSON.stringify(input.actionAvailability ?? []);
  useEffect(() => {
    session.current?.announceActions(latest.current.actionAvailability ?? []);
  }, [availabilityKey, input.instanceId, input.url]);

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
    const loaded = currentMount.current;
    // The blank document the element holds while a fresh URL is read: there is no widget in it to introduce.
    if (loaded.source === undefined) return;
    /*
     * A document loaded after its URL's grant lapsed is the node's refusal, not the widget: it gets the one re-read, or
     * the failure, and never the init message.
     */
    const next = afterFrameLoad(loaded, latest.current.renewUrl !== undefined, Date.now());
    if (next !== loaded) {
      currentMount.current = next;
      setMount(next);
      setStatus("loading");
      return;
    }
    // `init()` sends the message itself (via the session's `post`, wired to this frame's `contentWindow` above) and
    // returns what it sent only so a caller can inspect it. Posting the return value again here produced two init
    // messages for one load, and the widget runtime's `DUPLICATE_INIT` rejection was that second message arriving.
    live.init();
  };

  /** Try once more, on the person's word: one re-read, and the failure again if that is refused too. */
  const retry = (): void => {
    setMount((current) => ({ ...current, source: undefined, renewed: true, failure: undefined }));
  };

  const failed = mount.failure !== undefined;
  return (
    <div className="cc-widget-frame" data-widget-frame={input.instanceId} data-frame-status={failed ? "failed" : status}>
      <iframe
        ref={element}
        className="cc-widget-frame-document"
        src={mount.source?.url}
        // Nothing to show while a fresh URL is read or after loading failed: the element would only hold a blank page
        // or the node's refusal. It stays mounted so the session keeps talking to the same window.
        hidden={mount.source === undefined || failed}
        onLoad={start}
        /*
         * The line the whole feature rests on. `allow-scripts` lets the widget run; the *absence* of
         * `allow-same-origin` gives it an opaque origin, so it cannot read this document, its storage or its
         * cookies even though the host served both.
         */
        sandbox="allow-scripts"
        style={{ height }}
        title={input.title}
        data-frame-url={mount.source?.url}
      />
      {status === "loading" && !failed && <p className="cc-freshness">{t("widgets.frame.opening")}</p>}
      {/*
        What failed, what is kept, and what can be done next — in place of a document that would only show the node's
        refusal. Reached only after the one re-read, so it is not shown for a lapse the frame could recover from.
      */}
      {failed && (
        <div className="cc-widget-frame-failure" data-frame-failure="true" role="alert">
          <p>{t("widgets.frame.reloadFailed")}</p>
          {mount.failure !== "" && (
            <p data-frame-failure-reason="true">{t("widgets.frame.reloadFailedReason").replace("{reason}", mount.failure ?? "")}</p>
          )}
          {input.renewUrl !== undefined && (
            <button type="button" data-frame-retry="true" onClick={retry}>
              {t("widgets.frame.retry")}
            </button>
          )}
        </div>
      )}
      {notice !== undefined && (
        <p className="cc-freshness" data-frame-notice="true">
          {notice}
        </p>
      )}
    </div>
  );
}

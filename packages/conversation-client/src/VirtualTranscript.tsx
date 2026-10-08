import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";

import type { GatewayClient, Timeline } from "./api.ts";
import type { BlockActions, SurfaceBlockRef } from "./blocks.tsx";
import {
  distanceFromBottom,
  followScrollBehavior,
  followsAfterScroll,
  noteLayoutScroll,
  reportScroll,
  scrollAsTranscript,
  stillFollowsBottom,
  type ScrollReport,
} from "./follow-bottom.ts";
import { useT } from "./i18n/locale-context.tsx";
import { TimelineMessageRow } from "./TimelineMessageRow.tsx";
import { computeTranscriptWindow, rowVisibility, sameTranscriptWindow, viewportTopFor, type TranscriptWindow } from "./transcript-window.ts";

/** Rows mounted beyond each edge of the screen, in screens. */
const OVERSCAN_SCREENS = 1;
/** An older page is read once the top of the loaded history is this many screens away, or nearer. */
const PREFETCH_SCREENS = 2;
/** The screen height assumed before the transcript has been laid out once. */
const FALLBACK_VIEWPORT_PX = 800;

interface Anchor {
  id: string;
  /** The row's top, in pixels below the top of the screen; negative when it is partly scrolled past. */
  offset: number;
}

export interface VirtualTranscriptProps {
  messages: Timeline["messages"];
  renderSurface: (props: SurfaceBlockRef) => ReactElement;
  blockActions: BlockActions;
  client: GatewayClient;
  /** The row the notice Undo goes under, or -1; that row stays mounted while the Undo is offered. */
  undoIndex: number;
  undoRow: ReactNode;
  scroller: RefObject<HTMLDivElement | null>;
  /** Whether the reader is following the bottom, asked when something arrives (`use-turn-send.ts`). */
  followsBottomNow: () => boolean;
  hasOlder: boolean;
  olderLoading: boolean;
  olderFailed: boolean;
  loadOlder: () => Promise<void>;
  /** Told which messages are mounted, whenever that changes, so only their presentation is read. */
  onPresentChange: (messageIds: readonly string[]) => void;
}

/** The mounted row holding `node`, by its id. */
function rowIdOf(node: Node | null, list: HTMLElement): string | undefined {
  const element = node instanceof Element ? node : node?.parentElement;
  const slot = element?.closest<HTMLElement>("[data-row-id]");
  return slot !== null && slot !== undefined && list.contains(slot) ? slot.dataset.rowId : undefined;
}

function slotById(list: HTMLElement, id: string): HTMLElement | undefined {
  for (const child of list.children) {
    if (child instanceof HTMLElement && child.dataset.rowId === id) return child;
  }
  return undefined;
}

/** Whether the browser has pulled the view up to the bottom since the place was held at `anchoredTop`. */
function pulledToBottom(scroller: HTMLElement, anchoredTop: number): boolean {
  return scroller.scrollTop <= anchoredTop - 1 && distanceFromBottom(scroller) < 1;
}

/** The first row on screen, and where its top is: what the reader is reading, which must not move under them. */
function captureAnchor(scroller: HTMLElement, list: HTMLElement): Anchor | undefined {
  const top = scroller.getBoundingClientRect().top;
  let last: Anchor | undefined;
  for (const child of list.children) {
    if (!(child instanceof HTMLElement) || child.dataset.rowId === undefined) continue;
    const rect = child.getBoundingClientRect();
    last = { id: child.dataset.rowId, offset: rect.top - top };
    if (rect.bottom > top + 1) return last;
  }
  return last;
}

/**
 * The stored messages of the conversation, mounted around the screen.
 *
 * - **Window.** With more than a few dozen rows, only the rows within about a screen of what is visible are mounted
 *   (`transcript-window.ts`); the rest are spacers of their measured height. The newest row, the row holding focus, a
 *   row whose player is playing, the rows a selection spans, the row the Undo sits under and the row being read are
 *   always mounted, so nothing a person is using is unmounted underneath them.
 * - **Anchor.** What the reader is reading stays where it is: the first row on screen and its offset are kept, and
 *   restored whenever rows are put in front of it or a row above it changes height. The browser's own scroll anchoring
 *   is turned off on the scroller so the two never correct the same change twice.
 * - **History.** Nearing the top of what is loaded reads the page before it, with no button to press. A read that
 *   fails says so in place, keeps everything on screen, and offers to try again.
 * - **Announcements.** The transcript is a polite live region. Rows mounted by scrolling, or put in front by an older
 *   page, sit in an `aria-live="off"` wrapper, so a screen reader announces what arrived at the end of the
 *   conversation and not every row that scrolled into the document.
 * - **Motion.** A row enters with its animation once: in the first batch, or when it arrives at the end. A row mounted
 *   again by scrolling back, or put in front by an older page, just appears.
 *
 * Memoised: a streamed reply renders the conversation on every delta, and none of that reaches the history.
 */
function VirtualTranscriptComponent(props: VirtualTranscriptProps): ReactElement {
  const { messages, renderSurface, blockActions, client, undoIndex, undoRow, scroller, followsBottomNow } = props;
  const t = useT();
  const ids = useMemo(() => messages.map((message) => message.messageId), [messages]);
  const list = useRef<HTMLDivElement>(null);
  /** Each row's height plus the gap after it, by id, measured while it was mounted and kept after it was not. */
  const heights = useRef(new Map<string, number>());
  const gap = useRef(0);
  const anchor = useRef<Anchor | undefined>(undefined);
  const [viewport, setViewport] = useState<{ anchor: Anchor | undefined; height: number }>(() => ({
    anchor: undefined,
    height: typeof window === "undefined" ? FALLBACK_VIEWPORT_PX : window.innerHeight,
  }));
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
  const [playingIds, setPlayingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selectionIds, setSelectionIds] = useState<readonly [string, string] | undefined>(undefined);
  /** The row of the embedded frame last activated: what plays in it is not visible from here, so it is assumed to. */
  const [embedId, setEmbedId] = useState<string | undefined>(undefined);

  /*
   * Which rows arrived at the end, and which enter with their animation.
   *
   * Kept across renders and decided once per row: deciding again would cut an animation short on the next render. A
   * row the first render drew is part of the opening batch; one that came after the previous newest row arrived at the
   * end, and is announced. A conversation that started empty (a first message being sent) announces its first rows.
   */
  const rendered = useRef<{ tail: string | undefined; any: boolean }>({ tail: undefined, any: false });
  const opening = useRef<ReadonlySet<string> | undefined>(undefined);
  const arrived = useRef(new Set<string>());
  const enters = useRef(new Map<string, boolean>());
  /** Arrived rows still to be announced: a row stops being announced once it leaves the document, and stays so. */
  const announced = useRef(new Set<string>());
  const arrive = (id: string): void => {
    arrived.current.add(id);
    announced.current.add(id);
  };
  if (ids.length > 0) {
    const previous = rendered.current;
    if (!previous.any) {
      opening.current = new Set(ids);
    } else if (previous.tail === undefined) {
      for (const id of ids) arrive(id);
    } else {
      const at = ids.lastIndexOf(previous.tail);
      if (at >= 0) for (const id of ids.slice(at + 1)) if (!arrived.current.has(id)) arrive(id);
    }
    /*
     * A page that cannot be stitched to the held window (after a long disconnect, `mergeTimeline`) replaces it; its
     * newest message is then not after the previous tail, so nothing on it counts as arrived: it is announced and
     * animated as history, not as a burst of new messages the person did not watch arrive.
     */
  }
  rendered.current = { tail: ids.at(-1), any: true };

  const keep = useMemo(() => {
    const indices = new Set<number>([ids.length - 1]);
    if (undoIndex >= 0) indices.add(undoIndex);
    const add = (id: string | undefined): void => {
      if (id === undefined) return;
      const index = ids.indexOf(id);
      if (index >= 0) indices.add(index);
    };
    add(focusedId);
    add(embedId);
    add(viewport.anchor?.id);
    for (const id of playingIds) add(id);
    if (selectionIds !== undefined) {
      const from = ids.indexOf(selectionIds[0]);
      const to = ids.indexOf(selectionIds[1]);
      if (from >= 0 && to >= 0) for (let index = Math.min(from, to); index <= Math.max(from, to); index += 1) indices.add(index);
    }
    return indices;
  }, [embedId, focusedId, ids, playingIds, selectionIds, undoIndex, viewport.anchor]);

  const windowFor = useCallback(
    (at: { anchor: Anchor | undefined; height: number }): TranscriptWindow =>
      computeTranscriptWindow({
        ids,
        heights: heights.current,
        viewportTop: viewportTopFor({ ids, heights: heights.current, anchor: at.anchor, viewportHeight: at.height }),
        viewportHeight: at.height,
        overscan: at.height * OVERSCAN_SCREENS,
        keep,
        gap: gap.current,
      }),
    [ids, keep],
  );
  const shown = windowFor(viewport);
  const latest = useRef({ shown, windowFor, props });
  latest.current = { shown, windowFor, props };

  /** The scroll position the anchor was last taken or restored at. */
  const anchoredTop = useRef(0);

  /**
   * Put the row being read back where it was.
   *
   * This corrects a change of layout, never a scroll. A scroll the anchor has not been taken from yet - the reader's, a
   * focus or a `scrollIntoView` that brought something into view - moved the scroll position since the anchor was
   * taken; it is what the reader is now looking at, so the anchor is taken from it instead of the view being pulled
   * back to where it was.
   *
   * The moves it makes, and the browser's pull of the view up to a bottom that came closer, are the layout's: they are
   * noted as such (`noteLayoutScroll`), so a reader following the bottom is not taken for one who scrolled up.
   */
  const holdPlace = useCallback((): void => {
    const node = scroller.current;
    const rows = list.current;
    if (node === null || rows === null) return;
    const pulled = pulledToBottom(node, anchoredTop.current);
    if (Math.abs(node.scrollTop - anchoredTop.current) >= 1) {
      if (!pulled) {
        anchor.current = captureAnchor(node, rows);
        anchoredTop.current = node.scrollTop;
        return;
      }
      /*
       * Pulled up to a bottom that came closer: the browser's move, because less is below the view, not the reader's.
       *
       * Counted once because of the order a browser keeps: it reports a scroll (the report) and then runs the frame's
       * callbacks (`sync`, which moves `anchoredTop` to the new position) before any later task can draw the transcript
       * again. A report taken after this pull but before `anchoredTop` caught up would hold the pull twice, once in its
       * position and once here, and leave the check lenient by its size. A pull first heard as a scroll is held in that
       * scroll's own event, before it is reported (`onScroll` below), so it is counted once there too.
       *
       * For a reader who had left the bottom, the pull is not where they were reading, though. When rows above the screen
       * shrink under them - the window mounting rows that the browser then stops drawing off screen, say - the browser
       * takes the view up only as far as the new bottom, not by all that shrank: the row being read lands further up the
       * screen by the reader's distance from the bottom, and the view sits at the bottom as if they had never left it. So
       * the place is held from the anchor as for any change of layout, below: the row goes back where it was, which takes
       * the view back up to where the reader put it. Where nothing above shrank - a taller screen, less of the reply
       * below - the row has not moved up, there is no room below to put it back down, and the pull stands.
       *
       * A reader following the bottom stays at it: the pull is where they want to be.
       */
      noteLayoutScroll(node, node.scrollTop - anchoredTop.current);
      if (latest.current.props.followsBottomNow()) {
        anchor.current = captureAnchor(node, rows);
        anchoredTop.current = node.scrollTop;
        return;
      }
    }
    const held = anchor.current;
    const slot = held === undefined ? undefined : slotById(rows, held.id);
    if (held !== undefined && slot !== undefined) {
      const delta = slot.getBoundingClientRect().top - node.getBoundingClientRect().top - held.offset;
      if (Math.abs(delta) >= 1) scrollAsTranscript(node, { top: node.scrollTop + delta, behavior: "instant" });
    }
    if (pulled) anchor.current = captureAnchor(node, rows);
    anchoredTop.current = node.scrollTop;
  }, [scroller]);

  /** Read the page before the loaded history when its top is near. */
  const nearTop = useCallback((): void => {
    const node = scroller.current;
    const rows = list.current;
    const current = latest.current.props;
    if (node === null || rows === null || !current.hasOlder || current.olderLoading || current.olderFailed) return;
    const above = node.getBoundingClientRect().top - rows.getBoundingClientRect().top;
    if (above < PREFETCH_SCREENS * node.clientHeight) void current.loadOlder();
  }, [scroller]);

  /* Following the screen: the anchor on every scroll, the window only when the rows it mounts change. */
  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    let frame = 0;
    const sync = (): void => {
      frame = 0;
      const rows = list.current;
      if (rows === null) return;
      anchor.current = captureAnchor(node, rows);
      anchoredTop.current = node.scrollTop;
      const next = { anchor: anchor.current, height: node.clientHeight };
      if (!sameTranscriptWindow(latest.current.windowFor(next), latest.current.shown)) setViewport(next);
      nearTop();
    };
    const onScroll = (): void => {
      /*
       * A pull up to a bottom that came closer can land with nothing of the transcript's running first: a row the browser
       * stops drawing once it is off screen (`content-visibility`) shrinks between frames, and the first thing to hear of
       * it is this scroll. The place is held here, before the scroll is reported (this listener captures, so it runs
       * before the ones that read where the reader is), rather than on the next frame, when the report would already
       * have read a reader taken to the bottom as one who went there.
       */
      if (pulledToBottom(node, anchoredTop.current)) holdPlace();
      if (frame === 0) frame = requestAnimationFrame(sync);
    };
    node.addEventListener("scroll", onScroll, { passive: true, capture: true });
    /*
     * The screen changing height. A screen that got taller - a docked panel closing, a soft keyboard going away - pulls a
     * view at the bottom up, and nothing else draws the transcript to see it before more of a reply can land below and
     * the view is no longer at the bottom: the place is held here, in the frame of the change, so that pull is recorded.
     */
    const resize = new ResizeObserver(() => {
      holdPlace();
      onScroll();
    });
    resize.observe(node);
    return () => {
      node.removeEventListener("scroll", onScroll, { capture: true });
      resize.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [holdPlace, nearTop, scroller]);

  /* Measuring rows: a row that changes height above the one being read must not move it. */
  const measure = useMemo(
    () =>
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver((entries) => {
            for (const entry of entries) {
              const target = entry.target as HTMLElement;
              const id = target.dataset.rowId;
              if (id === undefined) continue;
              heights.current.set(id, (entry.borderBoxSize[0]?.blockSize ?? target.getBoundingClientRect().height) + gap.current);
            }
            /*
             * Held on every report, not only when a height differs from the one kept. A row mounted again is laid out
             * first at the height the browser assumes for content it has not drawn yet (`content-visibility`'s intrinsic
             * size), and the place is held against that layout when it mounts. The browser then draws it at its real
             * height, and the observer's first report is that height: the same as the one kept from before, yet every
             * row below it moved by the difference.
             */
            holdPlace();
          }),
    [holdPlace],
  );
  useEffect(() => () => measure?.disconnect(), [measure]);
  const observeRow = useCallback(
    (element: HTMLDivElement | null) => {
      if (element === null || measure === undefined) return undefined;
      measure.observe(element);
      return () => measure.unobserve(element);
    },
    [measure],
  );

  /*
   * After every change to what is mounted: keep the place, report what is drawn, and read more history if near the top.
   *
   * A reader following the bottom stays at it when the messages held change - the conversation opening, a message
   * arriving - as `use-turn-send.ts` does for the timeline; the rows are only laid out here, after it has scrolled. A
   * settled row growing as its picture or chart loads is not something arriving, and does not pull the view down.
   */
  const reported = useRef("");
  const heldMessages = useRef("");
  useLayoutEffect(() => {
    const rows = list.current;
    const node = scroller.current;
    if (rows !== null && gap.current === 0) {
      const parsed = Number.parseFloat(getComputedStyle(rows).rowGap);
      gap.current = Number.isFinite(parsed) ? parsed : 0;
    }
    holdPlace();
    const held = `${ids[0] ?? ""}\u0000${ids.at(-1) ?? ""}\u0000${String(ids.length)}`;
    if (held !== heldMessages.current) {
      heldMessages.current = held;
      if (node !== null && rows !== null && distanceFromBottom(node) > 0 && followsBottomNow()) {
        scrollAsTranscript(node, { top: node.scrollHeight, behavior: "instant" });
        anchor.current = captureAnchor(node, rows);
        anchoredTop.current = node.scrollTop;
      }
    }
    const mounted = new Set(shown.mounted.map((index) => ids[index]!));
    // A row that left the document enters without animation if it comes back.
    for (const id of enters.current.keys()) if (!mounted.has(id)) enters.current.set(id, false);
    // And is not announced again: it was said once, when it arrived.
    for (const id of announced.current) if (!mounted.has(id)) announced.current.delete(id);
    const present = [...mounted];
    const key = present.join("\u0000");
    if (key !== reported.current) {
      reported.current = key;
      props.onPresentChange(present);
    }
  });
  useEffect(() => {
    nearTop();
  }, [nearTop, props.hasOlder, props.olderLoading, props.olderFailed, ids]);

  /* The rows a person is using stay mounted: the focused one, one playing, and the ones a selection spans. */
  useEffect(() => {
    const rows = list.current;
    if (rows === null) return;
    const doc = rows.ownerDocument;
    const onFocusIn = (event: FocusEvent): void => setFocusedId(rowIdOf(event.target as Node, rows));
    /*
     * Focus is read from the document once it has settled rather than from `relatedTarget`, which is null when focus
     * goes into an embedded frame (or out of the window) and would let the row holding that frame be unmounted.
     */
    const settleFocus = (): void => {
      const active = doc.activeElement;
      setFocusedId(active !== null && rows.contains(active) ? rowIdOf(active, rows) : undefined);
    };
    const onFocusOut = (): void => queueMicrotask(settleFocus);
    /*
     * An embedded frame (a video, a map) takes focus and plays inside a document of its own: no focus or play event
     * reaches this one, only the window's blur, with the frame as the active element. Its row is kept as focused, and
     * kept after that as the last embed activated, until another embed is: whether it is still playing cannot be read.
     */
    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    const onWindowBlur = (): void => {
      clearTimeout(blurTimer);
      blurTimer = setTimeout(() => {
        const active = doc.activeElement;
        if (!(active instanceof HTMLIFrameElement) || !rows.contains(active)) return;
        const id = rowIdOf(active, rows);
        setFocusedId(id);
        if (id !== undefined) setEmbedId(id);
      }, 0);
    };
    const view = doc.defaultView;
    const playing = (event: Event): void => {
      const id = rowIdOf(event.target as Node, rows);
      if (id === undefined) return;
      const on = event.type === "play" || event.type === "playing";
      setPlayingIds((current) => {
        if (current.has(id) === on) return current;
        const next = new Set(current);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      });
    };
    const onSelection = (): void => {
      const selection = doc.getSelection();
      const from = selection === null || selection.isCollapsed ? undefined : rowIdOf(selection.anchorNode, rows);
      const to = selection === null || selection.isCollapsed ? undefined : rowIdOf(selection.focusNode, rows);
      setSelectionIds((current) => {
        if (from === undefined || to === undefined) return current === undefined ? current : undefined;
        return current !== undefined && current[0] === from && current[1] === to ? current : [from, to];
      });
    };
    rows.addEventListener("focusin", onFocusIn);
    rows.addEventListener("focusout", onFocusOut);
    view?.addEventListener("blur", onWindowBlur);
    for (const type of ["play", "playing", "pause", "ended", "emptied"]) rows.addEventListener(type, playing, true);
    doc.addEventListener("selectionchange", onSelection);
    return () => {
      rows.removeEventListener("focusin", onFocusIn);
      rows.removeEventListener("focusout", onFocusOut);
      view?.removeEventListener("blur", onWindowBlur);
      clearTimeout(blurTimer);
      for (const type of ["play", "playing", "pause", "ended", "emptied"]) rows.removeEventListener(type, playing, true);
      doc.removeEventListener("selectionchange", onSelection);
    };
  }, []);

  const edge = props.olderFailed ? (
    <div className="cc-history-edge" data-history="failed" role="status">
      <span>{t("timeline.history.failed")}</span>
      <button type="button" className="cc-action" onClick={() => void props.loadOlder()}>
        {t("timeline.history.retry")}
      </button>
    </div>
  ) : props.olderLoading ? (
    <div className="cc-history-edge" data-history="loading" aria-live="off">
      <span className="cc-freshness">{t("timeline.history.loading")}</span>
    </div>
  ) : null;

  return (
    <>
      {edge}
      <div className="cc-transcript-rows" ref={list} data-rows-total={ids.length} data-rows-mounted={shown.mounted.length}>
        {/* One flat list keyed by message id: rows in nested arrays would be remounted whenever a spacer above them
            appeared or went, losing focus, selection, playback and the entrance decision with them. */}
        {shown.segments.flatMap((segment) =>
          segment.kind === "gap" ? [
            <div
              key={`gap-${ids[segment.from]!}`}
              className="cc-transcript-gap"
              data-visibility="suspended"
              data-rows={segment.to - segment.from}
              aria-hidden="true"
              style={{ height: `${String(segment.height)}px` }}
            />,
          ] : (
            messages.slice(segment.from, segment.to).map((message, offset) => {
              const index = segment.from + offset;
              const id = message.messageId;
              if (!enters.current.has(id)) {
                enters.current.set(id, opening.current?.has(id) === true || arrived.current.has(id));
              }
              return (
                <div
                  key={id}
                  ref={observeRow}
                  className="cc-transcript-slot"
                  data-row-id={id}
                  data-visibility={rowVisibility(index, shown)}
                  data-enter={enters.current.get(id) === true ? undefined : "none"}
                  aria-live={announced.current.has(id) ? undefined : "off"}
                >
                  <TimelineMessageRow
                    message={message}
                    index={index}
                    renderSurface={renderSurface}
                    blockActions={blockActions}
                    client={client}
                    settled
                  />
                  {index === undoIndex && undoRow}
                </div>
              );
            })
          ),
        )}
      </div>
    </>
  );
}

export const VirtualTranscript = memo(VirtualTranscriptComponent);

/**
 * "Jump to latest", while the reader is more than a screen above the bottom and something new arrived there.
 *
 * Not chrome: it appears only when there is something to go to, sits over the transcript rather than taking room in
 * it, and goes away at the bottom. Returning to the bottom by any means resumes following it.
 */
export function JumpToLatest({ scroller, newest }: { scroller: RefObject<HTMLDivElement | null>; newest: string }): ReactElement | null {
  const t = useT();
  const [far, setFar] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const atBottom = useRef(true);
  const reported = useRef<ScrollReport>({ top: 0, layout: 0 });

  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    const onScroll = (): void => {
      atBottom.current = followsAfterScroll(atBottom.current, reported.current, node);
      reported.current = reportScroll(node);
      setFar(distanceFromBottom(node) > node.clientHeight);
      if (atBottom.current) setUnseen(false);
    };
    reported.current = reportScroll(node);
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [scroller]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const node = scroller.current;
    // A scroll up the browser has not reported yet still leaves the reader above what arrived.
    if (node === null ? !atBottom.current : !stillFollowsBottom(atBottom.current, reported.current, node)) setUnseen(true);
  }, [newest, scroller]);

  if (!far || !unseen) return null;
  return (
    <div className="cc-jump-latest-dock">
      <button
        type="button"
        className="cc-chip cc-jump-latest"
        data-jump-latest="true"
        onClick={() => {
          const node = scroller.current;
          if (node === null) return;
          node.scrollTo({ top: node.scrollHeight, behavior: followScrollBehavior(node) });
          setUnseen(false);
          // The button goes with the distance; focus goes to the conversation it brought the reader to.
          node.focus({ preventScroll: true });
        }}
      >
        {t("timeline.jumpToLatest")}
      </button>
    </div>
  );
}

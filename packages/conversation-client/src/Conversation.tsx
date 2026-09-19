import { type CSSProperties, type ReactElement, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";

import type {
  GatewayClient,
  ResolvedDataset,
  SnapshotPresentationResponse,
  Timeline,
} from "./api.ts";
import { renderBlock, type SurfaceBlockRef } from "./blocks.tsx";
import {
  applyResolvedTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  systemPrefersLight,
  watchSystemTheme,
  type ThemeChoice,
} from "./theme.ts";
import type { ThemeName } from "@clarkcant/design-tokens";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { ReasoningBlock, ToolActivityBlock, type BlockActions } from "./blocks.tsx";
import { composerTextareaHeight } from "./composer-height.ts";
import {
  attachmentReducer,
  clientAccepts,
  formatFileSize,
  nameForPastedFile,
  readyAttachmentIds,
  toBase64,
  type AttachmentChip,
} from "./attachments.ts";
import { ATTACHMENT_LIMITS } from "@clarkcant/contracts";
import { followsBottom } from "./follow-bottom.ts";
import { latestTurnMetrics, statuslineParts } from "./statusline.ts";
import { attachedPrompt, explainPrompt } from "./selection.ts";
import { SelectionToolbar } from "./selection-toolbar.tsx";
import { BackgroundSessionsMark } from "./background-sessions-mark.tsx";
import { applyLiveEvent, type LiveSegment } from "./live-reply.ts";
import { agentStateFrom, attachInputModality, type InputModality } from "./input-modality.ts";
import type { ResolvedOrbProfile } from "./orb-profile.ts";
import { Markdown } from "./markdown.tsx";
import { Orb } from "./Orb.tsx";
import { useTypewriterPlaceholder, prefersReducedMotion } from "./typewriter.ts";
import { VoiceOverlay } from "./VoiceOverlay.tsx";import { SettingsPanel } from "./SettingsPanel.tsx";
import { resolveRenderer, toRendererDataset } from "./renderers.tsx";
import { MiniAppSurface, type CompositeSurfaceView } from "./mini-app-surface.tsx";
import { PinnedLiveSurface } from "./DesktopSurfaces.tsx";
import { useImageUrls } from "./use-image-urls.ts";

/**
 * Conversation surface.
 *
 * One timeline, one composer, an optional pin shelf, and a status that never claims more
 * than it knows. There is no session picker and no sidebar, because the blueprint's
 * position is that the conversation is the interface: extra navigation is a cost the user
 * pays to learn the tool, not a feature.
 *
 * Two behaviours are load-bearing rather than cosmetic:
 *
 *   - **The status dot reports the gateway, not the model.** "Ready" means the runtime
 *     answered; it does not mean a provider credential is configured, and the empty state
 *     says so when nothing can answer.
 *   - **Suggestion chips are labelled as samples.** Clicking one runs a scripted recipe, so
 *     the label has to be visible before the click, not a footnote after it.
 */
export interface ConversationProps {
  client: GatewayClient;
  /** Pre-existing conversation, or `undefined` to create one on first send. */
  conversationId?: string;
  /** Injected so tests can assert behaviour without waiting on a wall clock. */
  onTimelineChange?: (timeline: Timeline) => void;
  /** Called once a conversation exists, so the host can remember it across reloads. */
  onConversationReady?: (conversationId: string) => void;
  /**
   * Called when the session is restarted, so the host can forget what it remembered.
   *
   * The conversation id lives in the host's storage rather than here, and a restart that left it
   * behind would be undone by the next reload: the start screen would appear, and then the old
   * conversation would come back. Clearing it is the host's job because remembering it is.
   */
  onSessionReset?: () => void;
  /** Loads an existing conversation on mount instead of starting empty. */
  initialAfter?: number;
  /**
   * The personalized orb, resolved by the host from the stored preferences.
   *
   * Passed down rather than read here: the conversation is rendered many times per turn, and a component
   * that fetched its own preferences would rebuild the orb's GPU program on whatever schedule its own
   * re-renders happened to follow.
   */
  orbProfile?: ResolvedOrbProfile;
}

type ConnectionState = "connecting" | "ready" | "offline";

/**
 * The four things the empty state offers.
 *
 * Four, and every one of them actually runs. The first three reach a scripted recipe over the
 * sample dataset, so they work with no provider configured; the fourth is an ordinary message and
 * needs a model to answer it. Nothing here is a label that looks like a feature — a chip that sends
 * a message nobody can handle teaches the user that the app is broken rather than that a model is
 * missing, and the fourth chip says which of those is true.
 */
const SUGGESTIONS = [
  // `demo: true` is what makes these chips the only way a scripted sample runs: the label says the data is sample
  // data, and the flag is what the node reads to decide whether a scripted reply is allowed at all.
  { label: "Làm gì đó", text: "cho tui xem biểu đồ", detail: "chạy trên dữ liệu mẫu", demo: true },
  { label: "Sửa một lỗi", text: "tạo note nhanh cho tui", detail: "chạy trên dữ liệu mẫu", demo: true },
  { label: "Xem dự án của tui", text: "cho tui xem bảng dữ liệu", detail: "chạy trên dữ liệu mẫu", demo: true },
  { label: "Chỉ trò chuyện", text: "chào bạn, bạn làm được gì?", detail: "cần model", demo: false },
] as const;

/**
 * The questions the empty composer types at the user, one at a time.
 *
 * Asked as questions rather than shown as commands, because the empty state is a prompt for what to
 * say and a list of instructions reads as a menu of the only four things that work.
 */
const PLACEHOLDER_PHRASES = [
  "có cập nhật gì mới không?",
  "cần làm gì hôm nay?",
  "phân tích các commit gần nhất",
] as const;

/**
 * The orb's canvas, which is deliberately larger than the ball drawn inside it.
 *
 * The ball's radius is a fraction of the canvas, so the margin around it is what the pointer's flare and
 * the jelly deformation have to grow into. At 720 pixels the margin was about a hundred pixels a side,
 * and a flare that followed the pointer to the edge was cut off by the canvas — a straight line across a
 * glow that is meant to fade. 960 with a smaller radius keeps the ball exactly the size it was and nearly
 * doubles the room around it.
 */
export const ORB_DRAW_SIZE = 960;
/** How often the conversation is re-read while a spoken turn runs, at most. */
const VOICE_REFRESH_INTERVAL_MS = 400;

/** The ball's radius as a fraction of the canvas half-height: 0.54 x 960 is the 518 pixel ball. */
export const ORB_RADIUS = 0.54;

/**
 * The orb's diameter once it is docked behind the composer.
 *
 * One reference size for the placement and the room reserved in the transcript, rather than the canvas
 * size: what a reader sees and what the layout has to make space for is the ball, not the buffer.
 */
const ORB_DOCK_SIZE = 720;

/** How long each suggestion waits behind the one before it as they leave. */
const HERO_CHIP_STAGGER_MS = 90;

/** Where the orb is drawn, in the shell's own coordinates. */
export interface OrbPlacement {
  x: number;
  y: number;
  /** Drawn at `ORB_DOCK_SIZE` and scaled, so the docked size is the reference. */
  scale: number;
  docked: boolean;
}

export function Conversation({
  client,
  conversationId: initialConversationId,
  onTimelineChange,
  onConversationReady,
  onSessionReset,
  orbProfile,
}: ConversationProps): ReactElement {
  const [conversationId, setConversationId] = useState<string | undefined>(initialConversationId);
  const [timeline, setTimeline] = useState<Timeline | undefined>(undefined);
  const [datasets, setDatasets] = useState<Record<string, ResolvedDataset>>({});
  /**
   * The immutable presentation each message captured, keyed by snapshot.
   *
   * Fetched once and kept: a bundle is written once and never updated, so re-reading it on every
   * render would be a request per keystroke for data that cannot have changed. The live instance is
   * a different read, and it lives in the pinned surface that claims ownership of it.
   */
  const [snapshots, setSnapshots] = useState<Record<string, SnapshotPresentationResponse>>({});
  /**
   * The control that opened the expanded live view.
   *
   * Focus has to come back somewhere specific when that view closes: a keyboard user who lands on
   * `<body>` after Escape has to re-navigate the whole page to get where they were.
   */
  const liveTrigger = useRef<HTMLElement | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * Files on their way to the node, as chips above the input.
   *
   * Held here rather than inside the composer form because sending has to read them and clear them, and a
   * chip that outlives the message it belonged to is a file the person thinks they sent twice.
   */
  const [chips, dispatchChips] = useReducer(attachmentReducer, [] as readonly AttachmentChip[]);
  /** Whether a file is being dragged over the composer, which is what draws the drop target. */
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  /**
   * Which of the two shapes the interface is in.
   *
   * `shown` is the start screen, `gone` is a conversation, and `leaving` is the few hundred
   * milliseconds between them — during which the hero is still drawn, out of the flow, so its chips
   * can leave one at a time instead of disappearing with the same layout change that starts the exit.
   */
  const [heroPhase, setHeroPhase] = useState<"shown" | "leaving" | "gone">("shown");
  /** The message the user just sent, drawn before the node has confirmed anything about it. */
  const [pendingUser, setPendingUser] = useState<{ text: string } | undefined>(undefined);
  /** The reply as it arrives, in the order the turn produces it. */
  const [live, setLive] = useState<LiveSegment[]>([]);
  /** Where the orb is drawn, once the layout has been measured. */
  const [orbPlacement, setOrbPlacement] = useState<OrbPlacement | undefined>(undefined);
  /** The element the orb answers pointer movement anywhere inside. */
  const shell = useRef<HTMLDivElement>(null);
  /**
   * How the user last interacted, as one attribute on the shell.
   *
   * Published here rather than detected by each component that cares: a listener per component is a
   * listener per component to keep in sync, and the stylesheet would have no single place to read. Only
   * changes are reported, so a pointer crossing the shell is one state write rather than a thousand.
   */
  const [modality, setModality] = useState<InputModality>("pointer");

  useEffect(() => {
    // The window rather than the shell: a pointer that has left the shell is still the last thing the user
    // did, and a keyboard event inside a focused control has to be seen too.
    const handle = attachInputModality({ target: window, onChange: setModality });
    return () => handle.dispose();
  }, []);

  /** The space the hero reserves for the orb, which is where the orb measures itself from. */
  const heroOrb = useRef<HTMLDivElement>(null);
  const composerWrap = useRef<HTMLDivElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  /** The hidden file input the `+` button opens, so the button itself is a real `<button>`. */
  const attachmentInput = useRef<HTMLInputElement>(null);
  /**
   * The composer's top edge before the hero left.
   *
   * Read in the same event that starts the exit, because it is the last moment at which the old
   * position still exists: the alternative is measuring after the fact and animating from a value
   * that is no longer anywhere.
   */
  const composerFrom = useRef<number | undefined>(undefined);
  const [uiCheckOpen, setUiCheckOpen] = useState(false);
  /**
   * Whether the voice surface is up.
   *
   * Opened from the composer's microphone button, which used to be disabled with a tooltip: the one
   * control a person would press to start talking was the one that did nothing, while the working
   * session sat in a settings tab. Speaking is a mode of the conversation, so it belongs here.
   */
  const [voiceOpen, setVoiceOpen] = useState(false);

  /**
   * What the agent is doing, as one state rather than several flags a stylesheet would have to combine.
   *
   * Every input is a state this component already holds. Nothing is promoted to `success`: there is no
   * real completion signal here yet, and a state published without one is the interface claiming to know
   * something it does not.
   */
  const agentState = agentStateFrom({
    failed: error !== undefined,
    listening: voiceOpen,
    busy,
    tooling: live.some((segment) => segment.kind === "tool"),
    responding: live.some((segment) => segment.kind === "text" || segment.kind === "reasoning"),
  });
  /** Which approval is in flight, so one card says so rather than every card looking busy. */
  const [decidingApprovalId, setDecidingApprovalId] = useState<string | undefined>(undefined);
  /**
   * Which session the interface is showing.
   *
   * Incremented by a restart, and captured by anything that is about to write a result back. A
   * reply that arrives after the user restarted belongs to a conversation they have left, so it
   * is dropped rather than drawn into the fresh start screen.
   */
  const sessionGeneration = useRef(0);
  /**
   * The theme the user chose, which is `dark`, `light` or `system`.
   *
   * The choice is held, not the resolved theme. Holding the resolved theme would silently turn
   * `system` into whichever theme the operating system happened to be in when the page loaded,
   * and the interface would then stop following the system it was asked to follow.
   */
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => readStoredTheme());
  const [resolvedTheme, setResolvedTheme] = useState<ThemeName>(() =>
    resolveTheme(readStoredTheme(), systemPrefersLight()),
  );

  /**
   * Apply the choice: store it, resolve it, and write the result onto the document.
   *
   * Storing the choice rather than the resolved value is what lets `system` keep meaning
   * `system` across a reload.
   */
  const applyThemeChoice = useCallback((next: ThemeChoice) => {
    storeTheme(next);
    const resolved = resolveTheme(next, systemPrefersLight());
    applyResolvedTheme(resolved);
    setThemeChoice(next);
    setResolvedTheme(resolved);
  }, []);

  /*
   * Follow the operating system, but only while the user has actually asked for `system`.
   * A listener that keeps firing after the user picks an explicit theme would override their
   * choice the next time their machine switched to night mode.
   */
  useEffect(() => {
    if (themeChoice !== "system") return;
    return watchSystemTheme((prefersLight) => {
      const resolved = resolveTheme("system", prefersLight);
      applyResolvedTheme(resolved);
      setResolvedTheme(resolved);
    });
  }, [themeChoice]);
  const scroller = useRef<HTMLDivElement>(null);
  /**
   * Whether the reader is at the bottom of the transcript.
   *
   * Following is something the reader chooses by being at the bottom, not a property of the transcript: a
   * streamed answer grows on every delta, and a view that follows it unconditionally pulls the page back down
   * each time someone scrolls up to read what came before. That is the fight this records, and ends.
   */
  const followBottom = useRef(true);

  /**
   * How long the hero takes to leave, read from the motion tokens.
   *
   * The duration the stylesheet runs and the duration the timer waits have to be the same number, so
   * it is read back off the document instead of repeated here — and it is zero for a reduced-motion
   * user, whose animations the stylesheet has already shortened to nothing.
   */
  const heroExitMs =
    prefersReducedMotion() ? 0 : motionDurationMs("--cc-motion-exit", 320) + HERO_CHIP_STAGGER_MS * (SUGGESTIONS.length - 1);

  /**
   * Remember where the composer is, before anything moves it.
   *
   * Read in the same event that changes the layout, because that is the last moment the old position
   * exists: measuring afterwards and animating from a value that is no longer anywhere is not a
   * transition. Both directions need it — leaving the start screen moves it down, and returning to it
   * moves it back up.
   */
  const rememberComposerTop = useCallback((): void => {
    const node = composerWrap.current;
    composerFrom.current = node === null ? undefined : node.getBoundingClientRect().top;
  }, []);

  /**
   * Start the hero leaving.
   *
   * Driven by a timer rather than by the exit animation's end event, because the chips finish at
   * different times and the event from the shortest of them would take the hero away while the rest
   * were still leaving.
   */
  const beginHeroExit = useCallback((): void => {
    if (heroPhase !== "shown") return;
    rememberComposerTop();
    setHeroPhase("leaving");
    window.setTimeout(
      () => setHeroPhase((phase) => (phase === "leaving" ? "gone" : phase)),
      heroExitMs,
    );
  }, [heroExitMs, heroPhase, rememberComposerTop]);

  /**
   * Grow the input to fit what is typed into it, and stop at five lines.
   *
   * A layout effect rather than an effect so the growth lands in the same frame as the keystroke: an
   * effect would let the browser paint the old height first, and the box would visibly trail the text
   * by one frame on every line.
   */
  useLayoutEffect(() => {
    const node = composerInput.current;
    if (node === null) return;
    // The height is released before measuring, because the scroll height of a box that is already as
    // tall as its content reports that height rather than the content's — which would make the box
    // only ever grow.
    node.style.height = "auto";
    const lineHeight = Number.parseFloat(getComputedStyle(node).lineHeight);
    const { height, scrolls } = composerTextareaHeight(node.scrollHeight, lineHeight);
    node.style.height = `${height}px`;
    node.style.overflowY = scrolls ? "auto" : "hidden";
  }, [draft]);

  /**
   * Replay the composer's move from the middle of the screen to the bottom.
   *
   * The Web Animations API rather than a CSS transition, because the composer has no property to
   * transition — where it sits comes from the document's flow, and the flow changed in one step. A
   * transform from the old position to none is the same movement, and it is applied to an element
   * whose layout position is already final, so nothing else is displaced while it plays.
   */
  useLayoutEffect(() => {
    const node = composerWrap.current;
    const from = composerFrom.current;
    composerFrom.current = undefined;
    if (node === null || from === undefined || prefersReducedMotion()) return;
    const delta = from - node.getBoundingClientRect().top;
    if (Math.abs(delta) < 2) return;
    node.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], {
      duration: motionDurationMs("--cc-motion-orb", 600),
      easing: motionEasing(),
    });
  }, [heroPhase]);

  /**
   * Keep the orb where the layout says it belongs.
   *
   * The orb is one element that moves between two places, so its position is measured from the thing
   * it belongs to rather than declared in CSS: the hero's reserved space while the start screen is
   * up, and the composer's frame once it is docked. A ResizeObserver rather than a list of events,
   * because what moves it is a change in either of those frames — a font arriving, a chip wrapping,
   * the input growing a line — and a list of causes is a list that goes stale.
   */
  const measureOrb = useCallback((): void => {
    const shellBox = shell.current?.getBoundingClientRect();
    if (shellBox === undefined) return;
    const docked = heroPhase !== "shown";
    const frame = (docked ? composerWrap.current : heroOrb.current)?.getBoundingClientRect();
    if (frame === undefined) return;
    const next: OrbPlacement = docked
      ? {
          x: frame.left + frame.width / 2 - shellBox.left,
          // A third of the orb above the composer's frame, the rest behind it: that is what "the orb
          // sits behind the input" means as a number.
          y: frame.top + ORB_DOCK_SIZE / 6 - shellBox.top,
          scale: 1,
          docked: true,
        }
      : {
          x: frame.left + frame.width / 2 - shellBox.left,
          y: frame.top + frame.height / 2 - shellBox.top,
          // The anchor reserves the space the ball occupies, so the canvas is scaled to that width.
          scale: frame.width / ORB_DRAW_SIZE,
          docked: false,
        };
    // Compared before storing, because this runs on every resize of a frame that moves on nearly
    // every keystroke: a fresh object each time would re-render the conversation per character.
    setOrbPlacement((current) =>
      current !== undefined &&
      Math.abs(current.x - next.x) < 0.5 &&
      Math.abs(current.y - next.y) < 0.5 &&
      current.scale === next.scale
        ? current
        : next,
    );
  }, [heroPhase]);

  useLayoutEffect(() => {
    measureOrb();
    window.addEventListener("resize", measureOrb);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => measureOrb()) : undefined;
    // The hero's own box is observed as well as the reserved space inside it, because what moves the
    // anchor is the text around it growing - the heading arriving with the webfont, the paragraph
    // wrapping - and a resize of the anchor's parent re-measures where the anchor ended up.
    for (const node of [heroOrb.current?.parentElement, heroOrb.current, composerWrap.current]) {
      if (node !== null && node !== undefined && observer !== undefined) observer.observe(node);
    }
    // And again as the layout settles over the first second - the health check returning, the composer's
    // own line arriving - because the first measurement describes the page before any of that. Bounded
    // on purpose: a settle window, not a loop.
    const settleTimers = [0, 50, 150, 400, 900].map((ms) => setTimeout(() => measureOrb(), ms));
    // The webfont arrives after the first paint and changes how tall the hero's text is, which moves
    // the reserved space the orb is placed against.
    void document.fonts?.ready.then(() => measureOrb());
    return () => {
      for (const timer of settleTimers) clearTimeout(timer);
      observer?.disconnect();
      window.removeEventListener("resize", measureOrb);
    };
  }, [measureOrb]);

  /* Connectivity is checked once, so the status reflects reality rather than optimism. */
  useEffect(() => {
    let cancelled = false;
    client
      .health()
      .then(() => {
        if (!cancelled) setConnection("ready");
      })
      .catch(() => {
        if (!cancelled) setConnection("offline");
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const applyTimeline = useCallback(
    (next: Timeline) => {
      setTimeline(next);
      onTimelineChange?.(next);
    },
    [onTimelineChange],
  );

  /**
   * Read the conversation again.
   *
   * A voice session answers through the conductor like any other message, but over its own socket, so
   * nothing draws the result here. This is the ask that keeps the two views of one conversation from
   * disagreeing until someone reloads the page.
   */
  const refreshTimeline = useCallback((): void => {
    if (conversationId === undefined) return;
    void client
      .timeline(conversationId)
      .then((loaded) => applyTimeline(loaded))
      .catch(() => undefined);
  }, [applyTimeline, client, conversationId]);

  /**
   * The same read, while a spoken turn is still running.
   *
   * A sentence someone has just spoken should appear as a message, and the answer should grow as it is written,
   * instead of both arriving when the turn ends - which reads as the interface having ignored the person who
   * spoke. Throttled, because the transcript updates per delta and reading the whole conversation per delta
   * would be a request storm that adds no information.
   */
  const voiceRefreshTimer = useRef<number | undefined>(undefined);
  const scheduleVoiceRefresh = useCallback((): void => {
    if (voiceRefreshTimer.current !== undefined) return;
    voiceRefreshTimer.current = window.setTimeout(() => {
      voiceRefreshTimer.current = undefined;
      refreshTimeline();
    }, VOICE_REFRESH_INTERVAL_MS);
  }, [refreshTimeline]);

  useEffect(
    () => () => {
      if (voiceRefreshTimer.current !== undefined) window.clearTimeout(voiceRefreshTimer.current);
    },
    [],
  );


  /* Load any existing conversation once, so a reload is not a new conversation. */
  useEffect(() => {
    if (initialConversationId === undefined) return;
    let cancelled = false;
    client
      .timeline(initialConversationId)
      .then((loaded) => {
        if (!cancelled) applyTimeline(loaded);
      })
      .catch(() => {
        // A conversation that no longer exists is not an error the user needs to see; the
        // next send creates a fresh one.
        if (!cancelled) setConversationId(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [applyTimeline, client, initialConversationId]);

  /* Resolve every dataset a visible widget references, and record its freshness. */
  const datasetRefs = useMemo(() => {
    const refs = new Set<string>();
    for (const instance of timeline?.instances ?? []) {
      const ref = instance.props.datasetRef;
      if (typeof ref === "string") refs.add(ref);
    }
    return [...refs].sort().join(",");
  }, [timeline]);

  useEffect(() => {
    if (datasetRefs === "") return;
    let cancelled = false;
    for (const datasetId of datasetRefs.split(",")) {
      if (datasets[datasetId] !== undefined) continue;
      client
        .dataset(datasetId)
        .then((resolved) => {
          if (!cancelled) setDatasets((current) => ({ ...current, [datasetId]: resolved }));
        })
        .catch(() => {
          // A missing dataset is normal: the renderer shows its own unavailable message.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [client, datasetRefs, datasets]);

  const instanceById = useMemo(() => {
    const map = new Map<string, Timeline["instances"][number]>();
    for (const instance of timeline?.instances ?? []) map.set(instance.instanceId, instance);
    return map;
  }, [timeline]);

  /**
   * The snapshot behind every composed message, and only those with a bundle.
   *
   * A snapshot written before bundles existed has nothing to render from, which is why the absence
   * of a bundle is carried forward as the reason to show the message's text alternative rather
   * than the live instance's current props.
   */
  const composedSnapshots = useMemo(() => {
    const entries: { snapshotId: string; instanceId: string | undefined }[] = [];
    for (const block of blocksOf(timeline)) {
      if (block.type !== "surface") continue;
      const snapshot = (block.snapshot ?? {}) as Record<string, unknown>;
      const definitionRef = (block.definitionRef ?? {}) as Record<string, unknown>;
      const instanceId = typeof snapshot.instanceId === "string" ? snapshot.instanceId : undefined;
      const definitionId =
        typeof definitionRef.id === "string" ? definitionRef.id : instanceId === undefined ? "" : instanceById.get(instanceId)?.definitionId ?? "";
      if (definitionId !== "canvas.overview@1") continue;
      const snapshotId = typeof snapshot.snapshotId === "string" ? snapshot.snapshotId : "";
      if (snapshotId === "" || typeof snapshot.bundleRef !== "string") continue;
      entries.push({ snapshotId, instanceId });
    }
    return entries;
  }, [instanceById, timeline]);

  useEffect(() => {
    if (conversationId === undefined) return;
    for (const entry of composedSnapshots) {
      if (snapshots[entry.snapshotId] !== undefined) continue;
      void client
        .snapshotPresentation(conversationId, entry.snapshotId)
        .then((loaded) => setSnapshots((current) => ({ ...current, [entry.snapshotId]: loaded })))
        .catch(() => {
          // A snapshot that cannot be read is not an error state for the conversation: the message
          // falls back to its text alternative, which is what history keeps regardless.
        });
    }
  }, [client, composedSnapshots, conversationId, snapshots]);

  /**
   * Every picture any surface asks for, from the props it asks in.
   *
   * A single reference, a list of them, or the poster beside a video: a renderer cannot fetch, it can only draw
   * a URL it was handed, so whatever shape the request takes has to be recognised here or the widget shows its
   * text alternative while the picture sits on the node unread.
   */
  const inlineImageRefs = useMemo(() => {
    const refs = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === "string") {
        if (value !== "") refs.add(value);
        return;
      }
      if (Array.isArray(value)) for (const entry of value) collect(entry);
    };
    for (const instance of timeline?.instances ?? []) {
      const props = (instance as { props?: Record<string, unknown> }).props ?? {};
      collect(props.imageRef);
      collect(props.imageRefs);
      collect(props.videoRef);
      collect(props.posterRef);
    }
    for (const entry of composedSnapshots) {
      for (const section of snapshots[entry.snapshotId]?.sections ?? []) {
        const ref = section.props.imageRef;
        if (typeof ref === "string" && ref !== "") refs.add(ref);
      }
    }
    return [...refs].sort();
  }, [composedSnapshots, snapshots, timeline]);

  const imageUrl = useImageUrls(client, inlineImageRefs);

  useEffect(() => {
    const node = scroller.current;
    if (node === null || !followBottom.current) return;
    node.scrollTop = node.scrollHeight;
    // The streamed reply is as much a reason to follow the bottom as a stored message is: without it
    // the answer grows below the fold while the view stays where the question was. It is conditional
    // because that is a reason to follow, not a licence to interrupt someone reading further up.
  }, [live, pendingUser, timeline]);

  /* Reading away from the bottom stops the following; coming back to it starts it again. */
  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    const onScroll = (): void => {
      followBottom.current = followsBottom({
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
        clientHeight: node.clientHeight,
      });
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  /**
   * Take files into the composer, one chip at a time.
   *
   * Every route in — the picker, a drop, a paste — comes through here, so the rules are applied once. A file
   * the client already knows the node will refuse gets a failed chip and no request at all: uploading 30 MB
   * to be told the ceiling is 25 would spend the person's bandwidth to tell them something known in advance.
   *
   * The conversation is created first when there is none. An attachment belongs to a conversation, and one
   * uploaded into nothing could never be sent.
   */
  const addFiles = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) return;
      setError(undefined);

      const stamped = Date.now();
      const additions: AttachmentChip[] = files.map((file, index) => ({
        id: `chip_${stamped}_${index}`,
        // A pasted file often arrives with no name at all, and the node refuses an empty one — rightly, since
        // a nameless attachment is a row nobody can recognise later.
        filename: file.name === "" ? nameForPastedFile(file.type, new Date(stamped)) : file.name,
        mime: file.type,
        sizeBytes: file.size,
        state: "checking",
      }));
      dispatchChips({ type: "add", chips: additions });

      // Where a chip can still become ready. Past this, the message could not carry them anyway.
      const room = Math.max(0, ATTACHMENT_LIMITS.maxPerMessage - chips.length);
      for (const [index, chip] of additions.entries()) {
        if (index >= room) {
          dispatchChips({
            type: "failed",
            id: chip.id,
            reason: `một tin nhắn chỉ mang được ${ATTACHMENT_LIMITS.maxPerMessage} tệp`,
          });
        }
      }
      const considered = additions.slice(0, room);
      if (considered.length === 0) return;

      let target = conversationId;
      if (target === undefined) {
        try {
          target = (await client.createConversation("Conversation")).conversationId;
          setConversationId(target);
          onConversationReady?.(target);
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          for (const chip of considered) dispatchChips({ type: "failed", id: chip.id, reason });
          return;
        }
      }

      for (const chip of considered) {
        const refused = clientAccepts({ filename: chip.filename, mime: chip.mime, sizeBytes: chip.sizeBytes });
        if (!refused.ok) {
          dispatchChips({ type: "failed", id: chip.id, reason: refused.message });
          continue;
        }
        const file = files[additions.indexOf(chip)];
        if (file === undefined) continue;
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const stored = await client.uploadAttachment({
            conversationId: target,
            filename: chip.filename,
            mime: chip.mime,
            contentBase64: toBase64(bytes),
          });
          dispatchChips({ type: "stored", id: chip.id, attachmentId: stored.attachmentId });
        } catch (cause) {
          dispatchChips({
            type: "failed",
            id: chip.id,
            reason: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    },
    [chips.length, client, conversationId, onConversationReady],
  );

  const send = useCallback(
    async (text: string, options: { demo?: boolean } = {}) => {
      const trimmed = text.trim();
      if (trimmed === "" || busy) return;

      setBusy(true);
      setError(undefined);
      setDraft("");
      // Drawn from here rather than from the node's answer: the user's own message is not in doubt,
      // and waiting for the round trip to show it makes the interface feel slower than it is.
      setPendingUser({ text: trimmed });
      // Sending is a decision to be at the newest turn, whatever the view was doing before it.
      followBottom.current = true;
      setLive([]);
      beginHeroExit();
      const generation = sessionGeneration.current;
      try {
        const attachmentIds = readyAttachmentIds(chips);
      const target = conversationId ?? (await client.createConversation("Conversation")).conversationId;
        // The user may have restarted while the conversation was being created or the model was
        // answering. Everything after this point belongs to the session they left.
        if (sessionGeneration.current !== generation) return;
        if (conversationId === undefined) {
          setConversationId(target);
          onConversationReady?.(target);
        }
        await client.streamMessage(
          target,
          trimmed,
          {
            onEvent: (event) => {
              if (sessionGeneration.current !== generation) return;
              setLive((segments) => applyLiveEvent(segments, event));
            },
            onDone: (result) => {
              if (sessionGeneration.current !== generation) return;
              // The node's own record replaces both placeholders in one update, so the reply is never
              // on screen twice: the stored message and the text that stood in for it change together.
              applyTimeline(result.timeline);
              setPendingUser(undefined);
              setLive([]);
            },
          },
          { ...options, attachmentIds },
        );
        // Cleared only after the send succeeded: a failed send leaves the chips stored on the node, so the
        // person can press send again rather than attaching the same file a second time.
        dispatchChips({ type: "sent" });
      } catch (cause) {
        if (sessionGeneration.current !== generation) return;
        // The draft is restored so a failed send does not lose the user's text.
        setDraft(trimmed);
        setPendingUser(undefined);
        setLive([]);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [applyTimeline, beginHeroExit, busy, chips, client, conversationId, onConversationReady],
  );

  /**
   * Back to the start screen, with a new session.
   *
   * Deliberately not a delete: the conversation stays in the node's history, because that is a
   * record of what happened rather than a draft to discard. This only stops the interface from
   * showing it, and the next message opens a new one.
   */
  const restartSession = useCallback((): void => {
    // Measured first, so the composer's return to the middle of the screen is a move rather than a
    // jump: a restart is the same layout change in the opposite direction.
    rememberComposerTop();
    sessionGeneration.current += 1;
    setConversationId(undefined);
    setTimeline(undefined);
    setDatasets({});
    setSnapshots({});
    setDraft("");
    setError(undefined);
    setBusy(false);
    // Back to the start screen, with the orb returning to the middle: the phase is the same fact as
    // an empty timeline, and leaving it behind is what would strand the orb at the foot of the page.
    setPendingUser(undefined);
    setLive([]);
    setHeroPhase("shown");
    onSessionReset?.();
  }, [onSessionReset, rememberComposerTop]);

  /**
   * Answer an operation the agent asked for.
   *
   * The decision goes to the node, which recomputes the digest of what it is about to run and refuses a
   * mismatch; the client's job is to send back exactly what the card displayed and to draw the timeline
   * that comes back. Nothing here can approve anything: the card's buttons are the only entry, and a
   * model cannot press them.
   */
  const decideApproval = useCallback(
    (input: { approvalId: string; digest: string; decision: "granted" | "denied" }) => {
      if (conversationId === undefined) return;
      setDecidingApprovalId(input.approvalId);
      setError(undefined);
      void client
        .decideApproval(conversationId, input.approvalId, { decision: input.decision, digest: input.digest })
        .then((result) => applyTimeline(result.timeline))
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setDecidingApprovalId(undefined));
    },
    [applyTimeline, client, conversationId],
  );

  /**
   * Approvals that already have a receipt in this transcript.
   *
   * The card in storage stays `pending` because messages are never rewritten, so the decision is read
   * from the receipt instead: the operation the user approved carries its approval id.
   */
  const decidedApprovals = useMemo(() => {
    const decided = new Set<string>();
    // Read from the timeline rather than from `blocks`, which is declared further down this component:
    // a hook that depends on a later `const` is a temporal dead zone, not a style preference.
    for (const message of timeline?.messages ?? []) {
      for (const block of message.blocks) {
        if (block.type !== "tool-activity") continue;
        const args = (block.args ?? {}) as Record<string, unknown>;
        if (typeof args.approvalId === "string") decided.add(args.approvalId);
      }
    }
    return [...decided];
  }, [timeline]);

  /**
   * What the node said about the last secret submitted through a card.
   *
   * Held here rather than in the card because the card is a message in a transcript: it is re-rendered from
   * stored blocks on every load, and a status that lived inside it would be a status that changed what history
   * says. This is a fact about now, so it lives with the other facts about now.
   */
  const [credentialStatus, setCredentialStatus] = useState<{ requestId: string; message: string } | undefined>(undefined);
  const submitCredential = useCallback(
    (input: { requestId: string; fields: { name: string; value: string }[] }): void => {
      client
        .putCredential({ fields: input.fields })
        .then((result) =>
          setCredentialStatus({
            requestId: input.requestId,
            message:
              result.names.length === 0
                ? "Đã gửi, nhưng node không ghi nhận tên nào."
                : `Đã lưu: ${result.names.join(", ")}.`,
          }),
        )
        .catch(() =>
          // The failure message says nothing about what was typed. An error that repeated the value would be the
          // leak this card exists to prevent, and it would be the easiest one to write by accident.
          setCredentialStatus({ requestId: input.requestId, message: "Không lưu được. Thử lại." }),
        );
    },
    [client],
  );

  const blockActions: BlockActions = useMemo(
    () => ({
      onApprovalDecide: decideApproval,
      decidedApprovals,
      ...(decidingApprovalId === undefined ? {} : { decidingApprovalId }),
      onCredentialSubmit: submitCredential,
      ...(credentialStatus === undefined ? {} : { credentialStatus }),
    }),
    [credentialStatus, decideApproval, decidedApprovals, decidingApprovalId, submitCredential],
  );

  const renderSurface = useCallback(
    (input: SurfaceBlockRef): ReactElement => {
      const instance = input.instanceId === undefined ? undefined : instanceById.get(input.instanceId);
      const definitionId = instance?.definitionId ?? input.definitionId;

      // The container is checked before the leaf renderer lookup, because the container is not a
      // leaf: `resolveRenderer` has no entry for it, and asking for one first would send every
      // composed surface down the fallback path.
      if (definitionId === "canvas.overview@1") {
        const captured = input.snapshotId === "" ? undefined : snapshots[input.snapshotId];
        // Staleness is the one field that changes after a snapshot is written, and it is recorded on
        // the snapshot row rather than in the message — the message is history and stays as it was.
        const snapshotRow = timeline?.snapshots.find((entry) => entry.snapshotId === input.snapshotId);
        const stale = snapshotRow?.stale ?? input.stale;
        if (instance === undefined) {
          return (
            <div className="cc-card cc-freshness" data-widget-fallback="true" style={{ padding: "var(--cc-space-md)" }}>
              {input.textAlternative}
            </div>
          );
        }
        return (
          <div
            data-widget-instance={instance.instanceId}
            data-widget-definition={definitionId}
            data-snapshot={input.snapshotId}
            data-snapshot-stale={stale ? "true" : "false"}
          >
            {captured === undefined ? (
              // History without a stored bundle shows what the message itself carries. Substituting
              // the live instance here is the failure mode this whole split exists to prevent.
              <div className="cc-card cc-freshness" data-widget-fallback="true" style={{ padding: "var(--cc-space-md)" }}>
                {input.textAlternative}
              </div>
            ) : (
              <MiniAppSurface
                view={toSurfaceViewFromSnapshot(captured, instance.revision)}
                title={typeof instance.props.title === "string" ? instance.props.title : undefined}
                imageUrl={imageUrl}
              />
            )}
            {conversationId !== undefined && (
              <button
                className="cc-icon-btn"
                style={{ width: "auto", padding: "0 var(--cc-space-sm)", marginTop: "var(--cc-space-xs)" }}
                data-open-live={instance.instanceId}
                onClick={(event) => {
                  liveTrigger.current = event.currentTarget;
                  // "Open the current view" is an expanded pin: the pinned surface is where the
                  // live instance is mounted, and it is the one that claims ownership of it.
                  void client
                    .pin(conversationId, instance.instanceId, "expanded")
                    .then((result) => applyTimeline(result.timeline))
                    .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
                }}
              >
                Mở bản hiện tại
              </button>
            )}
          </div>
        );
      }

      const Renderer = resolveRenderer(definitionId);
      if (Renderer === undefined || instance === undefined) {
        // An unknown definition is a normal outcome, not a failure: the snapshot's text alternative
        // is what history keeps.
        return (
          <div className="cc-card cc-freshness" data-widget-fallback="true" style={{ padding: "var(--cc-space-md)" }}>
            {input.textAlternative}
          </div>
        );
      }
      const datasetRef = instance.props.datasetRef;
      const resolved = typeof datasetRef === "string" ? datasets[datasetRef] : undefined;
      const dataset = resolved === undefined ? undefined : toRendererDataset(resolved);

      return (
        <div data-widget-instance={instance.instanceId} data-widget-definition={definitionId}>
          <Renderer
            definitionId={definitionId}
            props={instance.props}
            dataset={dataset}
            // The picture resolver, which used to reach only the composed surface. A widget that draws a picture
            // cannot fetch one: it can only draw a URL it was handed, so leaving this out made every picture
            // widget - the imported image included - show its text alternative while the bytes sat unread on the
            // node.
            imageUrl={imageUrl}
            onAction={(action) => {
              // View actions only for now: an action that would cause an effect goes through
              // the approval route, and there is no code path here that bypasses it.
              void action;
            }}
          />
          {conversationId !== undefined && (
            <button
              className="cc-icon-btn"
              style={{ width: "auto", padding: "0 var(--cc-space-sm)", marginTop: "var(--cc-space-xs)" }}
              data-pin-instance={instance.instanceId}
              onClick={() => {
                void client
                  .pin(conversationId, instance.instanceId)
                  .then((result) => applyTimeline(result.timeline))
                  .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
              }}
            >
              Ghim lại
            </button>
          )}
        </div>
      );
    },
    // `datasets` belongs here: the renderer reads the resolved rows through this closure, and a
    // missing entry is the difference between a table and "no data to show".
    // Every value the renderer reads through this closure belongs here. `datasets` and `imageUrl`
    // are the two that arrive after the first paint, and leaving either out is how a table or a
    // picture renders as "not available" while its bytes sit in the browser.
    [applyTimeline, client, conversationId, datasets, imageUrl, instanceById, snapshots, timeline],
  );

  const blocks = timeline?.messages ?? [];
  const pins = timeline?.pins ?? [];

  /**
   * A conversation that arrived with messages was never the start screen.
   *
   * Loading history is not the hero leaving — nothing was sent — so this skips the exit entirely
   * rather than replaying it for a conversation the user was already in.
   */
  useEffect(() => {
    if (blocks.length > 0) setHeroPhase((phase) => (phase === "shown" ? "gone" : phase));
  }, [blocks.length]);

  const placeholder = useTypewriterPlaceholder(PLACEHOLDER_PHRASES, heroPhase === "shown" && draft === "");
  const showTimeline = blocks.length > 0 || pendingUser !== undefined || busy;

  return (
    <div
      className="cc-shell"
      // The two shapes the interface takes, and the three measurements the motion needs: how long the
      // hero takes to leave, how far apart its chips go, and how big the orb is when docked. They are
      // custom properties on the shell so the stylesheet and the JavaScript that times the same
      // animation are reading one number instead of two copies of it.
      data-view={heroPhase === "shown" ? "hero" : "conversation"}
      // The composer steps aside while a voice session is open. It cannot be covered reliably - the panel is
      // narrower than the input it sits over - so it is taken out of the way instead, which is also what the
      // mode means: while the microphone is open, the thing you talk to is not the text box.
      data-voice-open={voiceOpen ? "true" : "false"}
      // How the user is interacting and what the agent is doing, published once for the whole shell. A
      // component that needs either reads an attribute instead of attaching its own listener and guessing
      // from unrelated DOM state.
      data-input-modality={modality}
      data-agent-state={agentState}
      ref={shell}
      style={
        {
          "--cc-hero-exit": `${heroExitMs}ms`,
          "--cc-chip-stagger": `${HERO_CHIP_STAGGER_MS}ms`,
          "--cc-orb-dock": `${ORB_DOCK_SIZE}px`,
        } as CSSProperties
      }
    >
      <header className="cc-header">
        {/*
          The logo is the way back to the start screen, which is where a user looks first when
          they want to begin again. It is a button rather than a decorated div so it can be reached
          and announced: a click target only a mouse can find is half a control.
        */}
        <button
          type="button"
          className="cc-brand"
          data-home="true"
          onClick={restartSession}
          title="Bắt đầu lại"
          aria-label="Bắt đầu lại: về màn hình đầu và mở một phiên mới"
        >
          <Orb size={30} className="cc-orb" label="" pointerTarget={shell} {...(orbProfile === undefined ? {} : { profile: orbProfile })} />
          <span>ClarkCant</span>
        </button>
        <div className="cc-header-end">
          <div className="cc-status" role="status" aria-live="polite" data-connection={connection}>
            <span className="cc-dot" data-state={connection} aria-hidden="true" />
            {connection === "ready" ? "Ready" : connection === "connecting" ? "Đang kết nối" : "Mất kết nối"}
          </div>
          {/* The work behind the conversation. Absent while there is none: a header that always said "0" would be a
              permanent line of noise, and the count only matters when it is not zero. */}
          <BackgroundSessionsMark client={client} />
          {/*
            The gear is the only settings affordance, which is why it is here rather than in a
            menu: a setting that is two clicks deep is a setting nobody checks. It opens a panel
            that reads the live tokens back off the document, so what it shows is what rendered.
          */}
          <button type="button" className="cc-icon-btn" aria-label="Cài đặt" title="Cài đặt" data-settings="true" onClick={() => setUiCheckOpen(true)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      {/* Focusable as a fallback target: when the control that opened the live view is gone from the
          document, focus has to land somewhere meaningful rather than on the body. */}
      <div className="cc-body">
        <div className="cc-scroll" ref={scroller} tabIndex={-1}>
          {/*
            The start screen. It stays mounted while it leaves, out of the flow, so that the chips can
            go one at a time: unmounting it with the message that replaced it would take all four with
            it in the same frame, which is a disappearance rather than an exit.
          */}
          {heroPhase !== "gone" && (
            <div className="cc-empty" data-leaving={heroPhase === "leaving" ? "true" : "false"}>
              {/*
                Where the orb goes while the start screen is up. The orb itself is drawn in the layer
                behind the composer, and this is the space it is measured against — which is why it is
                reserved rather than drawn: the same element has to be able to be in two places, and
                only one of them can be a layout child.
              */}
              <div className="cc-hero-orb" ref={heroOrb} aria-hidden="true" />
              <h1>Bạn đang nghĩ gì?</h1>
              <p>Nói việc bạn muốn làm, hoặc bắt đầu từ một trong bốn gợi ý dưới đây.</p>
              <div className="cc-chip-row" data-suggestion-count={SUGGESTIONS.length}>
                {SUGGESTIONS.map((suggestion, index) => (
                  <button
                    key={suggestion.text}
                    type="button"
                    className="cc-chip"
                    data-suggestion={suggestion.text}
                    data-suggestion-detail={suggestion.detail}
                    style={{ "--cc-chip-index": index } as CSSProperties}
                    // The detail is in the accessible name as well as visible text, because a person
                    // using a screen reader has the same question about which chips need a model.
                    aria-label={`${suggestion.label} — ${suggestion.detail}`}
                    onClick={() => void send(suggestion.text, { demo: suggestion.demo === true })}
                  >
                    <span className="cc-chip-label">{suggestion.label}</span>
                    <span className="cc-chip-detail">{suggestion.detail}</span>
                  </button>
                ))}
              </div>
              <p className="cc-freshness">
                Gợi ý đánh dấu “cần model” sẽ báo lỗi nếu node này chưa cấu hình model.
              </p>
            </div>
          )}

          {showTimeline && (
            <div className="cc-timeline" aria-live="polite" aria-relevant="additions">
              {blocks.map((message, index) => (
                <article
                  key={`${message.messageId}-${index}`}
                  className="cc-row"
                  data-role={message.role}
                  // Staggered so a reply with several parts arrives as a sequence rather than as one
                  // block; capped, because the tenth row should not wait a second to appear.
                  style={{ "--cc-enter-delay": `${Math.min(index, 6) * 60}ms` } as CSSProperties}
                >
                  {message.role === "assistant" ? (
                    // Full width, with the agent's mark beside it: a reply is the agent talking, and
                    // boxing it like the user's message would make both sides look like utterances.
                    <div className="cc-assistant">
                      <AgentAvatar />
                      <div className="cc-assistant-body">
                        {message.blocks.map((block, blockIndex) => renderBlock(block, blockIndex, renderSurface, blockActions, client))}
                      </div>
                    </div>
                  ) : (
                    // A bubble, because it is the user's own words coming back to them at a glance.
                    <div className="cc-bubble" data-bubble="user">
                      {message.blocks.map((block, blockIndex) => renderBlock(block, blockIndex, renderSurface, blockActions, client))}
                    </div>
                  )}
                </article>
              ))}

              {pendingUser !== undefined && (
                <article className="cc-row" data-role="user" data-pending="true" style={{ "--cc-enter-delay": "0ms" } as CSSProperties}>
                  <div className="cc-bubble" data-bubble="user">
                    <Markdown text={pendingUser.text} />
                  </div>
                </article>
              )}

              {/*
                The reply while it is being written. A blinking marker until the first token arrives,
                then the text itself: an indicator that stayed after the text started would be
                claiming the model has not begun, which is the opposite of what is on screen.
              */}
              {busy && (
                <article className="cc-row" data-role="assistant" data-live="true" style={{ "--cc-enter-delay": "0ms" } as CSSProperties}>
                  <div className="cc-assistant">
                    <AgentAvatar />
                    <div className="cc-assistant-body">
                      {live.length === 0 ? (
                        <div className="cc-thinking" data-thinking="true" role="status" aria-label="ClarkCant đang trả lời">
                          <span className="cc-thinking-dot" aria-hidden="true" />
                          <span className="cc-thinking-dot" aria-hidden="true" />
                          <span className="cc-thinking-dot" aria-hidden="true" />
                        </div>
                      ) : (
                        // Drawn in the order the turn produced it, so a tool call the model makes
                        // halfway through a sentence appears where it happened rather than under the
                        // whole reply — which is also where the stored message will put it.
                        live.map((segment, index) => {
                          const last = index === live.length - 1;
                          if (segment.kind === "tool") {
                            return <ToolActivityBlock key={`live-tool-${String(segment.block.toolCallId ?? index)}`} block={segment.block} />;
                          }
                          if (segment.kind === "reasoning") {
                            return <ReasoningBlock key={`live-reasoning-${index}`} block={{ type: "reasoning", content: segment.text }} />;
                          }
                          return (
                            <div key={`live-text-${index}`} className="cc-text" data-streaming={last ? "true" : undefined}>
                              <Markdown text={segment.text} />
                              {last && <span className="cc-caret" aria-hidden="true" />}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </article>
              )}
            </div>
          )}
        </div>

      {/*
        The expanded live view of a pinned instance. This is the only place a composed surface can
        be acted on: the copy in the transcript is history, and mounting a second live instance
        beside it would be two owners for one logical widget.
      */}
      {conversationId !== undefined &&
        pins
          .filter((pin) => pin.displayMode === "expanded" && instanceById.get(pin.instanceId)?.definitionId === "canvas.overview@1")
          .map((pin) => (
            <div key={`live-${pin.pinId}`} className="cc-pin-expanded" data-pin-live={pin.pinId}>
              <PinnedLiveSurface
                client={client}
                conversationId={conversationId}
                instanceId={pin.instanceId}
                displayMode="expanded"
                title={typeof instanceById.get(pin.instanceId)?.props.title === "string" ? String(instanceById.get(pin.instanceId)?.props.title) : undefined}
                onTimeline={applyTimeline}
                onClose={() => {
                  // Collapsing is an unpin: the expanded view exists because the pin says so, and
                  // leaving the pin behind would make the next render open it again.
                  void client
                    .unpin(conversationId, pin.pinId)
                    .then((result) => applyTimeline(result.timeline))
                    .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
                    .finally(() => {
                      const trigger = liveTrigger.current;
                      liveTrigger.current = null;
                      if (trigger !== null && trigger.isConnected) trigger.focus();
                      else scroller.current?.focus();
                    });
                }}
              />
            </div>
          ))}

      {pins.length > 0 && (
        <div className="cc-pins" data-pin-shelf="true">
          {pins.map((pin) => {
            const instance = instanceById.get(pin.instanceId);
            return (
              <span key={pin.pinId} className="cc-pin" data-pin-id={pin.pinId} data-refresh-policy={pin.refreshPolicy}>
                <span>{instance?.definitionId ?? pin.instanceId}</span>
                <button
                  aria-label="Bỏ ghim"
                  data-unpin={pin.pinId}
                  onClick={() => {
                    if (conversationId === undefined) return;
                    void client
                      .unpin(conversationId, pin.pinId)
                      .then((result) => applyTimeline(result.timeline))
                      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
                  }}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}

      <div
        className="cc-composer-wrap"
        ref={composerWrap}
        data-composer-drop={dragging ? "true" : "false"}
        onDragOver={(event) => {
          // `preventDefault` is what makes this element a drop target at all: without it the browser opens
          // the dropped file and the conversation is gone, which reads as the app having crashed.
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void addFiles([...event.dataTransfer.files]);
        }}
        onPaste={(event) => {
          const pasted = [...event.clipboardData.files];
          // Text paste stays the browser's business; only a file is intercepted.
          if (pasted.length === 0) return;
          event.preventDefault();
          void addFiles(pasted);
        }}
      >
        {/* The ring, drawn under the composer so the light travels around its edge rather than across it. */}
        <div className="cc-composer-shell">
          <span className="cc-composer-glow" aria-hidden="true" />
          {chips.length === 0 ? null : (
            <ul className="cc-chip-row" data-attachment-chips="true">
              {chips.map((chip) => (
                <li
                  key={chip.id}
                  className="cc-chip"
                  data-attachment-chip={chip.filename}
                  data-attachment-state={chip.state}
                >
                  <span className="cc-chip-name">{chip.filename}</span>
                  <span className="cc-chip-size">{formatFileSize(chip.sizeBytes)}</span>
                  {/* The node's own sentence, shown where the file is: a refusal the person cannot read is
                      indistinguishable from a click that did nothing. */}
                  {chip.state === "failed" ? <span className="cc-chip-reason">{chip.reason}</span> : null}
                  <button
                    type="button"
                    className="cc-chip-remove"
                    aria-label={`Bỏ ${chip.filename}`}
                    data-attachment-remove={chip.id}
                    onClick={() => dispatchChips({ type: "remove", id: chip.id })}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="cc-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send(draft);
            }}
          >
            <input
              ref={attachmentInput}
              type="file"
              multiple
              hidden
              data-attachment-input="true"
              onChange={(event) => {
                const chosen = [...(event.target.files ?? [])];
                // Cleared so choosing the same file twice in a row still fires a change event, which is what
                // a person does after removing a chip by mistake.
                event.target.value = "";
                void addFiles(chosen);
              }}
            />
            <button
              type="button"
              className="cc-icon-btn"
              aria-label="Đính kèm"
              title="Đính kèm tệp"
              data-attachment-open="true"
              onClick={() => attachmentInput.current?.click()}
            >
              +
            </button>
            <textarea
              ref={composerInput}
              value={draft}
              aria-label="Nhập tin nhắn"
              // The typed placeholder, and the plain one as soon as there is nothing to type — which
              // is also what a reduced-motion user sees, unchanged.
              placeholder={placeholder === "" ? "Message anything…" : placeholder}
              rows={1}
              data-composer="true"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send(draft);
                }
              }}
            />
            <button
              type="button"
              className="cc-icon-btn"
              aria-label="Nói bằng giọng nói"
              title="Nói bằng giọng nói"
              data-voice-open="true"
              onClick={() => setVoiceOpen(true)}
            >
              ◉
            </button>
            <button type="submit" className="cc-icon-btn" aria-label="Gửi" disabled={busy || draft.trim() === ""} data-send="true">
              ↑
            </button>
          </form>
        </div>
        {/*
          A statusline, not a motto.

          This line used to hold a slogan and a keyboard hint, in the one place a harness reports itself: what
          the session has spent, how full its context is, how much came back from the cache, what it has cost.
          The numbers are the newest turn's, so a turn that reported nothing cannot wipe what the last real
          one said.
        */}
        <div className="cc-hint" data-statusline={error === undefined ? "true" : "false"}>
          {error === undefined ? (
            statuslineParts({ metrics: latestTurnMetrics(timeline?.messages ?? []) }).map((part) => (
              <span key={part} className="cc-statusline-part">
                {part}
              </span>
            ))
          ) : (
            <span>{error}</span>
          )}
        </div>
      </div>
      </div>

      {/*
        The one orb. It is not two elements that swap places with a transition between them: it is a
        single canvas that moves, which is what makes the move look like one, and what keeps the
        shader's own animation continuous across the change of screen.
      */}
      {orbPlacement !== undefined && (
        <div className="cc-orb-stage">
          <div
            className="cc-stage-orb"
            data-docked={orbPlacement.docked ? "true" : "false"}
            style={{
              left: `${orbPlacement.x}px`,
              top: `${orbPlacement.y}px`,
              transform: `translate(-50%, -50%) scale(${orbPlacement.scale})`,
            }}
          >
            <Orb
              size={ORB_DRAW_SIZE}
              radius={ORB_RADIUS}
              className="cc-empty-orb"
              label="Đang chờ bạn nói điều muốn làm"
              // The canvas is 960 across. At two device pixels per CSS pixel that is nearly four million
              // fragments a frame for a soft glow, so it is drawn at a lower ratio than the small orbs,
              // where the difference is actually visible.
              maxPixelRatio={1.25}
              pointerTarget={shell}
              {...(orbProfile === undefined ? {} : { profile: orbProfile })}
            />
          </div>
        </div>
      )}

      <SettingsPanel
        open={uiCheckOpen}
        onClose={() => setUiCheckOpen(false)}
        client={client}
        themeChoice={themeChoice}
        resolvedTheme={resolvedTheme}
        onThemeChoice={applyThemeChoice}
      />

      {/*
        Voice, as its own screen over the conversation. Both ways out of it stop the session — a closed
        surface may not keep a microphone open — and the only difference between them is where the caret
        goes afterwards.
      */}
      {/*
        What a highlighted passage can be turned into.

        Beside the transcript rather than inside it, and beside the voice screen rather than within it: a selection
        belongs to the text on screen, not to whichever surface happens to be open over it.
      */}
      <SelectionToolbar
        container={scroller}
        onAttach={(text) => setDraft((current) => attachedPrompt(text, current))}
        onExplain={(text) => void send(explainPrompt(text))}
        // Offered only once there is a conversation to attach background work to, and the handler refuses quietly when
        // there is none rather than sending a request the node would answer 400 to.
        canBackground={conversationId !== undefined}
        onBackground={async (text) => {
          if (conversationId === undefined) return;
          await client.startBackground({ conversationId, text });
        }}
      />

      {voiceOpen && (
        <VoiceOverlay
          client={client}
          {...(conversationId === undefined ? {} : { conversationId })}
          onAnswered={refreshTimeline}
          onProgress={scheduleVoiceRefresh}
          onClose={({ focusComposer }) => {
            setVoiceOpen(false);
            if (focusComposer) composerInput.current?.focus();
          }}
        />
      )}
    </div>
  );
}

/**
 * Read a motion duration off the document, in milliseconds.
 *
 * Timings belong to the stylesheet, and so does the reduced-motion override: reading the value back
 * means an animation this file drives lasts exactly as long as the one the stylesheet would have run.
 * A second copy of `600` in the TypeScript is how the two come apart, and the symptom is an element
 * that finishes moving before its own fade does.
 */
function motionDurationMs(variable: string, fallbackMs: number): number {
  if (typeof getComputedStyle !== "function") return fallbackMs;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallbackMs;
  return raw.endsWith("ms") ? value : value * 1000;
}

/** The shared easing curve, by the same argument as the durations above. */
function motionEasing(): string {
  if (typeof getComputedStyle !== "function") return "ease";
  return getComputedStyle(document.documentElement).getPropertyValue("--cc-motion-easing").trim() || "ease";
}

/**
 * Every block in a timeline, flattened.
 *
 * A small helper rather than two nested loops in each caller: the composition effect and the
 * dataset effect both need the same walk, and writing it twice is how the two drift into
 * disagreeing about which blocks count.
 */
function blocksOf(timeline: Timeline | undefined): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const message of timeline?.messages ?? []) {
    for (const block of message.blocks ?? []) blocks.push(block);
  }
  return blocks;
}

/**
 * Turn a captured bundle into what the surface renders.
 *
 * Nothing here reaches the live rows. A region with no materialised rows is reported as `missing`
 * rather than filled from the current dataset, which is the difference between history and a view
 * that quietly rewrites itself. `actions` is deliberately empty: a snapshot declares the bindings
 * that existed when it was taken, and the read-only route that produced this data does not carry
 * them, so a historical surface cannot mutate anything even if a client tried.
 */
function toSurfaceViewFromSnapshot(
  captured: SnapshotPresentationResponse,
  revision: number,
): CompositeSurfaceView {
  const materialised = new Map(captured.sections.map((section) => [section.sectionId, section]));
  const availability: Record<string, "live" | "missing"> = {};
  const sections = captured.sections.map((section) => {
    const rows = materialised.get(section.sectionId)?.rows;
    // A region that declares no data reference needs none — a period selector and a save button are
    // complete on their own. Marking those "missing" because they carry no rows drew an empty card
    // where a working control belongs.
    availability[section.sectionId] = section.dataRefs.length === 0 || rows !== undefined ? "live" : "missing";
    return {
      sectionId: section.sectionId,
      slot: section.slot as CompositeSurfaceView["sections"][number]["slot"],
      definitionRef: section.definitionRef,
      props: section.props,
      dataRefs: section.dataRefs,
      ...(rows === undefined ? {} : { rows }),
      textAlternative: section.textAlternative,
    };
  });

  const spec = captured.spec;
  return {
    compositionId: spec?.compositionId ?? "",
    instanceId: spec?.instanceId ?? captured.snapshot.instanceId ?? "",
    catalogDigest: captured.catalogDigest ?? "",
    // The period a snapshot was captured at is the period it shows. A later filter change belongs
    // to the live instance, not to this message.
    initialState: spec?.initialState ?? { period: "week", timezone: "UTC" },
    actions: [],
    sections,
    revision,
    ...(typeof captured.snapshot.capturedAt === "string" ? { capturedAt: captured.snapshot.capturedAt } : {}),
    stale: captured.snapshot.stale === true,
    tombstone: captured.tombstone,
    availability,
    // A snapshot is history: it never acts, whatever it recorded when it was taken.
    readOnly: true,
  };
}

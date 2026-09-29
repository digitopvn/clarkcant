import { type KeyboardEvent, type ReactElement, type ReactNode, useId, useMemo, useRef, useState } from "react";

import { type CompositionSlot, type LayoutContainerNode, type LayoutNode, describeLayout, orderSections } from "@clarkcant/contracts";

import { type RendererDataset, resolveRenderer } from "./renderers.tsx";
import { useT } from "./i18n/locale-context.tsx";
import type { MessageKey } from "./i18n/messages.ts";

/**
 * The composed surface container.
 *
 * One instance, several leaf regions. The container's whole job is to place them: it resolves no
 * data, owns no action and knows nothing about a model. Each region is an ordinary catalog
 * renderer receiving the props and rows the host materialised for it, which is what keeps "rich
 * widget" and "layout" from becoming the same thing.
 *
 * Four states are distinguished per region rather than collapsed into an empty box, because they
 * mean different things to a reader:
 *
 * - `live` / `cached` — data is present, with its freshness shown.
 * - `missing` — there is genuinely nothing here, with the affordance that creates something.
 * - `denied` — this principal may not see it.
 * - `error` — the read failed, and the failure is named.
 */

export type RegionAvailability = "live" | "cached" | "missing" | "denied" | "error" | "loading";

export interface CompositeSurfaceSection {
  sectionId: string;
  slot: CompositionSlot;
  definitionRef: { id: string; version: string; digest: string };
  props: Record<string, unknown>;
  dataRefs: string[];
  /** Materialised rows for a snapshot render. Absent for a live render resolved from `dataRefs`. */
  rows?: Record<string, unknown>[];
  textAlternative: string;
}

export interface CompositeSurfaceAction {
  actionBindingId: string;
  sectionId: string;
  label: string;
  kind: "view" | "invoke" | "agent" | "workflow";
  effectCategory: string;
}

export interface CompositeSurfaceView {
  compositionId: string;
  instanceId: string;
  catalogDigest: string;
  initialState: { period: "week" | "month"; selectedDate?: string; timezone: string };
  actions: CompositeSurfaceAction[];
  sections: CompositeSurfaceSection[];
  revision: number;
  /** When the snapshot was taken, so history is labelled as history rather than as current. */
  capturedAt?: string;
  /** True when the live instance has moved past the revision this view was captured at. */
  stale?: boolean;
  /** Set when the stored bundle was removed; the reason replaces the data. */
  tombstone?: { reason: string } | null;
  /** Per-region availability supplied by the transport. */
  availability?: Record<string, RegionAvailability>;
  /**
   * Where each region goes, when the surface was arranged as a tree rather than from a template. Its leaves name
   * sections by id; without it the regions are laid out in slot order.
   */
  layout?: LayoutNode;
  /**
   * Set when this surface may not act.
   *
   * A historical snapshot and a surface another tab owns are both in this state. The leaves are told
   * so rather than being handed an action callback that resolves to nothing: a control that looks
   * live and does nothing is worse than one that says it is read-only.
   */
  readOnly?: boolean;
}

export interface SurfaceIntent {
  sectionId: string;
  action: string;
  input: Record<string, unknown>;
}

export interface MiniAppSurfaceProps {
  view: CompositeSurfaceView;
  title?: string | undefined;
  /** Every leaf interaction reports here. The container performs no effect itself. */
  onIntent?: ((intent: SurfaceIntent) => void) | undefined;
  /** Resolves an imported image reference to a fetchable URL. */
  imageUrl?: ((imageRef: string) => string | undefined) | undefined;
  /** Set while a change is in flight, so a control can be disabled rather than double-submitted. */
  busy?: boolean | undefined;
}

const AVAILABILITY_TEXT_KEY: Record<RegionAvailability, MessageKey | undefined> = {
  live: undefined,
  cached: undefined,
  missing: "widgets.surface.regionMissing",
  denied: "widgets.surface.regionDenied",
  error: "widgets.surface.regionError",
  loading: "widgets.surface.regionLoading",
};

function regionDataset(section: CompositeSurfaceSection, availability: RegionAvailability): RendererDataset | undefined {
  if (availability === "missing" || availability === "denied" || availability === "error" || availability === "loading") {
    // No rows is the honest answer for every non-live state: passing the last known rows with a
    // failed read would show stale numbers as if they were current.
    return undefined;
  }
  if (section.rows === undefined) return undefined;
  return { rows: section.rows, freshness: availability === "cached" ? "cached" : "live", updatedAt: "" };
}

export function MiniAppSurface(props: MiniAppSurfaceProps): ReactElement {
  const t = useT();
  const { view, onIntent, busy } = props;
  const [state, setState] = useState<Record<string, Record<string, unknown>>>({});
  const sections = useMemo(() => orderSections(view.sections), [view.sections]);
  const readOnly = view.readOnly === true;
  const sectionById = useMemo(() => new Map(view.sections.map((section) => [section.sectionId, section])), [view.sections]);

  const actionBySection = useMemo(() => {
    const map = new Map<string, CompositeSurfaceAction>();
    for (const action of view.actions) map.set(action.sectionId, action);
    return map;
  }, [view.actions]);

  const emit = (sectionId: string, action: string, input: Record<string, unknown>): void => {
    onIntent?.({ sectionId, action, input });
  };

  if (view.tombstone != null) {
    return (
      <figure className="cc-card cc-surface" data-surface-instance={view.instanceId} data-surface-tombstone="true">
        <figcaption className="cc-card-head">
          <span className="cc-card-title">{props.title ?? t("widgets.surface.overviewTitle")}</span>
          <span className="cc-freshness">{t("widgets.surface.snapshotDeleted")}</span>
        </figcaption>
        <div className="cc-card-body">
          <p className="cc-freshness" style={{ margin: 0 }} data-tombstone-reason={view.tombstone.reason}>
            {t("widgets.surface.tombstoneReason").replace("{reason}", view.tombstone.reason)}
          </p>
          <ul className="cc-surface-alt">
            {sections.map((section) => (
              <li key={section.sectionId}>{section.textAlternative}</li>
            ))}
          </ul>
        </div>
      </figure>
    );
  }

  return (
    <figure className="cc-card cc-surface" data-surface-instance={view.instanceId} data-surface-composition={view.compositionId}>
      <figcaption className="cc-card-head">
        <span className="cc-card-title">{props.title ?? t("widgets.surface.overviewTitle")}</span>
        <span className="cc-freshness" data-surface-captured-at={view.capturedAt ?? ""}>
          {view.capturedAt === undefined ? "" : t("widgets.surface.capturedAt").replace("{at}", view.capturedAt)}
          {view.stale === true ? t("widgets.surface.staleSuffix") : ""}
        </span>
      </figcaption>
      <div className="cc-card-body">
        {view.layout === undefined ? (
          <div className="cc-surface-grid" role="group" aria-label={t("widgets.surface.regionsAria")}>
            {sections.map(region)}
          </div>
        ) : (
          <div className="cc-layout" role="group" aria-label={t("widgets.surface.regionsAria")} data-layout-root="true">
            <LayoutTree node={view.layout} sections={sectionById} region={region} />
          </div>
        )}
      </div>
    </figure>
  );

  function region(section: CompositeSurfaceSection): ReactElement {
    const availability = view.availability?.[section.sectionId] ?? (section.rows === undefined ? "missing" : "live");
    const Renderer = resolveRenderer(section.definitionRef.id);
    const availabilityKey = AVAILABILITY_TEXT_KEY[availability];
    const message = availabilityKey === undefined ? undefined : t(availabilityKey);
    const action = actionBySection.get(section.sectionId);
    const sectionState: Record<string, unknown> = {
      period: view.initialState.period,
      ...(view.initialState.selectedDate === undefined ? {} : { selectedDate: view.initialState.selectedDate }),
      ...(busy === true ? { pending: true } : {}),
      ...(state[section.sectionId] ?? {}),
    };

    return (
      <section
        key={section.sectionId}
        className="cc-surface-region"
        data-slot={section.slot}
        data-section-id={section.sectionId}
        data-availability={availability}
        aria-busy={availability === "loading"}
      >
        {message !== undefined ? (
          <>
            <p className="cc-freshness" data-region-state={availability} style={{ margin: 0 }}>
              {message}
            </p>
            <details className="cc-text-alt">
              <summary>{t("widgets.surface.regionDescription")}</summary>
              <p>{section.textAlternative}</p>
            </details>
            {availability === "missing" && section.slot === "calendar" && (
              <p className="cc-freshness" style={{ margin: 0 }}>
                {t("widgets.surface.calendarMissingHint")}
              </p>
            )}
            {availability === "missing" && section.slot === "image" && (
              <p className="cc-freshness" style={{ margin: 0 }}>
                {t("widgets.surface.imageMissingHint")}
              </p>
            )}
          </>
        ) : Renderer === undefined ? (
          // An unknown renderer is a normal outcome: the definition was pinned, but this
          // client does not ship it. The text alternative is what history keeps.
          <p className="cc-freshness" data-region-state="unrenderable" style={{ margin: 0 }}>
            {section.textAlternative}
          </p>
        ) : (
          <Renderer
            definitionId={section.definitionRef.id}
            props={section.props}
            dataset={regionDataset(section, availability)}
            state={sectionState}
            {...(props.imageUrl === undefined ? {} : { imageUrl: props.imageUrl })}
            // Local view state stays interactive everywhere: which day is selected and which
            // period is on screen are presentation, not a change to the node. Only the action
            // channel is gated, because that is the one that would reach the server.
            onStateChange={(patch: Record<string, unknown>) => {
              setState((current) => ({
                ...current,
                [section.sectionId]: { ...(current[section.sectionId] ?? {}), ...patch },
              }));
            }}
            {...(readOnly
              ? {}
              : {
                  onAction: (action: string, payload: Record<string, unknown>) => {
                    emit(section.sectionId, action, payload);
                  },
                })}
          />
        )}
        {action !== undefined && availability !== "denied" && (
          <span className="cc-freshness" data-section-action={action.actionBindingId}>
            {t("widgets.surface.availableAction").replace("{label}", action.label)}
          </span>
        )}
      </section>
    );
  }
}

interface LayoutTreeProps {
  node: LayoutNode;
  sections: ReadonlyMap<string, CompositeSurfaceSection>;
  region: (section: CompositeSurfaceSection) => ReactElement;
}

/**
 * A surface arranged as a tree.
 *
 * Only arrangement happens here. Every leaf is drawn by the same region the template layout uses, so a
 * widget inside a card inside a tab has the same states, the same text alternative and the same action
 * channel as one in the plain grid. A container kind this client does not know is drawn as the text the
 * tree says for it, not dropped.
 */
function LayoutTree(props: LayoutTreeProps): ReactElement | null {
  const { node, sections, region } = props;
  if (node.kind === "divider") return <hr className="cc-layout-divider" data-layout="divider" />;
  if (node.kind === "widget") {
    const section = sections.get(node.sectionId);
    if (section === undefined) return null;
    return (
      <div className="cc-layout-leaf" data-layout="widget">
        {node.label === undefined ? null : <span className="cc-layout-label">{node.label}</span>}
        {region(section)}
      </div>
    );
  }

  const children = (container: LayoutContainerNode): ReactNode[] =>
    container.children.map((child, index) => <LayoutTree key={index} node={child} sections={sections} region={region} />);
  const heading = node.label === undefined ? null : <span className="cc-layout-label">{node.label}</span>;

  switch (node.kind) {
    case "stack":
    case "row":
    case "split":
      return (
        <div className={`cc-layout-${node.kind}`} data-layout={node.kind} data-layout-label={node.label}>
          {heading}
          <div className={`cc-layout-${node.kind}-body`}>{children(node)}</div>
        </div>
      );
    case "grid":
      return (
        <div className="cc-layout-grid" data-layout="grid" data-layout-columns={node.columns ?? 2} data-layout-label={node.label}>
          {heading}
          <div className="cc-layout-grid-body" style={{ ["--cc-layout-columns" as string]: String(node.columns ?? 2) }}>
            {children(node)}
          </div>
        </div>
      );
    case "card":
      return (
        <section className="cc-layout-card" data-layout="card" data-layout-label={node.label} aria-label={node.label}>
          {node.label === undefined ? null : <h4 className="cc-layout-card-title">{node.label}</h4>}
          <div className="cc-layout-stack-body">{children(node)}</div>
        </section>
      );
    case "tabs":
      return <LayoutTabs node={node} sections={sections} region={region} />;
    case "collapsible":
      return (
        <LayoutCollapsible label={node.label ?? ""} open={node.open === true}>
          {children(node)}
        </LayoutCollapsible>
      );
    default: {
      const textOf = (sectionId: string): string => sections.get(sectionId)?.textAlternative ?? "";
      return (
        <p className="cc-freshness" data-layout-fallback="true" style={{ margin: 0 }}>
          {describeLayout(node, textOf)}
        </p>
      );
    }
  }
}

/** The label a tab shows: its own, or the label of the node it holds. */
function tabLabel(node: LayoutNode): string {
  return node.kind === "divider" ? "" : (node.label ?? "");
}

/**
 * Tabs, following the WAI-ARIA tabs pattern.
 *
 * One stop in the tab order for the strip, arrows and Home/End move between tabs, and selection follows
 * focus. Hidden panels stay mounted so a table's sort or a chart's hover survives switching away and back.
 */
function LayoutTabs(props: LayoutTreeProps & { node: LayoutContainerNode }): ReactElement {
  const { node, sections, region } = props;
  const [selected, setSelected] = useState(0);
  const base = useId();
  const strip = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const last = node.children.length - 1;
    const next =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setSelected(next);
    strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div className="cc-layout-tabs" data-layout="tabs" data-layout-label={node.label}>
      <div className="cc-layout-tablist" role="tablist" aria-label={node.label} ref={strip}>
        {node.children.map((child, index) => (
          <button
            key={index}
            type="button"
            role="tab"
            className="cc-tab"
            id={`${base}-tab-${String(index)}`}
            aria-selected={selected === index}
            aria-controls={`${base}-panel-${String(index)}`}
            data-selected={selected === index}
            tabIndex={selected === index ? 0 : -1}
            onClick={() => setSelected(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {tabLabel(child)}
          </button>
        ))}
      </div>
      {node.children.map((child, index) => (
        <div
          key={index}
          role="tabpanel"
          className="cc-layout-tabpanel"
          id={`${base}-panel-${String(index)}`}
          aria-labelledby={`${base}-tab-${String(index)}`}
          hidden={selected !== index}
          tabIndex={0}
        >
          {/* The tab already says the leaf's label, so the panel does not repeat it. */}
          <LayoutTree node={child.kind === "widget" ? { kind: "widget", sectionId: child.sectionId } : child} sections={sections} region={region} />
        </div>
      ))}
    </div>
  );
}

/** A section that starts open or closed, as the tree says, and then belongs to the reader. */
function LayoutCollapsible(props: { label: string; open: boolean; children: ReactNode }): ReactElement {
  const [open, setOpen] = useState(props.open);
  return (
    <details
      className="cc-layout-collapsible"
      data-layout="collapsible"
      data-layout-label={props.label}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cc-layout-summary">{props.label}</summary>
      <div className="cc-layout-stack-body">{props.children}</div>
    </details>
  );
}
/** Sections whose data could not be resolved, for a caller that wants to say what is missing. */
export function unavailableSections(view: CompositeSurfaceView): string[] {
  return view.sections
    .filter((section) => (view.availability?.[section.sectionId] ?? "live") !== "live" && (view.availability?.[section.sectionId] ?? "live") !== "cached")
    .map((section) => section.slot);
}

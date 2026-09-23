import { type ReactElement, useMemo, useState } from "react";

import { type CompositionSlot, orderSections } from "@clarkcant/contracts";

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
        <div className="cc-surface-grid" role="group" aria-label={t("widgets.surface.regionsAria")}>
          {sections.map((section) => {
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
          })}
        </div>
      </div>
    </figure>
  );
}

/** Sections whose data could not be resolved, for a caller that wants to say what is missing. */
export function unavailableSections(view: CompositeSurfaceView): string[] {
  return view.sections
    .filter((section) => (view.availability?.[section.sectionId] ?? "live") !== "live" && (view.availability?.[section.sectionId] ?? "live") !== "cached")
    .map((section) => section.slot);
}

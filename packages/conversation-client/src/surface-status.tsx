import { type ReactElement, type ReactNode, useState } from "react";

import {
  type LivePoliteness,
  SURFACE_PHASE_TONE,
  type StatusTone,
  type SurfacePhase,
  surfaceAnnouncement,
} from "@clarkcant/contracts";

/**
 * How a miniapp draws a phase from the shared status contract (`packages/contracts/src/surface-status.ts`).
 *
 * Two pieces, used together by every host card that has a state:
 *
 * - `PhaseBadge` — the state in the card's own words, with a mark and a tone, so it is never told by colour alone.
 *   A plain function of its props, so a card stays callable outside React.
 * - `LiveNote` — what changed because of something that just happened (a press answered, a stop confirmed), in a live
 *   region that announces a change of phase once and stays quiet for what was already on screen when it mounted.
 */

/**
 * The `data-*` markers a card already publishes on the element, passed straight through. Taken as attributes rather
 * than one object so a test that walks the card's element tree finds them on the element the card returns.
 */
export type DataMarkers = { [marker: `data-${string}`]: string | number | boolean | undefined };

/** The badge classes the stylesheet draws, for each tone the contract names. */
const BADGE_TONE: Record<StatusTone, string> = {
  neutral: "",
  info: "info",
  success: "ok",
  warning: "warn",
  danger: "danger",
};

/** The stylesheet's tone for a phase. */
export function phaseBadgeTone(phase: SurfacePhase): string {
  return BADGE_TONE[SURFACE_PHASE_TONE[phase]];
}

/**
 * The phase a domain state reads as, or `undefined` for a state this build does not know (a newer node's). Unknown is
 * never guessed into a phase: a guess is how an unfamiliar state comes to be drawn as a success.
 */
export function phaseOf<T extends string>(table: Readonly<Record<T, SurfacePhase>>, state: string): SurfacePhase | undefined {
  return Object.hasOwn(table, state) ? table[state as T] : undefined;
}

/**
 * A state, in words, with the mark and tone its phase has on every card.
 *
 * The words are the card's own — "đang làm", "needs sign-in" — because the domain says it best; the phase only decides
 * how it looks. The mark is drawn by the stylesheet (`styles/cards.ts`) and is hidden from assistive technology: the words already say it. A state with no known phase is
 * drawn plain, with its words and nothing that claims how it went.
 */
export function PhaseBadge({
  phase,
  children,
  ...data
}: {
  phase: SurfacePhase | undefined;
  children: ReactNode;
} & DataMarkers): ReactElement {
  if (phase === undefined) {
    return (
      <span className="cc-badge" data-tone="" data-surface-phase="unknown" {...data}>
        {children}
      </span>
    );
  }
  return (
    <span className="cc-badge" data-tone={phaseBadgeTone(phase)} data-surface-phase={phase} {...data}>
      {children}
    </span>
  );
}


/** Where a live note's text is placed: which region, decided once per phase. */
export interface LivePlacement {
  phase: SurfacePhase | undefined;
  politeness: LivePoliteness;
}

/**
 * Where the note goes after `phase` arrives.
 *
 * The first placement is what the note mounted with. Anything on screen at mount is history — a reload, a scroll back,
 * another tab opening the conversation — and is placed outside every live region, so it is shown and never announced.
 * A later change of phase is placed in the region the contract's policy names; the same phase again keeps its place,
 * so a re-render never moves text into a region and announces it twice.
 */
export function nextLivePlacement(current: LivePlacement | undefined, phase: SurfacePhase | undefined): LivePlacement {
  if (current === undefined) return { phase, politeness: "off" };
  if (current.phase === phase) return current;
  if (phase === undefined) return { phase, politeness: "off" };
  return { phase, politeness: surfaceAnnouncement(current.phase, phase, { restored: false }) };
}

/**
 * A note that says what just happened, announced once.
 *
 * Mount it whether or not there is anything to say yet (`phase` undefined): a live region has to exist before its text
 * changes for a screen reader to hear the change. Both regions are always present and empty when unused, so switching
 * from a polite note to an error is heard as the error.
 *
 * Keep counts, percentages and other ticking figures out of `children`: the note is for changes of phase.
 */
export function LiveNote({
  phase,
  children,
  className = "cc-freshness",
  ...data
}: {
  phase: SurfacePhase | undefined;
  children?: ReactNode;
  className?: string;
} & DataMarkers): ReactElement {
  const [placement, setPlacement] = useState<LivePlacement>(() => nextLivePlacement(undefined, phase));
  // Derived from the previous render, the way React keeps state that follows a prop: set during render, applied before
  // anything is painted.
  const next = nextLivePlacement(placement, phase);
  if (next !== placement) setPlacement(next);

  const note =
    phase === undefined || children === undefined || children === null || children === "" ? null : (
      <p className={className} style={{ margin: 0 }} data-surface-phase={phase} {...data}>
        {children}
      </p>
    );
  return (
    <div className="cc-live-note" data-surface-live={next.politeness}>
      <div role="status" aria-live="polite" aria-atomic="true">
        {next.politeness === "polite" ? note : null}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true">
        {next.politeness === "assertive" ? note : null}
      </div>
      {next.politeness === "off" ? note : null}
    </div>
  );
}

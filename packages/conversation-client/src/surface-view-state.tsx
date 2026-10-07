import {
  createContext,
  useCallback,
  useContext,
  useState,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
} from "react";

/**
 * The view state of a transcript surface that has to outlive the surface's own component.
 *
 * A long transcript mounts only the rows around the screen (`transcript-window.ts`), so a row scrolled far away is
 * unmounted and every `useState` inside it is lost. What a person did to a surface there - a draft half typed into a
 * form or a note, a query in a search box, a fold opened on the steps of a turn - is not something the node keeps, and
 * it must not vanish because the row went out of view and came back.
 *
 * That state lives here instead, for the browser session of one conversation, keyed by the surface's own identity: the
 * message it is in and the block it is, never only the widget instance, because one instance can be drawn by several
 * messages and each drawing has its own view.
 *
 * What does not belong here:
 * - state the node owns (a chart's, calendar's or map's view, a widget's revisioned state) - it is read back from the
 *   node when the surface mounts again;
 * - an isolated frame's state - it is the frame's, and its `ephemeralStateKeys` are allowed to disappear with it;
 * - secrets - a credential typed into a card is never copied out of the component that holds it.
 *
 * Nothing here is persisted or sent anywhere. The store is bounded: past `SURFACE_VIEW_STATE_BUDGET` entries the least
 * recently written goes first.
 */
export const SURFACE_VIEW_STATE_BUDGET = 500;

export interface SurfaceViewStore {
  has: (key: string) => boolean;
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  readonly size: number;
}

export function createSurfaceViewStore(budget = SURFACE_VIEW_STATE_BUDGET): SurfaceViewStore {
  const entries = new Map<string, unknown>();
  return {
    has: (key) => entries.has(key),
    get: (key) => entries.get(key),
    set: (key, value) => {
      // Written last is evicted last: a Map iterates in insertion order, so re-inserting moves the key to the end.
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > Math.max(0, budget)) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    get size() {
      return entries.size;
    },
  };
}

/** Where one slot of one surface is kept in the store. */
export function surfaceViewKey(scope: string, slot: string): string {
  return `${scope}#${slot}`;
}

const SurfaceViewStoreContext = createContext<SurfaceViewStore | undefined>(undefined);
const SurfaceViewScopeContext = createContext<string | undefined>(undefined);

/** The store for one conversation's surfaces. Outside it, `useSurfaceViewState` is plain component state. */
export function SurfaceViewStoreProvider({ store, children }: { store: SurfaceViewStore; children: ReactNode }): ReactElement {
  return <SurfaceViewStoreContext.Provider value={store}>{children}</SurfaceViewStoreContext.Provider>;
}

/**
 * The identity of the surface below: a scope nests inside the one above it, so a section of a composed surface is told
 * apart from its sibling.
 */
export function SurfaceViewScope({ id, children }: { id: string; children: ReactNode }): ReactElement {
  const outer = useContext(SurfaceViewScopeContext);
  return (
    <SurfaceViewScopeContext.Provider value={outer === undefined ? id : `${outer}/${id}`}>{children}</SurfaceViewScopeContext.Provider>
  );
}

/**
 * `useState` for a view value that survives its surface being unmounted and mounted again within the session.
 *
 * `slot` names the value within its surface. Inside a scope under a store the value is read from and written to the
 * store; anywhere else - a pinned surface, which is never virtualized, or a preview - it is ordinary component state.
 */
export function useSurfaceViewState<T>(slot: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const store = useContext(SurfaceViewStoreContext);
  const scope = useContext(SurfaceViewScopeContext);
  const key = store === undefined || scope === undefined ? undefined : surfaceViewKey(scope, slot);
  const [value, setValue] = useState<T>(() => {
    if (key !== undefined && store !== undefined && store.has(key)) return store.get(key) as T;
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      setValue((current) => {
        const resolved = typeof next === "function" ? (next as (previous: T) => T)(current) : next;
        if (key !== undefined && store !== undefined) store.set(key, resolved);
        return resolved;
      });
    },
    [key, store],
  );
  return [value, set];
}

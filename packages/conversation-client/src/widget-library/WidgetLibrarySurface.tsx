import { type ReactElement, useEffect, useRef, useState } from "react";

import type { WidgetCatalogEntry } from "@clarkcant/widget-catalog";
import { libraryEntries } from "@clarkcant/widget-catalog";
import {
  applyPreviewAction,
  initialPreviewState,
  type PreviewAction,
  type PreviewState,
  viewportWidth,
} from "@clarkcant/widget-catalog";

import type { GatewayClient } from "../api.ts";
import { BUILT_IN_LABEL } from "../package-provenance.ts";
import { resolveRenderer } from "../renderers.tsx";
import { InstalledProvenance } from "./InstalledProvenance.tsx";
import { installedCatalogEntries, type InstalledEntriesRead } from "./installed-entries.ts";
import { WidgetFixtureControls } from "./WidgetFixtureControls.tsx";
import { WidgetGallery } from "./WidgetGallery.tsx";
import { WidgetInspector } from "./WidgetInspector.tsx";
import { WidgetPreview } from "./WidgetPreview.tsx";
import { WidgetPropsForm } from "./WidgetPropsForm.tsx";
import { fixtureById, fixtureIds, inspectorPanels, themeAttributeFor } from "./widget-lab.ts";
import {
  familyFacets,
  selectedEntry,
  visibleEntries,
  type WidgetLibraryAction,
  type WidgetLibraryState,
} from "./widget-library-state.ts";

/**
 * The Widget Library, as a full-screen utility surface over the conversation.
 *
 * Four things about it are deliberate:
 *
 * **It is a sibling of the conversation, never a replacement.** The transcript stays mounted
 * underneath, which is what keeps pins, live-effect ownership, media and voice untouched while
 * somebody browses the catalogue.
 *
 * **It is the only dialog that is open.** Its main entry is Settings → Extensions, and `Modal`
 * registers a document-level Escape handler with no notion of nesting, so opening this on top of
 * Settings would make one Escape close both and would leave Tab trapped in the dialog behind. The
 * settings panel therefore closes itself before this opens.
 *
 * **Escape closes the nearest thing.** With a widget open, Escape goes back to the grid; only from
 * the grid does it close the surface.
 *
 * **The preview controls are real.** The fixture and props select what the production renderer
 * receives, the viewport sets the preview frame's width, and theme and reduced motion set scoped
 * attributes on the preview subtree - so the control changes what is drawn rather than only its own
 * label.
 */

export interface WidgetLibrarySurfaceProps {
  state: WidgetLibraryState;
  /** Defaults to the shipping catalog; injectable so a test can drive a smaller one. */
  entries?: readonly WidgetCatalogEntry[];
  /**
   * Omitted by tests that only exercise the built-in catalog. When present, the browse view also
   * reports what this node has installed - as provenance, not as catalog entries.
   */
  client?: GatewayClient;
  onAction: (action: WidgetLibraryAction) => void;
}

export function WidgetLibrarySurface({
  state,
  entries = libraryEntries(),
  client,
  onAction,
}: WidgetLibrarySurfaceProps): ReactElement | null {
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const open = state.open;

  const [preview, setPreview] = useState<PreviewState>(() => initialPreviewState([]));
  const [propsOverride, setPropsOverride] = useState<Record<string, unknown> | undefined>(undefined);
  const [showInspector, setShowInspector] = useState(false);

  /*
   * What this node has installed, read when the surface opens rather than when it mounts: a library nobody has
   * opened should not be asking the node questions, and the answer only matters while the surface is up.
   */
  const [installed, setInstalled] = useState<InstalledEntriesRead>({ entries: [], notes: [] });

  useEffect(() => {
    if (!open || client === undefined) return;
    let cancelled = false;
    void client
      .packageWidgets()
      .then((answer) => {
        if (cancelled) return;
        setInstalled(
          installedCatalogEntries({
            packages: answer.packages,
            known: entries,
            canRender: (definitionId) => resolveRenderer(definitionId) !== undefined,
          }),
        );
      })
      .catch(() => {
        if (cancelled) return;
        // Named as unread rather than shown as an empty list, which would say "no package declares a widget here".
        setInstalled({
          entries: [],
          notes: [
            {
              packageId: "node",
              message: "Không đọc được widget của các gói đã cài. Danh mục dựng sẵn vẫn dùng được bình thường.",
            },
          ],
        });
      });
    return () => {
      cancelled = true;
    };
  }, [open, client, entries]);

  // The catalog's own entries come first, so a definition the catalog already provides is the one that shows.
  const allEntries = [...entries, ...installed.entries];
  const selected = selectedEntry(allEntries, state);
  const selectedId = selected?.definition.id;

  // A new widget starts from its own first fixture rather than inheriting the previous widget's
  // fixture id, which would silently select nothing.
  useEffect(() => {
    if (selected === undefined) return;
    setPreview(initialPreviewState(fixtureIds(selected)));
    setPropsOverride(undefined);
    setShowInspector(false);
  }, [selectedId, selected]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    opener.current = document.activeElement;
    dialog.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      // The control that opened this may have been the Browse button inside Settings, which closed
      // itself to let this surface be the only dialog. When that element is gone, focus goes to a
      // stable anchor rather than being dropped on the body.
      const previous = opener.current;
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus();
      else document.querySelector<HTMLElement>("[data-widget-library-anchor]")?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      // Escape unwinds one step: detail back to grid, grid closes the surface.
      onAction(state.selectedId === undefined ? { kind: "close" } : { kind: "back" });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, state.selectedId, onAction]);

  if (!open) return null;

  const visible = visibleEntries(allEntries, state);
  const facets = familyFacets(allEntries);
  const fixture = selected === undefined ? undefined : fixtureById(selected, preview.fixture) ?? selected.fixtures[0];
  const effectiveFixture =
    fixture === undefined
      ? undefined
      : propsOverride === undefined
        ? fixture
        : { ...fixture, props: propsOverride };
  const develop = state.mode === "develop";
  const themeAttribute = themeAttributeFor(preview.theme);

  return (
    <>
      <div className="cc-widget-library-scrim" aria-hidden="true" />
      <div
        className="cc-widget-library"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cc-widget-library-title"
        ref={dialog}
        tabIndex={-1}
        data-widget-library="true"
        data-widget-library-mode={state.mode}
      >
        <header className="cc-widget-library-head">
          {selected === undefined ? (
            <h2 id="cc-widget-library-title">
              {develop ? "Widget Lab" : "Widget Library"}
            </h2>
          ) : (
            <div className="cc-widget-library-head-left">
              <button
                type="button"
                className="cc-icon-btn"
                onClick={() => onAction({ kind: "back" })}
                aria-label="Quay lại danh mục"
                data-widget-library-back="true"
              >
                ←
              </button>
              <h2 id="cc-widget-library-title">{selected.displayName}</h2>
            </div>
          )}

          {selected === undefined && (
            <input
              type="search"
              className="cc-widget-library-search"
              placeholder="Tìm widget…"
              aria-label="Tìm widget"
              value={state.query}
              onChange={(event) => onAction({ kind: "query", value: event.target.value })}
              data-widget-library-search="true"
            />
          )}

          {selected !== undefined && develop && (
            <button
              type="button"
              className="cc-badge cc-widget-lab-pane-toggle"
              aria-pressed={showInspector}
              onClick={() => setShowInspector((current) => !current)}
              data-widget-lab-pane-toggle="true"
            >
              {showInspector ? "Xem trước" : "Inspector"}
            </button>
          )}

          <button
            type="button"
            className="cc-icon-btn"
            onClick={() => onAction({ kind: "close" })}
            aria-label="Đóng"
            data-widget-library-close="true"
          >
            ✕
          </button>
        </header>

        {selected === undefined && (
          <nav className="cc-widget-library-facets" aria-label="Nhóm widget">
            {facets.map((family) => (
              <button
                key={family}
                type="button"
                className="cc-widget-library-facet"
                data-selected={state.family === family}
                aria-pressed={state.family === family}
                onClick={() => onAction({ kind: "family", value: family })}
                data-widget-library-facet={family}
              >
                {family === "all" ? "Tất cả" : family}
              </button>
            ))}
          </nav>
        )}

        <div className="cc-widget-library-body">
          {selected === undefined ? (
            <>
              {/*
                The gallery is the built-in catalog and says so. Installed packages are reported below
                it as provenance rather than mixed in: no route exposes an installed package's widget
                definitions, fixtures or renderer, so a grid cell for one would have to invent the
                fields that make a cell work.
              */}
              <section className="cc-library-builtin" data-widget-provenance="built-in">
                <h3>{BUILT_IN_LABEL}</h3>
                <WidgetGallery
                  entries={visible}
                  onSelect={(definitionId) => onAction({ kind: "select", definitionId })}
                />
              </section>
              {/*
                What could not be shown, and why. A shorter list would say "this package declares no widgets" when
                the truth is that this node cannot read it, or that nothing here can draw it.
              */}
              {installed.notes.length > 0 && (
                <section className="cc-library-notes" data-widget-installed-notes="true">
                  <h3>Gói đã cài: phần chưa xem được</h3>
                  <ul>
                    {installed.notes.map((note) => (
                      <li key={`${note.packageId}:${note.message}`} data-widget-installed-note={note.packageId}>
                        <strong>{note.packageId}</strong>: {note.message}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {client !== undefined && <InstalledProvenance client={client} />}
            </>
          ) : (
            <div
              className="cc-widget-detail"
              data-widget-detail={selected.definition.id}
              data-widget-lab-pane={showInspector ? "inspector" : "preview"}
            >
              {develop && (
                <WidgetFixtureControls
                  preview={preview}
                  fixtures={fixtureIds(selected)}
                  onChange={(action: PreviewAction) =>
                    setPreview((current) => applyPreviewAction(current, action, { fixtures: fixtureIds(selected) }))
                  }
                />
              )}

              <div className="cc-widget-detail-preview" data-widget-lab-pane-preview="true">
                {effectiveFixture === undefined ? (
                  <p className="cc-widget-preview-missing" data-widget-preview-missing={selected.definition.id}>
                    Chưa có fixture cho widget này.
                  </p>
                ) : (
                  <div
                    className="cc-widget-preview-frame"
                    data-widget-preview-frame="true"
                    style={{ width: `${viewportWidth(preview.viewport)}px`, maxWidth: "100%" }}
                    {...(themeAttribute === undefined ? {} : { "data-cc-theme": themeAttribute })}
                    data-cc-reduced-motion={preview.reducedMotion ? "true" : "false"}
                  >
                    <WidgetPreview entry={selected} fixture={effectiveFixture} />
                  </div>
                )}

                {!develop && (
                  <dl className="cc-widget-detail-meta">
                    <dt>Nhóm</dt>
                    <dd>{selected.family}</dd>
                    <dt>Mô tả ngữ nghĩa</dt>
                    <dd>{selected.description}</dd>
                    <dt>Nguồn</dt>
                    <dd>{selected.source === "builtin" ? "Built-in" : selected.source}</dd>
                    <dt>Trạng thái</dt>
                    <dd>{selected.status}</dd>
                    <dt>Phương án chữ</dt>
                    <dd>{selected.definition.textFallback}</dd>
                  </dl>
                )}
              </div>

              {develop && (
                <div className="cc-widget-detail-inspector" data-widget-lab-pane-inspector="true">
                  {effectiveFixture !== undefined && (
                    <WidgetPropsForm
                      definition={selected.definition}
                      props={effectiveFixture.props}
                      onChange={(props) => setPropsOverride(props)}
                    />
                  )}
                  <WidgetInspector panels={inspectorPanels(selected, effectiveFixture)} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

import { Component, createElement, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { catalogEntry, libraryEntries, validateProps } from "@clarkcant/widget-catalog";
import { resolveRenderer } from "./renderers.tsx";
import { APP_CSS } from "./styles.ts";
import { appearanceDeclarations, compileAppearance } from "@clarkcant/design-tokens";
import { LocaleProvider } from "./i18n/locale-context.tsx";
import { CATALOGS } from "./i18n/messages.ts";

/** A public document host lends only local view state, never runtime authority. */
export interface PublicWidgetInput {
  definitionId: string;
  version: string;
  props: Record<string, unknown>;
  state?: Record<string, unknown>;
  rows?: Record<string, unknown>[];
  semantic: string;
  locale?: "en" | "vi";
}

export function validatePublicWidget(input: PublicWidgetInput): string | undefined {
  const entry = catalogEntry(input.definitionId);
  if (!entry || entry.definition.version !== input.version || !resolveRenderer(input.definitionId)) return "This widget version is unavailable. The article's text remains available.";
  const validation = validateProps(entry.definition, input.props);
  if (!validation.ok) return validation.problems.join("; ");
  return undefined;
}

export function publicMediaUrl(value: string): string | undefined {
  if (/^\/media\/[a-f0-9-]{36}$/.test(value)) return value;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}

class PublicWidgetBoundary extends Component<{ children: ReactNode; fallback: string }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  override render(): ReactNode { return this.state.failed ? createElement("p", { role: "status" }, this.props.fallback) : this.props.children; }
}

function PublicWidget({ input }: { input: PublicWidgetInput }): ReactNode {
  const [state, setState] = useState(input.state ?? {});
  const error = validatePublicWidget(input);
  const renderer = resolveRenderer(input.definitionId);
  if (error || !renderer) return createElement("p", { role: "status" }, error ?? input.semantic);
  return renderer({ definitionId: input.definitionId, props: input.props, state,
    dataset: { rows: input.rows ?? [], freshness: "cached", updatedAt: "" },
    onStateChange: patch => setState(previous => ({ ...previous, ...patch })),
    imageUrl: publicMediaUrl,
  });
}

export function mountPublicWidget(element: HTMLElement, input: PublicWidgetInput): () => void {
  const shadow = element.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = APP_CSS + "\n:host{display:block;color:inherit;font-family:inherit} .cc-public-widget{min-width:0;overflow:auto}";
  const mount = document.createElement("div"); mount.className = "cc-public-widget";
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const applyAppearance = (): void => {
    const choice = document.documentElement.dataset.theme;
    const scheme = choice === "dark" || (choice !== "light" && dark.matches) ? "dark" : "light";
    for (const [name, value] of Object.entries(appearanceDeclarations(compileAppearance({ scheme, reducedMotion: reduced.matches })))) {
      if (value !== undefined) mount.style.setProperty(name, value);
    }
  };
  applyAppearance();
  const observer = new MutationObserver(applyAppearance);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  dark.addEventListener("change", applyAppearance); reduced.addEventListener("change", applyAppearance);
  shadow.append(style, mount);
  const root = createRoot(mount);
  const locale = input.locale ?? "en";
  const content = createElement(PublicWidgetBoundary, { fallback: input.semantic, children: createElement(PublicWidget, { input }) });
  root.render(createElement(LocaleProvider, { value: { locale, setLocale: () => {}, t: key => key === "widgets.status.stated" ? (locale === "vi" ? "Nội dung bài viết" : "Article content") : CATALOGS[locale][key] }, children: content }));
  return () => { observer.disconnect(); dark.removeEventListener("change", applyAppearance); reduced.removeEventListener("change", applyAppearance); root.unmount(); };
}

export function publicWidgetCatalog(): unknown[] {
  return libraryEntries().map(entry => ({ id: entry.definition.id, version: entry.definition.version, propsSchema: entry.definition.propsSchema, description: entry.definition.semanticDescription }));
}

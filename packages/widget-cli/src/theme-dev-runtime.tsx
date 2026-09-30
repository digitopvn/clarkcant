import { useEffect, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { ThemeLabPreview } from "@clarkcant/conversation-client";

import type { ThemeDevView } from "./theme-dev-host.ts";

function ThemeDevRuntime(): ReactElement {
  const [view, setView] = useState<ThemeDevView>();
  const [selected, setSelected] = useState<string>();
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    let current = true;
    let ticket = 0;
    const reload = async (): Promise<void> => {
      const latest = ++ticket;
      try {
        const response = await fetch("/dev/theme");
        const next = await response.json() as ThemeDevView;
        if (!current || latest !== ticket) return;
        if (!response.ok || next.themes === undefined) { setProblem(next.problem ?? "Theme could not be read; the last preview is kept"); return; }
        setProblem(next.problem);
        // An invalid reload leaves the last checked document available; error text and audits still update.
        setView((kept) => next.themes.length === 0 && kept !== undefined ? { ...next, themes: kept.themes } : next);
      } catch (error) {
        if (current && latest === ticket) setProblem(error instanceof Error ? error.message : String(error));
      }
    };
    void reload();
    const events = new EventSource("/dev/events");
    events.onmessage = () => void reload();
    return () => { current = false; events.close(); };
  }, []);
  const theme = view?.themes.find((candidate) => candidate.themeRef === selected) ?? view?.themes[0];
  return <main style={{ padding: "var(--cc-space-lg)", maxWidth: "1200px", margin: "auto" }}>
    <h1>ClarkCant Theme Lab</h1>
    {view === undefined ? <p role="status">{problem ?? "Reading the theme / Đang đọc chủ đề…"}</p> : <>
      <label>Theme / Chủ đề <select value={theme?.themeRef ?? ""} onChange={(event) => setSelected(event.target.value)}>
        {view.themes.map((candidate) => <option key={candidate.themeRef} value={candidate.themeRef}>{candidate.document.displayName}</option>)}
      </select></label>
      <ThemeLabPreview theme={theme?.document ?? null} themeRef={theme?.themeRef ?? "builtin:clark"} problem={problem} />
      <details><summary>Manifest, assets and conformance / Manifest, tài sản và kiểm tra</summary><pre>{JSON.stringify(view.report, null, 2)}</pre></details>
    </>}
  </main>;
}

const host = typeof document === "undefined" ? null : document.getElementById("cc-theme-dev-root");
if (host !== null) createRoot(host).render(<ThemeDevRuntime />);

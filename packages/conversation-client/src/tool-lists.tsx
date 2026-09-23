import { type ReactElement, useEffect, useState } from "react";

import type { GatewayClient } from "./api.ts";
import { useT } from "./i18n/locale-context.tsx";

interface ToolRow {
  name: string;
  label: string;
  description: string;
}

interface ToolLists {
  self: ToolRow[];
  agent: ToolRow[];
  agentNote?: string;
}

/**
 * What this node can do, and what the agent it drives can do.
 *
 * Two lists because they are two different things, and a reader deciding whether something is possible needs to know
 * which half would do it: a tool the node holds works here, and one the agent holds works in whatever folder the
 * agent was pointed at. The note matters as much as the lists - extension tools depend on pi's own configuration, so
 * showing the built-ins as the whole of the agent's ability would be claiming less than the truth in the one place a
 * person is checking what is possible.
 */
export function ToolLists({ client }: { client: GatewayClient }): ReactElement {
  const t = useT();
  const [lists, setLists] = useState<ToolLists | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    client
      .tools()
      .then((loaded) => {
        if (!cancelled) setLists(loaded as ToolLists);
      })
      .catch(() => {
        if (!cancelled) setProblem(t("widgets.toolLists.readFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [client, t]);

  if (problem !== undefined) return <p className="cc-panel-note">{problem}</p>;
  if (lists === undefined) return <p className="cc-panel-note">{t("widgets.toolLists.loading")}</p>;

  const section = (title: string, rows: ToolRow[], empty: string): ReactElement => (
    <>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="cc-panel-note">{empty}</p>
      ) : (
        <ul className="cc-tool-list" data-tool-list={title}>
          {rows.map((row) => (
            <li key={row.name}>
              <code>{row.name}</code>
              <span> — {row.label}</span>
              <p className="cc-panel-note">{row.description}</p>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  return (
    <>
      {section(t("widgets.toolLists.nodeToolsTitle"), lists.self, t("widgets.toolLists.nodeToolsEmpty"))}
      {section(t("widgets.toolLists.agentToolsTitle"), lists.agent, t("widgets.toolLists.agentToolsEmpty"))}
      {lists.agentNote !== undefined && <p className="cc-panel-note">{lists.agentNote}</p>}
    </>
  );
}

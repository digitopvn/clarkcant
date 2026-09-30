import type { CSSProperties, ReactElement, ReactNode } from "react";

import { AgentAvatar } from "./AgentAvatar.tsx";

/** The actual transcript presentation, shared with the appearance preview; runtime block actions stay with its caller. */
export function TranscriptRow({ role, index, settled, children }: {
  role: string;
  index: number;
  settled: boolean;
  children: ReactNode;
}): ReactElement {
  return <article className="cc-row" data-role={role} style={{
    "--cc-enter-delay": `${Math.min(index, 6) * 60}ms`,
    ...(settled ? { contentVisibility: "auto", containIntrinsicSize: "0 auto 120px" } : {}),
  } as CSSProperties}>
    {role === "assistant" ? <div className="cc-assistant"><AgentAvatar /><div className="cc-assistant-body">{children}</div></div>
      : <div className="cc-bubble" data-bubble="user">{children}</div>}
  </article>;
}

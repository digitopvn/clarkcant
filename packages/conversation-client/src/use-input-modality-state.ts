import { useEffect, useState } from "react";

import { attachInputModality, type InputModality } from "./input-modality.ts";

/**
 * How the user last interacted, as one value the shell publishes as an attribute.
 *
 * Tracked here rather than detected by each component that cares: a listener per component is a
 * listener per component to keep in sync, and the stylesheet would have no single place to read.
 * Only changes are reported, so a pointer crossing the shell is one state write rather than a
 * thousand.
 */
export function useInputModalityState(): InputModality {
  const [modality, setModality] = useState<InputModality>("pointer");

  useEffect(() => {
    // The window rather than the shell: a pointer that has left the shell is still the last thing
    // the user did, and a keyboard event inside a focused control has to be seen too.
    const handle = attachInputModality({ target: window, onChange: setModality });
    return () => handle.dispose();
  }, []);

  return modality;
}

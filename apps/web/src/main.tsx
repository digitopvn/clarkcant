import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Self-hosted rather than fetched from a font CDN: the page's Content Security Policy allows
// fonts only from its own origin, and a local-first app should not need the network to render its
// own interface. The package ships the vietnamese subset, which this UI needs.
import "@fontsource-variable/plus-jakarta-sans";

import { App } from "./App.tsx";

const container = document.getElementById("root");
if (!container) throw new Error("the page has no #root element to mount into");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@signal-console/ui/global.css";
import "@signal-console/ui/utilities.css";
import "./index.css";

import { App } from "./App";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Signal Console: missing #root element in index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

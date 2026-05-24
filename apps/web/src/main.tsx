import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import "@signal-console/ui/global.css";
import "@signal-console/ui/utilities.css";
import "./index.css";

import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Signal Console: missing #root element in index.html");
}

// Module-scoped so StrictMode's double-mount doesn't construct two clients.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // PRD §16: Recent has "no auto-refresh on first load"; pages opt into
      // polling (Live = 30 s). Hooks own refetch cadence.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: 1,
    },
  },
});

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </QueryClientProvider>
  </StrictMode>,
);

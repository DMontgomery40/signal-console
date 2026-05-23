import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { ApiUnreachableBanner } from "../../components/ApiUnreachableBanner";

const API_BASE_URL: string =
  typeof import.meta.env.VITE_API_URL === "string" && import.meta.env.VITE_API_URL.length > 0
    ? import.meta.env.VITE_API_URL
    : "";

type HealthState =
  | { readonly kind: "loading" }
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly error: unknown };

export function RecentPage(): JSX.Element {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" });
  const controllerRef = useRef<AbortController | null>(null);

  function runHealthCheck(): void {
    if (controllerRef.current !== null) {
      controllerRef.current.abort();
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setHealth({ kind: "loading" });
    void (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/v1/health/live`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setHealth(
          res.ok
            ? { kind: "ok" }
            : { kind: "error", error: new Error(`HTTP ${String(res.status)}`) },
        );
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        setHealth({ kind: "error", error: err });
      }
    })();
  }

  useEffect(() => {
    runHealthCheck();
    return () => {
      if (controllerRef.current !== null) {
        controllerRef.current.abort();
      }
    };
  }, []);

  return (
    <section>
      {health.kind === "error" ? <ApiUnreachableBanner error={health.error} /> : null}
      <h2 className="text-text-hi text-lg font-semibold">Recent</h2>
      <p className="mt-3 text-text-md text-sm">Last 24 h of games (list lands in US-024).</p>
      <div className="mt-6 flex items-center gap-6">
        <p className="tabular font-mono text-sm" data-testid="health-status">
          <span className="text-text-lo">API status:</span> {renderHealth(health)}
        </p>
        <button
          type="button"
          onClick={runHealthCheck}
          data-testid="refresh-button"
          className="inline-block border border-accent-yellow px-3 py-1.5 text-sm font-medium text-text-hi transition-colors duration-fast ease-out hover:bg-accent-yellow hover:text-surface-0-from"
        >
          Refresh
        </button>
      </div>
    </section>
  );
}

function renderHealth(state: HealthState): JSX.Element {
  switch (state.kind) {
    case "loading":
      return <span className="text-text-md">checking…</span>;
    case "ok":
      return <span className="text-accent-green">ok</span>;
    case "error":
      return <span className="text-negative">unreachable</span>;
  }
}

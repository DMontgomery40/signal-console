import { useEffect, useState } from "react";
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

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/v1/health/live`, {
          signal: controller.signal,
        });
        setHealth(
          res.ok
            ? { kind: "ok" }
            : { kind: "error", error: new Error(`HTTP ${String(res.status)}`) },
        );
      } catch (err: unknown) {
        setHealth({ kind: "error", error: err });
      }
    })();
    return () => {
      controller.abort();
    };
  }, []);

  return (
    <section>
      {health.kind === "error" ? <ApiUnreachableBanner error={health.error} /> : null}
      <h2 className="text-text-hi text-lg font-semibold">Recent</h2>
      <p className="mt-3 text-text-md text-sm">Last 24 h of games (list lands in US-024).</p>
      <p className="mt-6 tabular font-mono text-sm" data-testid="health-status">
        <span className="text-text-lo">API status:</span> {renderHealth(health)}
      </p>
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

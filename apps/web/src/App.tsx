import { useEffect, useState } from "react";
import type { JSX } from "react";

type HealthStatus = "loading" | "ok" | "error";

const NAV_LINKS: readonly { readonly label: string; readonly href: string }[] = [
  { label: "Recent", href: "/" },
  { label: "Live", href: "/live" },
  { label: "Backtest", href: "/backtest" },
  { label: "Detectors", href: "/detectors" },
  { label: "Settings", href: "/settings" },
];

// Scaffold-stage placeholder: the real router lands in US-024. We mark
// "Recent" active so the design language's nav underline pattern can be
// visually verified at this story.
const ACTIVE_LABEL = "Recent";

// Same-origin by default — dev uses the Vite proxy configured in vite.config.ts;
// production serves UI and API from the same Cloudflare-tunnel origin.
// `VITE_API_URL` is supported as an override so the error-state path can be
// exercised by pointing at an unreachable host (see CLAUDE.md UI verification).
const API_BASE_URL: string =
  typeof import.meta.env.VITE_API_URL === "string" && import.meta.env.VITE_API_URL.length > 0
    ? import.meta.env.VITE_API_URL
    : "";

export function App(): JSX.Element {
  const [health, setHealth] = useState<HealthStatus>("loading");

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/v1/health/live`, {
          signal: controller.signal,
        });
        setHealth(res.ok ? "ok" : "error");
      } catch {
        setHealth("error");
      }
    })();
    return () => {
      controller.abort();
    };
  }, []);

  return (
    <div className="mx-auto max-w-[1440px] px-12 py-10 text-text-md">
      <header className="flex items-baseline justify-between">
        <h1 className="font-sans text-2xl font-semibold text-text-hi">Signal Console</h1>
        <span className="tabular font-mono text-xs text-text-lo">v2 · scaffold</span>
      </header>

      <nav aria-label="Primary" className="mt-8 border-b border-surface-1">
        <ul className="flex gap-8">
          {NAV_LINKS.map((link) => {
            const isActive = link.label === ACTIVE_LABEL;
            return (
              <li key={link.label}>
                <a
                  href={link.href}
                  data-active={isActive ? "true" : "false"}
                  className={
                    isActive
                      ? "inline-block pb-3 text-sm font-medium text-text-hi border-b-2 border-accent-green transition-colors duration-fast ease-out"
                      : "inline-block pb-3 text-sm font-medium text-text-md border-b-2 border-transparent transition-colors duration-fast ease-out hover:text-text-hi hover:bg-surface-2"
                  }
                >
                  {link.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      <main className="mt-12">
        <section>
          <p className="text-text-lo text-sm">
            Read-only, sport-agnostic. Recent / Live / Backtest land in upcoming stories.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-text-hi text-lg font-semibold">API connectivity</h2>
          <p className="mt-3 tabular font-mono text-sm">
            <span className="text-text-lo">target:</span>{" "}
            <span className="text-text-md">{API_BASE_URL}/v1/health/live</span>
          </p>
          <p className="mt-2 tabular font-mono text-sm" data-testid="health-status">
            <span className="text-text-lo">status:</span> {renderHealth(health)}
          </p>
        </section>
      </main>
    </div>
  );
}

function renderHealth(status: HealthStatus): JSX.Element {
  switch (status) {
    case "loading":
      return <span className="text-text-md">checking…</span>;
    case "ok":
      return <span className="text-accent-green">ok</span>;
    case "error":
      return <span className="text-negative">unreachable</span>;
  }
}

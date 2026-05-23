import { useEffect, useState } from "react";
import type { JSX } from "react";

import { ErrorBoundary } from "./components/ErrorBoundary";
import { RecentPage } from "./features/recent/RecentPage";
import { GameDetailPage } from "./features/games/GameDetailPage";
import { LivePage } from "./features/live/LivePage";
import { BacktestPage } from "./features/backtest/BacktestPage";
import { DetectorsPage } from "./features/detectors/DetectorsPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { navigateTo, parseGameId, parseLiveId } from "./router";

interface NavLink {
  readonly label: string;
  readonly href: string;
}

const NAV_LINKS: readonly NavLink[] = [
  { label: "Recent", href: "/" },
  { label: "Live", href: "/live" },
  { label: "Backtest", href: "/backtest" },
  { label: "Detectors", href: "/detectors" },
  { label: "Settings", href: "/settings" },
];

function CrashOnRender(): JSX.Element {
  throw new Error("Forced crash for ErrorBoundary verification");
}

function readPath(): string {
  if (typeof window === "undefined") return "/";
  return window.location.pathname;
}

function activeLabelFor(path: string): string {
  if (path === "/" || path.startsWith("/recent") || path.startsWith("/games")) return "Recent";
  if (path.startsWith("/live")) return "Live";
  if (path.startsWith("/backtest")) return "Backtest";
  if (path.startsWith("/detectors")) return "Detectors";
  if (path.startsWith("/settings")) return "Settings";
  return "";
}

function routeKey(path: string): string {
  if (path.startsWith("/__crash")) return "crash";
  if (path.startsWith("/games/")) return `game:${path}`;
  if (path.startsWith("/live/")) return `live:${path}`;
  if (path === "/live") return "live";
  if (path.startsWith("/backtest")) return "backtest";
  if (path.startsWith("/detectors")) return "detectors";
  if (path.startsWith("/settings")) return "settings";
  return "recent";
}

function routeContent(path: string): JSX.Element {
  const key = routeKey(path);
  if (key === "crash") return <CrashOnRender />;
  if (key.startsWith("game:")) {
    const gameId = parseGameId(path);
    return <GameDetailPage gameId={gameId} />;
  }
  if (key.startsWith("live:")) {
    const gameId = parseLiveId(path);
    return <LivePage gameId={gameId} />;
  }
  switch (key) {
    case "live":
      return <LivePage gameId={null} />;
    case "backtest":
      return <BacktestPage />;
    case "detectors":
      return <DetectorsPage />;
    case "settings":
      return <SettingsPage />;
    default:
      return <RecentPage />;
  }
}

export function App(): JSX.Element {
  const [path, setPath] = useState<string>(readPath());

  useEffect(() => {
    function handlePop(): void {
      setPath(readPath());
    }
    window.addEventListener("popstate", handlePop);
    return () => {
      window.removeEventListener("popstate", handlePop);
    };
  }, []);

  function navigate(event: React.MouseEvent<HTMLAnchorElement>, href: string): void {
    navigateTo(event, href);
  }

  const active = activeLabelFor(path);

  return (
    <div className="mx-auto max-w-[1440px] px-12 py-10 text-text-md">
      <header className="flex items-baseline justify-between">
        <h1 className="font-sans text-2xl font-semibold text-text-hi">Signal Console</h1>
        <span className="tabular font-mono text-xs">
          <span className="text-accent-yellow">v2</span>
          <span className="text-text-lo"> · scaffold</span>
        </span>
      </header>

      <nav aria-label="Primary" className="mt-8 border-b border-surface-1">
        <ul className="flex gap-8">
          {NAV_LINKS.map((link) => {
            const isActive = link.label === active;
            return (
              <li key={link.label}>
                <a
                  href={link.href}
                  data-active={isActive ? "true" : "false"}
                  onClick={(e) => {
                    navigate(e, link.href);
                  }}
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
        <ErrorBoundary key={routeKey(path)}>{routeContent(path)}</ErrorBoundary>
      </main>
    </div>
  );
}

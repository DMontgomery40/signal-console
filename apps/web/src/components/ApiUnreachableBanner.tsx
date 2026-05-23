import type { JSX } from "react";

interface ApiUnreachableBannerProps {
  readonly error?: unknown;
}

export function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof Error) {
    if (error.name === "AbortError") return true;
    if (error.name === "TypeError") return true;
    const msg = error.message.toLowerCase();
    if (msg.includes("failed to fetch")) return true;
    if (msg.includes("networkerror")) return true;
    if (msg.includes("network request failed")) return true;
    if (msg.includes("load failed")) return true;
  }
  return false;
}

export function ApiUnreachableBanner({ error }: ApiUnreachableBannerProps): JSX.Element | null {
  if (error === undefined || !isNetworkError(error)) return null;
  return (
    <div
      role="alert"
      data-testid="api-unreachable-banner"
      className="border-l-2 border-negative bg-surface-1 px-4 py-3 mb-6"
    >
      <p className="tabular font-mono text-sm text-negative">API unreachable — check Settings</p>
    </div>
  );
}

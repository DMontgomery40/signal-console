import type { JSX } from "react";

interface QueryLike {
  readonly isError: boolean;
  readonly error?: unknown;
  readonly refetch: () => unknown;
}

interface QueryErrorBannerProps {
  readonly query: QueryLike;
  readonly label?: string;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Request failed";
}

export function QueryErrorBanner({ query, label }: QueryErrorBannerProps): JSX.Element | null {
  if (!query.isError) return null;
  function handleRetry(): void {
    void query.refetch();
  }
  return (
    <div
      role="alert"
      data-testid="query-error-banner"
      className="border-l-2 border-negative bg-surface-1 px-4 py-3 mb-6 flex items-baseline justify-between gap-6"
    >
      <p className="tabular font-mono text-sm text-negative">
        {label === undefined || label.length === 0 ? "Request failed" : label} ·{" "}
        <span className="text-text-md">{messageOf(query.error)}</span>
      </p>
      <button
        type="button"
        onClick={handleRetry}
        className="text-sm font-medium text-accent-green underline-offset-2 hover:underline focus:underline transition-colors duration-fast ease-out"
      >
        Retry
      </button>
    </div>
  );
}

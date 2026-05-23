import type { JSX, ReactNode } from "react";
import { ErrorBoundary as ReactErrorBoundary } from "react-error-boundary";

interface FallbackProps {
  readonly error: unknown;
  readonly resetErrorBoundary: () => void;
}

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

function FallbackPanel({ error }: FallbackProps): JSX.Element {
  function handleReload(): void {
    window.location.reload();
  }
  return (
    <div role="alert" data-testid="error-fallback" className="bg-surface-1 px-8 py-8 my-8">
      <h2 className="text-text-hi text-xl font-semibold">Something broke</h2>
      <p className="mt-4 tabular font-mono text-sm text-text-md break-words">{messageOf(error)}</p>
      <button
        type="button"
        onClick={handleReload}
        className="mt-6 inline-block border border-accent-green px-4 py-2 text-sm font-medium text-text-hi transition-colors duration-fast ease-out hover:bg-accent-green hover:text-surface-1"
      >
        Reload
      </button>
    </div>
  );
}

export function ErrorBoundary({ children }: ErrorBoundaryProps): JSX.Element {
  return <ReactErrorBoundary FallbackComponent={FallbackPanel}>{children}</ReactErrorBoundary>;
}

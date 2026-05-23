import type { JSX, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

import { QueryErrorBanner } from "../QueryErrorBanner";

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
    },
  });
}

function Wrapper({ children, client }: { children: ReactNode; client: QueryClient }): JSX.Element {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

interface ProbeProps {
  readonly fetcher: () => Promise<string>;
}

function Probe({ fetcher }: ProbeProps): JSX.Element {
  const query = useQuery({
    queryKey: ["probe"],
    queryFn: fetcher,
  });
  return (
    <div>
      <QueryErrorBanner query={query} label="Games" />
      <p data-testid="status">{query.status}</p>
    </div>
  );
}

describe("QueryErrorBanner", () => {
  it("renders an inline banner with the negative token when a Tanstack Query is in error state", async () => {
    const client = makeClient();
    const fetcher = vi.fn(async () => {
      await Promise.resolve();
      throw new Error("network down");
    });
    render(
      <Wrapper client={client}>
        <Probe fetcher={fetcher} />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("error");
    });
    const banner = screen.getByTestId("query-error-banner");
    expect(banner).toBeTruthy();
    expect(banner.className).toContain("border-negative");
    expect(banner.textContent).toContain("Games");
    expect(banner.textContent).toContain("network down");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("invalidates and refetches when the Retry button is clicked", async () => {
    const client = makeClient();
    const fetcher = vi.fn(async () => {
      await Promise.resolve();
      throw new Error("first failure");
    });
    render(
      <Wrapper client={client}>
        <Probe fetcher={fetcher} />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("error");
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  it("renders nothing when the query is not in error state", () => {
    const client = makeClient();
    const fetcher = vi.fn(async () => {
      await Promise.resolve();
      return "ok";
    });
    render(
      <Wrapper client={client}>
        <Probe fetcher={fetcher} />
      </Wrapper>,
    );
    expect(screen.queryByTestId("query-error-banner")).toBeNull();
  });
});

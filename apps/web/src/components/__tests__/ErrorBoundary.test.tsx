import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { ErrorBoundary } from "../ErrorBoundary";

function Boom(): never {
  throw new Error("boom from test");
}

describe("ErrorBoundary", () => {
  it("renders the fallback panel when a child throws and does not crash the tree", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      return;
    });
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const fallback = screen.getByTestId("error-fallback");
    expect(fallback).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Something broke");
    expect(screen.getByRole("alert").textContent).toContain("boom from test");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    errorSpy.mockRestore();
  });

  it("renders children normally when no error is thrown", () => {
    render(
      <ErrorBoundary>
        <p data-testid="happy">happy path</p>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("happy").textContent).toBe("happy path");
    expect(screen.queryByTestId("error-fallback")).toBeNull();
  });
});

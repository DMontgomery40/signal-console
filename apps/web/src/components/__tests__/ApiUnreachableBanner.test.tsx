import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ApiUnreachableBanner, isNetworkError } from "../ApiUnreachableBanner";

describe("ApiUnreachableBanner", () => {
  it("recognises TypeError as a network error", () => {
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("recognises AbortError as a network error", () => {
    const err = new Error("aborted");
    Object.defineProperty(err, "name", { value: "AbortError" });
    expect(isNetworkError(err)).toBe(true);
  });

  it("does not recognise an arbitrary Error as a network error", () => {
    expect(isNetworkError(new Error("nope"))).toBe(false);
  });

  it("renders the banner when error is a TypeError", () => {
    render(<ApiUnreachableBanner error={new TypeError("Failed to fetch")} />);
    const banner = screen.getByTestId("api-unreachable-banner");
    expect(banner.textContent).toContain("API unreachable");
    expect(banner.className).toContain("border-negative");
  });

  it("renders nothing when error is undefined", () => {
    render(<ApiUnreachableBanner />);
    expect(screen.queryByTestId("api-unreachable-banner")).toBeNull();
  });

  it("renders nothing when error is a non-network Error", () => {
    render(<ApiUnreachableBanner error={new Error("validation failed")} />);
    expect(screen.queryByTestId("api-unreachable-banner")).toBeNull();
  });
});

// MemoryDial unit tests (US-053).
//
// The component name and test ids stay stable for compatibility, but the
// operator-facing contract is volatility lookback: a trailing-bucket count plus
// the exact wall-clock duration implied by the active bucketSeconds setting.

import { useState } from "react";
import type { JSX } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatBucketDurationForDisplay, MemoryDial } from "../MemoryDial";

function Harness({
  initial,
  bucketSeconds,
}: {
  readonly initial: number;
  readonly bucketSeconds: number;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  return <MemoryDial value={value} bucketSeconds={bucketSeconds} onChange={setValue} />;
}

describe("formatBucketDurationForDisplay", () => {
  it("formats bucket counts from the active bucketSeconds value", () => {
    expect(formatBucketDurationForDisplay(20, 60)).toBe("20 min");
    expect(formatBucketDurationForDisplay(20, 24)).toBe("8 min");
    expect(formatBucketDurationForDisplay(1, 30)).toBe("30 sec");
    expect(formatBucketDurationForDisplay(2, 30)).toBe("1 min");
    expect(formatBucketDurationForDisplay(3, 45)).toBe("2 min 15 sec");
  });
});

describe("MemoryDial volatility-lookback display", () => {
  it("renders the trader label, slider bounds, and exact duration", () => {
    render(<Harness initial={20} bucketSeconds={60} />);

    expect(screen.getByText("Volatility lookback")).not.toBeNull();
    expect(screen.getByTestId("memory-dial-headline").textContent).toBe("20");
    expect(screen.getByTestId("memory-dial-headline-detail").textContent).toBe("(20 min)");
    expect(screen.getByTestId("memory-dial-min-label").textContent).toBe("5 min");
    expect(screen.getByTestId("memory-dial-max-label").textContent).toBe("60 min");

    const dial = screen.getByTestId("memory-dial");
    expect(dial.getAttribute("aria-label")).toBe("Volatility lookback buckets");
    expect(dial.getAttribute("aria-valuenow")).toBe("20");
    expect(dial.getAttribute("aria-valuetext")).toBe("20 (20 min)");
  });

  it("updates the duration display after slider changes", () => {
    render(<Harness initial={5} bucketSeconds={30} />);
    const dial = screen.getByTestId("memory-dial");

    expect(screen.getByTestId("memory-dial-headline-detail").textContent).toBe("(2 min 30 sec)");
    fireEvent.change(dial, { target: { value: "6" } });

    expect(dial.getAttribute("aria-valuenow")).toBe("6");
    expect(dial.getAttribute("aria-valuetext")).toBe("6 (3 min)");
    expect(screen.getByTestId("memory-dial-headline-detail").textContent).toBe("(3 min)");
  });

  it("snap chips commit named lookback presets", () => {
    render(<Harness initial={20} bucketSeconds={60} />);
    fireEvent.click(screen.getByTestId("memory-dial-chip-quick"));
    expect(screen.getByTestId("memory-dial").getAttribute("aria-valuenow")).toBe("10");
    fireEvent.click(screen.getByTestId("memory-dial-chip-steady"));
    expect(screen.getByTestId("memory-dial").getAttribute("aria-valuenow")).toBe("40");
  });
});

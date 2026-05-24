// WarmupDial unit tests (US-042).
//
// Component-level checks for the opening-holdoff slider: HTML attributes
// (min/max/step), tooltip text, snap-chip commit semantics, and current-value display.
// End-to-end recompute behavior + round-trip stability lives in
// BacktestPage.test.tsx where the dial is mounted alongside form state.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { WarmupDial } from "../WarmupDial";

describe("WarmupDial", () => {
  it("renders an input type=range with min=2, max=20, step=1", () => {
    render(<WarmupDial value={8} bucketSeconds={60} onChange={() => {}} />);
    const slider = screen.getByTestId("warmup-dial-slider");
    if (!(slider instanceof HTMLInputElement)) throw new Error("not an input");
    expect(slider.type).toBe("range");
    expect(slider.min).toBe("2");
    expect(slider.max).toBe("20");
    expect(slider.step).toBe("1");
  });

  it("shows the current warmup value numerically next to the slider", () => {
    render(<WarmupDial value={4} bucketSeconds={60} onChange={() => {}} />);
    expect(screen.getByTestId("warmup-dial-headline").textContent).toBe("4");
    expect(screen.getByTestId("warmup-dial-headline-detail").textContent).toBe("(4 min)");
    const slider = screen.getByTestId("warmup-dial-slider");
    if (!(slider instanceof HTMLInputElement)) throw new Error("not an input");
    expect(slider.value).toBe("4");
  });

  it("displays the verbatim tooltip text on the slider", () => {
    render(<WarmupDial value={8} bucketSeconds={60} onChange={() => {}} />);
    const slider = screen.getByTestId("warmup-dial-slider");
    expect(slider.getAttribute("title")).toBe(
      "Opening holdoff: suppress the first N non-empty intensity buckets. Once the holdoff ends, the selected prior sample decides which buckets set median and MAD.",
    );
  });

  it("renders three snap chips labelled Default (8) / Fast (4) / Earliest (2)", () => {
    render(<WarmupDial value={8} bucketSeconds={60} onChange={() => {}} />);
    expect(screen.getByTestId("warmup-dial-chip-default").textContent).toBe("Default (8)");
    expect(screen.getByTestId("warmup-dial-chip-eager").textContent).toBe("Fast (4)");
    expect(screen.getByTestId("warmup-dial-chip-off").textContent).toBe("Earliest (2)");
  });

  it("clicking a snap chip commits the chip's value via onChange", () => {
    const onChange = vi.fn();
    render(<WarmupDial value={8} bucketSeconds={60} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("warmup-dial-chip-eager"));
    expect(onChange).toHaveBeenCalledWith(4);
    fireEvent.click(screen.getByTestId("warmup-dial-chip-off"));
    expect(onChange).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByTestId("warmup-dial-chip-default"));
    expect(onChange).toHaveBeenCalledWith(8);
  });

  it("changing the slider commits the parsed integer via onChange", () => {
    const onChange = vi.fn();
    render(<WarmupDial value={8} bucketSeconds={60} onChange={onChange} />);
    const slider = screen.getByTestId("warmup-dial-slider");
    if (!(slider instanceof HTMLInputElement)) throw new Error("not an input");
    fireEvent.change(slider, { target: { value: "3" } });
    expect(onChange).toHaveBeenLastCalledWith(3);
  });

  it("marks the active snap chip via data-chip-active=true (visual cue)", () => {
    render(<WarmupDial value={4} bucketSeconds={60} onChange={() => {}} />);
    expect(screen.getByTestId("warmup-dial-chip-eager").getAttribute("data-chip-active")).toBe(
      "true",
    );
    expect(screen.getByTestId("warmup-dial-chip-default").getAttribute("data-chip-active")).toBe(
      "false",
    );
    expect(screen.getByTestId("warmup-dial-chip-off").getAttribute("data-chip-active")).toBe(
      "false",
    );
  });

  it("clamps out-of-range incoming value into [2, 20]", () => {
    const { rerender } = render(<WarmupDial value={100} bucketSeconds={60} onChange={() => {}} />);
    expect(screen.getByTestId("warmup-dial-headline").textContent).toBe("20");
    rerender(<WarmupDial value={-5} bucketSeconds={60} onChange={() => {}} />);
    expect(screen.getByTestId("warmup-dial-headline").textContent).toBe("2");
  });
});

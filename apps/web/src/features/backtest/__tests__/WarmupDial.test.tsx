// WarmupDial unit tests (US-042).
//
// Component-level checks for the warmup slider: HTML attributes (min/max/step),
// verbatim tooltip text, snap-chip commit semantics, and current-value display.
// End-to-end recompute behavior + round-trip stability lives in
// BacktestPage.test.tsx where the dial is mounted alongside form state.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { WarmupDial } from "../WarmupDial";

describe("WarmupDial", () => {
  it("renders an input type=range with min=2, max=20, step=1", () => {
    render(<WarmupDial value={8} onChange={() => {}} />);
    const slider = screen.getByTestId("warmup-dial-slider");
    if (!(slider instanceof HTMLInputElement)) throw new Error("not an input");
    expect(slider.type).toBe("range");
    expect(slider.min).toBe("2");
    expect(slider.max).toBe("20");
    expect(slider.step).toBe("1");
  });

  it("shows the current warmup value numerically next to the slider", () => {
    render(<WarmupDial value={4} onChange={() => {}} />);
    expect(screen.getByTestId("warmup-dial-headline").textContent).toBe("4");
    const slider = screen.getByTestId("warmup-dial-slider");
    if (!(slider instanceof HTMLInputElement)) throw new Error("not an input");
    expect(slider.value).toBe("4");
  });

  it("displays the verbatim tooltip text on the slider", () => {
    render(<WarmupDial value={8} onChange={() => {}} />);
    const slider = screen.getByTestId("warmup-dial-slider");
    expect(slider.getAttribute("title")).toBe(
      "Skip the first N buckets before fires can occur. Lower = earlier fires; below ~4 the MAD becomes noisy.",
    );
  });

  it("renders three snap chips labelled Default (8) / Eager (4) / Off (2)", () => {
    render(<WarmupDial value={8} onChange={() => {}} />);
    expect(screen.getByTestId("warmup-dial-chip-default").textContent).toBe("Default (8)");
    expect(screen.getByTestId("warmup-dial-chip-eager").textContent).toBe("Eager (4)");
    expect(screen.getByTestId("warmup-dial-chip-off").textContent).toBe("Off (2)");
  });

  it("clicking a snap chip commits the chip's value via onChange", () => {
    const onChange = vi.fn();
    render(<WarmupDial value={8} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("warmup-dial-chip-eager"));
    expect(onChange).toHaveBeenCalledWith(4);
    fireEvent.click(screen.getByTestId("warmup-dial-chip-off"));
    expect(onChange).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByTestId("warmup-dial-chip-default"));
    expect(onChange).toHaveBeenCalledWith(8);
  });

  it("changing the slider commits the parsed integer via onChange", () => {
    const onChange = vi.fn();
    render(<WarmupDial value={8} onChange={onChange} />);
    const slider = screen.getByTestId("warmup-dial-slider");
    if (!(slider instanceof HTMLInputElement)) throw new Error("not an input");
    fireEvent.change(slider, { target: { value: "3" } });
    expect(onChange).toHaveBeenLastCalledWith(3);
  });

  it("marks the active snap chip via data-chip-active=true (visual cue)", () => {
    render(<WarmupDial value={4} onChange={() => {}} />);
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
    const { rerender } = render(<WarmupDial value={100} onChange={() => {}} />);
    expect(screen.getByTestId("warmup-dial-headline").textContent).toBe("20");
    rerender(<WarmupDial value={-5} onChange={() => {}} />);
    expect(screen.getByTestId("warmup-dial-headline").textContent).toBe("2");
  });
});

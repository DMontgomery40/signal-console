// CryWolfDial unit tests (US-036).
//
// Covers SVG geometry contract, keyboard / wheel / chip interactions, snap
// behaviour, and the "no shadow / no idle animation" rules.

import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { JSX } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { CryWolfDial } from "../CryWolfDial";

function Harness({
  initial,
  onChangeSpy,
}: {
  readonly initial: number;
  readonly onChangeSpy?: (v: number) => void;
}): JSX.Element {
  const [k, setK] = useState(initial);
  return (
    <CryWolfDial
      value={k}
      onChange={(next) => {
        setK(next);
        if (onChangeSpy) onChangeSpy(next);
      }}
    />
  );
}

describe("CryWolfDial geometry contract", () => {
  it("renders an SVG (NOT an <input type=range>) with role=slider and aria range 2–8", () => {
    render(<Harness initial={3} />);
    const dial = screen.getByTestId("cry-wolf-dial");
    expect(dial.tagName.toLowerCase()).toBe("svg");
    expect(dial.getAttribute("role")).toBe("slider");
    expect(dial.getAttribute("aria-valuemin")).toBe("2");
    expect(dial.getAttribute("aria-valuemax")).toBe("8");
    expect(dial.getAttribute("aria-valuenow")).toBe("3");
    expect(dial.getAttribute("aria-valuetext")).toBe("3.00");

    expect(screen.queryByRole("slider")?.tagName.toLowerCase()).toBe("svg");
    // The component must not fall back to a native range input.
    const inputs = document.querySelectorAll("input[type='range']");
    expect(inputs.length).toBe(0);
  });

  it("has 7 ticks at K=2..8 with K=3 and K=6 as accent-green majors", () => {
    render(<Harness initial={3} />);
    const ticks = screen.getAllByTestId(/^cry-wolf-dial-tick-/);
    expect(ticks.length).toBe(7);
    for (let k = 2; k <= 8; k++) {
      const t = screen.getByTestId(`cry-wolf-dial-tick-${String(k)}`);
      expect(t.getAttribute("data-tick-value")).toBe(String(k));
      const majorExpected = k === 3 || k === 6;
      expect(t.getAttribute("data-tick-major")).toBe(majorExpected ? "true" : "false");
      const visible = t.querySelector("line");
      if (visible === null) throw new Error(`tick ${String(k)} has no <line>`);
      const cls = visible.getAttribute("class") ?? "";
      if (majorExpected) {
        expect(cls).toContain("text-accent-green");
      } else {
        expect(cls).toContain("text-text-lo");
      }
    }
  });

  it("indicator rotates with K (compass −135° at K=2, 0° at K=5, +135° at K=8)", () => {
    const cases: readonly { readonly k: number; readonly deg: string }[] = [
      { k: 2, deg: "-135" },
      { k: 5, deg: "0" },
      { k: 8, deg: "135" },
    ];
    for (const { k, deg } of cases) {
      const { unmount } = render(<Harness initial={k} />);
      const indicator = screen.getByTestId("cry-wolf-dial-indicator");
      expect(indicator.getAttribute("data-indicator-deg")).toBe(deg);
      unmount();
    }
  });

  it("uses no drop-shadow / no CSS filter / no blur on the knob (AC #13)", () => {
    render(<Harness initial={3} />);
    const root = screen.getByTestId("cry-wolf-dial-root");
    const tree = root.outerHTML.toLowerCase();
    expect(tree).not.toMatch(/box-shadow/);
    expect(tree).not.toMatch(/drop-shadow/);
    expect(tree).not.toMatch(/filter:/);
    expect(tree).not.toMatch(/blur\(/);
  });

  it("at rest there is no inline transition on the indicator (AC #14: no idle animation)", () => {
    render(<Harness initial={3} />);
    const indicator = screen.getByTestId("cry-wolf-dial-indicator");
    // The snap-magnetize transition is only attached during the 50 ms snap
    // window; in the resting render the style is empty.
    const style = indicator.getAttribute("style") ?? "";
    expect(style).not.toMatch(/transition/);
  });
});

describe("CryWolfDial keyboard", () => {
  it("ArrowRight / ArrowUp raises K by 0.25", () => {
    render(<Harness initial={3} />);
    const dial = screen.getByTestId("cry-wolf-dial");
    fireEvent.keyDown(dial, { key: "ArrowRight" });
    expect(dial.getAttribute("aria-valuetext")).toBe("3.25");
    fireEvent.keyDown(dial, { key: "ArrowUp" });
    expect(dial.getAttribute("aria-valuetext")).toBe("3.50");
  });

  it("ArrowLeft / ArrowDown lowers K by 0.25", () => {
    render(<Harness initial={6} />);
    const dial = screen.getByTestId("cry-wolf-dial");
    fireEvent.keyDown(dial, { key: "ArrowLeft" });
    expect(dial.getAttribute("aria-valuetext")).toBe("5.75");
    fireEvent.keyDown(dial, { key: "ArrowDown" });
    expect(dial.getAttribute("aria-valuetext")).toBe("5.50");
  });

  it("PageUp / PageDown changes K by 1.0", () => {
    render(<Harness initial={4} />);
    const dial = screen.getByTestId("cry-wolf-dial");
    fireEvent.keyDown(dial, { key: "PageUp" });
    expect(dial.getAttribute("aria-valuetext")).toBe("5.00");
    fireEvent.keyDown(dial, { key: "PageDown" });
    expect(dial.getAttribute("aria-valuetext")).toBe("4.00");
  });

  it("Home jumps to K=2, End jumps to K=8", () => {
    render(<Harness initial={5} />);
    const dial = screen.getByTestId("cry-wolf-dial");
    fireEvent.keyDown(dial, { key: "Home" });
    expect(dial.getAttribute("aria-valuetext")).toBe("2.00");
    fireEvent.keyDown(dial, { key: "End" });
    expect(dial.getAttribute("aria-valuetext")).toBe("8.00");
  });

  it("does not move past 2.0 or 8.0 (clamped)", () => {
    render(<Harness initial={2} />);
    const dial = screen.getByTestId("cry-wolf-dial");
    fireEvent.keyDown(dial, { key: "ArrowLeft" });
    expect(dial.getAttribute("aria-valuetext")).toBe("2.00");
    fireEvent.keyDown(dial, { key: "End" });
    fireEvent.keyDown(dial, { key: "ArrowRight" });
    expect(dial.getAttribute("aria-valuetext")).toBe("8.00");
  });
});

describe("CryWolfDial snap behaviour", () => {
  it("snap-magnetize sets snap-window transition on the indicator after a near-snap move", () => {
    vi.useFakeTimers();
    try {
      render(<Harness initial={2.5} />);
      const dial = screen.getByTestId("cry-wolf-dial");
      // 2.5 + 0.25 = 2.75 (no snap); +0.25 again = 3.0 (snap, magnetize)
      act(() => {
        fireEvent.keyDown(dial, { key: "ArrowRight" });
        fireEvent.keyDown(dial, { key: "ArrowRight" });
      });
      expect(dial.getAttribute("aria-valuetext")).toBe("3.00");
      const indicator = screen.getByTestId("cry-wolf-dial-indicator");
      const style = indicator.getAttribute("style") ?? "";
      expect(style).toMatch(/transition: transform 50ms/);

      // After 50 ms the transition style is removed.
      act(() => {
        vi.advanceTimersByTime(60);
      });
      const styleAfter = indicator.getAttribute("style") ?? "";
      expect(styleAfter).not.toMatch(/transition/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CryWolfDial snap chips", () => {
  it("Sensitive chip snaps to K=3, Calm chip snaps to K=6", () => {
    render(<Harness initial={5} />);
    fireEvent.click(screen.getByTestId("cry-wolf-chip-calm"));
    expect(screen.getByTestId("cry-wolf-dial").getAttribute("aria-valuetext")).toBe("6.00");
    fireEvent.click(screen.getByTestId("cry-wolf-chip-sensitive"));
    expect(screen.getByTestId("cry-wolf-dial").getAttribute("aria-valuetext")).toBe("3.00");
  });

  it("active chip has accent-green fill, inactive has outline only", () => {
    render(<Harness initial={3} />);
    const sensitive = screen.getByTestId("cry-wolf-chip-sensitive");
    const calm = screen.getByTestId("cry-wolf-chip-calm");
    expect(sensitive.getAttribute("data-chip-active")).toBe("true");
    expect(calm.getAttribute("data-chip-active")).toBe("false");
    expect(sensitive.className).toMatch(/bg-accent-green/);
    expect(calm.className).not.toMatch(/^[^\s]*bg-accent-green(?!\/10)/);
    expect(calm.className).toMatch(/border-accent-green/);
  });

  it("chip click triggers an 80 ms flash on the headline (text-text-hi during, accent-yellow after)", () => {
    vi.useFakeTimers();
    try {
      render(<Harness initial={5} />);
      const headline = screen.getByTestId("cry-wolf-dial-headline");
      expect(headline.className).toMatch(/text-accent-yellow/);
      act(() => {
        fireEvent.click(screen.getByTestId("cry-wolf-chip-calm"));
      });
      expect(headline.className).toMatch(/text-text-hi/);
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(headline.className).toMatch(/text-accent-yellow/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CryWolfDial tick click", () => {
  it("clicking a tick snaps the dial to that K", () => {
    render(<Harness initial={3} />);
    const dial = screen.getByTestId("cry-wolf-dial");
    const tick6 = screen.getByTestId("cry-wolf-dial-tick-6");
    const hitTarget = tick6.querySelectorAll("line")[2];
    if (hitTarget === undefined) throw new Error("missing hit-target line on tick 6");
    fireEvent.click(hitTarget);
    expect(dial.getAttribute("aria-valuetext")).toBe("6.00");
  });
});

describe("CryWolfDial mouse drag", () => {
  it("vertical drag up raises K (200 px ≈ full 6.0 K range; 33 px ≈ +1.0)", () => {
    render(<Harness initial={3} />);
    const dial = screen.getByTestId("cry-wolf-dial");
    const knob = dial.querySelector("circle.fill-surface-1");
    if (knob === null) throw new Error("missing knob circle");
    fireEvent.mouseDown(knob, { clientY: 500 });
    // Drag up by 100 px == half-range == K + 3.0 → 3 + 3 = 6
    fireEvent.mouseMove(window, { clientY: 400 });
    fireEvent.mouseUp(window);
    expect(dial.getAttribute("aria-valuetext")).toBe("6.00");
  });

  it("drag stops moving K after mouseup", () => {
    render(<Harness initial={3} />);
    const dial = screen.getByTestId("cry-wolf-dial");
    const knob = dial.querySelector("circle.fill-surface-1");
    if (knob === null) throw new Error("missing knob circle");
    fireEvent.mouseDown(knob, { clientY: 500 });
    fireEvent.mouseMove(window, { clientY: 480 });
    fireEvent.mouseUp(window);
    const valueAfterUp = dial.getAttribute("aria-valuetext");
    fireEvent.mouseMove(window, { clientY: 200 });
    expect(dial.getAttribute("aria-valuetext")).toBe(valueAfterUp);
  });
});

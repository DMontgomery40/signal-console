// SensitivityDial unit tests (US-036).
//
// Covers SVG geometry contract, keyboard / wheel / chip interactions, snap
// behaviour, and the "no shadow / no idle animation" rules.

import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { JSX } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

import {
  BOARD_MAD_K_MAD_MAX,
  BOARD_MAD_K_MAD_MIN,
} from "@signal-console/detectors/board-mad/config";

import { SensitivityDial } from "../SensitivityDial";

// The dial range IS the kMad contract (audit F-004). Read the bounds from config
// so this test moves in lockstep with the contract and can never re-pin a stale
// hardcoded range. MIN=1, MAX=12 today; midpoint maps to compass 0°.
const MIN = BOARD_MAD_K_MAD_MIN;
const MAX = BOARD_MAD_K_MAD_MAX;
const MID = (MIN + MAX) / 2;

function Harness({
  initial,
  onChangeSpy,
}: {
  readonly initial: number;
  readonly onChangeSpy?: (v: number) => void;
}): JSX.Element {
  const [k, setK] = useState(initial);
  return (
    <SensitivityDial
      value={k}
      firesPerGamePreview="1.25"
      onChange={(next) => {
        setK(next);
        if (onChangeSpy) onChangeSpy(next);
      }}
    />
  );
}

describe("SensitivityDial geometry contract", () => {
  it("renders an SVG (NOT an <input type=range>) with role=slider and aria range from the kMad contract", () => {
    render(<Harness initial={3} />);
    const dial = screen.getByTestId("sensitivity-dial");
    expect(dial.tagName.toLowerCase()).toBe("svg");
    expect(dial.getAttribute("role")).toBe("slider");
    // Range derives from BOARD_MAD_K_MAD_MIN/MAX — the same contract the params
    // schema and Settings slider enforce. Not a bare [2,8] (audit F-004).
    expect(dial.getAttribute("aria-valuemin")).toBe(String(MIN));
    expect(dial.getAttribute("aria-valuemax")).toBe(String(MAX));
    expect(dial.getAttribute("aria-valuenow")).toBe("3");
    expect(dial.getAttribute("aria-valuetext")).toBe("3.00");
    expect(screen.getByTestId("sensitivity-dial-inline-value").textContent).toBe("1.25");
    expect(screen.getByTestId("sensitivity-dial-inline-detail").textContent).toBe("fires/gm");

    expect(screen.queryByRole("slider")?.tagName.toLowerCase()).toBe("svg");
    // The component must not fall back to a native range input.
    const inputs = document.querySelectorAll("input[type='range']");
    expect(inputs.length).toBe(0);
  });

  it("has one tick per integer K across the contract range with K=3 and K=6 as accent-green majors", () => {
    render(<Harness initial={3} />);
    const ticks = screen.getAllByTestId(/^sensitivity-dial-tick-/);
    expect(ticks.length).toBe(MAX - MIN + 1);
    for (let k = MIN; k <= MAX; k++) {
      const t = screen.getByTestId(`sensitivity-dial-tick-${String(k)}`);
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

  it("indicator rotates with K (compass −135° at MIN, 0° at midpoint, +135° at MAX)", () => {
    const cases: readonly { readonly k: number; readonly deg: string }[] = [
      { k: MIN, deg: "-135" },
      { k: MID, deg: "0" },
      { k: MAX, deg: "135" },
    ];
    for (const { k, deg } of cases) {
      const { unmount } = render(<Harness initial={k} />);
      const indicator = screen.getByTestId("sensitivity-dial-indicator");
      expect(indicator.getAttribute("data-indicator-deg")).toBe(deg);
      unmount();
    }
  });

  it("uses no drop-shadow / no CSS filter / no blur on the knob (AC #13)", () => {
    render(<Harness initial={3} />);
    const root = screen.getByTestId("sensitivity-dial-root");
    const tree = root.outerHTML.toLowerCase();
    expect(tree).not.toMatch(/box-shadow/);
    expect(tree).not.toMatch(/drop-shadow/);
    expect(tree).not.toMatch(/filter:/);
    expect(tree).not.toMatch(/blur\(/);
  });

  it("at rest there is no inline transition on the indicator (AC #14: no idle animation)", () => {
    render(<Harness initial={3} />);
    const indicator = screen.getByTestId("sensitivity-dial-indicator");
    // The snap-magnetize transition is only attached during the 50 ms snap
    // window; in the resting render the style is empty.
    const style = indicator.getAttribute("style") ?? "";
    expect(style).not.toMatch(/transition/);
  });
});

describe("SensitivityDial keyboard", () => {
  it("ArrowRight / ArrowUp raises K by 0.25", () => {
    render(<Harness initial={3} />);
    const dial = screen.getByTestId("sensitivity-dial");
    fireEvent.keyDown(dial, { key: "ArrowRight" });
    expect(dial.getAttribute("aria-valuetext")).toBe("3.25");
    fireEvent.keyDown(dial, { key: "ArrowUp" });
    expect(dial.getAttribute("aria-valuetext")).toBe("3.50");
  });

  it("ArrowLeft / ArrowDown lowers K by 0.25", () => {
    render(<Harness initial={6} />);
    const dial = screen.getByTestId("sensitivity-dial");
    fireEvent.keyDown(dial, { key: "ArrowLeft" });
    expect(dial.getAttribute("aria-valuetext")).toBe("5.75");
    fireEvent.keyDown(dial, { key: "ArrowDown" });
    expect(dial.getAttribute("aria-valuetext")).toBe("5.50");
  });

  it("PageUp / PageDown changes K by 1.0", () => {
    render(<Harness initial={4} />);
    const dial = screen.getByTestId("sensitivity-dial");
    fireEvent.keyDown(dial, { key: "PageUp" });
    expect(dial.getAttribute("aria-valuetext")).toBe("5.00");
    fireEvent.keyDown(dial, { key: "PageDown" });
    expect(dial.getAttribute("aria-valuetext")).toBe("4.00");
  });

  it("Home jumps to MIN, End jumps to MAX", () => {
    render(<Harness initial={5} />);
    const dial = screen.getByTestId("sensitivity-dial");
    fireEvent.keyDown(dial, { key: "Home" });
    expect(dial.getAttribute("aria-valuetext")).toBe(MIN.toFixed(2));
    fireEvent.keyDown(dial, { key: "End" });
    expect(dial.getAttribute("aria-valuetext")).toBe(MAX.toFixed(2));
  });

  it("does not move past MIN or MAX (clamped)", () => {
    render(<Harness initial={MIN} />);
    const dial = screen.getByTestId("sensitivity-dial");
    fireEvent.keyDown(dial, { key: "ArrowLeft" });
    expect(dial.getAttribute("aria-valuetext")).toBe(MIN.toFixed(2));
    fireEvent.keyDown(dial, { key: "End" });
    fireEvent.keyDown(dial, { key: "ArrowRight" });
    expect(dial.getAttribute("aria-valuetext")).toBe(MAX.toFixed(2));
  });
});

describe("SensitivityDial snap behaviour", () => {
  it("snap-magnetize sets snap-window transition on the indicator after a near-snap move", () => {
    vi.useFakeTimers();
    try {
      render(<Harness initial={2.5} />);
      const dial = screen.getByTestId("sensitivity-dial");
      // 2.5 + 0.25 = 2.75 (no snap); +0.25 again = 3.0 (snap, magnetize)
      act(() => {
        fireEvent.keyDown(dial, { key: "ArrowRight" });
        fireEvent.keyDown(dial, { key: "ArrowRight" });
      });
      expect(dial.getAttribute("aria-valuetext")).toBe("3.00");
      const indicator = screen.getByTestId("sensitivity-dial-indicator");
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

describe("SensitivityDial snap chips", () => {
  it("Sensitive chip snaps to K=3, Calm chip snaps to K=6", () => {
    render(<Harness initial={5} />);
    fireEvent.click(screen.getByTestId("sensitivity-chip-calm"));
    expect(screen.getByTestId("sensitivity-dial").getAttribute("aria-valuetext")).toBe("6.00");
    fireEvent.click(screen.getByTestId("sensitivity-chip-sensitive"));
    expect(screen.getByTestId("sensitivity-dial").getAttribute("aria-valuetext")).toBe("3.00");
  });

  it("active chip has accent-green fill, inactive has outline only", () => {
    render(<Harness initial={3} />);
    const sensitive = screen.getByTestId("sensitivity-chip-sensitive");
    const calm = screen.getByTestId("sensitivity-chip-calm");
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
      const headline = screen.getByTestId("sensitivity-dial-headline");
      expect(headline.className).toMatch(/text-accent-yellow/);
      act(() => {
        fireEvent.click(screen.getByTestId("sensitivity-chip-calm"));
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

describe("SensitivityDial tick click", () => {
  it("clicking a tick snaps the dial to that K", () => {
    render(<Harness initial={3} />);
    const dial = screen.getByTestId("sensitivity-dial");
    const tick6 = screen.getByTestId("sensitivity-dial-tick-6");
    const hitTarget = tick6.querySelectorAll("line")[2];
    if (hitTarget === undefined) throw new Error("missing hit-target line on tick 6");
    fireEvent.click(hitTarget);
    expect(dial.getAttribute("aria-valuetext")).toBe("6.00");
  });
});

describe("SensitivityDial mouse drag", () => {
  it("vertical drag up raises K (200 px ≈ full range; 100 px ≈ half-range)", () => {
    render(<Harness initial={3} />);
    const dial = screen.getByTestId("sensitivity-dial");
    const knob = dial.querySelector("circle.fill-surface-1");
    if (knob === null) throw new Error("missing knob circle");
    fireEvent.mouseDown(knob, { clientY: 500 });
    // Drag up by 100 px == half of the 200 px full-travel == half the K range.
    fireEvent.mouseMove(window, { clientY: 400 });
    fireEvent.mouseUp(window);
    expect(dial.getAttribute("aria-valuetext")).toBe((3 + (MAX - MIN) / 2).toFixed(2));
  });

  it("drag stops moving K after mouseup", () => {
    render(<Harness initial={3} />);
    const dial = screen.getByTestId("sensitivity-dial");
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

describe("SensitivityDial contract range (F-004)", () => {
  it("can reach the full deployable kMad range the Settings slider allows", () => {
    render(<Harness initial={MID} />);
    const dial = screen.getByTestId("sensitivity-dial");
    // End/Home reach MAX/MIN — values that exist in the params schema and the
    // Settings slider but were unreachable on the old hardcoded [2,8] dial.
    fireEvent.keyDown(dial, { key: "End" });
    expect(dial.getAttribute("aria-valuetext")).toBe(MAX.toFixed(2));
    fireEvent.keyDown(dial, { key: "Home" });
    expect(dial.getAttribute("aria-valuetext")).toBe(MIN.toFixed(2));
  });

  it("reconciles an out-of-range controlled value to the owner instead of displaying a clamped lie", () => {
    const spy = vi.fn();
    // A kMad above the dial max must NOT render as MAX while the form keeps the
    // real value; the dial pushes the clamped value back so form and dial agree
    // and the value can't be silently truncated on first interaction (F-004).
    render(<Harness initial={MAX + 5} onChangeSpy={spy} />);
    expect(spy).toHaveBeenCalledWith(MAX);
    expect(screen.getByTestId("sensitivity-dial").getAttribute("aria-valuetext")).toBe(
      MAX.toFixed(2),
    );
  });

  it("does NOT call onChange on mount for an in-range value (no spurious write / no reconcile loop)", () => {
    const spy = vi.fn();
    // The reconcile effect must fire ONLY for out-of-range values. An in-range
    // value must not trigger a write — otherwise mounting the dial would mark the
    // backtest snapshot stale spuriously, and a consumer that re-clamps could loop.
    render(<Harness initial={MID} onChangeSpy={spy} />);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId("sensitivity-dial").getAttribute("aria-valuetext")).toBe(
      MID.toFixed(2),
    );
  });
});

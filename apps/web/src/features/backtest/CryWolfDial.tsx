// Cry Wolf rotary dial (US-036).
//
// A rotary dial — a circular knob that the user turns — controlling K_MAD
// between 2.0 and 8.0 with snap detents at K_MAD_LIVE and K_MAD_CALM. NOT an
// <input type=range>; the trader mental model is a Sennheiser/Yamaha-style
// analog potentiometer.
//
// Spec is docs/design-language.md §"The Cry Wolf dial". Every geometric
// constant below is sourced from that doc and is part of the contract.
//
// Constraints:
//   * No drop shadows, no CSS filter:/blur(), no shadow utilities — depth is
//     implied by SVG hairlines and a single accent-yellow indicator.
//   * No idle animation. CSS transitions only fire during snap-magnetize
//     (50 ms) and chip-click flash (80 ms).
//   * The K=3.0 (K_MAD_LIVE) and K=6.0 (K_MAD_CALM) literals must never be
//     re-declared in this file; both come from @signal-console/detectors.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX, KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

import { K_MAD_CALM, K_MAD_LIVE } from "@signal-console/detectors/board-mad/config";

const K_MIN = 2;
const K_MAX = 8;
const K_RANGE = K_MAX - K_MIN;

// Geometry — pixel values per docs/design-language.md §"The Cry Wolf dial".
const KNOB_RADIUS = 80; // 160 px diameter knob body
const INNER_BEZEL_INSET = 4; // 1 px inset stroke, 4 px inside knob edge
const OUTER_BEZEL_RADIUS = 96; // 192 px diameter outer ring (16 px > knob)
const INDICATOR_RADIUS = 88; // length of indicator line from center
const TICK_INWARD_MINOR = 12; // 12 px minor tick (every 1.0 K)
const TICK_INWARD_MAJOR = 16; // 16 px major tick at K=3 and K=6
const INDICATOR_STROKE_WIDTH = 3;
const VIEWBOX_HALF = 110; // padding above the 96 px bezel
const VIEWBOX_DIM = VIEWBOX_HALF * 2;
const KNOB_SVG_PX = 220; // rendered SVG box size in CSS pixels

// Travel: 270° arc, K=2 at compass −135°, K=5 at 0° (12 o'clock), K=8 at
// compass +135°. Compass angle (0 = up, clockwise positive) is converted to
// SVG-math radians (0 = right, clockwise positive on screen because SVG y
// grows downward). svgDeg = compassDeg − 90.
function compassDegFromK(k: number): number {
  return -135 + ((k - K_MIN) / K_RANGE) * 270;
}
function svgRadiansFromK(k: number): number {
  return ((compassDegFromK(k) - 90) * Math.PI) / 180;
}

function clampK(k: number): number {
  if (!Number.isFinite(k)) return K_MIN;
  if (k < K_MIN) return K_MIN;
  if (k > K_MAX) return K_MAX;
  return k;
}

const DRAG_PIXELS_FOR_FULL_TRAVEL = 200; // 200 px vertical = full K range
const DRAG_K_PER_PIXEL = K_RANGE / DRAG_PIXELS_FOR_FULL_TRAVEL;
const WHEEL_STEP = 0.25;
const KEY_SMALL_STEP = 0.25;
const KEY_LARGE_STEP = 1.0;
const SNAP_THRESHOLD = 0.1;
const SNAP_TRANSITION_MS = 50;
const CHIP_FLASH_MS = 80;

const SNAP_VALUES = [K_MAD_LIVE, K_MAD_CALM] as const;

function maybeSnap(rawK: number): { readonly k: number; readonly snapped: boolean } {
  for (const snap of SNAP_VALUES) {
    if (Math.abs(rawK - snap) <= SNAP_THRESHOLD) {
      return { k: snap, snapped: true };
    }
  }
  return { k: rawK, snapped: false };
}

interface TickSpec {
  readonly k: number;
  readonly major: boolean;
}
const TICK_SPECS: readonly TickSpec[] = (() => {
  const out: TickSpec[] = [];
  for (let k = K_MIN; k <= K_MAX; k += 1) {
    out.push({ k, major: k === K_MAD_LIVE || k === K_MAD_CALM });
  }
  return out;
})();

function tickEndpoints(
  k: number,
  major: boolean,
): {
  readonly outerX: number;
  readonly outerY: number;
  readonly innerX: number;
  readonly innerY: number;
} {
  const theta = svgRadiansFromK(k);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const inward = major ? TICK_INWARD_MAJOR : TICK_INWARD_MINOR;
  return {
    outerX: cos * OUTER_BEZEL_RADIUS,
    outerY: sin * OUTER_BEZEL_RADIUS,
    innerX: cos * (OUTER_BEZEL_RADIUS - inward),
    innerY: sin * (OUTER_BEZEL_RADIUS - inward),
  };
}

export interface CryWolfDialProps {
  readonly value: number;
  readonly onChange: (next: number) => void;
  readonly ariaLabel?: string;
}

export function CryWolfDial({ value, onChange, ariaLabel }: CryWolfDialProps): JSX.Element {
  const clamped = clampK(value);
  const indicatorAngleDeg = compassDegFromK(clamped);

  // React event handlers close over `clamped`; rapid event sequences (12 key
  // presses dispatched inside one act() block; pixel-rate mousemove during
  // drag) all see the same stale closure value if we read from `clamped`
  // directly. A ref that mirrors each render's committed value lets handlers
  // always step from the latest K, not from the K that was current when the
  // handler was last redefined.
  const latestValueRef = useRef<number>(clamped);
  latestValueRef.current = clamped;

  // Snap-magnetize transition: when a drag/wheel/keyboard lands within ±0.1 K
  // of a snap, we set `snapTransitioning` for 50 ms so the indicator rotation
  // animates into the exact snap value instead of jumping.
  const [snapTransitioning, setSnapTransitioning] = useState(false);
  const snapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Chip-click flash on the inline K number — 80 ms text-hi → accent-yellow.
  const [chipFlashing, setChipFlashing] = useState(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (snapTimerRef.current !== null) clearTimeout(snapTimerRef.current);
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  const triggerSnapTransition = useCallback(() => {
    if (snapTimerRef.current !== null) clearTimeout(snapTimerRef.current);
    setSnapTransitioning(true);
    snapTimerRef.current = setTimeout(() => {
      setSnapTransitioning(false);
      snapTimerRef.current = null;
    }, SNAP_TRANSITION_MS);
  }, []);

  const triggerChipFlash = useCallback(() => {
    if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
    setChipFlashing(true);
    flashTimerRef.current = setTimeout(() => {
      setChipFlashing(false);
      flashTimerRef.current = null;
    }, CHIP_FLASH_MS);
  }, []);

  // Commits a new K value, applying snap-magnetize when within threshold.
  // `allowSnapTransition` controls whether the indicator should animate to the
  // snapped position (true for continuous drag/wheel, false for tick-clicks
  // which the spec says are "instant, no animation other than 50 ms snap").
  //
  // Updates `latestValueRef` synchronously so rapid event sequences (multiple
  // keyDowns batched into one React render, pixel-rate mousemove during drag)
  // each step from the most recently committed K, not from a stale closure.
  const commit = useCallback(
    (rawK: number, allowSnapTransition: boolean): void => {
      const next = maybeSnap(clampK(rawK));
      if (next.snapped && allowSnapTransition) triggerSnapTransition();
      latestValueRef.current = next.k;
      onChange(next.k);
    },
    [onChange, triggerSnapTransition],
  );

  // ── Drag interaction ────────────────────────────────────────────────────
  const dragStateRef = useRef<{ startY: number; startK: number } | null>(null);

  const handleMouseDown = useCallback(
    (e: ReactMouseEvent<SVGCircleElement>) => {
      e.preventDefault();
      dragStateRef.current = { startY: e.clientY, startK: latestValueRef.current };
      const onMove = (ev: MouseEvent): void => {
        const state = dragStateRef.current;
        if (state === null) return;
        const dyPx = state.startY - ev.clientY; // up = positive = raise K
        const rawK = state.startK + dyPx * DRAG_K_PER_PIXEL;
        commit(rawK, true);
      };
      const onUp = (): void => {
        dragStateRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [commit],
  );

  // ── Wheel interaction ───────────────────────────────────────────────────
  // React's synthetic onWheel is passive in some renderers; native attach so
  // preventDefault suppresses page scroll. (advisor #5)
  const svgRef = useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    const el = svgRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const step = e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP;
      commit(latestValueRef.current + step, true);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
    };
  }, [commit]);

  // ── Keyboard interaction ────────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<SVGSVGElement>) => {
      let delta: number | null = null;
      let absolute: number | null = null;
      switch (e.key) {
        case "ArrowLeft":
        case "ArrowDown":
          delta = -KEY_SMALL_STEP;
          break;
        case "ArrowRight":
        case "ArrowUp":
          delta = KEY_SMALL_STEP;
          break;
        case "PageUp":
          delta = KEY_LARGE_STEP;
          break;
        case "PageDown":
          delta = -KEY_LARGE_STEP;
          break;
        case "Home":
          absolute = K_MIN;
          break;
        case "End":
          absolute = K_MAX;
          break;
        default:
          return;
      }
      e.preventDefault();
      if (absolute !== null) {
        commit(absolute, true);
      } else if (delta !== null) {
        commit(latestValueRef.current + delta, true);
      }
    },
    [commit],
  );

  // ── Tick click ──────────────────────────────────────────────────────────
  const handleTickClick = useCallback(
    (k: number): void => {
      commit(k, false);
    },
    [commit],
  );

  // ── Snap-chip click ─────────────────────────────────────────────────────
  const handleChipClick = useCallback(
    (snapK: number): void => {
      triggerChipFlash();
      commit(snapK, true);
    },
    [commit, triggerChipFlash],
  );

  const indicatorTransitionStyle: CSSProperties = useMemo(
    () =>
      snapTransitioning
        ? { transition: `transform ${String(SNAP_TRANSITION_MS)}ms cubic-bezier(0,0,0.2,1)` }
        : {},
    [snapTransitioning],
  );

  const isSensitiveActive = clamped === K_MAD_LIVE;
  const isCalmActive = clamped === K_MAD_CALM;
  const valueLabel = clamped.toFixed(2);

  // For an aria-valuenow value, the integer/string form is more interoperable
  // with screen readers; we expose the rounded K (no decimals) and use
  // aria-valuetext for the precise reading.
  const ariaValueNow = Math.round(clamped * 100) / 100;

  return (
    <div
      data-testid="cry-wolf-dial-root"
      data-cry-wolf-value={String(clamped)}
      className="flex flex-col items-center select-none"
    >
      <div
        data-testid="cry-wolf-headline"
        className={[
          "tabular font-mono leading-none",
          chipFlashing ? "text-text-hi" : "text-accent-yellow",
          "transition-colors",
        ].join(" ")}
        style={{ fontSize: "96px" }}
      >
        {valueLabel}
      </div>

      <svg
        ref={svgRef}
        role="slider"
        tabIndex={0}
        aria-label={ariaLabel ?? "K_MAD threshold"}
        aria-valuemin={K_MIN}
        aria-valuemax={K_MAX}
        aria-valuenow={ariaValueNow}
        aria-valuetext={valueLabel}
        data-testid="cry-wolf-dial"
        onKeyDown={handleKeyDown}
        viewBox={`${String(-VIEWBOX_HALF)} ${String(-VIEWBOX_HALF)} ${String(VIEWBOX_DIM)} ${String(VIEWBOX_DIM)}`}
        width={KNOB_SVG_PX}
        height={KNOB_SVG_PX}
        className="mt-4 cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-green"
      >
        {/* Outer bezel ring (192 px diameter) */}
        <circle
          cx={0}
          cy={0}
          r={OUTER_BEZEL_RADIUS}
          fill="none"
          stroke="currentColor"
          className="text-text-lo"
          strokeOpacity={0.3}
          strokeWidth={1}
        />

        {/* Tick marks */}
        {TICK_SPECS.map((spec) => {
          const ep = tickEndpoints(spec.k, spec.major);
          const colorClass = spec.major ? "text-accent-green" : "text-text-lo";
          return (
            <g
              key={spec.k}
              data-testid={`cry-wolf-tick-${String(spec.k)}`}
              data-tick-k={String(spec.k)}
              data-tick-major={spec.major ? "true" : "false"}
            >
              <line
                x1={ep.outerX}
                y1={ep.outerY}
                x2={ep.innerX}
                y2={ep.innerY}
                stroke="currentColor"
                strokeWidth={1}
                strokeLinecap="round"
                className={colorClass}
              />
              {/* Tick-tip 1 px text-hi at 10% opacity — depth without shadow */}
              <line
                x1={ep.outerX}
                y1={ep.outerY}
                x2={ep.outerX}
                y2={ep.outerY}
                stroke="currentColor"
                strokeWidth={1}
                strokeLinecap="round"
                strokeOpacity={0.1}
                className="text-text-hi"
              />
              {/* Transparent wider hit-target so clicks land easily */}
              <line
                x1={ep.outerX}
                y1={ep.outerY}
                x2={ep.innerX}
                y2={ep.innerY}
                stroke="transparent"
                strokeWidth={14}
                strokeLinecap="round"
                onClick={() => {
                  handleTickClick(spec.k);
                }}
                style={{ cursor: "pointer" }}
              />
            </g>
          );
        })}

        {/* Knob body (160 px diameter) */}
        <circle
          cx={0}
          cy={0}
          r={KNOB_RADIUS}
          className="fill-surface-1"
          onMouseDown={handleMouseDown}
          style={{ cursor: "grab" }}
        />

        {/* Inner bezel ring — 1 px inset stroke, 4 px inside knob edge */}
        <circle
          cx={0}
          cy={0}
          r={KNOB_RADIUS - INNER_BEZEL_INSET}
          fill="none"
          stroke="currentColor"
          className="text-text-lo pointer-events-none"
          strokeOpacity={0.3}
          strokeWidth={1}
        />

        {/* Indicator group — rotates with K. Compass 0° = up, so SVG group is
            rotated by compassDeg from the 12 o'clock baseline. */}
        <g
          data-testid="cry-wolf-indicator"
          data-indicator-deg={String(indicatorAngleDeg)}
          transform={`rotate(${String(indicatorAngleDeg)})`}
          style={indicatorTransitionStyle}
          className="pointer-events-none"
        >
          {/* Main indicator line (3 px accent-yellow, rounded ends) */}
          <line
            x1={0}
            y1={0}
            x2={0}
            y2={-INDICATOR_RADIUS}
            stroke="currentColor"
            strokeWidth={INDICATOR_STROKE_WIDTH}
            strokeLinecap="round"
            className="text-accent-yellow"
          />
          {/* 0.5 px lighter hairline along the leading edge — implies a bevel
              without using shadow/filter. Offset 1 px so it reads as a thin
              highlight beside the main line. */}
          <line
            x1={-1}
            y1={0}
            x2={-1}
            y2={-INDICATOR_RADIUS}
            stroke="currentColor"
            strokeWidth={0.5}
            strokeLinecap="round"
            strokeOpacity={0.6}
            className="text-text-hi"
          />
        </g>

        {/* K value inside the knob — mono 32 px accent-yellow */}
        <text
          x={0}
          y={0}
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-accent-yellow font-mono pointer-events-none tabular"
          fontSize={32}
          data-testid="cry-wolf-inline-value"
        >
          {valueLabel}
        </text>
      </svg>

      {/* Snap chips */}
      <div className="mt-4 flex items-center gap-3" data-testid="cry-wolf-chips">
        <SnapChip
          label="Sensitive"
          active={isSensitiveActive}
          testId="cry-wolf-chip-sensitive"
          onClick={() => {
            handleChipClick(K_MAD_LIVE);
          }}
        />
        <SnapChip
          label="Calm"
          active={isCalmActive}
          testId="cry-wolf-chip-calm"
          onClick={() => {
            handleChipClick(K_MAD_CALM);
          }}
        />
      </div>
    </div>
  );
}

function SnapChip({
  label,
  active,
  testId,
  onClick,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly testId: string;
  readonly onClick: () => void;
}): JSX.Element {
  const className = active
    ? "border border-accent-green bg-accent-green px-3 py-1 text-xs font-mono uppercase tracking-wider text-surface-1"
    : "border border-accent-green bg-transparent px-3 py-1 text-xs font-mono uppercase tracking-wider text-accent-green hover:bg-accent-green/10";
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-chip-active={active ? "true" : "false"}
      className={className}
    >
      {label}
    </button>
  );
}

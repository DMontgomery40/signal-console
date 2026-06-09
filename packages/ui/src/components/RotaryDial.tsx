// RotaryDial primitive (US-053, US-036 original).
//
// Generic circular-knob control. Trader mental model is a
// Sennheiser/Yamaha-style analog potentiometer — drag vertically, scroll, or
// keyboard to turn; snap to configured detents on release within threshold.
// Visual contract is docs/design-language.md §"The Backtest Rotary Dials"; geometry
// is shared across every configured instance (Sensitivity dial, future dials,
// future dials) so the row of side-by-side dials reads as one family.
//
// What the caller configures:
//   value / onChange       — controlled numeric value
//   valueMin / valueMax    — full travel range
//   smallStep / largeStep  — arrow + wheel step / PageUp+PageDown step
//   snapPoints             — values that magnetize on drag/wheel/keyboard
//   snapChips              — buttons rendered below the dial; click sets value
//   majorTickValues        — emphasized ticks (default = snapPoints)
//   tickInterval           — spacing between minor ticks (default 1)
//   formatValue            — headline text formatter
//   formatValueDetail      — optional parenthetical detail shown under headline
//   inlineValueText        — optional alternate metric shown inside the knob
//   inlineDetailText       — optional alternate inline metric label/detail
//   showInlineValue        — render the inline metric inside the knob when true
//   testIdPrefix           — namespace for every data-testid emitted
//   label                  — sr-only / aria-label and visible caption below

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX, KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

import { ExplainerCard } from "./ExplainerCard";
import type { ExplainerId } from "../explainers";

// Geometry — shared with docs/design-language.md §"The Backtest Rotary Dials".
const KNOB_RADIUS = 80;
const INNER_BEZEL_INSET = 4;
const OUTER_BEZEL_RADIUS = 96;
const INDICATOR_RADIUS = 88;
const TICK_INWARD_MINOR = 12;
const TICK_INWARD_MAJOR = 16;
const INDICATOR_STROKE_WIDTH = 3;
const VIEWBOX_HALF = 110;
const VIEWBOX_DIM = VIEWBOX_HALF * 2;
const KNOB_SVG_PX = 220;

const DRAG_PIXELS_FOR_FULL_TRAVEL = 200;
// Default snap-magnetize window = 0.4× the small step. For the Sensitivity dial
// (smallStep 0.25) this is 0.1 — matches the original threshold.
// For integer dials (smallStep 1) this is 0.4, which is wider
// than the gap between integer values so the snap only ever fires on the
// exact snap value — the right behavior for integer-only domains.
const DEFAULT_SNAP_THRESHOLD_RATIO = 0.4;
const SNAP_TRANSITION_MS = 50;
const CHIP_FLASH_MS = 80;

function compassDegFromValue(v: number, min: number, max: number): number {
  const range = max - min;
  if (range <= 0) return -135;
  return -135 + ((v - min) / range) * 270;
}

function svgRadiansFromValue(v: number, min: number, max: number): number {
  return ((compassDegFromValue(v, min, max) - 90) * Math.PI) / 180;
}

function clampValue(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function roundToStep(v: number, step: number): number {
  if (step <= 0) return v;
  return Math.round(v / step) * step;
}

function maybeSnap(
  rawValue: number,
  snapPoints: readonly number[],
  threshold: number,
): { readonly value: number; readonly snapped: boolean } {
  for (const snap of snapPoints) {
    if (Math.abs(rawValue - snap) <= threshold) {
      return { value: snap, snapped: true };
    }
  }
  return { value: rawValue, snapped: false };
}

export interface RotaryDialSnapChip {
  readonly value: number;
  readonly label: string;
  readonly testId: string;
}

export interface RotaryDialProps {
  readonly value: number;
  readonly onChange: (next: number) => void;
  readonly ariaLabel: string;
  readonly valueMin: number;
  readonly valueMax: number;
  readonly smallStep: number;
  readonly largeStep: number;
  readonly snapPoints: readonly number[];
  readonly snapChips: readonly RotaryDialSnapChip[];
  readonly majorTickValues?: readonly number[];
  readonly tickInterval?: number;
  readonly formatValue?: (v: number) => string;
  readonly formatValueDetail?: (v: number) => string | null;
  readonly inlineValueText?: string;
  readonly inlineDetailText?: string | null;
  readonly showInlineValue?: boolean;
  readonly testIdPrefix: string;
  readonly label?: string;
  // Opt-in ExplainerCard hover on the visible label below the SVG. Yellow
  // dashed underline = the project-wide explainer identity (US-050). Pairs
  // with the dial's role as a primary affordance.
  readonly labelExplainerId?: ExplainerId;
  // Absolute distance from a snap point at which magnetize fires. Default
  // is 0.4× smallStep. Caller can override for non-uniform domains.
  readonly snapThreshold?: number;
}

interface TickSpec {
  readonly value: number;
  readonly major: boolean;
}

function buildTicks(
  min: number,
  max: number,
  interval: number,
  majorValues: readonly number[],
): readonly TickSpec[] {
  const majorSet = new Set(majorValues);
  const ticks: TickSpec[] = [];
  for (let v = min; v <= max + 1e-9; v += interval) {
    const rounded = Math.round(v * 1e6) / 1e6;
    ticks.push({ value: rounded, major: majorSet.has(rounded) });
  }
  return ticks;
}

function tickEndpoints(
  v: number,
  min: number,
  max: number,
  major: boolean,
): {
  readonly outerX: number;
  readonly outerY: number;
  readonly innerX: number;
  readonly innerY: number;
} {
  const theta = svgRadiansFromValue(v, min, max);
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

export function RotaryDial(props: RotaryDialProps): JSX.Element {
  const {
    value,
    onChange,
    ariaLabel,
    valueMin,
    valueMax,
    smallStep,
    largeStep,
    snapPoints,
    snapChips,
    majorTickValues,
    tickInterval,
    formatValue,
    formatValueDetail,
    inlineValueText,
    inlineDetailText,
    showInlineValue,
    testIdPrefix,
    label,
    labelExplainerId,
    snapThreshold,
  } = props;
  const clamped = clampValue(value, valueMin, valueMax);
  const interval = tickInterval ?? 1;
  const effectiveSnapThreshold = snapThreshold ?? smallStep * DEFAULT_SNAP_THRESHOLD_RATIO;
  const majorVals = majorTickValues ?? snapPoints;
  const ticks = useMemo(
    () => buildTicks(valueMin, valueMax, interval, majorVals),
    [valueMin, valueMax, interval, majorVals],
  );
  const indicatorAngleDeg = compassDegFromValue(clamped, valueMin, valueMax);
  const dragValuePerPixel = (valueMax - valueMin) / DRAG_PIXELS_FOR_FULL_TRAVEL;
  const headlineText = (formatValue ?? defaultFormat)(clamped);
  const detailText = formatValueDetail?.(clamped) ?? null;
  const renderedInlineValueText = inlineValueText ?? headlineText;
  const renderedInlineDetailText = inlineDetailText ?? detailText;
  const ariaValueText = detailText === null ? headlineText : `${headlineText} ${detailText}`;
  const shouldShowInlineValue = showInlineValue ?? true;

  const latestValueRef = useRef<number>(clamped);
  latestValueRef.current = clamped;

  const [snapTransitioning, setSnapTransitioning] = useState(false);
  const snapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [chipFlashing, setChipFlashing] = useState(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (snapTimerRef.current !== null) clearTimeout(snapTimerRef.current);
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  // Reconcile an out-of-range controlled value instead of silently displaying a
  // clamped lie. The dial clamps `value` to [valueMin, valueMax] for DISPLAY; if
  // the incoming value sits outside that range, push the clamped value back to
  // the owner so the form state and the dial can never disagree. Without this, a
  // value above the max rendered as the max while the form kept the real value,
  // then got truncated to the max on the first interaction (audit F-004). Once
  // the range derives from the kMad contract this is also the belt-and-suspenders
  // guarantee that no legacy/out-of-contract value can masquerade as in-range.
  useEffect(() => {
    if (value !== clamped) onChange(clamped);
  }, [value, clamped, onChange]);

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

  const commit = useCallback(
    (rawValue: number, allowSnapTransition: boolean): void => {
      const stepped = roundToStep(rawValue, smallStep);
      const next = maybeSnap(
        clampValue(stepped, valueMin, valueMax),
        snapPoints,
        effectiveSnapThreshold,
      );
      if (next.snapped && allowSnapTransition) triggerSnapTransition();
      latestValueRef.current = next.value;
      onChange(next.value);
    },
    [
      onChange,
      snapPoints,
      smallStep,
      effectiveSnapThreshold,
      triggerSnapTransition,
      valueMin,
      valueMax,
    ],
  );

  const dragStateRef = useRef<{ startY: number; startValue: number } | null>(null);

  const handleMouseDown = useCallback(
    (e: ReactMouseEvent<SVGCircleElement>) => {
      e.preventDefault();
      dragStateRef.current = { startY: e.clientY, startValue: latestValueRef.current };
      const onMove = (ev: MouseEvent): void => {
        const state = dragStateRef.current;
        if (state === null) return;
        const dyPx = state.startY - ev.clientY;
        const rawValue = state.startValue + dyPx * dragValuePerPixel;
        commit(rawValue, true);
      };
      const onUp = (): void => {
        dragStateRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [commit, dragValuePerPixel],
  );

  const svgRef = useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    const el = svgRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const step = e.deltaY < 0 ? smallStep : -smallStep;
      commit(latestValueRef.current + step, true);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
    };
  }, [commit, smallStep]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<SVGSVGElement>) => {
      let delta: number | null = null;
      let absolute: number | null = null;
      switch (e.key) {
        case "ArrowLeft":
        case "ArrowDown":
          delta = -smallStep;
          break;
        case "ArrowRight":
        case "ArrowUp":
          delta = smallStep;
          break;
        case "PageUp":
          delta = largeStep;
          break;
        case "PageDown":
          delta = -largeStep;
          break;
        case "Home":
          absolute = valueMin;
          break;
        case "End":
          absolute = valueMax;
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
    [commit, smallStep, largeStep, valueMin, valueMax],
  );

  const handleTickClick = useCallback(
    (v: number): void => {
      commit(v, false);
    },
    [commit],
  );

  const handleChipClick = useCallback(
    (v: number): void => {
      triggerChipFlash();
      commit(v, true);
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

  const ariaValueNow = Math.round(clamped * 100) / 100;

  return (
    <div
      data-testid={`${testIdPrefix}-root`}
      data-rotary-value={String(clamped)}
      className="flex flex-col items-center select-none"
    >
      <div
        data-testid={`${testIdPrefix}-headline`}
        className={[
          "tabular font-mono leading-none",
          chipFlashing ? "text-text-hi" : "text-accent-yellow",
          "transition-colors",
        ].join(" ")}
        style={{ fontSize: "clamp(64px, 12vw, 96px)" }}
      >
        {headlineText}
      </div>
      {detailText !== null ? (
        <div
          data-testid={`${testIdPrefix}-headline-detail`}
          className="mt-1 tabular font-mono text-sm text-text-md"
        >
          {detailText}
        </div>
      ) : null}

      <svg
        ref={svgRef}
        role="slider"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-valuemin={valueMin}
        aria-valuemax={valueMax}
        aria-valuenow={ariaValueNow}
        aria-valuetext={ariaValueText}
        data-testid={testIdPrefix}
        onKeyDown={handleKeyDown}
        viewBox={`${String(-VIEWBOX_HALF)} ${String(-VIEWBOX_HALF)} ${String(VIEWBOX_DIM)} ${String(VIEWBOX_DIM)}`}
        width={KNOB_SVG_PX}
        height={KNOB_SVG_PX}
        className="mt-3 h-[190px] w-[190px] cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-green sm:mt-4 sm:h-[220px] sm:w-[220px]"
      >
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

        {ticks.map((spec) => {
          const ep = tickEndpoints(spec.value, valueMin, valueMax, spec.major);
          const colorClass = spec.major ? "text-accent-green" : "text-text-lo";
          return (
            <g
              key={spec.value}
              data-testid={`${testIdPrefix}-tick-${String(spec.value)}`}
              data-tick-value={String(spec.value)}
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
              <line
                x1={ep.outerX}
                y1={ep.outerY}
                x2={ep.innerX}
                y2={ep.innerY}
                stroke="transparent"
                strokeWidth={14}
                strokeLinecap="round"
                onClick={() => {
                  handleTickClick(spec.value);
                }}
                style={{ cursor: "pointer" }}
              />
            </g>
          );
        })}

        <circle
          cx={0}
          cy={0}
          r={KNOB_RADIUS}
          className="fill-surface-1"
          onMouseDown={handleMouseDown}
          style={{ cursor: "grab" }}
        />

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

        <g
          data-testid={`${testIdPrefix}-indicator`}
          data-indicator-deg={String(indicatorAngleDeg)}
          transform={`rotate(${String(indicatorAngleDeg)})`}
          style={indicatorTransitionStyle}
          className="pointer-events-none"
        >
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

        {shouldShowInlineValue ? (
          <g className="pointer-events-none">
            <rect
              x={-54}
              y={-31}
              width={108}
              height={70}
              rx={4}
              className="fill-surface-1 stroke-surface-2"
              strokeWidth={1}
              fillOpacity={0.92}
              data-testid={`${testIdPrefix}-inline-window`}
            />
            <text
              x={0}
              y={renderedInlineDetailText === null ? 2 : -9}
              textAnchor="middle"
              dominantBaseline="central"
              className="fill-accent-yellow font-mono tabular"
              fontSize={30}
              data-testid={`${testIdPrefix}-inline-value`}
            >
              {renderedInlineValueText}
            </text>
          </g>
        ) : null}
        {shouldShowInlineValue && renderedInlineDetailText !== null ? (
          <text
            x={0}
            y={24}
            textAnchor="middle"
            dominantBaseline="central"
            className="fill-text-md font-mono pointer-events-none tabular"
            fontSize={13}
            data-testid={`${testIdPrefix}-inline-detail`}
          >
            {renderedInlineDetailText}
          </text>
        ) : null}
      </svg>

      {label !== undefined && label.length > 0 ? (
        labelExplainerId !== undefined ? (
          <div
            data-testid={`${testIdPrefix}-label`}
            className="mt-3 text-xs uppercase tracking-wider text-text-md"
          >
            <ExplainerCard id={labelExplainerId}>
              <span>{label}</span>
            </ExplainerCard>
          </div>
        ) : (
          <div
            data-testid={`${testIdPrefix}-label`}
            className="mt-3 text-xs uppercase tracking-wider text-text-md"
          >
            {label}
          </div>
        )
      ) : null}

      <div
        className="mt-4 flex flex-wrap items-center justify-center gap-2 sm:gap-3"
        data-testid={`${testIdPrefix}-chips`}
      >
        {snapChips.map((chip) => {
          const active = chip.value === clamped;
          return (
            <SnapChip
              key={chip.testId}
              label={chip.label}
              active={active}
              testId={chip.testId}
              onClick={() => {
                handleChipClick(chip.value);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function defaultFormat(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
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
    ? "border border-accent-green bg-accent-green px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider text-surface-1 sm:px-3 sm:text-xs"
    : "border border-accent-green bg-transparent px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider text-accent-green hover:bg-accent-green/10 sm:px-3 sm:text-xs";
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

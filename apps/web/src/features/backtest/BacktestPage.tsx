// Backtest page (US-035).
//
// Scope of this story is the FORM SCAFFOLD: date range + game scope + detector
// selector + an auto-rendered editable param form + empty results panel. The
// Sensitivity rotary dial (US-036), live preview metric (US-037), per-game
// timeline (US-038), Reaves/Hartenstein anchor display (US-039), and warmup
// dial (US-042) attach in later stories.
//
// The board-volatility model now lives in the Python sidecar, so the browser
// no longer tries to recompute backtest results locally. Once params change
// after a run, the page keeps showing the last server snapshot and marks it
// stale until the user reruns /v1/backtest.

import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, JSX } from "react";

import { ExplainerCard, explainers } from "@signal-console/ui";
import type { ExplainerId } from "@signal-console/ui";

import { ApiUnreachableBanner, isNetworkError } from "../../components/ApiUnreachableBanner";
import { PromotionDialog } from "../../components/PromotionDialog";
import { QueryErrorBanner } from "../../components/QueryErrorBanner";
import {
  useBacktest,
  useDetectors,
  useScheduleDetectorDefaults,
  useSettings,
  useUpdateDetectorDefaults,
  type BacktestObservation,
  type BacktestRequest,
  type BacktestResponse,
  type BacktestStats,
  type DetectorDefaults,
  type DetectorEntry,
} from "../../data/queries";
import { defaultValuesFor, parseSchema, type ParsedProperty } from "../../lib/paramsSchema";
import {
  isBoardMadPrebucketField,
  BOARD_MAD_DETECTOR_ID,
  ENSEMBLE_OR_DETECTOR_ID,
} from "./clientRecompute";
import { BacktestTimelines } from "./BacktestTimelines";
import { SensitivityDial } from "./SensitivityDial";
import { MemoryDial } from "./MemoryDial";
import { PbpAnchoredIncidents } from "./PbpAnchoredIncidents";
import { WarmupDial } from "./WarmupDial";
import {
  BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
  BOARD_MAD_BASELINE_MODE_DEFAULT,
  BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
  BOARD_MAD_BASELINE_MODE_TRAILING,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_MAX,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_MIN,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_MAX,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_MIN,
  BOARD_MAD_BUCKET_SECONDS_DEFAULT,
  BOARD_MAD_HISTORICAL_AWAY_WEIGHT_DEFAULT,
  BOARD_MAD_HISTORICAL_LAST_GAMES_DEFAULT,
  BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT,
  BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
  BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT,
  BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT,
  BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT,
  BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
  K_MAD_LIVE,
} from "@signal-console/detectors/board-mad/config";
import {
  BOARD_STATE_SPACE_CONFIG_DEFAULTS,
  BoardStateSpaceConfigSchema,
  type BoardStateSpaceConfig,
} from "@signal-console/detectors/board-mad/state-space-config";

const KMAD_PARAM_NAME = "kMad";
const BUCKET_SECONDS_PARAM_NAME = "bucketSeconds";
const BASELINE_MODE_PARAM_NAME = "baselineMode";
const OPENING_BASELINE_PARAM_NAME = "openingBaselineBuckets";
const OPENING_RAMP_COMPLETE_PARAM_NAME = "openingRampCompleteBuckets";
const TRAILING_PARAM_NAME = "trailingBuckets";
const WARMUP_PARAM_NAME = "warmupBuckets";
const HISTORICAL_LAST_GAMES_PARAM_NAME = "historicalLastGames";
const HISTORICAL_AWAY_WEIGHT_PARAM_NAME = "historicalAwayWeight";
const HISTORICAL_PRIOR_WEIGHT_PARAM_NAME = "historicalPriorWeight";
const HISTORICAL_RAMP_GAME_MINUTES_PARAM_NAME = "historicalRampCompleteGameMinutes";
const TRAILING_GAME_MINUTES_PARAM_NAME = "trailingGameMinutes";
const RECENT_WALL_MINUTES_PARAM_NAME = "recentWallMinutes";
const RECENT_WALL_WEIGHT_PARAM_NAME = "recentWallWeight";
const STATE_SPACE_PARAM_NAME = "stateSpace";
const BUCKET_SECONDS_DEFAULT = BOARD_MAD_BUCKET_SECONDS_DEFAULT;
const BASELINE_MODE_DEFAULT = BOARD_MAD_BASELINE_MODE_DEFAULT;
const OPENING_BASELINE_DEFAULT = BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT;
const OPENING_BASELINE_MIN = BOARD_MAD_OPENING_BASELINE_BUCKETS_MIN;
const OPENING_BASELINE_MAX = BOARD_MAD_OPENING_BASELINE_BUCKETS_MAX;
const OPENING_RAMP_COMPLETE_DEFAULT = BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT;
const OPENING_RAMP_COMPLETE_MIN = BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_MIN;
const OPENING_RAMP_COMPLETE_MAX = BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_MAX;
const TRAILING_DEFAULT = BOARD_MAD_TRAILING_BUCKETS_DEFAULT;
const WARMUP_DEFAULT = BOARD_MAD_WARMUP_BUCKETS_DEFAULT;

type BoardProfileId = "opening-ramp-live" | "historical-blend" | "legacy-trailing" | "custom";

const BOARD_PROFILE_PRESETS: ReadonlyArray<{
  readonly id: Exclude<BoardProfileId, "custom">;
  readonly label: string;
  readonly patch: Readonly<Record<string, number | string>>;
}> = [
  {
    id: "opening-ramp-live",
    label: "Opening anchor live",
    patch: {
      [BASELINE_MODE_PARAM_NAME]: BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
      [BUCKET_SECONDS_PARAM_NAME]: 60,
      [OPENING_BASELINE_PARAM_NAME]: 4,
      [OPENING_RAMP_COMPLETE_PARAM_NAME]: 20,
      [TRAILING_PARAM_NAME]: 20,
      [WARMUP_PARAM_NAME]: 8,
    },
  },
  {
    id: "historical-blend",
    label: "Historical prior live",
    patch: {
      [BASELINE_MODE_PARAM_NAME]: BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
      [BUCKET_SECONDS_PARAM_NAME]: 30,
      [OPENING_BASELINE_PARAM_NAME]: 3,
      [OPENING_RAMP_COMPLETE_PARAM_NAME]: 16,
      [TRAILING_PARAM_NAME]: 24,
      [WARMUP_PARAM_NAME]: 4,
      [HISTORICAL_LAST_GAMES_PARAM_NAME]: BOARD_MAD_HISTORICAL_LAST_GAMES_DEFAULT,
      [HISTORICAL_AWAY_WEIGHT_PARAM_NAME]: BOARD_MAD_HISTORICAL_AWAY_WEIGHT_DEFAULT,
      [HISTORICAL_PRIOR_WEIGHT_PARAM_NAME]: BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT,
      [HISTORICAL_RAMP_GAME_MINUTES_PARAM_NAME]:
        BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
      [TRAILING_GAME_MINUTES_PARAM_NAME]: BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT,
      [RECENT_WALL_MINUTES_PARAM_NAME]: BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT,
      [RECENT_WALL_WEIGHT_PARAM_NAME]: BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT,
    },
  },
  {
    id: "legacy-trailing",
    label: "Pure trailing state",
    patch: {
      [BASELINE_MODE_PARAM_NAME]: BOARD_MAD_BASELINE_MODE_TRAILING,
      [BUCKET_SECONDS_PARAM_NAME]: 60,
      [TRAILING_PARAM_NAME]: 20,
      [WARMUP_PARAM_NAME]: 8,
    },
  },
];

function readNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function readString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
    return stableJson(left) === stableJson(right);
  }
  return left === right;
}

// Both board-mad and ensemble-or share the board lane's sensitivity/baseline-timing knobs.
// The dials are the marquee Backtest UX so they render for either detector;
// the difference is just where in the params tree the values live.
function isBoardLikeDetector(id: string | undefined): boolean {
  return id === BOARD_MAD_DETECTOR_ID || id === ENSEMBLE_OR_DETECTOR_ID;
}

function withBoardStateSpaceDefaults(
  detectorId: string,
  params: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (detectorId === ENSEMBLE_OR_DETECTOR_ID) {
    const board = isPlainRecord(params["board"]) ? params["board"] : {};
    return {
      ...params,
      board: {
        ...board,
        [STATE_SPACE_PARAM_NAME]:
          board[STATE_SPACE_PARAM_NAME] ?? BOARD_STATE_SPACE_CONFIG_DEFAULTS,
      },
    };
  }
  if (detectorId === BOARD_MAD_DETECTOR_ID) {
    return {
      ...params,
      [STATE_SPACE_PARAM_NAME]: params[STATE_SPACE_PARAM_NAME] ?? BOARD_STATE_SPACE_CONFIG_DEFAULTS,
    };
  }
  return params;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Board params live at params.<name> for board-mad and params.board.<name> for
// ensemble-or. These helpers paper over that so the dial wiring stays simple.
function readBoardParam(
  params: Readonly<Record<string, unknown>>,
  detectorId: string | undefined,
  name: string,
  fallback: number,
): number {
  if (detectorId === ENSEMBLE_OR_DETECTOR_ID) {
    const board = params["board"];
    if (isPlainRecord(board)) return readNumber(board[name], fallback);
    return fallback;
  }
  return readNumber(params[name], fallback);
}

function readBoardStringParam(
  params: Readonly<Record<string, unknown>>,
  detectorId: string | undefined,
  name: string,
  fallback: string,
): string {
  if (detectorId === ENSEMBLE_OR_DETECTOR_ID) {
    const board = params["board"];
    if (isPlainRecord(board)) return readString(board[name], fallback);
    return fallback;
  }
  return readString(params[name], fallback);
}

function readBoardStateSpaceConfig(
  params: Readonly<Record<string, unknown>>,
  detectorId: string | undefined,
): BoardStateSpaceConfig {
  if (detectorId === ENSEMBLE_OR_DETECTOR_ID) {
    const board = params["board"];
    if (isPlainRecord(board)) {
      return BoardStateSpaceConfigSchema.parse(
        board[STATE_SPACE_PARAM_NAME] ?? BOARD_STATE_SPACE_CONFIG_DEFAULTS,
      );
    }
    return BoardStateSpaceConfigSchema.parse(BOARD_STATE_SPACE_CONFIG_DEFAULTS);
  }
  return BoardStateSpaceConfigSchema.parse(
    params[STATE_SPACE_PARAM_NAME] ?? BOARD_STATE_SPACE_CONFIG_DEFAULTS,
  );
}

function inferBoardProfile(baselineMode: string, bucketSeconds: number): BoardProfileId {
  if (baselineMode === BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND) return "historical-blend";
  if (baselineMode === BOARD_MAD_BASELINE_MODE_TRAILING) return "legacy-trailing";
  if (baselineMode === BOARD_MAD_BASELINE_MODE_OPENING_RAMP && bucketSeconds === 60) {
    return "opening-ramp-live";
  }
  return "custom";
}

function parseBoardProfileId(value: string): BoardProfileId {
  for (const profile of BOARD_PROFILE_PRESETS) {
    if (profile.id === value) return profile.id;
  }
  return "custom";
}

// Phase B4: next 09:00 UTC for scheduled promote-to-live. Mirrors the
// SettingsPage helper nextUtcNineAm() — keeping them in sync; both surfaces
// land on the same off-game-hours window per David's spec (msg 04 today).
function nextUtcNineAmIso(now = new Date()): string {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 9, 0, 0, 0),
  );
  return next.toISOString();
}

// Phase B4 amendment (Codex review P2, 2026-05-25): read the ensemble-or
// form's nested offprice params so the parity banner / Apply-to-Live
// dialog include them. Defaults match OffPricePrintParams (Zod) — used
// when the user hasn't explicitly edited offprice fields.
function readEnsembleOffpriceParams(
  params: Readonly<Record<string, unknown>>,
): { readonly minVolumeShare: number; readonly minOffPriceDistance: number } | null {
  const offprice = params["offprice"];
  // Use the existing isPlainRecord predicate to narrow `offprice` to an
  // indexable record without a type assertion. When absent/wrong shape,
  // fall through to OffPricePrintParams Zod defaults — same values the
  // runner would resolve.
  if (!isPlainRecord(offprice)) {
    return { minVolumeShare: 0.1, minOffPriceDistance: 0.4 };
  }
  const minVolumeShare = offprice["minVolumeShare"];
  const minOffPriceDistance = offprice["minOffPriceDistance"];
  return {
    minVolumeShare: typeof minVolumeShare === "number" ? minVolumeShare : 0.1,
    minOffPriceDistance: typeof minOffPriceDistance === "number" ? minOffPriceDistance : 0.4,
  };
}

function readBoardKMad(
  params: Readonly<Record<string, unknown>>,
  detectorId: string | undefined,
): number {
  return readBoardParam(params, detectorId, KMAD_PARAM_NAME, K_MAD_LIVE);
}

const MAX_WINDOW_DAYS = 28;
const MAX_GAMES = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const isExplainerId = (id: string): id is ExplainerId =>
  Object.prototype.hasOwnProperty.call(explainers, id);

function MaybeExplain({ id, children }: { id: string; children: JSX.Element }): JSX.Element {
  if (isExplainerId(id)) {
    return <ExplainerCard id={id}>{children}</ExplainerCard>;
  }
  return children;
}

function todayIso(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

function daysAgoIso(days: number): string {
  const t = new Date(Date.now() - days * DAY_MS);
  return t.toISOString().slice(0, 10);
}

function isoDateToWindowStart(d: string): string {
  return `${d}T00:00:00Z`;
}

function isoDateToWindowEnd(d: string): string {
  return `${d}T23:59:59Z`;
}

function diffDaysExclusive(startIso: string, endIso: string): number {
  const a = Date.parse(`${startIso}T00:00:00Z`);
  const b = Date.parse(`${endIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  return (b - a) / DAY_MS;
}

// ── Styling tokens ────────────────────────────────────────────────────────

const SECTION_LABEL_CLASS =
  "text-text-lo text-xs uppercase tracking-[0.08em] font-sans font-medium";
const FIELD_LABEL_CLASS = "text-text-lo text-xs uppercase tracking-[0.08em] font-sans";
const FIELD_HINT_CLASS = "text-text-lo tabular font-mono text-xs";
const INPUT_CLASS =
  "border border-surface-2 bg-surface-0-from px-2 py-1 text-sm font-mono text-text-hi tabular focus:border-accent-green focus:outline-none";
const NUMBER_INPUT_CLASS = `${INPUT_CLASS} w-full max-w-32`;
const SELECT_CLASS = `${INPUT_CLASS} w-full max-w-56`;
const TEXTAREA_CLASS = `${INPUT_CLASS} w-full min-h-24 font-mono`;
const BUTTON_PRIMARY_CLASS =
  "border border-accent-yellow bg-transparent px-4 py-1.5 text-sm font-mono uppercase tracking-wider text-accent-yellow hover:bg-accent-yellow/10 disabled:cursor-not-allowed disabled:opacity-50";

// ── Editable param controls ───────────────────────────────────────────────

interface ParamControlProps {
  readonly prop: ParsedProperty;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly onChange: (next: unknown) => void;
}

function NumberControl({ prop, value, disabled, onChange }: ParamControlProps): JSX.Element {
  const integer = prop.kind.kind === "number" && prop.kind.integer;
  const step = integer ? 1 : 0.1;
  const rendered = typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  const handle = (e: ChangeEvent<HTMLInputElement>): void => {
    const raw = e.target.value;
    if (raw === "") {
      onChange(undefined);
      return;
    }
    const parsed = integer ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
    if (Number.isFinite(parsed)) onChange(parsed);
  };
  return (
    <input
      type="number"
      value={rendered}
      step={step}
      disabled={disabled}
      {...(prop.minimum !== null ? { min: prop.minimum } : {})}
      {...(prop.maximum !== null ? { max: prop.maximum } : {})}
      onChange={handle}
      className={NUMBER_INPUT_CLASS}
      data-testid={`backtest-param-${prop.name}`}
      data-param-kind="number"
      aria-label={prop.name}
    />
  );
}

function EnumControl({
  prop,
  value,
  values,
  disabled,
  onChange,
}: ParamControlProps & { values: readonly string[] }): JSX.Element {
  const selected = typeof value === "string" ? value : (values[0] ?? "");
  const handle = (e: ChangeEvent<HTMLSelectElement>): void => {
    onChange(e.target.value);
  };
  return (
    <select
      value={selected}
      disabled={disabled}
      onChange={handle}
      className={SELECT_CLASS}
      data-testid={`backtest-param-${prop.name}`}
      data-param-kind="enum"
      aria-label={prop.name}
    >
      {values.map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
    </select>
  );
}

function BooleanControl({ prop, value, disabled, onChange }: ParamControlProps): JSX.Element {
  const checked = value === true;
  const handle = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange(e.target.checked);
  };
  return (
    <span
      role="switch"
      aria-checked={checked}
      data-testid={`backtest-param-${prop.name}`}
      data-param-kind="boolean"
      className="inline-flex items-center"
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={handle}
        className="accent-accent-green disabled:cursor-not-allowed"
        aria-label={prop.name}
      />
    </span>
  );
}

function rangeHint(prop: ParsedProperty): string | null {
  const parts: string[] = [];
  if (prop.minimum !== null) parts.push(`min ${String(prop.minimum)}`);
  if (prop.maximum !== null) parts.push(`max ${String(prop.maximum)}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

function ParamRow({
  detectorId,
  prop,
  value,
  needsRerunHint,
  onChange,
}: {
  readonly detectorId: string;
  readonly prop: ParsedProperty;
  readonly value: unknown;
  readonly needsRerunHint: boolean;
  readonly onChange: (next: unknown) => void;
}): JSX.Element {
  const labelEl = <span className="tabular font-mono text-sm text-text-hi">{prop.name}</span>;
  let control: JSX.Element;
  const props: ParamControlProps = { prop, value, disabled: false, onChange };
  switch (prop.kind.kind) {
    case "number":
      control = <NumberControl {...props} />;
      break;
    case "enum":
      control = <EnumControl {...props} values={prop.kind.values} />;
      break;
    case "boolean":
      control = <BooleanControl {...props} />;
      break;
    case "unknown":
      control = (
        <span className="tabular font-mono text-sm text-text-md">
          {typeof value === "string" || typeof value === "number" ? String(value) : "—"}
        </span>
      );
      break;
  }
  const hint = rangeHint(prop);
  return (
    <div
      data-testid="backtest-param-row"
      data-detector-id={detectorId}
      data-param-name={prop.name}
      className="contents"
    >
      <span className={`${FIELD_LABEL_CLASS} self-start py-2`}>
        <MaybeExplain id={prop.name}>{labelEl}</MaybeExplain>
      </span>
      <div className="flex flex-col gap-1 py-2">
        {control}
        <div className="flex gap-3 text-xs">
          {hint !== null ? <span className={FIELD_HINT_CLASS}>{hint}</span> : null}
          {needsRerunHint ? (
            <span
              data-testid={`backtest-rerun-hint-${prop.name}`}
              className="font-mono text-accent-yellow"
            >
              Re-run required
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface SignalTimingPanelProps {
  readonly profileValue: BoardProfileId;
  readonly baselineMode: string;
  readonly memoryValue: number;
  readonly bucketSeconds: number;
  readonly openingBaselineValue: number;
  readonly openingRampCompleteValue: number;
  readonly warmupValue: number;
  readonly onProfileChange: (next: BoardProfileId) => void;
  readonly onBaselineModeChange: (next: string) => void;
  readonly onMemoryChange: (next: number) => void;
  readonly onOpeningBaselineChange: (next: number) => void;
  readonly onOpeningRampCompleteChange: (next: number) => void;
  readonly onWarmupChange: (next: number) => void;
}

function SignalTimingPanel({
  profileValue,
  baselineMode,
  memoryValue,
  bucketSeconds,
  openingBaselineValue,
  openingRampCompleteValue,
  warmupValue,
  onProfileChange,
  onBaselineModeChange,
  onMemoryChange,
  onOpeningBaselineChange,
  onOpeningRampCompleteChange,
  onWarmupChange,
}: SignalTimingPanelProps): JSX.Element {
  return (
    <div
      data-testid="backtest-signal-timing-panel"
      className="border border-surface-2 bg-surface-0-from/70 px-4 py-4 sm:px-5"
    >
      <div className="border-b border-surface-2 pb-3">
        <ExplainerCard id="baseline-timing-controls">
          <span className="text-text-hi text-sm font-semibold uppercase tracking-[0.08em]">
            Signal timing
          </span>
        </ExplainerCard>
        <p className="mt-1 max-w-[58ch] text-xs text-text-md">
          How quickly the detector trusts this game: which prior sample defines normal, how fast it
          graduates, and the opening holdoff before the first fire can happen.
        </p>
      </div>
      <div className="mt-4 grid min-w-0 gap-4">
        <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <label className="flex min-w-0 flex-col gap-1">
            <span className={FIELD_LABEL_CLASS}>
              <ExplainerCard id="settings-detector-defaults">Profile</ExplainerCard>
            </span>
            <select
              value={profileValue}
              onChange={(e) => {
                onProfileChange(parseBoardProfileId(e.target.value));
              }}
              className={SELECT_CLASS}
              data-testid="backtest-baseline-profile"
              aria-label="baseline profile"
            >
              {BOARD_PROFILE_PRESETS.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label}
                </option>
              ))}
              <option value="custom">Custom</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className={FIELD_LABEL_CLASS}>
              <ExplainerCard id="baseline-source-mode">Prior anchor</ExplainerCard>
            </span>
            <select
              value={baselineMode}
              onChange={(e) => {
                onBaselineModeChange(e.target.value);
              }}
              className={SELECT_CLASS}
              data-testid="backtest-baseline-mode"
              aria-label="baseline mode"
            >
              <option value={BOARD_MAD_BASELINE_MODE_TRAILING}>Pure trailing state</option>
              <option value={BOARD_MAD_BASELINE_MODE_OPENING_RAMP}>Opening anchor ramp</option>
              <option value={BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND}>
                Historical prior blend
              </option>
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className={FIELD_LABEL_CLASS}>
              <ExplainerCard id="settings-opening-baseline-buckets">
                Opening anchor sample
              </ExplainerCard>
            </span>
            <input
              type="number"
              min={OPENING_BASELINE_MIN}
              max={OPENING_BASELINE_MAX}
              step={1}
              value={String(openingBaselineValue)}
              onChange={(e) => {
                const parsed = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(parsed)) onOpeningBaselineChange(parsed);
              }}
              className={NUMBER_INPUT_CLASS}
              data-testid="backtest-opening-baseline-buckets"
              aria-label="opening baseline buckets"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className={FIELD_LABEL_CLASS}>
              <ExplainerCard id="settings-opening-ramp-complete-buckets">
                Opening anchor fade-out
              </ExplainerCard>
            </span>
            <input
              type="number"
              min={OPENING_RAMP_COMPLETE_MIN}
              max={OPENING_RAMP_COMPLETE_MAX}
              step={1}
              value={String(openingRampCompleteValue)}
              onChange={(e) => {
                const parsed = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(parsed)) onOpeningRampCompleteChange(parsed);
              }}
              className={NUMBER_INPUT_CLASS}
              data-testid="backtest-opening-ramp-complete-buckets"
              aria-label="opening ramp complete buckets"
            />
          </label>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="min-w-0">
            <MemoryDial
              value={memoryValue}
              bucketSeconds={bucketSeconds}
              onChange={onMemoryChange}
            />
          </div>
          <div
            className="min-w-0 border-t border-surface-2 pt-4 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0"
            data-testid="backtest-warmup-dial"
          >
            <WarmupDial
              value={warmupValue}
              bucketSeconds={bucketSeconds}
              onChange={onWarmupChange}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────

type ScopeMode = "all" | "specific";

interface FormState {
  readonly startDate: string;
  readonly endDate: string;
  readonly scopeMode: ScopeMode;
  readonly gameIdsText: string;
  readonly detectorId: string;
  readonly params: Readonly<Record<string, unknown>>;
}

interface RunSnapshot {
  readonly detectorId: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly response: BacktestResponse;
}

function parseGameIds(raw: string): readonly string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface RecomputeView {
  readonly stats: BacktestStats;
  readonly observations: readonly BacktestObservation[];
  readonly fromRecompute: boolean;
}

function clampedStats(
  snapshot: RunSnapshot,
  currentParams: Readonly<Record<string, unknown>>,
): RecomputeView {
  void currentParams;
  return {
    stats: snapshot.response.stats,
    observations: snapshot.response.observations,
    fromRecompute: false,
  };
}

function readRenderedResultKMad(
  snapshot: RunSnapshot | null,
  currentParams: Readonly<Record<string, unknown>>,
  currentDetectorId: string | undefined,
  recompute: RecomputeView | null,
): number {
  if (snapshot === null) return readBoardKMad(currentParams, currentDetectorId);
  const paramsForRenderedRows = recompute?.fromRecompute === true ? currentParams : snapshot.params;
  return readBoardKMad(paramsForRenderedRows, snapshot.detectorId);
}

function formatFiresPerGamePreview(
  pending: boolean,
  hasSnapshot: boolean,
  firesPerGame: number | null,
): string {
  if (pending) return "…";
  if (!hasSnapshot || firesPerGame === null) return "—";
  return firesPerGame.toFixed(2);
}

function stableParamJson(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stableParamJson(entry)).join(",")}]`;
  if (isPlainRecord(value)) {
    const record = value;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableParamJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function snapshotIsStale(
  snapshot: RunSnapshot,
  currentParams: Readonly<Record<string, unknown>>,
): boolean {
  return stableParamJson(snapshot.params) !== stableParamJson(currentParams);
}

function selectInitialDetector(rows: readonly DetectorEntry[]): string {
  // Default to the Stage 1 cascade that runs board-mad AND off-price-print
  // and unions their fires. Falls back to board-mad if ensemble-or isn't
  // registered (older API), then to whatever the first registered detector is.
  const ensemble = rows.find((d) => d.id === ENSEMBLE_OR_DETECTOR_ID);
  if (ensemble !== undefined) return ensemble.id;
  const boardMad = rows.find((d) => d.id === BOARD_MAD_DETECTOR_ID);
  return boardMad?.id ?? rows[0]?.id ?? "";
}

export function BacktestPage(): JSX.Element {
  const detectorsQuery = useDetectors();
  const runMutation = useBacktest();
  // Phase B4 (2026-05-25): live-defaults read + promote-to-live mutation
  // hooks. Settings poll feeds the parity banner ("these params match live:
  // Yes/No") and the PromotionDialog's apply/schedule actions.
  const settingsQuery = useSettings();
  const promoteMutation = useUpdateDetectorDefaults();
  const promoteScheduleMutation = useScheduleDetectorDefaults();
  const [pendingPromote, setPendingPromote] = useState<{
    readonly next: DetectorDefaults;
    readonly effectiveAt: string;
  } | null>(null);

  const [form, setForm] = useState<FormState>(() => ({
    startDate: daysAgoIso(2),
    endDate: todayIso(),
    scopeMode: "all",
    gameIdsText: "",
    detectorId: "",
    params: {},
  }));

  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [stateSpaceText, setStateSpaceText] = useState<string>(
    stableJson(BOARD_STATE_SPACE_CONFIG_DEFAULTS),
  );
  const [stateSpaceError, setStateSpaceError] = useState<string | null>(null);

  const detectorRows = useMemo(() => detectorsQuery.data?.detectors ?? [], [detectorsQuery.data]);
  const selectedDetector = useMemo(
    () => detectorRows.find((d) => d.id === form.detectorId),
    [detectorRows, form.detectorId],
  );
  const parsedProps = useMemo(
    () => (selectedDetector !== undefined ? parseSchema(selectedDetector.paramsSchema) : []),
    [selectedDetector],
  );

  // When detectors first load, default-select board-mad and seed its params.
  useEffect(() => {
    if (detectorRows.length === 0) return;
    if (form.detectorId !== "") return;
    const initial = selectInitialDetector(detectorRows);
    const initialDetector = detectorRows.find((d) => d.id === initial);
    const props = initialDetector !== undefined ? parseSchema(initialDetector.paramsSchema) : [];
    setForm((prev) => ({
      ...prev,
      detectorId: initial,
      params: withBoardStateSpaceDefaults(initial, defaultValuesFor(props)),
    }));
  }, [detectorRows, form.detectorId]);

  function updateParam(name: string, next: unknown): void {
    setForm((prev) => ({ ...prev, params: { ...prev.params, [name]: next } }));
  }

  // Mirror of updateParam for the board lane's nested params under ensemble-or.
  // For board-mad it falls back to updateParam.
  function updateBoardParam(name: string, next: unknown): void {
    setForm((prev) => {
      if (prev.detectorId === ENSEMBLE_OR_DETECTOR_ID) {
        const prevBoard = isPlainRecord(prev.params["board"]) ? prev.params["board"] : {};
        return {
          ...prev,
          params: { ...prev.params, board: { ...prevBoard, [name]: next } },
        };
      }
      return { ...prev, params: { ...prev.params, [name]: next } };
    });
  }

  function updateBoardParams(patch: Readonly<Record<string, unknown>>): void {
    setForm((prev) => {
      if (prev.detectorId === ENSEMBLE_OR_DETECTOR_ID) {
        const prevBoard = isPlainRecord(prev.params["board"]) ? prev.params["board"] : {};
        return {
          ...prev,
          params: { ...prev.params, board: { ...prevBoard, ...patch } },
        };
      }
      return { ...prev, params: { ...prev.params, ...patch } };
    });
  }

  function updateBoardStateSpaceText(raw: string): void {
    setStateSpaceText(raw);
    try {
      const parsedUnknown: unknown = JSON.parse(raw);
      const parsed = BoardStateSpaceConfigSchema.parse(parsedUnknown);
      setStateSpaceError(null);
      updateBoardParam(STATE_SPACE_PARAM_NAME, parsed);
    } catch {
      setStateSpaceError("State-space config must be valid JSON matching the model schema.");
    }
  }

  function applyBoardProfile(profileId: BoardProfileId): void {
    if (profileId === "custom") return;
    const preset = BOARD_PROFILE_PRESETS.find((profile) => profile.id === profileId);
    if (preset !== undefined) updateBoardParams(preset.patch);
  }

  function handleDetectorChange(id: string): void {
    const next = detectorRows.find((d) => d.id === id);
    const props = next !== undefined ? parseSchema(next.paramsSchema) : [];
    setForm((prev) => ({
      ...prev,
      detectorId: id,
      params: withBoardStateSpaceDefaults(id, defaultValuesFor(props)),
    }));
  }

  // Window validation: end must be after start; span must be <= 28 days. Same
  // bounds as the API route (apps/api/src/routes/backtest.ts).
  const windowDays = diffDaysExclusive(form.startDate, form.endDate);
  const windowTooLong = Number.isFinite(windowDays) && windowDays > MAX_WINDOW_DAYS;
  const windowReversed = Number.isFinite(windowDays) && windowDays < 0;
  const windowError = windowReversed
    ? "End date must be on or after the start date."
    : windowTooLong
      ? `Window must be ${String(MAX_WINDOW_DAYS)} days or fewer.`
      : null;

  const parsedGameIds = parseGameIds(form.gameIdsText);
  const tooManyGames = form.scopeMode === "specific" && parsedGameIds.length > MAX_GAMES;
  const noGamesSelected = form.scopeMode === "specific" && parsedGameIds.length === 0;
  const gameIdsError = tooManyGames
    ? `Up to ${String(MAX_GAMES)} game ids; you entered ${String(parsedGameIds.length)}.`
    : null;

  const canRun =
    selectedDetector !== undefined &&
    windowError === null &&
    !tooManyGames &&
    !noGamesSelected &&
    stateSpaceError === null &&
    !runMutation.isPending;

  function buildRequest(): BacktestRequest {
    const base: BacktestRequest = {
      detector_id: form.detectorId,
      params: form.params,
      window: {
        start: isoDateToWindowStart(form.startDate),
        end: isoDateToWindowEnd(form.endDate),
      },
    };
    if (form.scopeMode === "specific") {
      return { ...base, game_ids: parsedGameIds };
    }
    return base;
  }

  function handleRun(): void {
    if (!canRun) return;
    const req = buildRequest();
    runMutation.mutate(req, {
      onSuccess: (data) => {
        setSnapshot({
          detectorId: req.detector_id,
          params: req.params,
          response: data,
        });
      },
    });
  }

  const detectorsBanner =
    detectorsQuery.isError && isNetworkError(detectorsQuery.error) ? (
      <ApiUnreachableBanner error={detectorsQuery.error} />
    ) : (
      <QueryErrorBanner query={detectorsQuery} label="Failed to load detectors" />
    );

  const recomputeView = snapshot !== null ? clampedStats(snapshot, form.params) : null;
  const stale = snapshot !== null ? snapshotIsStale(snapshot, form.params) : false;
  const resultKMad = readRenderedResultKMad(
    snapshot,
    form.params,
    selectedDetector?.id,
    recomputeView,
  );
  const firesPerGamePreview = formatFiresPerGamePreview(
    runMutation.isPending,
    snapshot !== null,
    recomputeView?.stats.firesPerGame ?? null,
  );
  const boardLikeSelected = isBoardLikeDetector(selectedDetector?.id);
  const currentSensitivity = readBoardParam(
    form.params,
    selectedDetector?.id,
    KMAD_PARAM_NAME,
    K_MAD_LIVE,
  );
  const currentBucketSeconds = readBoardParam(
    form.params,
    selectedDetector?.id,
    BUCKET_SECONDS_PARAM_NAME,
    BUCKET_SECONDS_DEFAULT,
  );
  const currentBaselineMode = readBoardStringParam(
    form.params,
    selectedDetector?.id,
    BASELINE_MODE_PARAM_NAME,
    BASELINE_MODE_DEFAULT,
  );
  const currentOpeningBaselineBuckets = readBoardParam(
    form.params,
    selectedDetector?.id,
    OPENING_BASELINE_PARAM_NAME,
    OPENING_BASELINE_DEFAULT,
  );
  const currentOpeningRampCompleteBuckets = readBoardParam(
    form.params,
    selectedDetector?.id,
    OPENING_RAMP_COMPLETE_PARAM_NAME,
    OPENING_RAMP_COMPLETE_DEFAULT,
  );
  const currentMemoryBuckets = readBoardParam(
    form.params,
    selectedDetector?.id,
    TRAILING_PARAM_NAME,
    TRAILING_DEFAULT,
  );
  const currentWarmupBuckets = readBoardParam(
    form.params,
    selectedDetector?.id,
    WARMUP_PARAM_NAME,
    WARMUP_DEFAULT,
  );
  const currentStateSpace = readBoardStateSpaceConfig(form.params, selectedDetector?.id);
  const currentStateSpaceJson = stableJson(currentStateSpace);
  const currentProfile = inferBoardProfile(currentBaselineMode, currentBucketSeconds);

  useEffect(() => {
    if (!boardLikeSelected) return;
    setStateSpaceText(currentStateSpaceJson);
    setStateSpaceError(null);
  }, [boardLikeSelected, currentStateSpaceJson, selectedDetector?.id]);

  // Phase B4 + Codex review P2 (2026-05-25): live-parity computation +
  // promote-to-live actions. For ensemble-or we ALSO compare the offprice
  // thresholds (the live ensemble route reads them from defaults in
  // apps/api/src/routes/ensemble-or.ts) so the banner doesn't claim
  // parity while the offprice thresholds differ silently.
  const liveDefaults = settingsQuery.data?.detectorDefaults ?? null;
  const liveProfile =
    liveDefaults !== null
      ? inferBoardProfile(liveDefaults.baselineMode, liveDefaults.bucketSeconds)
      : null;
  const isEnsembleSelected = selectedDetector?.id === ENSEMBLE_OR_DETECTOR_ID;
  const currentEnsembleOffprice = isEnsembleSelected
    ? readEnsembleOffpriceParams(form.params)
    : null;
  const boardLikeForParity = boardLikeSelected;
  const boardFieldsMatchLive =
    liveDefaults !== null && boardLikeForParity
      ? currentBaselineMode === liveDefaults.baselineMode &&
        currentBucketSeconds === liveDefaults.bucketSeconds &&
        currentOpeningBaselineBuckets === liveDefaults.openingBaselineBuckets &&
        currentOpeningRampCompleteBuckets === liveDefaults.openingRampCompleteBuckets &&
        currentMemoryBuckets === liveDefaults.trailingBuckets &&
        currentWarmupBuckets === liveDefaults.warmupBuckets &&
        currentSensitivity === liveDefaults.kMadLive &&
        jsonValuesEqual(currentStateSpace, liveDefaults.stateSpace)
      : null;
  const offpriceFieldsMatchLive =
    liveDefaults !== null && isEnsembleSelected && currentEnsembleOffprice !== null
      ? currentEnsembleOffprice.minVolumeShare === liveDefaults.offPriceMinVolumeShare &&
        currentEnsembleOffprice.minOffPriceDistance === liveDefaults.offPriceMinOffPriceDistance
      : null;
  const paramsMatchLive: boolean | null =
    boardFieldsMatchLive === null
      ? null
      : isEnsembleSelected
        ? boardFieldsMatchLive && offpriceFieldsMatchLive === true
        : boardFieldsMatchLive;
  const canPromote = boardLikeForParity && liveDefaults !== null && paramsMatchLive === false;

  function buildPromoteDefaults(): DetectorDefaults | null {
    if (liveDefaults === null) return null;
    // Narrow the current baselineMode string to the enum the API expects.
    // Defensively fall back to the live profile when the form holds a value
    // that doesn't match (e.g. an unknown profile chosen via custom config).
    const narrowedMode: DetectorDefaults["baselineMode"] =
      currentBaselineMode === BOARD_MAD_BASELINE_MODE_TRAILING ||
      currentBaselineMode === BOARD_MAD_BASELINE_MODE_OPENING_RAMP ||
      currentBaselineMode === BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND
        ? currentBaselineMode
        : liveDefaults.baselineMode;
    // Codex review P2: when promoting an ensemble-or backtest, also write
    // the offprice thresholds so the live /v1/ensemble-or route sees the
    // same values the operator was previewing. Standalone board-mad
    // backtests don't carry offprice params, so we leave those at their
    // current live values.
    const offpriceFields: Pick<
      DetectorDefaults,
      "offPriceMinVolumeShare" | "offPriceMinOffPriceDistance"
    > =
      isEnsembleSelected && currentEnsembleOffprice !== null
        ? {
            offPriceMinVolumeShare: currentEnsembleOffprice.minVolumeShare,
            offPriceMinOffPriceDistance: currentEnsembleOffprice.minOffPriceDistance,
          }
        : {
            offPriceMinVolumeShare: liveDefaults.offPriceMinVolumeShare,
            offPriceMinOffPriceDistance: liveDefaults.offPriceMinOffPriceDistance,
          };
    return {
      ...liveDefaults,
      baselineMode: narrowedMode,
      bucketSeconds: currentBucketSeconds,
      openingBaselineBuckets: currentOpeningBaselineBuckets,
      openingRampCompleteBuckets: currentOpeningRampCompleteBuckets,
      trailingBuckets: currentMemoryBuckets,
      warmupBuckets: currentWarmupBuckets,
      kMadLive: currentSensitivity,
      stateSpace: currentStateSpace,
      ...offpriceFields,
    };
  }

  function openPromoteDialog(): void {
    const next = buildPromoteDefaults();
    if (next === null) return;
    setPendingPromote({ next, effectiveAt: nextUtcNineAmIso() });
  }

  function applyPromoteNow(): void {
    if (pendingPromote === null) return;
    promoteMutation.mutate(pendingPromote.next, {
      onSuccess: () => {
        setPendingPromote(null);
      },
    });
  }

  function schedulePromote(): void {
    if (pendingPromote === null) return;
    promoteScheduleMutation.mutate(
      { defaults: pendingPromote.next, effectiveAt: pendingPromote.effectiveAt },
      {
        onSuccess: () => {
          setPendingPromote(null);
        },
      },
    );
  }

  const promoteError =
    promoteMutation.error?.message ?? promoteScheduleMutation.error?.message ?? undefined;

  return (
    <section data-testid="backtest-page">
      {pendingPromote !== null ? (
        <PromotionDialog
          dataTestIdRoot="backtest-promote"
          title="Promote these backtest params to live"
          body={
            <>
              <p>
                Writes the live detector defaults read by Recent and Live (
                <span className="font-mono text-text-md">
                  ~/signal-console/data/detector-defaults.json
                </span>
                ). The runtime detector version gets a defaults hash and old cached runs miss
                naturally — next /v1/board call recomputes against the new profile.
              </p>
              <p className="mt-3">
                Schedule lands at <span className="font-mono">{pendingPromote.effectiveAt}</span>{" "}
                (next 09:00 UTC, off NBA hours per David&apos;s playbook).
              </p>
            </>
          }
          effectiveAt={pendingPromote.effectiveAt}
          onApplyNow={applyPromoteNow}
          onSchedule={schedulePromote}
          onCancel={() => {
            setPendingPromote(null);
          }}
          isApplying={promoteMutation.isPending}
          isScheduling={promoteScheduleMutation.isPending}
          errorMessage={promoteError}
        />
      ) : null}
      {detectorsBanner}

      <div className="flex items-baseline justify-between">
        <h2 className="text-text-hi text-lg font-semibold">Backtest</h2>
        <p data-testid="backtest-meta" className="tabular font-mono text-xs text-text-lo">
          POST /v1/backtest
        </p>
      </div>
      <p className="mt-2 text-sm text-text-md">
        Replay a detector over a window. Results stay pinned to the last server run until you rerun
        with the current params.
      </p>

      <form
        className="mt-8 space-y-8"
        onSubmit={(e) => {
          e.preventDefault();
          handleRun();
        }}
      >
        <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(280px,380px)_minmax(0,1fr)] xl:items-start xl:gap-8">
          <div className="space-y-8">
            {/* Date range */}
            <div data-testid="backtest-window">
              <div className={SECTION_LABEL_CLASS}>Window</div>
              <div className="mt-3 flex flex-wrap items-end gap-4">
                <label className="flex flex-col gap-1">
                  <span className={FIELD_LABEL_CLASS}>Start</span>
                  <input
                    type="date"
                    value={form.startDate}
                    onChange={(e) => {
                      setForm((prev) => ({ ...prev, startDate: e.target.value }));
                    }}
                    className={INPUT_CLASS}
                    data-testid="backtest-window-start"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={FIELD_LABEL_CLASS}>End</span>
                  <input
                    type="date"
                    value={form.endDate}
                    onChange={(e) => {
                      setForm((prev) => ({ ...prev, endDate: e.target.value }));
                    }}
                    className={INPUT_CLASS}
                    data-testid="backtest-window-end"
                  />
                </label>
                <span className={FIELD_HINT_CLASS} data-testid="backtest-window-span">
                  {Number.isFinite(windowDays) ? `${String(windowDays)} day span` : "—"}
                </span>
              </div>
              {windowError !== null ? (
                <p
                  data-testid="backtest-window-error"
                  className="mt-2 font-mono text-xs text-accent-yellow"
                >
                  {windowError}
                </p>
              ) : null}
            </div>

            {/* Game scope */}
            <div data-testid="backtest-scope">
              <div className={SECTION_LABEL_CLASS}>Game scope</div>
              <div className="mt-3 flex flex-col gap-3">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    name="backtest-scope-mode"
                    value="all"
                    checked={form.scopeMode === "all"}
                    onChange={() => {
                      setForm((prev) => ({ ...prev, scopeMode: "all" }));
                    }}
                    data-testid="backtest-scope-all"
                  />
                  <span className="text-sm text-text-md">
                    All games in window (discovered up to {String(MAX_GAMES)})
                  </span>
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    name="backtest-scope-mode"
                    value="specific"
                    checked={form.scopeMode === "specific"}
                    onChange={() => {
                      setForm((prev) => ({ ...prev, scopeMode: "specific" }));
                    }}
                    data-testid="backtest-scope-specific"
                  />
                  <span className="text-sm text-text-md">
                    Specific game ids (one per line; up to {String(MAX_GAMES)})
                  </span>
                </label>
                {form.scopeMode === "specific" ? (
                  <div className="flex flex-col gap-1">
                    <textarea
                      value={form.gameIdsText}
                      onChange={(e) => {
                        setForm((prev) => ({ ...prev, gameIdsText: e.target.value }));
                      }}
                      placeholder="nba-0042500222"
                      className={TEXTAREA_CLASS}
                      data-testid="backtest-game-ids"
                      rows={4}
                    />
                    <span className={FIELD_HINT_CLASS} data-testid="backtest-game-ids-count">
                      {String(parsedGameIds.length)} id{parsedGameIds.length === 1 ? "" : "s"}
                    </span>
                    {gameIdsError !== null ? (
                      <p
                        data-testid="backtest-scope-error"
                        className="font-mono text-xs text-accent-yellow"
                      >
                        {gameIdsError}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            {/* Detector selector */}
            <div data-testid="backtest-detector">
              <div className={SECTION_LABEL_CLASS}>Detector</div>
              <div className="mt-3">
                {detectorsQuery.isLoading ? (
                  <p className="text-sm text-text-md">Loading detectors…</p>
                ) : detectorRows.length === 0 ? (
                  <p className="text-sm text-text-md">No detectors registered.</p>
                ) : (
                  <select
                    value={form.detectorId}
                    onChange={(e) => {
                      handleDetectorChange(e.target.value);
                    }}
                    className={SELECT_CLASS}
                    data-testid="backtest-detector-select"
                    aria-label="detector"
                  >
                    {detectorRows.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.displayName}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            <div className="border-t border-surface-1 pt-6" data-testid="backtest-run-hub">
              <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
                <button
                  type="submit"
                  disabled={!canRun}
                  className={`${BUTTON_PRIMARY_CLASS} px-7 py-2 text-base`}
                  data-testid="backtest-run-button"
                >
                  {runMutation.isPending ? "Running…" : "Run"}
                </button>
                <span className="max-w-[28ch] text-xs text-text-lo">
                  Replays the current window and control settings.
                </span>
              </div>
              {/* Phase B4: parity banner + Apply-to-Live button. Only meaningful
                  for board-mad / ensemble-or (board lane); off-price-print
                  standalone doesn't have live-promotable knobs surfaced in
                  this form yet. liveDefaults can be null during initial load
                  or if /v1/settings is unreachable. */}
              {boardLikeForParity && liveDefaults !== null && liveProfile !== null ? (
                <div
                  className="mt-4 flex flex-wrap items-center gap-3 border border-surface-2 bg-surface-0-from/50 px-3 py-2"
                  data-testid="backtest-live-parity"
                >
                  <span className="font-mono text-xs uppercase tracking-wider text-text-lo">
                    Live profile:
                  </span>
                  <span
                    className="font-mono text-xs text-text-hi"
                    data-testid="backtest-live-profile"
                  >
                    {liveProfile}
                  </span>
                  <span
                    className={
                      paramsMatchLive === true
                        ? "font-mono text-xs text-accent-green"
                        : "font-mono text-xs text-accent-yellow"
                    }
                    data-testid="backtest-live-match"
                  >
                    {paramsMatchLive === true
                      ? "these params match live"
                      : "these params differ from live"}
                  </span>
                  <button
                    type="button"
                    onClick={openPromoteDialog}
                    disabled={!canPromote}
                    className="ml-auto border border-accent-yellow px-3 py-1 text-xs font-mono uppercase tracking-wider text-text-hi hover:bg-accent-yellow hover:text-surface-0-from disabled:opacity-50"
                    data-testid="backtest-apply-to-live"
                    title={
                      canPromote === true
                        ? "Open the promote-to-live dialog"
                        : "Already matches live, nothing to promote"
                    }
                  >
                    Apply to live
                  </button>
                </div>
              ) : null}
              {runMutation.isError ? (
                <span
                  data-testid="backtest-run-error"
                  className="mt-3 block font-mono text-xs text-accent-yellow"
                >
                  {runMutation.error.message}
                </span>
              ) : null}
            </div>
          </div>

          {boardLikeSelected ? (
            <div className="min-w-0 space-y-6">
              <SignalTimingPanel
                profileValue={currentProfile}
                baselineMode={currentBaselineMode}
                memoryValue={currentMemoryBuckets}
                bucketSeconds={currentBucketSeconds}
                openingBaselineValue={currentOpeningBaselineBuckets}
                openingRampCompleteValue={currentOpeningRampCompleteBuckets}
                warmupValue={currentWarmupBuckets}
                onProfileChange={applyBoardProfile}
                onBaselineModeChange={(next) => {
                  updateBoardParam(BASELINE_MODE_PARAM_NAME, next);
                }}
                onMemoryChange={(next) => {
                  updateBoardParam(TRAILING_PARAM_NAME, next);
                }}
                onOpeningBaselineChange={(next) => {
                  updateBoardParam(OPENING_BASELINE_PARAM_NAME, next);
                }}
                onOpeningRampCompleteChange={(next) => {
                  updateBoardParam(OPENING_RAMP_COMPLETE_PARAM_NAME, next);
                }}
                onWarmupChange={(next) => {
                  updateBoardParam(WARMUP_PARAM_NAME, next);
                }}
              />
              <div
                className="flex flex-col items-center gap-4 border border-surface-2 bg-surface-0-from/70 px-4 py-5 sm:px-5"
                data-testid="backtest-sensitivity-dial"
              >
                <SensitivityDial
                  value={currentSensitivity}
                  firesPerGamePreview={firesPerGamePreview}
                  onChange={(next) => {
                    updateBoardParam(KMAD_PARAM_NAME, next);
                  }}
                />
                <p className="max-w-[42ch] text-center text-xs text-text-md">
                  The center readout is estimated fires per game for the last run. It updates in
                  memory as the trigger moves.
                </p>
              </div>
              <div
                className="border border-surface-2 bg-surface-0-from/70 px-4 py-5 sm:px-5"
                data-testid="backtest-state-space-config"
              >
                <div className="text-text-lo text-xs uppercase tracking-[0.08em] font-sans">
                  <ExplainerCard id="settings-state-space-config">
                    <span>State-space config</span>
                  </ExplainerCard>
                </div>
                <p className="mt-2 max-w-[64ch] text-xs text-text-md">
                  Advanced JSON object for trigger shape, breadth normalization, process noise,
                  anchors, and variance adaptation. Any change here requires a rerun.
                </p>
                <textarea
                  value={stateSpaceText}
                  onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
                    updateBoardStateSpaceText(e.target.value);
                  }}
                  data-testid="backtest-state-space-input"
                  aria-label="State-space config"
                  className="mt-3 min-h-64 w-full border border-surface-2 bg-surface-0-from px-3 py-2 text-xs font-mono text-text-hi focus:border-accent-green focus:outline-none"
                />
                {stateSpaceError === null ? (
                  <p className="mt-2 text-xs text-text-lo">
                    The browser keeps showing the last server snapshot until you rerun with this
                    advanced config.
                  </p>
                ) : (
                  <p
                    data-testid="backtest-state-space-error"
                    className="mt-2 font-mono text-xs text-accent-yellow"
                  >
                    {stateSpaceError}
                  </p>
                )}
              </div>
            </div>
          ) : null}
        </div>

        {selectedDetector !== undefined && parsedProps.length > 0 ? (
          <div
            data-testid="backtest-param-form"
            className="grid grid-cols-[max-content_1fr] gap-x-8"
          >
            {parsedProps
              .filter((p) => {
                // Ensemble-or's top-level params are nested objects (board,
                // offprice) that parseSchema returns as kind="unknown". They
                // render as bare placeholder rows with no controls. Hide them;
                // the dials own the board lane, and off-price thresholds are
                // runtime-tunable through Settings (phase B3) — the parity
                // banner + Apply-to-Live flow read/write them via
                // readEnsembleOffpriceParams (Codex review P2 fix).
                if (selectedDetector.id === ENSEMBLE_OR_DETECTOR_ID) {
                  return p.kind.kind !== "unknown";
                }
                // Board-mad: the sensitivity/lookback/opening controls replace these rows.
                return (
                  selectedDetector.id !== BOARD_MAD_DETECTOR_ID ||
                  (p.name !== KMAD_PARAM_NAME &&
                    p.name !== BASELINE_MODE_PARAM_NAME &&
                    p.name !== OPENING_BASELINE_PARAM_NAME &&
                    p.name !== OPENING_RAMP_COMPLETE_PARAM_NAME &&
                    p.name !== TRAILING_PARAM_NAME &&
                    p.name !== WARMUP_PARAM_NAME &&
                    p.name !== STATE_SPACE_PARAM_NAME)
                );
              })
              .map((p) => (
                <ParamRow
                  key={p.name}
                  detectorId={selectedDetector.id}
                  prop={p}
                  value={form.params[p.name]}
                  needsRerunHint={
                    selectedDetector.id === BOARD_MAD_DETECTOR_ID &&
                    isBoardMadPrebucketField(p.name)
                  }
                  onChange={(next) => {
                    updateParam(p.name, next);
                  }}
                />
              ))}
          </div>
        ) : null}

        {selectedDetector?.id === BOARD_MAD_DETECTOR_ID ? (
          <p data-testid="backtest-recompute-hint" className="text-xs text-text-lo max-w-[64ch]">
            Trigger and board-model timing recompute in memory after the first run. Changing
            bucketSeconds, weighting, or freshCapSeconds requires re-running.
          </p>
        ) : null}
      </form>

      {/* Results panel */}
      <ResultsPanel
        snapshot={snapshot}
        recompute={recomputeView}
        stale={stale}
        pending={runMutation.isPending}
        startDate={form.startDate}
        endDate={form.endDate}
        kMad={resultKMad}
      />
    </section>
  );
}

function ResultsPanel({
  snapshot,
  recompute,
  stale,
  pending,
  startDate,
  endDate,
  kMad,
}: {
  readonly snapshot: RunSnapshot | null;
  readonly recompute: RecomputeView | null;
  readonly stale: boolean;
  readonly pending: boolean;
  readonly startDate: string;
  readonly endDate: string;
  readonly kMad: number;
}): JSX.Element {
  return (
    <section
      data-testid="backtest-results"
      aria-labelledby="backtest-results-heading"
      className="mt-12 border-t border-surface-1 pt-6"
    >
      <h3 id="backtest-results-heading" className={SECTION_LABEL_CLASS}>
        Results
      </h3>
      {snapshot === null ? (
        <p data-testid="backtest-results-empty" className="mt-4 text-sm text-text-md max-w-[64ch]">
          {pending
            ? "Running backtest…"
            : "No backtest has run yet. Configure the form and click Run."}
        </p>
      ) : (
        <>
          <RunSummary snapshot={snapshot} recompute={recompute} stale={stale} />
          <PbpAnchoredIncidents
            observations={recompute?.observations ?? snapshot.response.observations}
            startDate={startDate}
            endDate={endDate}
          />
          <BacktestTimelines
            snapshotObservations={snapshot.response.observations}
            recomputedObservations={recompute?.observations ?? snapshot.response.observations}
            fromRecompute={recompute?.fromRecompute ?? false}
            k={kMad}
          />
        </>
      )}
    </section>
  );
}

function RunSummary({
  snapshot,
  recompute,
  stale,
}: {
  readonly snapshot: RunSnapshot;
  readonly recompute: RecomputeView | null;
  readonly stale: boolean;
}): JSX.Element {
  const stats = recompute?.stats ?? snapshot.response.stats;
  return (
    <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-3">
      <Stat label="fires/game">
        <MaybeExplain id="fires-per-game">
          <span data-testid="backtest-stat-fires-per-game">{stats.firesPerGame.toFixed(2)}</span>
        </MaybeExplain>
      </Stat>
      <Stat label="total fires">
        <span data-testid="backtest-stat-total-fires">{String(stats.totalFires)}</span>
      </Stat>
      <Stat label="games in window">
        <span data-testid="backtest-stat-games">{String(stats.gamesInWindow)}</span>
      </Stat>
      <div className="md:col-span-3">
        <p className="font-mono text-xs text-text-lo">
          run id <span data-testid="backtest-run-id">{String(snapshot.response.runId)}</span> ·{" "}
          {String(snapshot.response.observations.length)} observations
          {recompute?.fromRecompute === true ? " · client preview" : ""}
        </p>
        {stale ? (
          <p
            data-testid="backtest-stale-warning"
            className="mt-2 font-mono text-xs text-accent-yellow"
          >
            Params changed since last run — re-run to refresh.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Stat({
  label,
  children,
}: {
  readonly label: string;
  readonly children: JSX.Element;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className={FIELD_LABEL_CLASS}>{label}</span>
      <span className="text-text-hi text-2xl tabular font-mono">{children}</span>
    </div>
  );
}

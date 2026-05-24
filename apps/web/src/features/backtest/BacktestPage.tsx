// Backtest page (US-035).
//
// Scope of this story is the FORM SCAFFOLD: date range + game scope + detector
// selector + an auto-rendered editable param form + empty results panel. The
// Sensitivity rotary dial (US-036), live preview metric (US-037), per-game
// timeline (US-038), Reaves/Hartenstein anchor display (US-039), and warmup
// dial (US-042) attach in later stories.
//
// In-memory recompute (round-trip stability): editing sensitivity,
// signal timing, trailingBuckets, or warmupBuckets re-derives the fires/game stat from the cached
// observations (`applyClientRecompute`) without re-hitting /v1/backtest. The
// remaining knobs (bucketSeconds, weighting, freshCapSeconds) re-roll the
// prebucket so they require a fresh Run — the UI marks them as such.

import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, JSX } from "react";

import { ExplainerCard, explainers } from "@signal-console/ui";
import type { ExplainerId } from "@signal-console/ui";

import { ApiUnreachableBanner, isNetworkError } from "../../components/ApiUnreachableBanner";
import { QueryErrorBanner } from "../../components/QueryErrorBanner";
import {
  useBacktest,
  useDetectors,
  type BacktestObservation,
  type BacktestRequest,
  type BacktestResponse,
  type BacktestStats,
  type DetectorEntry,
} from "../../data/queries";
import { defaultValuesFor, parseSchema, type ParsedProperty } from "../../lib/paramsSchema";
import {
  applyClientRecompute,
  hasBoardMadPrebucketDrift,
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
  BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
  K_MAD_LIVE,
} from "@signal-console/detectors/board-mad/config";

const KMAD_PARAM_NAME = "kMad";
const BUCKET_SECONDS_PARAM_NAME = "bucketSeconds";
const BASELINE_MODE_PARAM_NAME = "baselineMode";
const OPENING_BASELINE_PARAM_NAME = "openingBaselineBuckets";
const OPENING_RAMP_COMPLETE_PARAM_NAME = "openingRampCompleteBuckets";
const TRAILING_PARAM_NAME = "trailingBuckets";
const WARMUP_PARAM_NAME = "warmupBuckets";
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

function readNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function readString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

// Both board-mad and ensemble-or share the board lane's sensitivity/baseline-timing knobs.
// The dials are the marquee Backtest UX so they render for either detector;
// the difference is just where in the params tree the values live.
function isBoardLikeDetector(id: string | undefined): boolean {
  return id === BOARD_MAD_DETECTOR_ID || id === ENSEMBLE_OR_DETECTOR_ID;
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
  "border border-surface-2 bg-surface-0 px-2 py-1 text-sm font-mono text-text-hi tabular focus:border-accent-green focus:outline-none";
const NUMBER_INPUT_CLASS = `${INPUT_CLASS} w-32`;
const SELECT_CLASS = `${INPUT_CLASS} w-40`;
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
  readonly baselineMode: string;
  readonly memoryValue: number;
  readonly bucketSeconds: number;
  readonly openingBaselineValue: number;
  readonly openingRampCompleteValue: number;
  readonly warmupValue: number;
  readonly onBaselineModeChange: (next: string) => void;
  readonly onMemoryChange: (next: number) => void;
  readonly onOpeningBaselineChange: (next: number) => void;
  readonly onOpeningRampCompleteChange: (next: number) => void;
  readonly onWarmupChange: (next: number) => void;
}

function SignalTimingPanel({
  baselineMode,
  memoryValue,
  bucketSeconds,
  openingBaselineValue,
  openingRampCompleteValue,
  warmupValue,
  onBaselineModeChange,
  onMemoryChange,
  onOpeningBaselineChange,
  onOpeningRampCompleteChange,
  onWarmupChange,
}: SignalTimingPanelProps): JSX.Element {
  return (
    <div
      data-testid="backtest-signal-timing-panel"
      className="border border-surface-2 bg-surface-0/70 px-5 py-4"
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
      <div className="mt-5 grid gap-6">
        <div className="grid gap-3">
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL_CLASS}>
              <ExplainerCard id="baseline-source-mode">Prior sample</ExplainerCard>
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
              <option value={BOARD_MAD_BASELINE_MODE_TRAILING}>Rolling current game</option>
              <option value={BOARD_MAD_BASELINE_MODE_OPENING_RAMP}>Opening sample ramp</option>
            </select>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>
                <ExplainerCard id="settings-opening-baseline-buckets">Opening sample</ExplainerCard>
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
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>
                <ExplainerCard id="settings-opening-ramp-complete-buckets">
                  Ramp complete
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
        </div>
        <MemoryDial value={memoryValue} bucketSeconds={bucketSeconds} onChange={onMemoryChange} />
        <div className="border-t border-surface-2 pt-5" data-testid="backtest-warmup-dial">
          <WarmupDial value={warmupValue} bucketSeconds={bucketSeconds} onChange={onWarmupChange} />
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
  const recomputed = applyClientRecompute(snapshot.detectorId, snapshot.response, currentParams);
  if (recomputed === null) {
    return {
      stats: snapshot.response.stats,
      observations: snapshot.response.observations,
      fromRecompute: false,
    };
  }
  return {
    stats: recomputed.stats,
    observations: recomputed.observations,
    fromRecompute: true,
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

// True when any param that the client cannot re-apply has drifted from the
// snapshot's last-run values. Board-like detectors can recompute sensitivity,
// volatility lookback, and opening holdoff in memory, but bucket/weighting/freshness changes still need
// a server run.
function snapshotIsStale(
  snapshot: RunSnapshot,
  currentParams: Readonly<Record<string, unknown>>,
): boolean {
  if (snapshot.detectorId === BOARD_MAD_DETECTOR_ID) {
    return hasBoardMadPrebucketDrift(snapshot.detectorId, snapshot.params, currentParams);
  }
  if (snapshot.detectorId === ENSEMBLE_OR_DETECTOR_ID) {
    if (hasBoardMadPrebucketDrift(snapshot.detectorId, snapshot.params, currentParams)) {
      return true;
    }
    return snapshot.params["offprice"] !== currentParams["offprice"];
  }
  for (const key of Object.keys(currentParams)) {
    if (snapshot.params[key] !== currentParams[key]) return true;
  }
  return false;
}

function selectInitialDetector(rows: readonly DetectorEntry[]): string {
  // Default to ensemble-or per the suspend-signal report §8.1 — the
  // recommended Stage 1 cascade that runs board-mad AND off-price-print
  // and unions their fires. Falls back to board-mad if ensemble-or isn't
  // registered (older API), then to whatever the first registered
  // detector is.
  const ensemble = rows.find((d) => d.id === ENSEMBLE_OR_DETECTOR_ID);
  if (ensemble !== undefined) return ensemble.id;
  const boardMad = rows.find((d) => d.id === BOARD_MAD_DETECTOR_ID);
  return boardMad?.id ?? rows[0]?.id ?? "";
}

export function BacktestPage(): JSX.Element {
  const detectorsQuery = useDetectors();
  const runMutation = useBacktest();

  const [form, setForm] = useState<FormState>(() => ({
    startDate: daysAgoIso(2),
    endDate: todayIso(),
    scopeMode: "all",
    gameIdsText: "",
    detectorId: "",
    params: {},
  }));

  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);

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
      params: defaultValuesFor(props),
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

  function handleDetectorChange(id: string): void {
    const next = detectorRows.find((d) => d.id === id);
    const props = next !== undefined ? parseSchema(next.paramsSchema) : [];
    setForm((prev) => ({
      ...prev,
      detectorId: id,
      params: defaultValuesFor(props),
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

  return (
    <section data-testid="backtest-page">
      {detectorsBanner}

      <div className="flex items-baseline justify-between">
        <h2 className="text-text-hi text-lg font-semibold">Backtest</h2>
        <p data-testid="backtest-meta" className="tabular font-mono text-xs text-text-lo">
          POST /v1/backtest
        </p>
      </div>
      <p className="mt-2 text-sm text-text-md">
        Replay a detector over a window. The sensitivity dial recomputes the live preview in memory
        after the first sweep — no API round-trip.
      </p>

      <form
        className="mt-8 space-y-8"
        onSubmit={(e) => {
          e.preventDefault();
          handleRun();
        }}
      >
        <div className="grid gap-8 xl:grid-cols-[minmax(300px,420px)_minmax(150px,220px)_minmax(360px,1fr)] xl:items-start">
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
          </div>

          <div
            className="flex h-full min-h-[120px] items-center justify-center xl:min-h-[320px]"
            data-testid="backtest-run-hub"
          >
            <div className="flex flex-col items-center gap-3 text-center">
              <button
                type="submit"
                disabled={!canRun}
                className={`${BUTTON_PRIMARY_CLASS} px-7 py-2 text-base`}
                data-testid="backtest-run-button"
              >
                {runMutation.isPending ? "Running…" : "Run"}
              </button>
              <span className="max-w-[18ch] text-xs text-text-lo">
                Replays the current window and control settings.
              </span>
              {runMutation.isError ? (
                <span
                  data-testid="backtest-run-error"
                  className="font-mono text-xs text-accent-yellow"
                >
                  {runMutation.error.message}
                </span>
              ) : null}
            </div>
          </div>

          {boardLikeSelected ? (
            <SignalTimingPanel
              baselineMode={currentBaselineMode}
              memoryValue={currentMemoryBuckets}
              bucketSeconds={currentBucketSeconds}
              openingBaselineValue={currentOpeningBaselineBuckets}
              openingRampCompleteValue={currentOpeningRampCompleteBuckets}
              warmupValue={currentWarmupBuckets}
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
          ) : (
            <div className="hidden xl:block" aria-hidden="true" />
          )}
        </div>

        {boardLikeSelected ? (
          <div className="flex flex-col items-center gap-4" data-testid="backtest-sensitivity-dial">
            <SensitivityDial
              value={currentSensitivity}
              firesPerGamePreview={firesPerGamePreview}
              onChange={(next) => {
                updateBoardParam(KMAD_PARAM_NAME, next);
              }}
            />
            <p className="max-w-[42ch] text-center text-xs text-text-md">
              The center readout is estimated fires per game for the last run. It updates in memory
              as sensitivity moves.
            </p>
          </div>
        ) : null}

        {selectedDetector !== undefined && parsedProps.length > 0 ? (
          <div
            data-testid="backtest-param-form"
            className="grid grid-cols-[max-content_1fr] gap-x-8"
          >
            {parsedProps
              .filter((p) => {
                // Ensemble-or's top-level params are nested objects (board,
                // offprice) that parseSchema returns as kind="unknown". They
                // render as bare placeholder rows ("BOARD —", "OFFPRICE —")
                // with no controls. Hide them; the dials own the board lane
                // and off-price thresholds run at their defaults until we add
                // nested sub-controls.
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
                    p.name !== WARMUP_PARAM_NAME)
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
            Sensitivity and signal timing recompute in memory after the first run. Changing
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
          {recompute?.fromRecompute === true ? " · in-memory recompute" : ""}
        </p>
        {stale ? (
          <p
            data-testid="backtest-stale-warning"
            className="mt-2 font-mono text-xs text-accent-yellow"
          >
            Prebucket params changed since last run — re-run to refresh.
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

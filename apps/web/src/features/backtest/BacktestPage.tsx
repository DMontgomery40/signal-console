// Backtest page (US-035).
//
// Scope of this story is the FORM SCAFFOLD: date range + game scope + detector
// selector + an auto-rendered editable param form + empty results panel. The
// Cry Wolf rotary dial (US-036), live preview metric (US-037), per-game
// timeline (US-038), Reaves/Hartenstein anchor display (US-039), and warmup
// dial (US-042) attach in later stories.
//
// In-memory recompute (round-trip stability): editing kMad, trailingBuckets,
// or warmupBuckets re-derives the fires/game stat from the cached
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
  isBoardMadPrebucketField,
  BOARD_MAD_DETECTOR_ID,
} from "./clientRecompute";
import { BacktestTimelines } from "./BacktestTimelines";
import { CryWolfDial } from "./CryWolfDial";
import { K_MAD_LIVE } from "@signal-console/detectors/board-mad/config";

const KMAD_PARAM_NAME = "kMad";

function readNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
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

// True when any param that drives prebucket has drifted from the snapshot's
// last-run values. Off-price-print has no prebucket params, so we look for
// drift on any field for non-board-mad detectors.
function snapshotIsStale(
  snapshot: RunSnapshot,
  currentParams: Readonly<Record<string, unknown>>,
): boolean {
  if (snapshot.detectorId === BOARD_MAD_DETECTOR_ID) {
    for (const key of Object.keys(currentParams)) {
      if (isBoardMadPrebucketField(key)) {
        if (snapshot.params[key] !== currentParams[key]) return true;
      }
    }
    return false;
  }
  for (const key of Object.keys(currentParams)) {
    if (snapshot.params[key] !== currentParams[key]) return true;
  }
  return false;
}

function selectInitialDetector(rows: readonly DetectorEntry[]): string {
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
        Replay a detector over a window. The K dial recomputes the live preview in memory after the
        first sweep — no API round-trip.
      </p>

      <form
        className="mt-8 space-y-8"
        onSubmit={(e) => {
          e.preventDefault();
          handleRun();
        }}
      >
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

          {/* Cry Wolf dial owns the kMad knob when board-mad is selected; the
              text-input row for kMad is omitted from the param grid below. The
              live-preview metric (US-037) sits directly below the dial so the
              eye tracks "K moves → fires/game moves" in one visual region. */}
          {selectedDetector?.id === BOARD_MAD_DETECTOR_ID ? (
            <div
              className="mt-8 flex flex-col items-center gap-8"
              data-testid="backtest-cry-wolf-dial"
            >
              <CryWolfDial
                value={readNumber(form.params[KMAD_PARAM_NAME], K_MAD_LIVE)}
                onChange={(next) => {
                  updateParam(KMAD_PARAM_NAME, next);
                }}
              />
              <LivePreview
                pending={runMutation.isPending}
                hasSnapshot={snapshot !== null}
                firesPerGame={recomputeView?.stats.firesPerGame ?? null}
                fromRecompute={recomputeView?.fromRecompute ?? false}
              />
            </div>
          ) : null}

          {selectedDetector !== undefined && parsedProps.length > 0 ? (
            <div
              data-testid="backtest-param-form"
              className="mt-4 grid grid-cols-[max-content_1fr] gap-x-8"
            >
              {parsedProps
                .filter(
                  (p) =>
                    selectedDetector.id !== BOARD_MAD_DETECTOR_ID || p.name !== KMAD_PARAM_NAME,
                )
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
            <p
              data-testid="backtest-recompute-hint"
              className="mt-3 text-xs text-text-lo max-w-[64ch]"
            >
              kMad, trailingBuckets, and warmupBuckets recompute in-memory after the first run — no
              API round-trip. Changing bucketSeconds, weighting, or freshCapSeconds requires
              re-running.
            </p>
          ) : null}
        </div>

        {/* Run button */}
        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={!canRun}
            className={BUTTON_PRIMARY_CLASS}
            data-testid="backtest-run-button"
          >
            {runMutation.isPending ? "Running…" : "Run"}
          </button>
          {runMutation.isError ? (
            <span data-testid="backtest-run-error" className="font-mono text-xs text-accent-yellow">
              {runMutation.error.message}
            </span>
          ) : null}
        </div>
      </form>

      {/* Results panel */}
      <ResultsPanel
        snapshot={snapshot}
        recompute={recomputeView}
        stale={stale}
        pending={runMutation.isPending}
      />
    </section>
  );
}

function ResultsPanel({
  snapshot,
  recompute,
  stale,
  pending,
}: {
  readonly snapshot: RunSnapshot | null;
  readonly recompute: RecomputeView | null;
  readonly stale: boolean;
  readonly pending: boolean;
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
          <BacktestTimelines
            snapshotObservations={snapshot.response.observations}
            recomputedObservations={recompute?.observations ?? snapshot.response.observations}
            fromRecompute={recompute?.fromRecompute ?? false}
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

// Live preview (US-037): "Estimated fires/game" — the headline metric that
// updates as the K dial moves. Reads from the same `recomputeView` the Results
// panel uses; never triggers an API call. The dial owns kMad; this readout is
// the visible feedback that K is doing something.
function LivePreview({
  pending,
  hasSnapshot,
  firesPerGame,
  fromRecompute,
}: {
  readonly pending: boolean;
  readonly hasSnapshot: boolean;
  readonly firesPerGame: number | null;
  readonly fromRecompute: boolean;
}): JSX.Element {
  const value =
    hasSnapshot && firesPerGame !== null ? firesPerGame.toFixed(2) : pending ? "…" : "—";
  return (
    <div className="flex flex-col items-center gap-1" data-testid="backtest-live-preview">
      <span className="text-text-lo text-xs uppercase tracking-[0.08em] font-sans">
        Estimated fires/game
      </span>
      <MaybeExplain id="fires-per-game">
        <span
          data-testid="backtest-live-fires-per-game"
          data-from-recompute={fromRecompute ? "1" : "0"}
          className="text-text-hi text-4xl tabular font-mono"
        >
          {value}
        </span>
      </MaybeExplain>
    </div>
  );
}

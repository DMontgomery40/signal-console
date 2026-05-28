import { useEffect, useMemo, useState, type JSX } from "react";

import { ApiUnreachableBanner, isNetworkError } from "../../components/ApiUnreachableBanner";
import { QueryErrorBanner } from "../../components/QueryErrorBanner";
import {
  useCreateKnownCase,
  useEnsembleOr,
  useGame,
  useKnownCases,
  useLive,
  type BoardObservation,
  type CreateKnownCaseRequest,
  type EnsembleOrBoardObservation,
  type EnsembleOrFire,
  type KnownCase,
  type QuoteTick,
} from "../../data/queries";
import { buildChartData, IntensityTimeline, type OffPriceMarkerSource } from "../live/LivePage";
import { FanoutPanel } from "../games/FanoutPanel";
import { participantLabel } from "../recent/RecentPage";

const INCIDENT_WINDOW_BEFORE_MS = 5 * 60 * 1000;
const INCIDENT_WINDOW_AFTER_MS = 5 * 60 * 1000;
const INCIDENT_WINDOW_MS = INCIDENT_WINDOW_BEFORE_MS + INCIDENT_WINDOW_AFTER_MS;
const INCIDENT_NAME_MAX_LENGTH = 240;
const CLAIM_MAX_LENGTH = 4000;
const OPTIONAL_TEXT_MAX_LENGTH = 2000;

const EMPTY_FORM = {
  incidentName: "",
  claim: "",
  utcTime: "",
  gameClock: "",
  period: "",
  teamOne: "",
  teamTwo: "",
  gameId: "",
  stat: "",
  creditedPlayer: "",
  rightfulPlayer: "",
  notes: "",
};

type IncidentFormState = typeof EMPTY_FORM;

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function formatTime(iso: string): string {
  if (iso.length === 0) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return TIME_FMT.format(d);
}

function caseGameId(incident: KnownCase): string {
  const local = incident.localBoardGameIds[0];
  return local !== undefined && local.length > 0 ? local : incident.gameId;
}

function clean(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function formPayload(form: IncidentFormState): CreateKnownCaseRequest {
  return {
    incidentName: form.incidentName.trim(),
    claim: form.claim.trim(),
    ...(clean(form.utcTime) === undefined ? {} : { utcTime: form.utcTime.trim() }),
    ...(clean(form.gameClock) === undefined ? {} : { gameClock: form.gameClock.trim() }),
    ...(clean(form.period) === undefined ? {} : { period: form.period.trim() }),
    ...(clean(form.teamOne) === undefined ? {} : { teamOne: form.teamOne.trim() }),
    ...(clean(form.teamTwo) === undefined ? {} : { teamTwo: form.teamTwo.trim() }),
    ...(clean(form.gameId) === undefined ? {} : { gameId: form.gameId.trim() }),
    ...(clean(form.stat) === undefined ? {} : { stat: form.stat.trim() }),
    ...(clean(form.creditedPlayer) === undefined
      ? {}
      : { creditedPlayer: form.creditedPlayer.trim() }),
    ...(clean(form.rightfulPlayer) === undefined
      ? {}
      : { rightfulPlayer: form.rightfulPlayer.trim() }),
    ...(clean(form.notes) === undefined ? {} : { notes: form.notes.trim() }),
    createdBy: "bet365 trading desk",
  };
}

function canSubmit(form: IncidentFormState): boolean {
  const hasName = form.incidentName.trim().length > 0;
  const hasClaim = form.claim.trim().length > 0;
  const hasTime = form.utcTime.trim().length > 0 || form.gameClock.trim().length > 0;
  const hasTeamOrGame =
    form.teamOne.trim().length > 0 ||
    form.teamTwo.trim().length > 0 ||
    form.gameId.trim().length > 0;
  return hasName && hasClaim && hasTime && hasTeamOrGame;
}

function originLabel(incident: KnownCase): string {
  return incident.origin === "desk-entered" ? "desk-entered" : "benchmark";
}

function caseStatusLabel(incident: KnownCase): string {
  if (incident.origin === "desk-entered") return "desk assertion";
  if (!incident.scoreable) return "not scoreable";
  if (incident.liveControl === null || !incident.liveControl.scoreable) return "scoreable";
  return "benchmark scoreable";
}

function incidentWindow(
  observations: readonly BoardObservation[],
  utcTime: string,
): BoardObservation[] {
  const anchor = Date.parse(utcTime);
  if (!Number.isFinite(anchor)) return [];
  const start = anchor - INCIDENT_WINDOW_BEFORE_MS;
  const end = anchor + INCIDENT_WINDOW_AFTER_MS;
  return observations.filter((obs) => {
    const bucketStart = Date.parse(obs.bucketStart);
    return Number.isFinite(bucketStart) && bucketStart >= start && bucketStart <= end;
  });
}

function isWithinIncidentWindow(iso: string, utcTime: string): boolean {
  const anchor = Date.parse(utcTime);
  const ms = Date.parse(iso);
  if (!Number.isFinite(anchor) || !Number.isFinite(ms)) return false;
  return ms >= anchor - INCIDENT_WINDOW_BEFORE_MS && ms <= anchor + INCIDENT_WINDOW_AFTER_MS;
}

function replayWindowEndIso(utcTime: string): string | null {
  const anchor = Date.parse(utcTime);
  if (!Number.isFinite(anchor)) return null;
  return new Date(anchor + INCIDENT_WINDOW_AFTER_MS).toISOString();
}

function bucketStartForAnchor(utcTime: string): string | null {
  const anchor = Date.parse(utcTime);
  if (!Number.isFinite(anchor)) return null;
  return new Date(Math.floor(anchor / 60_000) * 60_000).toISOString();
}

function eventBucket(
  observations: readonly BoardObservation[],
  utcTime: string,
): BoardObservation | null {
  const anchor = Date.parse(utcTime);
  if (!Number.isFinite(anchor)) return null;
  for (const obs of observations) {
    const start = Date.parse(obs.bucketStart);
    const end = Date.parse(obs.bucketEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start <= anchor && anchor < end) return obs;
  }
  return null;
}

function tickSourceCounts(ticks: readonly QuoteTick[]): readonly [string, number][] {
  const counts = new Map<string, number>();
  for (const tick of ticks) {
    const source = tick.source ?? "unknown";
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  maxLength = OPTIONAL_TEXT_MAX_LENGTH,
  required = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly placeholder?: string;
  readonly maxLength?: number;
  readonly required?: boolean;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-xs font-mono text-text-lo">
      <span>
        {label}
        {required ? <span className="text-accent-yellow"> *</span> : null}
      </span>
      <input
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        placeholder={placeholder}
        maxLength={maxLength}
        className="border border-surface-2 bg-surface-0-from px-3 py-2 text-sm text-text-hi outline-none focus:border-accent-green"
      />
    </label>
  );
}

function ClaimField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-xs font-mono text-text-lo md:col-span-2">
      <span>
        Desk claim <span className="text-accent-yellow">*</span>
      </span>
      <textarea
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        rows={4}
        placeholder="Trader-reported stat allocation"
        maxLength={CLAIM_MAX_LENGTH}
        className="resize-y border border-surface-2 bg-surface-0-from px-3 py-2 text-sm text-text-hi outline-none focus:border-accent-green"
      />
    </label>
  );
}

function IncidentForm({
  onCreated,
}: {
  readonly onCreated: (incident: KnownCase) => void;
}): JSX.Element {
  const [form, setForm] = useState<IncidentFormState>(EMPTY_FORM);
  const create = useCreateKnownCase();
  const ready = canSubmit(form);

  function update<K extends keyof IncidentFormState>(key: K, value: IncidentFormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <form
      data-testid="known-cases-form"
      className="border border-surface-2 bg-surface-1 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        create.mutate(formPayload(form), {
          onSuccess: (incident) => {
            setForm(EMPTY_FORM);
            onCreated(incident);
          },
        });
      }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h3 className="text-sm font-semibold text-text-hi">Add desk case</h3>
        <p className="font-mono text-xs text-text-lo">
          One time anchor + one team/game hint is enough.
        </p>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field
          label="Incident name"
          value={form.incidentName}
          required
          placeholder="Trader-reported case"
          maxLength={INCIDENT_NAME_MAX_LENGTH}
          onChange={(next) => {
            update("incidentName", next);
          }}
        />
        <Field
          label="UTC time"
          value={form.utcTime}
          placeholder="2026-05-25T00:16:22Z"
          onChange={(next) => {
            update("utcTime", next);
          }}
        />
        <Field
          label="Game clock"
          value={form.gameClock}
          placeholder="Q3 04:50"
          onChange={(next) => {
            update("gameClock", next);
          }}
        />
        <Field
          label="Period"
          value={form.period}
          placeholder="Q3"
          onChange={(next) => {
            update("period", next);
          }}
        />
        <Field
          label="Team one"
          value={form.teamOne}
          placeholder="OKC"
          onChange={(next) => {
            update("teamOne", next);
          }}
        />
        <Field
          label="Team two"
          value={form.teamTwo}
          placeholder="SAS"
          onChange={(next) => {
            update("teamTwo", next);
          }}
        />
        <Field
          label="Game ID"
          value={form.gameId}
          placeholder="nba-0042500314"
          onChange={(next) => {
            update("gameId", next);
          }}
        />
        <Field
          label="Stat family"
          value={form.stat}
          placeholder="points / rebound / assist"
          onChange={(next) => {
            update("stat", next);
          }}
        />
        <Field
          label="Credited/live side"
          value={form.creditedPlayer}
          placeholder="live box score"
          onChange={(next) => {
            update("creditedPlayer", next);
          }}
        />
        <Field
          label="Desk says"
          value={form.rightfulPlayer}
          placeholder="player or stat the desk wants tracked"
          onChange={(next) => {
            update("rightfulPlayer", next);
          }}
        />
        <ClaimField
          value={form.claim}
          onChange={(next) => {
            update("claim", next);
          }}
        />
        <Field
          label="Notes"
          value={form.notes}
          placeholder="ticket, trader initials, screen reference"
          onChange={(next) => {
            update("notes", next);
          }}
        />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={!ready || create.isPending}
          className="border border-accent-yellow px-3 py-1.5 text-sm font-medium text-text-hi transition-colors duration-fast ease-out hover:bg-accent-yellow hover:text-surface-0-from disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add case
        </button>
        {create.isError ? (
          <span className="font-mono text-xs text-negative" data-testid="known-cases-form-error">
            {create.error.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function IncidentRow({
  incident,
  selected,
  onSelect,
}: {
  readonly incident: KnownCase;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): JSX.Element {
  const replayGameId = caseGameId(incident);
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="known-case-row"
      data-incident-id={incident.id}
      data-selected={selected ? "true" : "false"}
      className={`relative w-full overflow-hidden bg-surface-1 text-left transition-colors duration-fast ease-out hover:bg-surface-2 focus:outline-none focus-visible:bg-surface-2 ${
        selected ? "ring-1 ring-accent-green" : ""
      }`}
    >
      <span aria-hidden className="absolute left-0 top-0 h-full w-[3px] bg-accent-yellow" />
      <span className="grid grid-cols-1 gap-2 px-4 py-4 sm:grid-cols-[1fr_auto] sm:items-baseline sm:gap-x-6 sm:px-5">
        <span className="min-w-0">
          <span className="block truncate text-base font-medium uppercase tracking-[0.06em] text-text-hi">
            {incident.incidentName}
          </span>
          <span className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-text-md">
            <span>{formatTime(incident.utcTime)}</span>
            <span>
              {incident.period || incident.clock ? `${incident.period} ${incident.clock}` : "—"}
            </span>
            <span>{replayGameId.length > 0 ? replayGameId : "no local game match"}</span>
            <span>{originLabel(incident)}</span>
          </span>
        </span>
        <span className="tabular font-mono text-sm text-accent-yellow">
          {caseStatusLabel(incident)}
        </span>
      </span>
    </button>
  );
}

function ReplayStatus({
  incident,
  gameId,
}: {
  readonly incident: KnownCase;
  readonly gameId: string;
}): JSX.Element | null {
  if (gameId.length === 0) {
    return (
      <p data-testid="known-case-no-game" className="font-mono text-sm text-accent-yellow">
        Stored. No local game/feed match yet.
      </p>
    );
  }
  if (incident.utcTime.length === 0) {
    return (
      <p data-testid="known-case-no-anchor" className="font-mono text-sm text-accent-yellow">
        Stored. Add a UTC anchor to replay the exact live window.
      </p>
    );
  }
  return null;
}

function IncidentReplay({ incident }: { readonly incident: KnownCase }): JSX.Element {
  const gameId = caseGameId(incident);
  const replayAt = replayWindowEndIso(incident.utcTime);
  const replayable = gameId.length > 0 && replayAt !== null;
  const replayGameId = replayable ? gameId : "";
  const game = useGame(gameId);
  const live = useLive(
    replayGameId,
    replayAt === null ? undefined : { at: replayAt, windowMs: INCIDENT_WINDOW_MS },
  );
  const ensemble = useEnsembleOr(replayGameId, replayAt === null ? undefined : { at: replayAt });
  const networkErrored =
    (live.isError && isNetworkError(live.error)) ||
    (game.isError && isNetworkError(game.error)) ||
    (ensemble.isError && isNetworkError(ensemble.error));
  const banner = networkErrored ? (
    <ApiUnreachableBanner error={live.error ?? ensemble.error ?? game.error ?? null} />
  ) : game.isError ? (
    <QueryErrorBanner query={game} label="Failed to load incident game metadata" />
  ) : live.isError ? (
    <QueryErrorBanner query={live} label="Failed to load incident tick window" />
  ) : ensemble.isError ? (
    <QueryErrorBanner query={ensemble} label="Failed to load incident live replay" />
  ) : null;
  const observations: readonly BoardObservation[] = (ensemble.data?.boardObservations ?? []).map(
    (b: EnsembleOrBoardObservation) => ({
      bucketStart: b.bucketStart,
      bucketEnd: b.bucketEnd,
      fired: b.fired,
      intensity: b.intensity,
      baselineMedian: b.baselineMedian,
      baselineMad: b.baselineMad,
      warmedUp: b.warmedUp,
    }),
  );
  const visibleObservations = incidentWindow(observations, incident.utcTime);
  const anchorBucket = eventBucket(observations, incident.utcTime);
  const fanoutBucketStart = anchorBucket?.bucketStart ?? bucketStartForAnchor(incident.utcTime);
  const offPriceEvents: readonly OffPriceMarkerSource[] = (ensemble.data?.fires ?? [])
    .filter((f: EnsembleOrFire) => f.lane === "offprice")
    .filter((f: EnsembleOrFire) => isWithinIncidentWindow(f.bucketStart, incident.utcTime))
    .map(
      (f: EnsembleOrFire): OffPriceMarkerSource => ({
        id: f.sourceMarketId !== undefined ? `${f.bucketStart}|${f.sourceMarketId}` : f.bucketStart,
        eventTimestamp: f.bucketStart,
      }),
    );
  const k = ensemble.data?.k ?? null;
  const chartData = buildChartData(visibleObservations, k ?? 0);
  const boardFires = visibleObservations.filter((obs) => obs.fired === 1);
  const tickCount = live.data?.ticks.length ?? 0;
  const sourceCounts = tickSourceCounts(live.data?.ticks ?? []);
  const replayLoaded =
    replayable &&
    live.data !== undefined &&
    ensemble.data !== undefined &&
    !live.isError &&
    !ensemble.isError;
  const replayLoading = replayable && (live.isLoading || ensemble.isLoading);
  const replayErrored = replayable && (live.isError || ensemble.isError);
  const currentCaught = replayLoaded && boardFires.length + offPriceEvents.length > 0;
  const statusText = !replayable
    ? "Current live replay: waiting for local game + UTC anchor"
    : replayLoading
      ? "Current live replay: loading incident window"
      : replayErrored
        ? "Current live replay: unavailable; see error above"
        : currentCaught
          ? `Current live replay: caught by ${String(boardFires.length)} board / ${String(
              offPriceEvents.length,
            )} off-price fire${boardFires.length + offPriceEvents.length === 1 ? "" : "s"} in ±5 min`
          : "Current live replay: no board/off-price fire in ±5 min";
  const liveWindowLabel =
    live.data !== undefined
      ? `${formatTime(live.data.windowStart)} → ${formatTime(live.data.windowEnd)}`
      : "incident ±5 min";
  const home = game.data === undefined ? "—" : participantLabel(game.data.homeParticipantJson);
  const away = game.data === undefined ? "—" : participantLabel(game.data.awayParticipantJson);
  const gameStatus = game.data?.status ?? "—";
  const sport = game.data?.sport ?? "NBA";
  const league = game.data?.league ?? "—";

  return (
    <section data-testid="known-case-replay" className="space-y-5">
      {banner}
      <div
        role="table"
        aria-label="Known case replay game"
        data-testid="known-case-game-bar"
        className="border border-surface-2 bg-surface-1 text-sm"
      >
        <div
          role="row"
          className="grid grid-cols-[1.5fr_0.7fr_0.8fr_0.8fr_0.8fr_0.8fr_0.8fr] gap-x-6 px-4 pb-3 pt-4 text-text-lo"
        >
          <span role="columnheader" className="font-medium">
            Case
          </span>
          <span role="columnheader" className="font-medium">
            Sport
          </span>
          <span role="columnheader" className="font-medium">
            League
          </span>
          <span role="columnheader" className="font-medium">
            Home
          </span>
          <span role="columnheader" className="font-medium">
            Away
          </span>
          <span role="columnheader" className="font-medium">
            Status
          </span>
          <span role="columnheader" className="font-medium">
            Fires
          </span>
        </div>
        <div
          role="row"
          className="grid grid-cols-[1.5fr_0.7fr_0.8fr_0.8fr_0.8fr_0.8fr_0.8fr] gap-x-6 border-t border-surface-1 px-4 py-3"
        >
          <span role="cell" className="min-w-0">
            <span
              className="block truncate font-medium uppercase tracking-[0.06em] text-text-hi"
              data-testid="known-case-title"
            >
              {incident.incidentName}
            </span>
            <span className="mt-1 block font-mono text-xs text-text-md">
              {gameId.length > 0 ? gameId : "no local game"} · {formatTime(incident.utcTime)} ·{" "}
              {incident.period || "—"} {incident.clock || ""}
            </span>
          </span>
          <span role="cell" className="text-text-md">
            {sport}
          </span>
          <span role="cell" className="text-text-md">
            {league}
          </span>
          <span role="cell" className="tabular font-mono text-text-hi">
            {home}
          </span>
          <span role="cell" className="tabular font-mono text-text-hi">
            {away}
          </span>
          <span role="cell" className="font-mono text-text-md">
            {gameStatus}
          </span>
          <span
            role="cell"
            className="tabular font-mono text-text-md"
            data-testid="known-case-fire-counts"
          >
            {replayLoaded
              ? `${String(boardFires.length)} board / ${String(offPriceEvents.length)} off-price`
              : "—"}
          </span>
        </div>
      </div>

      <div className="border border-surface-2 bg-surface-1 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <p
            className={`font-mono text-sm ${currentCaught ? "text-accent-yellow" : "text-text-hi"}`}
            data-testid="known-case-current-status"
          >
            {statusText}
          </p>
          <p className="font-mono text-xs text-text-lo" data-testid="known-case-source-counts">
            {sourceCounts.length === 0
              ? `${String(tickCount)} ticks`
              : sourceCounts.map(([source, count]) => `${source} ${String(count)}`).join(" · ")}
          </p>
        </div>
        <p className="mt-2 font-mono text-xs text-text-lo" data-testid="known-case-live-window">
          Live tick window: {liveWindowLabel}
        </p>
        <p className="mt-4 max-w-[80ch] text-sm text-text-md" data-testid="known-case-claim">
          {incident.claim}
        </p>
      </div>

      <ReplayStatus incident={incident} gameId={gameId} />

      {replayable ? (
        <div className="border border-surface-2 bg-surface-1 p-4">
          {ensemble.isLoading ? (
            <div
              className="h-72 w-full bg-surface-0-from"
              data-testid="known-case-replay-loading"
              role="status"
              aria-label="loading known case replay"
            />
          ) : ensemble.isError ? null : chartData.length === 0 ? (
            <div
              className="flex h-72 w-full items-center justify-center bg-surface-0-from"
              data-testid="known-case-replay-empty"
            >
              <p className="font-mono text-sm text-text-lo">
                No local board observations in the incident window.
              </p>
            </div>
          ) : (
            <div>
              <p className="mb-2 font-mono text-xs uppercase tracking-[0.08em] text-text-lo">
                Live intensity timeline ±5 min
              </p>
              <IntensityTimeline data={chartData} offPriceEvents={offPriceEvents} />
            </div>
          )}
        </div>
      ) : null}

      {anchorBucket !== null ? (
        <details className="mt-5 border-t border-surface-2 pt-4" open>
          <summary className="cursor-pointer font-mono text-sm text-text-hi">
            Incident bucket only
          </summary>
          <div
            className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-xs text-text-md sm:grid-cols-4"
            data-testid="known-case-anchor-bucket"
          >
            <span>{anchorBucket.bucketStart}</span>
            <span>intensity {anchorBucket.intensity.toFixed(3)}</span>
            <span>level {anchorBucket.baselineMedian.toFixed(3)}</span>
            <span>scale {anchorBucket.baselineMad.toFixed(3)}</span>
          </div>
        </details>
      ) : null}
      {replayable && fanoutBucketStart !== null ? (
        <div className="border border-surface-2 bg-surface-1 p-4" data-testid="known-case-fanout">
          <p className="mb-2 font-mono text-xs uppercase tracking-[0.08em] text-text-lo">
            Recent-style source drilldown ±5 min
          </p>
          <FanoutPanel gameId={gameId} bucketStart={fanoutBucketStart} />
        </div>
      ) : null}
    </section>
  );
}

export function KnownCasesPage(): JSX.Element {
  const cases = useKnownCases();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rows = useMemo(() => cases.data?.incidents ?? [], [cases.data?.incidents]);

  useEffect(() => {
    if (selectedId !== null || rows.length === 0) return;
    setSelectedId(rows[0]?.id ?? null);
  }, [rows, selectedId]);

  const selected = useMemo(
    () => rows.find((incident) => incident.id === selectedId) ?? rows[0] ?? null,
    [rows, selectedId],
  );

  const banner =
    cases.isError && isNetworkError(cases.error) ? (
      <ApiUnreachableBanner error={cases.error} />
    ) : (
      <QueryErrorBanner query={cases} label="Failed to load known cases" />
    );

  return (
    <section data-testid="known-cases-page">
      {banner}
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-text-hi">Known Cases</h2>
          <p className="mt-1 font-mono text-xs text-text-lo">
            {cases.isLoading
              ? "loading…"
              : cases.isError
                ? "—"
                : `${String(rows.length)} cases · ${String(
                    cases.data?.coverage.scoreableIncidents ?? 0,
                  )} benchmark scoreable`}
          </p>
        </div>
        <p className="max-w-[52ch] text-right text-xs text-text-md">
          Desk-entered cases are accepted as trader assertions; replay shows whether local feed
          evidence can match them.
        </p>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(360px,0.9fr)_minmax(520px,1.4fr)]">
        <div className="space-y-6">
          <IncidentForm
            onCreated={(incident) => {
              setSelectedId(incident.id);
            }}
          />
          <div className="space-y-3" data-testid="known-cases-list">
            {cases.isLoading && rows.length === 0 ? (
              <p className="text-sm text-text-md">Loading cases…</p>
            ) : cases.isError ? null : rows.length === 0 ? (
              <p className="text-sm text-text-md">No known cases loaded.</p>
            ) : (
              rows.map((incident) => (
                <IncidentRow
                  key={incident.id}
                  incident={incident}
                  selected={selected?.id === incident.id}
                  onSelect={() => {
                    setSelectedId(incident.id);
                  }}
                />
              ))
            )}
          </div>
        </div>
        <div>{selected === null ? null : <IncidentReplay incident={selected} />}</div>
      </div>
    </section>
  );
}

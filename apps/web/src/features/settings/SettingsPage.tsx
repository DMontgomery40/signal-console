// SettingsPage — diagnostic-only dashboard (US-026 / PRD §20).
//
// Five sections backed by useSettings():
//   - Detector defaults (US-053): runtime-editable sensitivity / signal timing /
//     freshCap / pbpPre / pbpPost. POST /v1/settings/detector-defaults writes
//     ~/signal-console/data/detector-defaults.json atomically; the API picks
//     up the new values within 5 s without restart.
//   - Database: gold-DB path/size/WAL/pageCount/pageSize/lastModified/mode.
//     A red banner shows above the section when mode !== 'read-only'.
//   - Sources: per-source rows when the ingest heartbeat is present, or an
//     'Ingest paused' notice plus last-known values when paused.
//   - Errors: tail of last 200 pino log entries with a level filter.
//   - About: appVersion, registered detectorVersions, dbSchemaVersion.
//
// Every label is wrapped in an ExplainerCard (US-053 AC #5) — yellow dashed
// underline = the project-wide explainer identity per US-050.
//
// 'Clear cache' is admin housekeeping — DELETE /v1/cache with a confirmation
// dialog (window.confirm), then refresh the settings query. The gold DB's size
// must not change as a side-effect (asserted in the test).

import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, JSX, ReactNode } from "react";

import {
  BOARD_MAD_BASELINE_MODE_DEFAULT,
  BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
  BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
  BOARD_MAD_BASELINE_MODE_TRAILING,
  BOARD_MAD_BUCKET_SECONDS_DEFAULT,
  BOARD_MAD_BUCKET_SECONDS_MAX,
  BOARD_MAD_BUCKET_SECONDS_MIN,
  BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
  BOARD_MAD_FRESH_CAP_SECONDS_MAX,
  BOARD_MAD_FRESH_CAP_SECONDS_MIN,
  BOARD_MAD_HISTORICAL_AWAY_WEIGHT_DEFAULT,
  BOARD_MAD_HISTORICAL_AWAY_WEIGHT_MAX,
  BOARD_MAD_HISTORICAL_AWAY_WEIGHT_MIN,
  BOARD_MAD_HISTORICAL_LAST_GAMES_DEFAULT,
  BOARD_MAD_HISTORICAL_LAST_GAMES_MAX,
  BOARD_MAD_HISTORICAL_LAST_GAMES_MIN,
  BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT,
  BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_MAX,
  BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_MIN,
  BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
  BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_MAX,
  BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_MIN,
  BOARD_MAD_K_MAD_MAX,
  BOARD_MAD_K_MAD_MIN,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_MAX,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_MIN,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_MAX,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_MIN,
  BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT,
  BOARD_MAD_RECENT_WALL_MINUTES_MAX,
  BOARD_MAD_RECENT_WALL_MINUTES_MIN,
  BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT,
  BOARD_MAD_RECENT_WALL_WEIGHT_MAX,
  BOARD_MAD_RECENT_WALL_WEIGHT_MIN,
  BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  BOARD_MAD_TRAILING_BUCKETS_MAX,
  BOARD_MAD_TRAILING_BUCKETS_MIN,
  BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT,
  BOARD_MAD_TRAILING_GAME_MINUTES_MAX,
  BOARD_MAD_TRAILING_GAME_MINUTES_MIN,
  BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
  BOARD_MAD_WARMUP_BUCKETS_MAX,
  BOARD_MAD_WARMUP_BUCKETS_MIN,
  K_MAD_LIVE,
} from "@signal-console/detectors/board-mad/config";
import { ExplainerCard } from "@signal-console/ui";
import type { ExplainerId } from "@signal-console/ui";

import { ApiUnreachableBanner, isNetworkError } from "../../components/ApiUnreachableBanner";
import { QueryErrorBanner } from "../../components/QueryErrorBanner";
import {
  useClearCache,
  useScheduleDetectorDefaults,
  useSettings,
  useUpdateDetectorDefaults,
  type DetectorDefaults,
  type Settings,
} from "../../data/queries";

type Sources = Settings["sources"];
type SourceRowMap = Readonly<
  Record<
    string,
    { lastSyncAt: string | null; lastError: string | null; rateLimitCooldown: string | null }
  >
>;

type LevelFilter = "all" | "info" | "warn" | "error" | "debug";
const LEVEL_FILTERS: readonly LevelFilter[] = ["all", "info", "warn", "error", "debug"];
const LEVEL_FILTER_SET: ReadonlySet<string> = new Set(LEVEL_FILTERS);

function parseLevelFilter(v: string): LevelFilter | null {
  if (!LEVEL_FILTER_SET.has(v)) return null;
  for (const candidate of LEVEL_FILTERS) {
    if (candidate === v) return candidate;
  }
  return null;
}

const KNOWN_SOURCES = ["nba-sidecar", "bet365", "kalshi", "polymarket"] as const;

const BYTES_FMT = new Intl.NumberFormat("en-US");

function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  const formatted =
    value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${formatted} ${units[exp] ?? "B"}`;
}

function formatBytesCell(bytes: number): string {
  return `${BYTES_FMT.format(bytes)} bytes (${humanBytes(bytes)})`;
}

function formatTimestamp(iso: string | null): string {
  if (iso === null || iso.length === 0) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString();
}

// Compact ExplainerCard-wrapped <dt>. Yellow dashed underline = the
// project-wide explainer identity (US-050 / US-053 AC #5).
function ExplainDt({ id, children }: { id: ExplainerId; children: ReactNode }): JSX.Element {
  return (
    <dt className="text-text-lo">
      <ExplainerCard id={id}>
        <span>{children}</span>
      </ExplainerCard>
    </dt>
  );
}

function ExplainHeader({ id, children }: { id: ExplainerId; children: ReactNode }): JSX.Element {
  return (
    <span role="columnheader" className="font-medium">
      <ExplainerCard id={id}>
        <span>{children}</span>
      </ExplainerCard>
    </span>
  );
}

// ── Detector defaults section (US-053) ──────────────────────────────────────

type NumericDetectorDefaultKey = Exclude<keyof DetectorDefaults, "baselineMode">;

const NUMERIC_DETECTOR_DEFAULT_FIELDS: ReadonlyArray<{
  readonly key: NumericDetectorDefaultKey;
  readonly label: string;
  readonly explainerId: ExplainerId;
  readonly step: number;
  readonly integer: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly unit: string;
}> = [
  {
    key: "kMadLive",
    label: "Live sensitivity",
    explainerId: "settings-k-mad-live",
    step: 0.1,
    integer: false,
    min: BOARD_MAD_K_MAD_MIN,
    max: BOARD_MAD_K_MAD_MAX,
    unit: "× MAD",
  },
  {
    key: "bucketSeconds",
    label: "Bucket size",
    explainerId: "settings-bucket-seconds",
    step: 10,
    integer: true,
    min: BOARD_MAD_BUCKET_SECONDS_MIN,
    max: BOARD_MAD_BUCKET_SECONDS_MAX,
    unit: "seconds",
  },
  {
    key: "openingBaselineBuckets",
    label: "Opening sample",
    explainerId: "settings-opening-baseline-buckets",
    step: 1,
    integer: true,
    min: BOARD_MAD_OPENING_BASELINE_BUCKETS_MIN,
    max: BOARD_MAD_OPENING_BASELINE_BUCKETS_MAX,
    unit: "buckets",
  },
  {
    key: "openingRampCompleteBuckets",
    label: "Ramp complete",
    explainerId: "settings-opening-ramp-complete-buckets",
    step: 1,
    integer: true,
    min: BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_MIN,
    max: BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_MAX,
    unit: "buckets",
  },
  {
    key: "trailingBuckets",
    label: "Volatility lookback",
    explainerId: "settings-trailing-buckets",
    step: 1,
    integer: true,
    min: BOARD_MAD_TRAILING_BUCKETS_MIN,
    max: BOARD_MAD_TRAILING_BUCKETS_MAX,
    unit: "buckets",
  },
  {
    key: "warmupBuckets",
    label: "Opening holdoff",
    explainerId: "settings-warmup-buckets",
    step: 1,
    integer: true,
    min: BOARD_MAD_WARMUP_BUCKETS_MIN,
    max: BOARD_MAD_WARMUP_BUCKETS_MAX,
    unit: "buckets",
  },
  {
    key: "freshCapSeconds",
    label: "Freshness cap",
    explainerId: "settings-fresh-cap-seconds",
    step: 30,
    integer: true,
    min: BOARD_MAD_FRESH_CAP_SECONDS_MIN,
    max: BOARD_MAD_FRESH_CAP_SECONDS_MAX,
    unit: "seconds",
  },
  {
    key: "historicalLastGames",
    label: "Historical games",
    explainerId: "settings-historical-last-games",
    step: 1,
    integer: true,
    min: BOARD_MAD_HISTORICAL_LAST_GAMES_MIN,
    max: BOARD_MAD_HISTORICAL_LAST_GAMES_MAX,
    unit: "games",
  },
  {
    key: "historicalAwayWeight",
    label: "Away/home split",
    explainerId: "settings-historical-away-weight",
    step: 0.05,
    integer: false,
    min: BOARD_MAD_HISTORICAL_AWAY_WEIGHT_MIN,
    max: BOARD_MAD_HISTORICAL_AWAY_WEIGHT_MAX,
    unit: "away share",
  },
  {
    key: "historicalPriorWeight",
    label: "Opening prior share",
    explainerId: "settings-historical-prior-weight",
    step: 0.05,
    integer: false,
    min: BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_MIN,
    max: BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_MAX,
    unit: "share",
  },
  {
    key: "historicalRampCompleteGameMinutes",
    label: "History ramp-out",
    explainerId: "settings-historical-ramp-complete-game-minutes",
    step: 0.5,
    integer: false,
    min: BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_MIN,
    max: BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_MAX,
    unit: "game min",
  },
  {
    key: "trailingGameMinutes",
    label: "Game-clock memory",
    explainerId: "settings-trailing-game-minutes",
    step: 0.5,
    integer: false,
    min: BOARD_MAD_TRAILING_GAME_MINUTES_MIN,
    max: BOARD_MAD_TRAILING_GAME_MINUTES_MAX,
    unit: "game min",
  },
  {
    key: "recentWallMinutes",
    label: "Recent all-clock tack-on",
    explainerId: "settings-recent-wall-minutes",
    step: 0.5,
    integer: false,
    min: BOARD_MAD_RECENT_WALL_MINUTES_MIN,
    max: BOARD_MAD_RECENT_WALL_MINUTES_MAX,
    unit: "wall min",
  },
  {
    key: "recentWallWeight",
    label: "Recent tack-on weight",
    explainerId: "settings-recent-wall-weight",
    step: 0.1,
    integer: false,
    min: BOARD_MAD_RECENT_WALL_WEIGHT_MIN,
    max: BOARD_MAD_RECENT_WALL_WEIGHT_MAX,
    unit: "×",
  },
  {
    key: "pbpPreBufferMs",
    label: "PBP pre-buffer",
    explainerId: "settings-pbp-pre-buffer-ms",
    step: 60_000,
    integer: true,
    unit: "ms",
  },
  {
    key: "pbpPostBufferMs",
    label: "PBP post-buffer",
    explainerId: "settings-pbp-post-buffer-ms",
    step: 10_000,
    integer: true,
    unit: "ms",
  },
];

const PBP_PRE_BUFFER_MS_DEFAULT = 5 * 60 * 1000;
const PBP_POST_BUFFER_MS_DEFAULT = 60_000;

// Fallback when /v1/settings hasn't reported them yet. Board MAD defaults come
// from the package config; PBP windows are local Settings/API defaults.
const BASELINE_DEFAULTS: DetectorDefaults = {
  kMadLive: K_MAD_LIVE,
  baselineMode: BOARD_MAD_BASELINE_MODE_DEFAULT,
  bucketSeconds: BOARD_MAD_BUCKET_SECONDS_DEFAULT,
  openingBaselineBuckets: BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
  openingRampCompleteBuckets: BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
  trailingBuckets: BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  warmupBuckets: BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
  freshCapSeconds: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
  historicalLastGames: BOARD_MAD_HISTORICAL_LAST_GAMES_DEFAULT,
  historicalAwayWeight: BOARD_MAD_HISTORICAL_AWAY_WEIGHT_DEFAULT,
  historicalPriorWeight: BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT,
  historicalRampCompleteGameMinutes: BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
  trailingGameMinutes: BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT,
  recentWallMinutes: BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT,
  recentWallWeight: BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT,
  pbpPreBufferMs: PBP_PRE_BUFFER_MS_DEFAULT,
  pbpPostBufferMs: PBP_POST_BUFFER_MS_DEFAULT,
};

const YELLOW_FLASH_MS = 200;

type DetectorProfileId = "opening-ramp-live" | "historical-blend" | "legacy-trailing" | "custom";

const DETECTOR_PROFILE_PRESETS: ReadonlyArray<{
  readonly id: Exclude<DetectorProfileId, "custom">;
  readonly label: string;
  readonly patch: Partial<DetectorDefaults>;
}> = [
  {
    id: "opening-ramp-live",
    label: "Opening ramp live",
    patch: {
      baselineMode: BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
      bucketSeconds: 60,
      openingBaselineBuckets: 4,
      openingRampCompleteBuckets: 20,
      trailingBuckets: 20,
      warmupBuckets: 8,
    },
  },
  {
    id: "historical-blend",
    label: "Historical to live",
    patch: {
      baselineMode: BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
      bucketSeconds: 30,
      openingBaselineBuckets: 3,
      openingRampCompleteBuckets: 16,
      trailingBuckets: 24,
      warmupBuckets: 4,
      historicalLastGames: BOARD_MAD_HISTORICAL_LAST_GAMES_DEFAULT,
      historicalAwayWeight: BOARD_MAD_HISTORICAL_AWAY_WEIGHT_DEFAULT,
      historicalPriorWeight: BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT,
      historicalRampCompleteGameMinutes: BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
      trailingGameMinutes: BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT,
      recentWallMinutes: BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT,
      recentWallWeight: BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT,
    },
  },
  {
    id: "legacy-trailing",
    label: "Legacy rolling",
    patch: {
      baselineMode: BOARD_MAD_BASELINE_MODE_TRAILING,
      bucketSeconds: 60,
      trailingBuckets: 20,
      warmupBuckets: 8,
    },
  },
];

function inferDetectorProfile(defaults: DetectorDefaults): DetectorProfileId {
  if (defaults.baselineMode === BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND) return "historical-blend";
  if (defaults.baselineMode === BOARD_MAD_BASELINE_MODE_TRAILING) return "legacy-trailing";
  if (defaults.bucketSeconds === 60) return "opening-ramp-live";
  return "custom";
}

function parseDetectorProfileId(value: string): DetectorProfileId {
  for (const profile of DETECTOR_PROFILE_PRESETS) {
    if (profile.id === value) return profile.id;
  }
  return "custom";
}

function nextUtcNineAm(now = new Date()): string {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 9, 0, 0, 0),
  );
  return next.toISOString();
}

function DetectorDefaultsSection({
  defaults,
}: {
  readonly defaults: DetectorDefaults;
}): JSX.Element {
  const mutation = useUpdateDetectorDefaults();
  const scheduleMutation = useScheduleDetectorDefaults();
  const [draft, setDraft] = useState<DetectorDefaults>(defaults);
  const [pendingProfile, setPendingProfile] = useState<{
    readonly label: string;
    readonly next: DetectorDefaults;
    readonly effectiveAt: string;
  } | null>(null);
  // Per-field "flash" set — populated immediately after a successful POST so
  // the changed field briefly highlights yellow per AC #3.
  const [flashing, setFlashing] = useState<ReadonlySet<keyof DetectorDefaults>>(new Set());

  // Sync local draft with server-reported defaults on first load + after a
  // successful write (server normalizes values through its Zod schema).
  useEffect(() => {
    setDraft(defaults);
  }, [defaults]);

  function updateField(key: NumericDetectorDefaultKey, raw: string): void {
    if (raw === "") return;
    const field = NUMERIC_DETECTOR_DEFAULT_FIELDS.find((f) => f.key === key);
    if (field === undefined) return;
    const parsed = field.integer ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) return;
    setDraft((prev) => ({ ...prev, [key]: parsed }));
  }

  function flashField(changedKey: keyof DetectorDefaults): void {
    const next = new Set(flashing);
    next.add(changedKey);
    setFlashing(next);
    // Clear the flash after 200 ms per AC #3.
    setTimeout(() => {
      setFlashing((prev) => {
        const without = new Set(prev);
        without.delete(changedKey);
        return without;
      });
    }, YELLOW_FLASH_MS);
  }

  function commitNext(changedKey: keyof DetectorDefaults, next: DetectorDefaults): void {
    if (next[changedKey] === defaults[changedKey]) return;
    mutation.mutate(next, {
      onSuccess: () => {
        flashField(changedKey);
      },
    });
  }

  function updateBaselineMode(raw: string): void {
    if (
      raw !== BOARD_MAD_BASELINE_MODE_TRAILING &&
      raw !== BOARD_MAD_BASELINE_MODE_OPENING_RAMP &&
      raw !== BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND
    ) {
      return;
    }
    const next: DetectorDefaults = { ...draft, baselineMode: raw };
    setDraft(next);
    commitNext("baselineMode", next);
  }

  function commit(changedKey: keyof DetectorDefaults): void {
    commitNext(changedKey, draft);
  }

  function resetField(key: keyof DetectorDefaults): void {
    const next: DetectorDefaults = { ...draft, [key]: BASELINE_DEFAULTS[key] };
    setDraft(next);
    commitNext(key, next);
  }

  function chooseProfile(profileId: DetectorProfileId): void {
    if (profileId === "custom") return;
    const preset = DETECTOR_PROFILE_PRESETS.find((profile) => profile.id === profileId);
    if (preset === undefined) return;
    const next: DetectorDefaults = { ...draft, ...preset.patch };
    setPendingProfile({ label: preset.label, next, effectiveAt: nextUtcNineAm() });
  }

  function applyPendingProfileNow(): void {
    if (pendingProfile === null) return;
    mutation.mutate(pendingProfile.next, {
      onSuccess: () => {
        setDraft(pendingProfile.next);
        setPendingProfile(null);
      },
    });
  }

  function schedulePendingProfile(): void {
    if (pendingProfile === null) return;
    scheduleMutation.mutate(
      { defaults: pendingProfile.next, effectiveAt: pendingProfile.effectiveAt },
      {
        onSuccess: () => {
          setPendingProfile(null);
        },
      },
    );
  }

  return (
    <section data-testid="settings-detector-defaults" className="mt-8">
      {pendingProfile === null ? null : (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="detector-profile-confirm-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-surface-0-from/85 px-4"
          data-testid="detector-profile-confirmation"
        >
          <div className="max-w-xl border border-accent-yellow bg-surface-1 p-5 shadow-lg">
            <h4
              id="detector-profile-confirm-title"
              className="text-text-hi text-base font-semibold"
            >
              Promote {pendingProfile.label}
            </h4>
            <p className="mt-3 text-sm text-text-md">
              This writes the live detector defaults used by Recent and Live. New board-mad requests
              will pick it up within 5 seconds after the effective time, the runtime detector
              version gets a defaults hash, and old cached runs miss naturally.
            </p>
            <p className="mt-3 text-sm text-text-md">
              Rollback is the same operation in reverse: choose Opening ramp live or Legacy rolling
              here, apply it, and the next request recomputes against that profile. Scheduled
              changes are stored beside detector-defaults.json and are promoted on the first API
              read at or after {pendingProfile.effectiveAt}.
            </p>
            {mutation.isError || scheduleMutation.isError ? (
              <p className="mt-3 font-mono text-xs text-accent-yellow">
                {(mutation.error ?? scheduleMutation.error)?.message}
              </p>
            ) : null}
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={applyPendingProfileNow}
                className="border border-accent-yellow px-3 py-2 text-xs font-mono uppercase tracking-wider text-text-hi hover:bg-accent-yellow hover:text-surface-0-from"
                data-testid="detector-profile-apply-now"
              >
                Apply now
              </button>
              <button
                type="button"
                onClick={schedulePendingProfile}
                className="border border-surface-2 px-3 py-2 text-xs font-mono uppercase tracking-wider text-text-md hover:border-accent-yellow hover:text-text-hi"
                data-testid="detector-profile-schedule"
              >
                Schedule 09:00 UTC
              </button>
              <button
                type="button"
                onClick={() => {
                  setPendingProfile(null);
                }}
                className="px-3 py-2 text-xs font-mono uppercase tracking-wider text-text-lo hover:text-text-hi"
                data-testid="detector-profile-cancel"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      <h3 className="text-text-hi text-base font-semibold">
        <ExplainerCard id="settings-detector-defaults">
          <span>Detector defaults</span>
        </ExplainerCard>
      </h3>
      <p className="mt-2 text-xs text-text-lo max-w-[64ch]">
        Live operating values for Recent + Live. Edits write
        <span className="font-mono text-text-md">
          {" "}
          ~/signal-console/data/detector-defaults.json
        </span>
        ; the API picks them up within 5 s and bumps the board-mad version so cached results
        recompute on next access.
      </p>
      <dl className="mt-4 grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-[180px_minmax(0,1fr)]">
        <div
          data-testid="detector-default-row"
          data-field="profile"
          data-dirty="0"
          data-flashing="0"
          className="contents"
        >
          <ExplainDt id="settings-detector-defaults">Profile</ExplainDt>
          <dd>
            <select
              value={inferDetectorProfile(draft)}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                chooseProfile(parseDetectorProfileId(e.target.value));
              }}
              data-testid="detector-default-profile"
              aria-label="Detector default profile"
              className="w-64 border border-surface-2 bg-surface-0-from px-2 py-1 text-sm font-mono text-text-hi focus:border-accent-green focus:outline-none"
            >
              {DETECTOR_PROFILE_PRESETS.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label}
                </option>
              ))}
              <option value="custom">Custom</option>
            </select>
          </dd>
        </div>
        <div
          data-testid="detector-default-row"
          data-field="baselineMode"
          data-dirty={draft.baselineMode !== defaults.baselineMode ? "1" : "0"}
          data-flashing={flashing.has("baselineMode") ? "1" : "0"}
          className="contents"
        >
          <ExplainDt id="settings-baseline-mode">Prior sample</ExplainDt>
          <dd
            className={
              flashing.has("baselineMode")
                ? "transition-colors duration-fast bg-accent-yellow/15"
                : "transition-colors duration-fast"
            }
          >
            <div className="flex items-center gap-3">
              <select
                value={draft.baselineMode}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  updateBaselineMode(e.target.value);
                }}
                data-testid="detector-default-input-baselineMode"
                aria-label="Prior sample"
                className="w-52 border border-surface-2 bg-surface-0-from px-2 py-1 text-sm font-mono text-text-hi focus:border-accent-green focus:outline-none"
              >
                <option value={BOARD_MAD_BASELINE_MODE_TRAILING}>rolling current game</option>
                <option value={BOARD_MAD_BASELINE_MODE_OPENING_RAMP}>opening sample ramp</option>
                <option value={BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND}>
                  historical to live ramp
                </option>
              </select>
              {defaults.baselineMode === BASELINE_DEFAULTS.baselineMode ? null : (
                <button
                  type="button"
                  onClick={() => {
                    resetField("baselineMode");
                  }}
                  data-testid="detector-default-reset-baselineMode"
                  className="font-mono text-xs uppercase tracking-wider text-accent-green hover:text-text-hi"
                >
                  Reset to default
                </button>
              )}
            </div>
          </dd>
        </div>
        {NUMERIC_DETECTOR_DEFAULT_FIELDS.map((field) => {
          const isFlashing = flashing.has(field.key);
          const draftValue = draft[field.key];
          const serverValue = defaults[field.key];
          const dirty = draftValue !== serverValue;
          const isBaseline = serverValue === BASELINE_DEFAULTS[field.key];
          return (
            <div
              key={field.key}
              data-testid={`detector-default-row`}
              data-field={field.key}
              data-dirty={dirty ? "1" : "0"}
              data-flashing={isFlashing ? "1" : "0"}
              className="contents"
            >
              <ExplainDt id={field.explainerId}>{field.label}</ExplainDt>
              <dd
                className={
                  isFlashing
                    ? "transition-colors duration-fast bg-accent-yellow/15"
                    : "transition-colors duration-fast"
                }
              >
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    value={String(draftValue)}
                    step={field.step}
                    {...(field.min !== undefined ? { min: field.min } : {})}
                    {...(field.max !== undefined ? { max: field.max } : {})}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      updateField(field.key, e.target.value);
                    }}
                    onBlur={() => {
                      commit(field.key);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commit(field.key);
                      }
                    }}
                    data-testid={`detector-default-input-${field.key}`}
                    aria-label={field.label}
                    className="w-32 border border-surface-2 bg-surface-0-from px-2 py-1 text-sm font-mono text-text-hi tabular focus:border-accent-green focus:outline-none"
                  />
                  <span className="tabular font-mono text-xs text-text-lo">{field.unit}</span>
                  {isBaseline ? null : (
                    <button
                      type="button"
                      onClick={() => {
                        resetField(field.key);
                      }}
                      data-testid={`detector-default-reset-${field.key}`}
                      className="font-mono text-xs uppercase tracking-wider text-accent-green hover:text-text-hi"
                    >
                      Reset to default
                    </button>
                  )}
                </div>
              </dd>
            </div>
          );
        })}
      </dl>
      {mutation.isError ? (
        <p
          role="alert"
          data-testid="detector-defaults-error"
          className="mt-3 text-xs text-negative"
        >
          {mutation.error.message}
        </p>
      ) : null}
    </section>
  );
}

function DbSection({ db }: { db: Settings["db"] }): JSX.Element {
  const isReadOnly = db.mode === "read-only";
  return (
    <section data-testid="settings-db" className="mt-8">
      <h3 className="text-text-hi text-base font-semibold">Database</h3>
      {!isReadOnly ? (
        <div
          role="alert"
          data-testid="db-mode-banner"
          className="mt-3 border-l-2 border-negative bg-surface-1 px-4 py-3"
        >
          <p className="tabular font-mono text-sm text-negative">
            Database mode is <span data-testid="db-mode-value">{db.mode}</span> — read-only guard
            not active
          </p>
          {db.openError !== undefined && db.openError.length > 0 ? (
            <p className="mt-1 text-xs text-text-md">{db.openError}</p>
          ) : null}
        </div>
      ) : null}
      <dl className="mt-3 grid grid-cols-[140px_1fr] gap-y-2 text-sm">
        <ExplainDt id="settings-db-path">Path</ExplainDt>
        <dd data-testid="db-path" className="tabular font-mono text-text-md break-all">
          {db.path}
        </dd>
        <ExplainDt id="settings-db-page-size">Size</ExplainDt>
        <dd data-testid="db-size" className="tabular font-mono text-text-hi">
          {formatBytesCell(db.sizeBytes)}
        </dd>
        <ExplainDt id="settings-db-wal-bytes">WAL</ExplainDt>
        <dd data-testid="db-wal" className="tabular font-mono text-text-md">
          {formatBytesCell(db.walBytes)}
        </dd>
        <ExplainDt id="settings-db-page-count">Page count</ExplainDt>
        <dd className="tabular font-mono text-text-md">{BYTES_FMT.format(db.pageCount)}</dd>
        <ExplainDt id="settings-db-page-size">Page size</ExplainDt>
        <dd className="tabular font-mono text-text-md">{BYTES_FMT.format(db.pageSize)} bytes</dd>
        <ExplainDt id="settings-db-last-modified">Last modified</ExplainDt>
        <dd className="tabular font-mono text-text-md">{formatTimestamp(db.lastModified)}</dd>
        <ExplainDt id="settings-db-mode">Mode</ExplainDt>
        <dd
          data-testid="db-mode"
          className={
            isReadOnly ? "tabular font-mono text-accent-green" : "tabular font-mono text-negative"
          }
        >
          {db.mode}
        </dd>
      </dl>
    </section>
  );
}

function sourcesMap(sources: Sources): SourceRowMap {
  return sources.ingestPaused ? sources.lastKnown : sources.bySource;
}

function SourcesSection({ sources }: { sources: Sources }): JSX.Element {
  const map = sourcesMap(sources);
  const rows = KNOWN_SOURCES.map((name) => ({ name, info: map[name] }));
  return (
    <section data-testid="settings-sources" className="mt-10">
      <h3 className="text-text-hi text-base font-semibold">
        <ExplainerCard id="settings-source-heartbeat">
          <span>Sources</span>
        </ExplainerCard>
      </h3>
      {sources.ingestPaused ? (
        <div
          role="status"
          data-testid="ingest-paused"
          className="mt-3 border-l-2 border-accent-yellow bg-surface-1 px-4 py-3"
        >
          <p className="tabular font-mono text-sm text-accent-yellow">
            Ingest paused — showing last-known values
          </p>
        </div>
      ) : null}
      <div role="table" aria-label="Sources" className="mt-3 text-sm">
        <div role="row" className="grid grid-cols-[1fr_1fr_1.4fr_1fr] gap-x-6 pb-2 text-text-lo">
          <ExplainHeader id="settings-source-heartbeat">Source</ExplainHeader>
          <ExplainHeader id="settings-source-last-sync">Last sync</ExplainHeader>
          <ExplainHeader id="settings-source-last-error">Last error</ExplainHeader>
          <ExplainHeader id="settings-source-rate-limit">Rate-limit cooldown</ExplainHeader>
        </div>
        {rows.map(({ name, info }) => (
          <div
            key={name}
            role="row"
            data-testid="source-row"
            data-source={name}
            className="grid grid-cols-[1fr_1fr_1.4fr_1fr] gap-x-6 border-t border-surface-1 py-2"
          >
            <span role="cell" className="tabular font-mono text-text-hi">
              {name}
            </span>
            <span role="cell" className="tabular font-mono text-text-md">
              {info === undefined ? "—" : formatTimestamp(info.lastSyncAt)}
            </span>
            <span role="cell" className="text-text-md break-all">
              {info?.lastError !== undefined && info.lastError !== null && info.lastError.length > 0
                ? info.lastError
                : "—"}
            </span>
            <span role="cell" className="tabular font-mono text-text-md">
              {info?.rateLimitCooldown !== undefined &&
              info.rateLimitCooldown !== null &&
              info.rateLimitCooldown.length > 0
                ? info.rateLimitCooldown
                : "—"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function levelClass(level: string): string {
  if (level === "error" || level === "fatal") return "text-negative";
  if (level === "warn") return "text-accent-yellow";
  if (level === "debug" || level === "trace") return "text-text-lo";
  return "text-text-md";
}

function ErrorsSection({ entries }: { entries: Settings["errors"] }): JSX.Element {
  const [filter, setFilter] = useState<LevelFilter>("all");
  const filtered = useMemo(() => {
    if (filter === "all") return entries;
    return entries.filter((e) => e.level === filter);
  }, [entries, filter]);
  return (
    <section data-testid="settings-errors" className="mt-10">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-text-hi text-base font-semibold">Errors</h3>
        <label className="text-xs text-text-lo">
          <ExplainerCard id="settings-errors-filter">
            <span>Level</span>
          </ExplainerCard>{" "}
          <select
            data-testid="errors-level-filter"
            value={filter}
            onChange={(e) => {
              const next = parseLevelFilter(e.target.value);
              if (next !== null) setFilter(next);
            }}
            className="ml-2 border border-surface-2 bg-surface-1 px-2 py-1 text-xs text-text-hi"
          >
            {LEVEL_FILTERS.map((lvl) => (
              <option key={lvl} value={lvl}>
                {lvl}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-2 text-xs text-text-lo">
        Tail of last {String(entries.length)} log entr{entries.length === 1 ? "y" : "ies"} (cap 200)
        · showing {String(filtered.length)}
      </p>
      {filtered.length === 0 ? (
        <p
          data-testid="errors-empty"
          className="mt-3 border-l-2 border-surface-2 bg-surface-1 px-4 py-3 text-sm text-text-md"
        >
          No log entries{filter === "all" ? "" : ` at level '${filter}'`}.
        </p>
      ) : (
        <ul
          data-testid="errors-list"
          className="mt-3 max-h-[420px] overflow-y-auto border-t border-surface-1"
        >
          {filtered.map((entry, i) => (
            <li
              key={`${String(entry.time ?? "")}-${String(i)}`}
              data-testid="errors-entry"
              data-level={entry.level}
              className="grid grid-cols-[160px_60px_1fr] gap-x-4 border-b border-surface-1 py-1.5 text-xs"
            >
              <span className="tabular font-mono text-text-lo">{formatTimestamp(entry.time)}</span>
              <span className={`tabular font-mono ${levelClass(entry.level)}`}>{entry.level}</span>
              <span className="font-mono text-text-md break-all">{entry.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AboutSection({
  about,
  cacheDb,
  onClearCache,
  isClearing,
  clearError,
  lastClearedAt,
  lastDeletedCount,
}: {
  readonly about: Settings["about"];
  readonly cacheDb: Settings["cacheDb"];
  readonly onClearCache: () => void;
  readonly isClearing: boolean;
  readonly clearError: Error | null;
  readonly lastClearedAt: string | null;
  readonly lastDeletedCount: number | null;
}): JSX.Element {
  return (
    <section data-testid="settings-about" className="mt-10">
      <h3 className="text-text-hi text-base font-semibold">About</h3>
      <dl className="mt-3 grid grid-cols-[180px_1fr] gap-y-2 text-sm">
        <ExplainDt id="settings-app-version">App version</ExplainDt>
        <dd data-testid="about-app-version" className="tabular font-mono text-text-hi">
          {about.appVersion}
        </dd>
        <ExplainDt id="settings-db-schema-version">DB schema version</ExplainDt>
        <dd data-testid="about-schema-version" className="tabular font-mono text-text-md">
          {String(about.dbSchemaVersion)}
        </dd>
        <ExplainDt id="settings-detector-versions">Detectors</ExplainDt>
        <dd data-testid="about-detectors">
          {about.detectorVersions.length === 0 ? (
            <span className="text-text-lo">no detectors registered</span>
          ) : (
            <ul className="space-y-1">
              {about.detectorVersions.map((d) => (
                <li
                  key={d.id}
                  data-testid="about-detector-row"
                  data-detector-id={d.id}
                  className="tabular font-mono text-sm"
                >
                  <span className="text-text-hi">{d.id}</span>{" "}
                  <span className="text-text-lo">v{d.version}</span>
                </li>
              ))}
            </ul>
          )}
        </dd>
        <ExplainDt id="settings-db-path">Cache DB</ExplainDt>
        <dd className="tabular font-mono text-text-md">
          <div data-testid="about-cache-path" className="break-all">
            {cacheDb.path}
          </div>
          <div data-testid="about-cache-size" className="text-text-lo">
            {formatBytesCell(cacheDb.sizeBytes)} · {BYTES_FMT.format(cacheDb.pageCount)} pages
          </div>
        </dd>
      </dl>
      <div className="mt-6 border-t border-surface-1 pt-4">
        <p className="text-xs text-text-lo">
          Maintenance · Clears detector_runs + detector_observations (gold DB untouched).
        </p>
        <div className="mt-2 flex items-center gap-4">
          <button
            type="button"
            data-testid="clear-cache-button"
            onClick={onClearCache}
            disabled={isClearing}
            className="inline-block border border-accent-yellow px-3 py-1.5 text-sm font-medium text-text-hi transition-colors duration-fast ease-out hover:bg-accent-yellow hover:text-surface-0-from disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isClearing ? "Clearing…" : "Clear cache"}
          </button>
          {lastDeletedCount !== null ? (
            <span
              data-testid="clear-cache-result"
              className="tabular font-mono text-xs text-text-md"
            >
              Last clear: {BYTES_FMT.format(lastDeletedCount)} run
              {lastDeletedCount === 1 ? "" : "s"} deleted
              {lastClearedAt !== null ? ` at ${lastClearedAt}` : ""}
            </span>
          ) : null}
        </div>
        {clearError !== null ? (
          <p role="alert" data-testid="clear-cache-error" className="mt-2 text-xs text-negative">
            {clearError.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function SettingsPage(): JSX.Element {
  const settings = useSettings();
  const clearCache = useClearCache();
  const [lastDeletedCount, setLastDeletedCount] = useState<number | null>(null);
  const [lastClearedAt, setLastClearedAt] = useState<string | null>(null);

  function handleClearCache(): void {
    const ok = window.confirm(
      "Clear detector cache?\n\nThis deletes all detector_runs and detector_observations rows. The gold DB is not touched. Detector results for the current windows will be recomputed on the next request.",
    );
    if (!ok) return;
    clearCache.mutate(undefined, {
      onSuccess: (data) => {
        setLastDeletedCount(data.deleted);
        setLastClearedAt(new Date().toISOString());
      },
    });
  }

  const banner =
    settings.isError && isNetworkError(settings.error) ? (
      <ApiUnreachableBanner error={settings.error} />
    ) : (
      <QueryErrorBanner query={settings} label="Failed to load settings" />
    );

  return (
    <section data-testid="settings-page">
      {banner}
      <div className="flex items-baseline justify-between">
        <h2 className="text-text-hi text-lg font-semibold">Settings</h2>
        <p className="tabular font-mono text-xs text-text-lo" data-testid="settings-meta">
          {settings.isLoading
            ? "loading…"
            : settings.isError
              ? "—"
              : "diagnostic dashboard · read-only"}
        </p>
      </div>

      {settings.isLoading ? (
        <p className="mt-6 text-text-md text-sm">Loading settings…</p>
      ) : settings.data === undefined ? null : (
        <>
          <DetectorDefaultsSection defaults={settings.data.detectorDefaults} />
          <DbSection db={settings.data.db} />
          <SourcesSection sources={settings.data.sources} />
          <ErrorsSection entries={settings.data.errors} />
          <AboutSection
            about={settings.data.about}
            cacheDb={settings.data.cacheDb}
            onClearCache={handleClearCache}
            isClearing={clearCache.isPending}
            clearError={clearCache.isError ? clearCache.error : null}
            lastClearedAt={lastClearedAt}
            lastDeletedCount={lastDeletedCount}
          />
        </>
      )}
    </section>
  );
}

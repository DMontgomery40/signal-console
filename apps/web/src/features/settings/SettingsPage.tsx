// SettingsPage — diagnostic-only dashboard (US-026 / PRD §20).
//
// Five sections backed by useSettings():
//   - Detector defaults (US-053): runtime-editable kMad / trailing / warmup /
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

import { ExplainerCard } from "@signal-console/ui";
import type { ExplainerId } from "@signal-console/ui";

import { ApiUnreachableBanner, isNetworkError } from "../../components/ApiUnreachableBanner";
import { QueryErrorBanner } from "../../components/QueryErrorBanner";
import {
  useClearCache,
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

const DETECTOR_DEFAULT_FIELDS: ReadonlyArray<{
  readonly key: keyof DetectorDefaults;
  readonly label: string;
  readonly explainerId: ExplainerId;
  readonly step: number;
  readonly integer: boolean;
  readonly unit: string;
}> = [
  {
    key: "kMadLive",
    label: "K (live)",
    explainerId: "settings-k-mad-live",
    step: 0.1,
    integer: false,
    unit: "× MAD",
  },
  {
    key: "trailingBuckets",
    label: "Trailing buckets",
    explainerId: "settings-trailing-buckets",
    step: 1,
    integer: true,
    unit: "buckets",
  },
  {
    key: "warmupBuckets",
    label: "Warmup buckets",
    explainerId: "settings-warmup-buckets",
    step: 1,
    integer: true,
    unit: "buckets",
  },
  {
    key: "freshCapSeconds",
    label: "Freshness cap",
    explainerId: "settings-fresh-cap-seconds",
    step: 30,
    integer: true,
    unit: "seconds",
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

// Hardcoded fallback when /v1/settings hasn't reported them yet. Kept in sync
// with apps/api/src/services/detector-defaults.ts BASELINE_DEFAULTS.
const BASELINE_DEFAULTS: DetectorDefaults = {
  kMadLive: 3.0,
  trailingBuckets: 20,
  warmupBuckets: 8,
  freshCapSeconds: 300,
  pbpPreBufferMs: 5 * 60 * 1000,
  pbpPostBufferMs: 60_000,
};

const YELLOW_FLASH_MS = 200;

function DetectorDefaultsSection({
  defaults,
}: {
  readonly defaults: DetectorDefaults;
}): JSX.Element {
  const mutation = useUpdateDetectorDefaults();
  const [draft, setDraft] = useState<DetectorDefaults>(defaults);
  // Per-field "flash" set — populated immediately after a successful POST so
  // the changed field briefly highlights yellow per AC #3.
  const [flashing, setFlashing] = useState<ReadonlySet<keyof DetectorDefaults>>(new Set());

  // Sync local draft with server-reported defaults on first load + after a
  // successful write (server normalizes values through its Zod schema).
  useEffect(() => {
    setDraft(defaults);
  }, [defaults]);

  function updateField(key: keyof DetectorDefaults, raw: string): void {
    if (raw === "") return;
    const field = DETECTOR_DEFAULT_FIELDS.find((f) => f.key === key);
    if (field === undefined) return;
    const parsed = field.integer ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) return;
    setDraft((prev) => ({ ...prev, [key]: parsed }));
  }

  function commit(changedKey: keyof DetectorDefaults): void {
    if (draft[changedKey] === defaults[changedKey]) return;
    mutation.mutate(draft, {
      onSuccess: () => {
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
      },
    });
  }

  function resetField(key: keyof DetectorDefaults): void {
    const next: DetectorDefaults = { ...draft, [key]: BASELINE_DEFAULTS[key] };
    setDraft(next);
    if (BASELINE_DEFAULTS[key] === defaults[key]) return;
    mutation.mutate(next, {
      onSuccess: () => {
        const flash = new Set(flashing);
        flash.add(key);
        setFlashing(flash);
        setTimeout(() => {
          setFlashing((prev) => {
            const without = new Set(prev);
            without.delete(key);
            return without;
          });
        }, YELLOW_FLASH_MS);
      },
    });
  }

  return (
    <section data-testid="settings-detector-defaults" className="mt-8">
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
      <dl className="mt-4 grid grid-cols-[180px_1fr] gap-y-3 text-sm">
        {DETECTOR_DEFAULT_FIELDS.map((field) => {
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
                    className="w-32 border border-surface-2 bg-surface-0 px-2 py-1 text-sm font-mono text-text-hi tabular focus:border-accent-green focus:outline-none"
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

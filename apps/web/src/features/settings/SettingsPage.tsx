// SettingsPage — diagnostic-only dashboard (US-026 / PRD §20).
//
// Four sections backed by useSettings():
//   - Database: gold-DB path/size/WAL/pageCount/pageSize/lastModified/mode.
//     A red banner shows above the section when mode !== 'read-only'.
//   - Sources: per-source rows when the ingest heartbeat is present, or an
//     'Ingest paused' notice plus last-known values when paused.
//   - Errors: tail of last 200 pino log entries with a level filter.
//   - About: appVersion, registered detectorVersions, dbSchemaVersion.
//
// 'Clear cache' is admin housekeeping — DELETE /v1/cache with a confirmation
// dialog (window.confirm), then refresh the settings query. The gold DB's size
// must not change as a side-effect (asserted in the test).

import { useMemo, useState } from "react";
import type { JSX } from "react";

import { ApiUnreachableBanner, isNetworkError } from "../../components/ApiUnreachableBanner";
import { QueryErrorBanner } from "../../components/QueryErrorBanner";
import { useClearCache, useSettings, type Settings } from "../../data/queries";

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
  // narrow without `as`: walk the typed list once.
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
        <dt className="text-text-lo">Path</dt>
        <dd data-testid="db-path" className="tabular font-mono text-text-md break-all">
          {db.path}
        </dd>
        <dt className="text-text-lo">Size</dt>
        <dd data-testid="db-size" className="tabular font-mono text-text-hi">
          {formatBytesCell(db.sizeBytes)}
        </dd>
        <dt className="text-text-lo">WAL</dt>
        <dd data-testid="db-wal" className="tabular font-mono text-text-md">
          {formatBytesCell(db.walBytes)}
        </dd>
        <dt className="text-text-lo">Page count</dt>
        <dd className="tabular font-mono text-text-md">{BYTES_FMT.format(db.pageCount)}</dd>
        <dt className="text-text-lo">Page size</dt>
        <dd className="tabular font-mono text-text-md">{BYTES_FMT.format(db.pageSize)} bytes</dd>
        <dt className="text-text-lo">Last modified</dt>
        <dd className="tabular font-mono text-text-md">{formatTimestamp(db.lastModified)}</dd>
        <dt className="text-text-lo">Mode</dt>
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
  // Narrow to the same shape regardless of paused flag for table rendering.
  return sources.ingestPaused ? sources.lastKnown : sources.bySource;
}

function SourcesSection({ sources }: { sources: Sources }): JSX.Element {
  const map = sourcesMap(sources);
  const rows = KNOWN_SOURCES.map((name) => ({ name, info: map[name] }));
  return (
    <section data-testid="settings-sources" className="mt-10">
      <h3 className="text-text-hi text-base font-semibold">Sources</h3>
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
          <span role="columnheader" className="font-medium">
            Source
          </span>
          <span role="columnheader" className="font-medium">
            Last sync
          </span>
          <span role="columnheader" className="font-medium">
            Last error
          </span>
          <span role="columnheader" className="font-medium">
            Rate-limit cooldown
          </span>
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
          Level{" "}
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
        <dt className="text-text-lo">App version</dt>
        <dd data-testid="about-app-version" className="tabular font-mono text-text-hi">
          {about.appVersion}
        </dd>
        <dt className="text-text-lo">DB schema version</dt>
        <dd data-testid="about-schema-version" className="tabular font-mono text-text-md">
          {String(about.dbSchemaVersion)}
        </dd>
        <dt className="text-text-lo">Detectors</dt>
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
        <dt className="text-text-lo">Cache DB</dt>
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

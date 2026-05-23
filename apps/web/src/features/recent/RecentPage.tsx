import type { JSX } from "react";

import { ApiUnreachableBanner, isNetworkError } from "../../components/ApiUnreachableBanner";
import { QueryErrorBanner } from "../../components/QueryErrorBanner";
import { useBoard, useGames, type Game } from "../../data/queries";

// Cap concurrent /v1/board/:gameId fetches per AC #5 ("page does not exceed 20
// in-flight requests simultaneously"). Rows past the cap render the plain "—"
// placeholder; today the desk window holds well under 20 games at once so this
// only matters in synthetic test renders and a future high-density layout.
const FIRES_CELL_BUDGET = 20;

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatScheduledStart(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return TIME_FMT.format(d);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Pull a short, display-friendly identifier out of the participant JSON the
// gold DB stores. Real rows carry { key, name, shortName, abbreviation, side };
// fixture/test rows may only carry { teamId }. Pick the first recognised key.
export function participantLabel(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return "?";
    for (const key of ["abbreviation", "teamId", "shortName", "key", "name", "id"]) {
      const v = parsed[key];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return "?";
  } catch {
    return "?";
  }
}

function renderStatus(status: string | null): JSX.Element {
  if (status === null || status.length === 0) {
    return <span className="text-text-lo">—</span>;
  }
  return <span className="text-text-md">{status}</span>;
}

function FiresCell({ gameId }: { gameId: string }): JSX.Element {
  const board = useBoard(gameId);
  if (board.isLoading) {
    return (
      <span
        data-testid="fires-pending"
        role="status"
        aria-label="loading fire count"
        className="inline-block h-3 w-3 animate-spin rounded-full border border-text-lo border-t-transparent align-middle"
      />
    );
  }
  if (board.isError) {
    return (
      <span data-testid="fires-error" title={board.error.message} className="text-negative">
        error
      </span>
    );
  }
  const fired = board.data?.observations.filter((o) => o.fired === 1).length ?? 0;
  return (
    <span data-testid="fires-count" className={fired > 0 ? "text-accent-yellow" : "text-text-md"}>
      {String(fired)}
    </span>
  );
}

export function RecentPage(): JSX.Element {
  const games = useGames("PT24H");

  function handleRefresh(): void {
    void games.refetch();
  }

  const banner =
    games.isError && isNetworkError(games.error) ? (
      <ApiUnreachableBanner error={games.error} />
    ) : (
      <QueryErrorBanner query={games} label="Failed to load games" />
    );

  const rows: readonly Game[] = games.data?.games ?? [];

  return (
    <section>
      {banner}
      <div className="flex items-baseline justify-between gap-6">
        <h2 className="text-text-hi text-lg font-semibold">Recent</h2>
        <div className="flex items-center gap-6">
          <p className="tabular font-mono text-xs text-text-lo" data-testid="recent-meta">
            {games.isLoading
              ? "loading…"
              : games.isError
                ? "—"
                : `${String(rows.length)} game${rows.length === 1 ? "" : "s"} · last 24 h`}
          </p>
          <button
            type="button"
            onClick={handleRefresh}
            data-testid="refresh-button"
            disabled={games.isFetching}
            className="inline-block border border-accent-yellow px-3 py-1.5 text-sm font-medium text-text-hi transition-colors duration-fast ease-out hover:bg-accent-yellow hover:text-surface-0-from disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="mt-6" data-testid="recent-list">
        {games.isLoading && rows.length === 0 ? (
          <p className="text-text-md text-sm">Loading games…</p>
        ) : games.isError && rows.length === 0 ? null : rows.length === 0 ? (
          <p className="text-text-md text-sm" data-testid="recent-empty">
            No games scheduled in the last 24 h.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-text-lo">
                <th className="pb-3 pr-6 font-medium">Scheduled</th>
                <th className="pb-3 pr-6 font-medium">Sport</th>
                <th className="pb-3 pr-6 font-medium">League</th>
                <th className="pb-3 pr-6 font-medium">Home</th>
                <th className="pb-3 pr-6 font-medium">Away</th>
                <th className="pb-3 pr-6 font-medium">Status</th>
                <th className="pb-3 font-medium">Fires</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g, idx) => (
                <tr
                  key={g.id}
                  data-testid="recent-row"
                  data-game-id={g.id}
                  className="border-t border-surface-1"
                >
                  <td className="py-3 pr-6 tabular font-mono text-text-md">
                    {formatScheduledStart(g.scheduledStart)}
                  </td>
                  <td className="py-3 pr-6 text-text-md">{g.sport}</td>
                  <td className="py-3 pr-6 text-text-md">{g.league}</td>
                  <td className="py-3 pr-6 tabular font-mono text-text-hi">
                    {participantLabel(g.homeParticipantJson)}
                  </td>
                  <td className="py-3 pr-6 tabular font-mono text-text-hi">
                    {participantLabel(g.awayParticipantJson)}
                  </td>
                  <td className="py-3 pr-6">{renderStatus(g.status)}</td>
                  <td className="py-3 tabular font-mono" data-testid="fires-cell">
                    {idx < FIRES_CELL_BUDGET ? (
                      <FiresCell gameId={g.id} />
                    ) : (
                      <span className="text-text-lo">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

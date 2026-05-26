// ensemble-or detector — Stage-1 cascade.
//
// Runs board-mad AND off-price-print over the same window and unions their
// fires. Bakeoff scores and rankings live in the generated report artifacts,
// not in this runtime module, because the benchmark corpus changes as new
// desk incidents become scoreable.
//
// Each surviving fire carries a `lane` ("board" or "offprice") so the UI
// can render the two lanes distinctly (Live shows red dashed lines for
// off-price prints over the green-tick board chart). Per-game stats add
// the per-lane totals; bucket observations are only emitted by the board
// lane (off-price events are point-in-time and have no surrounding
// 60-second-bucket context — their bucketStart === bucketEnd is the event
// time itself, mirroring off-price-print's existing run() contract).

import { z } from "zod";

import { detector as boardMad, Params as BoardMadParams } from "../board-mad";
import { detector as offPricePrint } from "../off-price-print";
import { Params as OffPricePrintParams } from "../off-price-print";
import type {
  Detector,
  DetectorBucket,
  DetectorFire,
  DetectorResult,
  DetectorStats,
  DetectorWindow,
} from "../types";

export const Params = z.object({
  board: BoardMadParams.optional().default({}),
  offprice: OffPricePrintParams.optional().default({}),
});

type ParamsResolved = z.infer<typeof Params>;

// Two outputs from the same lane can share game + timestamp without being the
// same event. Off-price prints carry sourceMarketId so simultaneous distinct
// markets stay distinct, while duplicate rows from the same market collapse.
function dedupeKey(f: DetectorFire): string {
  return [
    f.gameId,
    f.bucketStart.toISOString(),
    f.bucketEnd.toISOString(),
    f.lane ?? "",
    f.sourceMarketId ?? "",
  ].join("|");
}

const uniqueGameIds = (gameIds: readonly string[]): readonly string[] =>
  Array.from(new Set(gameIds));

export const detector: Detector<typeof Params> = {
  id: "ensemble-or",
  version: "1.0.0",
  displayName: "Stage 1 (board OR off-price-print)",
  // Union of the two lanes' sources; the loader honors this list.
  sources: ["bet365", "kalshi", "polymarket"],
  paramsSchema: Params,
  run(window: DetectorWindow, params: ParamsResolved): DetectorResult {
    const boardResult = boardMad.run(window, params.board);
    const offResult = offPricePrint.run(window, params.offprice);

    const boardFires: DetectorFire[] = boardResult.fires.map((f) => ({
      ...f,
      lane: "board",
    }));
    const offFires: DetectorFire[] = offResult.fires.map((f) => ({
      ...f,
      lane: "offprice",
    }));

    const fires = [...boardFires, ...offFires].reduce<{
      readonly seen: ReadonlySet<string>;
      readonly fires: readonly DetectorFire[];
    }>(
      (acc, f): { readonly seen: ReadonlySet<string>; readonly fires: readonly DetectorFire[] } => {
        const key = dedupeKey(f);
        if (acc.seen.has(key)) return acc;
        return {
          seen: new Set([...acc.seen, key]),
          fires: [...acc.fires, f],
        };
      },
      { seen: new Set<string>(), fires: [] },
    ).fires;

    // Only the board lane has well-defined per-bucket observations (the
    // off-price-print detector intentionally emits no buckets — its events
    // are tape prints, not aggregates). The Backtest UI's Sensitivity timeline
    // and past-fires drilldown both render from these; for off-price the
    // fires themselves are the renderable surface.
    const buckets: readonly DetectorBucket[] = boardResult.buckets;

    const gamesInWindow = uniqueGameIds(window.gameIds).length;
    const stats: DetectorStats = {
      firesPerGame: gamesInWindow === 0 ? 0 : fires.length / gamesInWindow,
      totalFires: fires.length,
      gamesInWindow,
    };
    return { fires, stats, buckets };
  },
};

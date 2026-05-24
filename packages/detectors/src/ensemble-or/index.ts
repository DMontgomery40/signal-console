// ensemble-or detector — Stage-1 cascade from the suspend-signal report §8.1.
//
// Runs board-mad AND off-price-print over the same window and unions their
// fires. This is the BAKEOFF row `ensemble-OR(board-vw@3,offprice)` in the
// report — strictly equal-or-better recall than either lane alone (5/6 on
// the canonical incident set vs 4/6 board-vw-only and 1/6 offprice-only).
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

// Two events on the same game at the same timestamp from the same lane
// would otherwise duplicate in the union (off-price-print returns one fire
// per microstructure event, board-mad returns one per fired bucket — disjoint
// by lane, but defensively dedup anyway).
function dedupeKey(f: DetectorFire): string {
  return `${f.gameId}|${f.bucketStart.toISOString()}|${f.lane ?? ""}`;
}

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

    const seen = new Set<string>();
    const fires: DetectorFire[] = [];
    for (const f of [...boardFires, ...offFires]) {
      const key = dedupeKey(f);
      if (seen.has(key)) continue;
      seen.add(key);
      fires.push(f);
    }

    // Only the board lane has well-defined per-bucket observations (the
    // off-price-print detector intentionally emits no buckets — its events
    // are tape prints, not aggregates). The Backtest UI's Cry Wolf timeline
    // and past-fires drilldown both render from these; for off-price the
    // fires themselves are the renderable surface.
    const buckets: readonly DetectorBucket[] = boardResult.buckets;

    const gamesInWindow = window.gameIds.length;
    const stats: DetectorStats = {
      firesPerGame: gamesInWindow === 0 ? 0 : fires.length / gamesInWindow,
      totalFires: fires.length,
      gamesInWindow,
    };
    return { fires, stats, buckets };
  },
};

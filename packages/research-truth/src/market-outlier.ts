import { bucketize, coverageNormalizedIntensity, matchupLabel } from "./buckets";
import {
  ALERT_EPISODE_MERGE_SECONDS,
  MARKET_OUTLIER_BUCKET_SECONDS,
  MARKET_OUTLIER_CONFIRMATION_Z,
  MARKET_OUTLIER_EXTREME_PRICE_MOVE_Z,
  MARKET_OUTLIER_MIN_ACTIVE_MARKETS,
  MARKET_OUTLIER_MIN_BUCKETS,
  MARKET_OUTLIER_MIN_SOURCES,
  MARKET_OUTLIER_PRICE_MOVE_Z,
} from "./constants";
import { isoFromSeconds, mean, positiveRobustZ, robustStats, rounded } from "./stats";
import type { GameData, MarketOutlierBucketCandidate, MarketOutlierEpisode } from "./types";

function diagnoseMarketOutlierEpisode(
  peakPriceMoveZ: number,
  peakBreadthZ: number,
  peakOffpriceZ: number,
  peakActiveMarkets: number,
  peakSources: number,
): string {
  const notes: string[] = [];
  if (peakPriceMoveZ >= MARKET_OUTLIER_EXTREME_PRICE_MOVE_Z) {
    notes.push("extreme price move");
  } else {
    notes.push("price move outlier");
  }
  if (
    peakBreadthZ >= MARKET_OUTLIER_CONFIRMATION_Z ||
    peakActiveMarkets >= MARKET_OUTLIER_MIN_ACTIVE_MARKETS ||
    peakSources >= MARKET_OUTLIER_MIN_SOURCES
  ) {
    notes.push("broad market participation");
  }
  if (peakOffpriceZ >= MARKET_OUTLIER_CONFIRMATION_Z) {
    notes.push("microstructure confirmation");
  }
  if (notes.length === 1) {
    notes.push("thin confirmation; review for coverage artifact");
  }
  return notes.join("; ");
}

function marketOutlierEpisodeFromCandidates(
  game: GameData,
  candidates: readonly MarketOutlierBucketCandidate[],
): MarketOutlierEpisode | null {
  if (candidates.length === 0) return null;
  const first = candidates[0];
  const last = candidates.at(-1);
  if (first === undefined || last === undefined) return null;
  const severities = candidates.map((candidate) => candidate.severity);
  const peakPriceMoveZ = Math.max(...candidates.map((candidate) => candidate.priceMoveZ));
  const peakBreadthZ = Math.max(...candidates.map((candidate) => candidate.breadthZ));
  const peakOffpriceZ = Math.max(...candidates.map((candidate) => candidate.offpriceZ));
  const peakActiveMarkets = Math.max(
    ...candidates.map((candidate) => candidate.bucket.activeMarketCount),
  );
  const peakSources = Math.max(...candidates.map((candidate) => candidate.bucket.sourceCount));
  const peakFamilies = Math.max(...candidates.map((candidate) => candidate.bucket.familyCount));
  return {
    gameId: game.gameId,
    scheduledStart: game.window.scheduledStart,
    matchup: matchupLabel(game.window),
    startSec: first.bucket.startSec,
    endSec: last.bucket.endSec,
    startIso: isoFromSeconds(first.bucket.startSec),
    endIso: isoFromSeconds(last.bucket.endSec),
    bucketSeconds: MARKET_OUTLIER_BUCKET_SECONDS,
    bucketCount: candidates.length,
    peakSeverity: rounded(Math.max(...severities), 3) ?? 0,
    meanSeverity: rounded(mean(severities) ?? 0, 3) ?? 0,
    peakPriceMoveZ: rounded(peakPriceMoveZ, 3) ?? 0,
    peakBreadthZ: rounded(peakBreadthZ, 3) ?? 0,
    peakOffpriceZ: rounded(peakOffpriceZ, 3) ?? 0,
    peakActiveMarkets,
    peakSources,
    peakFamilies,
    diagnosis: diagnoseMarketOutlierEpisode(
      peakPriceMoveZ,
      peakBreadthZ,
      peakOffpriceZ,
      peakActiveMarkets,
      peakSources,
    ),
  };
}

export function buildMarketOutlierEpisodes(game: GameData): readonly MarketOutlierEpisode[] {
  const buckets = bucketize(game, MARKET_OUTLIER_BUCKET_SECONDS);
  if (buckets.length < MARKET_OUTLIER_MIN_BUCKETS) return [];

  const priceMoveSeries = buckets.map((bucket) => Math.log1p(coverageNormalizedIntensity(bucket)));
  const breadthSeries = buckets.map((bucket) => Math.log1p(bucket.activeMarketCount));
  const offpriceSeries = buckets.map((bucket) => Math.log1p(bucket.offpriceSeverity));
  const priceMoveStats = robustStats(priceMoveSeries);
  const breadthStats = robustStats(breadthSeries);
  const offpriceStats = robustStats(offpriceSeries);

  const candidates = buckets.flatMap((bucket, index): readonly MarketOutlierBucketCandidate[] => {
    const priceMoveZ = positiveRobustZ(priceMoveSeries[index] ?? 0, priceMoveStats);
    const breadthZ = positiveRobustZ(breadthSeries[index] ?? 0, breadthStats);
    const offpriceZ = positiveRobustZ(offpriceSeries[index] ?? 0, offpriceStats);
    const hasConfirmation =
      breadthZ >= MARKET_OUTLIER_CONFIRMATION_Z ||
      offpriceZ >= MARKET_OUTLIER_CONFIRMATION_Z ||
      bucket.activeMarketCount >= MARKET_OUTLIER_MIN_ACTIVE_MARKETS ||
      bucket.sourceCount >= MARKET_OUTLIER_MIN_SOURCES;
    const confirmed = priceMoveZ >= MARKET_OUTLIER_PRICE_MOVE_Z && hasConfirmation;
    if (!confirmed) return [];
    return [
      {
        bucket,
        severity: priceMoveZ + breadthZ * 0.5 + offpriceZ * 0.35,
        priceMoveZ,
        breadthZ,
        offpriceZ,
      },
    ];
  });

  if (candidates.length === 0) return [];

  const episodes: MarketOutlierEpisode[] = [];
  let current: MarketOutlierBucketCandidate[] = [];
  for (const candidate of candidates) {
    const previous = current.at(-1);
    if (
      previous !== undefined &&
      candidate.bucket.startSec - previous.bucket.startSec > ALERT_EPISODE_MERGE_SECONDS
    ) {
      const episode = marketOutlierEpisodeFromCandidates(game, current);
      if (episode !== null) episodes.push(episode);
      current = [];
    }
    current.push(candidate);
  }
  const finalEpisode = marketOutlierEpisodeFromCandidates(game, current);
  if (finalEpisode !== null) episodes.push(finalEpisode);
  return episodes;
}

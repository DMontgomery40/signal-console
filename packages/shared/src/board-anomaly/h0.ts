import type {
  BoardAnomalyDetectorConfig,
  BoardObservation,
  H0Adjustment,
} from "@signal-console/domain";

const PREGAME_BASE_PROB_PER_HOUR = 0.01;
const NEAR_TIP_BASE_PROB_BOOST = 0.04;
const CLOSE_GAME_BASE_PROB_BOOST = 0.05;
const IN_PLAY_BASE_PROB = 0.02;
const PREDICTION_MARKET_SPREAD_FLOOR = 0.04;
const SPORTSBOOK_SPREAD_FLOOR = 0.01;
const MIN_PROB_DENOM = 0.05 * 0.95;

function probDriftToLogitCap(probDrift: number, baseProb: number): number {
  const p = Math.min(0.95, Math.max(0.05, baseProb));
  const denom = Math.max(MIN_PROB_DENOM, p * (1 - p));
  return probDrift / denom;
}

export function computeH0Adjustment(
  observation: BoardObservation,
  config: BoardAnomalyDetectorConfig
): H0Adjustment {
  const reasons: string[] = [];
  const baseProb =
    observation.previousImpliedProbability ??
    observation.impliedProbability ??
    0.5;
  let expectedProbDrift = 0;
  let expectedAbsLineMove = 0;
  const expectedAbsTradeDistance =
    observation.sourceKind === "prediction-market"
      ? Math.max(0, config.thresholds.tradeDistance * 0.5)
      : 0;
  const expectedSpreadFloor =
    observation.sourceKind === "prediction-market"
      ? PREDICTION_MARKET_SPREAD_FLOOR
      : SPORTSBOOK_SPREAD_FLOOR;

  let pregameDriftCap = 0;
  if (observation.gameState.status === "scheduled") {
    const minutesToTip = observation.gameState.minutesToTip ?? 0;
    const hoursToTip = Math.max(0, minutesToTip) / 60;
    pregameDriftCap =
      PREGAME_BASE_PROB_PER_HOUR * Math.max(1, Math.min(hoursToTip, 24));
    expectedProbDrift += pregameDriftCap;
    if (minutesToTip <= config.thresholds.nearTipMinutes) {
      expectedProbDrift += NEAR_TIP_BASE_PROB_BOOST;
      reasons.push("near-tip drift cap");
    } else {
      reasons.push("pregame drift cap");
    }
    expectedAbsLineMove = 0.25;
  }

  let closeGameRepricingCap = 0;
  if (observation.gameState.status === "in-play") {
    const margin = Math.abs(observation.gameState.scoreMargin ?? 0);
    if (margin <= config.thresholds.closeGameMarginAbs) {
      closeGameRepricingCap = CLOSE_GAME_BASE_PROB_BOOST;
      expectedProbDrift += closeGameRepricingCap;
      reasons.push("close-game repricing cap");
    } else {
      expectedProbDrift += IN_PLAY_BASE_PROB;
      reasons.push("in-play baseline");
    }
    expectedAbsLineMove = 0.35;
  }

  if (expectedProbDrift === 0) {
    expectedProbDrift = IN_PLAY_BASE_PROB / 2;
  }

  let staleQuoteSuppression = 0;
  if (observation.flags.isStale) {
    staleQuoteSuppression = 1;
    reasons.push("stale-quote suppression");
  }
  if (observation.quoteAgeMs != null) {
    const ageMinutes = observation.quoteAgeMs / 60_000;
    if (ageMinutes >= config.thresholds.staleQuoteAgeMinutes) {
      staleQuoteSuppression = Math.max(staleQuoteSuppression, 1);
      reasons.push(`quote-age ${ageMinutes.toFixed(1)}m`);
    }
  }

  if (observation.flags.isHeartbeat) {
    staleQuoteSuppression = Math.max(staleQuoteSuppression, 1);
    reasons.push("heartbeat-only");
  }

  const expectedAbsLogitMove = probDriftToLogitCap(expectedProbDrift, baseProb);
  const pregameDriftLogitCap = probDriftToLogitCap(pregameDriftCap, baseProb);
  const closeGameRepricingLogitCap = probDriftToLogitCap(
    closeGameRepricingCap,
    baseProb
  );

  return {
    expectedAbsLogitMove,
    expectedAbsLineMove,
    expectedAbsTradeDistance,
    expectedSpreadFloor,
    pregameDriftCap: pregameDriftLogitCap,
    closeGameRepricingCap: closeGameRepricingLogitCap,
    staleQuoteSuppression,
    reason: reasons.length > 0 ? reasons.join("; ") : "H0 baseline",
  };
}

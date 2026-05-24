export { resolveBoardAnomalyConfig, scoreToSeverity } from "./config";
export { computeH0Adjustment } from "./h0";
export { scoreObservation } from "./residual";
export { buildCoherenceClusters, deriveRelationKeys } from "./fanout";
export type { CoherenceCluster, RelationKey } from "./fanout";
export { classifyShock } from "./classifier";
export type { ShockClassification } from "./classifier";
export {
  compareBoardAnomalyAlerts,
  detectBoardAnomalies,
  measureBoardGameStateVolatility,
} from "./detector";
export { replayBoardAnomalies } from "./replay";

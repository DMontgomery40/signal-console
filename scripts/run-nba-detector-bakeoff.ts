// pnpm bakeoff:nba-detectors
//
// Offline NBA incident bake-off. This script is intentionally read-only against
// the gold DB and writes a standalone HTML report plus machine-readable JSON.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { format, resolveConfig } from "prettier";

import {
  BASELINE_DEFAULTS,
  readDetectorDefaults,
  type DetectorDefaults,
} from "../apps/api/src/services/detector-defaults";
import { GOLD_DB_PATH, openGoldDb } from "../packages/db/src/open";

const SOURCE_REGISTRY_PATH = resolve(
  "..",
  "nba-predict",
  "outputs",
  "innovation-team-suspend-signal-report",
  "research",
  "incident-registry-expanded.json",
);
const OUT_DIR = resolve("outputs", "nba-detector-bakeoff");
const RESEARCH_DIR = resolve(OUT_DIR, "research");
const PRETTIER_CONFIG_PATH = resolve(".prettierrc.json");
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const REGULATION_PERIOD_SECONDS = 12 * SECONDS_PER_MINUTE;
const OVERTIME_PERIOD_SECONDS = 5 * SECONDS_PER_MINUTE;
const STALE_PAIR_GAP_SECONDS = 300;
const DEFAULT_PRE_BUFFER_SECONDS = 10 * SECONDS_PER_MINUTE;
const DEFAULT_POST_BUFFER_SECONDS = 5 * SECONDS_PER_MINUTE;
const CATCH_WINDOW_BEFORE_SECONDS = -60;
const CATCH_WINDOW_AFTER_SECONDS = 300;
const CLUTCH_SECONDS_REMAINING = 5 * SECONDS_PER_MINUTE;
const CLOSE_GAME_MARGIN = 5;
const FOUL_MODE_SECONDS_REMAINING = 60;
const FOUL_MODE_MARGIN = 3;
const PROB_EPSILON = 0.001;
const MAD_SCALE = 1.4826;
const SCALE_FLOOR = 1e-9;
const LOW_SIGNAL_FLOOR = 1e-12;
const EWMA_TAU_SECONDS = 6 * SECONDS_PER_MINUTE;
const CUSUM_DRIFT = 0.35;
const RV_JUMP_RATIO = 2.25;
const COVERAGE_NORMALIZATION_MARKET_FLOOR = 1;
const NO_FIRE_COOLDOWN_BUCKETS = 0;
const SHORT_REGIME_COOLDOWN_BUCKETS = 4;
const HIGH_MARKET_BREADTH_COUNT = 120;
const HIGH_QUOTE_PAIR_COUNT = 5_000;
const HIGH_LATE_GAME_FIRE_SHARE = 0.35;
const OUTLIER_MIN_FIRE_COUNT = 20;
const OUTLIER_MEDIAN_MULTIPLIER = 2.5;
const ALERT_EPISODE_MERGE_SECONDS = 90;
const MARKET_OUTLIER_BUCKET_SECONDS = 30;
const MARKET_OUTLIER_MIN_BUCKETS = 8;
const MARKET_OUTLIER_PRICE_MOVE_Z = 3;
const MARKET_OUTLIER_CONFIRMATION_Z = 1.5;
const MARKET_OUTLIER_EXTREME_PRICE_MOVE_Z = 5;
const MARKET_OUTLIER_MIN_ACTIVE_MARKETS = 4;
const MARKET_OUTLIER_MIN_SOURCES = 2;
const MARKET_OUTLIER_EPISODE_BUFFER_SECONDS = 30;
const REPORT_GENERATED_AT = new Date().toISOString();

type ScoreKind =
  | "board-eq"
  | "board-vw"
  | "coverage-normalized-vw"
  | "logit-vw"
  | "volume-heavy"
  | "offprice"
  | "hybrid";

type BaselineKind =
  | "mad-wall"
  | "mad-game"
  | "mad-blend"
  | "mad-historical"
  | "ewma"
  | "cusum"
  | "rv-bv";

type DetectorEngine = "research-ts" | "python-state-space";

type RuntimeBaselineMode = "trailing" | "opening-ramp" | "historical-blend";

interface IncidentRegistryPayload {
  readonly incidents?: readonly unknown[];
  readonly summary?: unknown;
}

interface RawIncident {
  readonly id: string;
  readonly confidence: string;
  readonly anchorType: string;
  readonly gameDate: string;
  readonly teams: string;
  readonly gameId: string;
  readonly period: string;
  readonly clock: string;
  readonly utcTime: string;
  readonly stat: string;
  readonly creditedPlayer: string;
  readonly rightfulPlayer: string;
  readonly sourceOrigin: string;
  readonly sourceReference: string;
  readonly sourceTextSummary: string;
  readonly notes: string;
  readonly officialCorrection: boolean;
  readonly localBoardGameIds: readonly string[];
}

interface PbpPoint {
  readonly timeSec: number;
  readonly iso: string;
  readonly period: number | null;
  readonly clock: string | null;
  readonly secondsRemaining: number | null;
  readonly gameElapsedSec: number | null;
  readonly scoreMarginAbs: number | null;
  readonly description: string;
}

interface GameWindow {
  readonly gameId: string;
  readonly scheduledStart: string;
  readonly homeKey: string | null;
  readonly awayKey: string | null;
  readonly startIso: string;
  readonly endIso: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly points: readonly PbpPoint[];
}

interface PairContribution {
  readonly timeSec: number;
  readonly sourceMarketId: string;
  readonly source: string;
  readonly family: string;
  readonly deltaP: number;
  readonly deltaLogit: number;
  readonly volume: number;
}

interface MicroEvent {
  readonly timeSec: number;
  readonly source: string;
  readonly sourceMarketId: string;
  readonly instrumentId: string;
  readonly severity: number;
}

interface Bucket {
  readonly startSec: number;
  readonly endSec: number;
  readonly gameElapsedSec: number | null;
  readonly period: number | null;
  readonly secondsRemaining: number | null;
  readonly scoreMarginAbs: number | null;
  readonly eqIntensity: number;
  readonly vwIntensity: number;
  readonly logitVwIntensity: number;
  readonly volumeHeavyIntensity: number;
  readonly activeMarketCount: number;
  readonly sourceCount: number;
  readonly sourceDominance: number | null;
  readonly familyCount: number;
  readonly offpriceSeverity: number;
  readonly offpriceFanout: number;
  readonly offpriceSourceCount: number;
}

interface GameData {
  readonly gameId: string;
  readonly window: GameWindow;
  readonly pairs: readonly PairContribution[];
  readonly micro: readonly MicroEvent[];
  readonly bucketCache: Map<number, readonly Bucket[]>;
}

interface AlgoSpec {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  readonly engine?: DetectorEngine;
  readonly bucketSeconds: number;
  readonly scoreKind: ScoreKind;
  readonly baselineKind: BaselineKind;
  readonly k: number;
  readonly warmupBuckets: number;
  readonly minPrior: number;
  readonly trailingBuckets?: number;
  readonly wallMemorySeconds?: number;
  readonly gameMemorySeconds?: number;
  readonly recentWallSeconds?: number;
  readonly recentWallWeight?: number;
  readonly finalFiveCloseMultiplier?: number;
  readonly finalFoulModeMultiplier?: number;
  readonly requiredMarkets?: number;
  readonly requiredFamilies?: number;
  readonly requiredSources?: number;
  readonly requiredOffpriceFanout?: number;
  readonly cooldownBuckets?: number;
  readonly openingBaselineBuckets?: number;
  readonly openingRampCompleteBuckets?: number;
  readonly historicalLastGames?: number;
  readonly historicalAwayWeight?: number;
  readonly historicalPriorWeight?: number;
  readonly historicalRampCompleteGameSeconds?: number;
  readonly runtimeBaselineMode?: RuntimeBaselineMode;
  readonly stateSpace?: Record<string, unknown>;
  readonly configSource?: "baseline-defaults" | "live-defaults";
  readonly formula: string;
  readonly rationale: string;
  readonly citations: readonly string[];
}

interface StateSpaceAlgoSpec extends AlgoSpec {
  readonly engine: "python-state-space";
  readonly stateSpace: Record<string, unknown>;
}

interface BakeoffStateSpaceHistoricalPrior {
  readonly mad: number;
  readonly median: number;
  readonly sampleSize: number;
}

interface BakeoffStateSpaceObservation {
  readonly activeMarketCount?: number;
  readonly bucketEnd: string;
  readonly bucketStart: string;
  readonly gameElapsedSeconds?: number | null;
  readonly intensity: number;
  readonly sourceCount?: number;
  readonly sourceDominance?: number;
}

interface BakeoffStateSpaceRequest {
  readonly gameId: string;
  readonly observations: readonly BakeoffStateSpaceObservation[];
  readonly params: {
    readonly baselineMode: RuntimeBaselineMode;
    readonly bucketSeconds: number;
    readonly historicalPrior?: BakeoffStateSpaceHistoricalPrior;
    readonly historicalPriorWeight?: number;
    readonly historicalRampCompleteGameMinutes?: number;
    readonly kMad: number;
    readonly openingBaselineBuckets: number;
    readonly openingRampCompleteBuckets: number;
    readonly recentWallMinutes?: number;
    readonly recentWallWeight?: number;
    readonly stateSpace: Record<string, unknown>;
    readonly trailingBuckets: number;
    readonly trailingGameMinutes: number;
    readonly warmupBuckets: number;
  };
}

interface BakeoffStateSpaceResponseObservation {
  readonly bucketEnd: string;
  readonly bucketStart: string;
  readonly fired: boolean;
  readonly threshold: number;
}

interface HistoricalPrior {
  readonly median: number;
  readonly mad: number;
  readonly sampleSize: number;
}

interface Fire {
  readonly gameId: string;
  readonly bucketStartIso: string;
  readonly observedAtIso: string;
  readonly observedAtSec: number;
  readonly score: number;
  readonly threshold: number;
  readonly period: number | null;
  readonly secondsRemaining: number | null;
  readonly scoreMarginAbs: number | null;
  readonly activeMarketCount: number;
  readonly sourceCount: number;
  readonly familyCount: number;
  readonly offpriceFanout: number;
}

interface IncidentAlgoResult {
  readonly incidentId: string;
  readonly algoId: string;
  readonly scoreable: boolean;
  readonly caught: boolean;
  readonly leadSeconds: number | null;
  readonly fireIso: string | null;
  readonly skipReason: string | null;
}

interface AlgorithmSummary {
  readonly algoId: string;
  readonly name: string;
  readonly family: string;
  readonly caughtScoreable: number;
  readonly scoreableIncidents: number;
  readonly medianLeadSeconds: number | null;
  readonly meanLeadSeconds: number | null;
  readonly preEventCaughtScoreable: number;
  readonly postEventCaughtScoreable: number;
  readonly meanFiresPerGame: number;
  readonly medianFiresPerGame: number;
  readonly finalFiveCloseFiresPerGame: number;
  readonly meanEpisodesPerGame: number;
  readonly maxEpisodesPerGame: number;
  readonly p95FiresPerGame: number;
  readonly maxFiresPerGame: number;
  readonly fireDispersionRatio: number | null;
  readonly outlierGameCount: number;
  readonly marketOutlierEpisodesCaught: number;
  readonly marketOutlierEpisodeCount: number;
  readonly marketOutlierRecall: number;
  readonly medianMarketOutlierLeadSeconds: number | null;
  readonly firesInsideMarketOutlierWindows: number;
  readonly firesOutsideMarketOutlierWindows: number;
  readonly firesInsideMarketOutlierShare: number;
  readonly firesPerCaughtIncident: number | null;
  readonly caughtPer100Fires: number;
  readonly totalFires: number;
  readonly denominatorGames: number;
  readonly formula: string;
  readonly rationale: string;
}

interface BakeoffPayload {
  readonly generatedAt: string;
  readonly sourceRegistryPath: string;
  readonly dbPath: string;
  readonly incidentCount: number;
  readonly exactAnchorIncidentCount: number;
  readonly scoreableIncidentCount: number;
  readonly denominatorGames: number;
  readonly algorithmCount: number;
  readonly bestSummary: AlgorithmSummary | null;
  readonly incidents: readonly RawIncident[];
  readonly algorithms: readonly AlgoSpec[];
  readonly summaries: readonly AlgorithmSummary[];
  readonly gameSummaries: readonly GameAlgorithmSummary[];
  readonly marketOutlierEpisodes: readonly MarketOutlierEpisode[];
  readonly marketOutlierResults: readonly MarketOutlierAlgoResult[];
  readonly fireOutliers: readonly FireOutlier[];
  readonly incidentResults: readonly IncidentAlgoResult[];
  readonly researchSources: readonly ResearchSource[];
  readonly coverage: {
    readonly totalIncidents: number;
    readonly exactAnchorIncidents: number;
    readonly scoreableIncidents: number;
    readonly denominatorGames: number;
  };
}

interface GameAlgorithmSummary {
  readonly algoId: string;
  readonly gameId: string;
  readonly scheduledStart: string;
  readonly matchup: string;
  readonly fires: number;
  readonly episodes: number;
  readonly finalFiveCloseFires: number;
  readonly firstFireIso: string | null;
  readonly lastFireIso: string | null;
  readonly bucketSeconds: number;
  readonly bucketCount: number;
  readonly quotePairCount: number;
  readonly microEventCount: number;
  readonly activeMarketCount: number;
  readonly sourceCount: number;
  readonly familyCount: number;
  readonly meanActiveMarketsPerBucket: number;
  readonly p95ActiveMarketsPerBucket: number;
  readonly maxActiveMarketsPerBucket: number;
  readonly p95Score: number;
  readonly maxScore: number;
  readonly firesPer100QuotePairs: number;
  readonly episodesPer100QuotePairs: number;
  readonly diagnosis: string;
}

interface FireOutlier {
  readonly algoId: string;
  readonly gameId: string;
  readonly matchup: string;
  readonly fires: number;
  readonly episodes: number;
  readonly medianFires: number;
  readonly p95Fires: number;
  readonly quotePairCount: number;
  readonly activeMarketCount: number;
  readonly sourceCount: number;
  readonly familyCount: number;
  readonly finalFiveCloseFires: number;
  readonly diagnosis: string;
}

interface MarketOutlierEpisode {
  readonly gameId: string;
  readonly scheduledStart: string;
  readonly matchup: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly startIso: string;
  readonly endIso: string;
  readonly bucketSeconds: number;
  readonly bucketCount: number;
  readonly peakSeverity: number;
  readonly meanSeverity: number;
  readonly peakPriceMoveZ: number;
  readonly peakBreadthZ: number;
  readonly peakOffpriceZ: number;
  readonly peakActiveMarkets: number;
  readonly peakSources: number;
  readonly peakFamilies: number;
  readonly diagnosis: string;
}

interface MarketOutlierAlgoResult {
  readonly algoId: string;
  readonly gameId: string;
  readonly episodeStartIso: string;
  readonly episodeEndIso: string;
  readonly scoreable: boolean;
  readonly caught: boolean;
  readonly leadSeconds: number | null;
  readonly fireIso: string | null;
  readonly firesInWindow: number;
}

interface ResearchSource {
  readonly title: string;
  readonly url: string;
  readonly use: string;
}

interface ReportNote {
  readonly algoId: string;
  readonly severity: "caution" | "weak" | "pending";
  readonly note: string;
}

interface MethodAdjustment {
  readonly label: string;
  readonly formula: string;
  readonly reason: string;
}

const ARCHIVE_ONLY_INCIDENTS: readonly RawIncident[] = [
  {
    id: "archive_sasser_rebound",
    confidence: "medium",
    anchorType: "archive-only",
    gameDate: "2026-05-07/14",
    teams: "",
    gameId: "",
    period: "Q2",
    clock: "07:32",
    utcTime: "",
    stat: "rebound",
    creditedPlayer: "Marcus Sasser",
    rightfulPlayer: "",
    sourceOrigin: "archive_only",
    sourceReference:
      "nba-predict/.docs-archive/2026-05-repo-audit/outputs/innovation-team-suspend-signal-report/research/03b-external-research-verified.md",
    sourceTextSummary:
      "Archive-only rebound misattribution candidate not carried into current registry.",
    notes: "No exact UTC anchor recovered in current generated registry.",
    officialCorrection: false,
    localBoardGameIds: [],
  },
  {
    id: "archive_levert_jenkins_assist",
    confidence: "medium",
    anchorType: "archive-only",
    gameDate: "2026-05-07/14",
    teams: "",
    gameId: "",
    period: "Q3",
    clock: "04:13",
    utcTime: "",
    stat: "assist",
    creditedPlayer: "Cade LeVert / Daniss Jenkins",
    rightfulPlayer: "",
    sourceOrigin: "archive_only",
    sourceReference:
      "nba-predict/.docs-archive/2026-05-repo-audit/outputs/innovation-team-suspend-signal-report/research/03b-external-research-verified.md",
    sourceTextSummary: "Archive-only missing-assist candidate not carried into current registry.",
    notes: "No exact UTC anchor recovered in current generated registry.",
    officialCorrection: false,
    localBoardGameIds: [],
  },
  {
    id: "archive_sarr_trae_rebound",
    confidence: "medium",
    anchorType: "archive-only",
    gameDate: "2026-03-09",
    teams: "",
    gameId: "",
    period: "",
    clock: "",
    utcTime: "",
    stat: "rebound",
    creditedPlayer: "Alexandre Sarr",
    rightfulPlayer: "Trae Young",
    sourceOrigin: "archive_only",
    sourceReference:
      "nba-predict/.docs-archive/2026-05-repo-audit/outputs/innovation-team-suspend-signal-report/research/03b-external-research-verified.md",
    sourceTextSummary:
      "Archive-only regular-season rebound candidate outside the local playoff window.",
    notes: "Outside current local quote/PBP coverage.",
    officialCorrection: false,
    localBoardGameIds: [],
  },
];

const RESEARCH_SOURCES: readonly ResearchSource[] = [
  {
    title: "NBA clutch endpoint parameters",
    url: "https://nba-api-sbang.readthedocs.io/en/latest/nba_api/stats/endpoints/nba_stats_endpoints/",
    use: "Clutch split: final five minutes plus point differential.",
  },
  {
    title: "Metulini & Le Carre, Stop the Clock: Are Timeout Effects Real?",
    url: "https://arxiv.org/abs/2009.06750",
    use: "Timeout effects are endogenous; do not treat all stoppages as one regime.",
  },
  {
    title: "Cont, Kukanov & Stoikov, The Price Impact of Order Book Events",
    url: "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1712822",
    use: "Order-flow imbalance and market depth motivate fanout/depth-aware variants.",
  },
  {
    title: "Cont, Kukanov & Stoikov arXiv mirror",
    url: "https://arxiv.org/abs/1011.6402",
    use: "Primary formula inspiration for order-flow over raw volume.",
  },
  {
    title: "Adams & MacKay, Bayesian Online Changepoint Detection",
    url: "https://arxiv.org/abs/0710.3742",
    use: "Online regime-shift framing behind the CUSUM/changepoint contestants.",
  },
  {
    title: "RiskMetrics Technical Document",
    url: "https://faculty.runi.ac.il/kobi/riskmgt/rmtd.pdf",
    use: "EWMA volatility baseline.",
  },
  {
    title: "Engle, ARCH",
    url: "https://finance.martinsewell.com/arch-garch/Engle1982.pdf",
    use: "Conditional volatility and heteroskedasticity warning.",
  },
  {
    title: "Gabel & Redner, Random Walk Picture of Basketball Scoring",
    url: "https://arxiv.org/abs/1109.2825",
    use: "Run/reversal baselines and scoring-volatility humility.",
  },
  {
    title: "NBA Last Two Minute Reports archive",
    url: "https://official.nba.com/nba-officiating-last-two-minute-reports-archive/",
    use: "Late-game officiating/reporting context; not a stat-correction oracle.",
  },
  {
    title: "NBA Last Two Minute report criteria",
    url: "https://official.nba.com/2023-24-nba-officiating-last-two-minute-reports/",
    use: "Official late-game review window: final two minutes of close fourth quarters/overtime.",
  },
  {
    title: "NBA clutch definition example",
    url: "https://www.nba.com/news/stats-breakdown-coming-through-in-the-clutch",
    use: "NBA.com defines clutch as final five minutes of fourth/overtime within five points.",
  },
  {
    title: "NBA Rule 5 scoring and timing",
    url: "https://official.nba.com/rule-no-5-scoring-and-timing/",
    use: "Clock/timeout game-state context for wall-clock versus game-clock memory.",
  },
  {
    title: "Polymarket market-data WebSocket docs",
    url: "https://docs.polymarket.com/market-data/websocket/overview",
    use: "Live order-book/trade capture basis; historical backfill is not equivalent to live tape.",
  },
  {
    title: "Kalshi market orderbook docs",
    url: "https://docs.kalshi.com/api-reference/market/get-multiple-market-orderbooks",
    use: "Order-book surface for future OFI/depth-aware microstructure variants.",
  },
  {
    title: "Cboe VIX methodology",
    url: "https://cdn.cboe.com/resources/indices/Volatility_Index_Methodology_Cboe_Volatility_Index.pdf",
    use: "Volatility benchmark practice: fixed target horizon and explicit sampling rules.",
  },
  {
    title: "NOAA GEFS ensemble model",
    url: "https://www.ncei.noaa.gov/products/weather-climate-models/global-ensemble-forecast",
    use: "Forecast uncertainty is represented with ensembles, not a single brittle trajectory.",
  },
  {
    title: "NIST median absolute deviation",
    url: "https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/mad.htm",
    use: "MAD is robust scale, but short/tied samples still need floors or alternate scale estimators.",
  },
  {
    title: "Rousseeuw-Croux robust scale estimators",
    url: "https://www.tandfonline.com/doi/abs/10.1080/01621459.1993.10476408",
    use: "Qn/Sn motivation for small-window robust scale candidates.",
  },
];

const METHOD_ADJUSTMENTS: readonly MethodAdjustment[] = [
  {
    label: "Game-clock plus wall-clock blend",
    formula:
      "center = (median(last12GameMin) + 1.5 * median(last4WallMin)) / 2.5; scale uses the same weights.",
    reason:
      "Game action should define the main memory, while timeout/dead-ball betting pressure still gets a heavier short wall-clock overlay.",
  },
  {
    label: "Historical opening prior with sample strength",
    formula:
      "hist = 0.5 * awayLast5AwayOpening + 0.5 * homeLast5HomeOpening; eta = ramp * priorN / (priorN + liveN + c).",
    reason:
      "Keeps the user-specified home/away travel/home split while preventing tiny samples from acting fully authoritative.",
  },
  {
    label: "Calendar zero buckets",
    formula: "x_t = 0 when no quote/trade movement; normalize by activeMarkets_t * bucketSeconds.",
    reason:
      "Sparse-only buckets delete quiet time and make calm games look statistically absent instead of calm.",
  },
  {
    label: "Short-window robust scale floor",
    formula: "scale = max(Qn_or_Sn(prior), 1.4826 * MAD(prior), rho * median(nonzero x), eps).",
    reason:
      "Tiny/tied MAD windows make any nonzero move look enormous; Qn/Sn and a data-derived floor are safer for two-to-eight-minute starts.",
  },
  {
    label: "Flow, not cumulative volume",
    formula:
      "flow_t = max(0, volume_t - volume_{t-1}); score = sum(abs(deltaLogit) * log1p(flow_t)).",
    reason:
      "Prevents high-liquidity markets from looking alarming just because their cumulative or 24h volume is large.",
  },
  {
    label: "Signed coherence",
    formula: "coh = abs(sum(w_i * signedDelta_i)) / sum(w_i * absDelta_i); score *= coh.",
    reason: "Board churn in mixed directions should not count like one-sided repricing.",
  },
  {
    label: "Latency-tolerant source confirmation",
    formula: "confirm if another source/family has same signed move inside t +/- sourceLag.",
    reason: "Same-bucket cross-source gates mostly test ingestion synchrony, not market agreement.",
  },
  {
    label: "Alert episodes",
    formula:
      "merge fires within 90s per game/stat family; rank episodes/game and caught per 100 episodes.",
    reason:
      "A 300-fire game is usually one or several regimes repeatedly paging, not 300 separate operator decisions.",
  },
  {
    label: "Continuous clutch/foul leverage",
    formula:
      "leverage = exp(-abs(margin)/4) / sqrt(max(1, secondsRemaining/24)); foulMode = sigmoid(clock, margin, FT/foul count, deadRatio).",
    reason:
      "NBA clutch and foul modes are continuous risk regimes, not only hard final-five/final-sixty switches.",
  },
  {
    label: "Order-flow imbalance row",
    formula:
      "OFI = deltaBidSize - deltaAskSize + signedTradeSize; impact = OFI / max(depthNearMid, eps).",
    reason:
      "Depth and order flow are better microstructure signals than raw volume once book snapshots are available.",
  },
];

const REPORT_NOTES: readonly ReportNote[] = [
  {
    algoId: "A00_runtime_state_space_live_defaults",
    severity: "caution",
    note: "This is the current live board runtime from detector-defaults.json; treat it as product truth, not as a generic research comparator.",
  },
  {
    algoId: "A00_runtime_state_space_baseline_defaults",
    severity: "caution",
    note: "Packaged baseline of the live Python runtime, useful only as a control against the currently saved live defaults.",
  },
  {
    algoId: "A01_legacy_60_vw_k3",
    severity: "caution",
    note: "Useful sensitive control, but fixed 60s wall buckets mix live play, whistles, timeouts, and free throws.",
  },
  {
    algoId: "A02_legacy_60_vw_k6",
    severity: "caution",
    note: "Useful calmer control, not a basketball-specific memory model.",
  },
  {
    algoId: "A03_opening_ramp_30",
    severity: "weak",
    note: "Opening-ramp shape is directionally right, but this row catches too little for its fire burden.",
  },
  {
    algoId: "A06_wall4_timeout_sensitive",
    severity: "weak",
    note: "The worst fire burden in the current run; short wall memory alone is too jumpy.",
  },
  {
    algoId: "A07_final5_close_suppressed",
    severity: "pending",
    note: "Late-game suppression is not proven because the current scoreable incident set has no final-five-close fires.",
  },
  {
    algoId: "A08_final60_foul_mode",
    severity: "pending",
    note: "Final-minute foul-mode suppression is untested by the current incident denominator.",
  },
  {
    algoId: "A09_volume_heavy_short",
    severity: "caution",
    note: "Highest recall, but it is a noisy volume amplifier until flow/depth normalization and episode ranking are in place.",
  },
  {
    algoId: "A10_offprice_concentration",
    severity: "pending",
    note: "Not evaluated on current persisted surfaces; zero fires means missing microstructure inputs, not failed theory.",
  },
  {
    algoId: "A11_offprice_fanout",
    severity: "pending",
    note: "Not evaluated until previous-price/reference-mid/depth fields are materialized.",
  },
  {
    algoId: "A13_cross_source_confirm",
    severity: "pending",
    note: "Same-bucket cross-source confirmation mostly measures source coverage and latency.",
  },
  {
    algoId: "A16_rv_bv_jump",
    severity: "caution",
    note: "A rough jump proxy, not true RV/BV over signed high-frequency returns.",
  },
  {
    algoId: "A17_clutch_har_fanout",
    severity: "pending",
    note: "Name overstates proof; HAR/clutch behavior needs late-game scoreable incidents.",
  },
  {
    algoId: "A18_historical5_live_ramp",
    severity: "caution",
    note: "Historical prior is directionally important, but this incident set mostly does not validate opening behavior.",
  },
  {
    algoId: "A19_historical5_fanout",
    severity: "caution",
    note: "Fanout guard needs independent-market de-duplication; current raw fanout can still add fires.",
  },
];

const RESEARCH_ALGORITHMS: readonly AlgoSpec[] = [
  {
    id: "A01_legacy_60_vw_k3",
    name: "Legacy 60s VW K=3",
    family: "control",
    bucketSeconds: 60,
    scoreKind: "board-vw",
    baselineKind: "mad-wall",
    k: 3,
    warmupBuckets: 8,
    minPrior: 8,
    trailingBuckets: 20,
    formula: "I_t > median(I_{t-20:t-1}) + 3 * MAD(I_{t-20:t-1})",
    rationale: "Current sensitive control; catches more but cries more.",
    citations: ["Rousseeuw-Croux robust scale", "Signal Console board-mad contract"],
  },
  {
    id: "A02_legacy_60_vw_k6",
    name: "Legacy 60s VW K=6",
    family: "control",
    bucketSeconds: 60,
    scoreKind: "board-vw",
    baselineKind: "mad-wall",
    k: 6,
    warmupBuckets: 8,
    minPrior: 8,
    trailingBuckets: 20,
    formula: "I_t > median(I_{t-20:t-1}) + 6 * MAD(I_{t-20:t-1})",
    rationale: "Calmer control from the original report.",
    citations: ["Rousseeuw-Croux robust scale", "Signal Console report K=6 comparison"],
  },
  {
    id: "A03_opening_ramp_30",
    name: "30s Opening Ramp",
    family: "faster-memory",
    bucketSeconds: 30,
    scoreKind: "board-vw",
    baselineKind: "mad-wall",
    k: 3.4,
    warmupBuckets: 4,
    minPrior: 4,
    trailingBuckets: 16,
    formula: "30s buckets, first-fire gate at 2m, trailing wall baseline up to 8m.",
    rationale: "Basketball-specific shorter window; tests whether 60s is too slow.",
    citations: ["HAR-RV multi-horizon idea", "Signal Console opening-ramp implementation"],
  },
  {
    id: "A04_game12_recent4",
    name: "12 Game Min + Recent 4 Wall Min",
    family: "game-clock",
    bucketSeconds: 30,
    scoreKind: "board-vw",
    baselineKind: "mad-blend",
    k: 3.6,
    warmupBuckets: 4,
    minPrior: 4,
    gameMemorySeconds: 12 * SECONDS_PER_MINUTE,
    recentWallSeconds: 4 * SECONDS_PER_MINUTE,
    recentWallWeight: 1.5,
    formula:
      "baseline = game-clock 12m robust scale blended with 1.5x recent wall 4m robust scale.",
    rationale: "Directly tests game minutes versus timeout/wall-clock stress.",
    citations: ["Corsi HAR-RV", "NBA clutch/game-clock regime idea"],
  },
  {
    id: "A05_game6_fast",
    name: "6 Game Min Fast Memory",
    family: "game-clock",
    bucketSeconds: 30,
    scoreKind: "board-vw",
    baselineKind: "mad-game",
    k: 3.5,
    warmupBuckets: 4,
    minPrior: 4,
    gameMemorySeconds: 6 * SECONDS_PER_MINUTE,
    formula: "I_t versus robust baseline over the prior six game-clock minutes.",
    rationale: "Tests the user's view that basketball memory should be much shorter.",
    citations: ["NBA game-clock regime idea", "RiskMetrics uneven spacing caution"],
  },
  {
    id: "A06_wall4_timeout_sensitive",
    name: "4 Wall Min Timeout-Sensitive",
    family: "wall-clock",
    bucketSeconds: 30,
    scoreKind: "board-vw",
    baselineKind: "mad-wall",
    k: 3.7,
    warmupBuckets: 4,
    minPrior: 4,
    wallMemorySeconds: 4 * SECONDS_PER_MINUTE,
    formula: "I_t versus robust baseline over prior four wall-clock minutes.",
    rationale: "Lets timeout/stoppage betting pressure alter the baseline quickly.",
    citations: ["Timeout endogeneity warning", "HAR-RV short horizon"],
  },
  {
    id: "A07_final5_close_suppressed",
    name: "Final 5 Close Suppressed",
    family: "late-game-suppression",
    bucketSeconds: 30,
    scoreKind: "board-vw",
    baselineKind: "mad-blend",
    k: 3.4,
    warmupBuckets: 4,
    minPrior: 4,
    gameMemorySeconds: 12 * SECONDS_PER_MINUTE,
    recentWallSeconds: 4 * SECONDS_PER_MINUTE,
    recentWallWeight: 1.5,
    finalFiveCloseMultiplier: 1.75,
    formula: "A04, but multiply threshold by 1.75 in final five minutes when margin <= 5.",
    rationale: "Explicit false-alarm control for normal clutch volatility.",
    citations: ["NBA clutch endpoint", "Endgame win-probability modeling"],
  },
  {
    id: "A08_final60_foul_mode",
    name: "Final 60s Foul-Game Suppressed",
    family: "late-game-suppression",
    bucketSeconds: 30,
    scoreKind: "board-vw",
    baselineKind: "mad-blend",
    k: 3.4,
    warmupBuckets: 4,
    minPrior: 4,
    gameMemorySeconds: 12 * SECONDS_PER_MINUTE,
    recentWallSeconds: 4 * SECONDS_PER_MINUTE,
    recentWallWeight: 1.5,
    finalFiveCloseMultiplier: 1.35,
    finalFoulModeMultiplier: 2.25,
    formula: "A04 with stronger threshold in final 60s when margin <= 3.",
    rationale: "Separates intentional-foul chaos from true stat-misallocation risk.",
    citations: ["NBA clutch endpoint", "Performance under pressure free throw literature"],
  },
  {
    id: "A09_volume_heavy_short",
    name: "Volume-Heavy Short Memory",
    family: "money-weighted",
    bucketSeconds: 30,
    scoreKind: "volume-heavy",
    baselineKind: "mad-wall",
    k: 4.1,
    warmupBuckets: 4,
    minPrior: 4,
    wallMemorySeconds: 6 * SECONDS_PER_MINUTE,
    formula: "sum(|Δlogit(p)| * log1p(volume)^1.5) over 30s, six-minute wall baseline.",
    rationale: "Less time memory, more weight on actual wager/volume magnitude.",
    citations: ["Amihud/Kyle illiquidity family", "Order-flow imbalance literature"],
  },
  {
    id: "A10_offprice_concentration",
    name: "Off-Price Concentration",
    family: "microstructure",
    bucketSeconds: 30,
    scoreKind: "offprice",
    baselineKind: "mad-wall",
    k: 3.2,
    warmupBuckets: 2,
    minPrior: 3,
    wallMemorySeconds: 12 * SECONDS_PER_MINUTE,
    formula: "severity = volumeShare * offPriceDistance * spread/depth stress.",
    rationale: "Single-print detector extended with volume share and depth/spread stress.",
    citations: ["Prediction-market microstructure", "Polymarket/Kalshi orderbook docs"],
  },
  {
    id: "A11_offprice_fanout",
    name: "Off-Price Fanout Required",
    family: "microstructure",
    bucketSeconds: 30,
    scoreKind: "offprice",
    baselineKind: "mad-wall",
    k: 2.7,
    warmupBuckets: 2,
    minPrior: 3,
    wallMemorySeconds: 12 * SECONDS_PER_MINUTE,
    requiredOffpriceFanout: 2,
    formula: "A10, but require off-price activity in at least two source markets in the bucket.",
    rationale: "Prevents one isolated print from suspending a game.",
    citations: ["Correlated-market fanout coherence", "Order-flow imbalance literature"],
  },
  {
    id: "A12_board_fanout_range",
    name: "Board Fanout Range Required",
    family: "fanout",
    bucketSeconds: 30,
    scoreKind: "board-vw",
    baselineKind: "mad-blend",
    k: 3.0,
    warmupBuckets: 4,
    minPrior: 4,
    gameMemorySeconds: 12 * SECONDS_PER_MINUTE,
    recentWallSeconds: 4 * SECONDS_PER_MINUTE,
    recentWallWeight: 1.5,
    requiredMarkets: 3,
    requiredFamilies: 2,
    formula: "A04, but require at least three markets and two families to move.",
    rationale: "No single market can take out the detector by itself.",
    citations: ["Cross-market fanout coherence", "Prediction-market aggregation"],
  },
  {
    id: "A13_cross_source_confirm",
    name: "Cross-Source Confirmed",
    family: "fanout",
    bucketSeconds: 30,
    scoreKind: "board-vw",
    baselineKind: "mad-blend",
    k: 2.8,
    warmupBuckets: 4,
    minPrior: 4,
    gameMemorySeconds: 12 * SECONDS_PER_MINUTE,
    recentWallSeconds: 4 * SECONDS_PER_MINUTE,
    recentWallWeight: 1.5,
    requiredSources: 2,
    formula: "A04, but require at least two sources to contribute inside the bucket.",
    rationale: "Suppresses single-venue noise while preserving cross-venue repricing.",
    citations: ["Rothschild-Pennock prediction markets", "Betting exchange confirmation"],
  },
  {
    id: "A14_gap_ewma",
    name: "Gap-Decay EWMA",
    family: "volatility-model",
    bucketSeconds: 30,
    scoreKind: "logit-vw",
    baselineKind: "ewma",
    k: 3.25,
    warmupBuckets: 4,
    minPrior: 4,
    formula: "z_t = (x_t - μ_t) / σ_t with α = exp(-Δt / τ), τ = 6 wall minutes.",
    rationale: "Handles uneven sparse ticks without pretending samples are evenly spaced.",
    citations: ["RiskMetrics EWMA", "Engle ARCH"],
  },
  {
    id: "A15_cusum_shift",
    name: "CUSUM Regime Shift",
    family: "change-point",
    bucketSeconds: 30,
    scoreKind: "board-vw",
    baselineKind: "cusum",
    k: 4.8,
    warmupBuckets: 4,
    minPrior: 8,
    wallMemorySeconds: 10 * SECONDS_PER_MINUTE,
    formula: "C_t = max(0, C_{t-1} + robust_z_t - drift), alarm when C_t > h.",
    rationale: "Finds starts of sustained repricing regimes, not only one tall bucket.",
    citations: ["Page CUSUM", "Basseville-Nikiforov change detection"],
  },
  {
    id: "A16_rv_bv_jump",
    name: "RV/BV Jump Split",
    family: "volatility-model",
    bucketSeconds: 30,
    scoreKind: "logit-vw",
    baselineKind: "rv-bv",
    k: 3.1,
    warmupBuckets: 6,
    minPrior: 8,
    wallMemorySeconds: 12 * SECONDS_PER_MINUTE,
    formula: "Require robust high x_t and current squared move / bipower variation > 2.25.",
    rationale: "Separates one ugly print from broad repricing.",
    citations: ["Andersen realized volatility", "Barndorff-Nielsen & Shephard bipower variation"],
  },
  {
    id: "A17_clutch_har_fanout",
    name: "Clutch HAR + Fanout",
    family: "late-game-suppression",
    bucketSeconds: 30,
    scoreKind: "hybrid",
    baselineKind: "mad-blend",
    k: 3.2,
    warmupBuckets: 4,
    minPrior: 4,
    gameMemorySeconds: 12 * SECONDS_PER_MINUTE,
    recentWallSeconds: 4 * SECONDS_PER_MINUTE,
    recentWallWeight: 1.5,
    finalFiveCloseMultiplier: 1.5,
    finalFoulModeMultiplier: 2.0,
    requiredMarkets: 2,
    formula:
      "Hybrid board + off-price stress, HAR-like memory, late-game threshold lift, fanout >= 2.",
    rationale: "Most NBA-specific all-in contestant for final-minute false-alarm control.",
    citations: ["NBA clutch endpoint", "HAR-RV", "Microstructure fanout"],
  },
  {
    id: "A18_historical5_live_ramp",
    name: "Last-5 Home/Away Prior Ramp",
    family: "historical-prior",
    bucketSeconds: 30,
    scoreKind: "board-vw",
    baselineKind: "mad-historical",
    k: 3.5,
    warmupBuckets: 4,
    minPrior: 4,
    gameMemorySeconds: 12 * SECONDS_PER_MINUTE,
    recentWallSeconds: 4 * SECONDS_PER_MINUTE,
    recentWallWeight: 1.5,
    openingBaselineBuckets: 4,
    historicalLastGames: 5,
    historicalAwayWeight: 0.5,
    historicalPriorWeight: 1,
    historicalRampCompleteGameSeconds: 12 * SECONDS_PER_MINUTE,
    formula:
      "prior = 50% last five away-team away openings + 50% last five home-team home openings; share fades to zero by 12 game minutes.",
    rationale:
      "Tests the real deployable historical-prior profile instead of making the first few minutes depend only on current-game noise.",
    citations: [
      "Signal Console historical-blend implementation",
      "Hierarchical/shrinkage prior idea",
    ],
  },
  {
    id: "A19_historical5_fanout",
    name: "Historical Prior + Fanout Guard",
    family: "historical-prior",
    bucketSeconds: 30,
    scoreKind: "board-vw",
    baselineKind: "mad-historical",
    k: 3.15,
    warmupBuckets: 4,
    minPrior: 4,
    gameMemorySeconds: 12 * SECONDS_PER_MINUTE,
    recentWallSeconds: 4 * SECONDS_PER_MINUTE,
    recentWallWeight: 1.5,
    openingBaselineBuckets: 4,
    historicalLastGames: 5,
    historicalAwayWeight: 0.5,
    historicalPriorWeight: 1,
    historicalRampCompleteGameSeconds: 12 * SECONDS_PER_MINUTE,
    requiredMarkets: 3,
    requiredFamilies: 2,
    formula: "A18 with at least three moving markets and two market families in the 30s bucket.",
    rationale:
      "Keeps the historical opening prior, but refuses to let one market or family carry the alarm by itself.",
    citations: ["Signal Console historical-blend implementation", "Order-flow fanout coherence"],
  },
  {
    id: "A20_coverage_norm_historical5",
    name: "Coverage-Normalized Historical Prior",
    family: "fire-control",
    bucketSeconds: 30,
    scoreKind: "coverage-normalized-vw",
    baselineKind: "mad-historical",
    k: 3.05,
    warmupBuckets: 4,
    minPrior: 4,
    gameMemorySeconds: 12 * SECONDS_PER_MINUTE,
    recentWallSeconds: 4 * SECONDS_PER_MINUTE,
    recentWallWeight: 1.5,
    openingBaselineBuckets: 4,
    historicalLastGames: 5,
    historicalAwayWeight: 0.5,
    historicalPriorWeight: 1,
    historicalRampCompleteGameSeconds: 12 * SECONDS_PER_MINUTE,
    requiredMarkets: 3,
    requiredFamilies: 2,
    formula:
      "A19, but board intensity is divided by sqrt(active moving markets) before the robust baseline.",
    rationale:
      "Tests whether 300-fire games are partly listed-market breadth artifacts rather than true per-market volatility.",
    citations: ["Market breadth normalization", "Signal Console fire-count anomaly audit"],
  },
  {
    id: "A21_historical5_fanout_cooldown",
    name: "Historical Prior + Fanout + Cooldown",
    family: "fire-control",
    bucketSeconds: 30,
    scoreKind: "board-vw",
    baselineKind: "mad-historical",
    k: 3.15,
    warmupBuckets: 4,
    minPrior: 4,
    gameMemorySeconds: 12 * SECONDS_PER_MINUTE,
    recentWallSeconds: 4 * SECONDS_PER_MINUTE,
    recentWallWeight: 1.5,
    openingBaselineBuckets: 4,
    historicalLastGames: 5,
    historicalAwayWeight: 0.5,
    historicalPriorWeight: 1,
    historicalRampCompleteGameSeconds: 12 * SECONDS_PER_MINUTE,
    requiredMarkets: 3,
    requiredFamilies: 2,
    cooldownBuckets: SHORT_REGIME_COOLDOWN_BUCKETS,
    formula:
      "A19, plus one fire can suppress the next four 30s buckets so a regime shift does not page every bucket.",
    rationale: "Tests alert-hygiene hysteresis separately from the underlying volatility score.",
    citations: ["Industrial alarm rationalization", "Signal Console fire-count anomaly audit"],
  },
];

function detectorDefaultsEqual(left: DetectorDefaults, right: DetectorDefaults): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function runtimeFormulaFromDefaults(defaults: DetectorDefaults): string {
  const memoryBasis =
    defaults.baselineMode === "historical-blend"
      ? `game ${defaults.trailingGameMinutes}m + wall ${defaults.recentWallMinutes}m @ ${defaults.recentWallWeight}x`
      : `${defaults.trailingBuckets} buckets`;
  return [
    `Python state-space`,
    `mode=${defaults.baselineMode}`,
    `bucket=${defaults.bucketSeconds}s`,
    `trigger=${defaults.kMadLive}`,
    `warmup=${defaults.warmupBuckets} buckets`,
    `memory=${memoryBasis}`,
  ].join(", ");
}

function runtimeRationaleFromDefaults(
  configSource: "baseline-defaults" | "live-defaults",
  defaults: DetectorDefaults,
): string {
  if (configSource === "baseline-defaults") {
    return "Packaged baseline runtime config for side-by-side comparison against the currently saved live defaults.";
  }
  return `Current detector defaults from data/detector-defaults.json: the same Python state-space board model the app uses live, including the saved advanced stateSpace object and ${defaults.baselineMode} anchor profile.`;
}

function isStateSpaceAlgo(algo: AlgoSpec): algo is StateSpaceAlgoSpec {
  return algo.engine === "python-state-space" && algo.stateSpace !== undefined;
}

function runtimeStateSpaceAlgorithm(
  defaults: DetectorDefaults,
  configSource: "baseline-defaults" | "live-defaults",
): StateSpaceAlgoSpec {
  return {
    id:
      configSource === "baseline-defaults"
        ? "A00_runtime_state_space_baseline_defaults"
        : "A00_runtime_state_space_live_defaults",
    name:
      configSource === "baseline-defaults"
        ? "Runtime Python State-Space (Packaged Defaults)"
        : "Runtime Python State-Space (Current Live Defaults)",
    family: "runtime-state-space",
    engine: "python-state-space",
    bucketSeconds: defaults.bucketSeconds,
    scoreKind: "board-vw",
    baselineKind:
      defaults.baselineMode === "historical-blend"
        ? "mad-historical"
        : defaults.baselineMode === "opening-ramp"
          ? "mad-wall"
          : "mad-wall",
    runtimeBaselineMode: defaults.baselineMode,
    k: defaults.kMadLive,
    warmupBuckets: defaults.warmupBuckets,
    minPrior: Math.max(
      1,
      defaults.baselineMode === "historical-blend"
        ? defaults.openingBaselineBuckets
        : defaults.trailingBuckets,
    ),
    trailingBuckets: defaults.trailingBuckets,
    gameMemorySeconds: defaults.trailingGameMinutes * SECONDS_PER_MINUTE,
    recentWallSeconds: defaults.recentWallMinutes * SECONDS_PER_MINUTE,
    recentWallWeight: defaults.recentWallWeight,
    openingBaselineBuckets: defaults.openingBaselineBuckets,
    historicalLastGames: defaults.historicalLastGames,
    historicalAwayWeight: defaults.historicalAwayWeight,
    historicalPriorWeight: defaults.historicalPriorWeight,
    historicalRampCompleteGameSeconds:
      defaults.historicalRampCompleteGameMinutes * SECONDS_PER_MINUTE,
    openingRampCompleteBuckets: defaults.openingRampCompleteBuckets,
    stateSpace: defaults.stateSpace,
    configSource,
    formula: runtimeFormulaFromDefaults(defaults),
    rationale: runtimeRationaleFromDefaults(configSource, defaults),
    citations: [
      "apps/nba-sidecar/src/nba_sidecar/volatility.py",
      "apps/api/src/services/detector-defaults.ts",
      "data/detector-defaults.json",
    ],
  };
}

export function buildRuntimeStateSpaceAlgorithms(
  defaults: DetectorDefaults,
  baselineDefaults: DetectorDefaults = BASELINE_DEFAULTS,
): readonly StateSpaceAlgoSpec[] {
  const current = runtimeStateSpaceAlgorithm(defaults, "live-defaults");
  if (detectorDefaultsEqual(defaults, baselineDefaults)) return [current];
  return [current, runtimeStateSpaceAlgorithm(baselineDefaults, "baseline-defaults")];
}

function buildAlgorithms(defaults: DetectorDefaults): readonly AlgoSpec[] {
  return [...buildRuntimeStateSpaceAlgorithms(defaults), ...RESEARCH_ALGORITHMS];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readJsonRecord(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return isRecord(parsed) ? parsed : {};
}

function unknownRows(rows: unknown[]): readonly unknown[] {
  return rows;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function boolField(row: Record<string, unknown>, key: string): boolean {
  return row[key] === true;
}

function stringArrayField(row: Record<string, unknown>, key: string): readonly string[] {
  const value = row[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeIncident(raw: unknown): RawIncident | null {
  if (!isRecord(raw)) return null;
  const id = stringField(raw, "id");
  if (id === "") return null;
  return {
    id,
    confidence: stringField(raw, "confidence"),
    anchorType: stringField(raw, "anchor_type"),
    gameDate: stringField(raw, "game_date"),
    teams: stringField(raw, "teams"),
    gameId: stringField(raw, "game_id"),
    period: stringField(raw, "period"),
    clock: stringField(raw, "clock"),
    utcTime: stringField(raw, "utc_time"),
    stat: stringField(raw, "stat"),
    creditedPlayer: stringField(raw, "credited_player"),
    rightfulPlayer: stringField(raw, "rightful_player"),
    sourceOrigin: stringField(raw, "source_origin"),
    sourceReference: stringField(raw, "source_reference"),
    sourceTextSummary: stringField(raw, "source_text_summary"),
    notes: stringField(raw, "notes"),
    officialCorrection: boolField(raw, "official_correction"),
    localBoardGameIds: stringArrayField(raw, "local_board_game_ids"),
  };
}

function readIncidents(): readonly RawIncident[] {
  const payload: IncidentRegistryPayload = readJsonRecord(SOURCE_REGISTRY_PATH);
  const incidents = (payload.incidents ?? []).flatMap((item): readonly RawIncident[] => {
    const incident = normalizeIncident(item);
    return incident === null ? [] : [incident];
  });
  const seen = new Set(incidents.map((incident) => incident.id));
  const extras = ARCHIVE_ONLY_INCIDENTS.filter((incident) => !seen.has(incident.id));
  return [...incidents, ...extras];
}

function parseIsoSeconds(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms / MILLISECONDS_PER_SECOND : null;
}

function isoFromSeconds(value: number): string {
  return new Date(value * MILLISECONDS_PER_SECOND).toISOString();
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const middleValue = ordered[middle];
  if (middleValue === undefined) return 0;
  if (ordered.length % 2 === 1) return middleValue;
  const previous = ordered[middle - 1] ?? middleValue;
  return (previous + middleValue) / 2;
}

function mad(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const position = (ordered.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = ordered[lower];
  const upperValue = ordered[upper];
  if (lowerValue === undefined) return null;
  if (upperValue === undefined || lower === upper) return lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function rounded(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clampProbability(value: number): number {
  return Math.min(1 - PROB_EPSILON, Math.max(PROB_EPSILON, value));
}

function logit(value: number): number {
  const p = clampProbability(value);
  return Math.log(p / (1 - p));
}

function parseClockSecondsRemaining(clock: string | null): number | null {
  if (clock === null || clock.trim() === "") return null;
  const iso = /^PT(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(clock.trim());
  if (iso !== null) {
    const minutes = Number.parseFloat(iso[1] ?? "0");
    const seconds = Number.parseFloat(iso[2] ?? "0");
    const total = minutes * SECONDS_PER_MINUTE + seconds;
    return Number.isFinite(total) ? total : null;
  }
  const mmss = /^(\d{1,2}):(\d{2})(?:\.\d+)?$/.exec(clock.trim());
  if (mmss !== null) {
    const minutes = Number.parseInt(mmss[1] ?? "0", 10);
    const seconds = Number.parseInt(mmss[2] ?? "0", 10);
    return minutes * SECONDS_PER_MINUTE + seconds;
  }
  return null;
}

function gameElapsedSeconds(period: number | null, secondsRemaining: number | null): number | null {
  if (period === null || secondsRemaining === null || period < 1) return null;
  const completedRegulationPeriods = Math.min(period - 1, 4);
  const completedOvertimePeriods = Math.max(0, period - 5);
  const currentPeriodLength = period <= 4 ? REGULATION_PERIOD_SECONDS : OVERTIME_PERIOD_SECONDS;
  return (
    completedRegulationPeriods * REGULATION_PERIOD_SECONDS +
    completedOvertimePeriods * OVERTIME_PERIOD_SECONDS +
    Math.max(0, currentPeriodLength - secondsRemaining)
  );
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`expected ${key} string`);
  return value;
}

function normalizeGameId(gameId: string): string {
  if (gameId === "") return "";
  if (gameId.startsWith("nba-")) return gameId;
  if (/^\d{10}$/.test(gameId)) return `nba-${gameId}`;
  return gameId;
}

function participantKey(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    for (const key of ["key", "abbreviation", "name", "shortName"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim() !== "") {
        return value.trim().toLowerCase();
      }
    }
    return null;
  } catch {
    return null;
  }
}

function loadGameWindows(db: ReturnType<typeof openGoldDb>): readonly GameWindow[] {
  const gameRows = unknownRows(
    db
      .prepare(
        `SELECT pbp.game_id AS gameId,
              COALESCE(g.scheduled_start, MIN(pbp.time_actual)) AS scheduledStart,
              g.home_participant_json AS homeParticipantJson,
              g.away_participant_json AS awayParticipantJson,
              MIN(pbp.time_actual) AS startIso,
              MAX(pbp.time_actual) AS endIso
       FROM nba_play_by_play_actions pbp
       LEFT JOIN games g ON g.id = pbp.game_id
       WHERE pbp.time_actual IS NOT NULL
       GROUP BY pbp.game_id
       ORDER BY pbp.game_id`,
      )
      .all(),
  );
  const pointStmt = db.prepare(
    `SELECT period, clock, score_home, score_away, time_actual, description
     FROM nba_play_by_play_actions
     WHERE game_id = ?
       AND time_actual IS NOT NULL
     ORDER BY time_actual ASC, action_number ASC`,
  );
  return gameRows.flatMap((row): readonly GameWindow[] => {
    if (!isRecord(row)) return [];
    const gameId = rowString(row, "gameId");
    const startIso = rowString(row, "startIso");
    const endIso = rowString(row, "endIso");
    const scheduledStart = stringField(row, "scheduledStart") || startIso;
    const startRaw = parseIsoSeconds(startIso);
    const endRaw = parseIsoSeconds(endIso);
    if (startRaw === null || endRaw === null) return [];
    const points = unknownRows(pointStmt.all(gameId)).flatMap((pointRow): readonly PbpPoint[] => {
      if (!isRecord(pointRow)) return [];
      const iso = stringOrNull(pointRow["time_actual"]);
      const timeSec = iso === null ? null : parseIsoSeconds(iso);
      if (iso === null || timeSec === null) return [];
      const period = numberOrNull(pointRow["period"]);
      const clock = stringOrNull(pointRow["clock"]);
      const secondsRemaining = parseClockSecondsRemaining(clock);
      const elapsed = gameElapsedSeconds(period, secondsRemaining);
      const home = numberOrNull(pointRow["score_home"]);
      const away = numberOrNull(pointRow["score_away"]);
      return [
        {
          timeSec,
          iso,
          period,
          clock,
          secondsRemaining,
          gameElapsedSec: elapsed,
          scoreMarginAbs: home === null || away === null ? null : Math.abs(home - away),
          description: stringField(pointRow, "description"),
        },
      ];
    });
    return [
      {
        gameId,
        scheduledStart,
        homeKey: participantKey(row["homeParticipantJson"]),
        awayKey: participantKey(row["awayParticipantJson"]),
        startIso: isoFromSeconds(startRaw - DEFAULT_PRE_BUFFER_SECONDS),
        endIso: isoFromSeconds(endRaw + DEFAULT_POST_BUFFER_SECONDS),
        startSec: startRaw - DEFAULT_PRE_BUFFER_SECONDS,
        endSec: endRaw + DEFAULT_POST_BUFFER_SECONDS,
        points,
      },
    ];
  });
}

function contextAt(window: GameWindow, timeSec: number): PbpPoint | null {
  let lo = 0;
  let hi = window.points.length - 1;
  let best: PbpPoint | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const point = window.points[mid];
    if (point === undefined) break;
    if (point.timeSec <= timeSec) {
      best = point;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function loadPairs(
  db: ReturnType<typeof openGoldDb>,
  window: GameWindow,
): readonly PairContribution[] {
  const rows = unknownRows(
    db
      .prepare(
        `SELECT sm.source AS source,
              COALESCE(sm.raw_family, '') AS family,
              qt.source_market_id AS sourceMarketId,
              qt.captured_at AS capturedAt,
              qt.implied_probability AS impliedProbability,
              COALESCE(qt.volume, 0) AS volume
       FROM quote_ticks qt
       JOIN source_markets sm ON sm.id = qt.source_market_id
       WHERE sm.game_id = ?
         AND qt.is_heartbeat = 0
         AND qt.implied_probability IS NOT NULL
         AND qt.captured_at >= ?
         AND qt.captured_at <= ?
       ORDER BY qt.source_market_id ASC, qt.captured_at ASC`,
      )
      .all(window.gameId, window.startIso, window.endIso),
  );

  const pairs: PairContribution[] = [];
  let previousMarket = "";
  let previousTs: number | null = null;
  let previousP: number | null = null;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const sourceMarketId = rowString(row, "sourceMarketId");
    const capturedAt = rowString(row, "capturedAt");
    const ts = parseIsoSeconds(capturedAt);
    const p = numberOrNull(row["impliedProbability"]);
    if (ts === null || p === null || p === 0.5) {
      previousMarket = sourceMarketId;
      previousTs = ts;
      previousP = p;
      continue;
    }
    if (previousMarket === sourceMarketId && previousTs !== null && previousP !== null) {
      const gap = ts - previousTs;
      const deltaP = Math.abs(p - previousP);
      if (gap > 0 && gap <= STALE_PAIR_GAP_SECONDS && deltaP > 0) {
        pairs.push({
          timeSec: ts,
          sourceMarketId,
          source: rowString(row, "source"),
          family: rowString(row, "family") || "unknown",
          deltaP,
          deltaLogit: Math.abs(logit(p) - logit(previousP)),
          volume: Math.max(0, numberOrNull(row["volume"]) ?? 0),
        });
      }
    }
    previousMarket = sourceMarketId;
    previousTs = ts;
    previousP = p;
  }
  return pairs;
}

function loadMicro(db: ReturnType<typeof openGoldDb>, window: GameWindow): readonly MicroEvent[] {
  const rows = unknownRows(
    db
      .prepare(
        `SELECT source,
              source_market_id AS sourceMarketId,
              COALESCE(instrument_id, source_market_id) AS instrumentId,
              event_timestamp AS eventTimestamp,
              trade_price AS tradePrice,
              previous_price AS previousPrice,
              volume_share AS volumeShare,
              spread,
              depth_score AS depthScore,
              COALESCE(notional, volume, 0) AS sizeProxy
       FROM market_microstructure_events
       WHERE game_id = ?
         AND event_timestamp >= ?
         AND event_timestamp <= ?
         AND trade_price IS NOT NULL
         AND previous_price IS NOT NULL`,
      )
      .all(window.gameId, window.startIso, window.endIso),
  );
  return rows.flatMap((row): readonly MicroEvent[] => {
    if (!isRecord(row)) return [];
    const eventTimestamp = rowString(row, "eventTimestamp");
    const timeSec = parseIsoSeconds(eventTimestamp);
    const tradePrice = numberOrNull(row["tradePrice"]);
    const previousPrice = numberOrNull(row["previousPrice"]);
    if (timeSec === null || tradePrice === null || previousPrice === null) return [];
    const distance = Math.abs(tradePrice - previousPrice);
    if (distance <= 0) return [];
    const volumeShare = Math.max(0, numberOrNull(row["volumeShare"]) ?? 0);
    const spread = Math.max(0, numberOrNull(row["spread"]) ?? 0);
    const depthScore = numberOrNull(row["depthScore"]);
    const depthPenalty = depthScore === null ? 1 : 1 + Math.max(0, 1 - depthScore / 100);
    const sizeProxy = Math.max(0, numberOrNull(row["sizeProxy"]) ?? 0);
    const severity =
      distance * (1 + volumeShare * 8) * (1 + spread) * depthPenalty * Math.log1p(sizeProxy);
    return [
      {
        timeSec,
        source: rowString(row, "source"),
        sourceMarketId: rowString(row, "sourceMarketId"),
        instrumentId: rowString(row, "instrumentId"),
        severity,
      },
    ];
  });
}

function buildGameData(db: ReturnType<typeof openGoldDb>, window: GameWindow): GameData {
  return {
    gameId: window.gameId,
    window,
    pairs: loadPairs(db, window),
    micro: loadMicro(db, window),
    bucketCache: new Map<number, readonly Bucket[]>(),
  };
}

function bucketize(game: GameData, bucketSeconds: number): readonly Bucket[] {
  const cached = game.bucketCache.get(bucketSeconds);
  if (cached !== undefined) return cached;

  const buckets = new Map<number, MutableBucket>();
  const getBucket = (timeSec: number): MutableBucket => {
    const startSec = Math.floor(timeSec / bucketSeconds) * bucketSeconds;
    const existing = buckets.get(startSec);
    if (existing !== undefined) return existing;
    const context = contextAt(game.window, startSec + bucketSeconds);
    const created: MutableBucket = {
      startSec,
      endSec: startSec + bucketSeconds,
      gameElapsedSec: context?.gameElapsedSec ?? null,
      period: context?.period ?? null,
      secondsRemaining: context?.secondsRemaining ?? null,
      scoreMarginAbs: context?.scoreMarginAbs ?? null,
      eqIntensity: 0,
      vwIntensity: 0,
      logitVwIntensity: 0,
      volumeHeavyIntensity: 0,
      activeMarkets: new Set<string>(),
      sourceContribution: new Map<string, number>(),
      sources: new Set<string>(),
      families: new Set<string>(),
      offpriceSeverity: 0,
      offpriceMarkets: new Set<string>(),
      offpriceSources: new Set<string>(),
    };
    buckets.set(startSec, created);
    return created;
  };

  for (const pair of game.pairs) {
    const bucket = getBucket(pair.timeSec);
    const volumeWeight = Math.log1p(pair.volume);
    const weightedDelta = pair.deltaP * volumeWeight;
    bucket.eqIntensity += pair.deltaP;
    bucket.vwIntensity += weightedDelta;
    bucket.logitVwIntensity += pair.deltaLogit * volumeWeight;
    bucket.volumeHeavyIntensity += pair.deltaLogit * volumeWeight ** 1.5;
    bucket.activeMarkets.add(pair.sourceMarketId);
    bucket.sources.add(pair.source);
    bucket.families.add(pair.family);
    bucket.sourceContribution.set(
      pair.source,
      (bucket.sourceContribution.get(pair.source) ?? 0) + weightedDelta,
    );
  }

  for (const event of game.micro) {
    const bucket = getBucket(event.timeSec);
    bucket.offpriceSeverity += event.severity;
    bucket.offpriceMarkets.add(event.sourceMarketId);
    bucket.offpriceSources.add(event.source);
  }

  const result = [...buckets.values()]
    .sort((a, b) => a.startSec - b.startSec)
    .map((bucket): Bucket => {
      const topSourceContribution = Math.max(0, ...bucket.sourceContribution.values());
      const sourceDominance =
        bucket.vwIntensity <= 0 || bucket.sourceContribution.size === 0
          ? null
          : topSourceContribution / bucket.vwIntensity;
      return {
        startSec: bucket.startSec,
        endSec: bucket.endSec,
        gameElapsedSec: bucket.gameElapsedSec,
        period: bucket.period,
        secondsRemaining: bucket.secondsRemaining,
        scoreMarginAbs: bucket.scoreMarginAbs,
        eqIntensity: bucket.eqIntensity,
        vwIntensity: bucket.vwIntensity,
        logitVwIntensity: bucket.logitVwIntensity,
        volumeHeavyIntensity: bucket.volumeHeavyIntensity,
        activeMarketCount: bucket.activeMarkets.size,
        sourceCount: bucket.sources.size,
        sourceDominance,
        familyCount: bucket.families.size,
        offpriceSeverity: bucket.offpriceSeverity,
        offpriceFanout: bucket.offpriceMarkets.size,
        offpriceSourceCount: bucket.offpriceSources.size,
      };
    });
  game.bucketCache.set(bucketSeconds, result);
  return result;
}

interface MutableBucket {
  startSec: number;
  endSec: number;
  gameElapsedSec: number | null;
  period: number | null;
  secondsRemaining: number | null;
  scoreMarginAbs: number | null;
  eqIntensity: number;
  vwIntensity: number;
  logitVwIntensity: number;
  volumeHeavyIntensity: number;
  activeMarkets: Set<string>;
  sourceContribution: Map<string, number>;
  sources: Set<string>;
  families: Set<string>;
  offpriceSeverity: number;
  offpriceMarkets: Set<string>;
  offpriceSources: Set<string>;
}

function bucketScore(bucket: Bucket, algo: AlgoSpec): number {
  if (algo.scoreKind === "board-eq") return bucket.eqIntensity;
  if (algo.scoreKind === "board-vw") return bucket.vwIntensity;
  if (algo.scoreKind === "coverage-normalized-vw") {
    const marketBreadth = Math.max(COVERAGE_NORMALIZATION_MARKET_FLOOR, bucket.activeMarketCount);
    return bucket.vwIntensity / Math.sqrt(marketBreadth);
  }
  if (algo.scoreKind === "logit-vw") return bucket.logitVwIntensity;
  if (algo.scoreKind === "volume-heavy") return bucket.volumeHeavyIntensity;
  if (algo.scoreKind === "offprice") return bucket.offpriceSeverity;
  return bucket.vwIntensity + bucket.offpriceSeverity * 0.25;
}

function passesFanout(bucket: Bucket, algo: AlgoSpec): boolean {
  if (algo.requiredMarkets !== undefined && bucket.activeMarketCount < algo.requiredMarkets)
    return false;
  if (algo.requiredFamilies !== undefined && bucket.familyCount < algo.requiredFamilies)
    return false;
  if (algo.requiredSources !== undefined && bucket.sourceCount < algo.requiredSources) return false;
  if (
    algo.requiredOffpriceFanout !== undefined &&
    bucket.offpriceFanout < algo.requiredOffpriceFanout
  ) {
    return false;
  }
  return true;
}

function thresholdMultiplier(bucket: Bucket, algo: AlgoSpec): number {
  let multiplier = 1;
  const finalFiveClose =
    bucket.period !== null &&
    bucket.period >= 4 &&
    bucket.secondsRemaining !== null &&
    bucket.secondsRemaining <= CLUTCH_SECONDS_REMAINING &&
    bucket.scoreMarginAbs !== null &&
    bucket.scoreMarginAbs <= CLOSE_GAME_MARGIN;
  const finalFoulMode =
    bucket.period !== null &&
    bucket.period >= 4 &&
    bucket.secondsRemaining !== null &&
    bucket.secondsRemaining <= FOUL_MODE_SECONDS_REMAINING &&
    bucket.scoreMarginAbs !== null &&
    bucket.scoreMarginAbs <= FOUL_MODE_MARGIN;
  if (finalFiveClose && algo.finalFiveCloseMultiplier !== undefined) {
    multiplier *= algo.finalFiveCloseMultiplier;
  }
  if (finalFoulMode && algo.finalFoulModeMultiplier !== undefined) {
    multiplier *= algo.finalFoulModeMultiplier;
  }
  return multiplier;
}

function isSuppressedByCooldown(index: number, lastFireIndex: number, algo: AlgoSpec): boolean {
  const cooldownBuckets = Math.max(
    NO_FIRE_COOLDOWN_BUCKETS,
    Math.round(algo.cooldownBuckets ?? NO_FIRE_COOLDOWN_BUCKETS),
  );
  return cooldownBuckets > NO_FIRE_COOLDOWN_BUCKETS && index - lastFireIndex <= cooldownBuckets;
}

function elapsedSecondsForBucket(buckets: readonly Bucket[], index: number): number {
  const current = buckets[index];
  if (current === undefined) return 0;
  if (current.gameElapsedSec !== null) return Math.max(0, current.gameElapsedSec);
  const first = buckets[0];
  if (first === undefined) return 0;
  return Math.max(0, current.startSec - first.startSec);
}

function isPastOpeningHoldoff(buckets: readonly Bucket[], index: number, algo: AlgoSpec): boolean {
  return elapsedSecondsForBucket(buckets, index) >= algo.warmupBuckets * algo.bucketSeconds;
}

function priorScores(
  buckets: readonly Bucket[],
  index: number,
  algo: AlgoSpec,
  scoreByIndex: readonly number[],
): readonly number[] {
  const current = buckets[index];
  if (current === undefined) return [];
  if (algo.baselineKind === "mad-game" || algo.baselineKind === "mad-blend") {
    const gameMemorySeconds = algo.gameMemorySeconds;
    if (current.gameElapsedSec !== null && gameMemorySeconds !== undefined) {
      const currentGameElapsedSec = current.gameElapsedSec;
      return buckets
        .slice(0, index)
        .flatMap((bucket, bucketIndex) =>
          bucket.gameElapsedSec !== null &&
          bucket.gameElapsedSec < currentGameElapsedSec &&
          bucket.gameElapsedSec >= currentGameElapsedSec - gameMemorySeconds
            ? [scoreByIndex[bucketIndex] ?? 0]
            : [],
        );
    }
  }
  const wallMemorySeconds = algo.wallMemorySeconds;
  if (wallMemorySeconds !== undefined) {
    return buckets
      .slice(0, index)
      .flatMap((bucket, bucketIndex) =>
        bucket.startSec >= current.startSec - wallMemorySeconds
          ? [scoreByIndex[bucketIndex] ?? 0]
          : [],
      );
  }
  const trailing = algo.trailingBuckets ?? 20;
  return scoreByIndex.slice(Math.max(0, index - trailing), index);
}

function robustThreshold(scores: readonly number[], k: number): number | null {
  const stats = robustStats(scores);
  return stats === null ? null : thresholdFromStats(stats, k);
}

function robustStats(scores: readonly number[]): HistoricalPrior | null {
  if (scores.length === 0) return null;
  return { median: median(scores), mad: mad(scores), sampleSize: scores.length };
}

function thresholdFromStats(stats: HistoricalPrior, k: number): number {
  const scale = Math.max(MAD_SCALE * stats.mad, SCALE_FLOOR);
  return stats.median + k * scale;
}

function blendedStats(
  buckets: readonly Bucket[],
  index: number,
  algo: AlgoSpec,
  scoreByIndex: readonly number[],
): HistoricalPrior | null {
  const current = buckets[index];
  if (current === undefined) return null;
  const gameScores = priorScores(buckets, index, algo, scoreByIndex);
  const recentWallSeconds = algo.recentWallSeconds;
  const recentScores =
    recentWallSeconds === undefined
      ? []
      : buckets
          .slice(0, index)
          .flatMap((bucket, bucketIndex) =>
            bucket.startSec >= current.startSec - recentWallSeconds
              ? [scoreByIndex[bucketIndex] ?? 0]
              : [],
          );
  if (gameScores.length < algo.minPrior && recentScores.length < algo.minPrior) return null;
  if (gameScores.length === 0) return robustStats(recentScores);
  if (recentScores.length === 0) return robustStats(gameScores);
  const recentWeight = algo.recentWallWeight ?? 1;
  const gameCenter = median(gameScores);
  const recentCenter = recentScores.length > 0 ? median(recentScores) : gameCenter;
  const gameScale = Math.max(MAD_SCALE * mad(gameScores), SCALE_FLOOR);
  const recentScale =
    recentScores.length > 0 ? Math.max(MAD_SCALE * mad(recentScores), SCALE_FLOOR) : gameScale;
  const center = (gameCenter + recentCenter * recentWeight) / (1 + recentWeight);
  const scale = (gameScale + recentScale * recentWeight) / (1 + recentWeight);
  return {
    median: center,
    mad: scale / MAD_SCALE,
    sampleSize: gameScores.length + recentScores.length,
  };
}

function blendedThreshold(
  buckets: readonly Bucket[],
  index: number,
  algo: AlgoSpec,
  scoreByIndex: readonly number[],
): number | null {
  const stats = blendedStats(buckets, index, algo, scoreByIndex);
  return stats === null ? null : thresholdFromStats(stats, algo.k);
}

function combineHistoricalPriors(
  away: HistoricalPrior | null,
  home: HistoricalPrior | null,
  awayWeightRaw: number,
): HistoricalPrior | null {
  if (away === null && home === null) return null;
  if (away === null) return home;
  if (home === null) return away;
  const awayWeight = Math.min(1, Math.max(0, awayWeightRaw));
  const homeWeight = 1 - awayWeight;
  return {
    median: away.median * awayWeight + home.median * homeWeight,
    mad: away.mad * awayWeight + home.mad * homeWeight,
    sampleSize: away.sampleSize + home.sampleSize,
  };
}

function sideHistoricalPrior(
  target: GameData,
  allGames: ReadonlyMap<string, GameData>,
  algo: AlgoSpec,
  side: "away" | "home",
): HistoricalPrior | null {
  const targetKey = side === "away" ? target.window.awayKey : target.window.homeKey;
  if (targetKey === null) return null;
  const lastGames = Math.max(1, Math.round(algo.historicalLastGames ?? 5));
  const openingBuckets = Math.max(1, Math.round(algo.openingBaselineBuckets ?? algo.minPrior));
  const values = [...allGames.values()]
    .filter((candidate) => {
      if (candidate.gameId === target.gameId) return false;
      if (candidate.window.scheduledStart >= target.window.scheduledStart) return false;
      const candidateKey = side === "away" ? candidate.window.awayKey : candidate.window.homeKey;
      return candidateKey === targetKey;
    })
    .toSorted((a, b) => (a.window.scheduledStart > b.window.scheduledStart ? -1 : 1))
    .slice(0, lastGames)
    .flatMap((candidate) =>
      bucketize(candidate, algo.bucketSeconds)
        .slice(0, openingBuckets)
        .map((bucket) => bucketScore(bucket, algo)),
    );
  return robustStats(values);
}

function historicalPriorForGame(
  game: GameData,
  allGames: ReadonlyMap<string, GameData>,
  algo: AlgoSpec,
): HistoricalPrior | null {
  const away = sideHistoricalPrior(game, allGames, algo, "away");
  const home = sideHistoricalPrior(game, allGames, algo, "home");
  return combineHistoricalPriors(away, home, algo.historicalAwayWeight ?? 0.5);
}

function historicalShareForBucket(game: GameData, bucket: Bucket, algo: AlgoSpec): number {
  const priorWeight = Math.min(1, Math.max(0, algo.historicalPriorWeight ?? 1));
  const rampSeconds = Math.max(
    1,
    algo.historicalRampCompleteGameSeconds ?? 12 * SECONDS_PER_MINUTE,
  );
  const elapsedSeconds = bucket.gameElapsedSec ?? Math.max(0, bucket.endSec - game.window.startSec);
  return priorWeight * Math.min(1, Math.max(0, 1 - elapsedSeconds / rampSeconds));
}

function historicalThreshold(
  game: GameData,
  buckets: readonly Bucket[],
  index: number,
  algo: AlgoSpec,
  scoreByIndex: readonly number[],
  historicalPrior: HistoricalPrior | null,
): number | null {
  const current = buckets[index];
  if (current === undefined) return null;
  const liveStats = blendedStats(buckets, index, algo, scoreByIndex);
  if (historicalPrior === null || historicalPrior.sampleSize === 0) {
    return liveStats === null ? null : thresholdFromStats(liveStats, algo.k);
  }
  const historicalShare = historicalShareForBucket(game, current, algo);
  if (historicalShare <= 0) {
    return liveStats === null ? null : thresholdFromStats(liveStats, algo.k);
  }
  if (liveStats === null) return thresholdFromStats(historicalPrior, algo.k);
  const liveWeight = 1 - historicalShare;
  return thresholdFromStats(
    {
      median: liveStats.median * liveWeight + historicalPrior.median * historicalShare,
      mad: liveStats.mad * liveWeight + historicalPrior.mad * historicalShare,
      sampleSize: liveStats.sampleSize + historicalPrior.sampleSize,
    },
    algo.k,
  );
}

function runtimeBaselineModeForAlgo(algo: AlgoSpec): RuntimeBaselineMode {
  if (algo.runtimeBaselineMode !== undefined) return algo.runtimeBaselineMode;
  if (algo.baselineKind === "mad-historical") return "historical-blend";
  return algo.openingBaselineBuckets !== undefined ? "opening-ramp" : "trailing";
}

function trailingGameMinutesForAlgo(algo: AlgoSpec): number {
  if (algo.gameMemorySeconds !== undefined) {
    return Math.max(
      algo.bucketSeconds / SECONDS_PER_MINUTE,
      algo.gameMemorySeconds / SECONDS_PER_MINUTE,
    );
  }
  return Math.max(
    algo.bucketSeconds / SECONDS_PER_MINUTE,
    (algo.trailingBuckets ?? algo.minPrior) * (algo.bucketSeconds / SECONDS_PER_MINUTE),
  );
}

export function buildStateSpaceRequestForGame(
  game: GameData,
  algo: StateSpaceAlgoSpec,
  allGames: ReadonlyMap<string, GameData>,
): BakeoffStateSpaceRequest {
  const stateSpace = algo.stateSpace;
  const buckets = bucketize(game, algo.bucketSeconds);
  const observations = buckets
    .map((bucket) => ({
      bucket,
      intensity: bucketScore(bucket, algo),
    }))
    .filter((entry) => entry.intensity > LOW_SIGNAL_FLOOR)
    .map(
      ({ bucket, intensity }): BakeoffStateSpaceObservation => ({
        bucketStart: isoFromSeconds(bucket.startSec),
        bucketEnd: isoFromSeconds(bucket.endSec),
        intensity,
        gameElapsedSeconds: bucket.gameElapsedSec,
        activeMarketCount: bucket.activeMarketCount,
        sourceCount: bucket.sourceCount,
        ...(bucket.sourceDominance === null ? {} : { sourceDominance: bucket.sourceDominance }),
      }),
    );
  const baselineMode = runtimeBaselineModeForAlgo(algo);
  const historicalPrior =
    baselineMode === "historical-blend" ? historicalPriorForGame(game, allGames, algo) : null;
  const openingBaselineBuckets = algo.openingBaselineBuckets ?? algo.minPrior;
  const openingRampCompleteBuckets = Number(
    algo.openingRampCompleteBuckets ?? algo.trailingBuckets ?? algo.minPrior,
  );
  const recentWallMinutes =
    algo.recentWallSeconds === undefined ? undefined : algo.recentWallSeconds / SECONDS_PER_MINUTE;
  return {
    gameId: game.gameId,
    observations,
    params: {
      baselineMode,
      bucketSeconds: algo.bucketSeconds,
      kMad: algo.k,
      trailingBuckets: algo.trailingBuckets ?? Math.max(algo.minPrior, 1),
      trailingGameMinutes: trailingGameMinutesForAlgo(algo),
      warmupBuckets: algo.warmupBuckets,
      openingBaselineBuckets,
      openingRampCompleteBuckets,
      ...(historicalPrior === null
        ? {}
        : {
            historicalPrior: {
              mad: historicalPrior.mad,
              median: historicalPrior.median,
              sampleSize: historicalPrior.sampleSize,
            } satisfies BakeoffStateSpaceHistoricalPrior,
          }),
      ...(algo.historicalPriorWeight === undefined
        ? {}
        : { historicalPriorWeight: algo.historicalPriorWeight }),
      ...(algo.historicalRampCompleteGameSeconds === undefined
        ? {}
        : {
            historicalRampCompleteGameMinutes:
              algo.historicalRampCompleteGameSeconds / SECONDS_PER_MINUTE,
          }),
      ...(recentWallMinutes === undefined ? {} : { recentWallMinutes }),
      ...(algo.recentWallWeight === undefined ? {} : { recentWallWeight: algo.recentWallWeight }),
      stateSpace,
    },
  };
}

interface StateSpaceClientOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function resolveStateSpaceBaseUrl(explicitBaseUrl?: string): string {
  const baseUrl = explicitBaseUrl ?? process.env["NBA_SIDECAR_BASE_URL"];
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new Error("NBA_SIDECAR_BASE_URL is not configured for the bakeoff runtime rows.");
  }
  return trimTrailingSlash(baseUrl);
}

function parseBakeoffStateSpaceResponse(
  json: unknown,
): readonly BakeoffStateSpaceResponseObservation[] {
  if (!isRecord(json)) throw new Error("state-space sidecar response is not an object");
  const data = json["data"];
  if (!isRecord(data)) throw new Error("state-space sidecar response missing data object");
  const observations = data["observations"];
  if (!Array.isArray(observations)) {
    throw new Error("state-space sidecar response missing observations array");
  }
  return observations.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("state-space sidecar observation is not an object");
    }
    const bucketStart = entry["bucketStart"];
    const bucketEnd = entry["bucketEnd"];
    const threshold = entry["threshold"];
    const fired = entry["fired"];
    if (
      typeof bucketStart !== "string" ||
      typeof bucketEnd !== "string" ||
      typeof threshold !== "number" ||
      typeof fired !== "boolean"
    ) {
      throw new Error("state-space sidecar observation is missing required fields");
    }
    return {
      bucketStart,
      bucketEnd,
      threshold,
      fired,
    };
  });
}

async function postStateSpaceRequest(
  request: BakeoffStateSpaceRequest,
  clientOptions?: StateSpaceClientOptions,
): Promise<readonly BakeoffStateSpaceResponseObservation[]> {
  const fetchImpl = clientOptions?.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${resolveStateSpaceBaseUrl(clientOptions?.baseUrl)}/api/v1/models/board-volatility/state-space`,
    {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  if (!response.ok) {
    throw new Error(
      `Board volatility sidecar request failed with status ${String(response.status)}.`,
    );
  }
  return parseBakeoffStateSpaceResponse(await response.json());
}

export async function detectWithPythonStateSpace(
  game: GameData,
  algo: StateSpaceAlgoSpec,
  allGames: ReadonlyMap<string, GameData>,
  clientOptions?: StateSpaceClientOptions,
): Promise<readonly Fire[]> {
  const request = buildStateSpaceRequestForGame(game, algo, allGames);
  const response = await postStateSpaceRequest(request, clientOptions);
  const buckets = bucketize(game, algo.bucketSeconds);
  // The sidecar parses bucketStart into a datetime and re-serializes it without
  // the zero millisecond fraction (e.g. "...:00Z"), while isoFromSeconds always
  // emits "...:00.000Z". Canonicalize both key-spaces to epoch milliseconds so
  // the join survives the ISO-8601 fractional-second difference.
  const bucketStartKey = (iso: string): number => new Date(iso).getTime();
  const bucketByStart = new Map(
    buckets.map((bucket) => [bucketStartKey(isoFromSeconds(bucket.startSec)), bucket] as const),
  );
  const scoreByBucketStart = new Map(
    request.observations.map(
      (observation) => [bucketStartKey(observation.bucketStart), observation.intensity] as const,
    ),
  );
  const fires: Fire[] = [];
  for (const observation of response) {
    if (!observation.fired) continue;
    const key = bucketStartKey(observation.bucketStart);
    const bucket = bucketByStart.get(key);
    if (bucket === undefined) continue;
    const score = scoreByBucketStart.get(key) ?? 0;
    if (score <= LOW_SIGNAL_FLOOR || !passesFanout(bucket, algo)) continue;
    fires.push(
      fireFromBucket(game.gameId, bucket, score, observation.threshold, algo.bucketSeconds),
    );
  }
  return fires;
}

function isFinalFiveClose(fire: Fire): boolean {
  return (
    fire.period !== null &&
    fire.period >= 4 &&
    fire.secondsRemaining !== null &&
    fire.secondsRemaining <= CLUTCH_SECONDS_REMAINING &&
    fire.scoreMarginAbs !== null &&
    fire.scoreMarginAbs <= CLOSE_GAME_MARGIN
  );
}

function detectWithRobustBaseline(
  game: GameData,
  algo: AlgoSpec,
  allGames: ReadonlyMap<string, GameData>,
): readonly Fire[] {
  const buckets = bucketize(game, algo.bucketSeconds);
  const scores = buckets.map((bucket) => bucketScore(bucket, algo));
  const historicalPrior =
    algo.baselineKind === "mad-historical" ? historicalPriorForGame(game, allGames, algo) : null;
  const fires: Fire[] = [];
  let lastFireIndex = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index];
    const score = scores[index] ?? 0;
    if (
      bucket === undefined ||
      !isPastOpeningHoldoff(buckets, index, algo) ||
      score <= LOW_SIGNAL_FLOOR
    )
      continue;
    const threshold =
      algo.baselineKind === "mad-historical"
        ? historicalThreshold(game, buckets, index, algo, scores, historicalPrior)
        : algo.baselineKind === "mad-blend"
          ? blendedThreshold(buckets, index, algo, scores)
          : robustThreshold(priorScores(buckets, index, algo, scores), algo.k);
    if (threshold === null) continue;
    const adjustedThreshold = threshold * thresholdMultiplier(bucket, algo);
    if (
      score > adjustedThreshold &&
      passesFanout(bucket, algo) &&
      !isSuppressedByCooldown(index, lastFireIndex, algo)
    ) {
      fires.push(fireFromBucket(game.gameId, bucket, score, adjustedThreshold, algo.bucketSeconds));
      lastFireIndex = index;
    }
  }
  return fires;
}

function detectWithEwma(game: GameData, algo: AlgoSpec): readonly Fire[] {
  const buckets = bucketize(game, algo.bucketSeconds);
  const fires: Fire[] = [];
  let meanValue = 0;
  let variance = SCALE_FLOOR;
  let previousEnd: number | null = null;
  let lastFireIndex = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index];
    if (bucket === undefined) continue;
    const score = bucketScore(bucket, algo);
    const gap =
      previousEnd === null
        ? algo.bucketSeconds
        : Math.max(algo.bucketSeconds, bucket.endSec - previousEnd);
    const alpha = Math.exp(-gap / EWMA_TAU_SECONDS);
    const threshold = meanValue + algo.k * Math.sqrt(Math.max(variance, SCALE_FLOOR));
    if (
      isPastOpeningHoldoff(buckets, index, algo) &&
      score > threshold * thresholdMultiplier(bucket, algo) &&
      score > LOW_SIGNAL_FLOOR &&
      passesFanout(bucket, algo) &&
      !isSuppressedByCooldown(index, lastFireIndex, algo)
    ) {
      fires.push(fireFromBucket(game.gameId, bucket, score, threshold, algo.bucketSeconds));
      lastFireIndex = index;
    }
    const diff = score - meanValue;
    meanValue = alpha * meanValue + (1 - alpha) * score;
    variance = alpha * variance + (1 - alpha) * diff * diff;
    previousEnd = bucket.endSec;
  }
  return fires;
}

function detectWithCusum(game: GameData, algo: AlgoSpec): readonly Fire[] {
  const buckets = bucketize(game, algo.bucketSeconds);
  const scores = buckets.map((bucket) => bucketScore(bucket, algo));
  const fires: Fire[] = [];
  let cumulative = 0;
  let lastFireIndex = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index];
    const score = scores[index] ?? 0;
    if (bucket === undefined) continue;
    const prior = priorScores(buckets, index, algo, scores);
    if (!isPastOpeningHoldoff(buckets, index, algo) || prior.length < algo.minPrior) continue;
    const center = median(prior);
    const scale = Math.max(MAD_SCALE * mad(prior), SCALE_FLOOR);
    const z = Math.max(0, (score - center) / scale);
    cumulative = Math.max(0, cumulative + z - CUSUM_DRIFT);
    if (
      cumulative > algo.k &&
      score > LOW_SIGNAL_FLOOR &&
      passesFanout(bucket, algo) &&
      !isSuppressedByCooldown(index, lastFireIndex, algo)
    ) {
      fires.push(fireFromBucket(game.gameId, bucket, score, algo.k, algo.bucketSeconds));
      lastFireIndex = index;
      cumulative = 0;
    }
  }
  return fires;
}

function detectWithRvBv(game: GameData, algo: AlgoSpec): readonly Fire[] {
  const buckets = bucketize(game, algo.bucketSeconds);
  const scores = buckets.map((bucket) => bucketScore(bucket, algo));
  const fires: Fire[] = [];
  let lastFireIndex = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index];
    const score = scores[index] ?? 0;
    if (
      bucket === undefined ||
      !isPastOpeningHoldoff(buckets, index, algo) ||
      score <= LOW_SIGNAL_FLOOR
    )
      continue;
    const prior = priorScores(buckets, index, algo, scores);
    if (prior.length < algo.minPrior) continue;
    const threshold = robustThreshold(prior, algo.k);
    if (threshold === null) continue;
    const previous = scores[index - 1] ?? 0;
    const bipower = Math.max(Math.abs(previous) * Math.abs(score), SCALE_FLOOR);
    const jumpRatio = (score * score) / bipower;
    if (
      score > threshold &&
      jumpRatio > RV_JUMP_RATIO &&
      passesFanout(bucket, algo) &&
      !isSuppressedByCooldown(index, lastFireIndex, algo)
    ) {
      fires.push(fireFromBucket(game.gameId, bucket, score, threshold, algo.bucketSeconds));
      lastFireIndex = index;
    }
  }
  return fires;
}

function fireFromBucket(
  gameId: string,
  bucket: Bucket,
  score: number,
  threshold: number,
  bucketSeconds: number,
): Fire {
  return {
    gameId,
    bucketStartIso: isoFromSeconds(bucket.startSec),
    observedAtIso: isoFromSeconds(bucket.startSec + bucketSeconds),
    observedAtSec: bucket.startSec + bucketSeconds,
    score: rounded(score, 6) ?? score,
    threshold: rounded(threshold, 6) ?? threshold,
    period: bucket.period,
    secondsRemaining: bucket.secondsRemaining,
    scoreMarginAbs: bucket.scoreMarginAbs,
    activeMarketCount: bucket.activeMarketCount,
    sourceCount: bucket.sourceCount,
    familyCount: bucket.familyCount,
    offpriceFanout: bucket.offpriceFanout,
  };
}

async function detectGame(
  game: GameData,
  algo: AlgoSpec,
  allGames: ReadonlyMap<string, GameData>,
): Promise<readonly Fire[]> {
  if (isStateSpaceAlgo(algo)) {
    return await detectWithPythonStateSpace(game, algo, allGames);
  }
  if (algo.baselineKind === "ewma") return detectWithEwma(game, algo);
  if (algo.baselineKind === "cusum") return detectWithCusum(game, algo);
  if (algo.baselineKind === "rv-bv") return detectWithRvBv(game, algo);
  return detectWithRobustBaseline(game, algo, allGames);
}

function incidentGameIds(incident: RawIncident): readonly string[] {
  const local = incident.localBoardGameIds.map(normalizeGameId).filter((value) => value !== "");
  if (local.length > 0) return local;
  const normalized = normalizeGameId(incident.gameId);
  return normalized === "" ? [] : [normalized];
}

function hasCoverageForAlgo(game: GameData, algo: AlgoSpec): boolean {
  if (algo.scoreKind === "offprice") return game.micro.length > 0;
  if (algo.scoreKind === "hybrid") return game.pairs.length > 0 || game.micro.length > 0;
  return game.pairs.length > 0;
}

function findIncidentFire(
  incident: RawIncident,
  algorithms: readonly AlgoSpec[],
  firesByAlgoGame: ReadonlyMap<string, readonly Fire[]>,
  games: ReadonlyMap<string, GameData>,
): IncidentAlgoResult[] {
  const eventSec = parseIsoSeconds(incident.utcTime);
  return algorithms.map((algo): IncidentAlgoResult => {
    if (eventSec === null) {
      return skippedResult(incident.id, algo.id, "No exact UTC/PBP anchor.");
    }
    const gameIds = incidentGameIds(incident);
    if (gameIds.length === 0) {
      return skippedResult(incident.id, algo.id, "No local or normalized game id.");
    }
    const localGames = gameIds.flatMap((gameId): readonly GameData[] => {
      const game = games.get(gameId);
      return game === undefined ? [] : [game];
    });
    if (localGames.length === 0) {
      return skippedResult(incident.id, algo.id, "No local PBP window for this game id.");
    }
    const coveredGames = localGames.filter((game) => hasCoverageForAlgo(game, algo));
    if (coveredGames.length === 0) {
      return skippedResult(
        incident.id,
        algo.id,
        "No local quote or microstructure coverage for this algorithm.",
      );
    }
    const candidates = coveredGames.flatMap((game): readonly Fire[] => {
      const gameId = game.gameId;
      const fires = firesByAlgoGame.get(`${algo.id}:${gameId}`);
      return fires === undefined ? [] : fires;
    });
    if (candidates.length === 0) {
      return missedResult(incident.id, algo.id);
    }
    const inWindow = candidates
      .map((fire) => ({ fire, lead: fire.observedAtSec - eventSec }))
      .filter(
        ({ lead }) => lead >= CATCH_WINDOW_BEFORE_SECONDS && lead <= CATCH_WINDOW_AFTER_SECONDS,
      )
      .sort((a, b) => a.lead - b.lead);
    const first = inWindow[0];
    return {
      incidentId: incident.id,
      algoId: algo.id,
      scoreable: true,
      caught: first !== undefined,
      leadSeconds: first === undefined ? null : rounded(first.lead, 1),
      fireIso: first?.fire.observedAtIso ?? null,
      skipReason: null,
    };
  });
}

function missedResult(incidentId: string, algoId: string): IncidentAlgoResult {
  return {
    incidentId,
    algoId,
    scoreable: true,
    caught: false,
    leadSeconds: null,
    fireIso: null,
    skipReason: null,
  };
}

function skippedResult(incidentId: string, algoId: string, reason: string): IncidentAlgoResult {
  return {
    incidentId,
    algoId,
    scoreable: false,
    caught: false,
    leadSeconds: null,
    fireIso: null,
    skipReason: reason,
  };
}

function matchupLabel(window: GameWindow): string {
  const away = window.awayKey ?? "away";
  const home = window.homeKey ?? "home";
  return `${away.toUpperCase()} @ ${home.toUpperCase()}`;
}

function uniqueCount(values: readonly string[]): number {
  return new Set(values.filter((value) => value !== "")).size;
}

function isFireOutlier(fires: number, medianFires: number, p95Fires: number): boolean {
  const percentileGate = Math.max(OUTLIER_MIN_FIRE_COUNT, Math.ceil(p95Fires));
  const medianGate = Math.ceil(Math.max(1, medianFires) * OUTLIER_MEDIAN_MULTIPLIER);
  return fires >= percentileGate && fires >= medianGate;
}

function countAlertEpisodes(fires: readonly Fire[]): number {
  if (fires.length === 0) return 0;
  const sorted = fires.toSorted((a, b) => a.observedAtSec - b.observedAtSec);
  let episodes = 0;
  let previousSec = Number.NEGATIVE_INFINITY;
  for (const fire of sorted) {
    if (fire.observedAtSec - previousSec > ALERT_EPISODE_MERGE_SECONDS) {
      episodes += 1;
    }
    previousSec = fire.observedAtSec;
  }
  return episodes;
}

function coverageNormalizedIntensity(bucket: Bucket): number {
  const marketBreadth = Math.max(COVERAGE_NORMALIZATION_MARKET_FLOOR, bucket.activeMarketCount);
  return bucket.vwIntensity / Math.sqrt(marketBreadth);
}

function positiveRobustZ(value: number, stats: HistoricalPrior | null): number {
  if (stats === null) return 0;
  const scale = Math.max(MAD_SCALE * stats.mad, SCALE_FLOOR);
  return Math.max(0, (value - stats.median) / scale);
}

interface MarketOutlierBucketCandidate {
  readonly bucket: Bucket;
  readonly severity: number;
  readonly priceMoveZ: number;
  readonly breadthZ: number;
  readonly offpriceZ: number;
}

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

function episodeWindowBounds(episode: MarketOutlierEpisode): { startSec: number; endSec: number } {
  return {
    startSec: episode.startSec - MARKET_OUTLIER_EPISODE_BUFFER_SECONDS,
    endSec: episode.endSec + MARKET_OUTLIER_EPISODE_BUFFER_SECONDS,
  };
}

export function buildMarketOutlierResults(
  algorithms: readonly AlgoSpec[],
  episodes: readonly MarketOutlierEpisode[],
  firesByAlgoGame: ReadonlyMap<string, readonly Fire[]>,
): readonly MarketOutlierAlgoResult[] {
  return algorithms.flatMap((algo) =>
    episodes.map((episode): MarketOutlierAlgoResult => {
      const fires = firesByAlgoGame.get(`${algo.id}:${episode.gameId}`) ?? [];
      const bounds = episodeWindowBounds(episode);
      const matching = fires
        .filter(
          (fire) => fire.observedAtSec >= bounds.startSec && fire.observedAtSec <= bounds.endSec,
        )
        .toSorted((a, b) => a.observedAtSec - b.observedAtSec);
      const first = matching[0];
      return {
        algoId: algo.id,
        gameId: episode.gameId,
        episodeStartIso: episode.startIso,
        episodeEndIso: episode.endIso,
        scoreable: true,
        caught: first !== undefined,
        leadSeconds:
          first === undefined ? null : (rounded(first.observedAtSec - episode.startSec, 1) ?? 0),
        fireIso: first?.observedAtIso ?? null,
        firesInWindow: matching.length,
      };
    }),
  );
}

function fireMatchesAnyMarketOutlierWindow(
  fire: Fire,
  episodes: readonly MarketOutlierEpisode[],
): boolean {
  return episodes.some((episode) => {
    const bounds = episodeWindowBounds(episode);
    return (
      episode.gameId === fire.gameId &&
      fire.observedAtSec >= bounds.startSec &&
      fire.observedAtSec <= bounds.endSec
    );
  });
}

function diagnoseGameSummary(summary: Omit<GameAlgorithmSummary, "diagnosis">): string {
  if (summary.fires === 0) return "silent: no qualifying fire in this game";
  const notes: string[] = [];
  if (
    summary.activeMarketCount >= HIGH_MARKET_BREADTH_COUNT ||
    summary.quotePairCount >= HIGH_QUOTE_PAIR_COUNT
  ) {
    notes.push("coverage-heavy: many markets or quote pairs can inflate raw board intensity");
  }
  if (summary.finalFiveCloseFires / summary.fires >= HIGH_LATE_GAME_FIRE_SHARE) {
    notes.push("late-game heavy: clutch/foul/timeout churn is a major share of fires");
  }
  if (summary.episodes > 0 && summary.fires / summary.episodes >= 3) {
    notes.push("episode burst: repeated adjacent buckets should be reviewed as one alert episode");
  }
  if (summary.firesPer100QuotePairs > 1 && summary.quotePairCount < HIGH_QUOTE_PAIR_COUNT) {
    notes.push("threshold-heavy: high fires despite modest quote density");
  }
  return notes.length === 0
    ? "ordinary: no obvious coverage or late-game concentration flag"
    : notes.join("; ");
}

function summarizeGameAlgorithm(
  game: GameData,
  algo: AlgoSpec,
  fires: readonly Fire[],
): GameAlgorithmSummary {
  const buckets = bucketize(game, algo.bucketSeconds);
  const scores = buckets.map((bucket) => bucketScore(bucket, algo));
  const activeMarketCounts = buckets.map((bucket) => bucket.activeMarketCount);
  const quotePairCount = game.pairs.length;
  const firesPer100QuotePairs = quotePairCount === 0 ? 0 : (fires.length / quotePairCount) * 100;
  const base: Omit<GameAlgorithmSummary, "diagnosis"> = {
    algoId: algo.id,
    gameId: game.gameId,
    scheduledStart: game.window.scheduledStart,
    matchup: matchupLabel(game.window),
    fires: fires.length,
    episodes: countAlertEpisodes(fires),
    finalFiveCloseFires: fires.filter(isFinalFiveClose).length,
    firstFireIso: fires[0]?.observedAtIso ?? null,
    lastFireIso: fires.at(-1)?.observedAtIso ?? null,
    bucketSeconds: algo.bucketSeconds,
    bucketCount: buckets.length,
    quotePairCount,
    microEventCount: game.micro.length,
    activeMarketCount: uniqueCount(game.pairs.map((pair) => pair.sourceMarketId)),
    sourceCount: uniqueCount(game.pairs.map((pair) => pair.source)),
    familyCount: uniqueCount(game.pairs.map((pair) => pair.family)),
    meanActiveMarketsPerBucket: rounded(mean(activeMarketCounts) ?? 0, 2) ?? 0,
    p95ActiveMarketsPerBucket: rounded(percentile(activeMarketCounts, 0.95) ?? 0, 2) ?? 0,
    maxActiveMarketsPerBucket:
      activeMarketCounts.length === 0 ? 0 : Math.max(...activeMarketCounts),
    p95Score: rounded(percentile(scores, 0.95) ?? 0, 4) ?? 0,
    maxScore: rounded(scores.length === 0 ? 0 : Math.max(...scores), 4) ?? 0,
    firesPer100QuotePairs: rounded(firesPer100QuotePairs, 3) ?? 0,
    episodesPer100QuotePairs:
      rounded(quotePairCount === 0 ? 0 : (countAlertEpisodes(fires) / quotePairCount) * 100, 3) ??
      0,
  };
  return { ...base, diagnosis: diagnoseGameSummary(base) };
}

function buildGameSummaries(
  algorithms: readonly AlgoSpec[],
  games: ReadonlyMap<string, GameData>,
  firesByAlgoGame: ReadonlyMap<string, readonly Fire[]>,
): readonly GameAlgorithmSummary[] {
  return algorithms.flatMap((algo) =>
    [...games.values()].map((game) =>
      summarizeGameAlgorithm(game, algo, firesByAlgoGame.get(`${algo.id}:${game.gameId}`) ?? []),
    ),
  );
}

function buildFireOutliers(
  summaries: readonly AlgorithmSummary[],
  gameSummaries: readonly GameAlgorithmSummary[],
): readonly FireOutlier[] {
  return summaries.flatMap((summary): readonly FireOutlier[] => {
    const rows = gameSummaries.filter((game) => game.algoId === summary.algoId);
    return rows
      .filter((game) =>
        isFireOutlier(game.fires, summary.medianFiresPerGame, summary.p95FiresPerGame),
      )
      .toSorted((a, b) => b.fires - a.fires)
      .slice(0, 5)
      .map(
        (game): FireOutlier => ({
          algoId: game.algoId,
          gameId: game.gameId,
          matchup: game.matchup,
          fires: game.fires,
          episodes: game.episodes,
          medianFires: summary.medianFiresPerGame,
          p95Fires: summary.p95FiresPerGame,
          quotePairCount: game.quotePairCount,
          activeMarketCount: game.activeMarketCount,
          sourceCount: game.sourceCount,
          familyCount: game.familyCount,
          finalFiveCloseFires: game.finalFiveCloseFires,
          diagnosis: game.diagnosis,
        }),
      );
  });
}

export function summarizeAlgorithm(
  algo: AlgoSpec,
  incidentResults: readonly IncidentAlgoResult[],
  firesByGame: ReadonlyMap<string, readonly Fire[]>,
  gameSummaries: readonly GameAlgorithmSummary[],
  marketOutlierResults: readonly MarketOutlierAlgoResult[],
  marketOutlierEpisodes: readonly MarketOutlierEpisode[],
): AlgorithmSummary {
  const matchingResults = incidentResults.filter((result) => result.algoId === algo.id);
  const scoreable = matchingResults.filter((result) => result.scoreable);
  const caught = scoreable.filter((result) => result.caught);
  const leads = caught.flatMap((result): readonly number[] =>
    result.leadSeconds === null ? [] : [result.leadSeconds],
  );
  const preEventCaught = caught.filter(
    (result) => result.leadSeconds !== null && result.leadSeconds < 0,
  );
  const postEventCaught = caught.filter(
    (result) => result.leadSeconds !== null && result.leadSeconds >= 0,
  );
  const fireCounts = [...firesByGame.entries()]
    .filter(([key]) => key.startsWith(`${algo.id}:`))
    .map(([, fires]) => fires.length);
  const medianFires = percentile(fireCounts, 0.5) ?? 0;
  const p95Fires = percentile(fireCounts, 0.95) ?? 0;
  const maxFires = fireCounts.length === 0 ? 0 : Math.max(...fireCounts);
  const totalFires = fireCounts.reduce((sum, count) => sum + count, 0);
  const algoEpisodes = marketOutlierResults.filter((result) => result.algoId === algo.id);
  const caughtEpisodes = algoEpisodes.filter((result) => result.scoreable && result.caught);
  const marketLeads = caughtEpisodes.flatMap((result): readonly number[] =>
    result.leadSeconds === null ? [] : [result.leadSeconds],
  );
  const allFires = [...firesByGame.entries()]
    .filter(([key]) => key.startsWith(`${algo.id}:`))
    .flatMap(([, fires]) => fires);
  const firesInsideMarketOutlierWindows = allFires.filter((fire) =>
    fireMatchesAnyMarketOutlierWindow(fire, marketOutlierEpisodes),
  ).length;
  const firesOutsideMarketOutlierWindows = allFires.length - firesInsideMarketOutlierWindows;
  const finalFiveCloseFires = [...firesByGame.entries()]
    .filter(([key]) => key.startsWith(`${algo.id}:`))
    .reduce((sum, [, fires]) => sum + fires.filter(isFinalFiveClose).length, 0);
  const algoGameSummaries = gameSummaries.filter((summary) => summary.algoId === algo.id);
  const episodeCounts = algoGameSummaries.map((summary) => summary.episodes);
  return {
    algoId: algo.id,
    name: algo.name,
    family: algo.family,
    caughtScoreable: caught.length,
    scoreableIncidents: scoreable.length,
    medianLeadSeconds: rounded(percentile(leads, 0.5), 1),
    meanLeadSeconds: rounded(mean(leads), 1),
    preEventCaughtScoreable: preEventCaught.length,
    postEventCaughtScoreable: postEventCaught.length,
    meanFiresPerGame: rounded(mean(fireCounts) ?? 0, 2) ?? 0,
    medianFiresPerGame: rounded(medianFires, 2) ?? 0,
    finalFiveCloseFiresPerGame:
      rounded(fireCounts.length === 0 ? 0 : finalFiveCloseFires / fireCounts.length, 2) ?? 0,
    meanEpisodesPerGame: rounded(mean(episodeCounts) ?? 0, 2) ?? 0,
    maxEpisodesPerGame:
      rounded(episodeCounts.length === 0 ? 0 : Math.max(...episodeCounts), 2) ?? 0,
    p95FiresPerGame: rounded(p95Fires, 2) ?? 0,
    maxFiresPerGame: rounded(maxFires, 2) ?? 0,
    fireDispersionRatio:
      medianFires <= 0 ? null : (rounded(maxFires / medianFires, 2) ?? maxFires / medianFires),
    outlierGameCount: algoGameSummaries.filter((summary) =>
      isFireOutlier(summary.fires, medianFires, p95Fires),
    ).length,
    marketOutlierEpisodesCaught: caughtEpisodes.length,
    marketOutlierEpisodeCount: algoEpisodes.length,
    marketOutlierRecall:
      rounded(
        algoEpisodes.length === 0 ? 0 : (caughtEpisodes.length / algoEpisodes.length) * 100,
        1,
      ) ?? 0,
    medianMarketOutlierLeadSeconds: rounded(percentile(marketLeads, 0.5), 1),
    firesInsideMarketOutlierWindows,
    firesOutsideMarketOutlierWindows,
    firesInsideMarketOutlierShare:
      rounded(totalFires === 0 ? 0 : (firesInsideMarketOutlierWindows / totalFires) * 100, 1) ?? 0,
    firesPerCaughtIncident:
      caught.length === 0
        ? null
        : (rounded(totalFires / caught.length, 2) ?? totalFires / caught.length),
    caughtPer100Fires: rounded(totalFires === 0 ? 0 : (caught.length / totalFires) * 100, 3) ?? 0,
    totalFires,
    denominatorGames: fireCounts.length,
    formula: algo.formula,
    rationale: algo.rationale,
  };
}

function rankAlgorithmSummaries(
  summaries: readonly AlgorithmSummary[],
): readonly AlgorithmSummary[] {
  return summaries.toSorted((a, b) => {
    const caughtDelta = b.caughtScoreable - a.caughtScoreable;
    if (caughtDelta !== 0) return caughtDelta;
    const marketOutlierDelta = b.marketOutlierRecall - a.marketOutlierRecall;
    if (marketOutlierDelta !== 0) return marketOutlierDelta;
    const insideShareDelta = b.firesInsideMarketOutlierShare - a.firesInsideMarketOutlierShare;
    if (insideShareDelta !== 0) return insideShareDelta;
    const finalFiveDelta = a.finalFiveCloseFiresPerGame - b.finalFiveCloseFiresPerGame;
    if (finalFiveDelta !== 0) return finalFiveDelta;
    return a.meanFiresPerGame - b.meanFiresPerGame;
  });
}

function reportNoteFor(algoId: string): ReportNote | null {
  return REPORT_NOTES.find((note) => note.algoId === algoId) ?? null;
}

function warningText(summary: AlgorithmSummary): string {
  const note = reportNoteFor(summary.algoId);
  if (note !== null) return `${note.severity}: ${note.note}`;
  if (summary.marketOutlierEpisodesCaught === 0 && summary.marketOutlierEpisodeCount > 0) {
    return "weak: misses every market-native outlier episode in the current tape-derived denominator.";
  }
  if (summary.firesInsideMarketOutlierShare < 25 && summary.totalFires >= 10) {
    return "caution: most fires land outside the market-native outlier windows.";
  }
  if (summary.outlierGameCount > 0) {
    return `caution: ${String(summary.outlierGameCount)} game(s) hit the fire-count outlier rule.`;
  }
  if (summary.meanFiresPerGame >= 15) {
    return "caution: high alert burden; review episodes before treating this as deployable.";
  }
  return "usable comparator; no special warning from the current report rules.";
}

function buildReportMarkdown(payload: BakeoffPayload): string {
  const topRows = rankAlgorithmSummaries(payload.summaries)
    .slice(0, 10)
    .map(
      (summary) =>
        `| ${summary.algoId} | ${summary.caughtScoreable}/${summary.scoreableIncidents} | ${summary.marketOutlierEpisodesCaught}/${summary.marketOutlierEpisodeCount} (${summary.marketOutlierRecall}%) | ${summary.firesInsideMarketOutlierShare}% | ${summary.meanFiresPerGame} | ${summary.meanEpisodesPerGame} | ${summary.p95FiresPerGame} | ${summary.maxFiresPerGame} | ${summary.outlierGameCount} | ${summary.medianLeadSeconds ?? "n/a"} | ${warningText(summary)} |`,
    )
    .join("\n");
  const runtimeRows = payload.summaries
    .filter((summary) => summary.algoId.startsWith("A00_runtime_state_space"))
    .map(
      (summary) =>
        `| ${summary.algoId} | ${summary.caughtScoreable}/${summary.scoreableIncidents} | ${summary.marketOutlierEpisodesCaught}/${summary.marketOutlierEpisodeCount} (${summary.marketOutlierRecall}%) | ${summary.firesInsideMarketOutlierShare}% | ${summary.meanFiresPerGame} | ${summary.meanEpisodesPerGame} | ${warningText(summary)} |`,
    )
    .join("\n");
  const marketOutlierRows = payload.marketOutlierEpisodes
    .slice(0, 12)
    .map(
      (episode) =>
        `| ${episode.gameId} | ${episode.matchup} | ${episode.startIso} | ${episode.endIso} | ${episode.peakSeverity} | ${episode.peakPriceMoveZ} | ${episode.peakBreadthZ} | ${episode.peakOffpriceZ} | ${episode.diagnosis} |`,
    )
    .join("\n");
  const outlierRows = payload.fireOutliers
    .slice(0, 12)
    .map(
      (row) =>
        `| ${row.algoId} | ${row.gameId} | ${row.fires} | ${row.episodes} | ${row.quotePairCount} | ${row.activeMarketCount} | ${row.diagnosis} |`,
    )
    .join("\n");
  const methodRows = METHOD_ADJUSTMENTS.map(
    (row) => `| ${row.label} | \`${row.formula}\` | ${row.reason} |`,
  ).join("\n");
  return `# NBA Detector Bake-Off

Generated: ${payload.generatedAt}

This is an offline research artifact, not an official NBA source of truth. It scores every locally surfaced incident candidate we could ground from the previous report and archive trail, then labels anchor/data gaps instead of pretending they are misses. Positive lead seconds mean the first matching fire happened after the disputed play; negative lead seconds mean a pre-play warning.

## Coverage

- Incidents surfaced: ${payload.coverage.totalIncidents}
- Exact UTC anchors: ${payload.coverage.exactAnchorIncidents}
- Locally scoreable incidents: ${payload.coverage.scoreableIncidents}
- Market-native outlier episodes: ${payload.marketOutlierEpisodes.length}
- Denominator games with PBP windows: ${payload.coverage.denominatorGames}
- Algorithms tested: ${payload.algorithms.length}

## Runtime Rows

These rows are backed by the actual Python live runtime and the saved detector defaults, not only the TypeScript research comparators.

| Runtime row | Incident caught | Tape outliers caught | Fires inside tape windows | Mean fires/game | Episodes/game | Report read |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
${runtimeRows.length === 0 ? "| none | 0/0 | 0/0 (0%) | 0% | 0 | 0 | no runtime-backed rows generated |" : runtimeRows}

## Top Rows

| Algorithm | Incident caught | Tape outliers caught | Fires inside tape windows | Mean fires/game | Episodes/game | P95 fires | Max fires | Outlier games | Median lag seconds | Report read |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${topRows}

## Market-Native Outlier Episodes

| Game | Matchup | Start | End | Peak severity | Price-move z | Breadth z | Offprice z | Diagnosis |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
${marketOutlierRows.length === 0 ? "| none | none | n/a | n/a | 0 | 0 | 0 | 0 | no tape-derived outlier episodes |" : marketOutlierRows}

## Fire-Count Outliers

| Algorithm | Game | Fires | Episodes | Quote pairs | Active markets | Diagnosis |
| --- | --- | ---: | ---: | ---: | ---: | --- |
${outlierRows.length === 0 ? "| none | none | 0 | 0 | 0 | 0 | no outlier games |" : outlierRows}

## Actionable Formula Adjustments

| Adjustment | Formula | Why it matters |
| --- | --- | --- |
${methodRows}

## Artifact Files

- \`report.html\`: interactive standalone report.
- \`research/bakeoff-results.json\`: machine-readable source of truth.
- \`research/incident-registry-expanded.json\`: copied incident registry plus archive-only extras.

`;
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

async function formatArtifact(
  source: string,
  parser: "html" | "json" | "markdown",
): Promise<string> {
  const config = await resolveConfig(PRETTIER_CONFIG_PATH);
  return `${(await format(source, { ...(config ?? {}), parser })).trimEnd()}\n`;
}

function buildReportHtml(payload: BakeoffPayload): string {
  const best = payload.bestSummary;
  const runtimeRows = payload.summaries
    .filter((summary) => summary.algoId.startsWith("A00_runtime_state_space"))
    .map(
      (summary) =>
        `<tr><td class="mono">${htmlEscape(summary.algoId)}<br><span class="muted">${htmlEscape(summary.name)}</span></td><td class="num">${summary.caughtScoreable}/${summary.scoreableIncidents}</td><td class="num">${summary.marketOutlierEpisodesCaught}/${summary.marketOutlierEpisodeCount}<br>${summary.marketOutlierRecall}%</td><td class="num">${summary.firesInsideMarketOutlierShare}%</td><td class="num">${summary.meanFiresPerGame}</td><td class="num">${summary.meanEpisodesPerGame}</td><td>${htmlEscape(warningText(summary))}</td></tr>`,
    )
    .join("");
  const bestText =
    best === null
      ? "No scoreable algorithms"
      : `Highest recall row: ${best.name} ${best.caughtScoreable}/${best.scoreableIncidents} incidents, ${best.marketOutlierEpisodesCaught}/${best.marketOutlierEpisodeCount} tape outliers, ${best.meanEpisodesPerGame} episodes/game`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NBA Detector Bake-Off</title>
<link rel="icon" href="data:,">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,900&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#07120f;--bg2:#0a1814;--panel:#0d211b;--panel2:#0a1714;--line:#1c3a31;--ink:#d8e7df;--ink2:#9ab2a7;--ink3:#617c71;--paper:#f2f6f1;--amber:#ffd21f;--green:#19e06f;--red:#ff6262;--cyan:#62d8d1;--violet:#b2a3ff;--grid:#123228;--mono:'IBM Plex Mono',ui-monospace,monospace;--sans:'IBM Plex Sans',system-ui,sans-serif;--serif:'Fraunces',Georgia,serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.55}.wrap{max-width:1220px;margin:0 auto;padding:0 24px}.mono,.num{font-family:var(--mono);font-variant-numeric:tabular-nums}header{border-bottom:1px solid var(--line);background:linear-gradient(180deg,#0b1b16,#07120f);position:relative;overflow:hidden}header:before{content:"";position:absolute;inset:0;background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);background-size:34px 34px;opacity:.28;mask-image:linear-gradient(180deg,#000,transparent)}header .wrap{position:relative;padding:34px 24px 32px}.kicker{font-family:var(--mono);font-size:11px;letter-spacing:.25em;text-transform:uppercase;color:var(--amber);margin:0 0 14px}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--amber);margin-right:9px;box-shadow:0 0 14px var(--amber)}h1{font-family:var(--serif);font-weight:900;font-size:clamp(32px,5vw,58px);line-height:1.02;margin:0;color:var(--paper)}.dek{max-width:920px;margin:16px 0 0;color:var(--ink2);font-size:16.5px}.routing{display:flex;flex-wrap:wrap;gap:12px;margin-top:22px;font-family:var(--mono);font-size:12px;color:var(--ink2)}.tag{border:1px solid var(--line);border-radius:4px;padding:4px 9px;background:var(--panel2)}nav{position:sticky;top:0;z-index:20;background:rgba(7,18,15,.94);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}nav .wrap{display:flex;gap:2px;overflow-x:auto}nav a{font-family:var(--mono);font-size:11px;color:var(--ink3);padding:13px 10px;border-bottom:2px solid transparent;white-space:nowrap;text-decoration:none}nav a:hover{color:var(--ink)}section{padding:46px 0;border-bottom:1px solid var(--line)}.snum{font-family:var(--mono);font-size:12px;color:#caa900;letter-spacing:.18em}h2{font-family:var(--serif);font-weight:600;font-size:clamp(24px,3.4vw,36px);color:var(--paper);margin:8px 0 6px}h3{margin:0 0 8px;color:var(--paper)}.lede{color:var(--ink2);max-width:900px;font-size:16px;margin:0 0 22px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:20px 0}@media(max-width:860px){.stats{grid-template-columns:1fr 1fr}}@media(max-width:520px){.stats{grid-template-columns:1fr}}.stat,.panel,.chart{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:8px;padding:18px}.chart{margin:18px 0}.chart .ct{font-family:var(--mono);font-size:12px;letter-spacing:.05em;color:var(--ink);margin-bottom:2px}.chart .cs{font-size:12px;color:var(--ink3);margin-bottom:12px}.stat .v{font-family:var(--mono);font-size:25px;font-weight:600;color:var(--paper);line-height:1}.stat .l{font-size:12.5px;color:var(--ink2);margin-top:8px;line-height:1.4}.green .v{color:var(--green)}.amber .v{color:var(--amber)}.red .v{color:var(--red)}.cyan .v{color:var(--cyan)}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:900px){.grid2{grid-template-columns:1fr}}table{width:100%;border-collapse:collapse;font-size:13px;margin:16px 0}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-family:var(--mono);font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--ink3);font-weight:500}td.num,th.num{text-align:right}.t-scroll{overflow-x:auto}.pill{font-family:var(--mono);font-size:11px;padding:1px 7px;border-radius:10px;border:1px solid;white-space:nowrap}.pill.g{color:var(--green);border-color:rgba(25,224,111,.45);background:rgba(25,224,111,.09)}.pill.r{color:var(--red);border-color:rgba(255,98,98,.45);background:rgba(255,98,98,.09)}.pill.y{color:var(--amber);border-color:rgba(255,210,31,.45);background:rgba(255,210,31,.09)}.pill.n{color:var(--ink3);border-color:var(--line)}select,input{background:var(--panel2);border:1px solid var(--line);color:var(--ink);border-radius:5px;padding:8px 10px;font-family:var(--mono)}label{font-family:var(--mono);font-size:12px;color:var(--ink2);display:block;margin-bottom:6px}.controls{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}.callout{background:var(--panel2);border:1px solid var(--line);border-left:3px solid var(--amber);border-radius:6px;padding:16px 18px;margin:16px 0}.warn{border-left-color:var(--red)}.muted{color:var(--ink2)}.dim{color:var(--ink3)}a{color:var(--cyan)}code{font-family:var(--mono);font-size:.9em;background:var(--bg2);border:1px solid var(--line);border-radius:3px;padding:1px 5px;color:var(--amber)}svg{display:block;width:100%;height:auto;overflow:visible}.axis{stroke:var(--ink3);stroke-width:1}.grid{stroke:var(--grid);stroke-width:1}.legend{display:flex;gap:12px;flex-wrap:wrap;font-family:var(--mono);font-size:11px;color:var(--ink2)}details{border:1px solid var(--line);border-radius:8px;background:var(--panel2);padding:14px 16px;margin:14px 0}summary{cursor:pointer;color:var(--paper);font-weight:600}footer{padding:35px 0 70px;color:var(--ink3);font-family:var(--mono);font-size:12px}
</style>
</head>
<body>
<header><div class="wrap">
  <p class="kicker"><span class="dot"></span>Signal Console · NBA Detector Bake-Off · ${htmlEscape(payload.generatedAt)}</p>
  <h1>Baseline timing, historical priors, and the fire-burden problem.</h1>
  <p class="dek">This report still tests detector ideas against known NBA stat-credit scares, but it now adds a second denominator from the tape itself: market-native outlier episodes. A row is not deployable just because it catches the known cases if most of its fires land outside the tape's own volatility separations.</p>
  <div class="routing"><span class="tag">${htmlEscape(bestText)}</span><span class="tag">${payload.algorithms.length} algorithms</span><span class="tag">${payload.marketOutlierEpisodes.length} tape outlier episodes</span><span class="tag">${payload.fireOutliers.length} fire-count outlier rows</span></div>
</div></header>
<nav><div class="wrap"><a href="#decision">1·Decision</a><a href="#leaderboard">2·Leaderboard</a><a href="#market">3·Tape Outliers</a><a href="#burden">4·Fire Burden</a><a href="#weak">5·Weak Rows</a><a href="#incidents">6·Incidents</a><a href="#algos">7·Algorithms</a><a href="#method">8·Method</a><a href="#sources">9·Research</a></div></nav>
<main class="wrap">
<section id="decision">
  <div class="snum">SECTION 01</div><h2>Decision Read</h2>
  <p class="lede">Treat this as a tuning bakeoff, not a shipping verdict. The headline catcher can still be a bad production detector if it pages every few buckets in coverage-heavy games or if its fires mostly miss the tape's own outlier episodes.</p>
  <div class="stats">
    <div class="stat green"><div class="v">${payload.coverage.totalIncidents}</div><div class="l">surfaced incidents and archived complaints</div></div>
    <div class="stat amber"><div class="v">${payload.coverage.scoreableIncidents}</div><div class="l">scoreable with exact UTC plus matching market coverage</div></div>
    <div class="stat cyan"><div class="v">${payload.marketOutlierEpisodes.length}</div><div class="l">tape-derived outlier episodes from the market itself</div></div>
    <div class="stat red"><div class="v">${payload.algorithms.length}</div><div class="l">candidate formulas tested</div></div>
  </div>
  <div class="grid2">
    <div class="panel"><h3>What changed in this run</h3><p class="muted">The bakeoff still scores no-fire games as misses when the incident is anchored and the local game has coverage. It now also emits tape-derived outlier episodes, per-algorithm outlier recall, and the share of fires that actually land inside those windows.</p></div>
    <div class="panel"><h3>Working recommendation</h3><p class="muted">Keep the historical-to-live profile in the bakeoff, but judge it by incident catch rate plus tape-outlier recall plus episodes/game and outlier burden. Coverage-normalized and cooldown rows are research candidates, not silent live defaults.</p></div>
  </div>
  <div class="callout warn"><b>Important:</b> incident lag seconds are still relative to the disputed play. Tape-outlier recall is a separate denominator built from 30-second within-game robust z outliers on coverage-normalized board intensity, breadth, and offprice confirmation.</div>
  <div class="t-scroll"><table><thead><tr><th>Runtime row</th><th class="num">Incidents</th><th class="num">Tape outliers</th><th class="num">Inside share</th><th class="num">Fires/gm</th><th class="num">Episodes/gm</th><th>Read</th></tr></thead><tbody>${runtimeRows || '<tr><td>none</td><td class="num">0/0</td><td class="num">0/0</td><td class="num">0%</td><td class="num">0</td><td class="num">0</td><td>no runtime-backed rows generated</td></tr>'}</tbody></table></div>
</section>
<section id="leaderboard">
  <div class="snum">SECTION 02</div><h2>Leaderboard and Trade-Off</h2>
  <p class="lede">The chart still plots scoreable cases caught against alert episodes per game. Episodes merge fires within 90 seconds so one sustained repricing regime does not pretend to be dozens of separate desk decisions, while the table adds whether those fires align with tape-native outlier windows.</p>
  <div class="chart"><div class="ct">Caught cases vs alert episodes per game</div><div class="cs">Left is calmer; higher is better. Hover/click rows in the tables below for detail.</div><svg id="leaderSvg" viewBox="0 0 1100 420" role="img" aria-label="Caught cases versus alert episodes per game"></svg></div>
  <div class="t-scroll"><table id="summary-table"></table></div>
</section>
<section id="market">
  <div class="snum">SECTION 03</div><h2>Market-Native Outlier Episodes</h2>
  <p class="lede">This denominator comes from the tape itself, not from the incident registry. A bucket qualifies when coverage-normalized board intensity becomes a within-game robust outlier and broader participation or offprice microstructure confirms that the move is a board-level event rather than one isolated market twitch.</p>
  <div class="t-scroll"><table id="market-table"></table></div>
</section>
<section id="burden">
  <div class="snum">SECTION 04</div><h2>Fire-Count Outliers</h2>
  <p class="lede">This is the audit for the 300-fire-versus-10-fire problem. If a game lands here, the report forces a diagnosis: coverage-heavy board breadth, late-game churn, repeated adjacent buckets, or threshold behavior.</p>
  <div class="chart"><div class="ct">Top fire-count outliers</div><div class="cs">Bars show raw fires; markers show alert episodes after 90s merging.</div><svg id="outlierSvg" viewBox="0 0 1100 420" role="img" aria-label="Top fire-count outlier games"></svg></div>
  <div class="t-scroll"><table id="outlier-table"></table></div>
</section>
<section id="weak">
  <div class="snum">SECTION 05</div><h2>Weak Or Misleading Rows</h2>
  <p class="lede">These warnings are part of the result. Some rows are good controls or good research scaffolding, but they are not honest deployable winners under the current evidence.</p>
  <div class="t-scroll"><table id="weak-table"></table></div>
</section>
<section id="incidents">
  <div class="snum">SECTION 06</div><h2>Incident Timing</h2>
  <p class="lede">Pick an algorithm to see whether it fired in the incident window. Positive lag seconds are post-play; negative values are pre-play. Rows without anchors remain visible as data gaps, not fake misses.</p>
  <div class="chart"><div class="ct">Catch matrix for selected algorithms</div><div class="cs">Green = caught in the incident window, red = scoreable miss, gray = anchor/coverage gap.</div><svg id="matrixSvg" viewBox="0 0 1100 420" role="img" aria-label="Algorithm catch matrix"></svg></div>
  <div class="controls"><div><label for="incident-algo">Algorithm</label><select id="incident-algo"></select></div><div><label for="score-filter">Rows</label><select id="score-filter"><option value="all">All incidents</option><option value="scoreable">Scoreable only</option><option value="caught">Caught only</option><option value="missed">Missed scoreable only</option><option value="gap">Anchor/data gaps</option></select></div></div>
  <div class="t-scroll"><table id="incident-table"></table></div>
</section>
<section id="algos">
  <div class="snum">SECTION 07</div><h2>Algorithm Detail</h2>
  <p class="lede">Each row is causal and uses only prior information. Historical rows model last-five same-side openings, then fade toward current game memory. Fire-control rows test normalization and episode hygiene separately from raw recall.</p>
  <div class="controls"><div><label for="algo-select">Algorithm</label><select id="algo-select"></select></div></div>
  <div id="algo-detail" class="panel"></div>
</section>
<section id="method">
  <div class="snum">SECTION 08</div><h2>Method and Failure Modes</h2>
  <div class="grid2">
    <div class="panel"><h3>Scoreability contract</h3><p class="muted">A row is scoreable only when the incident has exact UTC, a normalized local game id, PBP coverage, and quote or microstructure coverage for that algorithm. Zero fires on a scoreable game is an honest miss.</p></div>
    <div class="panel"><h3>Memory contract</h3><p class="muted">The historical-to-live profile uses the requested home/away opening prior shape, then shifts weight to current-game baseline. The report keeps game-clock memory, recent wall-clock memory, and opening holdoff visible because each answers a different timing question.</p></div>
    <div class="panel"><h3>Known weak spots</h3><p class="muted">Sparse buckets erase quiet time; cumulative volume can amplify popularity; same-bucket cross-source confirmation can be too strict; tiny MAD windows can be brittle. These are research flags, not excuses to hide bad results.</p></div>
    <div class="panel"><h3>Next math work</h3><p class="muted">The next serious rows should add zero-filled calendar buckets, flow from volume deltas, signed-move coherence, latency-tolerant fanout, and robust Qn/Sn-style short-window scale candidates.</p></div>
  </div>
  <div class="t-scroll"><table id="method-table"></table></div>
  <details open><summary>Appendix: artifact contract</summary><p class="muted">Machine source: <code>research/bakeoff-results.json</code>. The JSON now includes <code>gameSummaries</code>, <code>marketOutlierEpisodes</code>, <code>marketOutlierResults</code>, and <code>fireOutliers</code> so future reports cannot hide tape misalignment or outlier games behind a mean fires/game number.</p></details>
</section>
<section id="sources">
  <div class="snum">SECTION 09</div><h2>Research Hooks</h2>
  <p class="lede">These are formula inspirations and operational guardrails, not proof that any one detector should ship. The report keeps them attached so tuning does not drift into numerology.</p>
  <div class="t-scroll"><table id="source-table"></table></div>
</section>
</main>
<footer class="wrap">Machine source: <code>research/bakeoff-results.json</code>. Incident registry copied from <code>${htmlEscape(payload.sourceRegistryPath)}</code>.</footer>
<script>
const DATA=${scriptJson(payload)};
const REPORT_NOTES=${scriptJson(REPORT_NOTES)};
const METHOD_ADJUSTMENTS=${scriptJson(METHOD_ADJUSTMENTS)};
const byId=(id)=>document.getElementById(id);
const pct=(a,b)=>b?Math.round((a/b)*100)+"%":"n/a";
function pill(text,cls){return '<span class="pill '+cls+'">'+text+'</span>'}
function esc(v){return String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function ranked(){return [...DATA.summaries].sort((a,b)=>(b.caughtScoreable-a.caughtScoreable)||(b.marketOutlierRecall-a.marketOutlierRecall)||(b.firesInsideMarketOutlierShare-a.firesInsideMarketOutlierShare)||(a.meanEpisodesPerGame-b.meanEpisodesPerGame)||(a.meanFiresPerGame-b.meanFiresPerGame))}
function reportNote(algoId){return REPORT_NOTES.find(n=>n.algoId===algoId)||null}
function reportRead(r){const n=reportNote(r.algoId);if(n)return '<span class="pill '+(n.severity==='weak'?'r':n.severity==='pending'?'n':'y')+'">'+n.severity+'</span> '+esc(n.note);if(r.marketOutlierEpisodesCaught===0&&r.marketOutlierEpisodeCount>0)return pill('weak','r')+' misses every tape outlier';if(r.firesInsideMarketOutlierShare<25&&r.totalFires>=10)return pill('caution','y')+' low tape alignment';if(r.outlierGameCount>0)return pill('caution','y')+' '+r.outlierGameCount+' outlier game(s)';if(r.meanFiresPerGame>=15)return pill('caution','y')+' high alert burden';return pill('ok','g')+' comparator'}
function renderSummary(){
  const rows=ranked();
  byId('summary-table').innerHTML='<thead><tr><th>Algorithm</th><th>Family</th><th class="num">Incidents</th><th class="num">Tape outliers</th><th class="num">Inside share</th><th class="num">Fires/gm</th><th class="num">Episodes/gm</th><th class="num">P95 fires</th><th class="num">Max fires</th><th class="num">Median lag s</th><th>Read</th></tr></thead><tbody>'+rows.map(r=>'<tr><td class="mono">'+esc(r.algoId)+'<br>'+esc(r.name)+'</td><td>'+esc(r.family)+'</td><td class="num">'+r.caughtScoreable+'/'+r.scoreableIncidents+'<br>'+pct(r.caughtScoreable,r.scoreableIncidents)+'</td><td class="num">'+r.marketOutlierEpisodesCaught+'/'+r.marketOutlierEpisodeCount+'<br>'+r.marketOutlierRecall+'%</td><td class="num">'+r.firesInsideMarketOutlierShare+'%</td><td class="num">'+r.meanFiresPerGame+'</td><td class="num">'+r.meanEpisodesPerGame+'</td><td class="num">'+r.p95FiresPerGame+'</td><td class="num">'+r.maxFiresPerGame+'</td><td class="num">'+(r.medianLeadSeconds??'n/a')+'</td><td>'+reportRead(r)+'</td></tr>').join('')+'</tbody>';
}
function fillSelect(id){
  const html=DATA.algorithms.map(a=>'<option value="'+a.id+'">'+a.id+' · '+a.name+'</option>').join('');
  byId(id).innerHTML=html;
}
function renderAlgo(){
  const id=byId('algo-select').value;
  const algo=DATA.algorithms.find(a=>a.id===id);
  const summary=DATA.summaries.find(s=>s.algoId===id);
  if(!algo||!summary)return;
  const games=DATA.gameSummaries.filter(g=>g.algoId===id).sort((a,b)=>b.fires-a.fires).slice(0,8);
  byId('algo-detail').innerHTML='<h3>'+esc(algo.name)+'</h3><p class="muted">'+esc(algo.rationale)+'</p><p><b>Formula:</b> <code>'+esc(algo.formula)+'</code></p><div class="callout">'+reportRead(summary)+'</div><div class="stats"><div class="stat green"><div class="v">'+summary.caughtScoreable+'/'+summary.scoreableIncidents+'</div><div class="l">scoreable incidents caught</div></div><div class="stat amber"><div class="v">'+summary.marketOutlierEpisodesCaught+'/'+summary.marketOutlierEpisodeCount+'</div><div class="l">tape outlier episodes caught</div></div><div class="stat red"><div class="v">'+summary.maxFiresPerGame+'</div><div class="l">max raw fires in one game</div></div><div class="stat cyan"><div class="v">'+summary.firesInsideMarketOutlierShare+'%</div><div class="l">fires inside tape outlier windows</div></div></div><p><b>Citations:</b> '+algo.citations.map(esc).join(' · ')+'</p><div class="t-scroll"><table><thead><tr><th>Highest-fire games</th><th class="num">Fires</th><th class="num">Episodes</th><th class="num">Quote pairs</th><th class="num">Markets</th><th>Diagnosis</th></tr></thead><tbody>'+games.map(g=>'<tr><td class="mono">'+esc(g.gameId)+'<br><span class="muted">'+esc(g.matchup)+'</span></td><td class="num">'+g.fires+'</td><td class="num">'+g.episodes+'</td><td class="num">'+g.quotePairCount+'</td><td class="num">'+g.activeMarketCount+'</td><td>'+esc(g.diagnosis)+'</td></tr>').join('')+'</tbody></table></div>';
}
function incidentStatus(result){
  if(!result.scoreable)return pill('gap','n');
  if(result.caught)return pill('caught','g');
  return pill('missed','r');
}
function renderIncidents(){
  const algoId=byId('incident-algo').value;
  const filter=byId('score-filter').value;
  const rows=DATA.incidents.map(i=>({incident:i,result:DATA.incidentResults.find(r=>r.incidentId===i.id&&r.algoId===algoId)})).filter(x=>{
    const r=x.result;
    if(filter==='scoreable')return r&&r.scoreable;
    if(filter==='caught')return r&&r.caught;
    if(filter==='missed')return r&&r.scoreable&&!r.caught;
    if(filter==='gap')return !r||!r.scoreable;
    return true;
  });
  byId('incident-table').innerHTML='<thead><tr><th>Incident</th><th>Anchor</th><th>Players</th><th>Status</th><th class="num">Lag s</th><th>Note</th></tr></thead><tbody>'+rows.map(({incident,result})=>'<tr><td class="mono">'+esc(incident.id)+'<br><span class="muted">'+esc(incident.sourceOrigin)+'</span></td><td>'+esc(incident.gameDate)+'<br><span class="muted">'+esc(incident.utcTime||'no exact UTC')+'</span></td><td>'+esc(incident.stat)+'<br>'+esc(incident.creditedPlayer)+' -> '+esc(incident.rightfulPlayer)+'</td><td>'+(result?incidentStatus(result):pill('gap','n'))+'</td><td class="num">'+(result&&result.leadSeconds!==null?result.leadSeconds:'')+'</td><td>'+esc(result&&result.skipReason?result.skipReason:(incident.notes||incident.sourceTextSummary||incident.sourceReference||''))+'</td></tr>').join('')+'</tbody>';
}
function renderSources(){
  byId('source-table').innerHTML='<thead><tr><th>Source</th><th>Use</th></tr></thead><tbody>'+DATA.researchSources.map(s=>'<tr><td><a href="'+esc(s.url)+'">'+esc(s.title)+'</a></td><td>'+esc(s.use)+'</td></tr>').join('')+'</tbody>';
}
function renderMarketOutliers(){
  const rows=[...DATA.marketOutlierEpisodes].sort((a,b)=>b.peakSeverity-a.peakSeverity);
  byId('market-table').innerHTML='<thead><tr><th>Game</th><th>Window</th><th class="num">Peak severity</th><th class="num">Price z</th><th class="num">Breadth z</th><th class="num">Offprice z</th><th class="num">Peak markets</th><th>Diagnosis</th></tr></thead><tbody>'+rows.map(r=>'<tr><td class="mono">'+esc(r.gameId)+'<br><span class="muted">'+esc(r.matchup)+'</span></td><td class="mono">'+esc(r.startIso)+'<br>'+esc(r.endIso)+'</td><td class="num">'+r.peakSeverity+'</td><td class="num">'+r.peakPriceMoveZ+'</td><td class="num">'+r.peakBreadthZ+'</td><td class="num">'+r.peakOffpriceZ+'</td><td class="num">'+r.peakActiveMarkets+'</td><td>'+esc(r.diagnosis)+'</td></tr>').join('')+'</tbody>';
}
function renderOutliers(){
  const rows=[...DATA.fireOutliers].sort((a,b)=>b.fires-a.fires);
  byId('outlier-table').innerHTML='<thead><tr><th>Algorithm</th><th>Game</th><th class="num">Fires</th><th class="num">Episodes</th><th class="num">Median</th><th class="num">P95</th><th class="num">Quote pairs</th><th class="num">Markets</th><th>Diagnosis</th></tr></thead><tbody>'+rows.map(r=>'<tr><td class="mono">'+esc(r.algoId)+'</td><td class="mono">'+esc(r.gameId)+'<br><span class="muted">'+esc(r.matchup)+'</span></td><td class="num">'+r.fires+'</td><td class="num">'+r.episodes+'</td><td class="num">'+r.medianFires+'</td><td class="num">'+r.p95Fires+'</td><td class="num">'+r.quotePairCount+'</td><td class="num">'+r.activeMarketCount+'</td><td>'+esc(r.diagnosis)+'</td></tr>').join('')+'</tbody>';
}
function renderWeakRows(){
  const rows=REPORT_NOTES.map(n=>({note:n,summary:DATA.summaries.find(s=>s.algoId===n.algoId)})).filter(x=>x.summary);
  byId('weak-table').innerHTML='<thead><tr><th>Algorithm</th><th>Severity</th><th class="num">Caught</th><th class="num">Fires/gm</th><th class="num">Episodes/gm</th><th class="num">Outliers</th><th>Why it is weak or misleading</th></tr></thead><tbody>'+rows.map(({note,summary})=>'<tr><td class="mono">'+esc(summary.algoId)+'<br>'+esc(summary.name)+'</td><td>'+pill(note.severity,note.severity==='weak'?'r':note.severity==='pending'?'n':'y')+'</td><td class="num">'+summary.caughtScoreable+'/'+summary.scoreableIncidents+'</td><td class="num">'+summary.meanFiresPerGame+'</td><td class="num">'+summary.meanEpisodesPerGame+'</td><td class="num">'+summary.outlierGameCount+'</td><td>'+esc(note.note)+'</td></tr>').join('')+'</tbody>';
}
function renderMethods(){
  byId('method-table').innerHTML='<thead><tr><th>Adjustment</th><th>Formula</th><th>Why it matters</th></tr></thead><tbody>'+METHOD_ADJUSTMENTS.map(row=>'<tr><td>'+esc(row.label)+'</td><td><code>'+esc(row.formula)+'</code></td><td>'+esc(row.reason)+'</td></tr>').join('')+'</tbody>';
}
function svgEl(tag,attrs){const e=document.createElementNS('http://www.w3.org/2000/svg',tag);Object.entries(attrs||{}).forEach(([k,v])=>e.setAttribute(k,String(v)));return e}
function txt(svg,x,y,text,attrs){const t=svgEl('text',{x,y,...attrs});t.textContent=text;svg.appendChild(t);return t}
function renderLeaderChart(){
  const svg=byId('leaderSvg');svg.innerHTML='';const W=1100,H=420,P={l:72,r:34,t:30,b:62};const rows=ranked();const maxX=Math.max(1,...rows.map(r=>r.meanEpisodesPerGame))*1.12;const maxY=Math.max(1,...rows.map(r=>r.caughtScoreable));
  const X=v=>P.l+(v/maxX)*(W-P.l-P.r);const Y=v=>H-P.b-(v/maxY)*(H-P.t-P.b);
  for(let i=0;i<=5;i++){const x=P.l+i*(W-P.l-P.r)/5;svg.appendChild(svgEl('line',{x1:x,y1:P.t,x2:x,y2:H-P.b,class:'grid'}));txt(svg,x,H-28,(maxX*i/5).toFixed(1),{'text-anchor':'middle',fill:'var(--ink3)','font-family':'IBM Plex Mono','font-size':11})}
  for(let i=0;i<=maxY;i++){const y=Y(i);svg.appendChild(svgEl('line',{x1:P.l,y1:y,x2:W-P.r,y2:y,class:'grid'}));txt(svg,38,y+4,String(i),{fill:'var(--ink3)','font-family':'IBM Plex Mono','font-size':11})}
  svg.appendChild(svgEl('line',{x1:P.l,y1:H-P.b,x2:W-P.r,y2:H-P.b,class:'axis'}));svg.appendChild(svgEl('line',{x1:P.l,y1:P.t,x2:P.l,y2:H-P.b,class:'axis'}));
  txt(svg,W/2,H-8,'alert episodes per game',{'text-anchor':'middle',fill:'var(--ink2)','font-family':'IBM Plex Mono','font-size':12});txt(svg,14,H/2,'caught scoreable cases',{transform:'rotate(-90 14 '+H/2+')','text-anchor':'middle',fill:'var(--ink2)','font-family':'IBM Plex Mono','font-size':12});
  rows.forEach((r,i)=>{const c=r.family==='fire-control'?'var(--amber)':r.family==='historical-prior'?'var(--green)':r.family==='control'?'var(--cyan)':'var(--ink2)';svg.appendChild(svgEl('circle',{cx:X(r.meanEpisodesPerGame),cy:Y(r.caughtScoreable),r:7,fill:c,stroke:'#07120f','stroke-width':2}));txt(svg,X(r.meanEpisodesPerGame)+9,Y(r.caughtScoreable)-7,r.algoId.replace('A',''),{fill:'var(--ink)', 'font-family':'IBM Plex Mono','font-size':10})});
}
function renderOutlierChart(){
  const svg=byId('outlierSvg');svg.innerHTML='';const rows=[...DATA.fireOutliers].sort((a,b)=>b.fires-a.fires).slice(0,10);const W=1100,H=420,P={l:260,r:40,t:24,b:42};const max=Math.max(1,...rows.map(r=>r.fires));const X=v=>P.l+(v/max)*(W-P.l-P.r);const rowH=(H-P.t-P.b)/Math.max(1,rows.length);
  rows.forEach((r,i)=>{const y=P.t+i*rowH+rowH*.18;const h=rowH*.52;txt(svg,12,y+h*.65,r.algoId+' · '+r.gameId,{fill:'var(--ink2)','font-family':'IBM Plex Mono','font-size':11});svg.appendChild(svgEl('rect',{x:P.l,y,width:Math.max(2,X(r.fires)-P.l),height:h,fill:'rgba(255,210,31,.65)'}));svg.appendChild(svgEl('circle',{cx:X(r.episodes),cy:y+h/2,r:5,fill:'var(--cyan)'}));txt(svg,X(r.fires)+8,y+h*.65,String(r.fires)+' fires / '+String(r.episodes)+' ep',{fill:'var(--ink)','font-family':'IBM Plex Mono','font-size':11})});
  txt(svg,P.l,H-10,'raw fires (bar) and episodes (cyan dot)',{fill:'var(--ink3)','font-family':'IBM Plex Mono','font-size':11});
}
function renderMatrix(){
  const svg=byId('matrixSvg');svg.innerHTML='';const algos=ranked().slice(0,10).map(r=>r.algoId);const incs=DATA.incidents.slice(0,12);const W=1100,H=420,P={l:260,t:72,r:24,b:28};const cw=(W-P.l-P.r)/Math.max(1,incs.length);const rh=(H-P.t-P.b)/Math.max(1,algos.length);
  incs.forEach((inc,i)=>txt(svg,P.l+i*cw+cw/2,34,inc.id.replace(/_/g,' ').slice(0,10),{'text-anchor':'middle',fill:'var(--ink3)','font-family':'IBM Plex Mono','font-size':9,transform:'rotate(-30 '+(P.l+i*cw+cw/2)+' 34)'}));
  algos.forEach((algo,j)=>{txt(svg,12,P.t+j*rh+rh/2+4,algo,{fill:'var(--ink2)','font-family':'IBM Plex Mono','font-size':11});incs.forEach((inc,i)=>{const r=DATA.incidentResults.find(x=>x.algoId===algo&&x.incidentId===inc.id);const fill=!r||!r.scoreable?'#273a34':r.caught?'var(--green)':'var(--red)';svg.appendChild(svgEl('rect',{x:P.l+i*cw+2,y:P.t+j*rh+2,width:Math.max(4,cw-4),height:Math.max(4,rh-4),rx:3,fill,opacity:(!r||!r.scoreable) ? .45 : .82}))})});
}
renderSummary();renderMarketOutliers();renderOutliers();renderWeakRows();renderMethods();fillSelect('algo-select');fillSelect('incident-algo');renderAlgo();renderIncidents();renderSources();renderLeaderChart();renderOutlierChart();renderMatrix();
byId('algo-select').addEventListener('change',renderAlgo);
byId('incident-algo').addEventListener('change',renderIncidents);
byId('score-filter').addEventListener('change',renderIncidents);
</script>
</body></html>`;
}

async function run(): Promise<number> {
  const dbPath = process.env.GOLD_DB_PATH ?? GOLD_DB_PATH;
  const db = openGoldDb(dbPath);
  try {
    const incidents = readIncidents();
    const detectorDefaults = readDetectorDefaults();
    const algorithms = buildAlgorithms(detectorDefaults);
    const windows = loadGameWindows(db);
    const games = new Map<string, GameData>();
    for (const window of windows) {
      games.set(window.gameId, buildGameData(db, window));
    }

    const firesByAlgoGame = new Map<string, readonly Fire[]>();
    for (const algo of algorithms) {
      for (const game of games.values()) {
        firesByAlgoGame.set(`${algo.id}:${game.gameId}`, await detectGame(game, algo, games));
      }
    }

    const incidentResults = incidents.flatMap((incident) =>
      findIncidentFire(incident, algorithms, firesByAlgoGame, games),
    );
    const gameSummaries = buildGameSummaries(algorithms, games, firesByAlgoGame);
    const marketOutlierEpisodes = [...games.values()].flatMap((game) =>
      buildMarketOutlierEpisodes(game),
    );
    const marketOutlierResults = buildMarketOutlierResults(
      algorithms,
      marketOutlierEpisodes,
      firesByAlgoGame,
    );
    const summaries = algorithms.map((algo) =>
      summarizeAlgorithm(
        algo,
        incidentResults,
        firesByAlgoGame,
        gameSummaries,
        marketOutlierResults,
        marketOutlierEpisodes,
      ),
    );
    const fireOutliers = buildFireOutliers(summaries, gameSummaries);
    const exactAnchorIncidents = incidents.filter(
      (incident) => parseIsoSeconds(incident.utcTime) !== null,
    );
    const scoreableIncidentIds = new Set(
      incidentResults.filter((result) => result.scoreable).map((result) => result.incidentId),
    );
    const bestSummary = rankAlgorithmSummaries(summaries)[0] ?? null;
    const payload: BakeoffPayload = {
      generatedAt: REPORT_GENERATED_AT,
      sourceRegistryPath: SOURCE_REGISTRY_PATH,
      dbPath,
      incidentCount: incidents.length,
      exactAnchorIncidentCount: exactAnchorIncidents.length,
      scoreableIncidentCount: scoreableIncidentIds.size,
      denominatorGames: games.size,
      algorithmCount: algorithms.length,
      bestSummary,
      incidents,
      algorithms,
      summaries,
      gameSummaries,
      marketOutlierEpisodes,
      marketOutlierResults,
      fireOutliers,
      incidentResults,
      researchSources: RESEARCH_SOURCES,
      coverage: {
        totalIncidents: incidents.length,
        exactAnchorIncidents: exactAnchorIncidents.length,
        scoreableIncidents: scoreableIncidentIds.size,
        denominatorGames: games.size,
      },
    };

    mkdirSync(RESEARCH_DIR, { recursive: true });
    writeFileSync(
      resolve(RESEARCH_DIR, "bakeoff-results.json"),
      await formatArtifact(JSON.stringify(payload, null, 2), "json"),
    );
    writeFileSync(
      resolve(RESEARCH_DIR, "incident-registry-expanded.json"),
      await formatArtifact(
        JSON.stringify({ incidents, archiveOnlyCount: ARCHIVE_ONLY_INCIDENTS.length }, null, 2),
        "json",
      ),
    );
    writeFileSync(
      resolve(OUT_DIR, "REPORT.md"),
      await formatArtifact(buildReportMarkdown(payload), "markdown"),
    );
    writeFileSync(
      resolve(OUT_DIR, "report.html"),
      await formatArtifact(buildReportHtml(payload), "html"),
    );
    process.stdout.write(
      JSON.stringify(
        {
          output: OUT_DIR,
          incidents: payload.coverage.totalIncidents,
          scoreable: payload.coverage.scoreableIncidents,
          marketOutlierEpisodes: payload.marketOutlierEpisodes.length,
          algorithms: payload.algorithms.length,
          denominatorGames: payload.coverage.denominatorGames,
          best: payload.bestSummary,
        },
        null,
        2,
      ),
    );
    process.stdout.write("\n");
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}

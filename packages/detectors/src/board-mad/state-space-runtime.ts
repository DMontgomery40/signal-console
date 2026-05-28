import type { BoardStateSpaceConfig } from "./state-space-config";

export interface VolatilityHistoricalPrior {
  readonly mad: number;
  readonly median: number;
  readonly sampleSize: number;
}

export interface VolatilityStateSpaceObservation {
  readonly activeMarketCount?: number;
  readonly bucketEnd: string;
  readonly bucketStart: string;
  readonly gameElapsedSeconds?: number | null;
  readonly intensity: number;
  readonly sourceCount?: number;
  readonly sourceDisagreement?: number;
  readonly sourceDominance?: number;
}

export interface VolatilityStateSpaceParams {
  readonly baselineMode: "trailing" | "opening-ramp" | "historical-blend";
  readonly bucketSeconds: number;
  readonly historicalPrior?: VolatilityHistoricalPrior | null;
  readonly historicalPriorWeight?: number;
  readonly historicalRampCompleteGameMinutes?: number;
  readonly kMad: number;
  readonly openingBaselineBuckets?: number;
  readonly openingRampCompleteBuckets?: number;
  readonly recentWallMinutes?: number;
  readonly recentWallWeight?: number;
  readonly stateSpace: BoardStateSpaceConfig;
  readonly trailingBuckets: number;
  readonly trailingGameMinutes?: number;
  readonly warmupBuckets: number;
}

export interface VolatilityStateSpaceRequest {
  readonly gameId?: string | null;
  readonly observations: readonly VolatilityStateSpaceObservation[];
  readonly params: VolatilityStateSpaceParams;
}

export interface VolatilityStateSpaceResultObservation {
  readonly baselineMad: number;
  readonly baselineMedian: number;
  readonly bucketEnd: string;
  readonly bucketStart: string;
  readonly fired: boolean;
  readonly regimeScore: number;
  readonly standardizedInnovation: number;
  readonly threshold: number;
  readonly warmedUp: boolean;
}

export interface VolatilityStateSpaceResponse {
  readonly gameId?: string | null;
  readonly generatedAt: string;
  readonly observations: readonly VolatilityStateSpaceResultObservation[];
}

type FetchLike = typeof fetch;

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function resolveSidecarBaseUrl(explicitBaseUrl?: string): string {
  const baseUrl = explicitBaseUrl ?? process.env["NBA_SIDECAR_BASE_URL"];
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new Error("NBA_SIDECAR_BASE_URL is not configured.");
  }
  return trimTrailingSlash(baseUrl);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResponse(json: unknown): VolatilityStateSpaceResponse {
  if (!isRecord(json)) throw new Error("volatility sidecar response is not an object");
  const data = json["data"];
  if (!isRecord(data)) throw new Error("volatility sidecar response missing data object");
  const generatedAt = data["generatedAt"];
  const observations = data["observations"];
  if (typeof generatedAt !== "string") {
    throw new Error("volatility sidecar response missing generatedAt");
  }
  if (!Array.isArray(observations)) {
    throw new Error("volatility sidecar response missing observations array");
  }
  const gameId = data["gameId"];
  return {
    ...(typeof gameId === "string" ? { gameId } : {}),
    generatedAt,
    observations: observations.map((entry) => {
      if (!isRecord(entry)) {
        throw new Error("volatility sidecar observation is not an object");
      }
      const bucketStart = entry["bucketStart"];
      const bucketEnd = entry["bucketEnd"];
      const baselineMedian = entry["baselineMedian"];
      const baselineMad = entry["baselineMad"];
      const threshold = entry["threshold"];
      const standardizedInnovation = entry["standardizedInnovation"];
      const regimeScore = entry["regimeScore"];
      const warmedUp = entry["warmedUp"];
      const fired = entry["fired"];
      if (
        typeof bucketStart !== "string" ||
        typeof bucketEnd !== "string" ||
        typeof baselineMedian !== "number" ||
        typeof baselineMad !== "number" ||
        typeof threshold !== "number" ||
        typeof standardizedInnovation !== "number" ||
        typeof regimeScore !== "number" ||
        typeof warmedUp !== "boolean" ||
        typeof fired !== "boolean"
      ) {
        throw new Error("volatility sidecar observation is missing required fields");
      }
      return {
        baselineMad,
        baselineMedian,
        bucketEnd,
        bucketStart,
        fired,
        regimeScore,
        standardizedInnovation,
        threshold,
        warmedUp,
      };
    }),
  };
}

export async function fetchBoardVolatilityStateSpace(options: {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly request: VolatilityStateSpaceRequest;
}): Promise<VolatilityStateSpaceResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = resolveSidecarBaseUrl(options.baseUrl);
  const response = await fetchImpl(`${baseUrl}/api/v1/models/board-volatility/state-space`, {
    body: JSON.stringify(options.request),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `Board volatility sidecar request failed with status ${String(response.status)}.`,
    );
  }
  return parseResponse(await response.json());
}

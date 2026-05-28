import type {
  VolatilityStateSpaceRequest,
  VolatilityStateSpaceResponse,
} from "@signal-console/detectors/board-mad/state-space-runtime";
import { vi } from "vitest";

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) {
    return ordered[middle] ?? 0;
  }
  return ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}

function mad(values: number[]) {
  if (values.length === 0) return 0;
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

function scoreRequest(request: VolatilityStateSpaceRequest): VolatilityStateSpaceResponse {
  const observations = request.observations;
  const trailingBuckets = request.params.trailingBuckets;
  const warmupBuckets = request.params.warmupBuckets;
  const bucketSeconds = request.params.bucketSeconds;
  const enterThreshold = request.params.kMad;
  const exitThreshold = Math.max(0.75, request.params.kMad * 0.7);
  let inAlert = false;

  return {
    gameId: request.gameId,
    generatedAt: "2026-05-28T00:00:00.000Z",
    observations: observations.map((observation, index) => {
      const priorValues = observations
        .slice(Math.max(0, index - trailingBuckets), index)
        .map((entry) => entry.intensity);
      const baselineMedian = median(priorValues);
      const baselineMad = Math.max(mad(priorValues), 1e-9);
      const threshold = baselineMedian + enterThreshold * baselineMad;
      const warmedUp =
        observation.gameElapsedSeconds != null
          ? observation.gameElapsedSeconds >= warmupBuckets * bucketSeconds
          : index >= warmupBuckets;
      const standardizedInnovation = (observation.intensity - baselineMedian) / baselineMad;
      const positiveInnovation = Math.max(0, standardizedInnovation);
      const fired = Boolean(
        warmedUp && !inAlert && observation.intensity >= threshold && observation.intensity > 0,
      );
      if (fired) {
        inAlert = true;
      }
      if (inAlert && positiveInnovation <= exitThreshold) {
        inAlert = false;
      }
      return {
        baselineMad,
        baselineMedian,
        bucketEnd: observation.bucketEnd,
        bucketStart: observation.bucketStart,
        fired,
        regimeScore: clamp01(positiveInnovation / Math.max(enterThreshold, 1e-9)),
        standardizedInnovation,
        threshold,
        warmedUp,
      };
    }),
  };
}

export const fetchBoardVolatilityStateSpaceMock = vi.fn(
  async (options: { readonly request: VolatilityStateSpaceRequest }) =>
    scoreRequest(options.request),
);

vi.mock("@signal-console/detectors/board-mad/state-space-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("@signal-console/detectors/board-mad/state-space-runtime")
  >("@signal-console/detectors/board-mad/state-space-runtime");
  return {
    ...actual,
    fetchBoardVolatilityStateSpace: fetchBoardVolatilityStateSpaceMock,
  };
});

export function resetBoardVolatilitySidecarMock() {
  fetchBoardVolatilityStateSpaceMock.mockClear();
  fetchBoardVolatilityStateSpaceMock.mockImplementation(
    async (options: { readonly request: VolatilityStateSpaceRequest }) =>
      scoreRequest(options.request),
  );
}

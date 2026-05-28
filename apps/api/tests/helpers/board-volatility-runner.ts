import {
  detector as boardMad,
  type ParamsResolved as BoardMadParamsResolved,
} from "@signal-console/detectors/board-mad";
import type { DetectorResult, DetectorWindow } from "@signal-console/detectors";

import type { BoardVolatilityRunner } from "../../src/services/detector-runner";

function runTsBoardVolatility(
  window: DetectorWindow,
  params: BoardMadParamsResolved,
): DetectorResult {
  return boardMad.run(window, params);
}

export const tsBoardVolatilityRunner: BoardVolatilityRunner = async ({ window, params }) =>
  await Promise.resolve(runTsBoardVolatility(window, params));

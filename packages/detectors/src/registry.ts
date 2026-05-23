// Detector registry. PRD §10 / FR-24: adding a detector requires one new file at
// packages/detectors/src/<name>/index.ts and one new line in this file.
//
// Wired in US-026 (the Settings UI's About section is the first consumer that
// surfaces what's registered). off-price-print is added by US-027.
//
// The registry stores a metadata-only projection (id, version, displayName,
// paramsSchema). Callers that need to dispatch run() should import the concrete
// detector module directly (e.g. apps/api/src/services/board.ts imports from
// "@signal-console/detectors/board-mad"). Storing the full Detector<TParams>
// in a `Map<string, Detector<z.ZodTypeAny>>` runs into TS variance: the per-
// detector Params type is invariantly inferred from the concrete schema, so a
// `Detector<typeof Params>` is not assignable to `Detector<z.ZodTypeAny>`
// without an `as` cast (forbidden by eslint). The metadata projection avoids
// the variance because the schema slot is `z.ZodTypeAny` and there's no `run`
// to drag the TParams type around.

import type { z } from "zod";

import { detector as boardMad } from "./board-mad";
import type { Detector } from "./types";

export interface RegisteredDetector {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly paramsSchema: z.ZodTypeAny;
}

function meta<T extends z.ZodTypeAny>(d: Detector<T>): RegisteredDetector {
  return {
    id: d.id,
    version: d.version,
    displayName: d.displayName,
    paramsSchema: d.paramsSchema,
  };
}

export type DetectorRegistry = ReadonlyMap<string, RegisteredDetector>;

export const registry: DetectorRegistry = new Map<string, RegisteredDetector>([
  [boardMad.id, meta(boardMad)],
]);

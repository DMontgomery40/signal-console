// Detector registry. PRD §10 / FR-24: adding a detector requires one new file at
// packages/detectors/src/<name>/index.ts and one new line in this file.
//
// Initial map is empty; board-mad lands in US-009 and off-price-print in US-027.

import type { z } from "zod";
import type { Detector } from "./types";

// Map keyed by detector id. Detectors stored as Detector<z.ZodTypeAny> because each
// concrete detector specialises TParams differently (e.g. board-mad vs off-price-print
// have different params schemas) and a Record cannot hold a per-key existential.
// Consumers that need the params schema for one detector should narrow by id at the
// call site (registry.get("board-mad")?.paramsSchema) and validate via Zod parse.
export type DetectorRegistry = ReadonlyMap<string, Detector<z.ZodTypeAny>>;

export const registry: DetectorRegistry = new Map<string, Detector<z.ZodTypeAny>>();

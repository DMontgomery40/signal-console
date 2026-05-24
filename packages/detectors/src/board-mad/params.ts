// board-mad Zod parameter schema. Extracted from index.ts so that sweep.ts
// can reference `Params` (for its `Omit<Params,'kMad'>` argument type) without
// importing index.ts, which in turn imports sweep.ts.

import { z } from "zod";

import { K_MAD_LIVE } from "./config";

export const Params = z.object({
  bucketSeconds: z.number().int().min(10).max(300).default(60),
  kMad: z.number().min(1).max(12).default(K_MAD_LIVE),
  weighting: z.enum(["volume", "equal"]).default("volume"),
  trailingBuckets: z.number().int().min(5).max(60).default(20),
  warmupBuckets: z.number().int().min(2).max(20).default(8),
  freshCapSeconds: z.number().int().min(30).max(3600).default(300),
});

export type ParamsResolved = z.infer<typeof Params>;
export type Weighting = ParamsResolved["weighting"];

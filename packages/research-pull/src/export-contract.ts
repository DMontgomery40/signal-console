import { z } from "zod";

/**
 * Shared snapshot-EXPORT REQUEST contract.
 *
 * This is the single source of truth for POST /v1/research/export, mirroring the
 * pull contract's split: this zod schema validates SHAPE only (presence, types,
 * enums); cross-field rules with stable codes live in `./export-validator`.
 *
 * Unlike a pull (which ingests fresh provider data), an export reads the already
 * persisted gold corpus and runs scripts/export-quant-snapshot.ts. `scope: "full"`
 * is the full-corpus default of that script; `scope: "sample"` is the opt-in
 * incident-plus-sample path and requires a positive `sample` count.
 */

export const EXPORT_SCOPES = ["full", "sample"] as const;
export type ExportScope = (typeof EXPORT_SCOPES)[number];

/** ISO calendar date (YYYY-MM-DD), matching the exporter's --since/--until. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO calendar date (YYYY-MM-DD)");

const nonEmptyString = z.string().min(1, "must not be empty");

export const exportRequestSchema = z
  .object({
    snapshotId: nonEmptyString.optional(),
    scope: z.enum(EXPORT_SCOPES),
    sample: z.number().int().positive().optional(),
    since: isoDate.optional(),
    until: isoDate.optional(),
    gameIds: z.array(nonEmptyString).optional(),
  })
  .strict();

export type ExportRequest = z.infer<typeof exportRequestSchema>;

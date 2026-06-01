import { exportRequestSchema, type ExportRequest } from "./export-contract";

/**
 * VALIDATOR for snapshot-export requests. Mirrors the pull validator: returns a
 * discriminated result with LOUD, stable error codes (assert on `code`, not
 * message text). Pure — depends only on `input`.
 */

export const EXPORT_VALIDATION_CODES = [
  "schema_invalid",
  "sample_requires_count",
  "sample_count_without_scope",
  "date_range_inverted",
] as const;
export type ExportValidationCode = (typeof EXPORT_VALIDATION_CODES)[number];

export type ExportValidationError = {
  readonly code: ExportValidationCode;
  readonly message: string;
  readonly path?: string;
};

export type ExportValidationResult =
  | { readonly ok: true; readonly request: ExportRequest; readonly errors: readonly [] }
  | { readonly ok: false; readonly errors: readonly ExportValidationError[] };

/**
 * Validate a snapshot-export request. Returns coded errors. Pure.
 *
 * Cross-field rules:
 *  - scope "sample" requires a positive `sample` count.
 *  - a `sample` count without scope "sample" is rejected (no silent drop).
 *  - when both `since` and `until` are present, `since` must be <= `until`.
 */
export function validateExportRequest(input: unknown): ExportValidationResult {
  const parsed = exportRequestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        code: "schema_invalid" as const,
        message: issue.message,
        path: issue.path.join("."),
      })),
    };
  }

  const request = parsed.data;
  const errors: ExportValidationError[] = [];

  if (request.scope === "sample" && request.sample === undefined) {
    errors.push({
      code: "sample_requires_count",
      message: 'scope "sample" requires a positive `sample` count.',
      path: "sample",
    });
  }

  if (request.scope === "full" && request.sample !== undefined) {
    errors.push({
      code: "sample_count_without_scope",
      message: 'a `sample` count is only valid with scope "sample" (full corpus is the default).',
      path: "sample",
    });
  }

  if (request.since !== undefined && request.until !== undefined && request.since > request.until) {
    errors.push({
      code: "date_range_inverted",
      message: `since (${request.since}) must be <= until (${request.until}).`,
      path: "since",
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, request, errors: [] };
}

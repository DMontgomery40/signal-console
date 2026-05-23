// Local re-type of the zod-to-json-schema export.
//
// The upstream signature is `zodToJsonSchema(schema: ZodSchema<any>, ...)`. The
// embedded `any` trips this repo's @typescript-eslint/no-unsafe-argument rule
// at every call site even though `z.ZodTypeAny` (the registry's slot type) is
// structurally compatible. Declaring an augmentation here tightens the
// parameter to a Zod type expression we already use elsewhere, so callers can
// pass `RegisteredDetector.paramsSchema` without an unsafe-argument error.
//
// Declaration merging means this *adds* overloads alongside the upstream ones;
// TypeScript prefers the more specific overload, so callers get
// `Record<string, unknown>` back without further narrowing.

declare module "zod-to-json-schema" {
  import type { ZodTypeAny } from "zod";

  export interface ZodToJsonSchemaOptions {
    readonly $refStrategy?: "none" | "root" | "relative" | "seen";
    readonly target?: "jsonSchema7" | "jsonSchema2019-09" | "openApi3";
  }

  export function zodToJsonSchema(
    schema: ZodTypeAny,
    options?: ZodToJsonSchemaOptions | string,
  ): Record<string, unknown>;
}

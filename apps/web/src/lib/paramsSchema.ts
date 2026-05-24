// Narrow walker for the JSON Schema produced by zod-to-json-schema (the
// shape served by GET /v1/detectors). We only inspect the first level of
// `properties` and pull `type`, `enum`, `default`, `minimum`, `maximum` —
// the same surface DetectorsPage (US-032) was rendering. Lifted here so
// BacktestPage (US-035) can drive an editable variant of the same form.

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readString(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === "string" ? v : null;
}

function readNumber(rec: Record<string, unknown>, key: string): number | null {
  const v = rec[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function readBoolean(rec: Record<string, unknown>, key: string): boolean | null {
  const v = rec[key];
  return typeof v === "boolean" ? v : null;
}

function readStringArray(rec: Record<string, unknown>, key: string): readonly string[] | null {
  const v = rec[key];
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry !== "string") return null;
    out.push(entry);
  }
  return out;
}

export type PropKind =
  | { readonly kind: "number"; readonly integer: boolean }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "boolean" }
  | { readonly kind: "unknown" };

export interface ParsedProperty {
  readonly name: string;
  readonly description: string | null;
  readonly defaultValue: unknown;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly kind: PropKind;
}

export function parseProperty(name: string, raw: unknown): ParsedProperty {
  if (!isRecord(raw)) {
    return {
      name,
      description: null,
      defaultValue: undefined,
      minimum: null,
      maximum: null,
      kind: { kind: "unknown" },
    };
  }
  const type = readString(raw, "type");
  const description = readString(raw, "description");
  const minimum = readNumber(raw, "minimum");
  const maximum = readNumber(raw, "maximum");
  const defaultValue = raw["default"];
  const enumValues = readStringArray(raw, "enum");
  if (enumValues !== null && enumValues.length > 0) {
    return {
      name,
      description,
      defaultValue,
      minimum,
      maximum,
      kind: { kind: "enum", values: enumValues },
    };
  }
  if (type === "number" || type === "integer") {
    return {
      name,
      description,
      defaultValue,
      minimum,
      maximum,
      kind: { kind: "number", integer: type === "integer" },
    };
  }
  if (type === "boolean") {
    return { name, description, defaultValue, minimum, maximum, kind: { kind: "boolean" } };
  }
  return {
    name,
    description,
    defaultValue,
    minimum,
    maximum,
    kind: { kind: "unknown" },
  };
}

export function parseSchema(paramsSchema: Record<string, unknown>): readonly ParsedProperty[] {
  const props = paramsSchema["properties"];
  if (!isRecord(props)) return [];
  const out: ParsedProperty[] = [];
  for (const [name, raw] of Object.entries(props)) {
    out.push(parseProperty(name, raw));
  }
  return out;
}

// Seed an editable values object from defaults. Numbers preserve their
// numeric default; enums fall back to the first allowed value; booleans
// default to false; unknown kinds pass through whatever the schema says.
export function defaultValuesFor(
  props: readonly ParsedProperty[],
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const p of props) {
    if (p.kind.kind === "number") {
      out[p.name] = typeof p.defaultValue === "number" ? p.defaultValue : 0;
    } else if (p.kind.kind === "enum") {
      out[p.name] =
        typeof p.defaultValue === "string" && p.kind.values.includes(p.defaultValue)
          ? p.defaultValue
          : (p.kind.values[0] ?? "");
    } else if (p.kind.kind === "boolean") {
      out[p.name] = typeof p.defaultValue === "boolean" ? p.defaultValue : false;
    } else {
      out[p.name] = p.defaultValue;
    }
  }
  return out;
}

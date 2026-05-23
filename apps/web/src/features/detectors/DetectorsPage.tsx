// DetectorsPage — registry browser (US-032 / PRD §10 + §15).
//
// Lists every detector from useDetectors() and renders its paramsSchema as a
// read-only form so the desk can see exactly which knobs each detector exposes
// without spelunking the source. Inputs are visually present but `disabled`
// because nothing on this page is meant to mutate detector behavior; the live
// route uses K_MAD_LIVE and Backtest provides its own param controls.
//
// Per-property control mapping (read-only):
//   number / integer  -> <input type="number" disabled>
//   enum              -> <select disabled> with one <option> per enum value
//   boolean           -> a styled <input type="checkbox" disabled> switch
//
// US-046: each detector card's title AND each visible param name is wrapped in
// an ExplainerCard so the hover-card machinery is reachable for the registered
// explainer ids. ExplainerCard renders its children unchanged when no
// explainer matches, so wrapping is safe even for param names that don't have
// dedicated explainer entries.

import type { JSX } from "react";

import { ExplainerCard, explainers } from "@signal-console/ui";
import type { ExplainerId } from "@signal-console/ui";

import { ApiUnreachableBanner, isNetworkError } from "../../components/ApiUnreachableBanner";
import { QueryErrorBanner } from "../../components/QueryErrorBanner";
import { useDetectors, type DetectorEntry } from "../../data/queries";

// Per US-046, each detector card's title and each visible param name is
// wrapped in an ExplainerCard so the registered HoverCard fires on hover.
// ExplainerCard logs a dev-mode console warning when handed an unknown id;
// the guard below short-circuits to the bare children for param names that
// don't have a dedicated explainer entry (e.g. "weighting", "minVolumeShare").
const isExplainerId = (id: string): id is ExplainerId =>
  Object.prototype.hasOwnProperty.call(explainers, id);

function MaybeExplain({ id, children }: { id: string; children: JSX.Element }): JSX.Element {
  if (isExplainerId(id)) {
    return <ExplainerCard id={id}>{children}</ExplainerCard>;
  }
  return children;
}

// ── JSON-Schema narrowing helpers ──────────────────────────────────────────
//
// /v1/detectors ships paramsSchema as zod-to-json-schema output (inlined,
// $refStrategy: "none"). We don't need a full JSON-Schema interpreter — only
// type, enum, default, minimum, maximum on first-level properties.

function isRecord(v: unknown): v is Record<string, unknown> {
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

function readBoolean(rec: Record<string, unknown>, key: string): boolean | null {
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

type PropKind =
  | { readonly kind: "number"; readonly integer: boolean }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "boolean" }
  | { readonly kind: "unknown" };

interface ParsedProperty {
  readonly name: string;
  readonly description: string | null;
  readonly defaultValue: unknown;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly kind: PropKind;
}

function parseProperty(name: string, raw: unknown): ParsedProperty {
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
  // Enum first — enums frequently arrive as `{ type: "string", enum: [...] }`
  // and the readable control is the dropdown, not a free-text string field.
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

function parseSchema(paramsSchema: Record<string, unknown>): readonly ParsedProperty[] {
  const props = paramsSchema["properties"];
  if (!isRecord(props)) return [];
  const out: ParsedProperty[] = [];
  for (const [name, raw] of Object.entries(props)) {
    out.push(parseProperty(name, raw));
  }
  return out;
}

// ── Read-only controls ─────────────────────────────────────────────────────

const FIELD_LABEL_CLASS = "text-text-lo text-xs uppercase tracking-[0.08em] font-sans";
const FIELD_HINT_CLASS = "text-text-lo tabular font-mono text-xs";
const NUMBER_INPUT_CLASS =
  "w-32 border border-surface-2 bg-surface-1 px-2 py-1 text-sm font-mono text-text-hi tabular disabled:cursor-not-allowed disabled:opacity-100";
const SELECT_CLASS =
  "w-32 border border-surface-2 bg-surface-1 px-2 py-1 text-sm font-mono text-text-hi disabled:cursor-not-allowed disabled:opacity-100";

function numberDefault(prop: ParsedProperty): string {
  if (typeof prop.defaultValue === "number" && Number.isFinite(prop.defaultValue)) {
    return String(prop.defaultValue);
  }
  return "";
}

function stringDefault(prop: ParsedProperty): string {
  return typeof prop.defaultValue === "string" ? prop.defaultValue : "";
}

function rangeHint(prop: ParsedProperty): string | null {
  const parts: string[] = [];
  if (prop.minimum !== null) parts.push(`min ${String(prop.minimum)}`);
  if (prop.maximum !== null) parts.push(`max ${String(prop.maximum)}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

function NumberField({ prop }: { prop: ParsedProperty }): JSX.Element {
  const hint = rangeHint(prop);
  const step = prop.kind.kind === "number" && prop.kind.integer ? 1 : 0.1;
  return (
    <div className="flex flex-col gap-1">
      <input
        type="number"
        disabled
        readOnly
        value={numberDefault(prop)}
        step={step}
        {...(prop.minimum !== null ? { min: prop.minimum } : {})}
        {...(prop.maximum !== null ? { max: prop.maximum } : {})}
        className={NUMBER_INPUT_CLASS}
        data-testid={`param-input-${prop.name}`}
        data-param-kind="number"
        aria-label={prop.name}
      />
      {hint !== null ? <span className={FIELD_HINT_CLASS}>{hint}</span> : null}
    </div>
  );
}

function EnumField({
  prop,
  values,
}: {
  prop: ParsedProperty;
  values: readonly string[];
}): JSX.Element {
  const selected = stringDefault(prop) || (values[0] ?? "");
  return (
    <select
      disabled
      value={selected}
      onChange={() => undefined}
      className={SELECT_CLASS}
      data-testid={`param-input-${prop.name}`}
      data-param-kind="enum"
      aria-label={prop.name}
    >
      {values.map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
    </select>
  );
}

function BooleanField({ prop }: { prop: ParsedProperty }): JSX.Element {
  const checked = readBooleanDefault(prop);
  return (
    <span
      role="switch"
      aria-checked={checked}
      aria-disabled={true}
      data-testid={`param-input-${prop.name}`}
      data-param-kind="boolean"
      className="inline-flex items-center"
    >
      <input
        type="checkbox"
        disabled
        readOnly
        checked={checked}
        onChange={() => undefined}
        className="accent-accent-green disabled:cursor-not-allowed"
        aria-label={prop.name}
      />
    </span>
  );
}

function readBooleanDefault(prop: ParsedProperty): boolean {
  return readBoolean({ default: prop.defaultValue }, "default") ?? false;
}

function UnknownField({ prop }: { prop: ParsedProperty }): JSX.Element {
  const raw =
    typeof prop.defaultValue === "string" || typeof prop.defaultValue === "number"
      ? String(prop.defaultValue)
      : "—";
  return (
    <span
      data-testid={`param-input-${prop.name}`}
      data-param-kind="unknown"
      className="tabular font-mono text-sm text-text-md"
    >
      {raw}
    </span>
  );
}

function ParamRow({
  detectorId,
  prop,
}: {
  readonly detectorId: string;
  readonly prop: ParsedProperty;
}): JSX.Element {
  const labelEl = <span className="tabular font-mono text-sm text-text-hi">{prop.name}</span>;
  let control: JSX.Element;
  switch (prop.kind.kind) {
    case "number":
      control = <NumberField prop={prop} />;
      break;
    case "enum":
      control = <EnumField prop={prop} values={prop.kind.values} />;
      break;
    case "boolean":
      control = <BooleanField prop={prop} />;
      break;
    case "unknown":
      control = <UnknownField prop={prop} />;
      break;
  }
  // `display: contents` removes the row wrapper from layout so the label and
  // control become direct children of the parent grid. That keeps the
  // accessible row container (data-testid, data-detector-id, data-param-name
  // for tests) while letting the parent's [max-content_1fr] grid align
  // every label / control column across all rows.
  return (
    <div
      data-testid="detector-param-row"
      data-detector-id={detectorId}
      data-param-name={prop.name}
      className="contents"
    >
      <span className={`${FIELD_LABEL_CLASS} self-start py-2`}>
        <MaybeExplain id={prop.name}>{labelEl}</MaybeExplain>
      </span>
      <div className="py-2">{control}</div>
    </div>
  );
}

// US-048: render the SOURCES chip for every detector card using the closed
// set the detector declares in its registry entry. Off-price-print drops the
// redundant "ONLY" (single-source is implied by the one-element list).
function formatSources(sources: readonly DetectorEntry["sources"][number][]): string {
  return sources.map((s) => s.toUpperCase()).join(", ");
}

function DetectorCard({ detector }: { detector: DetectorEntry }): JSX.Element {
  const props = parseSchema(detector.paramsSchema);
  return (
    <article
      data-testid="detector-card"
      data-detector-id={detector.id}
      className="border-t border-surface-1 pt-6"
    >
      <header className="flex items-baseline justify-between gap-4">
        <h3 className="text-text-hi text-base font-semibold">
          <MaybeExplain id={detector.id}>
            <span>{detector.displayName}</span>
          </MaybeExplain>
        </h3>
        <span data-testid="detector-version" className="tabular font-mono text-xs text-text-lo">
          v{detector.version}
        </span>
      </header>
      <p className="mt-1 tabular font-mono text-xs text-text-lo">{detector.id}</p>
      {detector.sources.length > 0 ? (
        <p
          data-testid="detector-sources-tag"
          className="mt-3 inline-block border border-accent-yellow px-2 py-0.5 text-xs font-mono uppercase tracking-wider text-accent-yellow"
        >
          SOURCES: {formatSources(detector.sources)}
        </p>
      ) : null}
      {props.length === 0 ? (
        <p className="mt-4 text-sm text-text-md">No tunable parameters.</p>
      ) : (
        <div className="mt-4 grid grid-cols-[max-content_1fr] gap-x-8">
          {props.map((p) => (
            <ParamRow key={p.name} detectorId={detector.id} prop={p} />
          ))}
        </div>
      )}
    </article>
  );
}

function HowToAddPanel(): JSX.Element {
  return (
    <aside
      data-testid="how-to-add-detector"
      className="mt-12 border-l-2 border-accent-green bg-surface-1 px-5 py-4"
    >
      <h3 className="text-text-hi text-base font-semibold">How to add a detector</h3>
      <ol className="mt-3 space-y-2 text-sm text-text-md">
        <li className="grid grid-cols-[1.25rem_1fr] gap-x-2">
          <span className="tabular font-mono text-accent-green">1.</span>
          <span>
            Create{" "}
            <code className="font-mono text-text-hi">
              packages/detectors/src/&lt;name&gt;/index.ts
            </code>{" "}
            exporting{" "}
            <code className="font-mono text-text-hi">detector: Detector&lt;typeof Params&gt;</code>.
          </span>
        </li>
        <li className="grid grid-cols-[1.25rem_1fr] gap-x-2">
          <span className="tabular font-mono text-accent-green">2.</span>
          <span>
            Add one line to{" "}
            <code className="font-mono text-text-hi">packages/detectors/src/registry.ts</code>{" "}
            registering the new detector.
          </span>
        </li>
        <li className="grid grid-cols-[1.25rem_1fr] gap-x-2">
          <span className="tabular font-mono text-accent-green">3.</span>
          <span>
            Run <code className="font-mono text-text-hi">pnpm verify</code> — typecheck, lint, and
            contract tests all gate the new detector.
          </span>
        </li>
      </ol>
    </aside>
  );
}

export function DetectorsPage(): JSX.Element {
  const detectors = useDetectors();
  const banner =
    detectors.isError && isNetworkError(detectors.error) ? (
      <ApiUnreachableBanner error={detectors.error} />
    ) : (
      <QueryErrorBanner query={detectors} label="Failed to load detectors" />
    );
  const rows = detectors.data?.detectors ?? [];
  return (
    <section data-testid="detectors-page">
      {banner}
      <div className="flex items-baseline justify-between">
        <h2 className="text-text-hi text-lg font-semibold">Detectors</h2>
        <p data-testid="detectors-meta" className="tabular font-mono text-xs text-text-lo">
          {detectors.isLoading
            ? "loading…"
            : detectors.isError
              ? "—"
              : `${String(rows.length)} registered`}
        </p>
      </div>
      <p className="mt-2 text-sm text-text-md">
        Detector registry · params are read-only here. Live route uses defaults; Backtest exposes
        per-run controls.
      </p>

      {detectors.isLoading ? (
        <p className="mt-6 text-text-md text-sm">Loading detectors…</p>
      ) : rows.length === 0 ? (
        detectors.isError ? null : (
          <p className="mt-6 text-text-md text-sm">No detectors registered.</p>
        )
      ) : (
        <div className="mt-6 space-y-2" data-testid="detector-list">
          {rows.map((d) => (
            <DetectorCard key={d.id} detector={d} />
          ))}
        </div>
      )}

      <HowToAddPanel />
    </section>
  );
}

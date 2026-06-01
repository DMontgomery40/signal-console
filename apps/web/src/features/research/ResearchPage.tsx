// ResearchPage — gold-DB-first research-lab artifact surface.
//
// Product truth: a 31GB golden SQLite DB already holds canonical Kalshi /
// Polymarket / Bet365 / NBA coverage (1256 games). Export reads that gold DB
// DIRECTLY — no pull is required to start modeling. Pull is ONLY to augment /
// repair (DraftKings / FanDuel via odds-api-io, or new date windows).
//
// Reads the quant-lab artifact tree via the read-only /v1/research/* API
// (queries.ts hooks: useResearchGold / Snapshot / Leaderboard / Models / Pulls
// / Sources). There are TWO writers:
//   - PRIMARY: the Export-snapshot dialog, ENABLED whenever the gold DB is
//     present, which POSTs /v1/research/export -> { jobId } (the worker runs the
//     existing scripts/export-quant-snapshot.ts against the gold DB).
//   - SECONDARY (demoted): the "Add/repair source data" dialog, which validates
//     the request CLIENT-SIDE with the SAME shared planner the server runs
//     (@signal-console/research-pull), shows a dry-run preview of where each
//     source would land (canonical / artifact-only / pending), and only then
//     enables "Submit job" (POST /v1/research/pull -> { job_id }).
//
// Design-language rules honored here: no bordered cards / no drop shadows
// (sections are whitespace-stacked over surface-1 fills + type hierarchy);
// no icons (readiness is the dot+label status pattern); every numeric is
// font-mono tabular-nums; colors only from packages/ui tokens. Yellow is the
// page's CTA/attention color (Pull data / Export / Open report, artifact-only
// readiness dot); green is structural (snapshot-eligible readiness, nav). The
// dialog reuses the canonical floating-surface treatment (surface-elevated +
// three-edge hairline + yellow left stripe, NO shadow) from ExplainerCard.
//
// Honest framing is a hard requirement: empty states render a one-line text-lo
// mono message + the relevant CTA and NEVER fabricate numbers; the leaderboard
// carries a "Research snapshot result, not live production behavior" header and
// the Odds-API.io source row says it is an event-snapshot/live artifact lane,
// not a historical warehouse.

import { useEffect, useMemo, useState, type JSX } from "react";

import { ExplainerCard, explainers } from "@signal-console/ui";
import type { ExplainerId } from "@signal-console/ui";
// Import from SUBPATHS, never the package root: the root index re-exports
// executor.ts, which pulls node:fs/node:zlib and breaks the browser bundle
// (`vite build`). The planner / capability-matrix / validator subpaths are
// pure, browser-safe leaves (this mirrors queries.ts importing
// @signal-console/detectors/board-mad/config the same way).
import {
  SOURCE_CAPABILITY_MATRIX,
  classToArtifactClass,
  getSourceCapability,
  type ArtifactClass,
} from "@signal-console/research-pull/capability-matrix";
import { ODDS_API_IO_MARKETS, ODDS_API_IO_SPINE } from "@signal-console/research-pull/validator";
import { planPullJob, type PullPlan } from "@signal-console/research-pull/planner";

import { ApiUnreachableBanner, isNetworkError } from "../../components/ApiUnreachableBanner";
import { QueryErrorBanner } from "../../components/QueryErrorBanner";
import {
  useResearchGold,
  useResearchAttribution,
  useResearchFarCalibration,
  useResearchHarvestedLabels,
  useResearchLeaderboard,
  useResearchModels,
  useResearchPulls,
  useResearchSnapshot,
  useResearchSources,
  useSubmitExport,
  useSubmitPull,
  type ResearchExportRequest,
  type ResearchGold,
  type ResearchSource,
} from "../../data/queries";

const isExplainerId = (id: string): id is ExplainerId =>
  Object.prototype.hasOwnProperty.call(explainers, id);

function Explain({ id, children }: { id: string; children: JSX.Element }): JSX.Element {
  if (isExplainerId(id)) {
    return <ExplainerCard id={id}>{children}</ExplainerCard>;
  }
  return children;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function pick(record: Record<string, unknown>, ...keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fmtNum(value: number | undefined, digits = 0): string {
  if (value === undefined) return "—";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
// Humanize a byte count to a stable, mono-friendly string. The gold DB is on
// the GB scale (≈31GB), so we render GB with one decimal; fall back to MB/KB/B
// for smaller sizes so the recap never reads "0.0 GB" for a tiny fixture.
function fmtBytes(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${fmtNum(bytes)} B`;
}

// snapshot-eligible -> green (canonical), artifact-only -> yellow (the task's
// sanctioned attention dot), pending -> text-lo. Readiness is dot+label, never
// an icon.
function sourceDotClass(klass: ResearchSource["class"]): string {
  if (klass === "snapshot-eligible") return "bg-accent-green";
  if (klass === "artifact-only") return "bg-accent-yellow";
  return "bg-text-lo";
}
// Gold-first readiness wording: snapshot-eligible sources are the canonical
// coverage ALREADY persisted in the gold DB; artifact-only sources land only as
// optional pull artifacts; pending sources require a pull to add.
function sourceReadinessLabel(klass: ResearchSource["class"]): string {
  if (klass === "snapshot-eligible") return "canonical · in gold DB";
  if (klass === "artifact-only") return "artifact-only";
  return "pull to add";
}
function pullStatusDotClass(status: string | undefined): string {
  if (status === undefined) return "bg-text-lo";
  const s = status.toLowerCase();
  if (s === "succeeded" || s === "complete" || s === "completed" || s === "ok") {
    return "bg-accent-green";
  }
  if (s === "failed" || s === "error") return "bg-negative";
  if (s === "running" || s === "queued" || s === "enqueued" || s === "pending") {
    return "bg-accent-yellow";
  }
  return "bg-text-lo";
}

const ODDS_API_IO_SOURCE_ID = "odds-api-io";

// Shared dot+label primitive. Numeric/id text uses font-mono tabular-nums; the
// dot is a structural status mark, not an icon.
function StatusDot({
  dotClass,
  label,
  testid,
}: {
  readonly dotClass: string;
  readonly label: string;
  readonly testid?: string;
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-xs" data-testid={testid}>
      <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${dotClass}`} />
      <span className="text-text-md">{label}</span>
    </span>
  );
}

function YellowButton({
  children,
  onClick,
  disabled,
  testid,
  type = "button",
}: {
  readonly children: JSX.Element | string;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly testid?: string;
  readonly type?: "button" | "submit";
}): JSX.Element {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      data-testid={testid}
      className="border border-accent-yellow px-3 py-1.5 text-xs font-mono uppercase tracking-wider text-text-hi transition-colors duration-fast ease-out hover:bg-accent-yellow hover:text-surface-0-from disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function GreenButton({
  children,
  onClick,
  disabled,
  testid,
}: {
  readonly children: JSX.Element | string;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly testid?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testid}
      className="border border-accent-green px-3 py-1.5 text-xs font-mono uppercase tracking-wider text-text-md transition-colors duration-fast ease-out hover:bg-accent-green hover:text-surface-0-from disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function SectionHeading({
  children,
  explainerId,
}: {
  readonly children: string;
  readonly explainerId?: string;
}): JSX.Element {
  const heading = <span>{children}</span>;
  return (
    <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-text-hi">
      {explainerId !== undefined ? <Explain id={explainerId}>{heading}</Explain> : heading}
    </h3>
  );
}

function EmptyLine({
  children,
  testid,
}: {
  readonly children: string;
  readonly testid?: string;
}): JSX.Element {
  return (
    <p className="font-mono text-xs text-text-lo" data-testid={testid}>
      {children}
    </p>
  );
}

// ── (0) Gold dataset status ─────────────────────────────────────────────────────
//
// First section after the header. Minimal design language: dot+label status,
// mono tabular numerics, no bordered cards. When present, "Golden DB ready"
// (accent-green dot) plus path / size / last modified / game count. When
// absent, a single honest text-lo line with NO fabricated numbers.
function GoldStatus({ gold }: { readonly gold: ResearchGold | undefined }): JSX.Element {
  return (
    <section data-testid="research-gold-status" className="space-y-3">
      <SectionHeading>Gold dataset status</SectionHeading>
      {gold === undefined ? (
        <EmptyLine testid="research-gold-loading">Loading gold DB status…</EmptyLine>
      ) : gold.present ? (
        <div className="bg-surface-1 px-5 py-4 space-y-3">
          <StatusDot
            dotClass="bg-accent-green"
            label="Golden DB ready"
            testid="research-gold-ready"
          />
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <div className="space-y-1 sm:col-span-2">
              <span className="font-mono text-xs text-text-lo">path</span>
              <p
                className="break-all font-mono text-sm text-text-hi"
                data-testid="research-gold-path"
              >
                {gold.path}
              </p>
            </div>
            <div className="space-y-1">
              <span className="font-mono text-xs text-text-lo">size</span>
              <p
                className="font-mono text-sm tabular-nums text-text-hi"
                data-testid="research-gold-size"
              >
                {fmtBytes(gold.sizeBytes)}
              </p>
            </div>
            <div className="space-y-1">
              <span className="font-mono text-xs text-text-lo">last modified</span>
              <p className="font-mono text-sm tabular-nums text-text-hi">
                {gold.lastModified.length > 0 ? gold.lastModified : "—"}
              </p>
            </div>
            <div className="space-y-1">
              <span className="font-mono text-xs text-text-lo">games</span>
              <p
                className="font-mono text-sm tabular-nums text-text-hi"
                data-testid="research-gold-game-count"
              >
                {gold.gameCount === null ? "—" : fmtNum(gold.gameCount)}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <EmptyLine testid="research-gold-absent">{`Gold DB not found at ${gold.path}`}</EmptyLine>
      )}
    </section>
  );
}

// ── (0b) Quant-guide panel ──────────────────────────────────────────────────────
//
// Compact orientation panel placed below the gold/snapshot status so the gold
// status is never pushed down. It keeps devs / traders / ops / researchers on
// the same artifacts and routes anyone who wants the full workflow to the
// durable guide. Two affordances, both reusing the page's minimal idioms:
//   - "Open Quant Guide": opens GET /v1/research/guide in a new tab — the API
//     serves docs/quant-researcher-guide.md (which lives outside the Vite web
//     root, so a static link to the path would fall through to the SPA shell).
//     The source file path is shown alongside so the link stays honest.
//   - "Copy CLI quickstart" (GreenButton): copies a short, RUNNABLE quickstart
//     (export -> resolve newest snapshot -> compare with the required --snapshot
//     flag). No bordered card, no icons — same surface-1 fill as GoldStatus.

const QUANT_GUIDE_PATH = "docs/quant-researcher-guide.md";
const QUANT_GUIDE_HREF = "/v1/research/guide";
// `ls` yields a bare dir name; --snapshot needs the path the CLI opens (pnpm quant
// runs from the repo root), so SNAP must include the snapshots dir, not just the id.
const QUANT_SNAPSHOTS_DIR = "outputs/nba-quant-lab/snapshots";
const QUANT_CLI_QUICKSTART = [
  "pnpm quant:export",
  `SNAP="${QUANT_SNAPSHOTS_DIR}/$(ls -t ${QUANT_SNAPSHOTS_DIR} | head -1)"`,
  'pnpm quant compare robust_mad state_space_current --snapshot "$SNAP"',
].join("\n");

function QuantGuidePanel(): JSX.Element {
  function onCopy(): void {
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (clip !== undefined) {
      void clip.writeText(QUANT_CLI_QUICKSTART);
    }
  }
  return (
    <section data-testid="research-quant-guide" className="space-y-3">
      <SectionHeading>Quant guide</SectionHeading>
      <div className="space-y-3 bg-surface-1 px-5 py-4">
        <p className="max-w-[80ch] text-sm text-text-md">
          This page keeps devs, traders, ops, and researchers looking at the same artifacts. If you
          want the full data/model workflow, open the quant guide.
        </p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <a
            href={QUANT_GUIDE_HREF}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="research-quant-guide-open"
            className="text-sm font-medium text-accent-green transition-colors duration-fast ease-out hover:text-text-hi"
          >
            Open Quant Guide
          </a>
          <span className="break-all font-mono text-xs text-text-lo">
            source: {QUANT_GUIDE_PATH}
          </span>
          <GreenButton onClick={onCopy} testid="research-quant-guide-copy">
            Copy CLI quickstart
          </GreenButton>
        </div>
      </div>
    </section>
  );
}

// ── (1) Header strip ──────────────────────────────────────────────────────────

function HeaderStrip({
  snapshotId,
  latestPullStatus,
  leaderboardTimestamp,
  goldPresent,
  hasSnapshot,
  hasReport,
  onExport,
  onPull,
}: {
  readonly snapshotId: string | undefined;
  readonly latestPullStatus: string | undefined;
  readonly leaderboardTimestamp: string | undefined;
  readonly goldPresent: boolean;
  readonly hasSnapshot: boolean;
  readonly hasReport: boolean;
  readonly onExport: () => void;
  readonly onPull: () => void;
}): JSX.Element {
  // Empty-state header copy is gold-aware: with a ready gold DB we NEVER imply
  // we have no data — we prompt the next honest step (export). The "no
  // artifacts" framing only appears when the gold DB itself is absent.
  const emptyLine = !hasSnapshot ? (
    goldPresent ? (
      <p className="font-mono text-xs text-accent-yellow" data-testid="research-empty-prompt">
        Golden DB ready. Export a reproducible snapshot to start modeling.
      </p>
    ) : (
      <p className="font-mono text-xs text-accent-yellow" data-testid="research-no-artifacts">
        No research artifacts yet — the gold DB is not present, so sources and models below are the
        static capability registry, not a completed run.
      </p>
    )
  ) : null;
  return (
    <section data-testid="research-header" className="bg-surface-1 px-5 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-text-hi">Research</h2>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className="font-mono text-xs text-text-lo">
              latest snapshot{" "}
              <span className="tabular-nums text-text-hi" data-testid="research-latest-snapshot-id">
                {snapshotId ?? "none"}
              </span>
            </span>
            <StatusDot
              dotClass={pullStatusDotClass(latestPullStatus)}
              label={`latest pull ${latestPullStatus ?? "none"}`}
              testid="research-latest-pull-status"
            />
            <span className="font-mono text-xs text-text-lo">
              latest leaderboard{" "}
              <span
                className="tabular-nums text-text-hi"
                data-testid="research-latest-leaderboard-ts"
              >
                {leaderboardTimestamp ?? "none"}
              </span>
            </span>
          </div>
          {emptyLine}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* PRIMARY CTA: export reads the gold DB directly, so it is enabled
              whenever the gold DB is present — NOT gated on an existing snapshot. */}
          <YellowButton onClick={onExport} disabled={!goldPresent} testid="research-cta-export">
            Export snapshot
          </YellowButton>
          {/* DEMOTED to secondary (green): pull only augments/repairs sources the
              gold DB doesn't carry, or new date windows. Same testid as before so
              existing dialog-open tests keep working. */}
          <GreenButton onClick={onPull} testid="research-cta-pull">
            Add/repair source data
          </GreenButton>
          <GreenButton disabled={!hasReport} testid="research-cta-report">
            Open latest report
          </GreenButton>
        </div>
      </div>
    </section>
  );
}

// ── (2) Source coverage ────────────────────────────────────────────────────────

function SourceCoverage({ sources }: { readonly sources: readonly ResearchSource[] }): JSX.Element {
  return (
    <section data-testid="research-source-coverage" className="space-y-3">
      <SectionHeading explainerId="canonical-vs-artifact-only">Source coverage</SectionHeading>
      <div role="table" aria-label="Source coverage" className="bg-surface-1 text-sm">
        <div
          role="row"
          className="grid grid-cols-[1fr_1.1fr_1fr_1.6fr] gap-x-6 px-5 pb-2 pt-4 font-mono text-xs uppercase tracking-[0.06em] text-text-lo"
        >
          <span role="columnheader">Source</span>
          <span role="columnheader">Readiness</span>
          <span role="columnheader">Capture modes</span>
          <span role="columnheader">Notes</span>
        </div>
        {sources.map((source) => {
          const isOddsApiIo = source.id === ODDS_API_IO_SOURCE_ID;
          const note = isOddsApiIo
            ? "event snapshot/live artifact lane — not a historical warehouse"
            : (source.limitations[0] ?? "—");
          return (
            <div
              key={source.id}
              role="row"
              data-testid="research-source-row"
              data-source-id={source.id}
              className="grid grid-cols-[1fr_1.1fr_1fr_1.6fr] items-baseline gap-x-6 px-5 py-3 transition-colors duration-fast ease-out hover:bg-surface-2"
            >
              <span role="cell" className="font-mono text-text-hi">
                {source.id}
              </span>
              <span role="cell">
                <StatusDot
                  dotClass={sourceDotClass(source.class)}
                  label={sourceReadinessLabel(source.class)}
                />
              </span>
              <span role="cell" className="font-mono text-xs tabular-nums text-text-md">
                {source.supportedModes.length > 0 ? source.supportedModes.join(", ") : "none"}
              </span>
              <span
                role="cell"
                className="text-xs text-text-md"
                data-testid={isOddsApiIo ? "research-odds-api-io-note" : undefined}
              >
                {note}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── (3) Pull-data dialog ────────────────────────────────────────────────────────

type CaptureMode = "historical" | "repair" | "live-capture";
type MarketScope = "all" | "board" | "player-props";
type OddsApiIoMode = "events-snapshot" | "updated-follow" | "live-ws";

function toCaptureMode(value: string): CaptureMode | undefined {
  return value === "historical" || value === "repair" || value === "live-capture"
    ? value
    : undefined;
}
function toMarketScope(value: string): MarketScope | undefined {
  return value === "all" || value === "board" || value === "player-props" ? value : undefined;
}

interface PullFormState {
  readonly sources: readonly string[];
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly gameIds: string;
  readonly captureMode: CaptureMode;
  readonly marketScope: MarketScope;
  // odds-api.io block
  readonly oddsMode: OddsApiIoMode;
  readonly useSelectedBookmakers: boolean;
  readonly bookmakers: readonly string[];
  readonly markets: readonly string[];
  readonly league: string;
  readonly eventIds: string;
  readonly sinceSecondsAgo: string;
}

const DEFAULT_PULL_FORM: PullFormState = {
  sources: ["kalshi"],
  dateFrom: "2026-05-01",
  dateTo: "2026-05-01",
  gameIds: "",
  captureMode: "historical",
  marketScope: "all",
  oddsMode: "events-snapshot",
  useSelectedBookmakers: false,
  bookmakers: ["Kalshi"],
  markets: [...ODDS_API_IO_MARKETS],
  league: "NBA",
  eventIds: "",
  sinceSecondsAgo: "30",
};

function splitList(value: string): readonly string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// Build the exact request body BOTH the client dry-run and the server validate.
// `nowSeconds` is injected so the updated-follow since-staleness rule is
// deterministic in tests.
function buildPullRequest(form: PullFormState, nowSeconds: number): Record<string, unknown> {
  const includesOddsApiIo = form.sources.includes(ODDS_API_IO_SOURCE_ID);
  const gameIds = splitList(form.gameIds);
  const body: Record<string, unknown> = {
    sources: [...form.sources],
    date_from: form.dateFrom,
    date_to: form.dateTo,
    capture_mode: form.captureMode,
    market_scope: form.marketScope,
    ...(gameIds.length > 0 ? { game_ids: gameIds } : {}),
  };
  if (includesOddsApiIo) {
    const eventIds = splitList(form.eventIds);
    const sinceAgo = Number.parseInt(form.sinceSecondsAgo, 10);
    const block: Record<string, unknown> = {
      bookmakers: [...form.bookmakers],
      markets: [...form.markets],
      mode: form.oddsMode,
      use_selected_bookmakers: form.useSelectedBookmakers,
    };
    // league ⊕ event_ids: send whatever the operator typed and let the shared
    // validator enforce the XOR. Under live-ws, supplying BOTH a league and
    // event_ids is rejected with code `live_ws_league_and_event_ids`, so the
    // dry-run surfaces the conflict instead of the form silently masking it.
    if (eventIds.length > 0) {
      block["event_ids"] = eventIds;
    }
    if (form.league.trim().length > 0) {
      block["league"] = form.league.trim();
    }
    if (form.oddsMode === "updated-follow" && Number.isFinite(sinceAgo)) {
      block["since"] = nowSeconds - sinceAgo;
    }
    body["odds_api_io"] = block;
  }
  return body;
}

function artifactClassLabel(klass: ArtifactClass): string {
  if (klass === "canonical") return "canonical";
  if (klass === "artifact_only") return "artifact-only";
  return "pending";
}

// Where each selected source WOULD land, computed directly from the shared
// capability matrix. This is validity-independent (unlike the planner, which
// only populates `sources` on a fully-valid request), so the preview can show
// the canonical / artifact-only / PENDING split even when a pending source
// (which supports no capture mode) makes the overall plan invalid.
function previewSourceClasses(
  sourceIds: readonly string[],
): readonly { readonly id: string; readonly artifactClass: ArtifactClass }[] {
  return sourceIds.map((id) => {
    const capability = getSourceCapability(id);
    return {
      id,
      // Unknown ids can't land anywhere; surface them as pending so the row is
      // never silently dropped (the planner still rejects them via the error list).
      artifactClass: capability === undefined ? "pending" : classToArtifactClass(capability.class),
    };
  });
}

function ChipToggle({
  label,
  active,
  onClick,
  testid,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly testid?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      data-active={active ? "true" : "false"}
      className={
        active
          ? "border border-accent-green bg-accent-green px-2 py-1 font-mono text-xs text-surface-0-from"
          : "border border-accent-green px-2 py-1 font-mono text-xs text-text-md transition-colors duration-fast ease-out hover:text-text-hi"
      }
    >
      {label}
    </button>
  );
}

function DialogField({
  label,
  children,
}: {
  readonly label: string;
  readonly children: JSX.Element;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1 font-mono text-xs text-text-lo">
      <span>{label}</span>
      {children}
    </label>
  );
}

const INPUT_CLASS =
  "border border-text-lo bg-surface-1 px-2 py-1.5 text-sm text-text-hi outline-none focus:border-accent-green";

function PullDialog({
  onClose,
  nowSeconds,
}: {
  readonly onClose: () => void;
  readonly nowSeconds: number;
}): JSX.Element {
  const [form, setForm] = useState<PullFormState>(DEFAULT_PULL_FORM);
  // The dry-run plan from the LAST validated run; Submit is gated on a fresh
  // OK plan for the CURRENT form, so editing after a dry-run re-locks Submit.
  const [plan, setPlan] = useState<PullPlan | null>(null);
  const [planForBody, setPlanForBody] = useState<string | null>(null);
  const submit = useSubmitPull();

  function update<K extends keyof PullFormState>(key: K, value: PullFormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const includesOddsApiIo = form.sources.includes(ODDS_API_IO_SOURCE_ID);
  const requestBody = useMemo(() => buildPullRequest(form, nowSeconds), [form, nowSeconds]);
  const currentBodyKey = JSON.stringify(requestBody);
  const dryRunFresh = planForBody === currentBodyKey && plan !== null;
  const dryRunValid = dryRunFresh && plan.ok;

  function toggleSource(id: string): void {
    setForm((prev) => {
      const has = prev.sources.includes(id);
      const next = has ? prev.sources.filter((s) => s !== id) : [...prev.sources, id];
      return { ...prev, sources: next };
    });
  }
  function toggleMarket(market: string): void {
    setForm((prev) => {
      const has = prev.markets.includes(market);
      const next = has ? prev.markets.filter((m) => m !== market) : [...prev.markets, market];
      return { ...prev, markets: next };
    });
  }

  function onDryRun(): void {
    const result = planPullJob(requestBody, { now: nowSeconds });
    setPlan(result);
    setPlanForBody(currentBodyKey);
  }

  function onSubmit(): void {
    if (!dryRunValid) return;
    submit.mutate(requestBody, {
      onSuccess: () => {
        onClose();
      },
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="research-pull-title"
      data-testid="research-pull-dialog"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-surface-0-from/80 px-4 py-10"
    >
      {/* Canonical floating-surface treatment: surface-elevated fill, 3px yellow
          left stripe, 1px text-lo/30 hairline on the other three edges, NO shadow. */}
      <div className="w-[min(680px,calc(100vw-32px))] border-l-[3px] border-l-accent-yellow border-t border-r border-b border-text-lo/30 bg-surface-elevated p-5">
        <div className="flex items-baseline justify-between gap-4">
          <h4 id="research-pull-title" className="text-base font-semibold text-text-hi">
            Pull data
          </h4>
          <button
            type="button"
            onClick={onClose}
            data-testid="research-pull-cancel"
            className="px-2 py-1 font-mono text-xs uppercase tracking-wider text-text-lo hover:text-text-hi"
          >
            Cancel
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <span className="font-mono text-xs text-text-lo">Sources</span>
            <div className="mt-1 flex flex-wrap gap-2">
              {SOURCE_CAPABILITY_MATRIX.map((source) => (
                <ChipToggle
                  key={source.id}
                  label={source.id}
                  active={form.sources.includes(source.id)}
                  onClick={() => {
                    toggleSource(source.id);
                  }}
                  testid={`research-pull-source-${source.id}`}
                />
              ))}
            </div>
          </div>

          <DialogField label="Date from">
            <input
              type="date"
              value={form.dateFrom}
              data-testid="research-pull-date-from"
              onChange={(e) => {
                update("dateFrom", e.target.value);
              }}
              className={INPUT_CLASS}
            />
          </DialogField>
          <DialogField label="Date to">
            <input
              type="date"
              value={form.dateTo}
              data-testid="research-pull-date-to"
              onChange={(e) => {
                update("dateTo", e.target.value);
              }}
              className={INPUT_CLASS}
            />
          </DialogField>

          <DialogField label="Game IDs (optional, space/comma separated)">
            <input
              value={form.gameIds}
              data-testid="research-pull-game-ids"
              placeholder="nba-0042500222"
              onChange={(e) => {
                update("gameIds", e.target.value);
              }}
              className={INPUT_CLASS}
            />
          </DialogField>
          <DialogField label="Capture mode">
            <select
              value={form.captureMode}
              data-testid="research-pull-capture-mode"
              onChange={(e) => {
                const mode = toCaptureMode(e.target.value);
                if (mode !== undefined) update("captureMode", mode);
              }}
              className={INPUT_CLASS}
            >
              <option value="historical">historical</option>
              <option value="repair">repair</option>
              <option value="live-capture">live-capture</option>
            </select>
          </DialogField>
          <DialogField label="Market scope">
            <select
              value={form.marketScope}
              data-testid="research-pull-market-scope"
              onChange={(e) => {
                const scope = toMarketScope(e.target.value);
                if (scope !== undefined) update("marketScope", scope);
              }}
              className={INPUT_CLASS}
            >
              <option value="all">all</option>
              <option value="board">board</option>
              <option value="player-props">player-props</option>
            </select>
          </DialogField>
        </div>

        {includesOddsApiIo ? (
          <div className="mt-4 space-y-3 bg-surface-1 p-4" data-testid="research-pull-odds-api-io">
            <p className="font-mono text-xs uppercase tracking-[0.08em] text-text-lo">
              Odds-API.io options
            </p>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <StatusDot
                dotClass="bg-accent-yellow"
                label="artifact-only — not persisted to gold"
                testid="research-pull-odds-bookmaker-status"
              />
              <label className="flex items-center gap-2 font-mono text-xs text-text-md">
                <input
                  type="checkbox"
                  checked={form.useSelectedBookmakers}
                  data-testid="research-pull-use-selected"
                  onChange={(e) => {
                    update("useSelectedBookmakers", e.target.checked);
                  }}
                />
                use selected bookmaker spine ({ODDS_API_IO_SPINE.join(", ")})
              </label>
            </div>

            {!form.useSelectedBookmakers ? (
              <div>
                <span className="font-mono text-xs text-text-lo">Bookmakers</span>
                <div className="mt-1 flex flex-wrap gap-2">
                  {ODDS_API_IO_SPINE.map((book) => (
                    <ChipToggle
                      key={book}
                      label={book}
                      active={form.bookmakers.includes(book)}
                      onClick={() => {
                        setForm((prev) => {
                          const has = prev.bookmakers.includes(book);
                          return {
                            ...prev,
                            bookmakers: has
                              ? prev.bookmakers.filter((b) => b !== book)
                              : [...prev.bookmakers, book],
                          };
                        });
                      }}
                      testid={`research-pull-book-${book}`}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            <div>
              <span className="font-mono text-xs text-text-lo">Mode</span>
              <div className="mt-1 flex flex-wrap gap-2">
                {(["events-snapshot", "updated-follow", "live-ws"] as const).map((mode) => (
                  <ChipToggle
                    key={mode}
                    label={mode}
                    active={form.oddsMode === mode}
                    onClick={() => {
                      update("oddsMode", mode);
                    }}
                    testid={`research-pull-mode-${mode}`}
                  />
                ))}
              </div>
            </div>

            <div>
              <span className="font-mono text-xs text-text-lo">Markets</span>
              <div className="mt-1 flex flex-wrap gap-2">
                {ODDS_API_IO_MARKETS.map((market) => (
                  <ChipToggle
                    key={market}
                    label={market}
                    active={form.markets.includes(market)}
                    onClick={() => {
                      toggleMarket(market);
                    }}
                    testid={`research-pull-market-${market}`}
                  />
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <DialogField label="League (⊕ event IDs)">
                <input
                  value={form.league}
                  data-testid="research-pull-league"
                  onChange={(e) => {
                    update("league", e.target.value);
                  }}
                  className={INPUT_CLASS}
                />
              </DialogField>
              <DialogField label="Event IDs (⊕ league)">
                <input
                  value={form.eventIds}
                  data-testid="research-pull-event-ids"
                  placeholder="evt-1 evt-2"
                  onChange={(e) => {
                    update("eventIds", e.target.value);
                  }}
                  className={INPUT_CLASS}
                />
              </DialogField>
              <DialogField label="updated-follow since (secs ago, ≤60)">
                <input
                  type="number"
                  value={form.sinceSecondsAgo}
                  data-testid="research-pull-since"
                  onChange={(e) => {
                    update("sinceSecondsAgo", e.target.value);
                  }}
                  className={INPUT_CLASS}
                />
              </DialogField>
            </div>
          </div>
        ) : null}

        {/* Dry-run preview: expected canonical / artifact-only / pending for
            every selected source, validity-independent so pending always shows.
            Errors (below) gate Submit; the preview is purely informational. */}
        {dryRunFresh ? (
          <div className="mt-4 bg-surface-1 p-4" data-testid="research-pull-preview">
            <p className="font-mono text-xs uppercase tracking-[0.08em] text-text-lo">
              Dry-run plan — where each source lands
            </p>
            <ul className="mt-2 space-y-1">
              {previewSourceClasses(form.sources).map((source) => (
                <li
                  key={source.id}
                  className="flex items-center justify-between gap-4 font-mono text-xs"
                  data-testid="research-pull-preview-row"
                  data-source-id={source.id}
                  data-artifact-class={source.artifactClass}
                >
                  <span className="text-text-hi">{source.id}</span>
                  <span className="text-text-md">{artifactClassLabel(source.artifactClass)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {dryRunFresh && !plan.ok ? (
          <div className="mt-4 bg-surface-1 p-4" data-testid="research-pull-errors">
            <p className="font-mono text-xs uppercase tracking-[0.08em] text-negative">
              Dry-run rejected
            </p>
            <ul className="mt-2 space-y-1">
              {plan.errors.map((err, i) => (
                <li
                  key={`${err.code}-${String(i)}`}
                  className="font-mono text-xs text-text-md"
                  data-testid="research-pull-error"
                  data-error-code={err.code}
                >
                  {err.code}: {err.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {submit.isError ? (
          <p
            className="mt-3 font-mono text-xs text-negative"
            data-testid="research-pull-submit-error"
          >
            {submit.error.message}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <GreenButton onClick={onDryRun} testid="research-pull-dry-run">
            Dry-run first
          </GreenButton>
          <YellowButton
            onClick={onSubmit}
            disabled={!dryRunValid || submit.isPending}
            testid="research-pull-submit"
          >
            Submit job
          </YellowButton>
          {!dryRunFresh ? (
            <span className="font-mono text-xs text-text-lo">Run a dry-run to enable submit.</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── (3b) Export-snapshot dialog ─────────────────────────────────────────────────
//
// PRIMARY writer. Reuses the canonical floating-surface treatment (surface-
// elevated + yellow left stripe + three-edge hairline, NO shadow) from the Pull
// dialog. Reads the gold DB directly — NO pull is needed because the canonical
// sources are already persisted. POSTs /v1/research/export -> { jobId } and
// shows the returned jobId; also surfaces the exact one-command CLI for CLI users.

interface ExportFormState {
  readonly scope: "full" | "sample";
  readonly sample: string;
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly gameIds: string;
  readonly snapshotId: string;
}

const DEFAULT_EXPORT_FORM: ExportFormState = {
  scope: "full",
  sample: "100",
  dateFrom: "",
  dateTo: "",
  gameIds: "",
  snapshotId: "",
};

function buildExportRequest(form: ExportFormState): ResearchExportRequest {
  const gameIds = splitList(form.gameIds);
  const sample = Number.parseInt(form.sample, 10);
  return {
    scope: form.scope,
    ...(form.scope === "sample" && Number.isFinite(sample) && sample > 0 ? { sample } : {}),
    ...(form.snapshotId.trim().length > 0 ? { snapshotId: form.snapshotId.trim() } : {}),
    ...(form.dateFrom.length > 0 ? { since: form.dateFrom } : {}),
    ...(form.dateTo.length > 0 ? { until: form.dateTo } : {}),
    ...(gameIds.length > 0 ? { gameIds } : {}),
  };
}

function ExportDialog({
  gold,
  onClose,
  onExportEnqueued,
}: {
  readonly gold: ResearchGold | undefined;
  readonly onClose: () => void;
  // Fired once the export job is enqueued so the page can poll
  // /v1/research/snapshot/latest until the worker lands the snapshot.
  readonly onExportEnqueued: () => void;
}): JSX.Element {
  const [form, setForm] = useState<ExportFormState>(DEFAULT_EXPORT_FORM);
  const submit = useSubmitExport();

  function update<K extends keyof ExportFormState>(key: K, value: ExportFormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function onSubmit(): void {
    submit.mutate(buildExportRequest(form), {
      onSuccess: () => {
        onExportEnqueued();
      },
    });
  }

  const jobId = submit.data?.jobId;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="research-export-title"
      data-testid="research-export-dialog"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-surface-0-from/80 px-4 py-10"
    >
      <div className="w-[min(680px,calc(100vw-32px))] border-l-[3px] border-l-accent-yellow border-t border-r border-b border-text-lo/30 bg-surface-elevated p-5">
        <div className="flex items-baseline justify-between gap-4">
          <h4 id="research-export-title" className="text-base font-semibold text-text-hi">
            Export snapshot
          </h4>
          <button
            type="button"
            onClick={onClose}
            data-testid="research-export-cancel"
            className="px-2 py-1 font-mono text-xs uppercase tracking-wider text-text-lo hover:text-text-hi"
          >
            Cancel
          </button>
        </div>

        {/* Gold status recap — the export reads THIS DB directly. */}
        <div className="mt-4 bg-surface-1 p-4">
          {gold !== undefined && gold.present ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <StatusDot dotClass="bg-accent-green" label="Golden DB ready" />
              <span className="break-all font-mono text-xs text-text-md">{gold.path}</span>
              <span className="font-mono text-xs tabular-nums text-text-md">
                {fmtBytes(gold.sizeBytes)}
              </span>
              <span className="font-mono text-xs tabular-nums text-text-md">
                {gold.gameCount === null ? "—" : `${fmtNum(gold.gameCount)} games`}
              </span>
            </div>
          ) : (
            <StatusDot dotClass="bg-text-lo" label="Gold DB not present" />
          )}
        </div>

        <div className="mt-4 space-y-4">
          <div>
            <span className="font-mono text-xs text-text-lo">Scope</span>
            <div className="mt-1 flex flex-wrap gap-2">
              <ChipToggle
                label="Full corpus"
                active={form.scope === "full"}
                onClick={() => {
                  update("scope", "full");
                }}
                testid="research-export-scope-full"
              />
              <ChipToggle
                label="Sample"
                active={form.scope === "sample"}
                onClick={() => {
                  update("scope", "sample");
                }}
                testid="research-export-scope-sample"
              />
            </div>
          </div>

          {form.scope === "sample" ? (
            <DialogField label="Sample size (games)">
              <input
                type="number"
                value={form.sample}
                data-testid="research-export-sample"
                onChange={(e) => {
                  update("sample", e.target.value);
                }}
                className={INPUT_CLASS}
              />
            </DialogField>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <DialogField label="Since (optional, YYYY-MM-DD)">
              <input
                type="date"
                value={form.dateFrom}
                data-testid="research-export-since"
                onChange={(e) => {
                  update("dateFrom", e.target.value);
                }}
                className={INPUT_CLASS}
              />
            </DialogField>
            <DialogField label="Until (optional, YYYY-MM-DD)">
              <input
                type="date"
                value={form.dateTo}
                data-testid="research-export-until"
                onChange={(e) => {
                  update("dateTo", e.target.value);
                }}
                className={INPUT_CLASS}
              />
            </DialogField>
          </div>

          <DialogField label="Game IDs (optional, space/comma separated)">
            <input
              value={form.gameIds}
              data-testid="research-export-game-ids"
              placeholder="nba-0042500222"
              onChange={(e) => {
                update("gameIds", e.target.value);
              }}
              className={INPUT_CLASS}
            />
          </DialogField>

          <DialogField label="Snapshot id (optional; the script picks one by default)">
            <input
              value={form.snapshotId}
              data-testid="research-export-snapshot-id"
              onChange={(e) => {
                update("snapshotId", e.target.value);
              }}
              className={INPUT_CLASS}
            />
          </DialogField>
        </div>

        {/* The exact one-command path for CLI users. */}
        <div className="mt-4 bg-surface-1 p-4">
          <p className="font-mono text-xs uppercase tracking-[0.08em] text-text-lo">
            CLI equivalent
          </p>
          <p className="mt-1 font-mono text-sm text-text-hi" data-testid="research-export-cli">
            pnpm quant:export
          </p>
        </div>

        {jobId !== undefined ? (
          <p className="mt-4 font-mono text-xs text-text-md" data-testid="research-export-job">
            job <span className="tabular-nums text-text-hi">{jobId}</span> — exporting… this reads
            the gold DB and appears under Snapshot when done
          </p>
        ) : null}

        {submit.isError ? (
          <p
            className="mt-3 font-mono text-xs text-negative"
            data-testid="research-export-submit-error"
          >
            {submit.error.message}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <YellowButton
            onClick={onSubmit}
            disabled={submit.isPending || jobId !== undefined}
            testid="research-export-submit"
          >
            Export snapshot
          </YellowButton>
          {jobId !== undefined ? (
            <GreenButton onClick={onClose} testid="research-export-done">
              Close
            </GreenButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── (4) Pull jobs table ─────────────────────────────────────────────────────────

function PullJobsTable({
  pulls,
}: {
  readonly pulls: readonly Record<string, unknown>[];
}): JSX.Element {
  return (
    <section data-testid="research-pull-jobs" className="space-y-3">
      <SectionHeading>Pull jobs</SectionHeading>
      {pulls.length === 0 ? (
        <EmptyLine testid="research-pull-jobs-empty">
          No add/repair jobs yet — optional, for sources not in the gold DB (DraftKings, FanDuel,
          Odds-API.io) or new date windows.
        </EmptyLine>
      ) : (
        <div role="table" aria-label="Pull jobs" className="bg-surface-1 text-sm">
          <div
            role="row"
            className="grid grid-cols-[1.4fr_0.8fr_1fr_1fr] gap-x-6 px-5 pb-2 pt-4 font-mono text-xs uppercase tracking-[0.06em] text-text-lo"
          >
            <span role="columnheader">Job</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Sources</span>
            <span role="columnheader">Created</span>
          </div>
          {pulls.map((job, i) => {
            const id = str(pick(job, "jobId", "job_id", "id")) ?? `job-${String(i)}`;
            const status = str(pick(job, "state", "status"));
            const sources = pick(job, "sources");
            const sourcesLabel = Array.isArray(sources)
              ? sources.filter((s): s is string => typeof s === "string").join(", ")
              : "—";
            const createdAt = str(pick(job, "createdAt", "created_utc", "created_at")) ?? "—";
            return (
              <div
                key={id}
                role="row"
                data-testid="research-pull-job-row"
                data-job-id={id}
                className="grid grid-cols-[1.4fr_0.8fr_1fr_1fr] items-baseline gap-x-6 px-5 py-3 transition-colors duration-fast ease-out hover:bg-surface-2"
              >
                <span role="cell" className="truncate font-mono text-xs tabular-nums text-text-hi">
                  {id}
                </span>
                <span role="cell">
                  <StatusDot dotClass={pullStatusDotClass(status)} label={status ?? "unknown"} />
                </span>
                <span role="cell" className="font-mono text-xs text-text-md">
                  {sourcesLabel}
                </span>
                <span role="cell" className="font-mono text-xs tabular-nums text-text-md">
                  {createdAt}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── (5) Snapshot block ──────────────────────────────────────────────────────────

function SnapshotBlock({
  snapshot,
}: {
  readonly snapshot: Record<string, unknown> | null;
}): JSX.Element {
  if (snapshot === null) {
    return (
      <section data-testid="research-snapshot" className="space-y-3">
        <SectionHeading>Snapshot</SectionHeading>
        <EmptyLine testid="research-snapshot-empty">
          No snapshot exported yet from the gold DB. Export one to begin (no pull needed — the
          canonical sources are already persisted).
        </EmptyLine>
      </section>
    );
  }
  // The real export-quant-snapshot manifest nests counts/date-range/coverage;
  // read those first, then fall back to flat keys so simpler fixtures also work.
  const obj = (value: unknown): Record<string, unknown> | undefined =>
    isRecord(value) ? value : undefined;
  const counts = obj(pick(snapshot, "counts"));
  const dateRange = obj(pick(snapshot, "dateRange", "date_range"));
  const id = str(pick(snapshot, "id", "snapshotId", "snapshot_id"));
  const dateFrom =
    str(pick(snapshot, "dateFrom", "date_from")) ??
    (dateRange !== undefined ? str(pick(dateRange, "observedStart", "since", "from")) : undefined);
  const dateTo =
    str(pick(snapshot, "dateTo", "date_to")) ??
    (dateRange !== undefined ? str(pick(dateRange, "observedEnd", "until", "to")) : undefined);
  const games =
    num(pick(snapshot, "games", "gameCount", "game_count")) ??
    (counts !== undefined ? num(pick(counts, "games")) : undefined);
  const incidents =
    num(pick(snapshot, "incidents", "incidentCount", "incident_count")) ??
    (counts !== undefined ? num(pick(counts, "incidents")) : undefined);
  const scoreable =
    num(pick(snapshot, "scoreable", "scoreableCount", "scoreable_count")) ??
    (counts !== undefined ? num(pick(counts, "scoreWindows", "scoreable")) : undefined);
  const doctor = pick(snapshot, "doctor", "doctorSummary", "doctor_summary");
  const doctorText =
    str(doctor) ?? (isRecord(doctor) ? str(pick(doctor, "summary", "text", "status")) : undefined);
  // sourceCoverageSummary is an object like { canonical: 278 }; render its
  // entries. Fall back to an array shape ([{id, class}]) for older fixtures.
  const coverageSummary = obj(pick(snapshot, "sourceCoverageSummary"));
  const coverage = pick(snapshot, "sourceCoverage", "source_coverage");
  const files = pick(snapshot, "files");

  return (
    <section data-testid="research-snapshot" className="space-y-3">
      <SectionHeading>Snapshot</SectionHeading>
      <div className="bg-surface-1 px-5 py-4">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          <div className="space-y-1">
            <span className="font-mono text-xs text-text-lo">id</span>
            <p
              className="font-mono text-sm tabular-nums text-text-hi"
              data-testid="research-snapshot-id"
            >
              {id ?? "—"}
            </p>
          </div>
          <div className="space-y-1">
            <span className="font-mono text-xs text-text-lo">date range</span>
            <p className="font-mono text-sm tabular-nums text-text-hi">
              {dateFrom ?? "—"} → {dateTo ?? "—"}
            </p>
          </div>
          <div className="space-y-1">
            <span className="font-mono text-xs text-text-lo">games</span>
            <p className="font-mono text-sm tabular-nums text-text-hi">{fmtNum(games)}</p>
          </div>
          <div className="space-y-1">
            <span className="font-mono text-xs text-text-lo">incidents</span>
            <p className="font-mono text-sm tabular-nums text-text-hi">{fmtNum(incidents)}</p>
          </div>
          <div className="space-y-1">
            <span className="font-mono text-xs text-text-lo">scoreable</span>
            <p className="font-mono text-sm tabular-nums text-text-hi">{fmtNum(scoreable)}</p>
          </div>
        </div>
        {coverageSummary !== undefined && Object.keys(coverageSummary).length > 0 ? (
          <p
            className="mt-3 font-mono text-xs text-text-md"
            data-testid="research-snapshot-coverage"
          >
            source coverage:{" "}
            {Object.entries(coverageSummary)
              .map(([klass, count]) => `${klass}=${fmtNum(num(count))}`)
              .join(" · ")}
          </p>
        ) : Array.isArray(coverage) && coverage.length > 0 ? (
          <p
            className="mt-3 font-mono text-xs text-text-md"
            data-testid="research-snapshot-coverage"
          >
            source coverage:{" "}
            {coverage
              .map((entry) =>
                isRecord(entry)
                  ? `${str(pick(entry, "id")) ?? "?"}=${
                      str(pick(entry, "class", "artifactClass")) ?? "?"
                    }`
                  : String(entry),
              )
              .join(" · ")}
          </p>
        ) : null}
        {Array.isArray(files) && files.length > 0 ? (
          <p className="mt-3 font-mono text-xs text-text-md" data-testid="research-snapshot-files">
            files: {files.filter((f): f is string => typeof f === "string").join(" · ")}
          </p>
        ) : null}
        {doctorText !== undefined ? (
          <p
            className="mt-3 max-w-[80ch] text-sm text-text-md"
            data-testid="research-snapshot-doctor"
          >
            doctor: {doctorText}
          </p>
        ) : null}
      </div>
    </section>
  );
}

// ── (6) Model lab ───────────────────────────────────────────────────────────────

function ModelLab({
  models,
  hasSnapshot,
}: {
  readonly models: readonly { id: string; label: string; description: string; source: string }[];
  readonly hasSnapshot: boolean;
}): JSX.Element {
  // Run/score affordances are AVAILABLE only once a snapshot exists. With no
  // snapshot we show the export-first empty state (NOT a pull prompt): the gold
  // DB already holds the data, so the next step is Export snapshot.
  if (!hasSnapshot) {
    return (
      <section data-testid="research-model-lab" className="space-y-3">
        <SectionHeading>Model lab</SectionHeading>
        <EmptyLine testid="research-model-lab-empty">
          No snapshot exported yet from the gold DB. Export one to begin (no pull needed — the
          canonical sources are already persisted), then score these baseline models against it.
        </EmptyLine>
      </section>
    );
  }
  return (
    <section data-testid="research-model-lab" className="space-y-3">
      <SectionHeading>Model lab</SectionHeading>
      <p className="max-w-[80ch] text-xs text-text-md" data-testid="research-model-lab-note">
        These are baseline research models, not tuned production detectors. They exist so a snapshot
        can be scored repeatably; treat them as humble reference points, not the live suspend
        signal.
      </p>
      <div role="table" aria-label="Model lab" className="bg-surface-1 text-sm">
        <div
          role="row"
          className="grid grid-cols-[0.8fr_1fr_0.6fr_2fr] gap-x-6 px-5 pb-2 pt-4 font-mono text-xs uppercase tracking-[0.06em] text-text-lo"
        >
          <span role="columnheader">Model</span>
          <span role="columnheader">Label</span>
          <span role="columnheader">Source</span>
          <span role="columnheader">Role</span>
        </div>
        {models.map((model) => (
          <div
            key={model.id}
            role="row"
            data-testid="research-model-row"
            data-model-id={model.id}
            className="grid grid-cols-[0.8fr_1fr_0.6fr_2fr] items-baseline gap-x-6 px-5 py-3 transition-colors duration-fast ease-out hover:bg-surface-2"
          >
            <span role="cell" className="font-mono text-xs text-text-hi">
              {model.id}
            </span>
            <span role="cell" className="text-text-md">
              {model.label}
            </span>
            <span role="cell" className="font-mono text-xs text-text-lo">
              {model.source}
            </span>
            <span role="cell" className="text-xs text-text-md">
              {model.description}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── (7) Leaderboard ─────────────────────────────────────────────────────────────

function Leaderboard({
  runId,
  rows,
}: {
  readonly runId: string | null;
  readonly rows: readonly Record<string, unknown>[];
}): JSX.Element {
  return (
    <section data-testid="research-leaderboard" className="space-y-3">
      <SectionHeading>Leaderboard</SectionHeading>
      <p className="font-mono text-xs text-text-lo" data-testid="research-leaderboard-disclaimer">
        Research snapshot result, not live production behavior.
      </p>
      {rows.length === 0 ? (
        <EmptyLine testid="research-leaderboard-empty">
          No leaderboard yet — score a snapshot to populate this table.
        </EmptyLine>
      ) : (
        <div role="table" aria-label="Leaderboard" className="bg-surface-1 text-sm">
          <div
            role="row"
            className="grid grid-cols-[1fr_0.8fr_0.8fr_0.7fr_0.8fr_0.7fr_0.9fr] gap-x-5 px-5 pb-2 pt-4 font-mono text-xs uppercase tracking-[0.06em] text-text-lo"
          >
            <span role="columnheader">Model</span>
            <span role="columnheader">
              <Explain id="recall-fires-per-game">
                <span>Incident recall</span>
              </Explain>
            </span>
            <span role="columnheader">Caught/scoreable</span>
            <span role="columnheader">
              <Explain id="fires-per-game">
                <span>Fires/game</span>
              </Explain>
            </span>
            <span role="columnheader">
              <Explain id="tape-outlier">
                <span>Tape-outlier</span>
              </Explain>
            </span>
            <span role="columnheader">Burden</span>
            <span role="columnheader">
              <Explain id="residual-coverage">
                <span>Residual cov.</span>
              </Explain>
            </span>
          </div>
          {rows.map((row, i) => {
            const model = str(pick(row, "model", "modelId", "id")) ?? `row-${String(i)}`;
            const recall = num(pick(row, "incidentRecall", "incident_recall", "recall"));
            const caught = num(pick(row, "caught", "incidentsCaught", "incidents_caught"));
            const scoreable = num(pick(row, "scoreable", "incidentsTotal", "incidents_total"));
            const firesPerGame = num(pick(row, "firesPerGame", "fires_per_game"));
            const tapeOutlier = num(
              pick(row, "tapeOutlier", "tapeOutlierRecall", "tape_outlier_recall", "tape_outlier"),
            );
            const burden = num(pick(row, "burden"));
            const residual = num(pick(row, "residualCoverage", "residual_coverage"));
            return (
              <div
                key={model}
                role="row"
                data-testid="research-leaderboard-row"
                data-model-id={model}
                className="grid grid-cols-[1fr_0.8fr_0.8fr_0.7fr_0.8fr_0.7fr_0.9fr] items-baseline gap-x-5 px-5 py-3 transition-colors duration-fast ease-out hover:bg-surface-2"
              >
                <span role="cell" className="font-mono text-xs text-text-hi">
                  {model}
                </span>
                <span role="cell" className="font-mono text-xs tabular-nums text-text-md">
                  {recall === undefined ? "—" : `${fmtNum(recall * 100, 1)}%`}
                </span>
                <span role="cell" className="font-mono text-xs tabular-nums text-text-md">
                  {caught === undefined || scoreable === undefined
                    ? "—"
                    : `${fmtNum(caught)} / ${fmtNum(scoreable)}`}
                </span>
                <span role="cell" className="font-mono text-xs tabular-nums text-text-md">
                  {fmtNum(firesPerGame, 1)}
                </span>
                <span role="cell" className="font-mono text-xs tabular-nums text-text-md">
                  {tapeOutlier === undefined ? "—" : `${fmtNum(tapeOutlier * 100, 1)}%`}
                </span>
                <span role="cell" className="font-mono text-xs tabular-nums text-text-md">
                  {fmtNum(burden)}
                </span>
                <span role="cell" className="font-mono text-xs tabular-nums text-text-md">
                  {residual === undefined ? "—" : `${fmtNum(residual * 100, 1)}%`}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {runId !== null ? (
        <p className="font-mono text-xs text-text-lo">
          run <span className="tabular-nums text-text-md">{runId}</span>
        </p>
      ) : null}
    </section>
  );
}

// ── (7b) Attribution re-ranker ────────────────────────────────────────────────

function AttributionReranker({
  attribution,
}: {
  readonly attribution: Record<string, unknown> | null;
}): JSX.Element {
  const strata: readonly { key: string; label: string }[] = [
    { key: "overall", label: "Overall" },
    { key: "player_swap", label: "Player swap" },
    { key: "team_dispute", label: "TEAM dispute" },
  ];
  const lineSelect = attribution !== null ? str(pick(attribution, "line_select")) : undefined;
  const nIncidents = attribution !== null ? num(pick(attribution, "n_incidents")) : undefined;
  return (
    <section data-testid="research-attribution" className="space-y-3">
      <SectionHeading>Attribution re-ranker</SectionHeading>
      <p className="max-w-[80ch] text-xs text-text-md" data-testid="research-attribution-note">
        Directed signed-paired prop drift over labeled incidents (the rightful player&apos;s over
        rises while the credited player&apos;s falls), stratified by candidate type. Research
        diagnostic, not the live suspend signal; &ldquo;score&rdquo; is unitless directed drift and
        abstentions are shown, never scored as misses.
      </p>
      {attribution === null ? (
        <EmptyLine testid="research-attribution-empty">
          No attribution report yet — run pnpm quant attribution-eval &lt;snapshot&gt; to populate
          this.
        </EmptyLine>
      ) : (
        <div role="table" aria-label="Attribution re-ranker" className="bg-surface-1 text-sm">
          <div
            role="row"
            className="grid grid-cols-[1.2fr_0.6fr_0.8fr_0.9fr_0.9fr] gap-x-5 px-5 pb-2 pt-4 font-mono text-xs uppercase tracking-[0.06em] text-text-lo"
          >
            <span role="columnheader">Stratum</span>
            <span role="columnheader">n</span>
            <span role="columnheader">Scored</span>
            <span role="columnheader">Abstention</span>
            <span role="columnheader">Median score</span>
          </div>
          {strata.map(({ key, label }) => {
            const s = pick(attribution, key);
            const rec = isRecord(s) ? s : {};
            const n = num(pick(rec, "n"));
            const scored = num(pick(rec, "n_scored"));
            const abst = num(pick(rec, "abstention_rate"));
            const med = num(pick(rec, "median_score"));
            return (
              <div
                key={key}
                role="row"
                data-testid="research-attribution-row"
                data-stratum={key}
                className="grid grid-cols-[1.2fr_0.6fr_0.8fr_0.9fr_0.9fr] items-baseline gap-x-5 px-5 py-3"
              >
                <span role="cell" className="text-text-md">
                  {label}
                </span>
                <span role="cell" className="font-mono text-xs tabular-nums text-text-md">
                  {fmtNum(n)}
                </span>
                <span role="cell" className="font-mono text-xs tabular-nums text-text-md">
                  {scored === undefined || n === undefined
                    ? "—"
                    : `${fmtNum(scored)} / ${fmtNum(n)}`}
                </span>
                <span role="cell" className="font-mono text-xs tabular-nums text-text-md">
                  {abst === undefined ? "—" : `${fmtNum(abst * 100, 0)}%`}
                </span>
                <span role="cell" className="font-mono text-xs tabular-nums text-text-md">
                  {med === undefined ? "—" : fmtNum(med, 3)}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {attribution !== null && (nIncidents !== undefined || lineSelect !== undefined) ? (
        <p className="font-mono text-xs text-text-lo" data-testid="research-attribution-meta">
          {nIncidents !== undefined ? `incidents ${fmtNum(nIncidents)}` : ""}
          {nIncidents !== undefined && lineSelect !== undefined ? " · " : ""}
          {lineSelect !== undefined ? `line-select ${lineSelect}` : ""}
        </p>
      ) : null}
    </section>
  );
}

function FarCalibration({
  farCalibration,
}: {
  readonly farCalibration: Record<string, unknown> | null;
}): JSX.Element {
  const thresholds = ["0.01", "0.02", "0.05", "0.1", "0.2"] as const;
  const fc = farCalibration ?? {};
  const acRaw = pick(fc, "all_control");
  const allControl = isRecord(acRaw) ? acRaw : {};
  const mrRaw = pick(fc, "matched_recall");
  const recall = isRecord(mrRaw) ? mrRaw : {};
  const dqRaw = pick(fc, "data_quality");
  const quality = isRecord(dqRaw) ? dqRaw : {};
  const ppRaw = pick(allControl, "per_pair_far");
  const perPair = isRecord(ppRaw) ? ppRaw : {};
  const prRaw = pick(allControl, "per_rebound_far");
  const perReb = isRecord(prRaw) ? prRaw : {};
  const tprRaw = pick(recall, "tpr_per_pair");
  const tpr = isRecord(tprRaw) ? tprRaw : {};
  const nControl = num(pick(fc, "n_control_games"));
  const nScoredInc = num(pick(recall, "n_scored"));
  const nInc = num(pick(recall, "n_incidents"));
  const badStarters = num(pick(quality, "games_bad_starters"));
  const ne5 = num(pick(quality, "rebounds_oncourt_ne5_frac"));
  const pct = (v: number | undefined): string => (v === undefined ? "—" : `${fmtNum(v * 100, 1)}%`);
  return (
    <section data-testid="research-far-calibration" className="space-y-3">
      <SectionHeading>Re-ranker FAR calibration</SectionHeading>
      <p className="max-w-[80ch] text-xs text-text-md" data-testid="research-far-calibration-note">
        False-alarm rate of the signed-paired re-ranker on non-incident control games (the score is
        not zero-centred, so a fire threshold must be read off this empirical distribution).
        Per-pair is one candidate; per-rebound is the max over a rebound&apos;s ~4 on-court
        teammates (the multiple-testing cost). Matched TPR runs the labeled incidents through the
        same candidate path — recall is label-starved, so read it with its N, never as a point
        estimate.
      </p>
      {farCalibration === null ? (
        <EmptyLine testid="research-far-calibration-empty">
          No FAR report yet — run pnpm quant far-calibration &lt;snapshot&gt; to populate this.
        </EmptyLine>
      ) : (
        <div role="table" aria-label="FAR calibration" className="bg-surface-1 text-sm">
          <div
            role="row"
            className="grid grid-cols-[0.8fr_1fr_1fr_1fr] gap-x-5 px-5 pb-2 pt-4 font-mono text-xs uppercase tracking-[0.06em] text-text-lo"
          >
            <span role="columnheader">Threshold</span>
            <span role="columnheader">FAR / pair</span>
            <span role="columnheader">FAR / rebound</span>
            <span role="columnheader">TPR (matched)</span>
          </div>
          {thresholds.map((th) => (
            <div
              key={th}
              role="row"
              data-testid="research-far-calibration-row"
              data-threshold={th}
              className="grid grid-cols-[0.8fr_1fr_1fr_1fr] items-baseline gap-x-5 px-5 py-2"
            >
              <span role="cell" className="font-mono text-xs tabular-nums text-text-md">
                {th}
              </span>
              <span role="cell" className="font-mono text-xs tabular-nums text-text-md">
                {pct(num(pick(perPair, th)))}
              </span>
              <span role="cell" className="font-mono text-xs tabular-nums text-text-md">
                {pct(num(pick(perReb, th)))}
              </span>
              <span role="cell" className="font-mono text-xs tabular-nums text-text-md">
                {pct(num(pick(tpr, th)))}
              </span>
            </div>
          ))}
        </div>
      )}
      {farCalibration !== null ? (
        <p className="font-mono text-xs text-text-lo" data-testid="research-far-calibration-meta">
          {nControl !== undefined ? `control games ${fmtNum(nControl)}` : ""}
          {nScoredInc !== undefined && nInc !== undefined
            ? ` · matched recall n ${fmtNum(nScoredInc)} / ${fmtNum(nInc)}`
            : ""}
          {badStarters !== undefined ? ` · bad-starter games ${fmtNum(badStarters)}` : ""}
          {ne5 !== undefined ? ` · on-court≠5 ${pct(ne5)}` : ""}
        </p>
      ) : null}
    </section>
  );
}

function HarvestedLabels({
  harvestedLabels,
}: {
  readonly harvestedLabels: Record<string, unknown> | null;
}): JSX.Element {
  const hl = harvestedLabels ?? {};
  const incidentsRaw = pick(hl, "incidents");
  const incidents = Array.isArray(incidentsRaw) ? incidentsRaw : [];
  const count = num(pick(hl, "incidentCount"));
  const scanned = num(pick(hl, "gamesScanned"));
  const generatedAt = str(pick(hl, "generatedAt"));
  return (
    <section data-testid="research-harvested-labels" className="space-y-3">
      <SectionHeading>Harvested miscredit labels</SectionHeading>
      <p className="max-w-[80ch] text-xs text-text-md" data-testid="research-harvested-labels-note">
        Credited&rarr;rightful corrections recovered by diffing the versioned PBP-revision shadow
        (NBA stat corrections are silent edits with no official feed, so the transition IS the
        label). This is the label engine that relieves the binding N constraint; it accrues over
        days as captures re-run, so an empty list here is expected early.
      </p>
      {harvestedLabels === null || incidents.length === 0 ? (
        <EmptyLine testid="research-harvested-labels-empty">
          {harvestedLabels === null
            ? "No harvest report yet — run scripts/harvest-incident-labels.ts to populate this."
            : `No corrections recovered yet (${scanned === undefined ? "0" : fmtNum(scanned)} games scanned). Labels accrue as capture-pbp-revisions.ts re-runs on a cadence.`}
        </EmptyLine>
      ) : (
        <div role="table" aria-label="Harvested miscredit labels" className="bg-surface-1 text-sm">
          <div
            role="row"
            className="grid grid-cols-[1fr_1fr_0.8fr] gap-x-5 px-5 pb-2 pt-4 font-mono text-xs uppercase tracking-[0.06em] text-text-lo"
          >
            <span role="columnheader">Credited</span>
            <span role="columnheader">Rightful</span>
            <span role="columnheader">Latency</span>
          </div>
          {incidents.map((inc, i) => {
            const rec = isRecord(inc) ? inc : {};
            const credited = str(pick(rec, "creditedPlayer"));
            const rightful = str(pick(rec, "rightfulPlayer"));
            const latency = num(pick(rec, "correctionLatencySec"));
            const id = str(pick(rec, "id"));
            return (
              <div
                key={id ?? String(i)}
                role="row"
                data-testid="research-harvested-labels-row"
                className="grid grid-cols-[1fr_1fr_0.8fr] items-baseline gap-x-5 px-5 py-2"
              >
                <span role="cell" className="text-text-md">
                  {credited ?? "—"}
                </span>
                <span role="cell" className="text-text-md">
                  {rightful ?? "—"}
                </span>
                <span role="cell" className="font-mono text-xs tabular-nums text-text-md">
                  {latency === undefined ? "—" : `${fmtNum(Math.round(latency / 60))}m`}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {harvestedLabels !== null ? (
        <p className="font-mono text-xs text-text-lo" data-testid="research-harvested-labels-meta">
          {count !== undefined ? `labels ${fmtNum(count)}` : ""}
          {scanned !== undefined ? ` · games scanned ${fmtNum(scanned)}` : ""}
          {generatedAt !== undefined ? ` · ${generatedAt}` : ""}
        </p>
      ) : null}
    </section>
  );
}

// ── (8) Casebook preview ──────────────────────────────────────────────────────

function CasebookPreview({ hasSnapshot }: { readonly hasSnapshot: boolean }): JSX.Element {
  return (
    <section data-testid="research-casebook" className="space-y-3">
      <SectionHeading>Casebook preview</SectionHeading>
      {!hasSnapshot ? (
        <EmptyLine testid="research-casebook-empty">
          No casebook yet — it is generated alongside a scored snapshot.
        </EmptyLine>
      ) : (
        <p className="max-w-[80ch] text-xs text-text-md" data-testid="research-casebook-body">
          The casebook walks each scored incident with its matched fires. Open the latest report for
          the full per-case writeup; the full Known Cases replay lives on the Known Cases tab.
        </p>
      )}
    </section>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function ResearchPage(): JSX.Element {
  const gold = useResearchGold();
  const sources = useResearchSources();
  const [pullDialogOpen, setPullDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  // After an export is enqueued, poll /v1/research/snapshot/latest until the
  // worker lands the snapshot (the dialog promises it "appears under Snapshot
  // when done"). Polling is off by default so the page stays one-shot otherwise.
  const [exportPolling, setExportPolling] = useState(false);
  const snapshot = useResearchSnapshot(exportPolling ? { refetchInterval: 5000 } : undefined);
  const leaderboard = useResearchLeaderboard();
  const models = useResearchModels();
  const pulls = useResearchPulls();
  const attribution = useResearchAttribution();
  const farCalibration = useResearchFarCalibration();
  const harvestedLabels = useResearchHarvestedLabels();

  const goldData = gold.data;
  const snapshotData = snapshot.data?.snapshot ?? null;
  const leaderboardRows = useMemo(() => leaderboard.data?.rows ?? [], [leaderboard.data?.rows]);
  const pullRows = useMemo(() => pulls.data?.pulls ?? [], [pulls.data?.pulls]);
  const sourceRows = useMemo(() => sources.data?.sources ?? [], [sources.data?.sources]);
  const modelRows = useMemo(() => models.data?.models ?? [], [models.data?.models]);
  const attributionData = attribution.data?.attribution ?? null;
  const farCalibrationData = farCalibration.data?.farCalibration ?? null;
  const harvestedLabelsData = harvestedLabels.data?.harvestedLabels ?? null;

  const hasSnapshot = snapshotData !== null;
  // Once the polled snapshot lands, stop the interval.
  useEffect(() => {
    if (hasSnapshot && exportPolling) setExportPolling(false);
  }, [hasSnapshot, exportPolling]);
  const goldPresent = goldData?.present === true;
  // "Open latest report" stays enabled only when a leaderboard/report exists.
  const hasReport = leaderboardRows.length > 0;

  const latestPullStatus = isRecord(pullRows[0])
    ? str(pick(pullRows[0], "state", "status"))
    : undefined;
  const snapshotId =
    snapshotData !== null ? str(pick(snapshotData, "id", "snapshotId", "snapshot_id")) : undefined;
  const leaderboardTimestamp =
    leaderboard.data?.runId !== null && leaderboard.data?.runId !== undefined
      ? leaderboard.data.runId
      : undefined;

  // Network-down banner takes precedence; otherwise surface the first hard error.
  // Include farCalibration + harvestedLabels so a failed /far-calibration or
  // /harvested-labels request surfaces as an operator error, not a silent
  // "No report yet" empty state (an ABSENT artifact returns null successfully and
  // is NOT an error, so this only banners real request failures).
  const queries = [
    gold,
    sources,
    snapshot,
    leaderboard,
    models,
    pulls,
    attribution,
    farCalibration,
    harvestedLabels,
  ];
  const networkErr = queries.find((q) => q.isError && isNetworkError(q.error));
  const hardErr = queries.find((q) => q.isError && !isNetworkError(q.error));
  const banner =
    networkErr !== undefined ? (
      <ApiUnreachableBanner error={networkErr.error} />
    ) : hardErr !== undefined ? (
      <QueryErrorBanner query={hardErr} label="Failed to load research artifacts" />
    ) : null;

  return (
    <div data-testid="research-page" className="space-y-12">
      {banner}
      <HeaderStrip
        snapshotId={snapshotId}
        latestPullStatus={latestPullStatus}
        leaderboardTimestamp={leaderboardTimestamp}
        goldPresent={goldPresent}
        hasSnapshot={hasSnapshot}
        hasReport={hasReport}
        onExport={() => {
          setExportDialogOpen(true);
        }}
        onPull={() => {
          setPullDialogOpen(true);
        }}
      />
      <GoldStatus gold={goldData} />
      <QuantGuidePanel />
      <SourceCoverage sources={sourceRows} />
      <PullJobsTable pulls={pullRows} />
      <SnapshotBlock snapshot={snapshotData} />
      <ModelLab models={modelRows} hasSnapshot={hasSnapshot} />
      <Leaderboard runId={leaderboard.data?.runId ?? null} rows={leaderboardRows} />
      <AttributionReranker attribution={attributionData} />

      <FarCalibration farCalibration={farCalibrationData} />

      <HarvestedLabels harvestedLabels={harvestedLabelsData} />
      <CasebookPreview hasSnapshot={hasSnapshot} />

      {pullDialogOpen ? (
        <PullDialog
          nowSeconds={Math.floor(Date.now() / 1000)}
          onClose={() => {
            setPullDialogOpen(false);
          }}
        />
      ) : null}
      {exportDialogOpen ? (
        <ExportDialog
          gold={goldData}
          onClose={() => {
            setExportDialogOpen(false);
          }}
          onExportEnqueued={() => {
            setExportPolling(true);
          }}
        />
      ) : null}
    </div>
  );
}

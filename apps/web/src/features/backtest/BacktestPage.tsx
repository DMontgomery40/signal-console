import type { JSX } from "react";

import { ExplainerCard } from "@signal-console/ui";

// Pre-dial placeholder for the Cry Wolf K dial (US-036). The K label here is
// wrapped with ExplainerCard so the explainer machinery is exercised end-to-end
// today; US-036 will swap in the actual range input + snap-point chips while
// keeping the same ExplainerCard wrapper around the "K" label and the live K
// value (per US-046 AC: "wrap the 'K' label and the current K value").
export function BacktestPage(): JSX.Element {
  return (
    <section>
      <h2 className="text-text-hi text-lg font-semibold">Backtest</h2>
      <p className="mt-3 text-text-md text-sm">
        Cry Wolf dial and historical replay (US-036 onward).
      </p>

      <div className="mt-12">
        <div className={SECTION_LABEL_CLASS}>Dial</div>
        <div className="mt-3 flex items-baseline gap-4 font-mono text-text-md">
          <ExplainerCard id="k-mad">
            <span aria-label="K (the Cry Wolf dial)" className="text-text-hi text-base">
              K
            </span>
          </ExplainerCard>
          <span className="text-text-lo">=</span>
          <ExplainerCard id="k-mad-sensitive">
            <span className="tabular text-accent-yellow text-base" data-testid="k-value">
              3.00
            </span>
          </ExplainerCard>
          <span className="ml-4 text-text-lo text-xs">
            Drag in US-036; for now the value is fixed at the live default (
            <ExplainerCard id="k-mad-sensitive">
              <span className="tabular text-text-md">K = 3.0</span>
            </ExplainerCard>
            ).
          </span>
        </div>

        <p className="mt-4 text-text-lo text-xs max-w-[60ch]">
          Hover the underlined terms above for an in-context explanation. The same{" "}
          <ExplainerCard id="fires-per-game">
            <span>fires/game</span>
          </ExplainerCard>{" "}
          metric this dial drives is the live preview metric the analyst watches as they sweep K
          between the{" "}
          <ExplainerCard id="k-mad-sensitive">
            <span>Sensitive</span>
          </ExplainerCard>{" "}
          and{" "}
          <ExplainerCard id="k-mad-calm">
            <span>Calm</span>
          </ExplainerCard>{" "}
          presets.
        </p>
      </div>
    </section>
  );
}

const SECTION_LABEL_CLASS =
  "text-text-lo text-xs uppercase tracking-[0.08em] font-sans font-medium";

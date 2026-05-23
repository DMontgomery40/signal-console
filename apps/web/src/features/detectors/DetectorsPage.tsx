import type { JSX } from "react";

import { ExplainerCard } from "@signal-console/ui";

// Pre-registry placeholder for the Detectors page (US-032). For US-046 the
// detector card titles and param names are wired through ExplainerCard so the
// explainer machinery is reachable from this route today. US-032 will replace
// the static names below with rows queried from /v1/detectors, keeping the
// ExplainerCard wrappers around each title and each visible param name (per
// US-046 AC: "wrap each detector card's title and each visible param name").
export function DetectorsPage(): JSX.Element {
  return (
    <section>
      <h2 className="text-text-hi text-lg font-semibold">Detectors</h2>
      <p className="mt-3 text-text-md text-sm">Detector registry and parameters (US-032).</p>

      <div className="mt-10 space-y-10">
        <article>
          <h3 className="text-text-hi text-base font-semibold">
            <ExplainerCard id="board-mad">
              <span>Board MAD</span>
            </ExplainerCard>
          </h3>
          <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm font-mono">
            <dt className="text-text-lo">
              <ExplainerCard id="bucket-seconds">
                <span>bucketSeconds</span>
              </ExplainerCard>
            </dt>
            <dd className="tabular text-text-md">60</dd>
            <dt className="text-text-lo">
              <ExplainerCard id="k-mad">
                <span>kMad</span>
              </ExplainerCard>
            </dt>
            <dd className="tabular text-text-md">3.00</dd>
            <dt className="text-text-lo">
              <ExplainerCard id="weighting">
                <span>weighting</span>
              </ExplainerCard>
            </dt>
            <dd className="text-text-md">volume</dd>
            <dt className="text-text-lo">
              <ExplainerCard id="trailing-buckets">
                <span>trailingBuckets</span>
              </ExplainerCard>
            </dt>
            <dd className="tabular text-text-md">20</dd>
            <dt className="text-text-lo">
              <ExplainerCard id="warmup-buckets">
                <span>warmupBuckets</span>
              </ExplainerCard>
            </dt>
            <dd className="tabular text-text-md">8</dd>
            <dt className="text-text-lo">
              <ExplainerCard id="fresh-cap-seconds">
                <span>freshCapSeconds</span>
              </ExplainerCard>
            </dt>
            <dd className="tabular text-text-md">300</dd>
          </dl>
        </article>

        <article>
          <h3 className="text-text-hi text-base font-semibold">
            <ExplainerCard id="off-price-print">
              <span>Off-price print</span>
            </ExplainerCard>
            <span className="ml-3 text-text-lo text-xs font-mono uppercase tracking-wider">
              Polymarket only
            </span>
          </h3>
        </article>
      </div>
    </section>
  );
}

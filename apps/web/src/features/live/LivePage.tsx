import type { JSX } from "react";

export function LivePage(): JSX.Element {
  return (
    <section>
      <h2 className="text-text-hi text-lg font-semibold">Live</h2>
      <p className="mt-3 text-text-md text-sm">
        Click a game from Recent to open its live view (US-031).
      </p>
    </section>
  );
}

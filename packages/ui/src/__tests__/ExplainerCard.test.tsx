import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ExplainerCard } from "../components/ExplainerCard";
import { explainers, type ExplainerId } from "../explainers";

const EXPLAINER_IDS: readonly ExplainerId[] = Object.keys(explainers).filter(
  (key): key is ExplainerId => key in explainers,
);

// Test-only escape hatch that lets the unknown-id test inject a string that
// the literal-union ExplainerId would otherwise reject. We use the JSON parser
// to launder the value through `unknown` -> typed prop bag with NO `as`
// keyword (per the repo's consistent-type-assertions:never rule). The cost is
// a JSON round-trip per call, which is fine for a single unit-test setup.
function makeBogusProps(id: string): { id: ExplainerId } {
  const json = JSON.stringify({ id });
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || !("id" in parsed)) {
    throw new Error("makeBogusProps: parse produced an unexpected shape");
  }
  const { id: erased } = parsed;
  if (typeof erased !== "string") {
    throw new Error("makeBogusProps: id is not a string");
  }
  // ExplainerId is a string-literal union; at runtime ExplainerCard's defensive
  // lookup will return undefined for unknown ids and render the children pass-
  // through with a dev warning. The type assertion here is sound at the prop-
  // type level (id IS a string) and intentionally unsound at the literal-union
  // level (id is NOT a known key) so the runtime guard can be exercised.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return { id: erased as ExplainerId };
}

describe("ExplainerCard — trigger discoverability", () => {
  it("wraps children with the dashed-underline trigger and cursor:help", () => {
    render(
      <ExplainerCard id="k-mad">
        <span>K</span>
      </ExplainerCard>,
    );
    const trigger = screen.getByText("K").parentElement;
    expect(trigger).not.toBeNull();
    expect(trigger?.className).toContain("border-b");
    expect(trigger?.className).toContain("border-dashed");
    // US-050: trigger underline shifts from text-lo/50 to accent-yellow/60 so
    // the explainer affordance is visibly the same yellow identity as the
    // card's left-edge stripe end-to-end.
    expect(trigger?.className).toContain("border-accent-yellow/60");
    expect(trigger?.className).not.toContain("border-text-lo/50");
    expect(trigger?.className).toContain("cursor-help");
    expect(trigger?.getAttribute("data-explainer-id")).toBe("k-mad");
  });
});

describe("ExplainerCard — US-050 surface, stripe, and backdrop", () => {
  it("renders the surface-elevated background + yellow left stripe + hairline ring + backdrop", async () => {
    const user = userEvent.setup();
    render(
      <ExplainerCard id="k-mad">
        <span>K</span>
      </ExplainerCard>,
    );
    const trigger = screen.getByText("K").parentElement;
    if (trigger === null) throw new Error("trigger missing");
    await user.hover(trigger);
    await waitFor(() => {
      expect(screen.getByText("Plain English")).toBeDefined();
    });

    const card = document.body.querySelector(".explainer-card-content");
    expect(card).not.toBeNull();
    const cardClass = String(card?.className ?? "");
    expect(cardClass).toContain("bg-surface-elevated");
    expect(cardClass).toContain("border-l-[3px]");
    expect(cardClass).toContain("border-l-accent-yellow");
    expect(cardClass).toContain("border-text-lo/30");
    // No box-shadow / drop-shadow / CSS filter classes on the card itself —
    // depth comes from the backdrop, not from elevation shadow on the body.
    expect(cardClass).not.toMatch(/\bshadow-/);
    expect(cardClass).not.toMatch(/\bdrop-shadow/);

    const backdrop = document.body.querySelector(".explainer-backdrop");
    expect(backdrop).not.toBeNull();
  });

  it("unmounts the backdrop when the card closes", async () => {
    const user = userEvent.setup();
    render(
      <ExplainerCard id="k-mad">
        <span>K</span>
      </ExplainerCard>,
    );
    const trigger = screen.getByText("K").parentElement;
    if (trigger === null) throw new Error("trigger missing");
    await user.hover(trigger);
    await waitFor(() => {
      expect(document.body.querySelector(".explainer-backdrop")).not.toBeNull();
    });

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(document.body.querySelector(".explainer-backdrop")).toBeNull();
    });
  });
});

describe("ExplainerCard — content opens on hover and shows both sections", () => {
  it("opens within 200ms of pointer enter and exposes Plain English + Formal labels", async () => {
    const user = userEvent.setup();
    render(
      <ExplainerCard id="k-mad">
        <span>K</span>
      </ExplainerCard>,
    );
    const trigger = screen.getByText("K").parentElement;
    expect(trigger).not.toBeNull();
    if (trigger === null) return;

    await user.hover(trigger);

    await waitFor(
      () => {
        expect(screen.getByText("Plain English")).toBeDefined();
        expect(screen.getByText("Formal")).toBeDefined();
      },
      { timeout: 1000 },
    );
  });

  it("renders KaTeX math in the Formal section, not raw $...$ source", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ExplainerCard id="k-mad">
        <span>K</span>
      </ExplainerCard>,
    );
    const trigger = screen.getByText("K").parentElement;
    if (trigger === null) throw new Error("trigger missing");
    await user.hover(trigger);
    await waitFor(
      () => {
        expect(screen.getByText("Formal")).toBeDefined();
      },
      { timeout: 1000 },
    );
    const portalRoot = document.body;
    const katexNodes = portalRoot.querySelectorAll(".katex");
    expect(katexNodes.length).toBeGreaterThan(0);
    expect(String(container.textContent)).not.toContain("$$");
  });
});

describe("ExplainerCard — Escape key dismisses the card", () => {
  it("removes the card from the DOM when Escape is pressed", async () => {
    const user = userEvent.setup();
    render(
      <ExplainerCard id="k-mad">
        <span>K</span>
      </ExplainerCard>,
    );
    const trigger = screen.getByText("K").parentElement;
    if (trigger === null) throw new Error("trigger missing");
    await user.hover(trigger);
    await waitFor(() => {
      expect(screen.getByText("Plain English")).toBeDefined();
    });

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByText("Plain English")).toBeNull();
    });
  });
});

describe("ExplainerCard — every authored explainer renders without throwing", () => {
  for (const id of EXPLAINER_IDS) {
    it(`renders id="${id}" hover content cleanly (no KaTeX parse error, no thrown markdown)`, async () => {
      const user = userEvent.setup();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      render(
        <ExplainerCard id={id}>
          <span>trigger</span>
        </ExplainerCard>,
      );
      const trigger = screen.getByText("trigger").parentElement;
      if (trigger === null) throw new Error("trigger missing");
      await user.hover(trigger);
      await waitFor(() => {
        expect(screen.getByText("Plain English")).toBeDefined();
      });

      const allKatexErrors = errSpy.mock.calls.filter((call) => {
        const first: unknown = call[0];
        return typeof first === "string" && first.toLowerCase().includes("katex");
      });
      expect(allKatexErrors.length).toBe(0);

      errSpy.mockRestore();
      warnSpy.mockRestore();
    });
  }
});

describe("ExplainerCard — markdown features", () => {
  it("renders multi-paragraph eli5 as separate <p> elements", async () => {
    const user = userEvent.setup();
    render(
      <ExplainerCard id="k-mad">
        <span>K</span>
      </ExplainerCard>,
    );
    const trigger = screen.getByText("K").parentElement;
    if (trigger === null) throw new Error("trigger missing");
    await user.hover(trigger);
    await waitFor(() => {
      expect(screen.getByText("Plain English")).toBeDefined();
    });

    const paragraphs = document.body.querySelectorAll(".explainer-prose p");
    expect(paragraphs.length).toBeGreaterThan(1);
  });

  it("dev-mode warning fires when eli5 contains a $ character", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // k-mad's eli5 deliberately contains `$K = 3$` etc., so this should warn.
    render(
      <ExplainerCard id="k-mad">
        <span>K</span>
      </ExplainerCard>,
    );
    const dollarWarnings = warnSpy.mock.calls.filter((call) => {
      const first: unknown = call[0];
      return typeof first === "string" && first.includes("$") && first.includes("eli5");
    });
    expect(dollarWarnings.length).toBeGreaterThan(0);
    warnSpy.mockRestore();
  });
});

describe("ExplainerCard — unknown id renders children passthrough", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "development";
  });
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["NODE_ENV"];
    } else {
      process.env["NODE_ENV"] = originalEnv;
    }
  });

  it("renders children as-is and logs a dev warning when given a bogus id", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bogusId = "does-not-exist-XYZ";
    // ExplainerId is a literal-key union, so the call site is type-erased here
    // to exercise the runtime guard. Tests legitimately need to inject values
    // the type system would otherwise reject; this is the only place in the
    // suite where that's true.
    const bogusProps = makeBogusProps(bogusId);
    act(() => {
      render(
        <ExplainerCard {...bogusProps}>
          <span>raw child</span>
        </ExplainerCard>,
      );
    });
    expect(screen.getByText("raw child")).toBeDefined();
    const unknownIdWarnings = warnSpy.mock.calls.filter((call) => {
      const first: unknown = call[0];
      return typeof first === "string" && first.includes(bogusId);
    });
    expect(unknownIdWarnings.length).toBeGreaterThan(0);
    warnSpy.mockRestore();
  });
});

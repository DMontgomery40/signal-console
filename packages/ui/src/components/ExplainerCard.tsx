import type { ReactNode, JSX } from "react";
import * as HoverCard from "@radix-ui/react-hover-card";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

import { explainers, type Explainer, type ExplainerId } from "../explainers";

interface ExplainerCardProps {
  readonly id: ExplainerId;
  readonly children: ReactNode;
  readonly className?: string;
}

// Widening the indexed lookup to Record<string, Explainer> lets the runtime
// guard (`explainer === undefined`) be reachable for tests that intentionally
// inject a bogus id. Direct `explainers[id]` against the literal-keyed object
// returns Explainer (not Explainer | undefined), so TS reports the check as
// dead code without this seam.
const EXPLAINER_LOOKUP: Record<string, Explainer | undefined> = explainers;

// US-050: trigger underline color shifts from text-lo/50 to accent-yellow/60.
// Yellow is now the explainer identity end-to-end — see yellow dashed
// underline, know it's hoverable; see yellow stripe on the resulting card,
// recognize the same affordance. This pairs with the bet365 "engage-with-this"
// yellow role (Join button, +odds, active K) and stays scarce — yellow
// underlines appear only on terms that have an attached explainer.
const TRIGGER_CLASS =
  "border-b border-dashed border-accent-yellow/60 cursor-help underline-offset-2 decoration-from-font";

// US-050: aesthetic pass. The card now sits on the surface-elevated token (a
// materially lighter green than the page gradient) so it reads as floating
// above the page rather than embedded in it. The previous 1 px accent-green
// top-edge border is replaced by a 3 px accent-yellow LEFT-edge stripe
// (Notion-callout pattern) with a 1 px text-lo/30 hairline on the remaining
// three edges. The companion .explainer-backdrop element (rendered as a
// Portal sibling, see render below) blurs and dims the rest of the page so
// the card has visual hierarchy WITHOUT any box-shadow / drop-shadow / CSS
// filter on the card itself. The card stays crisp; only the background is
// blurred.
//
// US-048 carryover: width 560 px clamps to viewport with a 16 px gutter on
// each side so narrow viewports never push the card off-screen.
const CONTENT_CLASS = [
  "bg-surface-elevated text-text-md",
  "border-l-[3px] border-l-accent-yellow",
  "border-t border-r border-b border-text-lo/30",
  "p-4",
  "w-[min(560px,calc(100vw-32px))] max-h-[60vh]",
  "overflow-y-auto",
  "explainer-card-content",
  "relative z-50",
  "data-[state=open]:animate-in data-[state=closed]:animate-out",
  "data-[state=open]:fade-in data-[state=closed]:fade-out",
].join(" ");

const SECTION_LABEL_CLASS =
  "text-text-lo text-xs uppercase tracking-[0.08em] font-sans font-medium";

const DIVIDER_CLASS = "border-t border-text-lo/30 my-6";

function isDev(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    process.env["NODE_ENV"] !== "production"
  );
}

export function ExplainerCard({ id, children, className }: ExplainerCardProps): JSX.Element {
  const explainer = EXPLAINER_LOOKUP[id];

  if (explainer === undefined) {
    if (isDev()) {
      console.warn(`ExplainerCard: unknown explainer id "${id}"`);
    }
    return <>{children}</>;
  }

  if (isDev() && explainer.eli5.includes("$")) {
    console.warn(
      `ExplainerCard: explainer "${id}" eli5 contains a "$" character; LaTeX is not rendered in the eli5 section.`,
    );
  }

  const triggerClass =
    className !== undefined && className.length > 0
      ? `${TRIGGER_CLASS} ${className}`
      : TRIGGER_CLASS;

  return (
    <HoverCard.Root openDelay={150} closeDelay={200}>
      <HoverCard.Trigger asChild>
        <span className={triggerClass} data-explainer-id={id} tabIndex={0}>
          {children}
        </span>
      </HoverCard.Trigger>
      {/* US-050: backdrop is mounted via its own HoverCard.Portal so it
          appears/disappears in sync with the card without violating the
          single-element-child contract on HoverCardPortal (PortalPrimitive
          is invoked with asChild: true, which routes the children through
          @radix-ui/react-slot's Children.only check). Both Portals are
          driven by the same HoverCard.Root open state, so the two presence
          transitions stay coupled. pointer-events:none on the backdrop keeps
          the trigger interactive; backdrop-filter blurs the rest of the
          page; no box-shadow / drop-shadow / filter is applied to the card
          body itself. */}
      <HoverCard.Portal>
        <div className="explainer-backdrop" aria-hidden="true" />
      </HoverCard.Portal>
      <HoverCard.Portal>
        <HoverCard.Content
          sideOffset={8}
          align="center"
          className={CONTENT_CLASS}
          collisionPadding={16}
        >
          <div className="font-sans">
            <div className={SECTION_LABEL_CLASS}>Plain English</div>
            <div className="mt-3 text-sm leading-relaxed text-text-md explainer-prose">
              <ReactMarkdown>{explainer.eli5}</ReactMarkdown>
            </div>

            <div className={DIVIDER_CLASS} />

            <div className={SECTION_LABEL_CLASS}>Formal</div>
            <div className="mt-3 text-sm leading-relaxed text-text-md font-mono explainer-prose explainer-prose-formal">
              <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                {explainer.formal}
              </ReactMarkdown>
            </div>
          </div>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

export type { ExplainerCardProps };

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

const TRIGGER_CLASS =
  "border-b border-dashed border-text-lo/50 cursor-help underline-offset-2 decoration-from-font";

// US-048: width widens 480 -> 560 (closer to 60-80 chars at text-md for the
// multi-paragraph Plain English copy) and clamps to the viewport with a 16 px
// gutter on each side so narrow viewports never push the card off-screen.
const CONTENT_CLASS = [
  "bg-surface-1 text-text-md",
  "border-t border-accent-green",
  "p-4",
  "w-[min(560px,calc(100vw-32px))] max-h-[60vh]",
  "overflow-y-auto",
  "explainer-card-content",
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

// Generic "promote to live" confirmation dialog (phase B4, 2026-05-25).
//
// Used by both:
//   - SettingsPage: profile picker → confirm-promote flow (existing UX)
//   - BacktestPage: "Apply these backtest params to live" button
//
// This is purely presentational. Owners pass the action callbacks and
// state; this component renders the modal shell with apply-now / schedule /
// cancel actions. effectiveAt is the ISO timestamp surfaced on the
// "Schedule" button so the operator knows exactly when a scheduled promote
// would land.

import { type JSX, type ReactNode } from "react";

export interface PromotionDialogProps {
  readonly title: string;
  // Body content — can be a string or any node (so callers can include
  // <p> blocks, lists, tables of changed fields, etc.).
  readonly body: ReactNode;
  readonly effectiveAt: string;
  readonly onApplyNow: () => void;
  readonly onSchedule: () => void;
  readonly onCancel: () => void;
  readonly isApplying?: boolean;
  readonly isScheduling?: boolean;
  readonly errorMessage?: string | undefined;
  // dataTestIdRoot keys all data-testid attributes inside the dialog so
  // SettingsPage and BacktestPage can target their own copies without
  // colliding (existing SettingsPage tests use "detector-profile-*"; new
  // BacktestPage tests use "backtest-promote-*").
  readonly dataTestIdRoot: string;
}

export function PromotionDialog(props: PromotionDialogProps): JSX.Element {
  const {
    title,
    body,
    effectiveAt,
    onApplyNow,
    onSchedule,
    onCancel,
    isApplying = false,
    isScheduling = false,
    errorMessage,
    dataTestIdRoot,
  } = props;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${dataTestIdRoot}-title`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-0-from/85 px-4"
      data-testid={dataTestIdRoot}
    >
      <div className="max-w-xl border border-accent-yellow bg-surface-1 p-5 shadow-lg">
        <h4 id={`${dataTestIdRoot}-title`} className="text-text-hi text-base font-semibold">
          {title}
        </h4>
        <div className="mt-3 text-sm text-text-md">{body}</div>
        {errorMessage !== undefined && errorMessage !== "" ? (
          <p
            className="mt-3 font-mono text-xs text-accent-yellow"
            data-testid={`${dataTestIdRoot}-error`}
          >
            {errorMessage}
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={onApplyNow}
            disabled={isApplying || isScheduling}
            className="border border-accent-yellow px-3 py-2 text-xs font-mono uppercase tracking-wider text-text-hi hover:bg-accent-yellow hover:text-surface-0-from disabled:opacity-60"
            data-testid={`${dataTestIdRoot}-apply-now`}
          >
            Apply now
          </button>
          <button
            type="button"
            onClick={onSchedule}
            disabled={isApplying || isScheduling}
            className="border border-surface-2 px-3 py-2 text-xs font-mono uppercase tracking-wider text-text-md hover:border-accent-yellow hover:text-text-hi disabled:opacity-60"
            data-testid={`${dataTestIdRoot}-schedule`}
            title={`Promote at ${effectiveAt}`}
          >
            Schedule 09:00 UTC
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={isApplying || isScheduling}
            className="px-3 py-2 text-xs font-mono uppercase tracking-wider text-text-lo hover:text-text-hi disabled:opacity-60"
            data-testid={`${dataTestIdRoot}-cancel`}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

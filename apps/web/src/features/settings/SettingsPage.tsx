import type { JSX } from "react";

export function SettingsPage(): JSX.Element {
  return (
    <section>
      <h2 className="text-text-hi text-lg font-semibold">Settings</h2>
      <p className="mt-3 text-text-md text-sm">Read-only view of gold DB + cache state (US-026).</p>
    </section>
  );
}

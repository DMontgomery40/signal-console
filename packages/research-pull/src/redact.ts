/**
 * URL redaction for evidence artifacts.
 *
 * Canonical source: packages/adapters/src/odds-api-io-live-comparator.ts
 * (`redactOddsApiIoUrl`). Re-declared locally — byte-for-byte behavior — so
 * this shared-contract package stays a dependency LEAF (no workspace runtime
 * deps, mirroring `validator.ts` re-declaring the bookmaker spine). Keep in
 * sync with the adapter.
 *
 * Strips the `apiKey` query parameter from a URL so Odds-API.io endpoints can
 * be persisted as evidence without leaking the credential.
 */
export function redactOddsApiIoUrl(input: string): string {
  const url = new URL(input);
  if (url.searchParams.has("apiKey")) {
    url.searchParams.set("apiKey", "REDACTED");
  }
  return url.toString();
}

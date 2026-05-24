US-026 visual verification — pending owner capture
===================================================

Per CLAUDE.md "KNOWN HANG MODE" Playwright/computer-use have hung on this machine
for prior UI stories (US-045, US-046). Per the fallback rule, this iteration
verified US-026 via HTTP smoke + DB parity + production-bundle testid grep
instead of browser screenshots. Documented in:
- scripts/ralph/progress.txt (Verification ran section for US-026)
- apps/web/src/features/settings/__tests__/SettingsPage.test.tsx (11 unit tests)

If/when the owner wants real screenshots for /settings, navigate to
http://localhost:5173/settings against the dev server. Pages to capture:
  1. baseline.png    — full /settings with read-only DB + per-source rows
  2. clear-cache.png — after clicking Clear cache and confirming
  3. error.png       — set VITE_API_URL to an unreachable host, reload, capture
                       the ApiUnreachableBanner across the page

Resolutions: 1440x900 + 1024x768.

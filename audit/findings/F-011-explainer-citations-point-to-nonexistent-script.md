# F-011 — Explainer "formal" cards cite `scripts/board_signal_v2.py` as the canonical source, but that path does not exist in this repo

- **Severity:** low–medium (no wrong numbers; misleads the reader who trusts the
  cited authority — and the explainers are product copy, per the Change Inventory)
- **Boundary crossed:** UI explainer copy ↔ actual repo file layout / canonical
  runtime; also the design-language voice guide ↔ reality
- **Status:** confirmed
- **Surfaces no error:** yes — it's prose; nothing validates that a cited path
  resolves.

## What's wrong

Six `formal` explainer cards in `packages/ui/src/explainers.ts` cite
`scripts/board_signal_v2.py` (one with `:33`) as **the canonical source** for the
board detector's defaults/behavior:

- `k-mad-calm`: "matching the original Python research backtest's default in
  `scripts/board_signal_v2.py:33`."
- `mad`: "see `scripts/board_signal_v2.py`."
- `bucket-seconds`: "(live default, see `scripts/board_signal_v2.py`)."
- `fresh-cap-seconds`: "$\tau_{\max}=300$ s is the live default in
  `scripts/board_signal_v2.py`."
- `weighting`: "The 'volume' mode is the live default in `scripts/board_signal_v2.py`."
- `opening-anchor` / heartbeat-sanitation: "Filtering occurs … in
  `scripts/board_signal_v2.py`."

But **`scripts/board_signal_v2.py` does not exist in this repo** (`ls`, `find`,
and `git log --all` all confirm — it was never committed here). `index.ts:1`
reveals why: the board-mad detector is "a TypeScript port of
`scripts/board_signal_v2.py` **(nba-predict)**" — the script lives in the separate
_nba-predict_ repo. The explainer cards drop the "(nba-predict)" qualifier, so the
path reads as in-repo and resolves to nothing here.

Compounding it: `docs/design-language.md:224` uses this exact dead path as the
_example_ of how to cite a canonical source ("Cite the canonical source (e.g.
`scripts/board_signal_v2.py:33`)") — so the pattern is institutionalized and new
explainers will copy it.

## Why it matters

- The cited _values_ are all correct (`K_MAD_CALM=6.0`, `BUCKET_SECONDS_DEFAULT=60`,
  `FRESH_CAP_SECONDS_DEFAULT=300`, `WEIGHTING_DEFAULT="volume"` — verified in
  `config.ts`), so this is not a wrong-number defect. The harm is **authority
  misdirection**: a `formal` card's whole contract (per the file header and
  design-language) is "Cite the canonical source." A quant who trusts that and goes
  to read `scripts/board_signal_v2.py` to understand the math finds nothing, in a
  repo whose actual live runtime is `apps/nba-sidecar/src/nba_sidecar/volatility.py`
  (state-space) — not even the same algorithm as the cited MAD script.
- It's also semantically stale: the cards describe the _current_ state-space
  behavior but cite the _pre-migration_ research MAD script as the source of those
  defaults. The defaults did carry over, but the citation implies the live behavior
  lives there, which it doesn't.

Explainers are explicitly product copy ("Content edits are review events"), and the
Change Inventory Checklist names hover-explainer code references as a maintained
surface — so a dangling canonical-source citation is a real copy defect, not a
nitpick.

## Fix

- For each citation, point at what actually exists in THIS repo and matches the
  claim:
  - Defaults (`K_MAD_*`, `BUCKET_SECONDS_DEFAULT`, `FRESH_CAP_SECONDS_DEFAULT`,
    `WEIGHTING_DEFAULT`) → `packages/detectors/src/board-mad/config.ts`.
  - Prebucket/sanitation/weighting behavior → `packages/detectors/src/board-mad/prebucket.ts`.
  - Live fire/innovation runtime → `apps/nba-sidecar/src/nba_sidecar/volatility.py`
    (several cards already cite this correctly — make all consistent).
  - If the intent is to credit the _origin_, write "ported from
    `nba-predict/scripts/board_signal_v2.py`" so it's unambiguously an external
    provenance note, not an in-repo path.
- Fix the `docs/design-language.md:224` example to a real in-repo path so the
  pattern stops propagating.
- Consider a tiny `verify-*` guard (repo already has `scripts/verify-*.ts`) that
  greps explainer/`docs` backtick-cited `scripts/…`/`packages/…`/`apps/…` paths and
  asserts each resolves — turns "citation rot" into a failing check (same spirit as
  F-001's contract test).

## Evidence

`explainers.ts` lines for `k-mad-calm` (`:73`), `mad` (`:93`), `bucket-seconds`
(`:171`), `fresh-cap-seconds` (`:213`), `weighting` (`:225`), heartbeat sanitation
(`:311`); `index.ts:1` ("(nba-predict)"); `design-language.md:224`; `ls`/`find`/`git
log --all` show no `scripts/board_signal_v2.py`. Values cross-checked in `config.ts`.

---

## RESOLUTION (fixed 2026-05-30) — repointed + enforced

- **6 explainer citations repointed** (`packages/ui/src/explainers.ts`) from the
  non-existent `scripts/board_signal_v2.py` to the real in-repo owner of each claim:
  - `k-mad-calm` → `K_MAD_CALM` in `config.ts` (+ explicit "upstream
    `nba-predict/scripts/board_signal_v2.py`" provenance note, the lone external mention)
  - `mad` floor → `BOARD_MAD_MAD_FLOOR` in `config.ts` + `volatility.py`
  - `bucket-seconds` → `BOARD_MAD_BUCKET_SECONDS_DEFAULT` in `config.ts`
  - `fresh-cap-seconds` → `BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT` in `config.ts`
  - `weighting` → `BOARD_MAD_WEIGHTING_DEFAULT` in `config.ts` + `prebucket.ts`
  - heartbeat sanitation → `prebucket.ts`
- **design-language.md:224** citation example fixed to a resolving in-repo path +
  explicit-external-provenance guidance, so the pattern stops propagating.
- **Enforcement (new):** `scripts/verify-citations.ts` scans explainer/doc copy for
  backtick-cited in-repo paths (`packages|apps|scripts|docs/….ext`) and fails if any
  doesn't resolve; wired into `package.json` `verify` chain (`verify:citations`).
  External-provenance tokens (`nba-predict/…`) don't match the in-repo prefixes, so
  they pass. **Negative control:** reinjecting `scripts/board_signal_v2.py` made the
  guard exit 1; revert → exit 0.

Verified: `verify-citations.ts` ok; ui `tsc` clean; ui vitest 20/20. Not committed.

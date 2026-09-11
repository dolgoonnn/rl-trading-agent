# 3-Month Paper-Trading Review — Combined Book
**Review date**: 2026-09-11 (pre-registered in charter, section "At review")
**Period covered**: 2026-06-11 → 2026-09-11 (≈ 92 calendar days)
**Reviewer**: cloud routine (https://claude.ai/code/routines/trig_01Gx4HbtnrsStENw6LG9ng6k)

---

## ⚠️ OPERATOR ACTION REQUIRED — live data not in repo

The live bot state files were **not committed to the repository** before the
review date. This is consistent with the charter's dependency note
(2026-06-11 log entry):

> "DEPENDENCY: charter + scripts + (ideally) bot state snapshots must be
> committed to GitHub before the review date — the cloud agent only sees the repo."

The cloud routine cannot see `data/metals-bot-state.json`,
`data/gold-bot-state.json`, or any crypto-bot DB that lives only on the
operator's local machine. The allocator script (`scripts/run-allocator.ts`)
was therefore NOT run — its output would be meaningless without the live state.

**What the operator must do:**

1. On the local machine, run:
   ```bash
   npx tsx scripts/run-allocator.ts > experiments/runs/allocator-report-2026-09-11.json
   ```
2. Fill in every `[NEEDS_OPERATOR_INPUT]` placeholder in this file with the
   actual numbers from that report and from the crypto bot DB.
3. Apply the FUND / DROP / EXTEND verdicts mechanically using the gates below.
4. Commit this file (with numbers filled in) and
   `experiments/runs/allocator-report-2026-09-11.json` to this branch, then
   merge the PR.

The structured checklist below lists every gate exactly as written in the
charter. The operator applies it mechanically — the verdict logic is not
discretionary.

---

## Integrity check (fill in BEFORE applying gates)

> Charter rule: "Bot integrity failure (missed/duplicated entries, stale-quote
> fills, clock bugs): fix immediately; if >5% of a sleeve's trades are
> corrupted, that sleeve's paper clock restarts."

| Item | Question | Operator answer |
|---|---|---|
| Crypto-bot uptime | Was the bot running continuously 2026-06-11 → 2026-09-11? Any gaps > 1h? | [NEEDS_OPERATOR_INPUT] |
| Crypto entry times | Do trade timestamps align with ICT session kill zones (London/NY open)? | [NEEDS_OPERATOR_INPUT] |
| Metals-bot uptime | Was `run-metals-bot.ts` running continuously? Any gaps? | [NEEDS_OPERATOR_INPUT] |
| Au overnight entry | Entries firing at 18:05 ET DST-aware (CME reopen +5m), not 22:01 UTC? | [NEEDS_OPERATOR_INPUT] |
| Ag overnight entry | Same anchor check for Ag leg. | [NEEDS_OPERATOR_INPUT] |
| NFP leg windows | NFP trades firing at delay-aware windows (signal 09:12–09:22, exit ≥12:12)? (Charter 2026-06-11 integrity bug fixed pre-launch) | [NEEDS_OPERATOR_INPUT] |
| Fix-short leg | Au fix-short entries at London fix window as designed? | [NEEDS_OPERATOR_INPUT] |
| US500 overnight | J-leg entries at CME close, exits at open? | [NEEDS_OPERATOR_INPUT] |
| EUR morning short | K-leg entries at London open, not at h22 rollover? (L-leg was cut) | [NEEDS_OPERATOR_INPUT] |
| F2F bot uptime | `gold-f2f-bot` running? Trades aligning with daily settlement? | [NEEDS_OPERATOR_INPUT] |
| Stale-quote fills | Any fill that used a quote > 30m stale? | [NEEDS_OPERATOR_INPUT] |
| Corrupt trade % (each sleeve) | Crypto: [__]% / Metals: [__]% / F2F: [__]% corrupted | [NEEDS_OPERATOR_INPUT] |
| Parameter changes | Were ANY parameters changed in any sleeve since 2026-06-11? (charter hard rule 1) | [NEEDS_OPERATOR_INPUT — must be NO] |
| New legs added | Were ANY new legs/sleeves added to the live book since 2026-06-11? (charter hard rule 2) | [NEEDS_OPERATOR_INPUT — must be NO] |

**Integrity verdict**:
- If corrupt trade % > 5% for any sleeve → that sleeve's clock restarts; exclude from this review and re-run after a fresh 3-month window.
- If any parameter was changed or a new leg was added → the review is invalid for that sleeve; document the deviation here with date and reason per charter rule.

Integrity verdict: [PASS / PARTIAL — see notes / FAIL — sleeve(s) restarting]

---

## BREACH log check

> Charter: rolling 60d Sharpe < −1.0 triggers a written review within a week.
> A BREACH may not be "resolved" by P&L recovering — it requires a written
> mechanism review.

| Period | Sleeve | Rolling 60d Sharpe (min observed) | BREACH triggered? | If yes — written review filed? |
|---|---|---|---|---|
| Jun–Aug 2026 | Crypto OB (Run 20) | [NEEDS_OPERATOR_INPUT] | [Y/N] | [Y/N/N/A] |
| Jun–Aug 2026 | Session book | [NEEDS_OPERATOR_INPUT] | [Y/N] | [Y/N/N/A] |
| Jun–Aug 2026 | F2F gold | [NEEDS_OPERATOR_INPUT] | [Y/N] | [Y/N/N/A] |

Any unresolved BREACH → the corresponding sleeve cannot receive a FUND verdict at this review (EXTEND or DROP instead, per charter).

---

## Sleeve 1 — Crypto OB (Run 20)

**Design**: BTC/ETH/SOL, 1H OB confluence entries, CMA-ES Run 20 parameters (WF pass 64.9% on data through 2026-06-11). Bybit perps, 7bp/side assumed. 50% allocator weight.

**Bootstrap 5th-percentile path for 3 months** (from `scripts/run-allocator.ts`):
Worst-case 3-month cumulative return at the 5th percentile: approximately **−7% to −2%** of sleeve notional (derived from vol-normalized Sharpe 1.88, 10% vol target, ~66d horizon; exact number from allocator preferred).

| Gate | Required | Actual (from allocator / crypto DB) | Met? |
|---|---|---|---|
| Trade count ≥ 30 | ≥ 30 trades in window | [NEEDS_OPERATOR_INPUT] | [Y/N] |
| Execution as designed | Entries at kill zones, directions match OB signal, frictions within 7bp/side | [NEEDS_OPERATOR_INPUT] | [Y/N] |
| Cumulative PnL ≥ 5th-pct path | ≥ approx. −7% sleeve notional (use allocator exact figure) | [NEEDS_OPERATOR_INPUT] | [Y/N] |
| No unresolved BREACH | 60d Sharpe never went below −1.0, or if it did a mechanism review was filed | [NEEDS_OPERATOR_INPUT] | [Y/N] |

**Additional metrics to record** (for the trading record):
- Total trades: [NEEDS_OPERATOR_INPUT]
- Win rate: [NEEDS_OPERATOR_INPUT]
- Avg holding days: [NEEDS_OPERATOR_INPUT]
- Cumulative sleeve PnL % equity: [NEEDS_OPERATOR_INPUT]
- Realized sleeve Sharpe (calendar-day, 92d): [NEEDS_OPERATOR_INPUT]
- Min rolling 30d Sharpe observed: [NEEDS_OPERATOR_INPUT]
- Min rolling 60d Sharpe observed: [NEEDS_OPERATOR_INPUT]

**Crypto sleeve verdict**:
- All four gates met → **FUND**
- PnL below 5th-pct AND mechanism failure plausible → **DROP**
- Fewer than 30 trades OR ambiguous (in-band but ugly) → **EXTEND 3 months**
- Unresolved BREACH → **EXTEND** (or DROP if mechanism clearly broken)

Verdict: **[FUND / DROP / EXTEND — operator fills in]**

---

## Sleeve 2 — Session Book (6 deployable legs)

**Design**: 6 legs — (A) Au overnight, (C) Au fix-short, (I) Ag own-fix short, (F) Au NFP-mom, (J) US500 overnight, (K) EUR morning short. Plus (B) Ag overnight as marginal/watch leg. Paper fills from ~10min-delayed Yahoo feed (validated unbiased). 30% allocator weight.

**Bootstrap 5th-percentile path for 3 months**:
Worst-case 3-month: approximately **−4% to 0%** of sleeve notional (vol-normalized Sharpe ~1.34 standalone, 10% vol, ~66d; allocator exact preferred).

| Gate | Required | Actual (from allocator / metals-bot-state.json) | Met? |
|---|---|---|---|
| Trade count ≥ 30 | ≥ 30 trades in window (across all legs combined) | [NEEDS_OPERATOR_INPUT] | [Y/N] |
| Execution as designed | Each leg's times, direction logic, and friction within venue assumptions | [NEEDS_OPERATOR_INPUT] | [Y/N] |
| Cumulative PnL ≥ 5th-pct path | ≥ approx. −4% sleeve notional (use allocator exact) | [NEEDS_OPERATOR_INPUT] | [Y/N] |
| No unresolved BREACH | 60d Sharpe ≥ −1.0, or mechanism review filed | [NEEDS_OPERATOR_INPUT] | [Y/N] |

**Per-leg trade counts and direction check** (from metals-bot-state.json):

| Leg | Expected fires/3mo | Actual fires | Directions correct? | Notes |
|---|---|---|---|---|
| A: Au overnight | ~60 (weeknights) | [NEEDS_OPERATOR_INPUT] | [Y/N] | |
| C: Au fix-short | ~60 (weekdays) | [NEEDS_OPERATOR_INPUT] | [Y/N] | |
| I: Ag own-fix short | ~60 (weekdays) | [NEEDS_OPERATOR_INPUT] | [Y/N] | |
| F: Au NFP-mom | ~3 (monthly) | [NEEDS_OPERATOR_INPUT] | [Y/N] | NFP dates: Jul 5, Aug 2, Sep 5 2026 |
| J: US500 overnight | ~60 (weeknights) | [NEEDS_OPERATOR_INPUT] | [Y/N] | |
| K: EUR morning short | ~60 (weekdays) | [NEEDS_OPERATOR_INPUT] | [Y/N] | |

**Additional metrics**:
- Cumulative sleeve PnL % equity: [NEEDS_OPERATOR_INPUT]
- Realized Sharpe (calendar-day, 92d): [NEEDS_OPERATOR_INPUT]
- Min rolling 60d Sharpe: [NEEDS_OPERATOR_INPUT]

**Session book verdict**: **[FUND / DROP / EXTEND — operator fills in]**

---

## Sleeve 2a — Ag Overnight (marginal, special rule)

> Charter special rule: "Ag-overnight (marginal, 0.27 at real costs): funds
> ONLY if its live paper Sharpe over the period is > 0.3 — it must earn its
> way back in."

This leg runs inside the session bot for live evidence collection but is NOT
part of the deployable book unless it clears 0.3 Sharpe in this review.

| Gate | Required | Actual | Met? |
|---|---|---|---|
| Live paper Sharpe (Ag overnight only, 92d calendar-day) | > 0.3 | [NEEDS_OPERATOR_INPUT] | [Y/N] |

> Note: with only ~60 observations over 3 months, the standard error on Sharpe
> is ≈ 1/√60 ≈ 0.13, so a measured Sharpe of 0.3 is barely 2σ above zero. The
> charter requires > 0.3 as the threshold; apply it literally.

Ag overnight verdict: **[ADD TO DEPLOYABLE BOOK / REMAIN ON WATCH — operator fills in]**

---

## Sleeve 3 — F2F Gold (daily)

**Design**: F2F daily gold, NON-overlapping walk-forward, zscore50, long-only. Bybit XAUT perp (maker entries) at ~3.2bp/side. 20% allocator weight. Calendar-day Sharpe ~0.34 (all days) / ~1.15 (vol-normalized in combination).

**Bootstrap 5th-percentile path for 3 months**:
Worst-case 3-month: approximately **−8% to −2%** sleeve notional (lower per-trade Sharpe, longer flat periods; allocator exact preferred).

| Gate | Required | Actual (from gold-bot-state.json) | Met? |
|---|---|---|---|
| Trade count ≥ 30 | ≥ 30 trades in window | [NEEDS_OPERATOR_INPUT] | [Y/N] |
| Execution as designed | Entries long-only, at daily settle/close, maker fills on perp | [NEEDS_OPERATOR_INPUT] | [Y/N] |
| Cumulative PnL ≥ 5th-pct path | ≥ approx. −8% sleeve notional (allocator exact) | [NEEDS_OPERATOR_INPUT] | [Y/N] |
| No unresolved BREACH | 60d Sharpe ≥ −1.0, or mechanism review filed | [NEEDS_OPERATOR_INPUT] | [Y/N] |

**Additional metrics**:
- Total trades in window: [NEEDS_OPERATOR_INPUT]
- Cumulative sleeve PnL % equity: [NEEDS_OPERATOR_INPUT]
- Realized Sharpe (calendar-day, 92d): [NEEDS_OPERATOR_INPUT]
- Min rolling 60d Sharpe: [NEEDS_OPERATOR_INPUT]

> Note on F2F trade count: the F2F strategy has lower trade frequency by
> design (daily timeframe, long-only). If fewer than 30 trades fire in 92
> days, this sleeve automatically receives **EXTEND** per the charter — that
> is not a failure, it is the charter operating as written.

**F2F gold verdict**: **[FUND / DROP / EXTEND — operator fills in]**

---

## Combined book — overall funding recommendation

> The combined book funds only if the sleeves that pass individually also
> satisfy the combination structure (crypto 0.50 / book 0.30 / f2f 0.20
> allocator weights remain valid).

| Sleeve | Verdict | Notes |
|---|---|---|
| Crypto OB (Run 20) | [FUND / DROP / EXTEND] | |
| Session book (6 legs) | [FUND / DROP / EXTEND] | |
| Ag overnight (marginal) | [ADD / WATCH] | |
| F2F gold | [FUND / DROP / EXTEND] | |

**Overall recommendation**: [NEEDS_OPERATOR_INPUT]

Examples of valid outcomes (non-exhaustive):
- All three FUND → open the broker account, deploy funded at the pre-registered
  crypto 0.50 / book 0.30 / f2f 0.20 weights with 12% ann vol target.
- One or more EXTEND → run the extended sleeve in paper only; fund the FUND
  sleeves at reduced weights (re-run the combination without the extended
  sleeve first to check it still clears 5/5 stress gates).
- Any DROP → re-run the combination without the dropped sleeve; only fund if
  the remaining book still passes. Do not rush to replace the dropped sleeve.
- A flat 3-month result on any sleeve is **within pre-registered expectations**
  and is NOT grounds for DROP (worst normal 6mo ≈ flat per the charter).

---

## Post-review actions checklist

- [ ] Run `npx tsx scripts/run-allocator.ts` and save output to `experiments/runs/allocator-report-2026-09-11.json`
- [ ] Fill in all `[NEEDS_OPERATOR_INPUT]` fields above
- [ ] Apply FUND / DROP / EXTEND verdicts mechanically
- [ ] If any sleeve is EXTENDED: set next review date (2026-12-11) and create a new cloud routine
- [ ] If any sleeve drops: run `scripts/combine-strategies.ts` without it and verify 5/5 stress gates before funding the rest
- [ ] If Ag overnight FUND: add it to the deployable book weights and re-run the combination
- [ ] If funding is approved: record broker account details in a local (non-committed) file; do not commit API keys
- [ ] Commit the filled-in review file and allocator report to this branch and merge the PR
- [ ] Append the final dated entry to the charter Log section (see template in charter)

---

## Reference numbers (from charter and strategy-combination.md)

**Pre-registered expectations (so results can be evaluated in context):**

| Metric | Pre-registered expectation |
|---|---|
| Combined book annual return | ~37%/yr (Universe C, realistic friction) |
| Combined book Sharpe | ~2.46–2.53 |
| Combined book max DD | ~9.9–11.7% |
| Worst normal 6 months | ≈ flat (−0.3% to +1.5%) |
| Worst normal 12 months | ≈ +6% |
| Crypto sleeve calendar-day Sharpe | ~1.88 (vol-normalized) |
| Session book calendar-day Sharpe | ~1.34 (standalone, 6 legs, realistic friction) |
| F2F gold calendar-day Sharpe | ~0.34 all-days / 1.15 vol-normalized |
| Ag overnight Sharpe at venue cost | 0.27 (marginal — charter gate is 0.3) |

**Allocator weights (must not have changed since signing):**
- Crypto 0.50 / Session book 0.30 / F2F 0.20
- Vol target 12% ann; rebalance only if a sleeve's target notional drifts >10% relative

**Deployable session-book legs (6, per execution-audit.md):**
A (Au overnight), C (Au fix-short), I (Ag own-fix short), F (Au NFP-mom), J (US500 overnight), K (EUR morning short).
Legs cut before paper start: D (Au AM-fix long — MARGINAL), L (EUR h22 long — FAIL).

---

*This document was written by the cloud review routine on 2026-09-11. The bot
state files (data/metals-bot-state.json, data/gold-bot-state.json, crypto bot DB)
were not present in the repository at review time and must be supplied by the
operator. The review structure and gate logic are copied directly from
experiments/paper-trading-charter.md — no new criteria have been invented.*

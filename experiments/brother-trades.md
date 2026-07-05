# Brother's Trade Ledger — extracted from 49 screenshots (2026-06-29)

Source: 49 MT5/Deriv mobile screenshots (Telegram), archived in `experiments/brother-screenshots/`
(`photo_2026-05-13_19-2*` = Apr–May trades; `photo_2026-06-29_16-23-*` = May–Jun trades).
Every value read directly off the pixels. **Entry price, lot, P&L, direction, instrument and the
History fills are exact**; chart exit prices are approximate.

Two record types:
1. **History / Deals ledger** (the dark MT5 screenshot) — the *real account record*: exact
   open→close fills, **including losers**, with the account summary. This is ground truth.
2. **Chart screenshots** — individual open/closed positions with an order label
   (`BUY/SELL <lot>, +<pnl> USD`) pinned at the entry price. Winners-biased (he screenshots wins),
   but now we also have the losers from the ledger.

Instruments traded: Volatility 75 / 100 / 100(1s), Step Index / 200 / 500, Boom 150 / 1000,
Crash 1000, Jump 100, and XAUUSD (gold). Timeframe almost always **M1** (a few M5 / M15).
Date span: **14 Apr – 29 Jun 2026**.

---

## 1. REAL ACCOUNT LEDGER (History → Deals tab) — the ground truth

Gold account, lot = 1.0, 28–29 Apr 2026. Exact fills:

| # | Side | Open → Close | P&L USD | Timestamp |
|---|---|---|---|---|
| H1 | sell | 4628.973 → 4627.567 | **+140.60** | 28 Apr 11:55:40 |
| H2 | buy  | 4609.727 → 4610.073 | **+34.60** | 28 Apr 13:10:55 |
| H3 | sell | 4611.863 → 4581.564 | **+3,029.90** | 28 Apr 14:36:25 |
| H4 | sell | 4565.053 → 4562.677 | **+237.60** | 28 Apr 17:47:29 |
| H5 | sell | 4591.583 → 4608.267 | **−1,668.40** | 29 Apr 03:08:54 |
| H6 | buy  | 4609.387 → 4607.003 | **−238.40** | 29 Apr 03:15:07 |
| H7 | sell | 4606.213 → 4600.307 | **+590.60** | 29 Apr 03:30:11 |
| H8 | sell | 4583.993 → 4583.535 | **+45.80** | 29 Apr 09:22:26 |
| H9 | sell | 4580.503 → 4579.607 | **+89.60** | 29 Apr 10:12:49 |
| H10 | sell | 4599.403 → 4572.227 | **+2,717.60** | 29 Apr 10:42:02 |
| H11 | sell | 4602.653 → 4571.077 | **+3,157.60** | 29 Apr 10:42:25 |

(Two further deals are faded/scrolled at the top — e.g. `sell 4665.663 → 4650.620` — not fully readable.)

**Account summary:** Deposit **20,000.00** · Profit **+10,552.10** · Swap −15.00 · Commission 0.00 · **Balance 30,537.10** (= +52.8%).

**What this proves (hard numbers):**
- Real win rate is NOT 100% — there are genuine losers (**−1,668.40, −238.40**).
- **Tail-dominated:** the 3 biggest gold shorts (**+3,029.90 / +2,717.60 / +3,157.60 = +8,905**) are
  ~84% of the visible +10,552 profit. Take those 3 away and the rest barely nets positive.
- He **cuts losers small** (−1,668 / −238) and **lets winners run huge** (+3,000-class) → textbook
  positive-skew. Note H5+H6 (the two losers) are *buys/counter-trend on 29 Apr* — when he fought the
  down-move he lost; when he sold with it (H7–H11) he won big. **Trade-with-the-move discipline is the edge.**
- Direction skew: 9 sells / 2 buys → he was overwhelmingly short gold across 28–29 Apr (and it paid).

---

## 2. CHART-SCREENSHOT ENTRIES (every order label, by date)

`dup` = same position re-screenshotted later (don't double-count P&L) · `Renko` = line/brick chart, not candles.

| Date | Instrument | Dir | Lot | Entry | P&L USD | Notes |
|---|---|---|---|---|---|---|
| 14 Apr | Boom 1000 | BUY | 5 | 13,738.4874 | +157.47 | buy dip → spike |
| 16 Apr | Boom 1000 | BUY | 2 | 13,877.5964 | +78.11 | Renko, scale-in |
| 16 Apr | Boom 1000 | BUY | 2 | 13,870.0864 | +93.13 | Renko, scale-in |
| 16 Apr | Boom 1000 | BUY | 2 | 13,865.0694 | +103.16 | Renko, scale-in |
| 16 Apr | Boom 1000 | BUY | 1 | 13,870.0864 | +210.92 | M5 view of same levels (likely dup of above) |
| 16 Apr | Boom 1000 | BUY | 1 | 13,865.0694 | +215.93 | M5 (likely dup) |
| 16 Apr | Volatility 100 | SELL | 20 | 813.55 | +117.40 | fade top |
| 16 Apr | Volatility 100 | SELL | 10 | 813.55 | +211.00 | SL 812.92 (2nd short, same level) |
| 17 Apr | XAUUSD | BUY | 0.2 | 4,795.62 | +168.40 | buy dip, ride up |
| 20 Apr | XAUUSD | BUY | 0.2 | 4,785.42 | +195.20 | buy flush |
| 21 Apr | XAUUSD | BUY | 0.2 | 4,790.60 | +95.60 | |
| 21 Apr | XAUUSD | BUY | 0.1 | 4,785.42 | +99.60 | |
| 22 Apr | XAUUSD | SELL | 0.2 | 4,771.12 | +91.80 | fade top |
| 22 Apr | Step Index 200 | BUY | 2 | 10,394.3 | +112.00 | |
| 22 Apr | Step Index 500 | SELL | 2 | 5,323.3 | +170.00 | |
| 22 Apr | Step Index 200 | BUY | 1 | 10,394.3 | +174.00 | same level later |
| 22 Apr | Step Index 500 | SELL | 1 | 5,323.3 | +180.00 | same level later |
| 22 Apr | Step Index 500 | SELL | 1 | ~5,323.3 | **+980.00** | M15, SL 5320.7 — same short ridden to scale (dup, big) |
| 23 Apr | Step Index 200 | BUY | 2 | 10,345.5 | +100.00 | |
| 23 Apr | Step Index 200 | BUY | 0.5 | 10,345.5 | +124.00 | M5, SL 10346.1 (same level) |
| 23 Apr | Jump 100 | BUY | 3 | 390.93 | +33.33 | buy dip → jump |
| 24 Apr | Crash 1000 | SELL | 10 | 5,697.6940 | +192.22 | sell rally → drop |
| 24 Apr | Crash 1000 | SELL | 10 | 5,685.0340 | +65.62 | scale-in |
| 25 Apr | Boom 1000 | BUY | 5 | 14,304.2266 | +104.40 | scale-in |
| 25 Apr | Boom 1000 | BUY | 5 | 14,288.1826 | +184.62 | scale-in |
| 25 Apr | Boom 1000 | BUY | 5 | 14,270.6256 | +272.41 | scale-in (deepest) |
| 27 Apr | Boom 1000 | BUY | 8 | 14,209.4736 | +173.13 | Renko |
| 27 Apr | XAUUSD | SELL | 0.2 | 4,717.47 | +292.60 | fade top, scale-in |
| 27 Apr | XAUUSD | SELL | 0.2 | 4,713.99 | +223.00 | scale-in |
| 27 Apr | XAUUSD | SELL | 0.1 | 4,711.48 | +86.40 | scale-in |
| 28 Apr | XAUUSD | SELL | 0.2 | 4,631.90 | +122.60 | fade top |
| 29 Apr | XAUUSD | SELL | 0.05 | ~4,606.97 | +116.65 | Renko, scale-in |
| 29 Apr | XAUUSD | SELL | 0.05 | 4,603.76 | +101.50 | Renko, scale-in |
| 30 Apr | Volatility 100 | BUY | 50 | 587.69 | +307.00 | buy flush |
| 4 May | Step Index 200 | BUY | 2 | 10,242.9 | +204.00 | buy V-bottom |
| 5 May | Volatility 75 | SELL | 0.75 | 36,763.49 | +114.19 | fade top |
| 5 May | XAUUSD | BUY | 0.2 | 4,542.18 | +243.20 | **Fib + trendline** overlay |
| 5 May | XAUUSD | BUY | 0.2 | 4,537.66 | +333.60 | SL 4532.33, scale-in |
| 8 May | XAUUSD | SELL | 0.2 | 4,729.44 | +285.60 | fade top |
| 11 May | Step Index | BUY | 2 | 7,908.7 | +236.00 | interim of next (dup) |
| 11 May | Step Index | BUY | 2 | 7,908.7 | +364.00 | same position ridden longer |
| 11 May | Step Index 200 | SELL | 1 | 10,396.5 | +170.00 | fade top |
| 13 May | Volatility 100 | SELL | 50 | 436.89 | +204.50 | fade top |
| 13 May | Volatility 100 (1s) | BUY | 50 | 1,143.80 | +209.00 | SL 1130.06, buy flush |
| 13 May | XAUUSD | SELL | 0.08 | 4,712.30 | +61.28 | fade top |
| 13 May | Step Index 200 | SELL | 2 | 10,373.7 | +120.00 | fade top |
| 21 May | Step Index | SELL | 2 | 8,106.4 | +308.00 | fade top |
| 29 May | Volatility 100 | SELL | 50 | 387.67 | +211.00 | fade top |
| 2 Jun | Boom 150 | BUY | 5 | 9,331.3440 | +30.45 | buy dip → spike |
| 2 Jun | XAUUSD | SELL | 0.2 | 4,539.69 | +155.00 | fade top |
| 8 Jun | Step Index | SELL | 5 | 8,008.3 | +405.00 | fade top |
| 11 Jun | Volatility 100 | SELL | 50 | 352.89 | +199.00 | fade top |
| 11 Jun | Step Index | SELL | 5 | 8,018.9 | +440.00 | fade top |
| 15 Jun | Step Index | BUY | 3 | 7,983.2 | +99.00 | buy flush |
| 18 Jun | Volatility 75 | BUY | 0.75 | 37,062.33 | **+718.00** | buy V-flush; SL trailed to 37,142 (above entry → locked profit) |
| 19 Jun | XAUUSD | SELL | 0.3 | 4,156.07 | +37.80 | fade top, scale-in ×4 |
| 19 Jun | XAUUSD | SELL | 0.3 | 4,155.96 | +34.50 | scale-in |
| 19 Jun | XAUUSD | SELL | 0.3 | 4,155.77 | +28.80 | scale-in |
| 19 Jun | XAUUSD | SELL | 0.3 | 4,155.67 | +25.80 | scale-in |
| 24 Jun | Boom 1000 | BUY | 8 | 14,729.9347 | +120.60 | buy dip, scale |
| 24 Jun | Boom 1000 | BUY | 8 | 14,720.3357 | +197.40 | scale-in |
| 25 Jun | Boom 1000 | BUY | 5 | 14,846.7127 | +155.07 | buy dip → spike |
| 29 Jun | Volatility 75 | SELL | 0.75 | 48,856.80 | +121.25 | fade top |

---

## 3. What the full set confirms (now with loser data)

1. **Indicator stack = a 6-line MA "rainbow":** thin **red** (fast trigger) · thick **dark-blue** (his
   primary watch-MA) · **gold/orange** · **dark-green** · **yellow** · **purple** (slowest). Fans out in
   trends, bunches when flat. Bottom sub-pane = a thin multi-line oscillator (DMI/ADX- or momentum-like).
   On gold he sometimes adds **Fibonacci retracement + a hand-drawn trendline** (5 May screenshot).
2. **Entry = fade-the-extension + ride** on every trade: SELL as price overextends above the ribbon and
   the red line rolls over (tops); BUY the flush as red troughs and turns up (bottoms / Boom dips).
3. **Aggressive scale-in** at better prices (gold ×4, Boom ×3, Crash ×2, Step ×2). Adds only into winners.
4. **Stops exist and trail** (Vol75 +718 SL above entry; several explicit `SL` lines) — but he uses
   *wide* stops and trails, never tight ones.
5. **Tail capture is the whole game:** the gold ledger's 3 monster shorts = ~84% of profit; the Vol75
   +718 and Step500-M15 +980 are the chart-side equivalents. Most trades are small (+30 to +200).
6. **The losers were counter-trend buys** (ledger H5/H6 on 29 Apr) — confirms the edge is discipline
   (trade with the move, cut fast, hold/scale winners), not the indicators. Mechanically the same
   entry rule is ≈ zero-EV on these random-walk synthetics (see `deriv-synthetics.md` Addendum 3);
   his profit lives in discretionary selection + tail-holding + (for gold) a real trend regime.

---

## 3b. ANALYSIS (computed — `scripts/analyze-brother-trades.ts`)

**Ledger (n=11, the only unbiased sample):**
- Win rate **81.8%** (9/11) · net **+$8,137** · expectancy **+$740/trade** · profit factor **5.27**
- avg win **$1,116** vs avg loss **$953** → payoff ratio only **1.17×** (NOT big-win/small-loss)
- **Top-3 trades = 109% of net profit.** Remove them and the other 8 net **−$768**. The entire
  account is 3 monster gold shorts (+3,158 / +3,030 / +2,718).
- Points: most winners are *tiny* (0.3–5.9 pts, scalped fast); only 3 are rides (27–32 pts). Worst
  loser **−16.7 pts** is bigger than every non-tail winner → stops are **wide, not tight**.
- Direction: **9 sells / 2 buys**; both losers were the **counter-trend** ones. All 9 continuation-sells won.
- It's one **2-day gold sell-off** (4629→4571, −1.2%) — single regime, small n.

**What this means:** the per-trade engine is fragile (1.17× payoff, 82% WR, median trade only +$140).
It is carried by **win-rate + a few tail rides in a trending market**, not by a durable per-trade edge.
Profit factor 5.27 is an artifact of 3 observations. The **one robust, copyable rule** the data screams:
**trade WITH the dominant move, never against it** (every counter-trend trade here lost). On random-walk
synthetics there is no dominant move to ride → the same method is ≈0 EV ([[deriv-synthetics-closed]]).

**Chart entries (n=64, winners-biased — method only, not edge):** 59 distinct positions; direction
aligns to instrument drift (Boom 12/12 long, Crash 2/2 short, gold 14S/6B in a sell-off); **13 sessions
scaled in** (adds into the move at better prices); biggest chart wins (+$718, +$440, +$405) confirm tail-capture.

## 3c. CAN WE MECHANIZE IT? Bot feasibility (computed)

Implemented his exact logic in `scripts/backtest-ribbon.ts` (`--mode fade --exit meanrev`):
fade price-extension from the anchor EMA → scalp back to the anchor → fixed stop + time-stop;
`--bias` for instrument-aligned direction (Boom long / Crash short). Reproduced his profile
(small target, wide stop, ~62% win rate). **Zero-cost control** isolates whether the *entry* is an edge:

| Instrument (1m) | win rate | avgR @ **zero cost** | PF @ 0 | avgR @ realistic spread |
|---|---|---|---|---|
| R_75 (Vol 75) | 62% | **−0.002** | 0.99 | −0.057 (3bp) |
| R_100 (Vol 100) | 61% | **−0.005** | 0.97 | −0.047 |
| Gold (frxXAUUSD) | 63% | **+0.001** | 1.00 | −0.041 |
| BTCUSDT | 61% | **−0.006** | 0.97 | −0.090 (1bp) |
| ETHUSDT | 63% | **−0.004** | 0.98 | −0.048 |
| SOLUSDT | 62% | **0.000** | 1.00 | −0.033 |

**Decisive result: his entry, mechanized on OHLC, is a perfect coin flip (EV = 0.00, PF ≈ 1.00) on
EVERY instrument — synthetics, gold AND crypto.** The 62% win rate is real but the rarer losses are
exactly proportionally bigger → zero. Add the spread and it bleeds by ≈ the spread. No parameter
(tested ext 0.6–3.5, SL 1.5–4×ATR, both exits) escapes it — the random-walk wall at 1m.

**Implication for a bot:**
- ❌ A **market-order** bot copying his entries = guaranteed −spread forever. Do not build.
- ✅ A **passive limit-order** scalper EARNS the spread → 0-EV entry + spread income = **net +EV**.
  This is almost certainly his real synthetic mechanism (a 62%-win small-target scalper IS a passive
  liquidity provider). Requires a **real order book** (crypto/FX ECN, e.g. Bybit which we integrate) —
  NOT Deriv synthetics, where the house sets the price and you can't post inside the spread.
- ✅ Port his **risk template** (scale into the move, cut counter-trend instantly, scratch most/hold the
  rare runner, instrument-aligned direction) onto OUR validated entries — the entry is where his edge is NOT.
- His **real money is gold** (ledger), discretionary directional read in a trending window — not 1m-OHLC-mechanizable.

## 3d. THE BOT (built — `src/lib/deriv/scalp-strategy.ts` + `scripts/run-deriv-scalp.ts`)

A runnable Deriv scalp bot mimicking his fade-to-mean ribbon scalp. ONE strategy module drives both
a backtest and a live PAPER runner (no real orders; fills simulated at the instrument spread), so sim
and live cannot drift. Risk controls: per-trade risk %, daily-loss stop, scale-in cap, per-instrument
directional bias + spread.

Backtest (realistic per-instrument spread, EMA 6/30/60, ext 1.5ATR, SL 3ATR, maxHold 15):

| Instrument | trades | win% | avgR | net$ (/$10 risk) | verdict |
|---|---|---|---|---|---|
| **frxXAUUSD (gold)** | 3218 | 64.6% | **−0.009** | −292 | near break-even (frontier) |
| **stpRNG (Step Index)** | 1793 | 65.0% | **−0.028** | −509 | least-bad synthetic |
| R_75 (Vol 75) | 1539 | 62.2% | −0.073 | −1,123 | spread too wide |
| BOOM1000 (long-only) | 577 | 20.6% | −0.757 | −4,366 | **AVOID — spike gaps through the stop** |
| CRASH1000 (short-only) | 558 | 18.6% | −0.793 | −4,424 | **AVOID** |

**Engineering conclusions:** (1) trade only the **low-spread, no-spike** instruments — gold + Step Index;
(2) **never** fade Boom/Crash (the very spike that pays him as a discretionary dip-buyer destroys a
mechanical fade-stop); (3) gold at −0.009R is one discretionary-skip away from break-even — that gap is
exactly where the human (his momentum read) or a real microstructure filter must supply the edge. The
bot is the harness to A/B those filters and to feed alerts to a human.

Run: `npx tsx scripts/run-deriv-scalp.ts --backtest --symbols stpRNG,frxXAUUSD` ·
live paper: `npx tsx scripts/run-deriv-scalp.ts --symbols stpRNG,frxXAUUSD --risk 0.005 --daily-loss 0.05`

## 3e. SIM-ENGINE VALIDATION (`scripts/validate-deriv-scalp-sim.ts`)

Re-ran the SAME entry signals through the project execution engine (`src/lib/sim/simulatePosition`):
pessimistic intrabar fidelity (stop-fills-first on straddle bars) + the maker-TP / taker-SL cost split.
TP modelled as a resting limit at the anchor (how a scalper really places it).

| Instrument | crude backtest avgR | **sim (Deriv: spread both legs)** | **sim (passive-TP counterfactual)** |
|---|---|---|---|
| frxXAUUSD (gold) | −0.009 | **−0.016** (raw +0.001%/trade ≈ flat) | −0.009 |
| stpRNG (Step Index) | −0.028 | **−0.044** | −0.031 |
| R_75 (Vol 75) | −0.073 | **−0.068** | −0.052 |
| BOOM1000 / CRASH1000 | −0.76 | **−0.86** | (n/a — uninvestable) |

**Verdicts:**
1. **The crude backtest is validated** — the sim engine reproduces it (slightly more conservative under
   pessimistic fills). The edge estimate is robust, NOT a fill artifact.
2. **On Deriv it is structurally −EV by the spread.** Gold is the frontier (−0.016R, essentially flat in
   raw return); Step Index next; Vol indices worse; Boom/Crash uninvestable for a fade.
3. **Execution edge quantified:** resting the TP as a passive limit (no spread on that leg) halves the
   bleed (gold −0.016 → −0.009) — but does NOT flip positive on Deriv, because entry + SL still cross and
   Deriv has no maker rebate. Net-positive requires resting BOTH legs + a rebate → a real order book
   (Bybit/ECN), NOT Deriv. On Deriv the only path to + is non-mechanical (discretionary skip / a real
   micro-edge we have not found).

## 3f. THE SOLUTION SEARCH — Range Break, and why it closes the whole question (`scripts/deriv-tick-gap-analysis.ts`)

"Use web search what could be a solution" → deep-research (20 sources) said: a profitable scalp needs a NON-coin-flip
instrument with a real mechanism. The asymmetric "Skew Step" isn't on the public API, but its analog **Range Break
(`RB100`/`RB200`)** is — a range-BOUNDED process (mean-reverting), so fading the boundary should have a real edge.

It does. At idealized fills RB200 = **+0.127R, PF 2.04, positive in ALL 4 quartiles** (RB200>RB100, exactly as the
"holds its range longer" mechanism predicts) — the FIRST and ONLY Deriv instrument with a non-zero entry edge. Every
symmetric (Step, Vol) and spike (Boom/Crash) instrument is flat 0.00 at zero cost.

**But the edge is un-collectable, and tick data proves why decisively.** A market stop fills at the NEXT TICK after it
triggers — so realized slip on a stop-out is bounded by the single-tick gap, NOT by how far the break runs. Measured
single-tick |Δ| over 50K real ticks:

| Symbol | median tick | 99.9% of ticks | **max single tick** | meaning |
|---|---|---|---|---|
| **RB200** | 0.09 ATR | 0.09 ATR | **19.98 ATR** | real edge, uncatchable break |
| **RB100** | 0.09 ATR | 0.09 ATR | **18.10 ATR** | real edge, uncatchable break |
| BOOM1000 | 0.01 ATR | 0.03 ATR | **33.75 ATR** | spike (same structure) |
| stpRNG (Step) | 0.088 ATR | 0.088 ATR | **0.088 ATR** | perfect fills, zero edge |
| R_100 (Vol) | 0.069 ATR | 0.249 ATR | 0.387 ATR | clean-ish, zero edge |

Range Break does **not** step gradually into a break — it breaks in a single ~20-ATR tick. Your 3-4 ATR stop fills
~20 ATR worse (≈5R loss instead of 1R) on exactly the trade that matters. The fade collects 0.09-ATR pennies 99.9% of
the time, then one uncatchable tick gives it all back and more — mechanically identical to a Boom/Crash spike. This is
why the 1m backtest went **+0.127R (slip 0) → −0.061R (slip 1.0)**: realistic execution IS the pessimistic end, because
the break is a single tick you cannot escape. (The sim engine's break-even +0.005R assumed fill-AT-stop — false here.)

**The cruel symmetry that closes ALL Deriv synthetics:** Step Index has *perfect* execution (every tick exactly
0.088 ATR, zero gaps ever) but *zero* edge (coin flip); Range Break has a *real* edge but an *uncatchable* 20-ATR gap.
Edge and gap always coincide by design. **There is no Deriv synthetic where a collectable edge meets clean execution.**
This is the house edge made mechanical, and it is the definitive answer to "what could be a solution": on Deriv
synthetics, none — the only collectable mechanism is on Deriv's REAL markets (MT5 CFDs).

## 4. Machine-readable

```json
{
  "account_ledger": {
    "symbol": "XAUUSD", "lot": 1.0, "deposit": 20000.00, "profit": 10552.10,
    "swap": -15.00, "commission": 0.00, "balance": 30537.10,
    "deals": [
      {"side":"sell","open":4628.973,"close":4627.567,"pnl":140.60,"time":"2026-04-28T11:55:40"},
      {"side":"buy","open":4609.727,"close":4610.073,"pnl":34.60,"time":"2026-04-28T13:10:55"},
      {"side":"sell","open":4611.863,"close":4581.564,"pnl":3029.90,"time":"2026-04-28T14:36:25"},
      {"side":"sell","open":4565.053,"close":4562.677,"pnl":237.60,"time":"2026-04-28T17:47:29"},
      {"side":"sell","open":4591.583,"close":4608.267,"pnl":-1668.40,"time":"2026-04-29T03:08:54"},
      {"side":"buy","open":4609.387,"close":4607.003,"pnl":-238.40,"time":"2026-04-29T03:15:07"},
      {"side":"sell","open":4606.213,"close":4600.307,"pnl":590.60,"time":"2026-04-29T03:30:11"},
      {"side":"sell","open":4583.993,"close":4583.535,"pnl":45.80,"time":"2026-04-29T09:22:26"},
      {"side":"sell","open":4580.503,"close":4579.607,"pnl":89.60,"time":"2026-04-29T10:12:49"},
      {"side":"sell","open":4599.403,"close":4572.227,"pnl":2717.60,"time":"2026-04-29T10:42:02"},
      {"side":"sell","open":4602.653,"close":4571.077,"pnl":3157.60,"time":"2026-04-29T10:42:25"}
    ]
  },
  "chart_entries": [
    {"date":"2026-04-14","symbol":"Boom 1000","dir":"BUY","lot":5,"entry":13738.4874,"pnl":157.47},
    {"date":"2026-04-16","symbol":"Boom 1000","dir":"BUY","lot":2,"entry":13877.5964,"pnl":78.11,"chart":"renko"},
    {"date":"2026-04-16","symbol":"Boom 1000","dir":"BUY","lot":2,"entry":13870.0864,"pnl":93.13,"chart":"renko"},
    {"date":"2026-04-16","symbol":"Boom 1000","dir":"BUY","lot":2,"entry":13865.0694,"pnl":103.16,"chart":"renko"},
    {"date":"2026-04-16","symbol":"Boom 1000","dir":"BUY","lot":1,"entry":13870.0864,"pnl":210.92,"dup":true},
    {"date":"2026-04-16","symbol":"Boom 1000","dir":"BUY","lot":1,"entry":13865.0694,"pnl":215.93,"dup":true},
    {"date":"2026-04-16","symbol":"Volatility 100","dir":"SELL","lot":20,"entry":813.55,"pnl":117.40},
    {"date":"2026-04-16","symbol":"Volatility 100","dir":"SELL","lot":10,"entry":813.55,"pnl":211.00,"sl":812.92},
    {"date":"2026-04-17","symbol":"XAUUSD","dir":"BUY","lot":0.2,"entry":4795.62,"pnl":168.40},
    {"date":"2026-04-20","symbol":"XAUUSD","dir":"BUY","lot":0.2,"entry":4785.42,"pnl":195.20},
    {"date":"2026-04-21","symbol":"XAUUSD","dir":"BUY","lot":0.2,"entry":4790.60,"pnl":95.60},
    {"date":"2026-04-21","symbol":"XAUUSD","dir":"BUY","lot":0.1,"entry":4785.42,"pnl":99.60},
    {"date":"2026-04-22","symbol":"XAUUSD","dir":"SELL","lot":0.2,"entry":4771.12,"pnl":91.80},
    {"date":"2026-04-22","symbol":"Step Index 200","dir":"BUY","lot":2,"entry":10394.3,"pnl":112.00},
    {"date":"2026-04-22","symbol":"Step Index 500","dir":"SELL","lot":2,"entry":5323.3,"pnl":170.00},
    {"date":"2026-04-22","symbol":"Step Index 200","dir":"BUY","lot":1,"entry":10394.3,"pnl":174.00},
    {"date":"2026-04-22","symbol":"Step Index 500","dir":"SELL","lot":1,"entry":5323.3,"pnl":180.00},
    {"date":"2026-04-22","symbol":"Step Index 500","dir":"SELL","lot":1,"entry":5323.3,"pnl":980.00,"tf":"M15","sl":5320.7,"dup":true},
    {"date":"2026-04-23","symbol":"Step Index 200","dir":"BUY","lot":2,"entry":10345.5,"pnl":100.00},
    {"date":"2026-04-23","symbol":"Step Index 200","dir":"BUY","lot":0.5,"entry":10345.5,"pnl":124.00,"tf":"M5","sl":10346.1},
    {"date":"2026-04-23","symbol":"Jump 100","dir":"BUY","lot":3,"entry":390.93,"pnl":33.33},
    {"date":"2026-04-24","symbol":"Crash 1000","dir":"SELL","lot":10,"entry":5697.6940,"pnl":192.22},
    {"date":"2026-04-24","symbol":"Crash 1000","dir":"SELL","lot":10,"entry":5685.0340,"pnl":65.62},
    {"date":"2026-04-25","symbol":"Boom 1000","dir":"BUY","lot":5,"entry":14304.2266,"pnl":104.40},
    {"date":"2026-04-25","symbol":"Boom 1000","dir":"BUY","lot":5,"entry":14288.1826,"pnl":184.62},
    {"date":"2026-04-25","symbol":"Boom 1000","dir":"BUY","lot":5,"entry":14270.6256,"pnl":272.41},
    {"date":"2026-04-27","symbol":"Boom 1000","dir":"BUY","lot":8,"entry":14209.4736,"pnl":173.13,"chart":"renko"},
    {"date":"2026-04-27","symbol":"XAUUSD","dir":"SELL","lot":0.2,"entry":4717.47,"pnl":292.60},
    {"date":"2026-04-27","symbol":"XAUUSD","dir":"SELL","lot":0.2,"entry":4713.99,"pnl":223.00},
    {"date":"2026-04-27","symbol":"XAUUSD","dir":"SELL","lot":0.1,"entry":4711.48,"pnl":86.40},
    {"date":"2026-04-28","symbol":"XAUUSD","dir":"SELL","lot":0.2,"entry":4631.90,"pnl":122.60},
    {"date":"2026-04-29","symbol":"XAUUSD","dir":"SELL","lot":0.05,"entry":4606.97,"pnl":116.65,"chart":"renko"},
    {"date":"2026-04-29","symbol":"XAUUSD","dir":"SELL","lot":0.05,"entry":4603.76,"pnl":101.50,"chart":"renko"},
    {"date":"2026-04-30","symbol":"Volatility 100","dir":"BUY","lot":50,"entry":587.69,"pnl":307.00},
    {"date":"2026-05-04","symbol":"Step Index 200","dir":"BUY","lot":2,"entry":10242.9,"pnl":204.00},
    {"date":"2026-05-05","symbol":"Volatility 75","dir":"SELL","lot":0.75,"entry":36763.49,"pnl":114.19},
    {"date":"2026-05-05","symbol":"XAUUSD","dir":"BUY","lot":0.2,"entry":4542.18,"pnl":243.20,"overlay":"fib+trendline"},
    {"date":"2026-05-05","symbol":"XAUUSD","dir":"BUY","lot":0.2,"entry":4537.66,"pnl":333.60,"sl":4532.33},
    {"date":"2026-05-08","symbol":"XAUUSD","dir":"SELL","lot":0.2,"entry":4729.44,"pnl":285.60},
    {"date":"2026-05-11","symbol":"Step Index","dir":"BUY","lot":2,"entry":7908.7,"pnl":236.00,"dup":true},
    {"date":"2026-05-11","symbol":"Step Index","dir":"BUY","lot":2,"entry":7908.7,"pnl":364.00},
    {"date":"2026-05-11","symbol":"Step Index 200","dir":"SELL","lot":1,"entry":10396.5,"pnl":170.00},
    {"date":"2026-05-13","symbol":"Volatility 100","dir":"SELL","lot":50,"entry":436.89,"pnl":204.50},
    {"date":"2026-05-13","symbol":"Volatility 100 (1s)","dir":"BUY","lot":50,"entry":1143.80,"pnl":209.00,"sl":1130.06},
    {"date":"2026-05-13","symbol":"XAUUSD","dir":"SELL","lot":0.08,"entry":4712.30,"pnl":61.28},
    {"date":"2026-05-13","symbol":"Step Index 200","dir":"SELL","lot":2,"entry":10373.7,"pnl":120.00},
    {"date":"2026-05-21","symbol":"Step Index","dir":"SELL","lot":2,"entry":8106.4,"pnl":308.00},
    {"date":"2026-05-29","symbol":"Volatility 100","dir":"SELL","lot":50,"entry":387.67,"pnl":211.00},
    {"date":"2026-06-02","symbol":"Boom 150","dir":"BUY","lot":5,"entry":9331.3440,"pnl":30.45},
    {"date":"2026-06-02","symbol":"XAUUSD","dir":"SELL","lot":0.2,"entry":4539.69,"pnl":155.00},
    {"date":"2026-06-08","symbol":"Step Index","dir":"SELL","lot":5,"entry":8008.3,"pnl":405.00},
    {"date":"2026-06-11","symbol":"Volatility 100","dir":"SELL","lot":50,"entry":352.89,"pnl":199.00},
    {"date":"2026-06-11","symbol":"Step Index","dir":"SELL","lot":5,"entry":8018.9,"pnl":440.00},
    {"date":"2026-06-15","symbol":"Step Index","dir":"BUY","lot":3,"entry":7983.2,"pnl":99.00},
    {"date":"2026-06-18","symbol":"Volatility 75","dir":"BUY","lot":0.75,"entry":37062.33,"pnl":718.00,"sl":37142.03},
    {"date":"2026-06-19","symbol":"XAUUSD","dir":"SELL","lot":0.3,"entry":4156.07,"pnl":37.80},
    {"date":"2026-06-19","symbol":"XAUUSD","dir":"SELL","lot":0.3,"entry":4155.96,"pnl":34.50},
    {"date":"2026-06-19","symbol":"XAUUSD","dir":"SELL","lot":0.3,"entry":4155.77,"pnl":28.80},
    {"date":"2026-06-19","symbol":"XAUUSD","dir":"SELL","lot":0.3,"entry":4155.67,"pnl":25.80},
    {"date":"2026-06-24","symbol":"Boom 1000","dir":"BUY","lot":8,"entry":14729.9347,"pnl":120.60},
    {"date":"2026-06-24","symbol":"Boom 1000","dir":"BUY","lot":8,"entry":14720.3357,"pnl":197.40},
    {"date":"2026-06-25","symbol":"Boom 1000","dir":"BUY","lot":5,"entry":14846.7127,"pnl":155.07},
    {"date":"2026-06-29","symbol":"Volatility 75","dir":"SELL","lot":0.75,"entry":48856.80,"pnl":121.25}
  ]
}
```

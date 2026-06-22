# Order-Flow Microstructure Feature Pipeline (study DEFERRED)

**Status:** Infrastructure built + unit-tested. **No predictive verdict drawn.**
**Date:** 2026-06-14

This documents a reusable order-flow feature-extraction pipeline built ahead of
the data. It is INFRASTRUCTURE only — the predictive, net-of-cost study is
deliberately deferred (see "Deferred study" below).

---

## 1. Grounding — Order Flow Imbalance (OFI)

Cont, Kukanov & Stoikov, **"The Price Impact of Order Book Events"**, *Journal
of Financial Econometrics* 12(1):47–88 (2014). arXiv:1011.6402 ; SSRN 1712822.

Classical **OFI** is the cumulative sum of **signed best-bid/ask queue-size
changes** over a time interval, computed event-by-event from L1 order-book
updates. It *increases* when the bid size increases, the ask size decreases, or
the best bid/ask **price** moves up; it *decreases* on the opposite events.

Empirical result: a near-**linear contemporaneous** relation between OFI and
price change, with slope **inversely proportional to market depth**; the paper
reports **R² ≥ 50% for 44/50 stocks**.

**Caveat (critical for honesty):** that R² is a *contemporaneous* fit and is
**partly tautological** — the order-book events that move price ARE the OFI. A
high contemporaneous R² is **NOT a free forecast** of future returns. Nothing in
this pipeline claims predictive power.

Sources:
- https://academic.oup.com/jfec/article-abstract/12/1/47/816163
- https://arxiv.org/pdf/1011.6402
- https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1712822

---

## 2. The data we actually store (inspected, not assumed)

Collector: `scripts/collect-btc-orderflow.ts` subscribes to Bybit's free L2
order book (50 levels) + public trades + liquidations and appends **one
aggregated NDJSON line per second**.

**Exact JSON keys per snapshot** (verified by reading the real file):

| Field        | Meaning                                                        | Always present? |
|--------------|----------------------------------------------------------------|-----------------|
| `ts`         | epoch ms (`Date.now()`)                                        | yes             |
| `mid`        | (bestBid + bestAsk) / 2                                         | yes             |
| `spreadBps`  | (bestAsk − bestBid)/mid × 1e4, basis points                    | yes             |
| `bidDepth5`  | summed size over top **5** bid levels (BTC)                    | yes             |
| `askDepth5`  | summed size over top **5** ask levels (BTC)                    | yes             |
| `imb5`       | (bidDepth5 − askDepth5)/(sum), top-5 imbalance ∈ [−1, 1]        | yes             |
| `imb25`      | top-**25**-level book imbalance ∈ [−1, 1]                      | yes             |
| `buyVol`     | aggressor-buy (taker) volume since prev snapshot (BTC)         | yes             |
| `sellVol`    | aggressor-sell (taker) volume since prev snapshot (BTC)        | yes             |
| `tradeCount` | public trades since prev snapshot                              | yes             |
| `liqBuy`     | forced shorts (buy-side liquidations), BTC                     | **OPTIONAL**    |
| `liqSell`    | forced longs (sell-side liquidations), BTC                     | **OPTIONAL**    |
| `liqCount`   | liquidation events since prev snapshot                         | **OPTIONAL**    |

> **Schema is not uniform.** In `BTCUSDT_2026-06-11.ndjson`: 27,238 lines carry
> the `liq*` fields, 20,917 do not (the collector only emits them after it has
> seen liquidation events). The parser therefore treats `liqBuy/liqSell/liqCount`
> as **optional** and leaves them `undefined` when absent — it does NOT silently
> default them to 0, which would corrupt any future forced-flow study.

### Computable vs NOT computable from 1s snapshots

| Feature | Computable? | Why / caveat |
|---|---|---|
| Book imbalance (imb5 / imb25) | **Yes, directly** | precomputed in the schema; also re-derivable from depth aggregates |
| CVD (cumulative volume delta) | **Yes** | `buyVol`/`sellVol` are aggressor-signed taker volume per 1s window |
| Snapshot-OFI **proxy** | **Yes (proxy)** | Δ top-5 depth between consecutive 1s snapshots — see §3 |
| True **event-level** OFI | **NO** | needs L1 event stream + best-level queue sizes; we store neither |
| True Stoikov microprice | **NO** | needs best-bid/ask **size**; we store only top-5/25 depth aggregates |
| Microprice **proxy** | **Yes (proxy)** | substitutes `bidDepth5`/`askDepth5` for L1 queue size — skew attenuated |
| Forced-flow / liquidation features | **Partly** | only when `liq*` present; sparse and optional |

---

## 3. Features built — `src/lib/microstructure/`

All numeric functions are **pure, typed (no `any`), IO-free**. IO is isolated in
a separate file.

- `parseSnapshotLine(line)` → typed `Snapshot`. Validates core fields are finite;
  optional `liq*` stay `undefined` when absent.
- `snapshotOFI(prev, cur)` → **snapshot-level OFI PROXY**. `value = ΔbidDepth5 −
  ΔaskDepth5` following the CKS sign convention (rising bid depth positive,
  rising ask depth negative). `midDirection` is surfaced separately as a
  cross-check. **This is an approximation:** aggregated top-5 depth stands in for
  the L1 best-level queue, and a 1s window collapses many events into one delta.
- `cvdDelta(snapshot)` = `buyVol − sellVol`; `cumulativeCVD(snapshots)` = running
  sum (CVD through index *i*).
- `microprice(bid, ask, bidSize, askSize)` = `(ask·bidSize + bid·askSize)/(bidSize
  + askSize)` — exact Stoikov size-weighted mid, for **L1 data** (e.g. the live
  bot's book state); cannot be fed from snapshots because L1 sizes aren't stored.
- `micropriceFromDepth(snapshot)` — microprice PROXY: reconstruct bid/ask from
  `mid ± ½·spread` and use `bidDepth5/askDepth5` as queue-size proxies.
- `bookImbalance(snapshot, levels)` reads stored `imb5`/`imb25`;
  `bookImbalanceFromDepth` re-derives top-5 imbalance from depth as a cross-check.
- `loadOrderflowDay(filePath, opts)` (in `load-orderflow.ts`) — **IO helper**,
  streams an NDJSON day file line-by-line into `Snapshot[]`; `skipMalformed`
  drops a truncated trailing line (the collector appends live).

---

## 4. End-to-end sanity check on the REAL file (NOT a study)

Loaded `data/orderflow/BTCUSDT_2026-06-11.ndjson` through the full pipeline:

```
snapshots:           48,155
mean spreadBps:      0.0204
snapshotOFI range:   [-223.832, 381.642]
microprice range:    [62315.02, 63879.93]
imb5 range:          [-1.000, 0.999]
final cumulativeCVD: 2942.225 BTC  (descriptive only)
```

All features finite (no NaN) across all 48,155 snapshots; `imb5` stays within
[−1, 1]; microprice stays within the day's mid range. This confirms the pipeline
**runs correctly at scale**. These are **descriptive sanity stats only** — they
make **no claim** about predictiveness, edge, or Sharpe.

---

## 5. Deferred study (explicit)

> **Predictive, net-of-cost study DEFERRED until ≥30–60 days of data accrue.**
> Current data is ~2–3 days (`BTCUSDT_2026-06-11/-12/-14.ndjson`) — **underpowered**.
> The project canon forbids drawing underpowered microstructure verdicts, and the
> prior is **already negative** (OBI/CVD scalp **OOS Sharpe 0.12**). The collector
> continues to accumulate 1s snapshots (today's file is actively growing). **The
> pipeline is ready; the verdict is not drawn.**

When ≥30–60d are collected, the study must: define a strictly *forward* target
(future mid return over a fixed horizon), respect realistic taker fees + spread,
walk-forward / OOS split, and clear the canon's bars (PBO, DSR, MC) before any
edge claim — exactly as every other strategy family in this repo.

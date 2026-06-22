# ICT on Gold: Signal vs Execution Layer — external validation research

**Date**: 2026-06-11. 5-thread deep web research (~170 tool calls), adversarial
cross-checking. Companion to KNOWLEDGE.md §5 and practitioner-mechanisms.md.

## Verdict on our thesis: PARTIALLY SUPPORTED + one material correction

**Confirmed — ICT-as-signal is refuted everywhere we looked:**
- ZERO peer-reviewed/replicated/audited evidence for OB, FVG, BOS/CHoCH as
  directional signals, any instrument. Our 40-experiment gold null is the most
  rigorous test of ICT structure on gold in existence, public or academic.
- FVG "fills" claim inverts: 60-63% go UNfilled same-session (Edgeful YM data).
- Vendor's own full-stack SMC backtest on BTC: +1.1% net over 5 YEARS (null).
- Huddleston's verifiable record: demo-account "$5k→$1M" challenge drawn down
  ~92%; 2017 Robbins Cup >60% DD; 2024 Robbins Cup account BLOWN. Every 60-80%
  WR claim traces to course/indicator sellers.
- Best pro-ICT datapoint (Kyle Ng/JadeCap, $2.55M Apex payout confirmed):
  attributes edge to risk management/session selection/patience — ICT as chart
  VOCABULARY, not mechanical signal. That IS our thesis, embodied.

**Confirmed — our mechanism edges have direct academic backing:**
- Overnight gold hold: Blose/Gondhalekar/Kort 2018 (J Econ&Fin) — overnight
  positive/day negative across COMEX+ETFs, survives costs. PEER-REVIEWED
  support for our biggest session-book leg.
- Fix windows: Caminschi&Heaney 2014; LBMA reform 2015-03 changed regime —
  our sample is 2015-01+ (essentially all post-reform; 2020-26 half positive
  standalone) → edge is post-reform validated already.
- Stop clustering: Osler 2003/2005 (J Finance, JIMF) — real dealer books,
  stops cluster past round numbers.
- WHY structure fails on gold but works on crypto: 60-78% of gold turnover is
  invisible London OTC; discovery is news/fix/algo-flow keyed to TIME and VOL
  (Hauptfleisch+ 2016). On crypto the visible exchange book IS the market.

## THE CORRECTION (changes our experiment design)
Documented post-sweep direction is **CONTINUATION for ~2h** (Osler 2005:
trends accelerate through stop clusters, p<0.001%; Savaser: stops amplify news
moves; ORB literature trades WITH the open expansion). Reversal exists only:
(a) AT levels before breach (take-profit clusters) — dies in <30 min;
(b) after liquidation OVERSHOOTS in HIGH-VOL states (Nagel RFS 2012;
    Brunnermeier-Pedersen predatory trading; BIS sterling flash study).
Unconditional Turtle-Soup sweep-fade graded "D" across 42 futures (Oxfordstrat).
→ A timing layer must be a STATE-CONTINGENT flush entry with reversion
confirmation, never "fade every sweep". Our CMA-ES keeping liquiditySweep on
gold ≈ proxy for "liquidation just happened" state, consistent with Nagel.

## Execution-layer mechanics (academic support + refutations)
- SUPPORTED: microstructure signals in order placement reduce adverse selection
  (Cartea-Donnelly-Jaimungal); execution is the main cost lever (AQR $1.7T
  live data); realistic prize is SINGLE-DIGIT bps per entry.
- REFUTED: naive resting limits — conditional on fill you pay ~the spread
  (arXiv 2407.16527); >90%-fill-prob orders have negative markouts.
→ Test design: taker entries on confirmation, fallback-to-clock (caps missed-
  fill cost), identical exposure windows both arms, vol-state stratification,
  compute minimum detectable effect (bps-scale).

## Experiment program (designs per research recommendations)
1. Overnight-entry timing A/B — clock 18:05 ET vs sweep-flush+reversion-bar
   trigger in first 90min, fallback to clock; stratify by vol tercile.
   STRONGEST prior (base edge peer-reviewed; Nagel state-dependence).
2. Fix-short + pre-fix sweep — log entry-improvement AND conditional hit-rate
   separately (Savaser warns the sweep may predict continuation = weak filter,
   not timing).
3. Daily bias + LTF FVG/OB fill — designated FALSIFICATION ARM (gold structure
   has no documented information; FVG fill base rate ~37-39%). One pass,
   pre-registered, no parameter search.

# XAUUSD (Gold) ICT Model Research

> Compiled: Feb 2026. Sources from academic papers, institutional reports, and market microstructure analysis.

---

## 1. Gold Market Microstructure

### Session Structure (3-Act Daily Play)

Gold trades in a predictable 3-act session structure, unlike 24/7 crypto:

| Session | Time (NY) | Time (London) | Role | Gold Behavior |
|---------|-----------|---------------|------|---------------|
| **Asian** | 7pm-12am | 12am-5am | Accumulation | Quiet range-building. Institutions build positions. Asian physical demand (China, India) sets floor. |
| **London** | 2am-5am | 7am-10am | Expansion | Range breaks. LBMA AM fix (5:30am NY / 10:30am London) sets daily reference. Highest initial momentum. |
| **NY** | 8am-12pm | 1pm-5pm | Distribution/Continuation | LBMA PM fix (10am NY / 3pm London). COMEX volume peaks. US data releases. |
| **London-NY Overlap** | 8am-12pm | 1pm-5pm | Peak liquidity | Spreads tighten to <$0.30/oz. **60%+ of daily range** occurs here. Institutional order flow most pronounced. |
| **Dead Zone** | 12pm-7pm NY | 5pm-12am | Low activity | Widening spreads, thin liquidity, false moves. |

**Key**: The London-NY overlap (8am-12pm NY / 1pm-5pm London) is when bid-ask spreads hit daily lows (<$0.30/oz) and institutional order flow is most pronounced. Both European banks/hedge funds and US market makers are active simultaneously.

Sources:
- [Best XAUUSD Trading Hours (EBC)](https://www.ebc.com/forex/what-are-the-best-xauusd-trading-hours)
- [NordFX Gold Session Guide](https://nordfx.com/en/traders-guide/best-time-to-trade-gold-xauusd-sessions-volatility-news)
- [GoldViewFX Trading Sessions](https://www.tradingview.com/chart/XAUUSD/wpy7txCe-GoldViewFX-TRADING-SESSIONS-TIME-ZONE/)

### LBMA Fix Mechanism

The London Bullion Market Association conducts electronic auctions twice daily:
- **AM Fix**: 10:30am London (5:30am NY) — among major bullion banks
- **PM Fix**: 3:00pm London (10:00am NY) — the primary benchmark

The LBMA Gold Price replaced the century-old telephone-based "London Fix" in 2015. It's the formal benchmark used for settlement, accounting, fund valuation, and physical delivery contracts.

**Fix process**: The difference between supply and demand must be less than 50 bars (~620kg) for price discovery completion. This creates a **microstructure event** — concentrated institutional flow at specific times.

Sources:
- [LBMA Alchemist - PM Fix](https://www.lbma.org.uk/alchemist/issue-73/has-there-been-a-decade-of-london-pm-gold-fixing-manipulation)
- [How Global Gold Spot Pricing Works](https://goldenarkreserve.com/blog/how-global-gold-spot-pricing-works-lbma-comex-otc/)

### COMEX-LBMA Basis (EFP)

Exchange For Physical (EFP) allows traders to switch between COMEX futures and LBMA physical positions. The COMEX-LBMA spread typically averages $3.84/oz but can blow out dramatically:
- **Aug 2025**: Premium exceeded $100/oz due to tariff fears and metal movements between London and NY vaults
- **Jan 2025**: EFP activity surged as risk managers moved metal to US vaults

The basis trade signals:
- **Widening basis** → market stress, physical demand, potential directional move
- **Tight basis** → normal market conditions, arbitrage keeping prices aligned

Sources:
- [LBMA Jan 2025 Volumes (Nasdaq)](https://www.nasdaq.com/articles/lbma-precious-metals-market-volumes-for-january-2025-and-their-significance)
- [LBMA-COMEX Premium (Kitco)](https://www.kitco.com/news/article/2025-01-31/lbma-says-its-working-comex-us-gold-price-premium-insists-london-stocks-and)

---

## 2. Academic Research on Gold Price Patterns

### LBMA PM Fix Anomaly (Abrantes-Metz & Metz, NYU)

**Study period**: 2001-2013 intraday gold data

**Key findings**:
- Large price moves during PM fix (3pm London / 10am NY) were **overwhelmingly downward**
- Pattern emerged in 2004, no obvious explanation for why
- In **2010**: large moves were negative **92% of the time**
- Pattern was more prevalent in PM fix than AM fix
- Appeared in at least two-thirds of the time in six different years between 2004-2013

**Regulatory outcome**:
- $152M in collective fines across Barclays, Deutsche Bank, HSBC, Société Générale (2014-2015)
- Led to replacement of telephone-based fix with electronic auction in 2015
- Prof. Abrantes-Metz now advises the EU on financial benchmarks

**Trading implication**: The PM fix window (10am NY) creates a predictable volatility event. Whether the post-reform pattern persists needs validation in our 2024-2026 data.

Sources:
- [LBMA Alchemist Issue 73](https://www.lbma.org.uk/alchemist/issue-73/has-there-been-a-decade-of-london-pm-gold-fixing-manipulation)
- [Gold London Bias](https://www.goldpriceforecast.com/explanations/gold-london-bias/)
- [NYU Faculty News](https://www.stern.nyu.edu/experience-stern/news-events/prof-rosa-abrantes-metz-discusses-london-gold-fix)

### JP Morgan Spoofing ($920M Settlement)

JP Morgan paid $920.2M for spoofing gold and Treasury futures (2008-2016). Two former traders convicted in 2022.

**Spoofing mechanism**: Placing huge orders in the futures market with intent to cancel, skewing displayed order volume in the limit order book to persuade market participants to trade in the spoofer's desired direction. Illegal under Dodd-Frank Act since 2010.

**Academic analysis**: Wiley paper "Unravelling the JPMorgan spoofing case using particle physics visualization methods" (Debie, 2023) analyzed the order book manipulation patterns.

**Trading implication**: Understanding that institutional players can and do create artificial order book patterns is relevant for any model relying on volume or order flow signals.

Sources:
- [JP Morgan Spoofing Case (Wiley)](https://onlinelibrary.wiley.com/doi/10.1111/eufm.12353)
- [Gold Market Manipulation Guide](https://discoveryalert.com.au/gold-price-manipulation-modern-markets-2025/)

### London Bias Pattern

Statistical regularity: gold prices tend to **decline during London trading hours** (especially around PM fix) and **rise during Asian trading hours**.

**Possible explanations**:
1. Higher afternoon liquidity + US market opening = institutional selling
2. Commercial participants (central banks, miners) are natural sellers
3. Asian physical demand creates buying pressure overnight

**Status**: The pattern was documented pre-2015 fix reform. Post-reform data (2015-2026) needs validation.

### Gold's Positive Skewness (Unique Among Assets)

Gold has **positive skewness** in return distributions:
- **Equities (S&P 500)**: Negative skewness — large downside moves
- **Forex (JPY/USD)**: Negative skewness
- **Gold**: Positive skewness — occasional large upside moves

This is because gold serves as a flight-to-safety asset: when markets are stressed, gold spikes upward (safe-haven flows), creating fat right tails.

**Trading implications**:
- Long positions have structurally favorable skew
- Stop losses on longs get hit less often than normal distribution suggests
- Take profits on longs should be wider (fat right tail pays for patience)
- Short positions face blowup risk from sudden safe-haven spikes
- Any model should have **long bias** or at minimum asymmetric R:R (wider TP on longs)

Source: [Verdad Research - Skewness and Kurtosis](https://verdadcap.com/archive/skewness-and-kurtosis)

---

## 3. Calendar Anomalies

### Day-of-Week Effects

From analysis of GLD (Nov 2004 - Dec 2023, 19 years):

| Day | GLD Avg Return | GDX Avg Return | GDXJ Avg Return |
|-----|---------------|----------------|-----------------|
| Monday | **-0.01%** | **-0.12%** | -0.03% |
| Tuesday | +0.04% | +0.08% | +0.02% |
| Wednesday | +0.03% | +0.04% | +0.04% |
| Thursday | +0.01% | +0.01% | -0.02% |
| Friday | **+0.11%** | **+0.11%** | +0.09% |

**Explanation**: Large investors buy gold before weekends for geopolitical protection, then sell Monday morning to reallocate to risk assets. Friday demand pushes prices up; Monday liquidation pushes down.

### Monthly Seasonality

| Month | GLD Avg Return | Hit Rate |
|-------|---------------|----------|
| **January** | **+3.31%** | 13/19 positive |
| February | +0.76% | 12/19 positive |
| March | -0.37% | 9/19 positive |
| April | +0.72% | 12/19 positive |
| **May** | **-0.54%** | 8/19 positive |
| June | +0.89% | 12/19 positive |
| July | +0.52% | 10/19 positive |
| August | +1.06% | 11/19 positive |
| **September** | **-0.66%** | 8/19 positive |
| October | +0.31% | 10/19 positive |
| November | +0.82% | 12/19 positive |
| December | -0.19% | 9/19 positive |

**Academic backing**: "The Seasonality of Gold - The Autumn Effect" (ResearchGate) found September and November are the only months with statistically significant gold price changes (at conventional levels).

### Halloween Effect

| Period | GLD Return | GDX Return | GDXJ Return |
|--------|-----------|-----------|-------------|
| **Nov-Apr (Winter)** | **+8.10%** | +8.99% | +3.44% |
| May-Oct (Summer) | +1.20% | -4.00% | -5.51% |
| **Difference** | **6.90pp** | 12.99pp | 8.95pp |

### Turn-of-Month Effect

Elevated returns on last day of month and first 2 days of new month:
- Day -1 (month end): up to +0.20%
- Day +1 (month start): up to +0.77% (GDXJ)
- Day +2: positive across all instruments

Source: [In Gold We Trust Report - Calendar Anomalies](https://ingoldwetrust.report/nuggets/calendar-anomalies-and-the-gold-market/?lang=en)

---

## 4. Macro Regime Signals

### DXY-Gold Correlation Breakdown (2024-2025)

Traditional inverse correlation (-0.45 rolling 60d) **broke** in 2023-2025:
- Both gold and DXY rose simultaneously
- 60-day rolling correlation swung from -0.72 to just above zero
- Driven by: central bank buying + de-dollarization + sovereign debt fears

**The old "short gold when DXY rises" model is dead in this regime.**

New regime drivers:
1. Central bank demand (structural, not cyclical)
2. Geopolitical risk premium
3. Real yield dynamics (gold attractive when real yields fall)
4. De-dollarization trend (China, Turkey, emerging markets)

Sources:
- [CME Gold-Dollar Evolving Relationship](https://www.cmegroup.com/openmarkets/metals/2025/Gold-and-the-US-Dollar-An-Evolving-Relationship.html)
- [US Dollar Index Decoupling (Investing.com)](https://www.investing.com/analysis/us-dollar-index-trends-show-decoupling-from-treasury-yields-and-gold-200668670)

### VIX as Gold Signal

- VIX spike >20-25 = risk-off regime → gold demand increases
- **VIX up + yields falling** = strongest gold-long setup
- Sustained VIX spikes signal institutional hedging and defensive rotation
- When interest rate uncertainty (MOVE index) is high, yield drag on gold diminishes

### Shanghai Gold Premium

The SGE (Shanghai Gold Exchange) premium over LBMA is a powerful demand signal:

| SGE Premium Level | Signal | Gold Price Impact |
|-------------------|--------|-------------------|
| >1% | Strong Chinese demand | **+$33 avg in next month** |
| Discount | Weak demand | +$2 avg in next month |
| >$20-50/oz | Intense physical demand | Often precedes global rally |

**Why it works**: China is the world's largest gold consumer (>1,000 tonnes annually). Import restrictions and PBOC quotas create supply shortages. When SGE trades at premium, it signals real physical demand from the largest buyer.

China was paying premiums up to **$39/oz above spot** at peak demand periods.

Sources:
- [LBMA - Links Between Chinese and International Gold Prices](https://www.lbma.org.uk/alchemist/issue-83/links-between-the-chinese-and-international-gold-prices)
- [World Gold Council - China's Gold Market](https://www.gold.org/goldhub/gold-focus/2023/10/chinas-gold-market-september-local-premium-rocketed-and-demand-continued)

### COT (Commitment of Traders) Positioning

CFTC COT report for gold futures:

**Key insight** (Bessembinder & Chan, 1992 seminal study): Commercial hedgers have **superior forecasting ability** compared to speculators, with statistically significant predictive power at extreme levels.

| Signal | Condition | Implication |
|--------|-----------|-------------|
| Managed money extreme long | Record net long positions | Correction likely |
| Managed money extreme short | Record net short positions | Bottom signal |
| Commercial hedger extreme short | Unusually heavy hedging | Bearish medium-term |
| Commercial hedger reducing shorts | Hedgers unwinding | Bullish medium-term |

**Caveat**: COT data is weekly (released Friday for Tuesday snapshot), so it's a medium-term signal, not intraday.

Sources:
- [CFTC COT Report Guide (Substack)](https://jinlow.substack.com/p/understanding-the-cftc-cot-report)
- [CFTC Gold Positions (MacroMicro)](https://en.macromicro.me/series/8308/gold-futures-and-options-manage-money-net-position)

### Central Bank Buying (Structural Shift)

Central banks have been net purchasers of gold for **15 consecutive years**, with annual acquisitions surpassing 1,000 tonnes in 2022, 2023, and 2024.

| Central Bank | 2024 Buying | Total Holdings | Notes |
|-------------|-------------|----------------|-------|
| **China (PBOC)** | 44 tonnes reported | 2,296 tonnes | 7 straight months through May 2025. Actual holdings likely much higher. |
| **Turkey** | 2nd largest buyer | 623.92 tonnes | 26 consecutive months of buying. Mandated 20% bank reserves in gold. |
| **India (RBI)** | Top 5 buyer | ~800+ tonnes | Diversifying from USD |
| **Poland** | Top 5 buyer | 420+ tonnes | Largest EU accumulator |

**Q3 2025**: Net purchases of 220 tonnes (28% increase from prior quarter).

**Trading volume**: Record $561 billion/day in October 2025. COMEX volume +49%, Shanghai Futures Exchange +86%.

**Trading implication**: This is a structural demand floor. Central bank buying is not price-sensitive — they buy regardless of price level. This supports gold's positive skewness and long bias.

Sources:
- [World Gold Council - Central Bank Statistics](https://www.gold.org/goldhub/gold-focus/2025/01/central-bank-gold-statistics-november-2024)
- [SSGA Gold Monitor Feb 2026](https://www.ssga.com/library-content/products/fund-docs/etfs/us/insights-investment-ideas/monthly-gold-monitor.pdf)
- [Gold Rush: Central Banks Record Demand](https://markets.financialcontent.com/stocks/article/marketminute-2025-12-9-gold-rush-continues-central-banks-fueling-record-precious-metal-demand-signaling-major-economic-shifts)

---

## 5. ICT-Specific Gold Strategies

### ICT Asian Range Model

**Definition**: The Asian Range is the price range formed during 7:00pm to midnight NY time. ICT teaches that this range represents institutional accumulation before the volatile London and NY sessions.

**Strategy flow**:
1. Mark Asian range high and low (7pm-12am NY)
2. Wait for price to **sweep** beyond one boundary (liquidity grab)
3. Look for **Market Structure Shift (MSS)** confirming reversal
4. Enter on pullback to **Order Block** or **FVG** formed after sweep
5. Stop loss at sweep extreme
6. Target: opposite Asian range boundary (conservative) or next liquidity pool (aggressive)

**Best execution window**: Near the transition into London session (2-5am NY), as higher liquidity validates breakouts.

Source: [ICT Asian Range Strategy](https://tradingfinder.com/education/forex/ict-asian-range-trading-strategy/)

### ICT Silver Bullet for Gold

ICT Silver Bullet identifies specific time windows with highest probability:
- **10:00-11:00am NY** — NY morning Silver Bullet (coincides with PM fix)
- **2:00-3:00pm NY** — afternoon Silver Bullet
- **3:00-4:00am NY** — London morning Silver Bullet

The strategy works by:
1. Identifying FVG formed within the Silver Bullet window
2. Price returns to FVG (consequent encroachment)
3. Enter with direction aligned to higher timeframe bias

Gold reportedly responds well to Silver Bullet entries due to institutional flow concentration at these times.

Source: [ICT Silver Bullet Strategy Guide](https://innercircletrader.net/tutorials/ict-silver-bullet-strategy/)

### ICT Kill Zones for Gold

Standard ICT kill zones align well with gold's session structure:

| Kill Zone | Time (NY) | Gold Relevance |
|-----------|-----------|----------------|
| **London Open** | 2:00-5:00am | **Critical** — first major liquidity injection, Asian range breaks |
| **NY Open** | 8:00-11:00am | **Critical** — COMEX opens, US data, PM fix window |
| **London Close** | 10:00am-12:00pm | Important — overlaps with NY, profit-taking from London positions |
| **Asian** | 8:00pm-12:00am | **Underrated for gold** — Asian physical demand, accumulation |

Source: [Master ICT Kill Zones](https://innercircletrader.net/tutorials/master-ict-kill-zones/)

### SMC/ICT Gold Backtesting Framework

From professional backtesting guides:
1. Identify untapped liquidity from previous session highs/lows
2. Wait for sweep of those levels
3. Confirm with FVG displacement
4. Enter on FVG retracement
5. Trade ONLY London/NY session windows
6. Exit at opposite liquidity pools or unfilled imbalances

**Reported performance**: Win rates of 70-77% when filtered by institutional timing windows (backtested 2022-2025). However, these claims need independent validation.

Sources:
- [Gold SMC Backtesting Guide (LiquidityFinder)](https://liquidityfinder.com/news/the-ultimate-guide-to-backtesting-and-trading-gold-xau-usd-using-smart-money-concepts-smc-c33b2)
- [Goldmine Strategy Backtest (Medium)](https://medium.com/coinmonks/how-to-backtest-the-goldmine-strategy-for-consistent-gold-profits-bfa20d0925eb)

---

## 6. Professional Gold Algo Benchmarks

### Pullback-Window State Machine (5yr Backtest)

From [GitHub: backtrader-pullback-window-xauusd](https://github.com/ilahuerta-IA/backtrader-pullback-window-xauusd):

| Metric | Value |
|--------|-------|
| Total Return | +44.75% ($44,747) |
| Sharpe Ratio | 0.892 |
| Win Rate | 55.43% (97W/78L) |
| Profit Factor | 1.64 |
| Max Drawdown | 5.81% |
| Total Trades | 175 (~3/month) |
| Period | July 2020 - July 2025 |

**Strategy**: 4-phase state machine (SCANNING → ARMED → WINDOW_OPEN → ENTRY). EMA crossover detection → pullback confirmation → volatility expansion channel breakout. Stop: 2.5x ATR, TP: 12x ATR.

**Key insight**: The state machine patience mechanism prevents false entries in gold's choppy ranges. This is relevant — any gold model needs a confirmation step, not raw signal → entry.

### Sentiment + Technical Hybrid (Academic, 2024)

From [ScienceDirect: Analytical Framework for Real-Time Gold Trading](https://www.sciencedirect.com/science/article/pii/S277266222500089X):

Used FinBERT sentiment analysis + RSI/EMA technical indicators on XAU/USD during September 2024. Outperformed ARIMA and basic ML methods. Academic validation of combining sentiment with technical signals for gold.

---

## 7. Gold vs Crypto vs Forex Comparison

| Characteristic | Crypto (BTC/ETH) | Forex (EUR/GBP) | Gold (XAUUSD) |
|---|---|---|---|
| **Median ATR%** | 1.5-2.5% | 0.05-0.08% | 0.75-1.2% |
| **Correct volatilityScale** | 1.0 | 0.05-0.10 | 0.5-0.8 |
| **Kill zone importance** | Low (24/7) | High | **Very high** |
| **Best kill zone weight** | 0.814 | ~2.0 | **2.5-3.0** |
| **Regime distribution** | Trending | 95% ranging+low | Mixed (trending + ranging) |
| **Friction (per side)** | 0.07% | 0.03% | 0.01-0.02% |
| **Return skewness** | Mixed | Negative | **Positive** (fat right tail) |
| **Session structure** | None (24/7) | 3 sessions | **3-act play** (accum/expand/distrib) |
| **Institutional events** | None | Rate decisions | **LBMA fix** (2x daily), COMEX, FOMC |
| **Physical demand signal** | N/A | N/A | **Shanghai premium** |
| **Positioning data** | Limited | Limited | **COT report** (weekly) |
| **Safe haven flows** | No | Partial (JPY, CHF) | **Primary safe haven** |
| **Central bank demand** | No | Indirect | **1000+ tonnes/year** structural |
| **Optimal strategy** | OB trend-following | Session breakout | **Asian range sweep → reversal** |

---

## 8. Key Insights for Model Design

### What Makes Gold Different (Summary)

1. **Gold is session-driven, not trend-driven** — Asian range → London expansion → NY distribution. Kill zones are the PRIMARY signal, not a minor confluence factor.

2. **LBMA fix creates predictable microstructure events** — 10:30am and 3:00pm London. Concentrated institutional flow at known times.

3. **Positive skewness means long bias** — Gold spikes up during stress. Longs have structural advantage. Any model should have wider TP on longs.

4. **Calendar effects are real** — Monday negative, Friday positive, January strong, September weak. These are decade-long patterns with institutional explanations.

5. **DXY correlation broke** — Don't use dollar as inverse signal in current regime. Central bank buying is the dominant driver now.

6. **Shanghai premium is a leading indicator** — Premium >1% → gold +$33 next month. Physical demand from world's largest consumer.

7. **Professional algos use patience mechanisms** — State machines, confirmation steps, session filters. Raw signal → entry doesn't work on gold due to choppy ranging behavior.

8. **Lower friction = lower bar for edge** — Gold's 0.02% per side (vs crypto 0.07%) means weaker statistical edges can still be profitable.

### What to Validate in Our Data

Before building any model, verify in `data/GC_F_1h.json`:
- [ ] Asian range gets broken in London session >=50% of days
- [ ] London and NY overlap shows highest hourly volatility
- [ ] Monday returns are negative, Friday positive
- [ ] OB/FVG detection rates per session
- [ ] Regime distribution (trending vs ranging ratio)
- [ ] LBMA PM fix hour (10am NY) shows elevated volatility
- [ ] Sweep → reversal pattern has positive expected value

---

## 9. Future Research Directions

These signals are NOT included in the initial model but could be added as overlays:

1. **DXY regime filter** — Avoid trades when DXY and gold are in unusual correlation regime
2. **VIX threshold** — Boost long bias when VIX >25 + yields falling
3. **COT extreme filter** — Weekly signal: reduce exposure at managed money extremes
4. **Shanghai premium** — Daily signal: boost long bias when premium >1%
5. **LBMA fix fade** — Trade the PM fix reversal pattern (if it persists post-reform)
6. **Seasonal filter** — Reduce size in May-October, increase in November-April
7. **Turn-of-month effect** — Boost size on last/first day of month
8. **Multi-timeframe** — 15m entries within 1h session framework (if Asian range detection is too coarse on hourly)
9. **Open interest divergence** — Rising OI + rising price = strong trend; rising OI + falling price = accumulation
10. **COMEX-LBMA basis** — Widening basis as market stress signal

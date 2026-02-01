# ICT (Inner Circle Trader) Complete Learning Roadmap

> A structured learning path for software engineers by complexity and dependencies.
> Estimated total time: 6-12 months (2-3 hours/day)

---

## Overview: Learning Phases

```
Phase 0: Prerequisites (1 week)
    │
    ▼
Phase 1: Foundation (2-4 weeks)
    │
    ▼
Phase 2: Core Concepts (4-6 weeks)
    │
    ▼
Phase 3: Market Structure (4-6 weeks)
    │
    ▼
Phase 4: Entry Models (4-6 weeks)
    │
    ▼
Phase 5: Time Theory (2-4 weeks)
    │
    ▼
Phase 6: Advanced Models (4-8 weeks)
    │
    ▼
Phase 7: Live Trading & Refinement (Ongoing)
```

---

## Phase 0: Prerequisites
**Duration:** 1 week | **Goal:** Basic trading literacy

### Topics:
- [ ] Candlestick basics (OHLC)
- [ ] Support/Resistance concept
- [ ] Trend basics (higher highs/lows)
- [ ] Fibonacci retracement tool usage
- [ ] TradingView basics

### Resources:
- Any basic candlestick course (YouTube, 2-3 hours)
- TradingView tutorial

---

## Phase 1: Foundation - "Why ICT Works"
**Duration:** 2-4 weeks | **Playlist:** "If I Could Go Back..." Series (7 videos)

### YouTube Playlist:
🔗 Search: `ICT "If I Could Go Back"` on Inner Circle Trader channel

### Concepts Learned:
| Concept | Description | Importance |
|---------|-------------|------------|
| Smart Money | Institutions vs Retail traders | ⭐⭐⭐⭐⭐ |
| Liquidity | Where stop losses cluster | ⭐⭐⭐⭐⭐ |
| Stop Hunts | How institutions trigger retail stops | ⭐⭐⭐⭐⭐ |
| Market Manipulation | Price moves are engineered | ⭐⭐⭐⭐⭐ |

### Milestone:
✅ Understand that price moves TO liquidity, not randomly

---

## Phase 2: Core Concepts - "Building Blocks"
**Duration:** 4-6 weeks | **Playlist:** Market Maker Primer Series (15+ videos)

### YouTube Playlist:
🔗 Search: `ICT Market Maker Series` or `ICT ForeXmas` on channel

### Concepts (Learn in Order):

#### 2.1 Market Structure
```
Swing Highs/Lows
    │
    ├── Higher High (HH)
    ├── Higher Low (HL)
    ├── Lower High (LH)
    └── Lower Low (LL)
    │
    ▼
Break of Structure (BOS) ──► Trend Continuation
Change of Character (CHoCH) ──► Trend Reversal
```

#### 2.2 Liquidity Concepts
| Type | Location | What Happens |
|------|----------|--------------|
| Buy-side Liquidity (BSL) | Above equal highs | Price sweeps up, then reverses down |
| Sell-side Liquidity (SSL) | Below equal lows | Price sweeps down, then reverses up |
| Inducement | Minor swing points | Traps early entries |

#### 2.3 Premium vs Discount
```
                    ┌─────────────────┐
                    │    PREMIUM      │  ← Sell Zone (above 50%)
                    │   (Expensive)   │
                    ├─────────────────┤ ← Equilibrium (50%)
                    │    DISCOUNT     │  ← Buy Zone (below 50%)
                    │    (Cheap)      │
                    └─────────────────┘
```

#### 2.4 Key Terms to Master:
- [ ] Swing Points
- [ ] BOS (Break of Structure)
- [ ] CHoCH (Change of Character)
- [ ] MSS (Market Structure Shift)
- [ ] EQH/EQL (Equal Highs/Lows)
- [ ] Premium/Discount Arrays
- [ ] Equilibrium (50% level)

### Milestone:
✅ Can identify market structure and liquidity pools on any chart

---

## Phase 3: Price Delivery - "Where Price Goes"
**Duration:** 4-6 weeks | **Playlist:** 2016 Core Content Month 1-4

### YouTube:
🔗 Search: `ICT Core Content Month 1` through `Month 4`

### 3.1 Order Blocks (OB)
```
Bullish Order Block:
    Last DOWN candle before UP move
    ┌───┐
    │ ▼ │ ← This is the OB
    └───┘
      │
      ▼
    ┌───┐┌───┐┌───┐
    │ ▲ ││ ▲ ││ ▲ │  (Strong up move)
    └───┘└───┘└───┘

Bearish Order Block:
    Last UP candle before DOWN move
    ┌───┐
    │ ▲ │ ← This is the OB
    └───┘
      │
      ▼
    ┌───┐┌───┐┌───┐
    │ ▼ ││ ▼ ││ ▼ │  (Strong down move)
    └───┘└───┘└───┘
```

### 3.2 Fair Value Gap (FVG) / Imbalance
```
Bullish FVG:
    Candle 1 High ─────┐
                       │ GAP (FVG)
    Candle 3 Low  ─────┘

    Price often returns to fill this gap
```

### 3.3 Breaker Blocks
```
Failed Order Block that becomes opposite zone:

    ┌───┐
    │OB │ ← Bullish OB forms
    └───┘
      │
      ▼ Price returns but BREAKS through
      │
    ══════ Now becomes Bearish Breaker (resistance)
```

### 3.4 Additional Blocks (Month 4):
| Block Type | Description |
|------------|-------------|
| Mitigation Block | OB that gets revisited |
| Rejection Block | Wick rejection zone |
| Vacuum Block | Rapid price movement zone |
| Propulsion Block | Strong momentum origin |

### Milestone:
✅ Can mark OBs, FVGs, and Breakers on charts accurately

---

## Phase 4: Entry Models - "When to Enter"
**Duration:** 4-6 weeks | **Playlist:** 2022 Mentorship (Episodes 1-20)

### YouTube Playlist:
🔗 `ICT 2022 Mentorship` - 41 videos total

### 4.1 Power of 3 / AMD (Accumulation-Manipulation-Distribution)
```
Daily Candle Structure:

    ASIA SESSION          LONDON SESSION       NEW YORK SESSION
    ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
    │             │      │             │      │             │
    │ Accumulate  │ ──►  │ Manipulate  │ ──►  │ Distribute  │
    │  (Range)    │      │ (Fake move) │      │ (Real move) │
    │             │      │             │      │             │
    └─────────────┘      └─────────────┘      └─────────────┘

    00:00-08:00 UTC      08:00-12:00 UTC      12:00-16:00 UTC
```

### 4.2 Optimal Trade Entry (OTE)
```
After CHoCH/MSS, wait for retracement:

    Swing High ────────────── 0%
         │
         │
         ├─────────────────── 62% ┐
         │    OTE ZONE            │ ENTRY ZONE
         ├─────────────────── 79% ┘
         │
    Swing Low ─────────────── 100%
```

### 4.3 Kill Zones (High Probability Times)
| Kill Zone | Time (UTC) | Time (EST) | Best For |
|-----------|------------|------------|----------|
| Asian | 00:00-04:00 | 7PM-11PM | Range identification |
| London Open | 07:00-10:00 | 2AM-5AM | First manipulation |
| NY Open | 12:00-15:00 | 7AM-10AM | Main move |
| NY PM | 18:00-20:00 | 1PM-3PM | Continuation |

### 4.4 Daily Bias
```
Determine BEFORE session starts:

Higher Timeframe (4H/Daily):
    │
    ├── Bullish Structure? ──► Look for LONGS only
    │
    └── Bearish Structure? ──► Look for SHORTS only
```

### Milestone:
✅ Can identify AMD setup and enter at OTE during kill zones

---

## Phase 5: Time Theory - "When Price Arrives"
**Duration:** 2-4 weeks | **Playlist:** 2022 Mentorship (Episodes 21-30)

### 5.1 ICT Time Concepts
| Concept | Description |
|---------|-------------|
| Macro Times | Specific 15-20 min windows for reversals |
| Quarterly Shifts | Every 3 months new trend |
| Monthly/Weekly Open | Key reference levels |
| True Day | 00:00 UTC to 00:00 UTC |

### 5.2 Key Macro Times (EST)
```
02:33 - 03:00  │ London Macro
04:03 - 04:30  │ London Close Macro
08:50 - 09:10  │ NY Open Macro  ← Most Important
09:50 - 10:10  │ NY Macro 2
10:50 - 11:10  │ NY Macro 3
13:10 - 13:40  │ PM Session Macro
```

### 5.3 IPDA (Interbank Price Delivery Algorithm)
```
Price seeks:
    1. Previous Day High/Low
    2. Previous Week High/Low
    3. Previous Month High/Low
    4. Liquidity pools
    5. FVGs/Imbalances

Within: 20/40/60 day look-back windows
```

### Milestone:
✅ Can time entries using macros and predict daily targets

---

## Phase 6: Advanced Models
**Duration:** 4-8 weeks | **Playlist:** 2022 Mentorship (Episodes 31-41) + 2016 Month 5-12

### 6.1 ICT Trading Models
| Model | Timeframe | Style |
|-------|-----------|-------|
| Scalping Model | 1m-5m | 5-15 pips |
| Silver Bullet | 15m | 10:00-11:00 AM EST specific |
| 2022 Model | 15m | Kill zone based |
| Swing Model | 4H-Daily | Multi-day holds |

### 6.2 Silver Bullet Strategy
```
Time: 10:00-11:00 AM EST (NY Session)

Setup:
    1. Wait for FVG to form in this window
    2. Enter on return to FVG
    3. Target: Opposing liquidity

    Simple and mechanical
```

### 6.3 Unicorn Model (Advanced)
```
Breaker + FVG Confluence:

    ┌─────────┐
    │ BREAKER │ ← Broken OB
    ├─────────┤
    │   FVG   │ ← Overlapping imbalance
    └─────────┘
         │
         ▼
    HIGH PROBABILITY ENTRY
```

### 6.4 SMT Divergence (Smart Money Technique)
```
Compare correlated pairs:

    ES (S&P)        NQ (Nasdaq)
    ────────        ──────────
    Higher High     NO Higher High ← DIVERGENCE
         │               │
         └───────────────┘
                 │
                 ▼
         Reversal Signal
```

### Milestone:
✅ Have 1-2 models mastered for consistent execution

---

## Phase 7: Live Trading & Refinement
**Duration:** Ongoing

### 7.1 Progression Path
```
Demo Trading (2-3 months)
    │
    ▼
Small Live Account (3-6 months)
    │
    ▼
Scale Up (After consistent profitability)
```

### 7.2 Journaling Requirements
Track every trade:
- [ ] Session (Asia/London/NY)
- [ ] Kill zone timing
- [ ] HTF bias
- [ ] Entry model used
- [ ] OB/FVG/Breaker type
- [ ] R:R achieved
- [ ] Screenshot with markup

### 7.3 Weekly Review
- Win rate by session
- Win rate by model
- Best performing kill zone
- Common mistakes

---

## Quick Reference: ICT YouTube Playlists

| Priority | Playlist | Videos | Focus |
|----------|----------|--------|-------|
| 1 | If I Could Go Back | 7 | Mindset |
| 2 | Market Maker Series | 15+ | Foundation |
| 3 | 2022 Mentorship | 41 | Complete System |
| 4 | Core Content 2016 | 115 | Deep Theory |
| 5 | 2024 Lectures | Ongoing | Advanced Time |

---

## Concept Dependency Graph

```
                        ┌──────────────┐
                        │  Candlesticks │
                        └──────┬───────┘
                               │
                        ┌──────▼───────┐
                        │Market Structure│
                        └──────┬───────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
       ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
       │  Liquidity  │  │Premium/Disc │  │   BOS/CHoCH │
       └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
              │                │                │
              └────────────────┼────────────────┘
                               │
                        ┌──────▼───────┐
                        │ Order Blocks  │
                        └──────┬───────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
       ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
       │    FVG      │  │   Breaker   │  │    OTE      │
       └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
              │                │                │
              └────────────────┼────────────────┘
                               │
                        ┌──────▼───────┐
                        │   AMD / PO3   │
                        └──────┬───────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
       ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
       │ Kill Zones  │  │  Time Theory │  │ Daily Bias  │
       └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
              │                │                │
              └────────────────┼────────────────┘
                               │
                        ┌──────▼───────┐
                        │Trading Models │
                        │(Silver Bullet,│
                        │ 2022 Model)   │
                        └──────────────┘
```

---

## Recommended Daily Schedule

```
Week 1-4:   2 videos/day + 1 hour chart review
Week 5-8:   1 video/day + 2 hours chart markup practice
Week 9-12:  Review + Demo trading kill zones
Week 13+:   Demo → Small live when consistent
```

---

## Resources

### Official
- YouTube: [The Inner Circle Trader](https://www.youtube.com/@InnerCircleTrader)
- Twitter/X: [@I_Am_The_ICT](https://twitter.com/I_Am_The_ICT)

### Community Notes
- [ICT Core Content Notes (Notion)](https://arjoio.notion.site/ICT-Core-Content-Notes-All-months-7ccee3fddff34d0cbb103f7c164ea9e1)
- [XWiki Study Guide](https://info.quagmyre.com/xwiki/bin/view/Forex/The-Inner-Circle-Trader/)

### Reviews
- [Trustpilot Reviews](https://www.trustpilot.com/review/theinnercircletrader.com)
- [ForexPeaceArmy Review](https://www.forexpeacearmy.com/forex-reviews/13001/inner-circle-trader-ICT)

---

## Your Trading System Integration

Your existing ICT trading system (`/Users/apple/projects/trading`) already implements:
- ✅ Market Structure (BOS/CHoCH)
- ✅ Order Blocks
- ✅ Fair Value Gaps
- ✅ Liquidity Detection
- ✅ Kill Zones
- ✅ OTE Zones

**Next steps for your system:**
1. Add Power of 3 / AMD detection
2. Add Silver Bullet time window alerts
3. Add SMT divergence between pairs
4. Add macro time highlighting

---

*Generated: January 2026*
*Based on ICT YouTube content analysis*

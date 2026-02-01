---
title: "Precision Market Structure"
slug: precision-market-structure
category: market-structure
source:
  type: youtube
  videoId: 8GkQfdAXZP0
  url: https://www.youtube.com/watch?v=8GkQfdAXZP0
  playlist: "ICT 2022 Mentorship"
  episode: 12
concepts:
  - swing-points
  - market-structure
  - time-frame-hierarchy
  - algorithm
difficulty: advanced
phase: 3
created: 2026-01-31
---

# Precision Market Structure

## Definition

Precision Market Structure is ICT's advanced approach to analyzing price action that goes beyond the simple "higher high, higher low" retail interpretation. It classifies swing points into a hierarchy (Long-Term, Intermediate Term, Short-Term) and uses Fair Value Gap rebalancing to identify key turning points.

## Core Philosophy

> "When we look at price we're not looking for just the simple higher high higher low therefore it's a bullish market or uptrend... I'm looking at does the market have a reason to go up for buy side liquidity or is it likely to go up to rebalance an imbalance?"

The market moves for two primary reasons:
1. **Liquidity** - Seeking stops above highs or below lows
2. **Rebalancing** - Filling Fair Value Gaps (imbalances)

## The Three Questions

Before every trade, ask:
1. Is price likely to go up for **buy stops** OR to **rebalance** a gap above?
2. Is price likely to go down for **sell stops** OR to **rebalance** a gap below?
3. What is the **current market narrative**?

## Swing Point Classification

### Long-Term High/Low (LTH/LTL)
- Framed by higher timeframe (daily chart) levels
- Often linked to significant support/resistance zones
- Parent of all subordinate swings
- Should NOT be broken if your analysis is correct

### Intermediate Term High/Low (ITH/ITL)
- Forms at the rebalancing of a Fair Value Gap
- Sits between two short-term highs/lows
- Key indicator of market direction when it fails to exceed adjacent swings

### Short-Term High/Low (STH/STL)
- Standard swing points (high with lower highs on both sides)
- Most frequently occurring swing type
- Used for immediate entry/stop placement

## Time Frame Hierarchy

```
Daily Chart (Parent)
    ↓ Frames the trade logic and bias
Hourly Chart (Framing)
    ↓ Provides the trade setup context
15-Minute Chart (Entry Bell-Weather)
    ↓ Signals get-in/get-out timing
5-Minute/1-Minute Chart (Precision)
    ↓ Reduces risk with tighter entries
```

### Key Principle
> "The daily chart that's exactly what institutions are working off of. That's exactly what banks are working off of. That's where the money is. That's where your bias is going to be determined."

## Order Block Refinement

In Precision Market Structure, the order block is NOT just the last up-close candle before a down move. Instead:

1. Watch for consecutive up-close candles moving into resistance
2. The ENTIRE range of those candles is the order block
3. Look for Fair Value Gaps WITHIN that order block range
4. Entry comes from FVGs inside the order block, not just the candle bodies

```
Traditional View:
    Only this candle → [Up-Close Candle]
                            ↓
                       [Down Move]

Precision View:
    Entire range → [Up Candle 1]
                   [Up Candle 2] ← Look for FVG entries inside here
                   [Up Candle 3]
                        ↓
                   [Down Move]
```

## Fractal Application

The same patterns repeat across timeframes:
- A small FVG rebalance on the 15-minute mirrors the larger FVG rebalance on the hourly
- ITH/ITL formation rules apply on all timeframes
- Lower timeframe provides precision; higher timeframe provides direction

## The Algorithm Perspective

> "If there's an algorithm that means it must follow some form of logic... it knows where people will have their stops based on these ideas: short-term high, short-term low, intermediate term high, intermediate term low, long-term low, long-term high, and where the imbalances are."

The algorithm references:
- Swing point levels for stop placement
- Imbalances that need to be rebalanced
- Standard deviation projections from key ranges

## Targeting Method

After a break below an Intermediate Term Low:
1. Identify the Long-Term High to Long-Term Low range
2. Anchor Fibonacci from the Intermediate Term High (where the decline starts) to the Long-Term Low
3. Project -1 to -1.5 standard deviation below
4. These projections become price targets

## Trading Application

1. **Daily Analysis**: Determine bias and identify key levels (FVGs, swing points)
2. **Hourly Framing**: Classify swings as LTH/LTL, ITH/ITL, STH/STL
3. **Wait for Rebalance**: Don't enter until FVG is rebalanced
4. **Classify the New Swing**: Is the ITH failing (not exceeding adjacent STHs)?
5. **Enter on Lower Timeframe**: Drop to 15-minute or lower for precision entry
6. **Target Using Range Projections**: Use the confirmed swing range for Fibonacci extensions

## Difference from Retail Analysis

| Retail Approach | Precision Approach |
|-----------------|-------------------|
| Higher high = bullish | What is causing the high? |
| Break of swing low = bearish | Which swing type broke? |
| Any swing high for entry | Only ITH/STH classified properly |
| Trend lines (subjective) | FVG rebalancing (objective) |
| Pattern recognition | Algorithmic reference points |

## Common Mistakes

- Looking only at higher high/higher low without context
- Not classifying swing types correctly
- Entering before FVG rebalance confirms the swing
- Ignoring the ITH relationship to adjacent STHs
- Trading against the daily chart bias

## Related Concepts

- [[intermediate-term-high-low]]
- [[fair-value-gap]]
- [[order-block]]
- [[market-structure-hierarchy]]
- [[swing-points]]

## Source Notes

> "We don't do technical analysis we do technical science... you have to be able to relate to certain things and measure what these factors are within price action which is not based on hypothetical guesswork."
> — ICT 2022 Mentorship Episode 12

> "I'm looking at the underpinnings of the marketplace and I'm examining what is it doing high to high low to low within a higher time frame premise."
> — ICT 2022 Mentorship Episode 12

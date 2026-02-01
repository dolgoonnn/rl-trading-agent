---
title: "Market Structure Hierarchy"
slug: market-structure-hierarchy
category: market-structure
source:
  type: youtube
  videoId: 8GkQfdAXZP0
  url: https://www.youtube.com/watch?v=8GkQfdAXZP0
  playlist: "ICT 2022 Mentorship"
  episode: 12
concepts:
  - swing-points
  - time-frame-hierarchy
  - market-structure
  - subordination
difficulty: advanced
phase: 3
created: 2026-01-31
---

# Market Structure Hierarchy

## Definition

Market Structure Hierarchy is the classification system for swing points based on their significance and relationship to higher timeframe levels. It establishes a parent-child relationship where higher timeframe structures dictate the behavior of lower timeframe swings.

## The Three Swing Types

### 1. Long-Term High/Low (LTH/LTL)

The most significant swing points, directly linked to higher timeframe levels:

- **Formation**: Framed by daily chart or higher timeframe reference points (FVGs, order blocks, liquidity pools)
- **Significance**: Defines the boundaries of the current trading range
- **Expectation**: Should NOT be broken if your higher timeframe analysis is correct
- **If Broken**: Your analysis is likely wrong - demand more information before trading

> "This now is a long-term high. I do not expect this high to be broken to the upside. Should it be broken to the upside that means that my daily analysis expecting this level to hold price... I'm probably wrong."

### 2. Intermediate Term High/Low (ITH/ITL)

The middle tier, formed at specific market events:

- **Formation**: Created at the rebalancing of a Fair Value Gap
- **Position**: Always sits between two short-term swing points
- **Key Feature**: When ITH fails to exceed adjacent STHs (or ITL fails to be lower than adjacent STLs), it signals directional bias
- **Use Case**: Primary swing for Fibonacci anchoring and projection

### 3. Short-Term High/Low (STH/STL)

The most frequently occurring swing points:

- **Formation**: Standard swing definition (higher lows on both sides for STL, lower highs for STH)
- **Frequency**: Most common, used for entry timing
- **Significance**: Breaking these triggers immediate price reactions
- **Use Case**: Entry and stop placement on execution timeframes

## Parent-Child Relationship

```
DAILY CHART (Parent - 100% control)
    │
    ├── Defines Long-Term Highs/Lows
    ├── Sets directional bias
    ├── Provides order flow context
    │
    ↓
HOURLY CHART (Child of Daily)
    │
    ├── All swings subordinate to daily levels
    ├── Frames ITH/ITL classification
    ├── Provides trade setup context
    │
    ↓
15-MINUTE CHART (Child of Hourly)
    │
    ├── Entry/exit timing
    ├── Short-term swing classification
    ├── Precision order block hunting
    │
    ↓
1-5 MINUTE CHART (Child of 15-minute)
        │
        ├── Final precision entries
        ├── Risk reduction
        └── Micro structure confirmation
```

## Subordination Principle

> "All minor lower time frame swings are going to be subordinate to [the higher timeframe]."

What this means:
1. Lower timeframe breaks do NOT invalidate higher timeframe structure
2. A break of a 15-minute STL while daily bias is bullish = buying opportunity, not trend change
3. The daily chart has "veto power" over all lower timeframe interpretations

## Volume Context

> "The daily chart has the bulk of the volume that's coming into that marketplace. There isn't a lot of volume coming in on a one minute chart."

Higher timeframe = More institutional volume = More significant levels

However, this doesn't reduce the utility of lower timeframes - they provide precision within the higher timeframe context.

## Practical Application

### Step 1: Daily Chart Analysis
- Identify the key FVG or order block
- Determine if price is heading to liquidity (stops) or rebalancing (FVG)
- This frames your Long-Term High and Long-Term Low

### Step 2: Hourly Chart Classification
```
Long-Term High ────────────────────
                ╲
                 ╲ Intermediate Term High (at FVG rebalance)
                  ╲
        Short-Term High
                   │
        Short-Term Low
                  ╱
                 ╱ Intermediate Term Low (at FVG rebalance)
                ╱
Long-Term Low ─────────────────────
```

### Step 3: Entry Timeframe (15-minute or lower)
- Wait for break of STH/STL
- Look for FVG formation on the break
- Enter on retrace into FVG
- Stop above/below the ITH/ITL

## Fibonacci Application

The hierarchy determines your Fibonacci anchoring:

```
For Bearish Projection:
┌─────────────────────────────┐
│                             │
│  ITH ←── Anchor point 1     │  This is where the
│   ↓                         │  decline BEGINS
│   ↓                         │
│   ↓                         │
│  LTL ←── Anchor point 2     │  Project -1 to -1.5
│                             │  standard deviation
└─────────────────────────────┘
```

NOT from the LTH to LTL, because the ITH is where the swing decline actually begins.

## Significant Break Criteria

A truly significant break in market structure occurs when:
- An Intermediate Term Low is broken (bearish)
- An Intermediate Term High is broken (bullish)

Simple short-term low breaks may just be discount buying opportunities in a bullish context.

## Framework vs Swing

Important distinction:
- **Framework** (LTH to LTL): The overall price range you're operating within
- **Swing** (ITH to LTL): Where the actual tradable move begins

> "This high and this low that's your framework. The retracement that fails that starts the decline begins here at that intermediate term high."

## Common Errors

1. **Treating all breaks equally**: STL break ≠ ITL break in significance
2. **Ignoring hierarchy**: Trading against daily bias based on 5-minute break
3. **Wrong Fibonacci anchoring**: Using LTH instead of ITH for projections
4. **Missing subordination**: Expecting lower timeframe to override higher

## Related Concepts

- [[intermediate-term-high-low]]
- [[precision-market-structure]]
- [[fair-value-gap]]
- [[market-structure-break]]
- [[swing-points]]

## Source Notes

> "The daily chart is the parent of this price structure... the subordination that the smaller time frame price swings adhere to from the higher time frame is directly linked to the order flow on those higher time frame charts."
> — ICT 2022 Mentorship Episode 12

> "If we have a break below any intermediate term low then we have what - a significant break in market structure. This is something that's more significant than just simply going into a chart saying 'okay well it took out a short-term low there it is' - uh-uh."
> — ICT 2022 Mentorship Episode 12

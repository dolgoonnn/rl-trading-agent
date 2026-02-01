---
title: "Fair Value Gap (FVG)"
slug: fair-value-gap
category: fair-value-gaps
source:
  type: youtube
  videoId: tmeCWULSTHc
  url: https://www.youtube.com/watch?v=tmeCWULSTHc
  playlist: "ICT 2022 Mentorship"
concepts:
  - imbalance
  - price-inefficiency
  - entry-model
difficulty: intermediate
phase: 2
created: 2026-01-11
---

# Fair Value Gap (FVG)

## Definition

A Fair Value Gap is a three-candle pattern where price moves so aggressively that it creates a gap between the first candle's wick and the third candle's wick. This gap represents an "imbalance" in price delivery that the market often returns to fill.

## Key Characteristics

- Created by strong one-directional moves
- Represents inefficient price delivery
- Algorithm seeks to "balance" these gaps
- Primary entry mechanism in ICT methodology

## Structure

### Bullish FVG (Buy Side Imbalance)
```
        │
    ┌───┴───┐  Candle 3
    │       │
    └───────┘
        ↑ GAP (FVG) - space between C1 high and C3 low
    ┌───────┐
    │       │  Candle 2 (large bullish candle)
    │       │
    └───┬───┘
    ┌───┴───┐  Candle 1
    │       │
    └───────┘
```
- Candle 1 HIGH to Candle 3 LOW = Fair Value Gap
- Entry: When price retraces DOWN into the gap

### Bearish FVG (Sell Side Imbalance)
```
    ┌───────┐  Candle 1
    │       │
    └───┬───┘
    ┌───┴───┐
    │       │  Candle 2 (large bearish candle)
    │       │
    └───────┘
        ↓ GAP (FVG) - space between C1 low and C3 high
    ┌───────┐
    │       │  Candle 3
    └───┬───┘
        │
```
- Candle 1 LOW to Candle 3 HIGH = Fair Value Gap
- Entry: When price retraces UP into the gap

## Trading Application

1. Wait for a break in market structure
2. Identify the FVG created during the break
3. Wait for price to retrace INTO the FVG
4. Enter in the direction of the break
5. Stop loss above/below the FVG

## Best Timeframes for FVG

- 1-minute, 2-minute, 3-minute charts are ideal for intraday
- High-frequency algorithms operate on these timeframes
- 5-minute may miss smaller imbalances

## Trading Rules

- FVG entry is AFTER market structure break, not before
- Enter as price moves INTO the gap (selling short as price rises)
- Don't chase - if price runs through the FVG, wait for next setup
- FVGs can be partially or fully filled
- Once filled, the imbalance is "balanced"

## Common Mistakes

- Entering before market structure break
- Waiting for "confirmation" instead of entering in the FVG
- Using FVGs on timeframes too high (missing the precision)
- Ignoring the directional context (weekly/daily bias)

## Related Concepts

- [[market-structure-break]]
- [[order-blocks]]
- [[premium-discount]]
- [[weekly-bias]]

## Source Notes

> "What's happening is the Market's going to go right up inside that area there and that's where you want to sell... this candle's low, this candle's high, and this right here is what I teach my students as a fair value Gap."
> — ICT 2022 Mentorship Episode 2

> "The one minute 2 minute 3 minute chart tends to be the best for finding the imbalances for indices... the high frequency trading algorithms are operating on nothing really higher than 3 minutes."
> — ICT 2022 Mentorship Episode 2

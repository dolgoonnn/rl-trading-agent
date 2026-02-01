---
title: "Order Block Confirmation with Fair Value Gap"
slug: order-block-confirmation
category: order-blocks
source:
  type: youtube
  videoId: tpPtItWqmlg
  url: https://www.youtube.com/watch?v=tpPtItWqmlg
  playlist: "ICT 2022 Mentorship"
  episode: 13
concepts:
  - order-block
  - fair-value-gap
  - liquidity
  - narrative
difficulty: advanced
phase: 3
created: 2026-01-31
---

# Order Block Confirmation with Fair Value Gap

## Definition

A high probability order block is NOT simply the last up-close candle before a down move (or vice versa). True order block confirmation requires three essential elements working together: the candle formation, a Fair Value Gap, and a clear liquidity narrative.

## The Three-Element Confirmation

### 1. The Order Block Candle
- **Bullish**: Down-close candle in a bullish market
- **Bearish**: Up-close candle in a bearish market

### 2. The Fair Value Gap (FVG)
The order block MUST have an imbalance created when price leaves it:
```
Bullish Order Block:
    [This candle's high]
         ↑
    ──── GAP ────  ← FVG must exist here
         ↑
    [Previous candle's low]
         ↑
    [Down-Close Candle] ← Order Block
```

### 3. The Narrative (Draw on Liquidity)
Price must have a reason to return to the order block:
- Buy-side liquidity above (for bullish)
- Sell-side liquidity below (for bearish)

## Key Rule

> "That is how you determine your high probability bullish order block - it must have the imbalance coupled with the down closed candle and the underlying narrative that it's likely to go higher to reach for buy side liquidity."

## Order Block Integrity Test

### Bullish Market
Down-close candles should NOT be violated:
- They act as support
- Price should respect them on retracements
- If violated, the bullish thesis may be wrong

### Bearish Market
Up-close candles should NOT be violated:
- They act as resistance
- Price should respect them on retracements
- If violated, the bearish thesis may be wrong

## The Judas Swing Context

Often, the best order block entries occur after a "Judas swing" at key times:

1. **Pre-9:30 AM Move**: Price may rally before equity open
2. **9:30 AM Opening**: Initial move lower (the fake-out)
3. **Order Block Entry**: Price retraces to OB with FVG
4. **True Direction**: Market reverses and runs toward liquidity

```
                    9:30 AM Open
                        ↓
    Rally Up         Drop Down        Rally to Target
    ┌──────┐         ┌──────┐         ┌──────────────┐
    │      │         │      │         │              │
────┘      └─────────┘      └─────────┘              │
                                                     │
                     OB + FVG Entry                  └→ Buy-side Liquidity
```

## Practical Application

### Step 1: Establish the Narrative
What is the draw on liquidity?
- Relative equal highs above = buy-side liquidity
- Price unwilling to go lower = bullish bias

### Step 2: Identify the Order Block
On your entry timeframe (5-15 minute):
- Find down-close candle(s) in the bullish move
- Mark the range from the candle's low to high

### Step 3: Verify the FVG
When price moves away from the order block:
- Does it leave a gap?
- Gap = high probability entry
- No gap = lower probability

### Step 4: Wait for Retrace
- Price must return to the order block
- Entry is inside the FVG within the order block
- Stop below the order block low

### Step 5: Target the Liquidity
- Aim for the buy-side liquidity (relative equal highs)
- Partial at the first liquidity level
- Runner toward the main draw

## What to Ignore

> "Forget all that engulfing candle stuff... you don't need that. It's the gap plus the down closed candle plus the idea that it's likely to go for buy side liquidity. That's it."

Traditional candlestick patterns (engulfing, doji, etc.) are not required. Focus on:
- The FVG
- The order block candle
- The narrative

## Multi-Timeframe Order Block

The same order block appears differently across timeframes:

```
Hourly Chart:
    [Single Down-Close Candle] = Order Block

15-Minute Chart:
    [Candle 1]
    [Candle 2]  = Same order block, more detail
    [Candle 3]
    [Candle 4]

5-Minute Chart:
    [Multiple candles] = Maximum precision
    └── Look for FVG within the hourly OB range
```

## Entry Precision

Within the hourly order block range:
1. Drop to 15-minute or 5-minute
2. Find the FVG that formed when price left the OB
3. Enter when price returns to the FVG
4. This provides the best risk:reward

## Common Mistakes

1. **Entering without FVG**: Order block without gap = lower probability
2. **Ignoring the narrative**: No clear liquidity target = no trade
3. **Chasing the initial move**: Don't chase pre-open moves or the fake 9:30 move
4. **Violating candle rules**: Entering bullish when down-close candle gets violated

## Psychology Note

> "These are the moments where you get scared. You basically snap yourself out of the desire to hold the trade and you just collapse the trade because you can't handle it."

When price retraces to the order block:
- New traders panic
- This is precisely when the setup is forming
- Trust the process: OB + FVG + Narrative = High probability

## Related Concepts

- [[order-block]]
- [[fair-value-gap]]
- [[liquidity]]
- [[ict-kill-zone]]
- [[precision-market-structure]]

## Source Notes

> "This is that hourly down closed candle which is a bullish order block. Notice the down closed candle is made up of two candles on the 5-minute time frame. Price moves away from it, goes above it right here - does it create an imbalance here? Yes."
> — ICT 2022 Mentorship Episode 13

> "Down closed candles should not be violated. They're going to act as support. Bearish market moves - up close candles should not be breached and broken through."
> — ICT 2022 Mentorship Episode 13

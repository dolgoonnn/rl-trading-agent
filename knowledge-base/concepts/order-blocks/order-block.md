---
title: "Order Block"
slug: order-block
category: order-blocks
source:
  type: youtube
  videoId: nQfHZ2DEJ8c
  url: https://www.youtube.com/watch?v=nQfHZ2DEJ8c
  playlist: "ICT 2022 Mentorship"
concepts:
  - state-of-delivery
  - liquidity
  - entry-pattern
difficulty: intermediate
phase: 2
created: 2026-01-11
---

# Order Block

## Definition

An Order Block is a consecutive group of candles that represent a **change in the state of delivery**. It marks where the algorithm shifted from offering one type of liquidity to another.

## Key Characteristics

- Identified by the **opening price** of the first candle in the sequence
- Represents a shift in how the market is delivering price
- The opening price acts as the "memory" point for the algorithm
- When price violates this opening, the state of delivery changes

## Structure

### Bullish Order Block
```
Consecutive UP-CLOSE candles
│
├─ Candle 1: Opens at X, closes higher
├─ Candle 2: Opens higher, closes higher
├─ Candle 3: Opens higher, closes higher
│
└─ Opening Price (X) = Sensitive Level
   When price trades BELOW this opening,
   state of delivery changes to SELL-SIDE
```

### Bearish Order Block
```
Consecutive DOWN-CLOSE candles
│
├─ Candle 1: Opens at X, closes lower
├─ Candle 2: Opens lower, closes lower
├─ Candle 3: Opens lower, closes lower
│
└─ Opening Price (X) = Sensitive Level
   When price trades ABOVE this opening,
   state of delivery changes to BUY-SIDE
```

## State of Delivery

**What it means:**

- **Offering Buy-Side**: Market is offering to buyers. Algorithms are constantly repricing higher.
- **Offering Sell-Side**: Market is offering to sellers. Algorithms are constantly repricing lower.

When the opening price of an order block is violated, the algorithm changes which side it's offering to.

## Trading Application

1. Identify order blocks on the timeframe you're trading
2. Note the opening price (the "memory" level)
3. When price re-enters the order block, it's a potential entry
4. Use the opening price as a reference for stops
5. The smaller the order block, the more responsive it is

## Trading Rules

- Not every down-close candle is a bearish order block
- Order blocks must have **multiple consecutive candles in same direction**
- Single candle = not an order block
- Order blocks work on ALL timeframes
- The opening price is what matters, not the entire candle

## Common Mistakes

- Treating single candles as order blocks
- Not recognizing the opening price significance
- Trading order blocks without market structure context
- Ignoring the state of delivery change

## Related Concepts

- [[state-of-delivery]]
- [[fair-value-gap]]
- [[market-structure-break]]
- [[liquidity]]

## Source Notes

> "Order block... it's a change in the state of delivery. The market's being offered higher higher higher in these two up close candles... when this candle trades below it that changes the state of delivery."
> — ICT 2022 Mentorship Episode 3

> "That opening once this candle trades below it that changes its state of delivery... that is what an order block is it is a change in the state of delivery."
> — ICT 2022 Mentorship Episode 3

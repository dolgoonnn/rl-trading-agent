---
title: "Buy Programs and Spooling"
slug: buy-programs
category: algorithms
source:
  type: youtube
  videoId: N29ZJ-o31xs
  url: https://www.youtube.com/watch?v=N29ZJ-o31xs
  playlist: "ICT 2022 Mentorship"
concepts:
  - algo-trading
  - liquidity
  - price-delivery
  - market-maker
difficulty: advanced
phase: 3
created: 2026-01-11
---

# Buy Programs and Spooling

## Definition

A **Buy Program** is when algorithms automatically reprice higher regardless of volume, creating a continuous stream of higher prices. **Spooling** is the gradual acceleration of this repricing.

## How It Works

### Buy Program
Algorithm enters "buy mode":
- Continuously offers higher prices
- Does NOT respond to volume
- Does NOT respond to "selling pressure"
- Just keeps repricing UP

### Sell Program
Algorithm enters "sell mode":
- Continuously offers lower prices
- Indifferent to buying interest
- Does NOT care about volume
- Just keeps repricing DOWN

## Why Volume Doesn't Match

You see:
- Massive volume coming in
- But price still rallies
- OR minimal volume, but price crashes

This seems contradictory if you believe in "buying/selling pressure" theory. This is because algorithms are **repricing**, not responding to participant activity.

## Spooling Process

```
Initial Buy Stop Hit
        ↓
Algorithm recognizes selling
        ↓
Enters BUY PROGRAM mode
        ↓
Spooling begins (accelerating repricing)
        ↓
Continuous higher prices
        ↓
Trapped shorts forced to cover
        ↓
More forced buying = acceleration continues
```

## The Mistake People Make

**Common belief**: "Buying pressure drives price higher"

**Reality**: Algorithm is programmed to reprice. The price doesn't care who's buying. Volume is irrelevant once the algorithm is in repricing mode.

## Proof in Charts

Look for:
- Volume doesn't match price move
- "Weird" price action that defies logic
- Steady acceleration with varying volume
- Moves that seem to ignore resistance

## Trading Application

1. Identify when a swing low is broken (stop hunt)
2. Watch for spooling to BEGIN
3. The violation of that low = start of buy program
4. Enter when spooling becomes evident
5. Hold through the acceleration
6. Exit when algorithm changes state

## Key Insight

If algorithms are **always repricing** (which they are), then:
- Understanding repricing = understanding price
- "Buying/selling pressure" = distraction
- Volume = irrelevant to price delivery
- Your job = recognize when repricing starts/stops

## Common Mistakes

- Thinking volume explains price movement
- Fighting the algorithm (shorting into buy program)
- Over-analyzing "why" and missing "when"
- Attributing movement to fundamental news

## Related Concepts

- [[order-blocks]]
- [[market-structure-break]]
- [[liquidity]]
- [[state-of-delivery]]

## Source Notes

> "If it's being manipulated doesn't it stand profitable for you to know what it's likely to do... these things tend to repeat and if they repeat a majority of time... these things are in alignment if they start showing the same fingerprints it's probably going to pan out."
> — ICT 2022 Mentorship Episode 5

> "They're just continuously keeps offering higher prices it does not matter what the volume is... if you go through the charts you're going to see this okay."
> — ICT 2022 Mentorship Episode 5

#!/usr/bin/env node

/**
 * Batch transcript processing for ICT Knowledge Base
 * Extracts key concepts from transcripts and generates concept markdown files
 */

import fs from "fs";
import path from "path";

interface TranscriptFile {
  videoId: string;
  title: string;
  fullText: string;
  playlist: string;
}

interface ConceptMapping {
  [episode: number]: Array<{
    title: string;
    slug: string;
    category: string;
    concepts: string[];
    description: string;
  }>;
}

// Manual concept mappings based on episode analysis
const conceptMappings: ConceptMapping = {
  1: [
    {
      title: "Personal Responsibility in Trading",
      slug: "personal-responsibility",
      category: "psychology",
      concepts: ["mindset", "three-stages-of-trading"],
      description: "Owning both successes and failures in trading",
    },
    {
      title: "Three Stages of Trading Development",
      slug: "three-stages-of-trading",
      category: "psychology",
      concepts: ["mindset", "learning-path"],
      description: "Yearner, Learner, Earner progression",
    },
  ],
  2: [
    {
      title: "Weekly Bias",
      slug: "weekly-bias",
      category: "bias",
      concepts: ["market-structure", "swing-points"],
      description: "Expected weekly candle direction",
    },
    {
      title: "Liquidity",
      slug: "liquidity",
      category: "liquidity",
      concepts: ["buy-stops", "sell-stops"],
      description: "Buy/sell stops above old highs/lows",
    },
    {
      title: "Fair Value Gap (FVG)",
      slug: "fair-value-gap",
      category: "fair-value-gaps",
      concepts: ["imbalance", "price-inefficiency"],
      description: "Three-candle imbalance pattern",
    },
    {
      title: "Market Structure Break",
      slug: "market-structure-break",
      category: "market-structure",
      concepts: ["swing-points", "bos", "choch"],
      description: "Break below swing low or above swing high",
    },
    {
      title: "Premium and Discount",
      slug: "premium-discount",
      category: "market-structure",
      concepts: ["equilibrium", "fibonacci"],
      description: "Zones above/below 50% equilibrium level",
    },
    {
      title: "Stop Hunt and Inducement",
      slug: "stop-hunt",
      category: "liquidity",
      concepts: ["liquidity", "manipulation", "smart-money"],
      description: "Engineered liquidity before major moves",
    },
  ],
  3: [
    {
      title: "Order Block",
      slug: "order-block",
      category: "order-blocks",
      concepts: ["state-of-delivery", "liquidity"],
      description: "Change in state of delivery with opening price memory",
    },
    {
      title: "Trading Sessions and Timing",
      slug: "session-timing",
      category: "trading-sessions",
      concepts: ["time-of-day-trading", "liquidity-cycles"],
      description: "Asian, London, New York session windows",
    },
    {
      title: "Back Testing",
      slug: "backtesting",
      category: "methodology",
      concepts: ["study", "learning-process", "pattern-recognition"],
      description: "Deliberate chart annotation and pattern learning",
    },
    {
      title: "Internal Range Liquidity",
      slug: "internal-range-liquidity",
      category: "market-structure",
      concepts: ["liquidity", "consolidation", "swing-points"],
      description: "Swing points within larger price legs",
    },
  ],
  4: [
    {
      title: "Fibonacci Equilibrium",
      slug: "fibonacci-equilibrium",
      category: "market-structure",
      concepts: ["fibonacci", "50-level", "premium-discount"],
      description: "50% midpoint using Fibonacci tool",
    },
    {
      title: "Target Refinement",
      slug: "target-refinement",
      category: "methodology",
      concepts: ["entry", "exit", "risk-management"],
      description: "Progressive targeting from low-hanging fruit to full moves",
    },
  ],
  5: [
    {
      title: "Futures Contract Mechanics",
      slug: "futures-mechanics",
      category: "instruments",
      concepts: ["delivery-months", "expiration", "open-interest"],
      description: "Symbols, delivery months, contract rolling",
    },
    {
      title: "Daily Range Framework",
      slug: "daily-range-framework",
      category: "trading-sessions",
      concepts: ["morning-session", "lunch-hour", "afternoon-session"],
      description: "Morning, lunch (no-trade), afternoon session structure",
    },
    {
      title: "Three Drives Pattern",
      slug: "three-drives",
      category: "patterns",
      concepts: ["swing-points", "accumulation", "stop-hunt"],
      description: "Three higher highs building into old resistance",
    },
    {
      title: "Displacement",
      slug: "displacement",
      category: "price-action",
      concepts: ["market-structure", "aggression"],
      description: "Energetic aggressive move vs lethargic movement",
    },
    {
      title: "Buy Programs and Spooling",
      slug: "buy-programs",
      category: "algorithms",
      concepts: ["algo-trading", "liquidity", "pricing"],
      description: "Algorithm repricing higher/lower continuously",
    },
  ],
};

async function getEpisodeNumber(videoId: string): Promise<number> {
  // Map video IDs to episode numbers
  const idToEpisode: { [key: string]: number } = {
    "kt6V4ai60fI": 1,
    "tmeCWULSTHc": 2,
    "nQfHZ2DEJ8c": 3,
    "L-ReMHiavPM": 4,
    "N29ZJ-o31xs": 5,
    "Bkt8B3kLATQ": 6,
    "G8-z91acgG4": 7,
    "7rbV8aWkcqY": 8,
    "iZLXnNiZm_s": 9,
    "S9ORTYmXwdE": 10,
  };
  return idToEpisode[videoId] || 0;
}

function generateMarkdown(
  concept: (typeof conceptMappings)[number][number],
  videoId: string,
  episode: number
): string {
  return `---
title: "${concept.title}"
slug: ${concept.slug}
category: ${concept.category}
source:
  type: youtube
  videoId: ${videoId}
  url: https://www.youtube.com/watch?v=${videoId}
  playlist: "ICT 2022 Mentorship"
concepts:
${concept.concepts.map((c) => `  - ${c}`).join("\n")}
difficulty: ${episode <= 2 ? "beginner" : episode <= 3 ? "intermediate" : "advanced"}
phase: ${Math.min(Math.ceil(episode / 2), 3)}
created: 2026-01-11
---

# ${concept.title}

## Definition

${concept.description}

## Key Characteristics

- [Key point 1]
- [Key point 2]
- [Key point 3]

## Trading Application

1. [Application point 1]
2. [Application point 2]
3. [Application point 3]

## Trading Rules

- [Rule 1]
- [Rule 2]

## Common Mistakes

- [Mistake 1]
- [Mistake 2]

## Related Concepts

${concept.concepts.map((c) => `- [[${c}]]`).join("\n")}

## Source Notes

> "Quote from the episode"
> — ICT 2022 Mentorship Episode ${episode}
`;
}

async function processTranscripts() {
  const sourceDir = path.join(
    process.cwd(),
    "knowledge-base",
    "sources",
    "youtube"
  );
  const outputDir = path.join(process.cwd(), "knowledge-base", "concepts");

  // Get all transcript files
  const files = fs
    .readdirSync(sourceDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  console.log(`Found ${files.length} transcript files`);

  let processedCount = 0;

  for (const file of files) {
    const filePath = path.join(sourceDir, file);
    const transcript: TranscriptFile = JSON.parse(fs.readFileSync(filePath, "utf-8"));

    const episode = await getEpisodeNumber(transcript.videoId);
    if (episode === 0) continue;

    const concepts = conceptMappings[episode];
    if (!concepts) {
      console.log(`⏭️  Episode ${episode}: No mappings defined yet`);
      continue;
    }

    console.log(`\n📝 Processing Episode ${episode}: ${transcript.title}`);

    for (const concept of concepts) {
      const categoryDir = path.join(outputDir, concept.category);
      if (!fs.existsSync(categoryDir)) {
        fs.mkdirSync(categoryDir, { recursive: true });
      }

      const outputPath = path.join(categoryDir, `${concept.slug}.md`);

      // Skip if already exists
      if (fs.existsSync(outputPath)) {
        console.log(`   ✓ ${concept.title} (already exists)`);
        continue;
      }

      const markdown = generateMarkdown(concept, transcript.videoId, episode);
      fs.writeFileSync(outputPath, markdown);

      console.log(`   ✓ ${concept.title}`);
      processedCount++;
    }
  }

  console.log(`\n✅ Processed ${processedCount} new concept files`);
}

processTranscripts().catch(console.error);

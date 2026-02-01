# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

ICT (Inner Circle Trader) Trading Platform - A TypeScript-based learning and analysis tool for ICT trading concepts.

## Tech Stack

- **Framework**: Next.js 15 (App Router)
- **Language**: TypeScript (strict mode)
- **Styling**: Tailwind CSS v4
- **State**: Zustand
- **Database**: SQLite via Drizzle ORM
- **API**: tRPC for type-safe API calls
- **Charts**: Lightweight Charts (TradingView library)

## Commands

```bash
# Development
pnpm dev          # Start dev server with Turbopack
pnpm build        # Production build
pnpm start        # Start production server
pnpm lint         # Run ESLint
pnpm typecheck    # TypeScript type checking

# Database
pnpm db:generate  # Generate migrations from schema changes
pnpm db:migrate   # Run migrations
pnpm db:push      # Push schema directly (dev only)
pnpm db:studio    # Open Drizzle Studio GUI
```

## Project Structure

```
src/
├── app/                    # Next.js App Router pages
├── components/
│   ├── ui/                # Base UI components
│   ├── chart/             # Chart components
│   └── ict/               # ICT-specific components
├── lib/
│   ├── ict/               # ICT concept detection
│   │   ├── market-structure.ts  # Swing points, BOS, CHoCH
│   │   ├── order-blocks.ts      # OB detection
│   │   └── fair-value-gaps.ts   # FVG detection
│   ├── data/              # Database schema & connection
│   ├── trpc/              # tRPC router setup
│   └── utils/             # Helper functions
├── types/                 # TypeScript type definitions
│   ├── candle.ts          # OHLCV types
│   ├── ict.ts             # ICT concept types
│   └── trade.ts           # Trade journal types
└── stores/                # Zustand stores
```

## ICT Concepts Implemented

### Core Types (`src/types/ict.ts`)
- **SwingPoint**: High/low pivot points
- **StructureBreak**: BOS (Break of Structure), CHoCH (Change of Character)
- **OrderBlock**: Institutional supply/demand zones
- **FairValueGap**: Price imbalances
- **LiquidityLevel**: Equal highs/lows where stops cluster
- **ICTSetup**: Complete setup with confluence scoring

### Detection Modules (`src/lib/ict/`)
- `market-structure.ts` - Swing detection, bias determination
- `order-blocks.ts` - Bullish/bearish OB detection
- `fair-value-gaps.ts` - FVG detection and fill tracking

## Database Schema (`src/lib/data/schema.ts`)

- `candles` - OHLCV data cache
- `trades` - Trading journal entries
- `setupFingerprints` - Setup type patterns for intelligence
- `setupRecords` - Individual setup instances

## Development Guidelines

### TypeScript
- Strict mode enabled with additional checks
- Use proper types - never use `any`
- All ICT types are in `src/types/`

### Adding New ICT Concepts
1. Define types in `src/types/ict.ts`
2. Create detection module in `src/lib/ict/`
3. Export from `src/lib/ict/index.ts`
4. Add tRPC router if needed

### Database Changes
1. Modify schema in `src/lib/data/schema.ts`
2. Run `pnpm db:generate` to create migration
3. Run `pnpm db:migrate` to apply

## Knowledge Base Workflow

The knowledge base extracts ICT concepts from YouTube videos. Claude Code does the structuring (no API costs).

### Step 1: Extract Transcript
```bash
cd scripts/python && python -m venv venv && source venv/bin/activate && pip install -r requirements.txt
npx tsx scripts/extract-transcript.ts "https://youtube.com/watch?v=VIDEO_ID" --title "Video Title"
```
Output: `knowledge-base/sources/youtube/<video_id>.json`

### Step 2: Ask Claude Code to Structure
Tell Claude Code:
> "Read the transcript at knowledge-base/sources/youtube/<video_id>.json and create structured concept markdown files in knowledge-base/concepts/"

Claude Code will:
- Read the transcript
- Extract ICT concepts (definitions, rules, applications)
- Generate markdown files with proper frontmatter
- Optionally generate flashcards

### Step 3: Generate Embeddings
```bash
ollama serve  # In another terminal
ollama pull nomic-embed-text
npx tsx scripts/embed-knowledge.ts
```
Stores vector embeddings in SQLite for semantic search.

### Knowledge Base Structure
```
knowledge-base/
├── concepts/           # Structured ICT concepts (markdown)
│   ├── market-structure/
│   ├── liquidity/
│   ├── order-blocks/
│   └── fair-value-gaps/
├── sources/youtube/    # Raw transcripts (JSON)
├── setups/            # Trading models
└── exports/anki/      # Flashcard exports
```

### Database Tables (Knowledge Base)
- `video_sources` - YouTube video processing status
- `knowledge_chunks` - Embedded content for search
- `flashcards` - Spaced repetition cards (FSRS algorithm)
- `ict_concepts` - Master concept list

## Related Projects

- `/Users/apple/projects/trading` - Python ICT trading system with backtesting and alerts
- See `docs/ICT_LEARNING_ROADMAP.md` for ICT concept reference

## ICT Learning Path

This project aims to help learn and apply ICT concepts:
1. **Phase 1-2**: Market structure, swing points, liquidity
2. **Phase 3**: Order blocks, FVGs, breakers
3. **Phase 4**: Entry models (AMD, OTE, Kill Zones)
4. **Phase 5-6**: Time theory, Silver Bullet, SMT divergence

Reference: `docs/ICT_LEARNING_ROADMAP.md` in trading project

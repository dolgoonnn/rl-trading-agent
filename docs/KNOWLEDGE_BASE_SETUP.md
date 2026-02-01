# ICT Knowledge Base Setup Guide

## Overview

The ICT Knowledge Base is a comprehensive system for storing, searching, and learning from ICT trading concepts extracted from YouTube videos.

**Current Status:**
- ✅ 29 concept files created (27 planned + 2 additional)
- ✅ 275 chunks extracted and stored in SQLite
- ✅ Keyword search API ready
- ⏳ Vector embeddings (requires Ollama)
- ⏳ Flashcard generation

---

## Architecture

```
YouTube Videos (10 episodes)
        │
        ▼
Transcripts (text files)
        │
        ▼
Markdown Concepts (29 files, 275+ chunks)
        │
        ├─────────────────┬──────────────────┐
        ▼                 ▼                  ▼
    SQLite DB      Ollama Embeddings    Flashcards
  (knowledge_chunks)  (optional)       (Anki export)
        │                 │
        └──────────┬──────┘
                   ▼
            tRPC Search API
                   │
                   ▼
            React Search UI
```

---

## Directory Structure

```
knowledge-base/
├── concepts/                    # 29 markdown files
│   ├── psychology/
│   │   ├── personal-responsibility.md
│   │   └── three-stages-of-trading.md
│   ├── market-structure/
│   ├── liquidity/
│   ├── trading-sessions/
│   ├── methodology/
│   └── ... (13 categories total)
├── exports/
│   └── anki/                    # Future: Anki flashcard exports
└── sources/
    └── youtube/                 # Future: Raw video transcripts

src/lib/kb/                      # Knowledge base module
├── ingest/
│   ├── markdown.ts              # Markdown parsing
│   └── youtube.ts               # Video transcript extraction
├── process/
│   ├── chunker.ts               # Content chunking (header-aware)
│   ├── embedder.ts              # Ollama embeddings
│   └── structurer.ts            # LLM concept extraction (future)
├── search/
│   └── semantic.ts              # Keyword & semantic search
├── flashcards/
│   ├── generator.ts             # Flashcard generation
│   └── anki.ts                  # Anki export format
├── types.ts                     # Type definitions
└── index.ts                     # Module exports

src/lib/trpc/routers/
├── kb.ts                        # Knowledge base tRPC router
└── index.ts                     # Router registration

src/app/
├── api/trpc/[trpc].ts          # tRPC API handler
└── kb-search/                   # Search UI page
```

---

## Database Schema

### knowledge_chunks table

```sql
CREATE TABLE knowledge_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,              -- Chunk text
  sourceType TEXT NOT NULL,           -- 'youtube' | 'notion' | 'manual'
  sourceUrl TEXT,                     -- YouTube URL or source link
  videoId TEXT,                       -- YouTube video ID
  timestamp TEXT,                     -- "12:34" video timestamp
  concept TEXT,                       -- Slug: 'order-blocks', 'fvg', etc.
  section TEXT,                       -- H2 header from markdown
  filePath TEXT,                      -- Path to source markdown
  embedding TEXT,                     -- JSON array of 768 floats
  tokenCount INTEGER,                 -- Approximate token count
  createdAt TIMESTAMP                 -- Insertion time
);
```

**Indexes:**
- `concept` - Fast concept-based queries
- `sourceType` - Filter by source
- `createdAt` - Sort by recency

---

## Search API (tRPC)

### Endpoint: `kb.search`

Keyword-based search (works without Ollama).

**Input:**
```typescript
{
  query: string;              // e.g., "fair value gap"
  concept?: string;           // Optional concept filter
  topK?: number;              // Results to return (1-50, default: 10)
}
```

**Output:**
```typescript
{
  success: boolean;
  query: string;
  resultCount: number;
  results: Array<{
    id: number;
    content: string;
    section: string;           // e.g., "Definition"
    concept: string;           // e.g., "fvg"
    filePath: string;          // Concept slug
    sourceType: string;        // e.g., "manual"
    videoId?: string;
    sourceUrl?: string;
    tokenCount?: number;
  }>;
}
```

**Example:**
```typescript
const result = await trpc.kb.search.query({
  query: "what is a liquidity grab",
  topK: 5,
});
```

---

### Endpoint: `kb.concept`

Get all chunks for a specific concept.

**Input:**
```typescript
{
  concept: string;            // Concept slug
  limit?: number;             // Max chunks (1-100, default: 20)
}
```

**Output:**
```typescript
{
  success: boolean;
  concept: string;
  chunkCount: number;
  chunks: KnowledgeChunk[];
}
```

**Example:**
```typescript
const fvgChunks = await trpc.kb.concept.query({
  concept: "fair-value-gap",
});
```

---

### Endpoint: `kb.ragContext`

Build RAG context for passing to LLM.

**Input:**
```typescript
{
  query: string;
  concept?: string;
  maxTokens?: number;         // Context window (100-16000, default: 4000)
}
```

**Output:**
```typescript
{
  success: boolean;
  query: string;
  context: string;            // Formatted chunks ready for LLM
  contextLength: number;      // Character count
}
```

**Example:**
```typescript
const context = await trpc.kb.ragContext.query({
  query: "how does the kill zone work",
  maxTokens: 2000,
});

// Use with Claude API for context-aware response
const response = await anthropic.messages.create({
  model: "claude-3-5-haiku",
  max_tokens: 1024,
  system: `You are an ICT trading expert. Answer the following question using the provided context:\n\n${context.context}`,
  messages: [{ role: "user", content: "How does the kill zone work?" }],
});
```

---

### Endpoint: `kb.suggestions`

Get popular search terms for autocomplete.

**Output:**
```typescript
{
  success: boolean;
  suggestions: string[];      // Popular terms
}
```

---

## Using the Search UI

1. **Open the search page:**
   ```bash
   pnpm dev
   # Visit http://localhost:3000/kb-search
   ```

2. **Search features:**
   - Type any ICT trading term
   - Click suggestions for quick searches
   - Filter by concept slug (optional)
   - Adjust results count (1-50)

3. **Result details:**
   - View chunk content with preview
   - See source information (video ID, concept, section)
   - Token count for size reference
   - Link to source video (if available)

---

## Adding Ollama Embeddings (Future)

When you're ready to add semantic search:

### 1. Install Ollama

**macOS:**
```bash
# Download from https://ollama.ai
# Or use Homebrew
brew install ollama
```

**Linux:**
```bash
curl https://ollama.ai/install.sh | sh
```

**Windows:**
Download from https://ollama.ai/download

### 2. Start Ollama Service

```bash
# Terminal 1
ollama serve

# Terminal 2
ollama pull nomic-embed-text
```

### 3. Generate Embeddings

```bash
pnpm tsx scripts/ingest-concepts.ts --with-embeddings
```

Expected output:
```
🚀 Starting ICT concept ingestion...

✅ Ollama ready for embeddings

📂 Scanning concept files...
   Found 29 concept files

[1/29] Processing: Back Testing
   📦 Created 13 chunks
   ✅ Embedded 13/13 chunks

...
```

### 4. Test Semantic Search

Once embeddings are generated, the `kb.search` endpoint will automatically use semantic search for better results.

---

## Upcoming Features

### Phase 3: Flashcard Generation

Generate FSRS-based flashcards for spaced repetition:

```typescript
// Example (not yet implemented)
const cards = await generateFlashcards('order-blocks', {
  types: ['basic', 'cloze'],
  maxCards: 20,
});

// Export to Anki
const apkg = await createAnkiDeck(cards, 'ICT Order Blocks');
await fs.writeFile('ict-order-blocks.apkg', apkg);
```

### Phase 4: Enhanced Ingestion

- [ ] Support more video formats (Notion, community notes)
- [ ] Automatic concept extraction using Claude API
- [ ] Cross-reference generation between concepts
- [ ] Performance metrics (win rate per concept, etc.)

### Phase 5: LLM Integration

- [ ] RAG-based Q&A system
- [ ] Concept recommendations based on user questions
- [ ] Explanation generation for trading setups

---

## Scripts

### Ingest Concepts

```bash
# Without embeddings (fast)
pnpm tsx scripts/ingest-concepts.ts

# With embeddings (requires Ollama)
pnpm tsx scripts/ingest-concepts.ts --with-embeddings
```

### Verify Ollama Setup

```bash
pnpm tsx scripts/verify-ollama.ts
```

---

## Database Commands

```bash
# Generate migrations
pnpm db:generate

# Run migrations
pnpm db:migrate

# Open Drizzle Studio (visual editor)
pnpm db:studio
```

---

## Performance Notes

- **Chunks:** 275 total, average 150 tokens each
- **Database size:** ~5-10 MB (including embeddings when added)
- **Search latency:**
  - Keyword: <100ms
  - Semantic: 50-200ms (depends on Ollama performance)
- **Embedding generation:** ~100 chunks/minute on M1 MacBook

---

## Troubleshooting

### "Ollama not running"

```bash
# Check if Ollama service is available
curl http://localhost:11434/api/tags

# If not, start it
ollama serve
```

### Embedding model not found

```bash
# Pull the model
ollama pull nomic-embed-text

# Verify it's installed
ollama list
```

### Database locked error

```bash
# Remove WAL files
rm data/ict-trading.db-wal data/ict-trading.db-shm

# Recreate database
pnpm db:push
```

### Search returns no results

- Check query has at least 3 characters
- Try more general terms (e.g., "order blocks" instead of "order block management")
- Use concept filter to narrow results

---

## File Organization

### Concept Categories (13 total)

1. **Psychology** (2 files)
   - personal-responsibility.md
   - three-stages-of-trading.md

2. **Market Structure** (5 files)
   - market-structure-break.md
   - premium-discount.md
   - fibonacci-equilibrium.md
   - internal-range-liquidity.md
   - external-range-liquidity.md

3. **Liquidity** (3 files)
   - liquidity.md
   - stop-hunt.md
   - internal-range-liquidity.md

4. **Bias** (2 files)
   - weekly-bias.md
   - daily-bias.md

5. **Trading Sessions** (3 files)
   - session-timing.md
   - daily-range-framework.md
   - ict-kill-zone.md

6. **Order Blocks & Patterns** (2 files)
   - order-block.md
   - three-drives.md

7. **Fair Value Gaps** (1 file)
   - fair-value-gap.md

8. **Methodology** (6 files)
   - backtesting.md
   - target-refinement.md
   - leader-trades.md
   - narrative-trading.md
   - power-three.md
   - economic-calendar.md

9. **Price Action** (2 files)
   - displacement.md
   - displacement-high-low.md

10. **Market Mechanics** (2 files)
    - buy-programs.md
    - futures-mechanics.md

11. **Market Efficiency** (1 file)
    - market-efficiency-paradigm.md

12. **Intermarket** (1 file)
    - intermarket-relationships.md

---

## Next Steps

1. ✅ **Completed:** Core concepts extracted and stored
2. ⏳ **Next:** Install Ollama and generate embeddings
3. ⏳ **Then:** Build flashcard generator for spaced repetition
4. ⏳ **Finally:** Create Q&A system using Claude + RAG

---

## Resources

- **Knowledge Base:** `/knowledge-base/concepts/`
- **Search UI:** http://localhost:3000/kb-search
- **Database:** `/data/ict-trading.db`
- **Ollama:** https://ollama.ai
- **nomic-embed-text:** https://ollama.ai/library/nomic-embed-text

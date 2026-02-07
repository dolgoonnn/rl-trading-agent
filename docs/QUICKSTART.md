# ICT Knowledge Base - Quick Start Guide

## In 60 Seconds

### 1. Start the server

```bash
pnpm dev
```

### 2. Open search UI

Visit: **http://localhost:3000/kb-search**

### 3. Search for concepts

Type any ICT trading term:c

- "fair value gap"
- "kill zone"
- "order blocks"
- "daily bias"

**Done!** You have access to 275+ chunks from 29 concepts.

---

## What's Available

✅ **Keyword Search** - Works immediately, no setup needed
✅ **API Access** - tRPC endpoints ready to use
✅ **RAG Context** - Build context for LLM integration
✅ **Clean UI** - Search, filter, explore concepts

---

## Using the API

### From Frontend (React)

```typescript
import { trpc } from '@/lib/trpc/client';

export function SearchComponent() {
  const { data } = trpc.kb.search.useQuery({
    query: 'order blocks',
    topK: 5,
  });

  return <div>{data?.results.map(r => <p>{r.content}</p>)}</div>;
}
```

### From Server (Node.js)

```typescript
import { keywordSearch, getRelatedChunks } from "@/lib/kb/search/semantic";

const results = await keywordSearch("fair value gap", { topK: 10 });

// Get all chunks for a concept
const fvgChunks = await getRelatedChunks("fair-value-gap");

// Build RAG context for LLM
const { buildRAGContext } = await import("@/lib/kb/search/semantic");
const context = buildRAGContext(results, 4000);
```

---

## Optional: Add Ollama Embeddings

Want semantic search instead of just keywords?

### 1. Install Ollama

```bash
# macOS
brew install ollama

# Or download from https://ollama.ai
```

### 2. Start Ollama

```bash
# Terminal 1
ollama serve

# Terminal 2
ollama pull nomic-embed-text
```

### 3. Generate embeddings

```bash
pnpm tsx scripts/ingest-concepts.ts --with-embeddings
```

**That's it!** Semantic search will automatically activate.

---

## Database

SQLite at: `/data/ict-trading.db`

View with:

```bash
pnpm db:studio
```

### Tables

- `knowledge_chunks` (275 rows) - Main content
- `flashcards` - For spaced repetition (future)
- `videoSources` - Source tracking
- `ictConcepts` - Concept metadata

---

## File Organization

```
/knowledge-base/concepts/
├── psychology/           2 concepts
├── market-structure/     5 concepts
├── liquidity/            3 concepts
├── bias/                 2 concepts
├── trading-sessions/     3 concepts
├── order-blocks/         2 concepts
├── methodology/          6 concepts
└── ... (13 categories)
```

---

## Key Files

| File                            | Purpose          |
| ------------------------------- | ---------------- |
| `src/lib/kb/search/semantic.ts` | Search functions |
| `src/lib/trpc/routers/kb.ts`    | API endpoints    |
| `src/app/kb-search/page.tsx`    | Search UI        |
| `scripts/ingest-concepts.ts`    | Data ingestion   |
| `knowledge-base/concepts/`      | Content files    |

---

## Common Queries

**Search for a concept:**

```typescript
const results = await trpc.kb.search.query({
  query: "market structure break",
});
```

**Get all chunks for a concept:**

```typescript
const chunks = await trpc.kb.concept.query({
  concept: "order-blocks",
});
```

**Build context for Claude:**

```typescript
const { context } = await trpc.kb.ragContext.query({
  query: "what is a fair value gap",
  maxTokens: 2000,
});
```

---

## Troubleshooting

### No results found?

- Try more general terms ("order blocks" not "order block positioning")
- Check search is at least 3 characters
- Use concept filter if you know the slug

### Want embeddings but Ollama won't start?

```bash
# Verify Ollama is running
curl http://localhost:11434/api/tags

# If not, start it
ollama serve
```

### Database locked?

```bash
# Remove stale WAL files
rm data/ict-trading.db-wal data/ict-trading.db-shm

# Re-ingest if needed
pnpm tsx scripts/ingest-concepts.ts
```

---

## Next Steps

1. ✅ **Today** - Use keyword search
2. 🔲 **Option A** - Setup Ollama for better results
3. 🔲 **Option B** - Integrate RAG with Claude API
4. 🔲 **Option C** - Add to your trading app

---

## Stats

- **Concepts:** 29
- **Chunks:** 275
- **Search latency:** <100ms (keyword)
- **Database size:** ~5-10 MB
- **Coverage:** 10 YouTube episodes

---

## Need Help?

See full docs: `docs/KNOWLEDGE_BASE_SETUP.md`

# Batch Video Ingestion Guide

This guide explains how to ingest remaining ICT videos into the knowledge base using the batch processing pipeline.

---

## Overview

The batch ingestion system handles the complete pipeline:

```
Video IDs
    ↓
Extract Transcripts (youtube-transcript-api)
    ↓
Process into Concepts (Claude API)
    ↓
Chunk Knowledge (512 token chunks)
    ↓
Ingest into SQLite
    ↓
Generate Embeddings (Ollama)
    ↓
Ready for Search & Flashcards
```

---

## Current Status

### ✅ Completed
- **2022 Mentorship**: Episodes 1-10 (10 videos extracted)
- **Concept Extraction**: 29 concepts from 275 chunks
- **Database**: SQLite with 275 chunks indexed

### ⏳ Remaining
- **If I Could Go Back**: 7 videos (Phase 1 foundation)
- **Market Maker Series**: 15+ videos (Phase 2 core concepts)
- **2022 Mentorship**: Episodes 11-41 (31 more videos, Phase 4-6)

**Total remaining: ~53 videos → ~1,200+ chunks → ~3,000+ flashcards**

---

## Step 1: Find Video IDs

You need to populate the video IDs in `scripts/ict-video-list.json`.

### Method A: From YouTube Playlist URL (Recommended)

1. Navigate to the playlist on YouTube
2. Right-click a video → **Copy video URL**
3. URL format: `https://www.youtube.com/watch?v=VIDEO_ID&list=PLAYLIST_ID`
4. Extract the `VIDEO_ID` part (11 characters, alphanumeric + underscore/dash)

**Example:**
```
URL: https://www.youtube.com/watch?v=abc123DEF45&list=PLxxx
Video ID: abc123DEF45
```

### Method B: Manual Playlist Navigation

1. Open playlist in browser
2. Open DevTools (F12) → Console
3. Paste this code to extract all video IDs:

```javascript
const videos = Array.from(document.querySelectorAll('[href*="/watch?v="]'))
  .map(a => ({
    id: new URL(a.href).searchParams.get('v'),
    title: a.textContent.trim()
  }))
  .filter((v, i, a) => a.findIndex(u => u.id === v.id) === i);

console.log(JSON.stringify(videos, null, 2));
```

4. Copy output and update `ict-video-list.json`

---

## Step 2: Update Video List

Edit `scripts/ict-video-list.json` and replace placeholder IDs with real YouTube video IDs.

### Example: If I Could Go Back Series

**Before:**
```json
{
  "id": "NEED_VIDEO_ID_1",
  "title": "If I Could Go Back - Part 1"
}
```

**After:**
```json
{
  "id": "dGVzdDEyMzQ1Ng",
  "title": "If I Could Go Back - Part 1"
}
```

### How to Find These Playlists

Search YouTube for:
- **"If I Could Go Back"** - Search on Inner Circle Trader channel
- **"ICT Market Maker Series"** or **"ICT ForeXmas"** - Same channel
- **"ICT 2022 Mentorship"** - Same channel (already have episodes 1-10)

---

## Step 3: Run Batch Ingestion

Once video IDs are populated, run the batch processing pipeline:

### Quick Test (First 3 Videos)

```bash
npx tsx scripts/batch-ingest-all.ts \
  --playlist if-i-could-go-back \
  --limit 3
```

**Output:**
```
🎬 ICT Knowledge Base - Batch Ingestion Pipeline
═══════════════════════════════════════════════════
📊 Configuration:
   Playlist: if-i-could-go-back
   Limit: 3 videos
   Pipeline: Extract → Process → Chunk → Ingest

📥 Stage 1: Extracting Transcripts
[1/3] If I Could Go Back - Part 1... ✅
[2/3] If I Could Go Back - Part 2... ✅
[3/3] If I Could Go Back - Part 3... ✅

🔄 Stage 2: Processing Concepts
⏳ Parsing transcripts into concepts...
✅ Extracted 42 new concepts

...
```

### Full Playlist Ingestion

```bash
# If I Could Go Back (7 videos, ~15 min)
npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back

# Market Maker Series (15 videos, ~45 min)
npx tsx scripts/batch-ingest-all.ts --playlist market-maker-series

# Remaining 2022 Mentorship (31 videos, ~90 min)
npx tsx scripts/batch-ingest-all.ts --playlist 2022-mentorship --limit 31
```

### With Embeddings (Optional)

For semantic search support, generate embeddings during ingestion:

```bash
npx tsx scripts/batch-ingest-all.ts \
  --playlist if-i-could-go-back \
  --embed
```

**Requires:** Ollama running with `nomic-embed-text` model
```bash
ollama pull nomic-embed-text
ollama serve
```

---

## Step 4: Verify Ingestion

Check database has new chunks:

```bash
# Open Drizzle Studio
pnpm db:studio

# Navigate to: knowledgeChunks table
# Verify new rows with playlist source
```

---

## Complete Pipeline Example

Full end-to-end ingestion of all three series:

```bash
#!/bin/bash

echo "🎯 Starting complete ICT knowledge base ingestion..."

# 1. If I Could Go Back (Foundation)
echo "📚 Phase 1: Ingesting 'If I Could Go Back' series..."
npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back
echo "✅ Phase 1 complete\n"

# 2. Market Maker Series (Core Concepts)
echo "📚 Phase 2: Ingesting Market Maker Series..."
npx tsx scripts/batch-ingest-all.ts --playlist market-maker-series
echo "✅ Phase 2 complete\n"

# 3. Remaining 2022 Mentorship (Entry Models + Advanced)
echo "📚 Phase 4-6: Ingesting remaining Mentorship episodes..."
npx tsx scripts/batch-ingest-all.ts --playlist 2022-mentorship --limit 31
echo "✅ Phase 4-6 complete\n"

# 4. Generate Embeddings (Optional)
echo "🧠 Generating embeddings for semantic search..."
npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back --embed
npx tsx scripts/batch-ingest-all.ts --playlist market-maker-series --embed
npx tsx scripts/batch-ingest-all.ts --playlist 2022-mentorship --embed
echo "✅ Embeddings complete\n"

# 5. Update search index
echo "🔍 Updating knowledge base search index..."
pnpm db:studio
echo "✅ Index updated\n"

echo "🎉 All ingestion complete!"
echo "📖 Visit http://localhost:3000/kb-search to search knowledge base"
```

---

## Estimated Timeline

| Phase | Videos | Duration | Concepts | Chunks |
|-------|--------|----------|----------|--------|
| If I Could Go Back | 7 | 15 min | ~70 | ~210 |
| Market Maker Series | 15 | 45 min | ~150 | ~450 |
| 2022 Mentorship (11-41) | 31 | 90 min | ~310 | ~930 |
| **Total** | **53** | **~2.5 hours** | **~530** | **~1,590** |

**All 53 videos + 10 existing = 63 videos, ~1,900 total chunks**

---

## Troubleshooting

### Issue: "Video not found" or Transcript Error

**Cause:** Video ID is incorrect or video doesn't allow transcripts

**Solution:**
1. Verify video ID from YouTube URL
2. Check video allows captions (click "CC" button on player)
3. Try alternative video from same series

### Issue: Claude API Rate Limit

**Error:** "Rate limit exceeded - 429"

**Solution:**
1. Wait 1-2 minutes before retrying
2. Use `--resume` flag to continue from checkpoint
3. Use `--limit 5` for smaller batches

```bash
npx tsx scripts/batch-ingest-all.ts --playlist 2022-mentorship --limit 5 --resume
```

### Issue: Out of Memory

**Cause:** Processing too many videos at once

**Solution:** Process in batches of 10-15 videos

```bash
# Instead of all 31 remaining videos
npx tsx scripts/batch-ingest-all.ts --playlist 2022-mentorship --limit 10
npx tsx scripts/batch-ingest-all.ts --playlist 2022-mentorship --limit 10
npx tsx scripts/batch-ingest-all.ts --playlist 2022-mentorship --limit 11
```

### Issue: Embeddings Taking Too Long

**Cause:** Ollama not optimized or CPU-bound

**Solution:**
1. Skip embeddings initially (semantic search is optional)
2. Generate embeddings later in batches of 5-10 chunks

```bash
# Without embeddings (faster)
npx tsx scripts/batch-ingest-all.ts --playlist market-maker-series

# Later, add embeddings if needed
npx tsx scripts/batch-ingest-all.ts --playlist market-maker-series --embed --skip-transcript --skip-processing
```

---

## Architecture Details

### Video List Structure

`scripts/ict-video-list.json`:
```json
{
  "playlists": {
    "if-i-could-go-back": {
      "name": "If I Could Go Back Series",
      "videos": [
        { "id": "dXQtPbz7Z3c", "title": "..." },
        ...
      ]
    },
    "market-maker-series": { ... },
    "2022-mentorship": { ... }
  }
}
```

### Processing Pipeline

1. **Extract** (`scripts/batch-extract.ts`)
   - Calls youtube-transcript-api
   - Saves JSON with fullText + metadata
   - Output: `knowledge-base/sources/youtube/{videoId}.json`

2. **Process** (`scripts/process-transcripts-batch.ts`)
   - Parses transcript text
   - Extracts key concepts using Claude API
   - Creates markdown files by concept
   - Output: `knowledge-base/concepts/{category}/{concept}.md`

3. **Chunk** (`src/lib/kb/process/chunker.ts`)
   - Splits markdown by headers (H2 boundaries)
   - Fallback recursive split (512 tokens)
   - Preserves metadata: source, concept, section

4. **Ingest** (`scripts/ingest-concepts.ts`)
   - Stores chunks in `knowledgeChunks` table
   - Updates foreign key relationships
   - Creates text search indices

5. **Embed** (via Ollama)
   - Calls `nomic-embed-text` model
   - 768-dim vectors for each chunk
   - Stored in SQLite blob column

---

## Database Schema

`knowledgeChunks` table:
```typescript
{
  id: number,
  content: string,           // The actual chunk text
  sourceType: string,        // 'youtube'
  sourceUrl: string,         // Link to video
  videoId: string,          // YouTube video ID
  timestamp: string,         // "12:34" (if available)
  concept: string,           // 'order-blocks', 'fvg', etc.
  section: string,          // From H2 header
  filePath: string,         // knowledge-base/concepts/...
  embedding: blob,          // 768-dim vector (optional)
  createdAt: timestamp
}
```

---

## Next Steps After Ingestion

1. **Test Search Interface**
   ```bash
   pnpm dev
   # Visit http://localhost:3000/kb-search
   # Try searching: "fair value gap", "order blocks", "kill zones"
   ```

2. **Generate Flashcards**
   ```bash
   pnpm tsx scripts/generate-flashcards.ts
   # Creates ~1,900 flashcards from chunks
   ```

3. **Export to Anki**
   ```bash
   pnpm tsx scripts/generate-flashcards.ts --export
   # Creates TSV files in knowledge-base/exports/anki/
   ```

4. **Enable Semantic Search**
   - If embeddings generated, semantic search now available
   - Uses vector similarity for better results

---

## Questions?

Check:
- `docs/KNOWLEDGE_BASE_SETUP.md` - Full KB documentation
- `docs/FLASHCARDS.md` - Flashcard generation docs
- `scripts/batch-extract.ts` - Transcript extraction code
- `scripts/process-transcripts-batch.ts` - Concept processing code

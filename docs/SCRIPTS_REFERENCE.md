# Scripts Reference

Complete guide to all build and ingestion scripts for the ICT Knowledge Base project.

---

## Quick Access

| Script | Purpose | Usage |
|--------|---------|-------|
| `batch-ingest-all.ts` | 🚀 Master pipeline (NEW) | `npx tsx scripts/batch-ingest-all.ts --playlist <name>` |
| `validate-video-list.ts` | ✅ Check video IDs status | `npx tsx scripts/validate-video-list.ts` |
| `batch-extract.ts` | 📥 Extract transcripts | `npx tsx scripts/batch-extract.ts --playlist <name>` |
| `process-transcripts-batch.ts` | 🔄 Process concepts | `npx tsx scripts/process-transcripts-batch.ts` |
| `generate-flashcards.ts` | 📚 Create flashcards | `npx tsx scripts/generate-flashcards.ts` |
| `ingest-concepts.ts` | 💾 Load into database | `npx tsx scripts/ingest-concepts.ts` |
| `extract-transcript.ts` | 🎬 Single video | `npx tsx scripts/extract-transcript.ts <videoId>` |
| `verify-ollama.ts` | 🧠 Check embeddings setup | `npx tsx scripts/verify-ollama.ts` |

---

## Detailed Reference

### 1. validate-video-list.ts ✅

**Purpose:** Check if all video IDs are populated in `ict-video-list.json`

**Usage:**
```bash
npx tsx scripts/validate-video-list.ts
```

**Output:**
```
📋 ICT Video List Status
═══════════════════════════════════════════════════

If I Could Go Back Series
─────────────────────────
  Videos: 0/7 populated
  ❌ 7 video IDs needed

Market Maker Series
─────────────────────────
  Videos: 0/15 populated
  ❌ 15 video IDs needed

ICT 2022 Mentorship
─────────────────────────
  Videos: 10/41 populated
  ❌ 31 video IDs needed

═══════════════════════════════════════════════════
📊 Overall Summary
Total Videos: 63
✅ Populated: 10
❌ Needed: 53
Progress: 15.9%
```

**When to use:**
- Before running batch ingestion
- To check completion progress
- To identify which playlists need video IDs

---

### 2. batch-ingest-all.ts 🚀 (NEW - RECOMMENDED)

**Purpose:** Complete pipeline for video ingestion (transcript → concepts → chunks → database → embeddings)

**Usage:**
```bash
# Test first 3 videos
npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back --limit 3

# Full playlist
npx tsx scripts/batch-ingest-all.ts --playlist market-maker-series

# With embeddings
npx tsx scripts/batch-ingest-all.ts --playlist 2022-mentorship --embed

# Resume from checkpoint
npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back --resume
```

**Flags:**
- `--playlist <name>` (required) - Which playlist to process
- `--limit <n>` (optional) - Max videos to process
- `--embed` (optional) - Generate embeddings via Ollama
- `--resume` (optional) - Continue from last checkpoint
- `--skip-transcript` (optional) - Skip extraction (use existing)
- `--skip-processing` (optional) - Skip concept processing

**Pipeline stages:**
1. Extract transcripts from YouTube
2. Process into concept markdown files
3. Chunk knowledge content (512 tokens)
4. Ingest chunks into SQLite
5. Generate embeddings (optional)

**Why use this:** Handles everything in one command. Recommended for 90% of use cases.

---

### 3. batch-extract.ts 📥

**Purpose:** Extract transcripts from YouTube videos only

**Usage:**
```bash
npx tsx scripts/batch-extract.ts --playlist 2022-mentorship

npx tsx scripts/batch-extract.ts --playlist if-i-could-go-back --limit 5
```

**Flags:**
- `--playlist <name>` (required)
- `--limit <n>` (optional)

**Output:**
```
knowledge-base/sources/youtube/
├── kt6V4ai60fI.json        # Transcript + metadata
├── tmeCWULSTHc.json
└── ...
```

**When to use:**
- If you only want transcripts (no concept processing)
- To test if videos have captions available
- With `--limit` to test a small batch first

**Error handling:**
- Gracefully handles videos without transcripts
- Returns detailed error messages
- Continues processing remaining videos

---

### 4. extract-transcript.ts 🎬

**Purpose:** Extract transcript from a single video

**Usage:**
```bash
npx tsx scripts/extract-transcript.ts kt6V4ai60fI

npx tsx scripts/extract-transcript.ts --video-id kt6V4ai60fI --save-path ./transcript.json
```

**Output:**
```json
{
  "videoId": "kt6V4ai60fI",
  "text": "...",
  "language": "en",
  "metadata": { ... }
}
```

**When to use:**
- Testing a specific video
- Debugging transcript issues
- Quick manual extraction

---

### 5. process-transcripts-batch.ts 🔄

**Purpose:** Convert raw transcripts into structured concepts

**Usage:**
```bash
npx tsx scripts/process-transcripts-batch.ts --playlist 2022-mentorship

npx tsx scripts/process-transcripts-batch.ts --playlist if-i-could-go-back --concept-mapping ./custom-mapping.json
```

**Output:**
```
knowledge-base/concepts/
├── psychology/
│   ├── personal-responsibility.md
│   └── three-stages-of-trading.md
├── market-structure/
│   ├── market-structure-break.md
│   └── premium-discount.md
└── ...
```

**Features:**
- Extracts concepts using Claude API
- Groups by category (psychology, liquidity, etc.)
- Creates markdown with YAML frontmatter
- Preserves source attribution

**When to use:**
- After extracting transcripts
- To generate markdown files for knowledge base
- To structure concepts by category

---

### 6. ingest-concepts.ts 💾

**Purpose:** Load concept markdown files into SQLite database

**Usage:**
```bash
npx tsx scripts/ingest-concepts.ts

npx tsx scripts/ingest-concepts.ts --playlist if-i-could-go-back

npx tsx scripts/ingest-concepts.ts --concept fair-value-gap
```

**Reads from:**
```
knowledge-base/concepts/**/*.md
```

**Writes to:**
```
SQLite: data/ict-trading.db
Tables:
  - knowledgeChunks (main content)
  - conceptReferences (cross-references)
```

**When to use:**
- After markdown files are created
- To update database with new concepts
- Part of batch pipeline

---

### 7. generate-flashcards.ts 📚

**Purpose:** Create FSRS-compatible flashcards from knowledge chunks

**Usage:**
```bash
# Generate all flashcards
npx tsx scripts/generate-flashcards.ts

# Single concept
npx tsx scripts/generate-flashcards.ts --concept=order-blocks

# Test with limit
npx tsx scripts/generate-flashcards.ts --limit=50

# Export to Anki
npx tsx scripts/generate-flashcards.ts --export
```

**Output:**
```
Database: flashcards table
  ~1,900 flashcards with FSRS metadata

Exports (if --export):
knowledge-base/exports/anki/
├── order-blocks.txt
├── fair-value-gap.txt
└── ...
```

**Features:**
- Generates 3-7 cards per chunk
- Types: basic, cloze, sequence
- FSRS scheduling included
- Anki-compatible export

**When to use:**
- After all knowledge is ingested
- To create study materials
- To prepare for Anki export

---

### 8. verify-ollama.ts 🧠

**Purpose:** Check if Ollama embeddings are available and working

**Usage:**
```bash
npx tsx scripts/verify-ollama.ts
```

**Output:**
```
🧠 Ollama Verification
═════════════════════════════
✅ Ollama running on localhost:11434
✅ Model 'nomic-embed-text' available
✅ Test embedding generated: 768-dim vector
✅ Ready for batch embedding
```

**When to use:**
- Before running embeddings
- To debug embedding issues
- To test Ollama setup

**Requirements:**
```bash
ollama serve              # Ollama must be running
ollama pull nomic-embed-text  # Model must be installed
```

---

## Workflow Examples

### Example 1: Fresh Start (All Videos)

```bash
# 1. Check video IDs
npx tsx scripts/validate-video-list.ts

# 2. Populate missing IDs in scripts/ict-video-list.json

# 3. Test with small batch
npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back --limit 2

# 4. If successful, run full ingestion
npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back
npx tsx scripts/batch-ingest-all.ts --playlist market-maker-series
npx tsx scripts/batch-ingest-all.ts --playlist 2022-mentorship --limit 31

# 5. Generate flashcards
npx tsx scripts/generate-flashcards.ts

# 6. Study!
pnpm dev
# Visit http://localhost:3000/flashcards
```

### Example 2: Incremental Updates

```bash
# Add new videos to playlist
# Update scripts/ict-video-list.json

# Ingest only new videos
npx tsx scripts/batch-ingest-all.ts --playlist 2022-mentorship --limit 5

# Update search index
pnpm db:studio

# Generate flashcards for new content
npx tsx scripts/generate-flashcards.ts --concept new-concept-name

# Test search
pnpm dev
```

### Example 3: Embeddings Setup

```bash
# 1. Verify Ollama is running
npx tsx scripts/verify-ollama.ts

# 2. Generate embeddings for existing content
npx tsx scripts/batch-ingest-all.ts \
  --playlist if-i-could-go-back \
  --embed \
  --skip-transcript \
  --skip-processing

# 3. Test semantic search
pnpm dev
# Search at http://localhost:3000/kb-search
```

---

## Error Handling & Recovery

### Issue: One playlist fails

**Problem:**
```
❌ Market Maker Series - Episode 5 failed: No captions available
```

**Solution:**
```bash
# Skip the failed video and continue
npx tsx scripts/batch-ingest-all.ts \
  --playlist market-maker-series \
  --resume

# Or process other videos
npx tsx scripts/batch-ingest-all.ts \
  --playlist 2022-mentorship
```

### Issue: Out of Memory

**Problem:** Processing too many videos at once

**Solution:**
```bash
# Use --limit to process in smaller batches
npx tsx scripts/batch-ingest-all.ts \
  --playlist 2022-mentorship \
  --limit 10

# ... wait for completion, then process next batch
npx tsx scripts/batch-ingest-all.ts \
  --playlist 2022-mentorship \
  --limit 10 \
  --skip-transcript \
  --skip-processing

# etc.
```

### Issue: Database connection error

**Problem:** SQLite locked or corrupted

**Solution:**
```bash
# Reset database
rm data/ict-trading.db

# Reinitialize schema
pnpm db:migrate

# Start ingestion again
npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back
```

---

## Performance Notes

| Script | Time (per video) | Total (53 videos) |
|--------|------------------|-------------------|
| Extract transcript | 2-5 sec | 2-4 min |
| Process concepts | 5-10 sec | 4-8 min |
| Chunk content | <1 sec | <1 min |
| Ingest to DB | <1 sec | <1 min |
| Generate embeddings | 10-30 sec | 8-25 min |
| **Total (no embeddings)** | **~10-20 sec** | **~9-15 min** |
| **Total (with embeddings)** | **~20-50 sec** | **~18-45 min** |

---

## Configuration Files

### scripts/ict-video-list.json

Master list of all videos to ingest. Structure:

```json
{
  "playlists": {
    "playlist-key": {
      "name": "Display Name",
      "playlistUrl": "YouTube playlist URL",
      "videoCount": 15,
      "phase": "Phase X: Name",
      "focus": "Brief description",
      "videos": [
        { "id": "VIDEO_ID", "title": "Video Title" },
        ...
      ]
    }
  }
}
```

**How to populate:**
1. Go to YouTube playlist
2. Extract video IDs using browser console
3. Update corresponding playlist entry

---

## Next Steps

1. **Populate video IDs** → `npx tsx scripts/validate-video-list.ts`
2. **Run batch ingestion** → `npx tsx scripts/batch-ingest-all.ts --playlist <name>`
3. **Generate flashcards** → `npx tsx scripts/generate-flashcards.ts`
4. **Study!** → `pnpm dev` then visit http://localhost:3000/flashcards

---

## Need Help?

- **Batch Ingestion Guide:** `docs/BATCH_INGESTION.md`
- **Knowledge Base Setup:** `docs/KNOWLEDGE_BASE_SETUP.md`
- **Flashcard System:** `docs/FLASHCARDS.md`
- **Project Overview:** `docs/PROJECT_SUMMARY.md`

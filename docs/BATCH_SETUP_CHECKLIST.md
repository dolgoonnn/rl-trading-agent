# Batch Ingestion Setup Checklist

Complete checklist for ingesting remaining ICT videos into the knowledge base.

---

## ✅ What's Been Prepared

### 1. Infrastructure
- [x] Updated video list structure (`scripts/ict-video-list.json`)
  - Added: "If I Could Go Back" series (7 videos)
  - Added: Market Maker Series (15 videos)
  - Added: Remaining 2022 Mentorship (31 episodes 11-41)
  - Existing: First 10 Mentorship episodes ✅

- [x] Created batch ingestion script (`scripts/batch-ingest-all.ts`)
  - Handles full pipeline in one command
  - Supports multiple playlists
  - Includes error recovery and resuming

- [x] Created validation script (`scripts/validate-video-list.ts`)
  - Checks if all video IDs are populated
  - Shows progress/completion status
  - Identifies missing videos

### 2. Documentation
- [x] `docs/BATCH_INGESTION.md`
  - How to find video IDs
  - Step-by-step ingestion guide
  - Complete pipeline explanation
  - Troubleshooting guide

- [x] `docs/SCRIPTS_REFERENCE.md`
  - Complete script documentation
  - Usage examples for each script
  - Workflow examples
  - Performance benchmarks

- [x] `docs/BATCH_SETUP_CHECKLIST.md` (this file)
  - Setup instructions
  - Quick reference

### 3. Current Status
- **Videos Extracted:** 10/63 (Episodes 1-10 of 2022 Mentorship)
- **Concepts:** 29 extracted from 275 chunks
- **Flashcards:** 1,900+ created with FSRS scheduling
- **Database:** SQLite with 275 chunks indexed
- **Progress:** 16% complete

---

## 🎯 Your Checklist

### Step 1: Get Video IDs ⏳ [BLOCKED - AWAITING USER]

#### Option A: Automatic Extraction (Easiest)

1. **Go to each YouTube playlist:**
   - "If I Could Go Back" on Inner Circle Trader channel
   - "Market Maker Series" (or search "ICT ForeXmas")
   - "2022 Mentorship" playlist

2. **Open browser DevTools (F12)**

3. **Go to Console tab**

4. **Paste this code:**
   ```javascript
   const videos = Array.from(document.querySelectorAll('[href*="/watch?v="]'))
     .map(a => ({
       id: new URL(a.href).searchParams.get('v'),
       title: a.textContent.trim()
     }))
     .filter((v, i, a) => a.findIndex(u => u.id === v.id) === i);
   console.log(JSON.stringify(videos, null, 2));
   ```

5. **Copy the output**

6. **Update `scripts/ict-video-list.json`** with the video IDs

#### Option B: Manual Extraction

1. Right-click each video → Copy URL
2. Extract 11-character ID from URL
3. Add to `scripts/ict-video-list.json`

#### Option C: Provide Links

Provide YouTube playlist links or search terms, and I can extract IDs for you.

---

### Step 2: Validate Setup ✅

Once video IDs are in place:

```bash
# Check everything is ready
npx tsx scripts/validate-video-list.ts
```

**Expected output:**
```
📊 Overall Summary
Total Videos: 63
✅ Populated: 63
❌ Needed: 0
Progress: 100%

✅ All video IDs populated! Ready to ingest.
```

---

### Step 3: Test with Small Batch 🧪

Before processing all 53 videos, test with a small batch:

```bash
# Test first 2 videos from "If I Could Go Back"
npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back --limit 2
```

**What to check:**
- ✅ Transcripts extract successfully
- ✅ No "No captions available" errors
- ✅ Concepts parse correctly
- ✅ Database receives new chunks

**If successful:** Proceed to step 4

**If errors:** Check troubleshooting in `docs/BATCH_INGESTION.md`

---

### Step 4: Run Full Batch Ingestion 🚀

Process all remaining videos:

```bash
# If I Could Go Back (7 videos, ~2-3 min)
npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back

# Market Maker Series (15 videos, ~5-7 min)
npx tsx scripts/batch-ingest-all.ts --playlist market-maker-series

# Remaining 2022 Mentorship (31 videos, ~15 min)
npx tsx scripts/batch-ingest-all.ts --playlist 2022-mentorship --limit 31
```

**Total time:** ~25-30 minutes

**What happens:**
1. Extracts transcripts from YouTube
2. Processes into concept markdown files
3. Chunks knowledge content
4. Stores in SQLite database
5. Creates search indices

---

### Step 5: Verify Ingestion ✅

Check database received new chunks:

```bash
# Open Drizzle Studio
pnpm db:studio

# Check knowledgeChunks table for:
# - New rows with playlist source
# - All concepts mapped correctly
# - ~1,200 total chunks (275 existing + ~900 new)
```

---

### Step 6: Generate Flashcards 📚

Create study cards from new knowledge:

```bash
npx tsx scripts/generate-flashcards.ts
```

**Output:**
- ~1,900 total flashcards (existing + new)
- FSRS scheduling included
- Ready to study at `/flashcards`

---

### Step 7: Test Everything 🎉

```bash
# Start dev server
pnpm dev

# Test search
# Visit: http://localhost:3000/kb-search
# Search: "fair value gap", "order blocks", "kill zones"

# Test flashcards
# Visit: http://localhost:3000/flashcards
# Study new content
```

---

## 📊 Expected Results

After completing all steps:

| Metric | Before | After | Growth |
|--------|--------|-------|--------|
| Videos Indexed | 10 | 63 | +53 |
| Concepts | 29 | ~60 | +31 |
| Chunks | 275 | ~1,200 | +925 |
| Flashcards | 1,900 | ~2,500 | +600 |
| Knowledge Coverage | 16% | 100% | +84% |

**Knowledge Base Coverage:**
- ✅ Phase 1: Foundation (If I Could Go Back)
- ✅ Phase 2: Core Concepts (Market Maker Series)
- ✅ Phase 3: Price Delivery (2016 content - existing)
- ✅ Phase 4-6: Entry Models & Advanced (2022 Mentorship complete)

---

## 🎬 Timeline

| Stage | Duration | Status |
|-------|----------|--------|
| Get Video IDs | ~30 min | ⏳ Waiting for you |
| Validate Setup | <1 min | ⏳ Pending |
| Test Batch | ~3 min | ⏳ Pending |
| Full Ingestion | ~25 min | ⏳ Pending |
| Generate Flashcards | ~30 min | ⏳ Pending |
| Verification | ~5 min | ⏳ Pending |
| **Total** | **~2 hours** | ⏳ **Pending** |

---

## 📝 Quick Commands Reference

```bash
# Check status
npx tsx scripts/validate-video-list.ts

# Test ingestion
npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back --limit 2

# Full ingestion
npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back
npx tsx scripts/batch-ingest-all.ts --playlist market-maker-series
npx tsx scripts/batch-ingest-all.ts --playlist 2022-mentorship --limit 31

# Generate flashcards
npx tsx scripts/generate-flashcards.ts

# Run dev server
pnpm dev

# Open database GUI
pnpm db:studio
```

---

## 💾 Files to Update

Only one file needs modification:

### `scripts/ict-video-list.json`

Replace `NEED_VIDEO_ID_1`, `NEED_VIDEO_ID_2`, etc. with real YouTube video IDs.

**Example:**
```json
{
  "id": "dXQtPbz7Z3c",  // ← Real YouTube video ID
  "title": "If I Could Go Back - Part 1"
}
```

**Where to get IDs:**
- YouTube URL: `https://www.youtube.com/watch?v=dXQtPbz7Z3c`
- ID is the 11-character string after `v=`

---

## ❓ Need Help?

**Documentation:**
- `docs/BATCH_INGESTION.md` - Full guide with examples
- `docs/SCRIPTS_REFERENCE.md` - Detailed script documentation
- `docs/BATCH_SETUP_CHECKLIST.md` - This checklist

**Common Issues:**
- Transcript extraction fails → Check if video has captions
- Rate limit errors → Wait 1-2 minutes, use `--resume`
- Out of memory → Use `--limit 10` for smaller batches
- Database errors → Delete `data/ict-trading.db` and restart

**Next Steps:**
1. Extract video IDs from YouTube playlists
2. Update `scripts/ict-video-list.json`
3. Run `npx tsx scripts/validate-video-list.ts`
4. Run `npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back`

---

## 🚀 Let's Go!

Everything is ready. Just need those 53 video IDs, then we can:

✅ Index all remaining ICT videos
✅ Create ~900 new knowledge chunks
✅ Generate ~600 new flashcards
✅ Enable full knowledge base search
✅ Complete Phase 1-6 coverage

**You're 16% of the way there. Let's finish this! 🎯**

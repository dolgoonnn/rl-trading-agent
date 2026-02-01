# YouTube Video ID Extraction Guide

Complete guide to extract ICT video IDs from YouTube playlists for batch ingestion.

---

## Quick Summary

**Three Playlists Needed:**
- ✅ **2022 Mentorship**: Episodes 1-10 already done, need 11-41
- ❌ **If I Could Go Back**: 7 videos (Phase 1 foundation)
- ❌ **Market Maker Primer**: 15+ videos (Phase 2 core concepts)

**Total needed: 53 video IDs**

---

## Method 1: Using Python Script (Easiest)

### Prerequisites

```bash
# Install yt-dlp (handles YouTube playlist extraction)
pip install yt-dlp

# Or if you prefer:
pip3 install yt-dlp
```

### Run Extraction

```bash
cd /Users/apple/projects/ict-trading

# Extract all playlists automatically
python3 scripts/extract-youtube-ids.py
```

**Output:**
- Automatically updates `scripts/ict-video-list.json` with all video IDs
- Shows extracted video count per playlist
- Ready to validate and ingest immediately

**Time needed:** ~2-3 minutes

---

## Method 2: Browser Console (Manual)

### Steps

1. **Visit "If I Could Go Back" Playlist:**
   - Go to: https://www.youtube.com/playlist?list=PLrlNxdU85imVq0g0_F6l2S1gz6-cHfvyN

2. **Open Browser DevTools:**
   - Press F12 (or Cmd+Option+J on Mac)
   - Click "Console" tab

3. **Paste This Code:**

```javascript
// Extract all video IDs from current playlist
const videos = Array.from(document.querySelectorAll('[href*="/watch?v="]'))
  .map(a => {
    const url = a.href;
    const videoId = new URL(url).searchParams.get('v');
    const title = a.getAttribute('title') || a.textContent.trim() || 'Unknown';
    return { videoId, title };
  })
  .filter((v, i, a) => v.videoId && a.findIndex(u => u.videoId === v.videoId) === i)
  .sort((a, b) => {
    // Try to maintain playlist order by sorting by appearance
    const aNum = parseInt(a.title.match(/\d+/)?.[0] || '999');
    const bNum = parseInt(b.title.match(/\d+/)?.[0] || '999');
    return aNum - bNum;
  });

// Output as JSON
const output = {
  playlistUrl: window.location.href,
  videoCount: videos.length,
  videos: videos.map((v, i) => ({
    id: v.videoId,
    title: v.title || `Video ${i + 1}`
  }))
};

console.log('='.repeat(70));
console.log('Copy the JSON below and save to scripts/ict-video-list.json');
console.log('='.repeat(70));
console.log(JSON.stringify(output, null, 2));
console.log('='.repeat(70));
```

4. **Copy Output:**
   - Right-click output → Copy
   - Save to `scripts/ict-video-list.json`

5. **Repeat for Other Playlists:**
   - Market Maker Primer: https://www.youtube.com/playlist?list=PLVgHx4Z63paah1dHyad1OMJQJdm6iP2Yn
   - 2022 Mentorship (for episodes 11-41)

---

## Method 3: Using yt-dlp Directly

### One-Liner Commands

```bash
# If I Could Go Back
yt-dlp --dump-json --flat-playlist --no-warnings "https://www.youtube.com/playlist?list=PLrlNxdU85imVq0g0_F6l2S1gz6-cHfvyN" | python3 -c "import sys, json; data = json.load(sys.stdin); [print(e['id']) for e in data.get('entries', [])]"

# Market Maker Primer
yt-dlp --dump-json --flat-playlist --no-warnings "https://www.youtube.com/playlist?list=PLVgHx4Z63paah1dHyad1OMJQJdm6iP2Yn" | python3 -c "import sys, json; data = json.load(sys.stdin); [print(e['id']) for e in data.get('entries', [])]"

# 2022 Mentorship
yt-dlp --dump-json --flat-playlist --no-warnings "https://www.youtube.com/playlist?list=PLVgHx4Z63paYiFGQ56PjTF1PGePL3r69s" | python3 -c "import sys, json; data = json.load(sys.stdin); [print(e['id']) for e in data.get('entries', [])]"
```

### Save to File

```bash
yt-dlp --dump-json --flat-playlist "PLAYLIST_URL" > playlist.json
python3 -c "import json; data=json.load(open('playlist.json')); print('\n'.join([e['id'] for e in data.get('entries',[])]))" > video_ids.txt
```

---

## Recommended: Method 1 (Python Script)

### Why?

✅ Automatic
✅ Fast (~2 minutes for all 3 playlists)
✅ Error handling built-in
✅ Directly updates video list JSON
✅ No manual copy/paste needed
✅ Ready to validate and ingest immediately

### Setup & Run

```bash
# 1. Install yt-dlp
pip3 install yt-dlp

# 2. Extract all videos
python3 scripts/extract-youtube-ids.py

# 3. Validate
npx tsx scripts/validate-video-list.ts

# 4. Start ingestion
npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back
```

---

## Post-Extraction Steps

After extracting video IDs:

```bash
# 1. Verify extraction
npx tsx scripts/validate-video-list.ts

# Expected output:
# ✅ All video IDs populated! Ready to ingest.

# 2. Test with small batch
npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back --limit 2

# 3. If successful, run full ingestion
npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back
npx tsx scripts/batch-ingest-all.ts --playlist market-maker-series
npx tsx scripts/batch-ingest-all.ts --playlist 2022-mentorship

# 4. Generate flashcards
npx tsx scripts/generate-flashcards.ts

# 5. Study!
pnpm dev
# Visit http://localhost:3000/flashcards
```

---

## Troubleshooting

### Issue: "yt-dlp not found"

**Solution:**
```bash
pip3 install yt-dlp
# Or on Windows:
py -m pip install yt-dlp
```

### Issue: "Connection timeout"

**Solution:**
- Check internet connection
- Try again (YouTube may be rate-limiting)
- Use VPN if YouTube is blocked in your region

### Issue: Some playlists extract 0 videos

**Cause:** Playlist might be unavailable or private

**Solution:**
1. Verify URL is correct
2. Try opening playlist in browser first
3. Use browser console method instead

### Issue: Video count doesn't match expected

**Possible causes:**
- Playlist has unlisted/private videos (won't extract)
- YouTube changed playlist structure
- Some videos removed from playlist

**Solution:** Check manually, then manually add missing IDs to `scripts/ict-video-list.json`

---

## File Structure

After extraction, `scripts/ict-video-list.json` should look like:

```json
{
  "playlists": {
    "if-i-could-go-back": {
      "name": "If I Could Go Back Series",
      "playlistUrl": "https://www.youtube.com/playlist?list=...",
      "videoCount": 7,
      "videos": [
        { "id": "abc123DEF45", "title": "If I Could Go Back - Part 1" },
        { "id": "xyz789GHI01", "title": "If I Could Go Back - Part 2" },
        ...
      ]
    },
    "market-maker-series": { ... },
    "2022-mentorship": { ... }
  }
}
```

---

## Timeline

| Task | Time |
|------|------|
| Install yt-dlp | 1 min |
| Extract all video IDs | 2-3 min |
| Validate setup | <1 min |
| **Total** | **~5 min** |

Then batch ingestion takes ~25-30 minutes.

**Total time to complete: ~35-40 minutes**

---

## Alternative: Manual Playlist Links

If automated extraction fails, provide me with:
- Direct YouTube playlist URLs
- Or playlist search terms (e.g., "ICT Market Maker Primer 2024")

And I'll extract the IDs manually and populate the list for you.

---

## Next Steps

1. **Extract video IDs** (choose a method above)
2. **Validate:** `npx tsx scripts/validate-video-list.ts`
3. **Run batch ingestion:** `npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back`
4. **Generate flashcards:** `npx tsx scripts/generate-flashcards.ts`
5. **Study!** Visit http://localhost:3000/flashcards

---

## Support

- **Extraction issues?** Check troubleshooting above
- **Not sure about method?** Use Method 1 (Python script)
- **Still stuck?** Provide playlist URLs and I'll help extract IDs

---

**Ready to complete the knowledge base? Run the extraction now! 🚀**

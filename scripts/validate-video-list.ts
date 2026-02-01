#!/usr/bin/env npx tsx
/**
 * Validate and check status of ict-video-list.json
 *
 * Usage:
 *   npx tsx scripts/validate-video-list.ts
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

interface Video {
  id: string;
  title: string;
}

interface Playlist {
  name: string;
  videos: Video[];
  videoCount?: number;
  phase?: string;
  focus?: string;
}

interface VideoList {
  playlists: Record<string, Playlist>;
}

async function main() {
  try {
    const listPath = join(process.cwd(), 'scripts', 'ict-video-list.json');
    const content = await readFile(listPath, 'utf-8');
    const videoList = JSON.parse(content) as VideoList;

    console.log('\n📋 ICT Video List Status');
    console.log('═'.repeat(70));

    let totalVideos = 0;
    let totalPopulated = 0;
    let totalNeeded = 0;

    for (const [, playlist] of Object.entries(videoList.playlists)) {
      const videoCount = playlist.videos.length;
      const populated = playlist.videos.filter((v) => !v.id.includes('NEED_')).length;
      const needed = videoCount - populated;

      totalVideos += videoCount;
      totalPopulated += populated;
      totalNeeded += needed;

      console.log(`\n${playlist.name}`);
      console.log('─'.repeat(70));

      if (playlist.phase) console.log(`  Phase: ${playlist.phase}`);
      if (playlist.focus) console.log(`  Focus: ${playlist.focus}`);

      console.log(`  Videos: ${populated}/${videoCount} populated`);

      if (needed > 0) {
        console.log(`  ❌ ${needed} video IDs needed`);
      } else {
        console.log(`  ✅ All video IDs populated`);
      }

      // Show first few and last few
      if (needed > 0 && needed <= 5) {
        console.log(`  Missing IDs:`);
        playlist.videos
          .filter((v) => v.id.includes('NEED_'))
          .slice(0, 3)
          .forEach((v) => {
            console.log(`    - ${v.title}`);
          });
        if (needed > 3) {
          console.log(`    ... and ${needed - 3} more`);
        }
      }
    }

    console.log('\n' + '═'.repeat(70));
    console.log('📊 Overall Summary');
    console.log('─'.repeat(70));
    console.log(`  Total Videos: ${totalVideos}`);
    console.log(`  ✅ Populated: ${totalPopulated}`);
    console.log(`  ❌ Needed: ${totalNeeded}`);
    const percentComplete = ((totalPopulated / totalVideos) * 100).toFixed(1);
    console.log(`  Progress: ${percentComplete}%`);

    if (totalNeeded === 0) {
      console.log(`\n✅ All video IDs populated! Ready to ingest.`);
      console.log(`\nNext steps:`);
      console.log(`  1. Run: npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back --limit 2`);
      console.log(`  2. Verify transcripts extracted successfully`);
      console.log(`  3. Run full ingestion: npx tsx scripts/batch-ingest-all.ts --playlist <name>`);
    } else {
      console.log(`\n⏳ ${totalNeeded} video IDs still needed.`);
      console.log(`\nHow to get video IDs:`);
      console.log(`  1. Visit YouTube playlist`);
      console.log(`  2. Open DevTools (F12) → Console`);
      console.log(`  3. Paste code from docs/BATCH_INGESTION.md (Method B)`);
      console.log(`  4. Copy output and update scripts/ict-video-list.json`);
    }

    console.log('');

    if (totalNeeded > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error reading video list:', error);
    process.exit(1);
  }
}

main();

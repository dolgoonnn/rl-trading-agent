#!/usr/bin/env npx tsx
/**
 * Batch extract transcripts from ICT video list.
 *
 * Usage:
 *   npx tsx scripts/batch-extract.ts [--playlist <name>] [--limit <n>]
 */

import { writeFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { getTranscript } from '../src/lib/kb/ingest/youtube';

interface Video {
  id: string;
  title: string;
}

interface Playlist {
  name: string;
  playlistUrl: string;
  videos: Video[];
}

interface VideoList {
  playlists: Record<string, Playlist>;
}

async function main() {
  const args = process.argv.slice(2);
  let playlistName = '2022-mentorship';
  let limit = 5;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--playlist' && args[i + 1]) {
      playlistName = args[++i] ?? playlistName;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[++i] ?? '5', 10);
    }
  }

  // Load video list
  const listPath = join(process.cwd(), 'scripts', 'ict-video-list.json');
  const listContent = await readFile(listPath, 'utf-8');
  const videoList = JSON.parse(listContent) as VideoList;

  const playlist = videoList.playlists[playlistName];
  if (!playlist) {
    console.error(`Playlist '${playlistName}' not found`);
    process.exit(1);
  }

  console.log(`\n📚 Extracting: ${playlist.name}`);
  console.log(`   Videos: ${Math.min(limit, playlist.videos.length)} of ${playlist.videos.length}`);
  console.log('─'.repeat(50));

  const outputDir = join(process.cwd(), 'knowledge-base', 'sources', 'youtube');
  await mkdir(outputDir, { recursive: true });

  const results: { success: string[]; failed: string[] } = { success: [], failed: [] };

  for (let i = 0; i < Math.min(limit, playlist.videos.length); i++) {
    const video = playlist.videos[i];
    if (!video) continue;

    process.stdout.write(`\n[${i + 1}/${Math.min(limit, playlist.videos.length)}] ${video.title}...`);

    try {
      const transcript = await getTranscript(video.id, { grouped: true });

      if (transcript.error) {
        console.log(` ❌ ${transcript.error}`);
        results.failed.push(video.id);
        continue;
      }

      const output = {
        videoId: video.id,
        title: video.title,
        playlist: playlist.name,
        language: transcript.language,
        extractedAt: new Date().toISOString(),
        segmentCount: transcript.segments?.length ?? 0,
        fullText: transcript.fullText,
        groupedSegments: transcript.groupedSegments,
      };

      const outputPath = join(outputDir, `${video.id}.json`);
      await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf-8');

      console.log(` ✓ ${transcript.segments?.length ?? 0} segments`);
      results.success.push(video.id);

      // Small delay to avoid rate limiting
      await new Promise((r) => setTimeout(r, 500));
    } catch (error) {
      console.log(` ❌ ${error instanceof Error ? error.message : 'Unknown error'}`);
      results.failed.push(video.id);
    }
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`✅ Success: ${results.success.length}`);
  if (results.failed.length > 0) {
    console.log(`❌ Failed: ${results.failed.length} (${results.failed.join(', ')})`);
  }
  console.log(`\n📁 Transcripts saved to: ${outputDir}`);
  console.log('\n📋 Next: Ask Claude Code to process these transcripts');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});

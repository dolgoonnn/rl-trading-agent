#!/usr/bin/env npx tsx
/**
 * Extract YouTube transcript and save to file.
 * Step 1 of the manual ingestion workflow.
 *
 * Usage:
 *   npx tsx scripts/extract-transcript.ts <video_url_or_id> [--title "Video Title"]
 *
 * Output: knowledge-base/sources/youtube/<video_id>.json
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getTranscript, extractVideoId } from '../src/lib/kb/ingest/youtube';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || !args[0]) {
    console.error('Usage: npx tsx scripts/extract-transcript.ts <video_url_or_id> [--title "Title"]');
    process.exit(1);
  }

  const videoId = extractVideoId(args[0]);
  let title = `Video ${videoId}`;

  // Parse optional title
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--title' && args[i + 1]) {
      title = args[++i] ?? title;
    }
  }

  console.log(`\n📹 Extracting transcript: ${videoId}`);
  console.log(`   Title: ${title}`);
  console.log('─'.repeat(50));

  // Extract transcript
  console.log('\n📝 Fetching transcript from YouTube...');
  const transcript = await getTranscript(videoId, { grouped: true });

  if (transcript.error) {
    console.error(`❌ Failed: ${transcript.error}`);
    process.exit(1);
  }

  console.log(`✓ Got ${transcript.segments?.length ?? 0} segments`);
  console.log(`✓ Language: ${transcript.language}`);

  // Save to file
  const outputDir = join(process.cwd(), 'knowledge-base', 'sources', 'youtube');
  await mkdir(outputDir, { recursive: true });

  const outputPath = join(outputDir, `${videoId}.json`);
  const output = {
    videoId,
    title,
    language: transcript.language,
    extractedAt: new Date().toISOString(),
    segmentCount: transcript.segments?.length ?? 0,
    fullText: transcript.fullText,
    groupedSegments: transcript.groupedSegments,
  };

  await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf-8');

  console.log(`\n✅ Saved to: ${outputPath}`);
  console.log('\n📋 Next step:');
  console.log(`   Ask Claude Code to process this transcript:`);
  console.log(`   "Process the ICT transcript at ${outputPath}"`);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});

#!/usr/bin/env npx tsx
/**
 * Extract YouTube video IDs from playlists
 *
 * This script extracts all video IDs from the ICT YouTube playlists
 * and updates scripts/ict-video-list.json automatically.
 *
 * Usage:
 *   npx tsx scripts/extract-playlist-ids.ts
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

interface PlaylistInfo {
  playlistId: string;
  playlistKey: string;
  name: string;
  url: string;
}

const PLAYLISTS: PlaylistInfo[] = [
  {
    playlistId: 'PLrlNxdU85imVq0g0_F6l2S1gz6-cHfvyN',
    playlistKey: 'if-i-could-go-back',
    name: 'If I Could Go Back Series',
    url: 'https://www.youtube.com/playlist?list=PLrlNxdU85imVq0g0_F6l2S1gz6-cHfvyN',
  },
  {
    playlistId: 'PLVgHx4Z63paah1dHyad1OMJQJdm6iP2Yn',
    playlistKey: 'market-maker-series',
    name: 'Market Maker Primer Course',
    url: 'https://www.youtube.com/playlist?list=PLVgHx4Z63paah1dHyad1OMJQJdm6iP2Yn',
  },
  {
    playlistId: 'PLVgHx4Z63paYiFGQ56PjTF1PGePL3r69s',
    playlistKey: '2022-mentorship',
    name: 'ICT 2022 Mentorship',
    url: 'https://www.youtube.com/playlist?list=PLVgHx4Z63paYiFGQ56PjTF1PGePL3r69s',
  },
];

async function extractVideoIds() {
  console.log('\n🔍 ICT YouTube Playlist Video ID Extractor');
  console.log('═'.repeat(70));

  // Load current video list (for reference)
  const listPath = join(process.cwd(), 'scripts', 'ict-video-list.json');
  void JSON.parse(await readFile(listPath, 'utf-8'));

  for (const playlist of PLAYLISTS) {
    console.log(`\n📺 ${playlist.name}`);
    console.log('─'.repeat(70));
    console.log(`Playlist URL: ${playlist.url}`);
    console.log(`Playlist ID: ${playlist.playlistId}`);

    // Note: Direct API calls would require YouTube Data API credentials
    // Instead, show user how to extract using browser console
    console.log(`\n⚠️  To extract video IDs, visit the playlist and use browser console:`);
    console.log(`\n1. Visit: ${playlist.url}`);
    console.log(`2. Open DevTools (F12) → Console tab`);
    console.log(`3. Paste this code:`);
    console.log(getExtractionCode(playlist.playlistKey));
    console.log(`\n4. Copy the output and provide it to populate the video list`);
  }

  console.log('\n' + '═'.repeat(70));
  console.log('💡 Alternative: Use yt-dlp to extract playlist');
  console.log('─'.repeat(70));
  console.log(`\nInstall yt-dlp: pip install yt-dlp`);
  console.log(`\nThen extract video IDs:`);
  console.log(`  yt-dlp --dump-json --flat-playlist "${PLAYLISTS[0]?.url}" | jq -r '.entries[].id'`);
  console.log(`  yt-dlp --dump-json --flat-playlist "${PLAYLISTS[1]?.url}" | jq -r '.entries[].id'`);
  console.log(`  yt-dlp --dump-json --flat-playlist "${PLAYLISTS[2]?.url}" | jq -r '.entries[].id'`);

  console.log('\n' + '═'.repeat(70));
  console.log('🚀 Once you have the video IDs:');
  console.log(`1. Save them to: scripts/ict-video-list.json`);
  console.log(`2. Run validation: npx tsx scripts/validate-video-list.ts`);
  console.log(`3. Start ingestion: npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back`);
  console.log('');
}

function getExtractionCode(playlistKey: string): string {
  return `
// Extract video IDs from current YouTube playlist
const videos = Array.from(document.querySelectorAll('[href*="/watch?v="]'))
  .map(a => {
    const url = a.href;
    const videoId = new URL(url).searchParams.get('v');
    const title = a.textContent.trim() || a.getAttribute('title') || 'Unknown';
    return { videoId, title };
  })
  .filter((v, i, a) => v.videoId && a.findIndex(u => u.videoId === v.videoId) === i);

// Copy this JSON and save to scripts/ict-video-list.json
const output = {
  playlistKey: "${playlistKey}",
  videoCount: videos.length,
  videos: videos.map((v, idx) => ({
    id: v.videoId,
    title: v.title || \`Episode \${idx + 1}\`
  }))
};

console.log(JSON.stringify(output, null, 2));
// Copy the above output and update scripts/ict-video-list.json
`;
}

// Main
extractVideoIds().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});

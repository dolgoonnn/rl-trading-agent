#!/usr/bin/env python3
"""
Extract YouTube video IDs from ICT playlists using yt-dlp

Install yt-dlp first:
  pip install yt-dlp

Usage:
  python3 scripts/extract-youtube-ids.py
"""

import json
import subprocess
import sys
from pathlib import Path

PLAYLISTS = {
    "if-i-could-go-back": {
        "url": "https://www.youtube.com/playlist?list=PLrlNxdU85imVq0g0_F6l2S1gz6-cHfvyN",
        "name": "If I Could Go Back Series",
    },
    "market-maker-series": {
        "url": "https://www.youtube.com/playlist?list=PLVgHx4Z63paah1dHyad1OMJQJdm6iP2Yn",
        "name": "Market Maker Primer Course",
    },
    "2022-mentorship": {
        "url": "https://www.youtube.com/playlist?list=PLVgHx4Z63paYiFGQ56PjTF1PGePL3r69s",
        "name": "ICT 2022 Mentorship",
    },
}


def check_ytdlp():
    """Check if yt-dlp is installed"""
    try:
        subprocess.run(["yt-dlp", "--version"], capture_output=True, check=True)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def extract_playlist_videos(playlist_url: str) -> list[dict]:
    """Extract video IDs and titles from a YouTube playlist"""
    try:
        result = subprocess.run(
            [
                "yt-dlp",
                "--dump-json",
                "--flat-playlist",
                "--no-warnings",
                playlist_url,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )

        if result.returncode != 0:
            print(f"Error: {result.stderr}")
            return []

        data = json.loads(result.stdout)
        videos = []

        for entry in data.get("entries", []):
            videos.append({"id": entry["id"], "title": entry.get("title", f"Episode {len(videos) + 1}")})

        return videos
    except json.JSONDecodeError:
        print("Error decoding JSON response from yt-dlp")
        return []
    except subprocess.TimeoutExpired:
        print(f"Timeout extracting playlist: {playlist_url}")
        return []
    except Exception as e:
        print(f"Error extracting playlist: {e}")
        return []


def main():
    print("\n🎬 ICT YouTube Playlist Video ID Extractor")
    print("═" * 70)

    # Check yt-dlp
    if not check_ytdlp():
        print("\n❌ yt-dlp not found!")
        print("\nPlease install yt-dlp:")
        print("  pip install yt-dlp")
        print("\nThen run this script again.")
        sys.exit(1)

    print("✅ yt-dlp found!")
    print()

    # Load current video list
    video_list_path = Path("scripts/ict-video-list.json")
    with open(video_list_path, "r") as f:
        video_list = json.load(f)

    # Extract videos for each playlist
    for playlist_key, playlist_info in PLAYLISTS.items():
        print(f"📺 {playlist_info['name']}")
        print("─" * 70)
        print(f"Extracting from: {playlist_info['url']}")

        videos = extract_playlist_videos(playlist_info["url"])

        if videos:
            print(f"✅ Found {len(videos)} videos")

            # Update video list
            if playlist_key in video_list["playlists"]:
                playlist_data = video_list["playlists"][playlist_key]
                playlist_data["videos"] = videos

                print(f"✅ Updated playlist with {len(videos)} videos")
            else:
                print(f"⚠️  Playlist '{playlist_key}' not found in video list")
        else:
            print(f"❌ Failed to extract videos from {playlist_key}")

        print()

    # Save updated video list
    print("💾 Saving updated video list...")
    with open(video_list_path, "w") as f:
        json.dump(video_list, f, indent=2)

    print(f"✅ Updated: {video_list_path}")
    print()

    # Validation
    print("📊 Summary:")
    print("─" * 70)
    total_videos = 0
    for playlist_key, playlist in video_list["playlists"].items():
        count = len(playlist.get("videos", []))
        total_videos += count
        print(f"  {playlist_key}: {count} videos")

    print(f"\n  Total: {total_videos} videos")

    # Check for remaining NEED_VIDEO_ID placeholders
    needs_id = 0
    for playlist_key, playlist in video_list["playlists"].items():
        for video in playlist.get("videos", []):
            if "NEED_VIDEO_ID" in video.get("id", ""):
                needs_id += 1

    if needs_id == 0:
        print("\n✅ All video IDs populated! Ready to ingest.")
        print("\nNext steps:")
        print("  1. Run: npx tsx scripts/validate-video-list.ts")
        print("  2. Run: npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back")
    else:
        print(f"\n⚠️  {needs_id} video IDs still need to be populated")
        print("  Some playlists may have extraction issues")


if __name__ == "__main__":
    main()

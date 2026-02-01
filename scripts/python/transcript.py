#!/usr/bin/env python3
"""
YouTube transcript extraction for ICT Knowledge Base.
Uses youtube-transcript-api to fetch transcripts with timestamps.

Usage:
    python transcript.py <video_id_or_url>
    python transcript.py --playlist <playlist_id>

Output: JSON to stdout
"""

import sys
import json
import re
from typing import Optional


def extract_video_id(url_or_id: str) -> str:
    """Extract video ID from YouTube URL or return as-is if already an ID."""
    # Already a video ID (11 characters, alphanumeric + _ -)
    if re.match(r'^[a-zA-Z0-9_-]{11}$', url_or_id):
        return url_or_id

    # YouTube URL patterns
    patterns = [
        r'(?:v=|/v/|youtu\.be/)([a-zA-Z0-9_-]{11})',
        r'(?:embed/)([a-zA-Z0-9_-]{11})',
        r'(?:shorts/)([a-zA-Z0-9_-]{11})',
    ]

    for pattern in patterns:
        match = re.search(pattern, url_or_id)
        if match:
            return match.group(1)

    raise ValueError(f"Could not extract video ID from: {url_or_id}")


def get_transcript(video_id: str, languages: list[str] = ['en'], use_cookies: bool = True) -> dict:
    """
    Fetch transcript for a YouTube video.

    Returns:
        {
            "video_id": str,
            "segments": [
                {"text": str, "start": float, "duration": float}
            ],
            "full_text": str,
            "language": str
        }
    """
    from youtube_transcript_api import YouTubeTranscriptApi
    import os

    try:
        # Try with cookies first to avoid IP bans
        cookies_path = os.path.expanduser("~/.youtube_cookies.txt")

        if use_cookies and os.path.exists(cookies_path):
            # Use cookies file if available
            api = YouTubeTranscriptApi(cookies=cookies_path)
        else:
            # Try without cookies - use browser cookies directly
            try:
                # Try Chrome cookies (most common browser)
                api = YouTubeTranscriptApi(cookie_path="chrome")
            except Exception:
                # Fall back to no cookies
                api = YouTubeTranscriptApi()

        segments = api.fetch(video_id)

        # Build full text
        full_text = " ".join([seg.text for seg in segments])

        return {
            "videoId": video_id,
            "language": "en",
            "segments": [
                {
                    "text": seg.text,
                    "start": seg.start,
                    "duration": seg.duration
                }
                for seg in segments
            ],
            "fullText": full_text
        }

    except Exception as e:
        return {
            "videoId": video_id,
            "error": str(e)
        }


def format_timestamp(seconds: float) -> str:
    """Convert seconds to HH:MM:SS or MM:SS format."""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)

    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def group_by_pauses(segments: list[dict], pause_threshold: float = 2.0) -> list[dict]:
    """
    Group transcript segments by natural pauses.
    Useful for identifying topic shifts.
    """
    if not segments:
        return []

    groups = []
    current_group = {
        "start": segments[0]["start"],
        "texts": [segments[0]["text"]]
    }

    for i in range(1, len(segments)):
        prev = segments[i - 1]
        curr = segments[i]

        # Check for pause
        prev_end = prev["start"] + prev["duration"]
        gap = curr["start"] - prev_end

        if gap >= pause_threshold:
            # End current group
            current_group["text"] = " ".join(current_group["texts"])
            current_group["timestamp"] = format_timestamp(current_group["start"])
            del current_group["texts"]
            groups.append(current_group)

            # Start new group
            current_group = {
                "start": curr["start"],
                "texts": [curr["text"]]
            }
        else:
            current_group["texts"].append(curr["text"])

    # Add final group
    current_group["text"] = " ".join(current_group["texts"])
    current_group["timestamp"] = format_timestamp(current_group["start"])
    del current_group["texts"]
    groups.append(current_group)

    return groups


def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "Usage: python transcript.py <video_id_or_url> [--grouped]"
        }))
        sys.exit(1)

    video_input = sys.argv[1]
    grouped = "--grouped" in sys.argv

    try:
        video_id = extract_video_id(video_input)
        result = get_transcript(video_id)

        if "error" not in result and grouped:
            result["grouped_segments"] = group_by_pauses(result["segments"])

        print(json.dumps(result, indent=2))

    except ValueError as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": f"Unexpected error: {str(e)}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
YouTube transcript extraction via Tor proxy.
Bypasses IP-based rate limiting by routing through Tor network.

Usage:
    python transcript_tor.py <video_id>

Requires: Tor running on localhost:9050 (brew services start tor)
"""

import sys
import json
import time
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api.proxies import GenericProxyConfig

# Tor SOCKS5 proxy (default port)
TOR_PROXY = "socks5://127.0.0.1:9050"

def get_new_tor_identity():
    """Request a new Tor circuit (new IP)"""
    try:
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.connect(("127.0.0.1", 9051))
            s.send(b'AUTHENTICATE ""\r\n')
            s.send(b'SIGNAL NEWNYM\r\n')
            s.send(b'QUIT\r\n')
        time.sleep(5)  # Wait for new circuit
        return True
    except:
        return False

def fetch_transcript_via_tor(video_id: str, max_retries: int = 3) -> dict:
    """Fetch transcript using Tor proxy with retry logic"""

    for attempt in range(max_retries):
        try:
            # Configure proxy
            proxy_config = GenericProxyConfig(
                http_url=TOR_PROXY,
                https_url=TOR_PROXY
            )

            api = YouTubeTranscriptApi(proxy_config=proxy_config)
            segments = api.fetch(video_id)

            # Build full text
            full_text = " ".join([seg.text for seg in segments])

            # Group segments by pauses for better chunking
            grouped = group_by_pauses([
                {"text": seg.text, "start": seg.start, "duration": seg.duration}
                for seg in segments
            ])

            return {
                "videoId": video_id,
                "language": "en",
                "segments": [
                    {"text": seg.text, "start": seg.start, "duration": seg.duration}
                    for seg in segments
                ],
                "groupedSegments": grouped,
                "fullText": full_text
            }

        except Exception as e:
            error_msg = str(e)
            if "429" in error_msg or "blocked" in error_msg.lower() or "could not retrieve" in error_msg.lower():
                # Rate limited, get new Tor identity and retry
                if attempt < max_retries - 1:
                    print(f"Rate limited, requesting new Tor identity (attempt {attempt + 2}/{max_retries})...", file=sys.stderr)
                    get_new_tor_identity()
                    time.sleep(2)
                    continue

            return {"videoId": video_id, "error": error_msg}

    return {"videoId": video_id, "error": "All retries failed"}

def format_timestamp(seconds: float) -> str:
    """Convert seconds to MM:SS or HH:MM:SS format"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)

    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"

def group_by_pauses(segments: list, pause_threshold: float = 2.0) -> list:
    """Group transcript segments by natural pauses"""
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

        prev_end = prev["start"] + prev["duration"]
        gap = curr["start"] - prev_end

        if gap >= pause_threshold:
            current_group["text"] = " ".join(current_group["texts"])
            current_group["timestamp"] = format_timestamp(current_group["start"])
            del current_group["texts"]
            groups.append(current_group)

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
        print(json.dumps({"error": "Usage: python transcript_tor.py <video_id>"}))
        sys.exit(1)

    video_id = sys.argv[1]
    result = fetch_transcript_via_tor(video_id)
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()

/**
 * YouTube transcript extraction wrapper.
 * Calls Python script for youtube-transcript-api functionality.
 */

import { spawn } from 'child_process';
import { join } from 'path';

export interface TranscriptSegment {
  text: string;
  start: number;
  duration: number;
}

export interface GroupedSegment {
  text: string;
  start: number;
  timestamp: string;
}

export interface TranscriptResult {
  videoId: string;
  language?: string;
  segments?: TranscriptSegment[];
  groupedSegments?: GroupedSegment[];
  fullText?: string;
  error?: string;
}

/**
 * Extract video ID from YouTube URL or return as-is if already an ID.
 */
export function extractVideoId(urlOrId: string): string {
  // Already a video ID (11 characters)
  if (/^[a-zA-Z0-9_-]{11}$/.test(urlOrId)) {
    return urlOrId;
  }

  // YouTube URL patterns
  const patterns = [
    /(?:v=|\/v\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:shorts\/)([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = urlOrId.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  throw new Error(`Could not extract video ID from: ${urlOrId}`);
}

/**
 * Get the path to the Python transcript script.
 * @param useTor - Use Tor proxy for bypassing rate limits
 */
function getPythonScriptPath(useTor: boolean = false): string {
  const scriptName = useTor ? 'transcript_tor.py' : 'transcript.py';
  return join(process.cwd(), 'scripts', 'python', scriptName);
}

/**
 * Get the path to Python in the virtual environment.
 */
function getPythonPath(): string {
  return join(process.cwd(), 'scripts', 'python', 'venv', 'bin', 'python3');
}

/**
 * Fetch transcript for a YouTube video.
 *
 * @param videoIdOrUrl - YouTube video ID or URL
 * @param options.grouped - Group segments by natural pauses
 * @param options.useTor - Use Tor proxy to bypass rate limits
 */
export async function getTranscript(
  videoIdOrUrl: string,
  options: { grouped?: boolean; useTor?: boolean } = {}
): Promise<TranscriptResult> {
  const videoId = extractVideoId(videoIdOrUrl);
  const scriptPath = getPythonScriptPath(options.useTor ?? false);

  const args = [scriptPath, videoId];
  if (options.grouped && !options.useTor) {
    // Tor script already includes grouping
    args.push('--grouped');
  }

  return new Promise((resolve, reject) => {
    const python = spawn(getPythonPath(), args);

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    python.on('close', (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error(`Python script failed: ${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(stdout) as TranscriptResult;
        resolve(result);
      } catch {
        reject(new Error(`Failed to parse transcript result: ${stdout}`));
      }
    });

    python.on('error', (err) => {
      reject(new Error(`Failed to spawn Python: ${err.message}`));
    });
  });
}

/**
 * Format seconds to timestamp string (MM:SS or HH:MM:SS).
 */
export function formatTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/**
 * Generate YouTube URL with timestamp.
 */
export function getTimestampUrl(videoId: string, seconds: number): string {
  return `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(seconds)}s`;
}

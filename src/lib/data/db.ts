import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import path from 'path';

// Database path - stored in project data folder
const DB_PATH = path.join(process.cwd(), 'data', 'ict-trading.db');

// Create database connection
const sqlite = new Database(DB_PATH);

// Enable WAL mode for better concurrent access
sqlite.pragma('journal_mode = WAL');
// Wait (up to 5s) for a write lock instead of failing immediately with
// SQLITE_BUSY — needed so the crypto forward bot + gold bot can safely share
// this single DB file (WAL gives concurrent readers + one writer; busy_timeout
// makes the second concurrent writer briefly wait rather than crash).
sqlite.pragma('busy_timeout = 5000');

// Create drizzle instance
export const db = drizzle(sqlite, { schema });

// Export schema for migrations
export { schema };

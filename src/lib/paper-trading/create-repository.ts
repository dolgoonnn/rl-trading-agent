/**
 * Repository Factory
 *
 * Selects SQLite or PostgreSQL based on DATABASE_URL.
 * Uses dynamic imports to avoid loading the wrong native driver.
 */

import type { PaperTradingRepository } from './repository';

export async function createRepository(): Promise<PaperTradingRepository> {
  const dbUrl = process.env.DATABASE_URL;

  if (dbUrl && (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://'))) {
    const { PgRepository } = await import('./repository-pg');
    const repo = new PgRepository(dbUrl);
    await repo.ensureTables();
    console.log('[DB] Connected to PostgreSQL');
    return repo;
  }

  const { SqliteRepository } = await import('./repository-sqlite');
  console.log('[DB] Using local SQLite');
  return new SqliteRepository();
}

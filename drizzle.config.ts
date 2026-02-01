import type { Config } from 'drizzle-kit';

export default {
  schema: './src/lib/data/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: './data/ict-trading.db',
  },
} satisfies Config;

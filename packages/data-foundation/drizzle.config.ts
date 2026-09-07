import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/postgres/schema.ts',
  out: './drizzle',
  // Only used by `drizzle-kit generate` to introspect connection defaults; no
  // real credential is required for schema-diff generation and none is read
  // from this file at runtime by application code.
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/samvardiq_unused_placeholder',
  },
});

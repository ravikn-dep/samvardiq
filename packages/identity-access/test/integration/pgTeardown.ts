import fs from 'node:fs';

import type EmbeddedPostgres from 'embedded-postgres';

/**
 * embedded-postgres's own Windows `stop()` path kills the process via
 * `taskkill /pid ... /f /t` without awaiting it, then resolves as soon as
 * the ORIGINAL process's `exit` event fires and immediately runs its own
 * `fs.rm(databaseDir, { recursive, force })` with no retry (see
 * node_modules/embedded-postgres/dist/index.js). Windows can report a
 * forcibly-killed process as exited before the OS releases all its file
 * handles, so that immediate `fs.rm` intermittently throws EBUSY/EPERM —
 * an upstream library race, not anything in this repository's own test
 * code. By the time it throws, the postgres process is already confirmed
 * dead (the kill step's own promise already resolved) — only the
 * disposable temp directory's removal raced — so retry that removal
 * ourselves with backoff rather than letting a teardown-only race fail
 * the test. Shared here (rather than duplicated per call site) because
 * this package's harness.ts and migration.test.ts each start/stop
 * multiple independent embedded clusters.
 */
export async function stopEmbeddedPostgres(pg: EmbeddedPostgres, dataDir: string): Promise<void> {
  try {
    await pg.stop();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw err;
    await fs.promises.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

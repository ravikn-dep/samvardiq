import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import '@testing-library/jest-dom/vitest';

// With vitest's `globals: false` (this project's convention — see
// vite.config.ts), Testing Library's own auto-cleanup-after-each does not
// self-register (it only does so when it detects Vitest's *global*
// afterEach). Without this, DOM from one test leaks into the next,
// producing "multiple elements found" failures — reproduced during this
// session's own test development.
afterEach(() => {
  cleanup();
});

#!/usr/bin/env node
// Provider-neutral build of apps/api for this multi-package (non-workspace, ADR-HTTP-001) layout.
//
//   node scripts/api-runtime.mjs install   # npm ci --include=dev from each lockfile, in every project apps/api needs
//   node scripts/api-runtime.mjs build     # builds the sibling packages, then apps/api (npm run build)
//   node scripts/api-runtime.mjs prune     # drop devDependencies everywhere -> production runtime tree
//
// `prune` is destructive to a development checkout (removes tsc/eslint/tsx/test tooling); run it only
// on a deployment build, then start with `node dist/index.js` from apps/api. Needs Node + npm only.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Order is not significant: file: links only need their target to exist at build time, not at install time.
const projects = [
  'packages/marketing-intelligence',
  'packages/approval-governance',
  'packages/identity-access',
  'packages/data-foundation',
  'packages/clinic-cms-connector',
  'packages/application-services',
  'packages/communication-orchestration',
  'apps/api',
];

function npm(args, dir) {
  console.log(`\n> [${dir}] npm ${args.join(' ')}`);
  // shell:true on Windows only, where npm is npm.cmd.
  const r = spawnSync('npm', args, { cwd: join(root, dir), stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`FAILED: npm ${args.join(' ')} in ${dir} (exit ${r.status ?? r.signal})`);
    process.exit(r.status || 1);
  }
}

const commands = {
  // --include=dev: the build needs tsc etc. even if the host sets NODE_ENV=production (npm would then omit devDependencies
  // and exit 0, and the build fails later). Production-only trees come from `prune`, never from the install.
  install: () => projects.forEach((d) => npm(['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], d)),
  build: () => npm(['run', 'build'], 'apps/api'),
  prune: () => projects.forEach((d) => npm(['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], d)),
};

const command = commands[process.argv[2]];
if (!command) {
  console.error('usage: node scripts/api-runtime.mjs <install|build|prune>');
  process.exit(2);
}
command();

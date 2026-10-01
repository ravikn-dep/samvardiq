import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * INFRA-W1D-PKG: the deployable runtime is `npm prune --omit=dev` of apps/api and every sibling package
 * (scripts/api-runtime.mjs). That only works if each project *declares* its own runtime imports as
 * `dependencies`, and keeps test/build/migration tooling out of them. Every project is its own npm project
 * (ADR-HTTP-001), so nothing may be satisfied by a sibling's node_modules.
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
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
const nonRuntime = ['embedded-postgres', 'drizzle-kit', 'tsx', 'eslint', 'typescript', 'typescript-eslint'];

const builtins = new Set(builtinModules);
const staticImport = /^\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;
const dynamicImport = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function packageName(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('node:')) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  return builtins.has(name) ? null : name;
}

function runtimeImports(project: string): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles(join(repoRoot, project, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const re of [staticImport, dynamicImport]) {
      for (const match of text.matchAll(re)) {
        const name = packageName(match[1] ?? match[2] ?? '');
        if (name) names.add(name);
      }
    }
  }
  return names;
}

for (const project of projects) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, project, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  const declared = Object.keys(manifest.dependencies ?? {});

  test(`${project}: every runtime import in src/ is a declared production dependency`, () => {
    const missing = [...runtimeImports(project)].filter((name) => !declared.includes(name));
    assert.deepEqual(missing, [], `${project} imports these from src/ but does not list them under "dependencies"`);
  });

  test(`${project}: test/build/migration tooling is not a production dependency`, () => {
    const leaked = declared.filter((name) => nonRuntime.includes(name) || name.startsWith('@types/'));
    assert.deepEqual(leaked, []);
  });
}

/**
 * INFRA-W1D-PKG-F1: hosts may set NODE_ENV=production during the build, and `npm ci` then silently omits
 * devDependencies (exit 0), so the later build fails for want of tsc. Run the real script with a stub `npm`
 * first on PATH that records each call, and check the contract: install always requests devDependencies, and
 * the production-only tree comes solely from `prune`.
 */
function recordNpmCalls(command: string, nodeEnv: string | undefined): { cwd: string; args: string }[] {
  const dir = mkdtempSync(join(tmpdir(), 'api-runtime-stub-'));
  const log = join(dir, 'calls.log');
  writeFileSync(join(dir, 'npm.cmd'), `@echo %CD% :: %* >> "${log}"\r\n`);
  writeFileSync(join(dir, 'npm'), `#!/bin/sh\necho "$PWD :: $*" >> "${log}"\n`);
  chmodSync(join(dir, 'npm'), 0o755);
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const env: NodeJS.ProcessEnv = { ...process.env, [pathKey]: `${dir}${delimiter}${process.env[pathKey] ?? ''}` };
  if (nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = nodeEnv;
  try {
    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'api-runtime.mjs'), command], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command} exited ${result.status}: ${result.stderr}`);
    return readFileSync(log, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [cwd = '', args = ''] = line.split(' :: ');
        return { cwd: cwd.trim().replace(/\\/g, '/'), args: args.trim() };
      });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const nodeEnv of ['production', 'development', undefined]) {
  test(`api-runtime install requests devDependencies in every project (NODE_ENV=${nodeEnv})`, () => {
    const calls = recordNpmCalls('install', nodeEnv);
    assert.equal(calls.length, projects.length);
    for (const project of projects) {
      const call = calls.find((c) => c.cwd.endsWith(`/${project}`));
      assert.ok(call, `no npm call for ${project}`);
      assert.match(call.args, /^ci\b/);
      assert.match(call.args, /--include=dev\b/, `${project}: install must not depend on ambient NODE_ENV`);
    }
  });
}

/**
 * INFRA-W1D-RAILWAY-G1: the root Dockerfile is the canonical container. It must build via api-runtime.mjs (not its own
 * install logic), run one pinned Node in both stages, start non-root and in exec form, and carry no credentials. The
 * .dockerignore is an allowlist, so .env files, tests and migrations can only enter the image by an explicit edit here.
 */
test('Dockerfile builds with the canonical lifecycle on one pinned Node and starts non-root', () => {
  const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
  assert.equal(froms.length, 2);
  assert.equal(froms[0], froms[1], 'build and runtime stages must use the same Node image');
  assert.match(froms[0]!, /^node:24\.15\.0-bookworm-slim@sha256:[0-9a-f]{64}$/);
  const steps = [...dockerfile.matchAll(/node scripts\/api-runtime\.mjs (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(steps, ['install', 'build', 'prune']);
  assert.doesNotMatch(dockerfile, /npm (ci|install)\b/, 'install logic belongs to api-runtime.mjs only');
  const runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM'));
  assert.match(runtime, /^USER node$/m);
  assert.match(runtime, /^CMD \["node", "apps\/api\/dist\/index\.js"\]$/m);
  assert.doesNotMatch(dockerfile, /DATABASE_URL|PASSWORD|SECRET|TOKEN|migrat/i);
});

test('.dockerignore denies everything except the sources api-runtime.mjs builds', () => {
  const lines = readFileSync(join(repoRoot, '.dockerignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert.equal(lines[0], '*');
  const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'src'];
  const expected = ['!scripts/api-runtime.mjs', ...['apps/api', 'packages/*'].flatMap((dir) => files.map((f) => `!${dir}/${f}`))];
  assert.deepEqual(lines.slice(1).sort(), expected.sort());
});

test('api-runtime prune still produces the production-only tree (--omit=dev) in every project', () => {
  const calls = recordNpmCalls('prune', 'production');
  assert.equal(calls.length, projects.length);
  for (const call of calls) {
    assert.match(call.args, /^prune\b/);
    assert.match(call.args, /--omit=dev\b/);
    assert.doesNotMatch(call.args, /--include=dev/);
  }
});

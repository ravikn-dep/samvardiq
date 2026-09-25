import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
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

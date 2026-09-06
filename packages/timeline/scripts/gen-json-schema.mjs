#!/usr/bin/env node
// Regenerates schema/project.schema.json from the zod ProjectSchema (the
// source of truth in src/index.ts). Run automatically as part of `build`;
// run with --check in CI/verify to fail loudly if the checked-in file is stale.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectJsonSchema } from '../dist/json-schema.js';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outPath = join(pkgRoot, 'schema', 'project.schema.json');
const content = JSON.stringify(projectJsonSchema, null, 2) + '\n';

const check = process.argv.includes('--check');

if (check) {
  const existing = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null;
  if (existing !== content) {
    console.error(
      `[gen-json-schema] ${outPath} is stale — run \`pnpm --filter @memeit/timeline gen:schema\` and commit the result.`
    );
    process.exit(1);
  }
  console.log('[gen-json-schema] schema/project.schema.json is up to date.');
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content);
  console.log(`[gen-json-schema] wrote ${outPath}`);
}

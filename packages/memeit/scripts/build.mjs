// Full build: web UI -> public/, then tsup bundle -> dist/cli.js
import { execSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const skipUi = process.argv.includes('--no-ui');

if (!skipUi) {
  execSync('node scripts/build-ui.mjs', { cwd: pkgDir, stdio: 'inherit' });
} else {
  console.log('[memeit] skipping UI build (--no-ui)');
}

console.log('[memeit] bundling server with tsup…');
execSync('pnpm exec tsup', { cwd: pkgDir, stdio: 'inherit' });

const cli = join(pkgDir, 'dist/cli.js');
if (!existsSync(cli)) {
  console.error('[memeit] build failed: dist/cli.js missing');
  process.exit(1);
}
chmodSync(cli, 0o755);
console.log('[memeit] build ok: dist/cli.js (+ public/ for the UI)');

// Builds @memeit/web and copies its dist into packages/memeit/public/
// so the published npm tarball serves the UI with zero extra downloads.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const root = resolve(pkgDir, '../..');
const webDist = join(root, 'apps/web/dist');
const publicDir = join(pkgDir, 'public');

const skipBuild = process.argv.includes('--no-build') || process.env.MEMEIT_SKIP_UI_BUILD === '1';

if (!skipBuild) {
  console.log('[memeit] building @memeit/web…');
  execSync('pnpm --filter @memeit/web build', { cwd: root, stdio: 'inherit' });
}

if (!existsSync(join(webDist, 'index.html'))) {
  console.error(`[memeit] web build missing: ${webDist} (run pnpm --filter @memeit/web build first)`);
  process.exit(1);
}

rmSync(publicDir, { recursive: true, force: true });
cpSync(webDist, publicDir, { recursive: true });
console.log(`[memeit] ui copied: ${webDist} -> ${publicDir}`);

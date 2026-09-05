import { join, resolve } from 'node:path';

/** Absolute directory for job data, caches, downloads. Defaults to ./data under cwd. */
export function resolveDataDir(explicit?: string): string {
  return resolve(explicit ?? process.env.MEMEIT_DATA_DIR ?? join(process.cwd(), 'data'));
}

/** Absolute directory for the built web UI (vite dist). Null = API-only mode. */
export function resolvePublicDir(explicit?: string): string | null {
  const raw = explicit ?? process.env.MEMEIT_PUBLIC_DIR;
  if (!raw) return null;
  return resolve(raw);
}

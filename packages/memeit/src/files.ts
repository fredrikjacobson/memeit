import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type SrcResolution = { path: string } | { reason: string };

/**
 * Resolve a media clip `src` to a local file path.
 *
 * Accepted forms:
 * - plain path: tried as-is, then relative to `projectDir`, then `assetsDir`
 * - `asset:<id>`: exact `<dir>/<id>` match, else first `<dir>/<id>.*` match
 *   in `assetsDir`, then `projectDir`
 *
 * Browser-only (`blob:`, `missing:`) and remote (`http(s):`) refs never
 * resolve — callers warn and skip them.
 */
export function resolveMediaSrc(
  src: string,
  projectDir: string,
  assetsDir: string
): SrcResolution {
  if (!src.trim()) return { reason: 'empty src' };
  if (src.startsWith('blob:') || src.startsWith('missing:')) {
    return { reason: `browser-only reference "${src}" — re-attach the file` };
  }
  if (/^https?:\/\//i.test(src)) {
    return { reason: `remote URL "${src}" — download it to a local file first` };
  }
  if (src.startsWith('asset:')) {
    const id = src.slice('asset:'.length);
    const tried: string[] = [];
    for (const dir of [assetsDir, projectDir]) {
      const exact = join(dir, id);
      tried.push(exact);
      if (existsSync(exact)) return { path: exact };
      try {
        for (const entry of readdirSync(dir)) {
          if (entry === id || entry.startsWith(`${id}.`)) {
            return { path: join(dir, entry) };
          }
        }
      } catch {
        // dir unreadable/missing — keep looking
      }
    }
    return { reason: `asset:${id} not found (tried ${tried.join(', ')})` };
  }

  const candidates = [src, join(projectDir, src), join(assetsDir, src)].filter(
    (c, i, arr) => arr.indexOf(c) === i
  );
  for (const c of candidates) {
    try {
      if (existsSync(c)) return { path: c };
    } catch {
      // ignore
    }
  }
  return { reason: `file not found (tried ${candidates.join(', ')})` };
}

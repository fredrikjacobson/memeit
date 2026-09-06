// Filename-safe slug for export downloads, derived from the project name.
// Falls back when the name is empty/whitespace or sluggifies to nothing.

export function slugify(name: string | undefined, fallback: string): string {
  const s = (name ?? '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 80);
  return s || fallback;
}

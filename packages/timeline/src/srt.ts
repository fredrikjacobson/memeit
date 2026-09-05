// Minimal SRT support — standard `HH:MM:SS,mmm --> HH:MM:SS,mmm` cues.
// Text may contain `\n` line breaks; we keep them (rendered as-is, exported as-is).

export type SrtCue = { startMs: number; endMs: number; text: string };

const TS_RE = /(\d+):(\d+):(\d+)[,.](\d+)/;

export function parseSrtTime(s: string): number | null {
  const m = s.trim().match(TS_RE);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const ms = Number(String(m[4]).padEnd(3, '0').slice(0, 3));
  if ([h, min, sec, ms].some((n) => !Number.isFinite(n))) return null;
  return h * 3600_000 + min * 60_000 + sec * 1000 + ms;
}

export function formatSrtTime(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  const h = Math.floor(v / 3600_000);
  const min = Math.floor((v % 3600_000) / 60_000);
  const sec = Math.floor((v % 60_000) / 1000);
  const mmm = v % 1000;
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(min)}:${p(sec)},${String(mmm).padStart(3, '0')}`;
}

export function parseSrt(input: string): SrtCue[] {
  const norm = input.replace(/\r\n?/g, '\n').trim();
  if (!norm) return [];
  const blocks = norm.split(/\n\s*\n/);
  const cues: SrtCue[] = [];
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;
    // first line may be numeric index — skip it
    let i = 0;
    if (/^\d+$/.test(lines[0]!.trim())) i = 1;
    if (i >= lines.length) continue;
    const arrow = lines[i++]!.split('-->');
    if (arrow.length !== 2) continue;
    const startMs = parseSrtTime(arrow[0]!);
    const endMs = parseSrtTime(arrow[1]!);
    if (startMs == null || endMs == null || endMs <= startMs) continue;
    const text = lines.slice(i).join('\n').slice(0, 500);
    if (!text.trim()) continue;
    cues.push({ startMs, endMs, text });
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

export function formatSrt(cues: SrtCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${formatSrtTime(c.startMs)} --> ${formatSrtTime(c.endMs)}\n${c.text.trim()}\n`)
    .join('\n');
}

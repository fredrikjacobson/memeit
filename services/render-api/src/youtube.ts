import express, { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// yt-dlp binary resolution.
//
// Spec: the binary lives at ./bin/yt-dlp (repo root). The API runs from
// services/render-api, so `./bin/yt-dlp` relative to cwd is wrong — search a
// few likely locations, overridable via YTDLP_PATH.
// ---------------------------------------------------------------------------
function resolveYtDlp(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.YTDLP_PATH,
    // repo-root relative to cwd (when launched from repo root)
    resolve(process.cwd(), 'bin/yt-dlp'),
    // repo-root relative to cwd (when launched from services/render-api)
    resolve(process.cwd(), '../../bin/yt-dlp'),
    // repo-root relative to this file (src/ or dist/)
    resolve(here, '../../../bin/yt-dlp'),
    resolve(here, '../../../../bin/yt-dlp'),
    // last resort: rely on PATH
    'yt-dlp',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (c === 'yt-dlp') return c;
    try {
      if (existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return candidates[0] ?? null;
}

let cachedBin: string | null | undefined;
export function ytDlpBin(): string | null {
  if (cachedBin === undefined) cachedBin = resolveYtDlp();
  return cachedBin;
}

// Only these hosts are allowed — never pass arbitrary user input as flags.
const YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

export function isYouTubeUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return YT_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const BodySchema = z.object({
  url: z.string().min(8).max(2048).refine(isYouTubeUrl, 'not a YouTube URL'),
  mode: z.enum(['video', 'audio']).default('video'),
  // seconds into the source video to start at ( Omitting = from the beginning )
  startSec: z.number().min(0).max(5 * 60 * 60).optional(),
  // how many seconds to keep ( Omitting = to the end ). Capped to project max.
  durationSec: z.number().min(1).max(5 * 60).optional(),
});

type YtJob = {
  id: string;
  status: 'queued' | 'downloading' | 'ready' | 'error';
  url: string;
  mode: 'video' | 'audio';
  startSec?: number;
  durationSec?: number;
  title?: string;
  filename?: string;
  size?: number;
  error?: string;
  log: string;
};

const jobs = new Map<string, YtJob>();

function fmtSectionTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(r)}`;
}

// Sanitize a video title into a safe filename stem.
function safeStem(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 60);
  return s || 'youtube';
}

async function fetchTitle(bin: string, url: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(bin, ['--no-playlist', '--skip-download', '--print', '%(title)s', url], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const t = stdout.trim().split('\n').pop()?.trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

async function runDownload(dataDir: string, job: YtJob): Promise<void> {
  const bin = ytDlpBin();
  if (!bin) {
    job.status = 'error';
    job.error = 'yt-dlp binary not found (expected at ./bin/yt-dlp, override with YTDLP_PATH)';
    return;
  }
  // Early, clear error when the file is missing — the bundled binary is a
  // PyInstaller one-dir exe without its _internal/ folder in that case.
  try {
    if (bin !== 'yt-dlp') await access(bin, constants.X_OK);
  } catch {
    job.status = 'error';
    job.error = `yt-dlp binary not executable: ${bin} (re-install with: curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos -o bin/yt-dlp && chmod +x bin/yt-dlp)`;
    return;
  }

  job.status = 'downloading';
  const dir = join(dataDir, 'youtube', job.id);
  mkdirSync(dir, { recursive: true });
  const outTemplate = join(dir, 'source.%(ext)s');

  const args: string[] = ['--no-playlist', '--no-progress'];
  if (job.mode === 'audio') {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    args.push(
      '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
      '--merge-output-format', 'mp4',
      '--remux-video', 'mp4',
    );
  }
  // Trim server-side so the project only ever receives the wanted range.
  if (job.startSec != null || job.durationSec != null) {
    const start = job.startSec ?? 0;
    const end = job.durationSec != null ? start + job.durationSec : undefined;
    args.push(
      '--download-sections', `*${fmtSectionTime(start)}-${end != null ? fmtSectionTime(end) : 'inf'}`,
      '--force-keyframes-at-cuts',
    );
  }
  args.push('-o', outTemplate, job.url);

  job.log = `$ ${bin} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  try {
    await execFileAsync(bin, args, { timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
  } catch (e: unknown) {
    const err = e as { message?: string; stderr?: string; stdout?: string };
    job.status = 'error';
    const tail = String(err.stderr ?? err.stdout ?? '').slice(-2000).trim();
    job.error = `yt-dlp failed: ${err.message ?? e}${tail ? `\n${tail}` : ''}`;
    job.log += `\n${job.error}`;
    return;
  }

  // Find the downloaded media file (largest audio/video file in the job dir).
  const MEDIA_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.mp3', '.m4a', '.opus', '.ogg', '.wav']);
  let best: { path: string; size: number } | null = null;
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let size = 0;
      try {
        size = statSync(p).size;
      } catch {
        continue;
      }
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
      if (!MEDIA_EXT.has(ext) || size === 0) continue;
      if (!best || size > best.size) best = { path: p, size };
    }
  } catch {
    /* ignore */
  }
  if (!best) {
    job.status = 'error';
    job.error = 'yt-dlp finished but produced no media file';
    return;
  }

  const title = (await fetchTitle(bin, job.url)) ?? 'youtube';
  const ext = best.path.slice(best.path.lastIndexOf('.')).toLowerCase() || (job.mode === 'audio' ? '.mp3' : '.mp4');
  job.title = title;
  job.filename = `${safeStem(title)}${ext}`;
  job.size = best.size;
  job.status = 'ready';
  job.log += `\ndone -> ${best.path} (${best.size} bytes)`;
}

function jobFilePath(dataDir: string, job: YtJob): string | null {
  const dir = join(dataDir, 'youtube', job.id);
  if (!existsSync(dir)) return null;
  const MEDIA_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.mp3', '.m4a', '.opus', '.ogg', '.wav']);
  let best: { path: string; size: number } | null = null;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    if (!MEDIA_EXT.has(ext)) continue;
    try {
      const size = statSync(p).size;
      if (size > 0 && (!best || size > best.size)) best = { path: p, size };
    } catch {
      /* ignore */
    }
  }
  return best?.path ?? null;
}

export function createYoutubeRouter(dataDir: string): Router {
const youtubeRouter = Router();
youtubeRouter.use(express.json({ limit: '16kb' }));

youtubeRouter.get('/api/youtube-health', async (_req, res) => {
  const bin = ytDlpBin();
  if (!bin) return res.status(500).json({ ok: false, error: 'yt-dlp binary not found (expected at ./bin/yt-dlp)' });
  try {
    if (bin !== 'yt-dlp') await access(bin, constants.X_OK);
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 15_000 });
    res.json({ ok: true, bin, version: stdout.trim().split('\n')[0] });
  } catch (e) {
    res.status(500).json({ ok: false, bin, error: e instanceof Error ? e.message : String(e) });
  }
});

youtubeRouter.post('/api/youtube', (req, res) => {
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { url, mode, startSec, durationSec } = parsed.data;
  const id = randomUUID().slice(0, 8);
  const job: YtJob = {
    id,
    status: 'queued',
    url: url.trim(),
    mode,
    startSec,
    durationSec,
    log: 'queued',
  };
  jobs.set(id, job);
  // run async — frontend polls
  void runDownload(dataDir, job);
  res.json({ jobId: id, status: job.status });
});

youtubeRouter.get('/api/youtube/:id', (req, res) => {
  const job = jobs.get(req.params.id as string);
  if (!job) return res.status(404).json({ error: 'not found' });
  const { log: _log, ...rest } = job;
  res.json({ ...rest, log: job.status === 'error' ? job.log : undefined });
});

youtubeRouter.get('/api/youtube/:id/file', (req, res) => {
  const job = jobs.get(req.params.id as string);
  if (!job) return res.status(404).json({ error: 'not found' });
  if (job.status !== 'ready') return res.status(409).json({ error: `not ready: ${job.status}`, log: job.log });
  const p = jobFilePath(dataDir, job);
  if (!p || !existsSync(p)) return res.status(404).json({ error: 'file missing' });
  res.download(p, job.filename ?? `youtube-${job.id}`);
});
  return youtubeRouter;
}

// Back-compat for existing dev entry (uses cwd ./data).
export const youtubeRouter = createYoutubeRouter(join(process.cwd(), 'data'));

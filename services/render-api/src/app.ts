import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProjectSchema } from '@memeit/timeline';
import { buildFfmpegArgs, type ResolvedAsset } from '@memeit/renderer';
import { trackGreenScreen, type TrackKeyframe, type TrackStats } from '@memeit/tracker';
import { renderTextPng } from './text.js';
import { createTtsRouter } from './tts.js';
import { createYoutubeRouter } from './youtube.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

export type AppOptions = {
  /** Absolute dir for jobs/cache/downloads. Defaults to MEMEIT_DATA_DIR or ./data under cwd. */
  dataDir?: string;
  /** Absolute dir of built web UI to serve. Null/undefined = API-only. */
  publicDir?: string | null;
};

export function createApp(opts: AppOptions = {}) {
  const dataDir = resolve(opts.dataDir ?? process.env.MEMEIT_DATA_DIR ?? join(process.cwd(), 'data'));
  const publicDir = opts.publicDir ?? process.env.MEMEIT_PUBLIC_DIR ?? null;
  const resolvedPublic = publicDir ? resolve(publicDir) : null;

  const app = express();
  app.use(cors());
  app.use(createTtsRouter(dataDir));
  app.use(createYoutubeRouter(dataDir));

  type Job = { id: string; status: 'queued' | 'rendering' | 'done' | 'error'; log: string; warnings: string[] };
  const jobs = new Map<string, Job>();
  type TrackJob = {
    id: string;
    status: 'queued' | 'tracking' | 'done' | 'error';
    log: string;
    keyframes: TrackKeyframe[] | null;
    stats: TrackStats | null;
  };
  const trackJobs = new Map<string, TrackJob>();

  app.get('/api/health', async (_req, res) => {
    try {
      const { stdout } = await execFileAsync('ffmpeg', ['-version']);
      res.json({ ok: true, ffmpeg: stdout.split('\n')[0] });
    } catch {
      res.status(500).json({ ok: false, error: 'ffmpeg not found on PATH — install ffmpeg (https://ffmpeg.org/download.html) and retry' });
    }
  });

  async function hasAudioStream(path: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', path,
      ]);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  // Multipart: fields `project` (JSON), files keyed by clipId.
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        const id = (req as unknown as { jobId: string }).jobId;
        const dir = join(dataDir, 'jobs', id, 'assets');
        mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const ext = extname(file.originalname) || '';
        cb(null, `${file.fieldname}${ext}`);
      },
    }),
    limits: { fileSize: 500 * 1024 * 1024 },
  });

  app.post('/api/renders', (req, res, next) => {
    const id = randomUUID().slice(0, 8);
    (req as unknown as { jobId: string }).jobId = id;
    mkdirSync(join(dataDir, 'jobs', id, 'assets'), { recursive: true });
    const job: Job = { id, status: 'queued', log: '', warnings: [] };
    jobs.set(id, job);
    next();
  }, upload.any(), async (req, res) => {
    const id = (req as unknown as { jobId: string }).jobId;
    const job = jobs.get(id)!;
    try {
      const raw = (req.body as Record<string, string>).project;
      if (!raw) return res.status(400).json({ error: 'missing project field' });
      const parsed = ProjectSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const project = parsed.data;

      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const assetDir = join(dataDir, 'jobs', id, 'assets');
      // map clipId -> saved file (multer fieldname is clipId)
      const saved = new Map<string, string>();
      for (const f of files) saved.set(f.fieldname, f.path);
      // fallback: match by scanning dir (covers retries)
      if (saved.size === 0 && existsSync(assetDir)) {
        for (const name of readdirSync(assetDir)) {
          const dot = name.lastIndexOf('.');
          saved.set(dot > 0 ? name.slice(0, dot) : name, join(assetDir, name));
        }
      }

      const assets: ResolvedAsset[] = [];
      for (const c of project.clips) {
        if (c.kind === 'video' || c.kind === 'image' || c.kind === 'audio') {
          const p = saved.get(c.id);
          if (p && existsSync(p)) assets.push({ clipId: c.id, kind: c.kind, path: p });
        }
      }

      // pre-render text overlays to full-frame PNGs
      const textPngs: { clipId: string; path: string }[] = [];
      for (const c of project.clips) {
        if (c.kind !== 'text') continue;
        const out = join(assetDir, `text-${c.id}.png`);
        const hasPositionKeyframes = (c.keyframes?.length ?? 0) > 0;
        await renderTextPng(c, project.width, project.height, out, { anchorCenter: hasPositionKeyframes });
        textPngs.push({ clipId: c.id, path: out });
      }

      // probe base video audio
      const videos = project.clips.filter((c) => c.kind === 'video').sort((a, b) => a.startMs - b.startMs);
      let baseHasAudio = false;
      const base = videos[0];
      if (base) {
        const p = saved.get(base.id);
        if (p) baseHasAudio = await hasAudioStream(p);
      }

      const outPath = join(dataDir, 'jobs', id, 'out.mp4');
      const plan = buildFfmpegArgs(project, assets, textPngs, { baseHasAudio }, outPath);
      job.warnings = plan.warnings;
      job.status = 'rendering';
      job.log = plan.description;
      res.json({ jobId: id, status: job.status, warnings: job.warnings });

      // run async — frontend polls
      try {
        await execFileAsync('ffmpeg', plan.args);
        job.status = 'done';
        job.log += '\nffmpeg done -> out.mp4';
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        job.status = 'error';
        job.log += `\nffmpeg failed: ${err.message ?? e}\n${String(err.stderr ?? '').slice(-3000)}`;
      }
    } catch (e) {
      job.status = 'error';
      job.log = String(e);
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/api/renders/:id', (req, res) => {
    const job = jobs.get(req.params.id as string);
    if (!job) return res.status(404).json({ error: 'not found' });
    res.json(job);
  });

  app.get('/api/renders/:id/file', (req, res) => {
    const id = req.params.id as string;
    const job = jobs.get(id);
    if (!job) return res.status(404).json({ error: 'not found' });
    if (job.status !== 'done') return res.status(409).json({ error: `not ready: ${job.status}`, log: job.log });
    const p = join(dataDir, 'jobs', id, 'out.mp4');
    if (!existsSync(p)) return res.status(404).json({ error: 'file missing' });
    res.download(p, `memeit-${id}.mp4`);
  });

  // Auto-track a solid-color screen in an uploaded video clip and return
  // position keyframes for an image clip. Multipart like /api/renders:
  // `project` (JSON) + media files keyed by clip id, plus text fields
  // videoId / targetId (required) and optional trackFps / threshold /
  // smooth / minDelta / maxKeys / roi (x,y,w,h) / fromMs / toMs.
  const numField = (v: unknown, name: string, min: number, max: number): number | undefined => {
    if (v == null || v === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`invalid ${name}: ${v}`);
    return n;
  };

  app.post('/api/tracks', (req, res, next) => {
    const id = randomUUID().slice(0, 8);
    (req as unknown as { jobId: string }).jobId = id;
    mkdirSync(join(dataDir, 'jobs', id, 'assets'), { recursive: true });
    trackJobs.set(id, { id, status: 'queued', log: '', keyframes: null, stats: null });
    next();
  }, upload.any(), async (req, res) => {
    const id = (req as unknown as { jobId: string }).jobId;
    const job = trackJobs.get(id)!;
    try {
      const body = req.body as Record<string, string>;
      const raw = body.project;
      if (!raw) return res.status(400).json({ error: 'missing project field' });
      const parsed = ProjectSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const project = parsed.data;

      const videoId = (body.videoId ?? '').trim();
      const targetId = (body.targetId ?? '').trim();
      if (!videoId || !targetId) return res.status(400).json({ error: 'missing videoId / targetId field' });
      let roi: { x: number; y: number; w: number; h: number } | undefined;
      if (body.roi != null && body.roi !== '') {
        const parts = String(body.roi).split(',').map(Number);
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
          return res.status(400).json({ error: `invalid roi (want x,y,w,h): ${body.roi}` });
        }
        roi = { x: parts[0]!, y: parts[1]!, w: parts[2]!, h: parts[3]! };
      }
      let trackOpts;
      try {
        trackOpts = {
          videoId,
          targetId,
          trackFps: numField(body.trackFps, 'trackFps', 1, 30),
          threshold: numField(body.threshold, 'threshold', 0, 255),
          smooth: numField(body.smooth, 'smooth', 1, 31),
          minDelta: numField(body.minDelta, 'minDelta', 0, 1),
          maxKeys: numField(body.maxKeys, 'maxKeys', 2, 1000),
          roi,
          fromMs: numField(body.fromMs, 'fromMs', 0, 300000),
          toMs: numField(body.toMs, 'toMs', 0, 300000),
        };
      } catch (e) {
        return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      }

      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const saved = new Map<string, string>();
      for (const f of files) saved.set(f.fieldname, f.path);
      const videoPath = saved.get(videoId);
      if (!videoPath || !existsSync(videoPath)) {
        return res.status(400).json({ error: `no file attached for video clip "${videoId}" (field name = clip id)` });
      }

      job.status = 'tracking';
      job.log = `tracking ${videoId} -> ${targetId}`;
      res.json({ jobId: id, status: job.status });

      // run async — frontend polls
      try {
        const result = await trackGreenScreen(project, videoPath, trackOpts);
        job.keyframes = result.keyframes;
        job.stats = result.stats;
        job.status = 'done';
        job.log = `${result.summary} -> ${result.keyframes.length} keyframes`;
      } catch (e: unknown) {
        job.status = 'error';
        job.log = e instanceof Error ? e.message : String(e);
      }
    } catch (e) {
      job.status = 'error';
      job.log = String(e);
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/api/tracks/:id', (req, res) => {
    const job = trackJobs.get(req.params.id as string);
    if (!job) return res.status(404).json({ error: 'not found' });
    res.json(job);
  });

  // Serve built web UI (single-server npx mode) with COOP/COEP for WASM threading.
  if (resolvedPublic && existsSync(resolvedPublic)) {
    app.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
    app.use(express.static(resolvedPublic));
    // SPA fallback: non-API GETs serve index.html
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(join(resolvedPublic, 'index.html'));
    });
  }

  return { app, dataDir, publicDir: resolvedPublic };
}

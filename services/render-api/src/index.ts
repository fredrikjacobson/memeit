import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProjectSchema } from '@memeit/timeline';
import { buildFfmpegArgs, type ResolvedAsset } from '@memeit/renderer';
import { renderTextPng } from './text.js';
import { ttsRouter } from './tts.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const app = express();
app.use(cors());
app.use(ttsRouter);

type Job = { id: string; status: 'queued' | 'rendering' | 'done' | 'error'; log: string; warnings: string[] };
const jobs = new Map<string, Job>();

app.get('/api/health', async (_req, res) => {
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-version']);
    res.json({ ok: true, ffmpeg: stdout.split('\n')[0] });
  } catch {
    res.status(500).json({ ok: false, error: 'ffmpeg not found' });
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
// Multer stores to data/jobs/:id/assets/<clipId><ext>
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const id = (req as unknown as { jobId: string }).jobId;
      const dir = join('data', 'jobs', id, 'assets');
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
  mkdirSync(join('data', 'jobs', id, 'assets'), { recursive: true });
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
    const assetDir = join('data', 'jobs', id, 'assets');
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
      await renderTextPng(c, project.width, project.height, out);
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

    const outPath = join('data', 'jobs', id, 'out.mp4');
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
  const p = join('data', 'jobs', id, 'out.mp4');
  if (!existsSync(p)) return res.status(404).json({ error: 'file missing' });
  res.download(p, `memeit-${id}.mp4`);
});

const port = 3001;
app.listen(port, () => console.log(`render-api on http://localhost:${port}`));

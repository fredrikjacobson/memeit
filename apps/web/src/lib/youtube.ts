import { addMediaFiles } from './media';

export type YoutubeMode = 'video' | 'audio';

export type YoutubeJob = {
  id: string;
  status: 'queued' | 'downloading' | 'ready' | 'error';
  url: string;
  mode: YoutubeMode;
  title?: string;
  filename?: string;
  size?: number;
  error?: string;
  log?: string;
};

const YT_RE = /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i;

export function isYouTubeUrl(raw: string): boolean {
  return YT_RE.test(raw.trim());
}

/** Accept "90", "1:23", "01:02:03" (also "1m30s"-ish is rejected — keep it strict). */
export function parseTimeInput(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.max(0, Number(t));
  const parts = t.split(':').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return NaN as unknown as null;
  let secs = 0;
  for (const p of parts) secs = secs * 60 + Number(p);
  return secs;
}

export function formatBytes(n?: number): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function pollJob(jobId: string, onStatus: (s: string) => void): Promise<YoutubeJob> {
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`/api/youtube/${jobId}`);
    if (!res.ok) throw new Error(`YouTube job lookup failed: ${await res.text()}`);
    const job = (await res.json()) as YoutubeJob;
    onStatus(job.status === 'downloading' || job.status === 'queued' ? `Downloading… (${job.status})` : job.status);
    if (job.status === 'ready') return job;
    if (job.status === 'error') throw new Error(job.error || job.log || 'yt-dlp failed');
  }
  throw new Error('YouTube download timed out after 20 min — try a shorter section.');
}

export async function downloadYoutube(opts: {
  url: string;
  mode: YoutubeMode;
  startSec?: number;
  durationSec?: number;
  onStatus: (s: string) => void;
}): Promise<YoutubeJob> {
  const res = await fetch('/api/youtube', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: opts.url.trim(),
      mode: opts.mode,
      ...(opts.startSec != null ? { startSec: opts.startSec } : {}),
      ...(opts.durationSec != null ? { durationSec: opts.durationSec } : {}),
    }),
  });
  if (!res.ok) {
    let msg = await res.text();
    try {
      msg = (JSON.parse(msg) as { error: unknown }).error as string ?? msg;
    } catch { /* keep raw */ }
    throw new Error(typeof msg === 'string' ? msg : 'Failed to start YouTube download');
  }
  const { jobId } = (await res.json()) as { jobId: string };
  opts.onStatus('Downloading… (queued)');
  return pollJob(jobId, opts.onStatus);
}

/** Fetch the finished file as a File and add it to the project (timeline + IDB). */
export async function addYoutubeToProject(job: YoutubeJob): Promise<void> {
  const res = await fetch(`/api/youtube/${job.id}/file`);
  if (!res.ok) throw new Error(`Download failed: ${await res.text()}`);
  const blob = await res.blob();
  const name = job.filename ?? (job.mode === 'audio' ? 'youtube-audio.mp3' : 'youtube-video.mp4');
  const type = blob.type || (job.mode === 'audio' ? 'audio/mpeg' : 'video/mp4');
  await addMediaFiles([new File([blob], name, { type })]);
}

/** Trigger a plain browser download of the finished file (without adding to project). */
export function saveYoutubeFile(job: YoutubeJob) {
  const a = document.createElement('a');
  a.href = `/api/youtube/${job.id}/file`;
  a.download = job.filename ?? `youtube-${job.id}`;
  a.click();
}

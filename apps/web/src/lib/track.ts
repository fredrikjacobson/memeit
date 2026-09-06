import { useEditor } from '../store';
import { buildUploadFormData } from './render';

export type TrackKeyframe = { id: string; offsetMs: number; x: number; y: number };

export type TrackStats = {
  frames: number;
  good: number;
  droppedPartial: number;
  rangeXPx: number;
  rangeYPx: number;
  windowStartMs: number;
  windowEndMs: number;
};

export type TrackOptions = {
  trackFps?: number;
  threshold?: number;
  smooth?: number;
  fromMs?: number;
  toMs?: number;
};

/**
 * Auto-track a green/blue screen via the render-api server and return
 * position keyframes for the target image clip. The caller applies them
 * (e.g. updateClip(targetId, { keyframes })) — replaces existing keys.
 */
export async function trackTargetClip(
  videoId: string,
  targetId: string,
  opts: TrackOptions,
  onProgress: (s: string) => void
): Promise<{ keyframes: TrackKeyframe[]; stats: TrackStats; log: string }> {
  const { project } = useEditor.getState();
  const { fd } = buildUploadFormData(project);
  if (!fd.has(videoId)) {
    throw new Error('Video file not attached — re-link it in Media first.');
  }
  fd.append('videoId', videoId);
  fd.append('targetId', targetId);
  if (opts.trackFps != null) fd.append('trackFps', String(opts.trackFps));
  if (opts.threshold != null) fd.append('threshold', String(opts.threshold));
  if (opts.smooth != null) fd.append('smooth', String(opts.smooth));
  if (opts.fromMs != null) fd.append('fromMs', String(opts.fromMs));
  if (opts.toMs != null) fd.append('toMs', String(opts.toMs));

  onProgress('Uploading…');
  const res = await fetch('/api/tracks', { method: 'POST', body: fd });
  if (!res.ok) {
    const body = await res.text();
    let detail = body;
    try {
      const j = JSON.parse(body) as { error?: unknown };
      if (typeof j.error === 'string') detail = j.error;
    } catch {
      // keep raw body
    }
    throw new Error(`Track failed to start: ${detail}`);
  }
  const { jobId } = (await res.json()) as { jobId: string };

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const poll = await fetch(`/api/tracks/${jobId}`);
    const job = (await poll.json()) as {
      status: string;
      log?: string;
      keyframes?: TrackKeyframe[];
      stats?: TrackStats;
    };
    onProgress(job.status === 'tracking' ? 'Tracking…' : job.status);
    if (job.status === 'done') {
      return { keyframes: job.keyframes ?? [], stats: job.stats!, log: job.log ?? '' };
    }
    if (job.status === 'error') throw new Error(job.log || 'tracking failed');
  }
  throw new Error('Track timed out after 2 min — narrow from/to to a shorter segment.');
}

import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { uid, type Project } from '@memeit/timeline';

const execFileAsync = promisify(execFile);

export type TrackParams = {
  videoId: string;
  targetId: string;
  /** frames sampled per second (default 8) */
  trackFps?: number;
  /** key-channel dominance margin 0..255 (default 60) */
  threshold?: number;
  /** centered moving-average window in frames, >=1 (default 3, 1 = off) */
  smooth?: number;
  /** min normalized move to keep a keyframe (default 0.002) */
  minDelta?: number;
  /** cap on keyframes (default 80) */
  maxKeys?: number;
  /** restrict detection to a source-pixel box */
  roi?: { x: number; y: number; w: number; h: number };
  /** project-time tracking start (default: target clip start) */
  fromMs?: number;
  /** project-time tracking end (default: target clip end) */
  toMs?: number;
};

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

export type TrackResult = {
  keyframes: TrackKeyframe[];
  stats: TrackStats;
  summary: string;
};

async function probeDims(path: string): Promise<{ w: number; h: number }> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path,
  ]);
  const [w, h] = stdout.trim().split(',').map(Number);
  if (!w || !h) throw new Error(`could not probe dimensions of ${path}`);
  return { w, h };
}

function hexChannel(hex: string): 0 | 1 | 2 {
  const m = hex.trim().replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  return g >= r && g >= b ? 1 : b >= r && b >= g ? 2 : 0;
}

/**
 * Track a solid-color screen in a video clip and express its motion as
 * position keyframes for an image clip.
 *
 * No new dependencies: ffmpeg extracts frames, sharp finds the screen's
 * centroid per frame (key-channel dominance mask). Deltas are relative to
 * the first stable frame, so the card keeps its manual base alignment.
 * Throws on failure with a human-readable message.
 */
export async function trackGreenScreen(
  project: Project,
  videoPath: string,
  params: TrackParams
): Promise<TrackResult> {
  const trackFps = params.trackFps ?? 8;
  const threshold = params.threshold ?? 60;
  const smooth = Math.max(1, Math.round(params.smooth ?? 3));
  const minDelta = params.minDelta ?? 0.002;
  const maxKeys = Math.max(2, Math.round(params.maxKeys ?? 80));

  const video = project.clips.find((c) => c.id === params.videoId);
  const target = project.clips.find((c) => c.id === params.targetId);
  if (!video || video.kind !== 'video') throw new Error(`video clip "${params.videoId}" not found`);
  if (!target || target.kind !== 'image') throw new Error(`target clip "${params.targetId}" not found (must be an image clip)`);

  const { w: sw, h: sh } = await probeDims(videoPath);

  // Tracking window in project time, intersected with both clips.
  const winStart = Math.max(target.startMs, video.startMs, params.fromMs ?? 0);
  const winEnd = Math.min(
    target.startMs + target.durationMs,
    video.startMs + video.durationMs,
    params.toMs ?? Number.POSITIVE_INFINITY
  );
  if (winEnd - winStart < 200) throw new Error('tracking window < 200ms — check clip timing / fromMs / toMs');
  const srcStartMs = video.srcOffsetMs + (winStart - video.startMs);
  const srcDurMs = winEnd - winStart;

  // Extract frames at a capped work width; remember the scale for mapping.
  const workDir = mkdtempSync(join(tmpdir(), 'memeit-track-'));
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y', '-v', 'error',
        '-ss', (srcStartMs / 1000).toFixed(3),
        '-i', videoPath,
        '-t', (srcDurMs / 1000).toFixed(3),
        '-vf', `fps=${trackFps},scale=480:-2`,
        join(workDir, 'f%04d.png'),
      ],
      { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (e) {
    rmSync(workDir, { recursive: true, force: true });
    throw new Error(`frame extraction failed: ${(e as Error).message ?? e}`);
  }
  const frames = readdirSync(workDir).filter((f) => f.endsWith('.png')).sort();
  if (frames.length === 0) {
    rmSync(workDir, { recursive: true, force: true });
    throw new Error('no frames extracted — check the tracking window');
  }

  const keyCh = hexChannel(video.chromaColor ?? '#00FF00');
  const first = await sharp(join(workDir, frames[0]!)).metadata();
  const fw = first.width ?? 480;
  const fh = first.height ?? Math.round((sh * fw) / sw);
  const kx = fw / sw;
  const ky = fh / sh;
  const roi = params.roi
    ? {
        x0: Math.max(0, Math.floor(params.roi.x * kx)),
        y0: Math.max(0, Math.floor(params.roi.y * ky)),
        x1: Math.min(fw - 1, Math.ceil((params.roi.x + params.roi.w) * kx - 1)),
        y1: Math.min(fh - 1, Math.ceil((params.roi.y + params.roi.h) * ky - 1)),
      }
    : null;

  // Same cover-fit the renderer applies, so source px map to canvas px.
  const W = project.width;
  const H = project.height;
  const fitScale = Math.max(W / sw, H / sh);
  const offX = (sw * fitScale - W) / 2;
  const offY = (sh * fitScale - H) / 2;
  const toNorm = (srcX: number, srcY: number): { x: number; y: number } => ({
    x: (srcX * fitScale - offX - W / 2) / W,
    y: (srcY * fitScale - offY - H / 2) / H,
  });

  type Sample = { i: number; ok: boolean; nx: number; ny: number; count: number };
  const samples: Sample[] = [];
  const minCount = Math.max(150, fw * fh * 0.002);
  for (let fi = 0; fi < frames.length; fi++) {
    const { data, info } = await sharp(join(workDir, frames[fi]!)).raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    const iw = info.width;
    const ih = info.height;
    const x0 = roi ? roi.x0 : 0;
    const y0 = roi ? roi.y0 : 0;
    const x1 = roi ? roi.x1 : iw - 1;
    const y1 = roi ? roi.y1 : ih - 1;
    let count = 0;
    let sx = 0;
    let sy = 0;
    for (let y = y0; y <= y1; y++) {
      const row = y * iw * ch;
      for (let x = x0; x <= x1; x++) {
        const o = row + x * ch;
        const c0 = data[o]!;
        const c1 = data[o + 1]!;
        const c2 = data[o + 2]!;
        const key = keyCh === 0 ? c0 : keyCh === 1 ? c1 : c2;
        const rest = keyCh === 0 ? Math.max(c1, c2) : keyCh === 1 ? Math.max(c0, c2) : Math.max(c0, c1);
        if (key - rest > threshold) {
          count += 1;
          sx += x;
          sy += y;
        }
      }
    }
    if (count < minCount) {
      samples.push({ i: fi, ok: false, nx: 0, ny: 0, count });
      continue;
    }
    const n = toNorm(sx / count / kx, sy / count / ky);
    samples.push({ i: fi, ok: true, nx: n.x, ny: n.y, count });
  }

  const usable = samples.filter((s) => s.ok);
  if (usable.length < 2) {
    rmSync(workDir, { recursive: true, force: true });
    throw new Error(
      `only ${usable.length} usable frame(s) of ${samples.length} — no screen found. ` +
        `Try threshold < ${threshold}, roi x,y,w,h, or narrow fromMs/toMs to the green segment.`
    );
  }
  // Partial-visibility gate: entry/exit slivers (phone sliding into frame)
  // carry far fewer mask pixels than a full screen and would bias the
  // reference centroid. Drop frames below half the median count.
  if (usable.length >= 3) {
    const counts = usable.map((s) => s.count).sort((a, b) => a - b);
    const median = counts[Math.floor(counts.length / 2)]!;
    for (const s of usable) {
      if (s.count < median * 0.5) s.ok = false;
    }
  }
  const good = samples.filter((s) => s.ok);
  const droppedPartial = usable.length - good.length;
  if (good.length < 2) {
    rmSync(workDir, { recursive: true, force: true });
    throw new Error(
      `only ${good.length} stable frame(s) of ${samples.length} — screen is mostly partial or missing. ` +
        `Narrow fromMs/toMs to the stable green segment, or try threshold / roi.`
    );
  }
  const ref = good[0]!;
  // Deltas from the reference centroid, smoothed, bad frames hold neighbors.
  const raw = samples.map((s) => (s.ok ? { x: s.nx - ref.nx, y: s.ny - ref.ny } : null));
  const half = Math.floor(smooth / 2);
  const sm = raw.map((_, idx) => {
    let nx = 0;
    let ny = 0;
    let n = 0;
    for (let k = idx - half; k <= idx + half; k++) {
      const v = raw[k];
      if (v) {
        nx += v.x;
        ny += v.y;
        n += 1;
      }
    }
    return n > 0 ? { x: nx / n, y: ny / n } : null;
  });
  let last: { x: number; y: number } = { x: 0, y: 0 };
  const fwd = sm.map((v) => {
    if (v) {
      last = v;
      return v;
    }
    return last;
  });
  // Backward pass so leading bad frames hold the first good value instead of 0.
  let next: { x: number; y: number } | null = null;
  for (let idx = fwd.length - 1; idx >= 0; idx--) {
    if (sm[idx]) next = sm[idx];
    else if (next) fwd[idx] = next;
  }

  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  const frameProjMs = (fi: number) => winStart + (fi * 1000) / trackFps;
  const keyframes: TrackKeyframe[] = [];
  const push = (fi: number) => {
    const d = fwd[fi]!;
    const offsetMs = Math.max(0, Math.min(target.durationMs, Math.round(frameProjMs(fi) - target.startMs)));
    if (keyframes.length > 0 && keyframes[keyframes.length - 1]!.offsetMs === offsetMs) keyframes.pop();
    keyframes.push({ id: uid(), offsetMs, x: clamp(target.x + d.x), y: clamp(target.y + d.y) });
  };
  push(good[0]!.i);
  for (const s of samples) {
    if (!s.ok || s.i === good[0]!.i) continue;
    const d = fwd[s.i]!;
    const prev = keyframes[keyframes.length - 1]!;
    const px = prev.x - target.x;
    const py = prev.y - target.y;
    if (Math.abs(d.x - px) >= minDelta || Math.abs(d.y - py) >= minDelta) push(s.i);
  }
  const lastGood = good[good.length - 1]!;
  if (keyframes[keyframes.length - 1]!.offsetMs !== Math.round(frameProjMs(lastGood.i) - target.startMs)) push(lastGood.i);
  // Cap: stride-thin while keeping first + last.
  if (keyframes.length > maxKeys) {
    const stride = Math.ceil(keyframes.length / maxKeys);
    const thinned = keyframes.filter((_, idx) => idx % stride === 0);
    if (thinned[thinned.length - 1] !== keyframes[keyframes.length - 1]) thinned.push(keyframes[keyframes.length - 1]!);
    keyframes.length = 0;
    keyframes.push(...thinned);
  }
  rmSync(workDir, { recursive: true, force: true });

  const rangeX = Math.max(...keyframes.map((k) => k.x)) - Math.min(...keyframes.map((k) => k.x));
  const rangeY = Math.max(...keyframes.map((k) => k.y)) - Math.min(...keyframes.map((k) => k.y));
  return {
    keyframes,
    stats: {
      frames: frames.length,
      good: good.length,
      droppedPartial,
      rangeXPx: (rangeX * W) / 2,
      rangeYPx: (rangeY * H) / 2,
      windowStartMs: Math.round(winStart),
      windowEndMs: Math.round(winEnd),
    },
    summary:
      `${frames.length} frames @${trackFps}fps, ${good.length} good` +
      (droppedPartial > 0 ? ` (${droppedPartial} partial dropped)` : '') +
      `, motion x±${((rangeX * W) / 2).toFixed(1)}px y±${((rangeY * H) / 2).toFixed(1)}px`,
  };
}

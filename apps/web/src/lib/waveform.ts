import { useEffect, useState } from 'react';

export type WaveformData = {
  /** Normalized 0..1 peaks for the whole decoded file. */
  peaks: number[];
  /** Full decoded file duration in ms. */
  durationMs: number;
};

const PEAK_BUCKETS = 2000;

// src -> in-flight/finished promise (decode once per URL)
const cache = new Map<string, Promise<WaveformData | null>>();

let ctx: AudioContext | null = null;
function sharedCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
}

function shouldSkip(src: string): boolean {
  return (
    !src ||
    src.startsWith('missing:') ||
    src.startsWith('asset:') ||
    src.startsWith('data:')
  );
}

async function decode(src: string): Promise<WaveformData | null> {
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) return null;
    // decodeAudioData detaches the buffer — copy when needed
    const audio = await sharedCtx().decodeAudioData(buf);
    if (!audio || audio.length === 0) return null;
    const channels: Float32Array[] = [];
    for (let c = 0; c < audio.numberOfChannels; c++) {
      try {
        channels.push(audio.getChannelData(c));
      } catch {
        break;
      }
    }
    if (channels.length === 0) return null;
    const total = channels[0]!.length;
    const block = Math.max(1, Math.floor(total / PEAK_BUCKETS));
    const peaks: number[] = new Array(Math.ceil(total / block));
    let max = 0;
    for (let i = 0; i < peaks.length; i++) {
      const start = i * block;
      const end = Math.min(total, start + block);
      let peak = 0;
      // stride sampling inside large blocks to stay fast on long files
      const stride = Math.max(1, Math.floor((end - start) / 200));
      for (const ch of channels) {
        for (let s = start; s < end; s += stride) {
          const v = Math.abs(ch[s] ?? 0);
          if (v > peak) peak = v;
        }
      }
      peaks[i] = peak;
      if (peak > max) max = peak;
    }
    if (max > 0) {
      for (let i = 0; i < peaks.length; i++) {
        // sqrt compression lifts quiet sections so silence isn't invisible
        peaks[i] = Math.sqrt(peaks[i]! / max);
      }
    }
    return { peaks, durationMs: Math.max(1, Math.round(audio.duration * 1000)) };
  } catch {
    // Unsupported codec, revoked blob URL, decode error etc. — no waveform.
    return null;
  }
}

/** Peaks for a whole source file, cached + shared across clips using it. */
export function getWaveform(src: string): Promise<WaveformData | null> {
  if (shouldSkip(src)) return Promise.resolve(null);
  let p = cache.get(src);
  if (!p) {
    p = decode(src);
    cache.set(src, p);
    // Drop failures so a relinked/retry can try again.
    void p.then((r) => {
      if (!r) cache.delete(src);
    });
  }
  return p;
}

/** React hook — returns null while loading or when undecodable. */
export function useWaveform(src: string | undefined): WaveformData | null {
  const [data, setData] = useState<WaveformData | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    if (!src) return;
    void getWaveform(src).then((d) => {
      if (live) setData(d);
    });
    return () => {
      live = false;
    };
  }, [src]);
  return data;
}

/**
 * Slice full-file peaks to the segment this clip plays
 * (srcOffsetMs .. srcOffsetMs + durationMs).
 */
export function slicePeaks(
  data: WaveformData,
  srcOffsetMs: number,
  durationMs: number
): number[] {
  const { peaks, durationMs: fileMs } = data;
  if (peaks.length === 0 || fileMs <= 0) return [];
  const start = Math.max(0, Math.min(fileMs, srcOffsetMs || 0));
  const end = Math.max(start + 1, Math.min(fileMs, start + Math.max(1, durationMs)));
  const lo = Math.floor((start / fileMs) * peaks.length);
  const hi = Math.max(lo + 1, Math.ceil((end / fileMs) * peaks.length));
  return peaks.slice(lo, hi);
}

// Client-side AI background removal.
//
// Flow (video):
//   1. decode original via <video>+<canvas> at ~540p, 1 frame at a time
//   2. segment each frame -> transparent PNG (in a Web Worker via
//      @imgly/background-removal, main-thread fallback)
//   3. temporal smoothing on alpha to reduce flickery edges
//   4. re-encode frames to transparent WebM (VP9) via realtime
//      canvas.captureStream + MediaRecorder playback pass
//   5. cache blob URL via registerFile(url, file, `${clipId}__bgai`)
//      so Preview can swap src and render.ts can upload the bytes.
//   6. camera audio (the cutout WebM is video-only) is sliced to WAV via
//      WebAudio and re-attached as a separate audio clip on the same span,
//      so preview mix + export keep the sound.
//
// Flow (image): single frame -> transparent PNG, same cache scheme.
//
// No server change needed for upload (render.ts prefers the processed file);
// the renderer treats bgRemove==='ai' as "already has alpha, just composite
// over the replacement background".

import { create } from 'zustand';
import * as ort from 'onnxruntime-web';
import { uid, useEditor } from '../store';
import { getFileForUrl, registerFile, unregisterUrl } from './media';
import { deleteAsset, loadAsset } from './assets';
import { wrapRgba, type RgbaTensor } from '../workers/pixels';

export const AI_MODELS = [
  { id: 'isnet_quint8', label: 'Fast (~40MB)', note: 'quantized, occasional edge artifacts' },
  { id: 'isnet_fp16', label: 'Balanced (~80MB)', note: 'default quality/speed trade-off' },
  { id: 'isnet', label: 'Quality (~170MB)', note: 'best edges, slowest download + inference' },
] as const;
export type AiModelId = (typeof AI_MODELS)[number]['id'];
export const AI_DEFAULT_MODEL: AiModelId = 'isnet_quint8';

// --- WASM threading ---
// onnxruntime-web only uses multiple threads on a cross-origin-isolated page
// (COOP + COEP headers → SharedArrayBuffer). Without them it silently runs
// single-threaded, which is the bulk of the "painfully slow" problem.
export function aiThreadInfo(): { isolated: boolean; cores: number; threads: number } {
  const cores = Math.max(1, navigator.hardwareConcurrency ?? 4);
  const threads = Math.max(1, Math.min(8, cores));
  return { isolated: window.crossOriginIsolated === true, cores, threads };
}

export function configureOrtThreads(): void {
  const { isolated, threads } = aiThreadInfo();
  ort.env.wasm.numThreads = isolated ? threads : 1;
  if (isolated) {
    console.info(`[bgai] cross-origin isolated — WASM inference on ${threads} threads`);
  } else {
    console.warn('[bgai] page is not cross-origin isolated — WASM inference limited to 1 thread (serve with COOP/COEP headers)');
  }
}

// 540p working budget: preserve aspect, cap total pixels (960x540).
const AI_MAX_PIXELS = 960 * 540;
const AI_DEFAULT_FPS = 15;
const AI_MAX_FRAMES = 450;
const AI_MAX_DURATION_MS = 15_000;

export type AiPhase = 'idle' | 'loading' | 'processing' | 'encoding' | 'done' | 'error';
export type AiJob = {
  clipId: string;
  phase: AiPhase;
  progress: number; // 0..1 overall
  label: string;
  error?: string;
};

type BgAiState = {
  jobs: Record<string, AiJob>;
  setJob: (clipId: string, patch: Partial<AiJob>) => void;
  clearJob: (clipId: string) => void;
};

export const useBgAi = create<BgAiState>((set) => ({
  jobs: {},
  setJob: (clipId, patch) =>
    set((s) => {
      const prev = s.jobs[clipId];
      const next: AiJob = {
        clipId,
        phase: patch.phase ?? prev?.phase ?? 'processing',
        progress: patch.progress ?? prev?.progress ?? 0,
        label: patch.label ?? prev?.label ?? '',
        error: patch.error ?? undefined,
      };
      return { jobs: { ...s.jobs, [clipId]: next } };
    }),
  clearJob: (clipId) =>
    set((s) => {
      const next = { ...s.jobs };
      delete next[clipId];
      return { jobs: next };
    }),
}));

// cooperative cancellation flags per running job
const cancelFlags = new Map<string, { cancelled: boolean }>();

export function cancelAiJob(clipId: string) {
  const flag = cancelFlags.get(clipId);
  if (flag) flag.cancelled = true;
  useBgAi.getState().setJob(clipId, { label: 'Cancelling…' });
}

export function aiJobFor(clipId: string): AiJob | undefined {
  return useBgAi.getState().jobs[clipId];
}

/** Effective display source: processed transparent file when AI is on + ready. */
export function aiDisplaySrc(clip: { bgRemove?: string; bgAiSrc?: string } | undefined): string | null {
  if (!clip) return null;
  if ((clip.bgRemove ?? 'off') === 'ai' && clip.bgAiSrc && !clip.bgAiSrc.startsWith('missing:')) {
    return clip.bgAiSrc;
  }
  return null;
}

/** Preferred upload file: processed bytes when AI is on + cached, else original. */
export function fileForUpload(src: string, bgAiSrc?: string): File | undefined {
  if (bgAiSrc) {
    const processed = getFileForUrl(bgAiSrc);
    if (processed) return processed;
  }
  return getFileForUrl(src);
}

export async function preloadAiModel(
  model: string = AI_DEFAULT_MODEL,
  onProgress?: (key: string, current: number, total: number) => void,
): Promise<void> {
  const mod = await import('@imgly/background-removal');
  await mod.preload({
    model: model as 'isnet' | 'isnet_fp16' | 'isnet_quint8',
    output: { format: 'image/png', quality: 0.8 },
    ...(onProgress ? { progress: onProgress } : {}),
  });
}

// ---------- worker plumbing ----------

type WorkerResult =
  | { type: 'ready' }
  | { type: 'result'; frameIndex: number; width: number; height: number; buffer: ArrayBuffer }
  | { type: 'result'; frameIndex: number; blob: Blob }
  | { type: 'error'; frameIndex?: number; message: string }
  | { type: 'closed' };

// Raw cutout pixels (zero-copy path) or a PNG blob (fallback path).
type SegmentOutput = { kind: 'raw'; image: ImageData } | { kind: 'png'; blob: Blob };

function createSegmentWorker(model: string): Promise<Worker> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/bgai.worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(e);
      return;
    }
    const timeout = setTimeout(() => {
      try { worker.terminate(); } catch { /* ignore */ }
      reject(new Error('AI worker init timed out'));
    }, 30_000);
    const onReady = (e: MessageEvent<WorkerResult>) => {
      if ((e.data as { type: string }).type === 'ready') {
        clearTimeout(timeout);
        worker.removeEventListener('message', onReady as EventListener);
        resolve(worker);
      } else if ((e.data as { type: string }).type === 'error' && (e.data as { frameIndex?: number }).frameIndex === undefined) {
        clearTimeout(timeout);
        worker.removeEventListener('message', onReady as EventListener);
        try { worker.terminate(); } catch { /* ignore */ }
        reject(new Error((e.data as { message?: string }).message ?? 'worker init failed'));
      }
    };
    worker.addEventListener('message', onReady as EventListener);
    worker.addEventListener('error', (err) => {
      clearTimeout(timeout);
      reject(err instanceof ErrorEvent ? new Error(err.message) : new Error('worker error'));
    });
    worker.postMessage({ type: 'init', model, device: 'cpu', threads: aiThreadInfo().threads });
  });
}

// Segment one frame. The frame's pixel buffer is *transferred* to the worker
// (zero-copy) — do not reuse `frame` afterwards.
function segmentViaWorker(
  worker: Worker,
  frameIndex: number,
  frame: ImageData,
  timeoutMs = 180_000,
): Promise<SegmentOutput> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.removeEventListener('message', onMsg as EventListener);
      reject(new Error(`frame ${frameIndex} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const onMsg = (e: MessageEvent<WorkerResult>) => {
      const d = e.data;
      if (d.type === 'result' && d.frameIndex === frameIndex) {
        clearTimeout(timeout);
        worker.removeEventListener('message', onMsg as EventListener);
        const raw = d as { width?: number; height?: number; buffer?: ArrayBuffer; blob?: Blob };
        if (raw.buffer && raw.width === frame.width && raw.height === frame.height) {
          const image = rawToImageData(raw.buffer, raw.width, raw.height);
          if (image) {
            resolve({ kind: 'raw', image });
            return;
          }
        }
        if (raw.blob) {
          resolve({ kind: 'png', blob: raw.blob });
          return;
        }
        reject(new Error(`frame ${frameIndex}: worker returned unusable pixels`));
      } else if (d.type === 'error' && (d.frameIndex === frameIndex || d.frameIndex === undefined)) {
        clearTimeout(timeout);
        worker.removeEventListener('message', onMsg as EventListener);
        reject(new Error(d.message));
      }
    };
    worker.addEventListener('message', onMsg as EventListener);
    // transfer (not copy) the pixel buffer — `frame` is unusable afterwards
    const buffer = frame.data.buffer as ArrayBuffer;
    worker.postMessage(
      { type: 'segment', frameIndex, width: frame.width, height: frame.height, buffer },
      [buffer],
    );
  });
}

function rawToImageData(buf: ArrayBuffer, width: number, height: number): ImageData | null {
  try {
    if (buf.byteLength !== width * height * 4) return null;
    return new ImageData(new Uint8ClampedArray(buf), width, height);
  } catch {
    return null;
  }
}

// main-thread fallback (same library, runs on UI thread — slower but works
// when Workers/modules are blocked)
async function segmentOnMainThread(frame: ImageData, model: string): Promise<SegmentOutput> {
  const mod = await import('@imgly/background-removal');
  const fn = (mod.default ?? mod.removeBackground) as unknown as (
    src: RgbaTensor,
    cfg?: Record<string, unknown>,
  ) => Promise<Blob>;
  // zero-copy view — the pipeline must get an ndarray-shaped tensor, never a
  // raw DOM ImageData (see workers/pixels.ts)
  const tensor = wrapRgba(
    new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
    frame.width,
    frame.height,
  );
  if (!tensor) throw new Error('unusable frame pixels');
  try {
    const raw = await fn(tensor, { model, device: 'cpu', output: { format: 'image/x-rgba8' } });
    const image = rawToImageData(await raw.arrayBuffer(), frame.width, frame.height);
    if (image) return { kind: 'raw', image };
  } catch { /* fall through to PNG */ }
  return { kind: 'png', blob: await fn(tensor, { model, device: 'cpu', output: { format: 'image/png', quality: 0.8 } }) };
}

// ---------- video helpers ----------

function loadVideo(file: File): Promise<{ video: HTMLVideoElement; url: string }> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    const cleanup = () => {
      video.onloadedmetadata = null;
      video.onerror = null;
    };
    video.onloadedmetadata = () => {
      cleanup();
      resolve({ video, url });
    };
    video.onerror = () => {
      cleanup();
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode this video in the browser.'));
    };
    video.src = url;
    setTimeout(() => reject(new Error('Video load timed out.')), 20_000);
  });
}

function seekTo(video: HTMLVideoElement, sec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onErr);
      resolve();
    };
    const onErr = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onErr);
      reject(new Error('Seek failed during background removal.'));
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onErr);
    video.currentTime = Math.max(0, sec);
    setTimeout(() => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onErr);
      resolve(); // some browsers don't fire seeked for tiny seeks — continue anyway
    }, 5000);
  });
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Frame encode failed.'))), 'image/png');
  });
}

function pickRecorderMime(): { mime: string; hasAlpha: boolean } {
  const cands = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const mime of cands) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
        return { mime, hasAlpha: mime.includes('vp9') };
      }
    } catch { /* ignore */ }
  }
  return { mime: '', hasAlpha: false };
}

// Blend current frame's alpha with the previous frame's to dampen flicker.
// Operates in place on `cur` using `prev` (same dimensions).
function temporalSmoothAlpha(cur: ImageData, prev: ImageData | null, amount = 0.25): void {
  if (!prev || prev.width !== cur.width || prev.height !== cur.height) return;
  const a = cur.data;
  const b = prev.data;
  for (let i = 3; i < a.length; i += 4) {
    a[i] = Math.round(a[i]! * (1 - amount) + b[i]! * amount);
  }
}

// ---------- public jobs ----------

export type StartAiOptions = {
  model?: AiModelId;
  fps?: number;
  smoothing?: boolean;
  /** slice camera audio into a separate timeline track (default true) */
  keepAudio?: boolean;
};

export async function startAiBackgroundRemoval(clipId: string, opts: StartAiOptions = {}): Promise<void> {
  const st = useEditor.getState();
  const clip = st.project.clips.find((c) => c.id === clipId);
  if (!clip || (clip.kind !== 'video' && clip.kind !== 'image')) {
    throw new Error('Select a video or image clip first.');
  }
  if (clip.src.startsWith('missing:')) throw new Error('File is missing — relink it first.');
  if (cancelFlags.has(clipId)) throw new Error('Removal already running for this clip.');

  const model = opts.model ?? ((clip.bgAiModel as AiModelId | undefined) ?? AI_DEFAULT_MODEL);
  const smoothing = opts.smoothing ?? true;
  const keepAudio = opts.keepAudio ?? true;
  // thread pool must be set before the first session is created (preload)
  configureOrtThreads();
  const flag = { cancelled: false };
  cancelFlags.set(clipId, flag);
  const setJob = useBgAi.getState().setJob;

  // resolve original bytes (registry first, IDB fallback after refresh)
  let original = getFileForUrl(clip.src);
  if (!original) {
    const blob = await loadAsset(clipId).catch(() => undefined);
    if (blob) {
      original = blob instanceof File ? blob : new File([blob], clip.name ?? 'media', { type: blob.type || 'video/mp4' });
    }
  }
  if (!original) {
    cancelFlags.delete(clipId);
    throw new Error('Original file bytes not found — re-import the media.');
  }

  const fail = (message: string, cause?: unknown) => {
    // full stack goes to the console; the panel shows the staged message
    if (cause !== undefined) console.error('[bgai] AI job failed:', cause);
    st.updateClip(clipId, { bgAiStatus: 'error', bgAiError: message } as never);
    setJob(clipId, { phase: 'error', progress: 0, label: 'Failed', error: message });
    cancelFlags.delete(clipId);
  };

  try {
    if (clip.kind === 'image') {
      await runImageJob(clipId, original, model, flag, setJob);
      return;
    }
    await runVideoJob(clipId, original, model, smoothing, opts.fps, keepAudio, flag, setJob);
  } catch (e) {
    if (flag.cancelled) {
      st.updateClip(clipId, { bgAiStatus: 'idle', bgAiProgress: 0 } as never);
      useBgAi.getState().clearJob(clipId);
      cancelFlags.delete(clipId);
      return;
    }
    const stage = useBgAi.getState().jobs[clipId]?.label;
    const msg = e instanceof Error ? e.message : String(e);
    fail(stage ? `${stage} — ${msg}` : msg, e);
  }
}

async function runImageJob(
  clipId: string,
  original: File,
  model: string,
  flag: { cancelled: boolean },
  setJob: BgAiState['setJob'],
) {
  const st = useEditor.getState();
  st.updateClip(clipId, { bgRemove: 'ai', bgAiStatus: 'loading', bgAiProgress: 0, bgAiModel: model, bgAiError: undefined } as never);
  setJob(clipId, { phase: 'loading', progress: 0.02, label: 'Loading AI model…' });

  let worker: Worker | null = null;
  try {
    worker = await createSegmentWorker(model);
  } catch {
    worker = null; // main-thread fallback below
  }
  if (flag.cancelled) throw new Error('cancelled');
  setJob(clipId, { phase: 'processing', progress: 0.2, label: 'Removing background…' });
  st.updateClip(clipId, { bgAiStatus: 'processing', bgAiProgress: 0.2 } as never);

  // decode straight to pixels (no PNG round-trip) at the same pixel budget
  const srcBmp = await createImageBitmap(original);
  const iScale = Math.min(1, Math.sqrt(AI_MAX_PIXELS / Math.max(1, srcBmp.width * srcBmp.height)));
  const iW = Math.max(2, Math.round(srcBmp.width * iScale));
  const iH = Math.max(2, Math.round(srcBmp.height * iScale));
  const iCanvas = document.createElement('canvas');
  iCanvas.width = iW;
  iCanvas.height = iH;
  const ictx = iCanvas.getContext('2d')!;
  ictx.drawImage(srcBmp, 0, 0, iW, iH);
  srcBmp.close?.();
  const frame = ictx.getImageData(0, 0, iW, iH);

  const out = worker
    ? await segmentViaWorker(worker, 0, frame).finally(() => { try { worker?.terminate(); } catch { /* ignore */ } })
    : await segmentOnMainThread(frame, model);
  if (flag.cancelled) throw new Error('cancelled');

  let outBlob: Blob;
  if (out.kind === 'raw') {
    const oCanvas = document.createElement('canvas');
    oCanvas.width = out.image.width;
    oCanvas.height = out.image.height;
    oCanvas.getContext('2d')!.putImageData(out.image, 0, 0);
    outBlob = await canvasToPngBlob(oCanvas);
  } else {
    outBlob = out.blob;
  }
  const file = new File([outBlob], baseName(st.project.clips.find((c) => c.id === clipId)?.name, 'image') + '.bgai.png', { type: 'image/png' });
  const url = URL.createObjectURL(file);
  registerFile(url, file, `${clipId}__bgai`);
  st.updateClip(clipId, {
    bgRemove: 'ai',
    bgAiSrc: url,
    bgAiStatus: 'done',
    bgAiProgress: 1,
    bgAiModel: model,
    bgAiError: undefined,
  } as never);
  setJob(clipId, { phase: 'done', progress: 1, label: 'Done — preview shows cutout' });
  cancelFlags.delete(clipId);
  setTimeout(() => useBgAi.getState().clearJob(clipId), 4000);
}

async function runVideoJob(
  clipId: string,
  original: File,
  model: string,
  smoothing: boolean,
  fpsOpt: number | undefined,
  keepAudio: boolean,
  flag: { cancelled: boolean },
  setJob: BgAiState['setJob'],
) {
  const st = useEditor.getState();
  const getClip = () => st.project.clips.find((c) => c.id === clipId);
  const clip0 = getClip();
  if (!clip0 || clip0.kind !== 'video') throw new Error('Clip is not a video.');
  const projectFps = st.project.fps || 30;

  st.updateClip(clipId, { bgRemove: 'ai', bgAiStatus: 'loading', bgAiProgress: 0, bgAiModel: model, bgAiError: undefined } as never);
  setJob(clipId, { phase: 'loading', progress: 0.01, label: 'Loading video…' });

  const { video, url } = await loadVideo(original);
  try {
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const scale = Math.min(1, Math.sqrt(AI_MAX_PIXELS / Math.max(1, vw * vh)));
    const W = Math.max(2, Math.round((vw * scale) / 2) * 2);
    const H = Math.max(2, Math.round((vh * scale) / 2) * 2);

    // The cutout must cover the whole clip (preview + export play it for the
    // full duration), so refuse clips longer than the cap instead of
    // silently truncating — Cut (S) into ≤15s pieces first.
    if (clip0.durationMs > AI_MAX_DURATION_MS) {
      throw new Error(
        `Clip is ${(clip0.durationMs / 1000).toFixed(1)}s — AI cutout supports up to ${AI_MAX_DURATION_MS / 1000}s. ` +
        'Cut (S) it into shorter pieces first, then run AI on each.',
      );
    }
    // fps: requested (default 15) capped by project fps; auto-drop so the
    // frame budget (450) holds.
    let fps = Math.min(fpsOpt ?? AI_DEFAULT_FPS, projectFps, 30);
    const durationMs = clip0.durationMs;
    let nFrames = Math.max(1, Math.round((durationMs / 1000) * fps));
    if (nFrames > AI_MAX_FRAMES) {
      fps = Math.max(5, Math.floor((AI_MAX_FRAMES / durationMs) * 1000));
      nFrames = Math.max(1, Math.round((durationMs / 1000) * fps));
    }
    const srcOffsetMs = clip0.srcOffsetMs ?? 0;

    // Extract camera audio up front (fast offline decode, runs in parallel
    // with segmentation). The cutout WebM is video-only, so the audio comes
    // back as a separate timeline track at the end.
    const audioPromise: Promise<{ blob: Blob; durationMs: number } | null> = keepAudio
      ? extractAudioSlice(original, srcOffsetMs, durationMs).catch((e) => {
        console.warn('[bgai] audio extraction failed:', e);
        return null;
      })
      : Promise.resolve(null);

    // worker (preferred) or main-thread fallback
    setJob(clipId, { phase: 'loading', progress: 0.03, label: 'Loading AI model (~40-170MB first run)…' });
    let worker: Worker | null = null;
    try {
      // warm the model cache with progress surfaced on the model-download
      // phase (first run downloads; later runs are instant)
      await preloadAiModel(model, (_key, current, total) => {
        if (flag.cancelled) return;
        const p = total > 0 ? 0.03 + 0.12 * (current / total) : 0.05;
        setJob(clipId, { phase: 'loading', progress: p, label: `Downloading AI model… ${Math.round((current / Math.max(1, total)) * 100)}%` });
      });
      worker = await createSegmentWorker(model);
    } catch (e) {
      console.warn('[bgai] worker unavailable, using main thread:', e);
      worker = null;
    }
    if (flag.cancelled) throw new Error('cancelled');

    const frameCanvas = document.createElement('canvas');
    frameCanvas.width = W;
    frameCanvas.height = H;
    const fctx = frameCanvas.getContext('2d', { willReadFrequently: true })!;
    const outCanvas = document.createElement('canvas');
    outCanvas.width = W;
    outCanvas.height = H;
    const octx = outCanvas.getContext('2d', { willReadFrequently: true })!;

    st.updateClip(clipId, { bgAiStatus: 'processing' } as never);
    const cutouts: Blob[] = [];
    let prev: ImageData | null = null;

    for (let i = 0; i < nFrames; i++) {
      if (flag.cancelled) throw new Error('cancelled');
      const tSec = (srcOffsetMs + (i * 1000) / fps) / 1000;
      await seekTo(video, tSec);
      fctx.clearRect(0, 0, W, H);
      fctx.drawImage(video, 0, 0, W, H);
      // raw pixels, zero-copy into the worker — no PNG encode on the way in.
      // (the buffer is transferred, so re-read from the canvas if we retry)
      const frame = fctx.getImageData(0, 0, W, H);

      setJob(clipId, {
        phase: 'processing',
        progress: 0.15 + 0.7 * (i / nFrames),
        label: `Cutting out… frame ${i + 1}/${nFrames}`,
      });

      let out: SegmentOutput;
      try {
        out = worker ? await segmentViaWorker(worker, i, frame) : await segmentOnMainThread(frame, model);
      } catch (e) {
        // worker died mid-job (e.g. OOM) — fall back to main thread once
        if (worker) {
          try { worker.terminate(); } catch { /* ignore */ }
          worker = null;
          out = await segmentOnMainThread(fctx.getImageData(0, 0, W, H), model);
        } else {
          throw e;
        }
      }
      if (flag.cancelled) throw new Error('cancelled');

      // Composite the cutout, smooth alpha against the previous frame, and
      // store one PNG per frame for the realtime encode pass. PNG decode only
      // happens on the fallback path — raw pixels go straight to the canvas.
      if (out.kind === 'raw') {
        octx.putImageData(out.image, 0, 0);
      } else {
        try {
          const bmp = await createImageBitmap(out.blob);
          octx.clearRect(0, 0, W, H);
          octx.drawImage(bmp, 0, 0, W, H);
          bmp.close?.();
        } catch {
          // undecodable PNG — keep the pixels as-is rather than failing the job
          cutouts.push(out.blob);
          st.updateClip(clipId, { bgAiProgress: 0.15 + 0.7 * ((i + 1) / nFrames) } as never);
          continue;
        }
      }
      if (smoothing) {
        const cur = octx.getImageData(0, 0, W, H);
        temporalSmoothAlpha(cur, prev);
        octx.putImageData(cur, 0, 0);
      }
      prev = octx.getImageData(0, 0, W, H);
      cutouts.push(await canvasToPngBlob(outCanvas));
      st.updateClip(clipId, { bgAiProgress: 0.15 + 0.7 * ((i + 1) / nFrames) } as never);
    }

    if (worker) {
      try {
        worker.postMessage({ type: 'close' });
        worker.terminate();
      } catch { /* ignore */ }
    }
    if (flag.cancelled) throw new Error('cancelled');

    // ---- encode pass: play cutouts back in realtime while recording ----
    const { mime, hasAlpha } = pickRecorderMime();
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('This browser cannot record WebM (MediaRecorder unsupported).');
    }
    setJob(clipId, { phase: 'encoding', progress: 0.88, label: 'Encoding transparent WebM…' });
    st.updateClip(clipId, { bgAiStatus: 'processing', bgAiProgress: 0.88 } as never);

    const stream = outCanvas.captureStream(fps);
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
    const recorded = new Promise<Blob>((resolve, reject) => {
      recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      recorder.onerror = () => reject(new Error('WebM recording failed.'));
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
    });
    recorder.start(250);

    const frameMs = 1000 / fps;
    for (let i = 0; i < cutouts.length; i++) {
      if (flag.cancelled) {
        try { recorder.stop(); } catch { /* ignore */ }
        throw new Error('cancelled');
      }
      const bmp = await createImageBitmap(cutouts[i]!);
      octx.clearRect(0, 0, W, H);
      octx.drawImage(bmp, 0, 0, W, H);
      bmp.close?.();
      setJob(clipId, {
        phase: 'encoding',
        progress: 0.88 + 0.1 * ((i + 1) / cutouts.length),
        label: `Encoding… ${i + 1}/${cutouts.length}`,
      });
      await new Promise((r) => setTimeout(r, frameMs));
    }
    // flush trailing frame then stop
    await new Promise((r) => setTimeout(r, Math.max(300, frameMs * 2)));
    recorder.stop();
    const webm = await recorded;
    for (const t of stream.getTracks()) t.stop();
    if (flag.cancelled) throw new Error('cancelled');
    if (!webm.size) throw new Error('Encoding produced an empty file.');

    const clipNow = getClip();
    const file = new File([webm], baseName(clipNow?.kind === 'video' ? clipNow.name : undefined, 'video') + '.bgai.webm', { type: 'video/webm' });
    const outUrl = URL.createObjectURL(file);
    registerFile(outUrl, file, `${clipId}__bgai`);

    st.updateClip(clipId, {
      bgRemove: 'ai',
      bgAiSrc: outUrl,
      bgAiStatus: 'done',
      bgAiProgress: 1,
      bgAiModel: model,
      bgAiError: undefined,
    } as never);

    // re-attach camera audio as its own track (same span, same mix level)
    let audioNote = '';
    if (keepAudio) {
      const wav = await audioPromise;
      if (wav && !flag.cancelled) {
        attachAiAudioClip(clipId, wav.blob, wav.durationMs);
        audioNote = ' · 🎵 audio kept as separate track';
      } else if (!flag.cancelled) {
        audioNote = ' · no audio in source';
      }
    }
    if (flag.cancelled) throw new Error('cancelled');

    setJob(clipId, {
      phase: 'done',
      progress: 1,
      label: hasAlpha ? `Done — preview shows cutout${audioNote}` : 'Done (no VP9 alpha — edges may look solid)',
    });
    if (!hasAlpha) console.warn('[bgai] VP9 WebM unsupported, fell back without alpha channel');
    cancelFlags.delete(clipId);
    setTimeout(() => useBgAi.getState().clearJob(clipId), 5000);
  } finally {
    try { video.pause(); } catch { /* ignore */ }
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function baseName(name: string | undefined | null, fallback: string): string {
  const stem = (name ?? fallback).split('/').pop() ?? fallback;
  return stem.replace(/\.[a-z0-9]+$/i, '') || fallback;
}

/** File name for the auto-extracted camera-audio track of a video clip. */
function aiAudioClipName(videoName: string | undefined | null): string {
  return `${baseName(videoName, 'video')}.bgaudio.wav`;
}

// Slice [offsetMs, offsetMs + durationMs] of the source file's audio track and
// encode it as 16-bit WAV. Returns null when the source has no usable audio
// (silent video, offset past the audio end, unsupported codec…).
async function extractAudioSlice(
  original: File,
  offsetMs: number,
  durationMs: number,
): Promise<{ blob: Blob; durationMs: number } | null> {
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC();
  try {
    const buf = await ctx.decodeAudioData(await original.arrayBuffer());
    if (buf.numberOfChannels === 0 || buf.duration < 0.05) return null;
    const sr = buf.sampleRate;
    const start = Math.floor((offsetMs / 1000) * sr);
    if (start >= buf.length) return null;
    const end = Math.min(buf.length, start + Math.floor((durationMs / 1000) * sr));
    if (end - start < sr * 0.1) return null; // <100ms sliver — not worth a track
    const channels = Math.min(2, buf.numberOfChannels);
    const sliced: Float32Array[] = [];
    for (let ch = 0; ch < channels; ch++) {
      sliced.push(buf.getChannelData(ch).slice(start, end));
    }
    return { blob: encodeWav(sliced, sr), durationMs: Math.round(((end - start) / sr) * 1000) };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// Minimal 16-bit PCM WAV encoder (interleaved, capped at stereo).
function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const nCh = channels.length;
  const nFrames = channels[0]!.length;
  const dataSize = nFrames * nCh * 2;
  const ab = new ArrayBuffer(44 + dataSize);
  const v = new DataView(ab);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nCh * 2, true);
  v.setUint16(32, nCh * 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, 'data');
  v.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < nFrames; i++) {
    for (let ch = 0; ch < nCh; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch]![i]!));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// Add (or replace, on re-runs) the extracted camera-audio track: same timeline
// span as the video clip, same mix level, srcOffset 0 (already sliced).
// Selection is handed back to the video clip afterwards.
function attachAiAudioClip(videoClipId: string, wav: Blob, sliceMs: number): void {
  const st = useEditor.getState();
  const video = st.project.clips.find((c) => c.id === videoClipId);
  if (!video || video.kind !== 'video') return;
  const name = aiAudioClipName(video.name);
  // drop a previous auto-extract for this video so re-runs don't stack tracks
  for (const c of st.project.clips) {
    if (c.kind === 'audio' && c.name === name && Math.abs(c.startMs - video.startMs) < 1) {
      st.removeClip(c.id);
    }
  }
  const id = uid();
  const file = new File([wav], name, { type: 'audio/wav' });
  const url = URL.createObjectURL(file);
  registerFile(url, file, id);
  st.addClip({
    id,
    kind: 'audio',
    name,
    startMs: video.startMs,
    durationMs: Math.max(100, sliceMs),
    src: url,
    volume: Math.max(0, Math.min(2, video.volume ?? 1)),
    srcOffsetMs: 0,
  });
  st.select(videoClipId);
}

/** Revert an AI removal: drop the processed file, restore original preview. */
export async function clearAiBackground(clipId: string) {
  const st = useEditor.getState();
  const clip = st.project.clips.find((c) => c.id === clipId);
  if (!clip) return;
  if (clip.kind === 'video' || clip.kind === 'image') {
    const bgAiSrc = (clip as { bgAiSrc?: string }).bgAiSrc;
    if (bgAiSrc) unregisterUrl(bgAiSrc);
    await deleteAsset(`${clipId}__bgai`).catch(() => {});
    // also drop the auto-extracted audio track (if still sitting where we put
    // it) — otherwise it would double up with the restored camera audio
    if (clip.kind === 'video') {
      const name = aiAudioClipName(clip.name);
      for (const c of useEditor.getState().project.clips) {
        if (c.kind === 'audio' && c.name === name && Math.abs(c.startMs - clip.startMs) < 1) {
          useEditor.getState().removeClip(c.id);
        }
      }
    }
    st.updateClip(clipId, {
      bgRemove: 'off',
      bgAiSrc: undefined,
      bgAiStatus: 'idle',
      bgAiProgress: 0,
      bgAiError: undefined,
    } as never);
  }
  useBgAi.getState().clearJob(clipId);
}

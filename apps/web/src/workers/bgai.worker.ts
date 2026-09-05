// Segmentation worker: runs @imgly/background-removal off the main thread.
// Main thread decodes video frames (<video>+<canvas>) and encodes the result
// (canvas.captureStream + MediaRecorder) — this worker only does
// image -> cutout pixels per frame so the UI stays responsive.
//
// Zero-copy protocol: raw RGBA buffers are *transferred* (not copied) both
// ways. The segmenter takes ImageData directly (no PNG encode on the way in)
// and returns `image/x-rgba8` raw bytes when the size matches (no PNG decode
// on the way out), with transparent fallback to PNG blobs.
//
// Protocol (main -> worker):
//   { type: 'init', model, device, threads }
//   { type: 'segment', frameIndex, width, height, buffer: ArrayBuffer }
//   { type: 'close' }
// Protocol (worker -> main):
//   { type: 'ready' }
//   { type: 'result', frameIndex, width, height, buffer: ArrayBuffer }  // raw RGBA
//   { type: 'result', frameIndex, blob: Blob }                          // PNG fallback
//   { type: 'error', frameIndex?, message }

import * as ort from 'onnxruntime-web';
import { wrapRgba, type RgbaTensor } from './pixels';

type InitMsg = { type: 'init'; model: string; device: 'cpu' | 'gpu'; threads?: number };
type SegmentMsg = { type: 'segment'; frameIndex: number; width: number; height: number; buffer: ArrayBuffer };
type CloseMsg = { type: 'close' };

type Post = (m: unknown, transfer?: Transferable[]) => void;
const post = (m: unknown, transfer?: Transferable[]) =>
  (self as unknown as { postMessage: Post }).postMessage(m, transfer);

let removeFn: ((src: RgbaTensor, config?: Record<string, unknown>) => Promise<Blob>) | null = null;
let modelName = 'isnet_quint8';
let deviceName: 'cpu' | 'gpu' = 'cpu';
let initPromise: Promise<void> | null = null;

async function ensureInit(threads?: number): Promise<void> {
  if (removeFn) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // Thread pool must be set before the first session is created.
    // (Page needs COOP/COEP headers or this is silently single-threaded.)
    try {
      ort.env.wasm.numThreads = Math.max(1, threads ?? 1);
    } catch { /* ignore — older builds */ }
    // Dynamic import keeps the main bundle lean; the model/wasm assets are
    // fetched from the @imgly CDN on first use and cached by the browser.
    const mod = await import('@imgly/background-removal');
    const fn = (mod.default ?? mod.removeBackground) as unknown as NonNullable<typeof removeFn>;
    if (!fn) throw new Error('background-removal module has no default export');
    removeFn = fn;
  })();
  return initPromise;
}

self.onmessage = async (e: MessageEvent<InitMsg | SegmentMsg | CloseMsg>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      modelName = msg.model || modelName;
      deviceName = msg.device || 'cpu';
      await ensureInit(msg.threads);
      post({ type: 'ready' });
      return;
    }
    if (msg.type === 'segment') {
      await ensureInit();
      const fn = removeFn!;
      // NOTE: pass an ndarray-shaped tensor, NOT a DOM ImageData — the lib's
      // input passthrough leaves ImageData unconverted and inference crashes
      // destructuring its (nonexistent) .shape. See workers/pixels.ts.
      const tensor = wrapRgba(new Uint8Array(msg.buffer), msg.width, msg.height);
      if (!tensor) throw new Error(`frame ${msg.frameIndex}: bad pixel buffer`);
      const needed = msg.width * msg.height * 4;
      // fast path: raw RGBA straight into ImageData, no PNG codec either way
      try {
        const raw = await fn(tensor, {
          model: modelName,
          device: deviceName,
          output: { format: 'image/x-rgba8' },
        });
        const ab = await raw.arrayBuffer();
        if (ab.byteLength === needed) {
          post(
            { type: 'result', frameIndex: msg.frameIndex, width: msg.width, height: msg.height, buffer: ab },
            [ab],
          );
          return;
        }
      } catch { /* fall through to PNG */ }
      const png = await fn(tensor, {
        model: modelName,
        device: deviceName,
        output: { format: 'image/png', quality: 0.8 },
      });
      post({ type: 'result', frameIndex: msg.frameIndex, blob: png });
      return;
    }
    if (msg.type === 'close') {
      removeFn = null;
      initPromise = null;
      post({ type: 'closed' });
    }
  } catch (err) {
    post({
      type: 'error',
      frameIndex: msg.type === 'segment' ? msg.frameIndex : undefined,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

export {};

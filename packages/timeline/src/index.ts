import { z } from 'zod';

export * from './srt.js';

// 10s typical, 2-3min max -> cap at 5min for safety, 30fps max
export const ClipBase = z.object({
  id: z.string(),
  name: z.string().optional(),
  startMs: z.number().min(0).max(5 * 60 * 1000),
  durationMs: z.number().min(100).max(5 * 60 * 1000),
});

export const VideoClipSchema = ClipBase.extend({
  kind: z.literal('video'),
  src: z.string(), // local path or blobURL (preview) / file id (render)
  volume: z.number().min(0).max(1).default(1),
  scale: z.number().min(0.1).max(4).default(1),
  x: z.number().default(0), // -0.5..0.5 normalized offset
  y: z.number().default(0),
  // offset into the source file where this clip starts (set by split)
  srcOffsetMs: z.number().min(0).max(5 * 60 * 1000).default(0),
  // how the source fills the canvas: cover = fill+crop, contain = fit+letterbox, stretch = exact (may distort)
  fit: z.enum(['cover', 'contain', 'stretch']).default('cover'),
  // background removal: chroma-key for solid green/blue screens,
  // 'ai' for client-side ML segmentation (transparent WebM cached in bgAiSrc)
  bgRemove: z.enum(['off', 'chroma', 'ai']).default('off'),
  // client-side AI result (blob: URL in memory, asset: ref when serialized)
  bgAiSrc: z.string().optional(),
  bgAiStatus: z.enum(['idle', 'loading', 'processing', 'done', 'error']).default('idle').optional(),
  bgAiProgress: z.number().min(0).max(1).default(0).optional(),
  bgAiModel: z.string().optional(),
  bgAiError: z.string().optional(),
  chromaColor: z.string().default('#00FF00'),
  chromaSimilarity: z.number().min(0).max(1).default(0.3),
  chromaBlend: z.number().min(0).max(1).default(0.1),
  // what to composite behind the keyed subject (only used when bgRemove === 'chroma')
  bgReplace: z.enum(['black', 'color', 'image']).default('black'),
  bgColor: z.string().default('#000000'),
  bgImageClipId: z.string().optional(),
});

export const ImageClipSchema = ClipBase.extend({
  kind: z.literal('image'),
  src: z.string(),
  scale: z.number().min(0.1).max(4).default(1),
  x: z.number().default(0),
  y: z.number().default(0),
  // client-side AI background removal (single-frame PNG cached in bgAiSrc)
  bgRemove: z.enum(['off', 'ai']).default('off').optional(),
  bgAiSrc: z.string().optional(),
  bgAiStatus: z.enum(['idle', 'loading', 'processing', 'done', 'error']).default('idle').optional(),
  bgAiProgress: z.number().min(0).max(1).default(0).optional(),
  bgAiModel: z.string().optional(),
  bgAiError: z.string().optional(),
});

export const KeyframeSchema = z.object({
  id: z.string(),
  // offset from clip.startMs — robust when clip is moved
  offsetMs: z.number().min(0).max(5 * 60 * 1000),
  x: z.number().min(-1).max(1),
  y: z.number().min(-1).max(1),
  fontSize: z.number().min(12).max(200).optional(),
});

export type Keyframe = z.infer<typeof KeyframeSchema>;

export const TextClipSchema = ClipBase.extend({
  kind: z.literal('text'),
  text: z.string().min(1).max(280),
  font: z.string().default('Impact'),
  fontSize: z.number().min(12).max(200).default(64),
  color: z.string().default('#ffffff'),
  strokeColor: z.string().default('#000000'),
  strokeWidth: z.number().min(0).max(20).default(4),
  x: z.number().default(0), // normalized -0.5..0.5
  y: z.number().default(-0.35), // default top meme position
  keyframes: z.array(KeyframeSchema).default([]),
});

export const AudioClipSchema = ClipBase.extend({
  kind: z.literal('audio'),
  src: z.string(),
  volume: z.number().min(0).max(2).default(1),
  // offset into the source file where this clip starts (set by split)
  srcOffsetMs: z.number().min(0).max(5 * 60 * 1000).default(0),
});

export const AnyClipSchema = z.discriminatedUnion('kind', [
  VideoClipSchema,
  ImageClipSchema,
  TextClipSchema,
  AudioClipSchema,
]);

export const ProjectSchema = z.object({
  version: z.literal(1),
  width: z.number().default(1080),
  height: z.number().default(1920),
  fps: z.number().min(15).max(60).default(30),
  durationMs: z.number().min(500).max(5 * 60 * 1000).default(10_000),
  clips: z.array(AnyClipSchema).default([]),
});

export type VideoClip = z.infer<typeof VideoClipSchema>;
export type ImageClip = z.infer<typeof ImageClipSchema>;
export type TextClip = z.infer<typeof TextClipSchema>;
export type AudioClip = z.infer<typeof AudioClipSchema>;
export type AnyClip = z.infer<typeof AnyClipSchema>;
export type Project = z.infer<typeof ProjectSchema>;

export const isClipActiveAt = (clip: AnyClip, tMs: number) =>
  tMs >= clip.startMs && tMs < clip.startMs + clip.durationMs;

export const activeClipsAt = (project: Project, tMs: number) =>
  project.clips.filter((c) => isClipActiveAt(c, tMs));

// --- keyframe interpolation (linear) ---
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export type TextTransform = { x: number; y: number; fontSize: number };

export function evalTextAt(clip: TextClip, absTimeMs: number): TextTransform {
  const base = { x: clip.x, y: clip.y, fontSize: clip.fontSize };
  const kfs = [...(clip.keyframes ?? [])].sort((a, b) => a.offsetMs - b.offsetMs);
  if (kfs.length === 0) return base;
  const offset = absTimeMs - clip.startMs;
  // implicit base key at offset 0 so motion starts from clip position
  const pts = [{ id: '__base__', offsetMs: 0, ...base }, ...kfs];
  const first = pts[0]!;
  if (offset <= first.offsetMs) return { x: first.x, y: first.y, fontSize: first.fontSize ?? base.fontSize };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (offset >= a.offsetMs && offset <= b.offsetMs) {
      const span = Math.max(1, b.offsetMs - a.offsetMs);
      const t = (offset - a.offsetMs) / span;
      const aSize = a.fontSize ?? base.fontSize;
      const bSize = b.fontSize ?? aSize;
      return {
        x: lerp(a.x, b.x, t),
        y: lerp(a.y, b.y, t),
        fontSize: lerp(aSize, bSize, t),
      };
    }
  }
  const last = pts[pts.length - 1]!;
  return { x: last.x, y: last.y, fontSize: last.fontSize ?? base.fontSize };
}

export function nearestKeyframe(clip: TextClip, absTimeMs: number, tolMs = 150) {
  const offset = absTimeMs - clip.startMs;
  let best: Keyframe | null = null;
  let bestD = Infinity;
  for (const k of clip.keyframes ?? []) {
    const d = Math.abs(k.offsetMs - offset);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best && bestD <= tolMs ? best : null;
}

export const createDefaultProject = (): Project => ({
  version: 1,
  width: 1080,
  height: 1920,
  fps: 30,
  durationMs: 10_000,
  clips: [],
});

export const uid = () => Math.random().toString(36).slice(2, 10);

import type { AudioClip, ImageClip, Project, TextClip, VideoClip } from '@memeit/timeline';

export type ResolvedAsset = {
  clipId: string;
  kind: 'video' | 'image' | 'audio';
  path: string;
};

export type RenderPlan = {
  args: string[];
  description: string;
  warnings: string[];
};

// Full local render:
// - base = earliest video fitted to WxH (cover/contain/stretch) or black color
// - base video may have chroma-key ('chroma') or client-side AI cutout ('ai')
//   background removal, composited over black / solid color / another image clip
// - image overlays scaled by clip.scale, positioned from normalized x/y
// - text overlays are pre-rendered full-frame PNGs (see text.ts), overlaid 0:0
// - audio: base video audio (if probed present) + N tracks via adelay+amix
// NOTE: keyframed text motion is preview-only in V1 — text renders at base x/y.
export function buildFfmpegArgs(
  project: Project,
  assets: ResolvedAsset[],
  textPngs: { clipId: string; path: string }[],
  opts: { baseHasAudio: boolean },
  outPath: string
): RenderPlan {
  const { width: W, height: H, fps, durationMs } = project;
  const DUR = durationMs / 1000;
  const warnings: string[] = [];
  const args: string[] = ['-y'];

  const byId = new Map(assets.map((a) => [a.clipId, a]));
  const videos = project.clips.filter((c) => c.kind === 'video').sort((a, b) => a.startMs - b.startMs) as VideoClip[];
  const images = project.clips.filter((c) => c.kind === 'image').sort((a, b) => a.startMs - b.startMs) as ImageClip[];
  const texts = project.clips.filter((c) => c.kind === 'text').sort((a, b) => a.startMs - b.startMs) as TextClip[];
  const audios = project.clips.filter((c) => c.kind === 'audio').sort((a, b) => a.startMs - b.startMs) as AudioClip[];

  const baseClip = videos[0] as VideoClip | undefined;
  if (videos.length > 1) warnings.push(`${videos.length - 1} extra video clip(s) ignored in V1 — only the first is used as base.`);
  const kfCount = texts.reduce((n, t) => n + (t.keyframes?.length ?? 0), 0);
  if (kfCount > 0) warnings.push(`Text keyframes (${kfCount}) are preview-only in V1 — export uses base position.`);

  // input index bookkeeping: idxOf maps a key -> ffmpeg input index
  // seekMs applies `-ss` *before* `-i` (fast input seek into cut pieces)
  const idxOf = new Map<string, number>();
  let idx = 0;
  const pushInput = (key: string, path: string, loopImage: boolean, seekMs = 0) => {
    if (seekMs > 0) args.push('-ss', (seekMs / 1000).toFixed(3));
    if (loopImage) args.push('-loop', '1');
    args.push('-i', path);
    idxOf.set(key, idx);
    idx += 1;
  };

  if (baseClip && byId.has(baseClip.id)) {
    pushInput(`video:${baseClip.id}`, byId.get(baseClip.id)!.path, false, baseClip.srcOffsetMs ?? 0);
  }
  for (const c of images) {
    const a = byId.get(c.id);
    if (a) pushInput(`image:${c.id}`, a.path, true);
    else warnings.push(`Image "${c.name ?? c.id}" missing file — skipped.`);
  }
  for (const t of texts) {
    const p = textPngs.find((x) => x.clipId === t.id);
    if (p) pushInput(`text:${t.id}`, p.path, true);
  }
  for (const c of audios) {
    const a = byId.get(c.id);
    if (a) pushInput(`audio:${c.id}`, a.path, false, c.srcOffsetMs ?? 0);
    else warnings.push(`Audio "${c.name ?? c.id}" missing file — skipped.`);
  }

  const filters: string[] = [];
  const hasBase = baseClip && idxOf.has(`video:${baseClip.id}`);
  const chromaOn = hasBase && (baseClip as VideoClip).bgRemove === 'chroma';
  // AI cutout: the uploaded file is already a transparent WebM (client-side
  // segmentation) — no chromakey needed, just composite over the replacement bg
  const aiOn = hasBase && (baseClip as VideoClip).bgRemove === 'ai';
  const keyedOn = chromaOn || aiOn;
  if (aiOn && opts.baseHasAudio === false && !audios.some((c) => byId.has(c.id))) {
    warnings.push('AI cutout is silent and no separate audio track was found — original camera audio is dropped.');
  }
  const fit = (hasBase ? (baseClip as VideoClip).fit : 'cover') ?? 'cover';
  // cover = fill + center-crop (current behavior, best for same-aspect sources)
  // contain = fit inside + black letterbox (best for 16:9 source on 9:16 canvas)
  // stretch = exact WxH (may distort, no cropping)
  const fitChain =
    fit === 'contain'
      ? `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps}`
      : fit === 'stretch'
        ? `scale=${W}:${H},setsar=1,fps=${fps}`
        : `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps}`;

  if (hasBase) {
    const vc = baseClip as VideoClip;
    // pan the fitted video on the canvas (x/y are -0.5..0.5 normalized; 0,0 = centered = legacy)
    const vxb = Math.round((vc.x ?? 0) * W);
    const vyb = Math.round((vc.y ?? 0) * H);
    if (keyedOn) {
      const c = vc;
      if (chromaOn) {
        const hex = (c.chromaColor ?? '#00FF00').replace('#', '0x');
        const sim = Math.max(0, Math.min(1, c.chromaSimilarity ?? 0.3)).toFixed(3);
        const blend = Math.max(0, Math.min(1, c.chromaBlend ?? 0.1)).toFixed(3);
        filters.push(`[0:v]${fitChain},chromakey=${hex}:${sim}:${blend},format=yuva420p[ck]`);
      } else {
        // AI file already carries alpha — keep it through the fit
        filters.push(`[0:v]${fitChain},format=yuva420p[ck]`);
      }
      // replacement background behind the keyed subject
      const replace = (c.bgReplace ?? 'black') as 'black' | 'color' | 'image';
      const bgImage =
        replace === 'image'
          ? images.find((im) => im.id === (c.bgImageClipId ?? ''))
          : undefined;
      const bgIdx = bgImage ? idxOf.get(`image:${bgImage.id}`) : undefined;
      if (replace === 'image' && bgImage && bgIdx != null) {
        // honor the linked image clip's own size/position: cover-fill, zoom by
        // scale, then center with x/y offset on a black canvas (s=1,x=0,y=0 = exact fill)
        const s = Math.max(0.1, Math.min(4, bgImage.scale ?? 1));
        const xb = Math.round((bgImage.x ?? 0) * W);
        const yb = Math.round((bgImage.y ?? 0) * H);
        filters.push(
          `[${bgIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps},scale=iw*${s}:ih*${s},format=yuva420p[bgs]`
        );
        filters.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${DUR},format=yuv420p[bgc]`);
        filters.push(`[bgc][bgs]overlay=x='(W-w)/2+${xb}':y='(H-h)/2+${yb}':shortest=1,format=yuv420p[bg]`);
      } else {
        if (replace === 'image') {
          warnings.push(
            `Background image "${c.bgImageClipId ?? '(none)'}" missing — fell back to black.`
          );
        }
        const raw = (c.bgColor ?? '#000000').trim();
        const solid =
          replace === 'color' && /^#?[0-9a-fA-F]{6}$/.test(raw)
            ? raw.replace('#', '0x')
            : 'black';
        filters.push(`color=c=${solid}:s=${W}x${H}:r=${fps}:d=${DUR},format=yuv420p[bg]`);
      }
      filters.push(`[bg][ck]overlay=x='(W-w)/2+${vxb}':y='(H-h)/2+${vyb}':shortest=1,format=yuv420p[base]`);
    } else if (vxb !== 0 || vyb !== 0) {
      filters.push(`[0:v]${fitChain},format=yuva420p[fg]`);
      filters.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${DUR},format=yuv420p[bgc]`);
      filters.push(`[bgc][fg]overlay=x='(W-w)/2+${vxb}':y='(H-h)/2+${vyb}':shortest=1,format=yuv420p[base]`);
    } else {
      filters.push(`[0:v]${fitChain},format=yuv420p[base]`);
    }
  } else {
    filters.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${DUR},format=yuv420p[base]`);
  }

  let cur = '[base]';
  let vN = 0;
  const between = (sMs: number, dMs: number) => `between(t,${(sMs / 1000).toFixed(3)},${((sMs + dMs) / 1000).toFixed(3)})`;

  // background image doubles as the [bg] source — don't also draw it on top
  const bgImageId =
    keyedOn ? ((baseClip as VideoClip).bgImageClipId ?? null) : null;
  const bgInUse =
    keyedOn &&
    (baseClip as VideoClip).bgReplace === 'image' &&
    bgImageId != null &&
    idxOf.has(`image:${bgImageId}`)
      ? bgImageId
      : null;

  for (const c of images) {
    if (bgInUse != null && c.id === bgInUse) continue;
    const i = idxOf.get(`image:${c.id}`);
    if (i == null) continue;
    const ov = `ov${vN}`;
    const s = Math.max(0.1, Math.min(4, c.scale));
    filters.push(`[${i}:v]scale=iw*${s}:ih*${s},format=yuva420p[${ov}]`);
    const xb = Math.round(c.x * W);
    const yb = Math.round(c.y * H);
    const out = `v${vN}`;
    filters.push(
      `${cur}[${ov}]overlay=x='(W-w)/2+${xb}':y='(H-h)/2+${yb}':enable='${between(c.startMs, c.durationMs)}'[${out}]`
    );
    cur = `[${out}]`;
    vN += 1;
  }

  for (const t of texts) {
    const i = idxOf.get(`text:${t.id}`);
    if (i == null) continue;
    const out = `v${vN}`;
    filters.push(`${cur}[${i}:v]overlay=0:0:enable='${between(t.startMs, t.durationMs)}'[${out}]`);
    cur = `[${out}]`;
    vN += 1;
  }

  // ---- audio ----
  const audioLabels: string[] = [];
  if (hasBase && opts.baseHasAudio && baseClip) {
    const v = Math.max(0, Math.min(1, baseClip.volume));
    filters.push(`[0:a]aresample=44100,volume=${v}[a0]`);
    audioLabels.push('[a0]');
  }
  audios.forEach((c, n) => {
    const i = idxOf.get(`audio:${c.id}`);
    if (i == null) return;
    const delay = Math.round(c.startMs);
    const v = Math.max(0, Math.min(2, c.volume));
    filters.push(`[${i}:a]aresample=44100,adelay=${delay}|${delay},volume=${v},apad[aa${n}]`);
    audioLabels.push(`[aa${n}]`);
  });

  let mapAudio = false;
  if (audioLabels.length === 1) {
    filters.push(`${audioLabels[0]}atrim=0:${DUR},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`);
    mapAudio = true;
  } else if (audioLabels.length > 1) {
    filters.push(
      `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0,atrim=0:${DUR},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`
    );
    mapAudio = true;
  }

  args.push('-filter_complex', filters.join(';'), '-map', cur, ...(mapAudio ? ['-map', '[aout]'] : []));
  args.push(
    '-t', String(DUR),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    ...(mapAudio ? ['-c:a', 'aac', '-b:a', '128k'] : []),
    '-movflags', '+faststart',
    outPath
  );

  return {
    args,
    description: `render ${W}x${H}@${fps} ${DUR}s — ${videos.length}v/${images.length}img/${texts.length}txt/${audios.length}aud, base audio ${opts.baseHasAudio ? 'yes' : 'no'}${hasBase ? `, fit ${fit}` : ''}${chromaOn ? `, chroma-key over ${(baseClip as VideoClip).bgReplace ?? 'black'}` : ''}${aiOn ? `, AI cutout over ${(baseClip as VideoClip).bgReplace ?? 'black'}` : ''}`,
    warnings,
  };
}

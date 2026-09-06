import { useEditor, uid } from '../store';
import { deleteAsset, saveAsset } from './assets';

function kindForFile(f: File): 'video' | 'image' | 'audio' | null {
  if (f.type.startsWith('video/')) return 'video';
  if (f.type.startsWith('image/')) return 'image';
  if (f.type.startsWith('audio/')) return 'audio';
  // fallback by extension (e.g. drag from some browsers / Linux gives empty type)
  const ext = f.name.split('.').pop()?.toLowerCase();
  if (['mp4', 'mov', 'm4v'].includes(ext ?? '')) return 'video';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext ?? '')) return 'image';
  if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'oga', 'opus'].includes(ext ?? '')) return 'audio';
  // ambiguous containers — resolved by probing below (webm/mkv/ogg can hold either)
  if (['webm', 'mkv', 'ogg'].includes(ext ?? '')) return null;
  return null;
}

// webm/mkv/ogg can contain audio-only OR video. Ask a temp element whether
// the file actually has a picture; fall back to `fallback` when unloadable
// (unloadable here also means unplayable in this browser).
function probeHasVideo(url: string, fallback: 'video' | 'audio'): Promise<'video' | 'audio'> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    let done = false;
    const finish = (k: 'video' | 'audio') => {
      if (done) return;
      done = true;
      v.removeAttribute('src');
      v.load();
      resolve(k);
    };
    v.onloadedmetadata = () => {
      const tracks = (v as HTMLVideoElement & { videoTracks?: { length: number } }).videoTracks;
      const hasPic = (tracks ? tracks.length > 0 : false) || v.videoWidth > 0 || v.videoHeight > 0;
      finish(hasPic ? 'video' : 'audio');
    };
    v.onerror = () => finish(fallback);
    v.src = url;
    setTimeout(() => finish(fallback), 5000);
  });
}

function probeVideoDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const cleanup = () => {
      v.removeAttribute('src');
      v.load();
    };
    v.onloadedmetadata = () => {
      const sec = v.duration;
      cleanup();
      resolve(Number.isFinite(sec) ? sec * 1000 : null);
    };
    v.onerror = () => {
      cleanup();
      resolve(null);
    };
    v.src = url;
    // safety timeout
    setTimeout(() => resolve(null), 5000);
  });
}

function probeAudioDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const a = document.createElement('audio');
    a.preload = 'metadata';
    let done = false;
    const finish = (v: number | null) => {
      if (done) return;
      done = true;
      a.removeAttribute('src');
      a.load();
      resolve(v);
    };
    a.onloadedmetadata = () => {
      const sec = a.duration;
      finish(Number.isFinite(sec) ? sec * 1000 : null);
    };
    a.onerror = () => finish(null);
    a.src = url;
    setTimeout(() => finish(null), 5000);
  });
}

// Registry so the renderer can upload original Files (preview uses blob URLs,
// the server needs the bytes). Keyed by object URL. Blobs also persist to
// IndexedDB keyed by clip id so media survives refresh.
const fileRegistry = new Map<string, File>();

export function getFileForUrl(url: string): File | undefined {
  return fileRegistry.get(url);
}

export function registerFile(url: string, file: File, clipId?: string) {
  fileRegistry.set(url, file);
  if (clipId) void saveAsset(clipId, file).catch(() => {});
}

export function unregisterUrl(url: string) {
  fileRegistry.delete(url);
  try {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  } catch { /* ignore */ }
}

export async function deleteStoredClip(clipId: string, src?: string) {
  if (src && src.startsWith('blob:')) unregisterUrl(src);
  await deleteAsset(clipId).catch(() => {});
}

// Swap a missing/broken asset for a newly picked file (relink)
export async function relinkClipFile(clipId: string, f: File): Promise<string> {
  const url = URL.createObjectURL(f);
  registerFile(url, f, clipId);
  return url;
}

export async function addMediaFiles(files: FileList | File[]) {
  const list = Array.from(files);
  if (list.length === 0) return;
  const state = useEditor.getState();

  for (const f of list) {
    const id = uid();
    const url = URL.createObjectURL(f);
    let kind = kindForFile(f);
    if (!kind) {
      // ambiguous container (webm/mkv/ogg hold audio or video) — probe content;
      // anything else unrecognized is skipped
      const ext = f.name.split('.').pop()?.toLowerCase();
      if (!['webm', 'mkv', 'ogg'].includes(ext ?? '')) continue;
      kind = await probeHasVideo(url, ext === 'ogg' ? 'audio' : 'video');
    }
    registerFile(url, f, id);
    const base = { id, name: f.name, startMs: 0, src: url };

    if (kind === 'video') {
      const probed = await probeVideoDuration(url);
      const project = useEditor.getState().project;
      // cap 10s default logic replaced: use real duration, clamped 1s..5min
      const durationMs = probed ? Math.max(1000, Math.min(300_000, probed)) : Math.min(project.durationMs, 10_000);
      useEditor.getState().addClip({
        ...base,
        kind: 'video',
        durationMs,
        volume: 1,
        scale: 1,
        x: 0,
        y: 0,
        srcOffsetMs: 0,
        fit: 'cover',
        bgRemove: 'off',
        bgAiStatus: 'idle',
        bgAiProgress: 0,
        chromaColor: '#00FF00',
        chromaSimilarity: 0.3,
        chromaBlend: 0.1,
        bgReplace: 'black',
        bgColor: '#000000',
      });
      // if this is the first video, fit project duration to it (10s typical, up to 3min+)
      const vids = useEditor.getState().project.clips.filter((c) => c.kind === 'video');
      if (vids.length === 1) {
        useEditor.getState().updateProject((p) => ({ ...p, durationMs }));
      }
    } else if (kind === 'image') {
      state.addClip({ ...base, kind: 'image', durationMs: 3000, scale: 1, x: 0, y: 0, keyframes: [] });
    } else {
      const probed = await probeAudioDuration(url);
      const durationMs = probed ? Math.max(500, Math.min(300_000, probed)) : 10_000;
      state.addClip({ ...base, kind: 'audio', durationMs, volume: 1, srcOffsetMs: 0 });
      // Grow the timeline to fit the audio (startMs is 0). Otherwise a clip
      // longer than the project overflows it and the timeline move clamp
      // (projDur - duration <= 0) pins it at 0 — it can't be dragged at all.
      const cur = useEditor.getState().project.durationMs;
      if (durationMs > cur) {
        useEditor.getState().updateProject((p) => ({ ...p, durationMs: Math.min(300_000, Math.max(p.durationMs, durationMs)) }));
      }
    }
  }
}

import { create } from 'zustand';
import {
  AnyClip,
  Project,
  createDefaultProject,
  uid,
} from '@memeit/timeline';
import { deleteAsset } from './lib/assets';

type EditorState = {
  project: Project;
  currentTimeMs: number;
  playing: boolean;
  selectedId: string | null;
  selectedKeyframeId: string | null;
  autoKey: boolean;
  // clips the browser itself cannot decode (preview-only problem — export via ffmpeg still works)
  unsupportedIds: Record<string, true>;
  markUnsupported: (id: string) => void;
  setTime: (ms: number) => void;
  setPlaying: (p: boolean) => void;
  select: (id: string | null) => void;
  selectKeyframe: (id: string | null) => void;
  setAutoKey: (v: boolean) => void;
  updateProject: (fn: (p: Project) => Project) => void;
  addClip: (clip: AnyClip) => void;
  updateClip: (id: string, patch: Partial<AnyClip>) => void;
  removeClip: (id: string) => void;
};

export const useEditor = create<EditorState>((set) => ({
  project: createDefaultProject(),
  currentTimeMs: 0,
  playing: false,
  selectedId: null,
  selectedKeyframeId: null,
  autoKey: true,
  unsupportedIds: {},
  markUnsupported: (id) => set((s) => (s.unsupportedIds[id] ? s : { unsupportedIds: { ...s.unsupportedIds, [id]: true as const } })),
  setTime: (ms) =>
    set((s) => ({
      currentTimeMs: Math.max(0, Math.min(s.project.durationMs, ms)),
    })),
  setPlaying: (playing) => set({ playing }),
  select: (selectedId) => set({ selectedId, selectedKeyframeId: null }),
  selectKeyframe: (selectedKeyframeId) => set({ selectedKeyframeId }),
  setAutoKey: (autoKey) => set({ autoKey }),
  updateProject: (fn) => set((s) => ({ project: fn(s.project) })),
  addClip: (clip) =>
    set((s) => ({ project: { ...s.project, clips: [...s.project.clips, clip] }, selectedId: clip.id })),
  updateClip: (id, patch) =>
    set((s) => ({
      project: {
        ...s.project,
        clips: s.project.clips.map((c) => (c.id === id ? ({ ...c, ...patch } as AnyClip) : c)),
      },
    })),
  removeClip: (id) => {
    // drop persisted bytes too (fire-and-forget)
    void deleteAsset(id).catch(() => {});
    return set((s) => ({
      project: { ...s.project, clips: s.project.clips.filter((c) => c.id !== id) },
      selectedId: s.selectedId === id ? null : s.selectedId,
      selectedKeyframeId: s.selectedId === id ? null : s.selectedKeyframeId,
    }));
  },
}));

export { uid };

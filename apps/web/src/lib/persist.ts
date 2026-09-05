import { ProjectSchema, type AnyClip, type Project } from '@memeit/timeline';
import { clipIdFromRef, isMissingRef, loadAsset, toAssetRef } from './assets';
import { registerFile } from './media';

const LS_KEY = 'memeit.project.v1';

// Serialize: blob:/missing: URLs -> asset: refs so JSON survives refresh + export
export function serializeProject(project: Project): Project {
  return {
    ...project,
    clips: project.clips.map((c) => {
      if (c.kind === 'video' || c.kind === 'image' || c.kind === 'audio') {
        const id = clipIdFromRef(c.src) ?? (c.src.startsWith('blob:') ? c.id : null);
        if (id) return { ...c, src: toAssetRef(id) };
        if (isMissingRef(c.src)) return { ...c, src: toAssetRef(c.id) };
      }
      return c;
    }) as Project['clips'],
  };
}

export function saveProjectLocal(project: Project) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(serializeProject(project)));
  } catch {
    // quota exceeded (shouldn't — blobs live in IDB, not localStorage)
  }
}

export function loadProjectLocal(): Project | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = ProjectSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Turn asset: refs back into playable blob URLs. Returns missing clip ids.
export async function rehydrateProject(project: Project): Promise<{ project: Project; missing: string[] }> {
  const missing: string[] = [];
  const clips = await Promise.all(
    project.clips.map(async (c): Promise<AnyClip> => {
      if (c.kind !== 'video' && c.kind !== 'image' && c.kind !== 'audio') return c;
      const refId = clipIdFromRef(c.src);
      const lookupId = refId ?? (c.src.startsWith('blob:') ? null : null);
      if (!refId) {
        // legacy blob: URL from an older export — unresolvable after refresh
        if (c.src.startsWith('blob:')) {
          missing.push(c.id);
          return { ...c, src: `missing:${c.id}` } as AnyClip;
        }
        return c;
      }
      void lookupId;
      const blob = await loadAsset(refId);
      if (!blob) {
        missing.push(c.id);
        return { ...c, src: `missing:${c.id}` } as AnyClip;
      }
      const file = blob instanceof File ? blob : new File([blob], c.name ?? refId, { type: blob.type });
      const url = URL.createObjectURL(file);
      registerFile(url, file, refId);
      return { ...c, src: url } as AnyClip;
    })
  );
  return { project: { ...project, clips }, missing };
}

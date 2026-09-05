import { ProjectSchema, type AnyClip, type Project } from '@memeit/timeline';
import { clipIdFromRef, isMissingRef, loadAsset, toAssetRef } from './assets';
import { registerFile } from './media';

const LS_KEY = 'memeit.project.v1';

// Serialize: blob:/missing: URLs -> asset: refs so JSON survives refresh + export.
// AI cutouts (bgAiSrc) are persisted under `<clipId>__bgai` the same way.
export function serializeProject(project: Project): Project {
  return {
    ...project,
    clips: project.clips.map((c) => {
      if (c.kind === 'video' || c.kind === 'image' || c.kind === 'audio') {
        let next: AnyClip = { ...c };
        const id = clipIdFromRef(c.src) ?? (c.src.startsWith('blob:') ? c.id : null);
        if (id) next = { ...next, src: toAssetRef(id) };
        else if (isMissingRef(c.src)) next = { ...next, src: toAssetRef(c.id) };
        if ((c.kind === 'video' || c.kind === 'image') && c.bgAiSrc) {
          const bgId = clipIdFromRef(c.bgAiSrc) ?? (c.bgAiSrc.startsWith('blob:') ? `${c.id}__bgai` : null);
          if (bgId) next = { ...next, bgAiSrc: toAssetRef(bgId) } as AnyClip;
          else if (isMissingRef(c.bgAiSrc)) next = { ...next, bgAiSrc: toAssetRef(`${c.id}__bgai`) } as AnyClip;
        }
        return next;
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

// Grow the timeline to cover all clips (capped). Repairs projects where a
// clip — e.g. an audio file longer than the timeline — overflows it and gets
// pinned at 0 by the timeline move clamp, making it undraggable.
export function fitProjectToClips(project: Project): Project {
  const maxEnd = project.clips.reduce((m, c) => Math.max(m, c.startMs + c.durationMs), 0);
  if (maxEnd <= project.durationMs) return project;
  return { ...project, durationMs: Math.min(300_000, maxEnd) };
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
      let next = { ...c, src: url } as AnyClip;
      // restore the AI cutout alongside the original (stored under <id>__bgai)
      if ((next.kind === 'video' || next.kind === 'image') && next.bgAiSrc) {
        const bgRefId = clipIdFromRef(next.bgAiSrc);
        if (bgRefId) {
          const bgBlob = await loadAsset(bgRefId).catch(() => undefined);
          if (bgBlob) {
            const bgFile = bgBlob instanceof File ? bgBlob : new File([bgBlob], `${c.name ?? c.id}.bgai`, { type: bgBlob.type });
            const bgUrl = URL.createObjectURL(bgFile);
            registerFile(bgUrl, bgFile, bgRefId);
            next = { ...next, bgAiSrc: bgUrl } as AnyClip;
          } else {
            next = { ...next, bgAiSrc: `missing:${bgRefId}` } as AnyClip;
          }
        } else if (next.bgAiSrc.startsWith('blob:')) {
          next = { ...next, bgAiSrc: `missing:${c.id}__bgai` } as AnyClip;
        }
      }
      return next;
    })
  );
  return { project: { ...project, clips }, missing };
}

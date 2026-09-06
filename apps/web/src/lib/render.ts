import { useEditor } from '../store';
import type { Project } from '@memeit/timeline';
import { fileForUpload } from './bgai';
import { slugify } from './projectName';

export type RenderState = { status: string; warnings?: string[]; log?: string };

/** Project JSON + attached media files (field name = clip id, mirroring the render API). */
export function buildUploadFormData(project: Project): { fd: FormData; attached: number } {
  const fd = new FormData();
  fd.append('project', JSON.stringify(project));

  let attached = 0;
  for (const c of project.clips) {
    if (c.kind === 'video' || c.kind === 'image' || c.kind === 'audio') {
      // AI cutout ready? upload the processed transparent file instead of the
      // original — the server composites it the same way, no API change needed
      const bgAiSrc = c.kind === 'video' || c.kind === 'image' ? (c.bgAiSrc ?? undefined) : undefined;
      const aiOn = (c.kind === 'video' || c.kind === 'image') && ((c.bgRemove ?? 'off') === 'ai');
      const f = aiOn ? fileForUpload(c.src, bgAiSrc) : fileForUpload(c.src);
      if (f) {
        // fieldname = clip id so server can map back (multer uses fieldname)
        fd.append(c.id, f, `${c.id}-${c.name ?? 'file'}`);
        attached += 1;
      }
    }
  }
  return { fd, attached };
}

export async function renderProject(onProgress: (s: string) => void): Promise<void> {
  const { project } = useEditor.getState();
  const { fd, attached } = buildUploadFormData(project);
  if (attached === 0 && project.clips.some((c) => c.kind !== 'text')) {
    throw new Error('No local files attached — re-import media (files from a previous session are not available).');
  }

  onProgress('Uploading…');
  const res = await fetch('/api/renders', { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`Render failed to start: ${await res.text()}`);
  const { jobId, warnings } = await res.json();

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const poll = await fetch(`/api/renders/${jobId}`);
    const job: RenderState = await poll.json();
    onProgress(job.status === 'rendering' ? `Rendering…${warnings?.length ? ` (${warnings.length} note)` : ''}` : job.status);
    if (job.status === 'done') {
      onProgress('Downloading…');
      const a = document.createElement('a');
      a.href = `/api/renders/${jobId}/file`;
      a.download = `${slugify(project.name, `memeit-${jobId}`)}.mp4`;
      a.click();
      if (job.warnings?.length) alert(`Rendered with notes:\n- ${job.warnings.join('\n- ')}`);
      return;
    }
    if (job.status === 'error') throw new Error(job.log || 'ffmpeg failed');
  }
  throw new Error('Render timed out after 2 min — try a shorter clip.');
}

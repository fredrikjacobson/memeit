import { ProjectSchema, type Project } from '@memeit/timeline';
import { clipIdFromRef, loadAsset, saveAsset } from './assets';
import { getFileForUrl } from './media';
import { fitProjectToClips, rehydrateProject, serializeProject } from './persist';
import { slugify } from './projectName';
import { useEditor } from '../store';

// Portable data-dump format (v1) — a ZIP bundle:
//
//   memeit-dump.zip
//     project.json          serializeProject() output (`asset:<clipId>` refs)
//     assets/<clipId>.<ext> original media bytes per clip
//     assets/<clipId>__bgai.<ext>  AI-cutout bytes when present
//
// `assets/<id>.<ext>` naming is deliberate: `resolveMediaSrc()` (CLI/server)
// resolves `asset:<id>` to `<dir>/<id>` or `<dir>/<id>.*`, so after unzipping
// `memeit verify/render project.json --assets-dir assets` just works.

const MIME_EXT: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
};

function extFor(name: string | undefined, mime: string | undefined): string {
  if (name) {
    const m = /\.([a-z0-9]{2,5})$/i.exec(name.trim());
    if (m) return `.${m[1]!.toLowerCase()}`;
  }
  if (mime) {
    const base = mime.split(';')[0]!.trim().toLowerCase();
    if (MIME_EXT[base]) return MIME_EXT[base]!;
  }
  return '.bin';
}

type MediaRef = { assetId: string; fileName: string; blob: Blob };

async function collectMedia(project: Project): Promise<{ files: MediaRef[]; missing: string[] }> {
  const files: MediaRef[] = [];
  const missing: string[] = [];
  for (const c of project.clips) {
    if (c.kind !== 'video' && c.kind !== 'image' && c.kind !== 'audio') continue;
    // original bytes: live registry first, IDB fallback after refresh
    const refId = clipIdFromRef(c.src);
    let blob: Blob | File | undefined = c.src.startsWith('blob:') ? getFileForUrl(c.src) : undefined;
    blob ??= refId ? await loadAsset(refId).catch(() => undefined) : undefined;
    // legacy: blob URL whose registry entry lapsed — try by clip id
    blob ??= c.src.startsWith('blob:') ? await loadAsset(c.id).catch(() => undefined) : undefined;
    if (blob) {
      const name = c.name ?? c.id;
      files.push({
        assetId: refId ?? c.id,
        fileName: `assets/${refId ?? c.id}${extFor(name, blob.type)}`,
        blob,
      });
    } else {
      missing.push(c.id);
    }
    // AI cutout alongside the original (stored under <id>__bgai)
    if ((c.kind === 'video' || c.kind === 'image') && c.bgAiSrc && !c.bgAiSrc.startsWith('missing:')) {
      const bgRef = clipIdFromRef(c.bgAiSrc) ?? (c.bgAiSrc.startsWith('blob:') ? `${c.id}__bgai` : null);
      if (bgRef) {
        const bgBlob: Blob | File | undefined = c.bgAiSrc.startsWith('blob:')
          ? (getFileForUrl(c.bgAiSrc) ?? (await loadAsset(bgRef).catch(() => undefined)))
          : await loadAsset(bgRef).catch(() => undefined);
        if (bgBlob) {
          files.push({
            assetId: bgRef,
            fileName: `assets/${bgRef}${extFor(undefined, bgBlob.type)}`,
            blob: bgBlob,
          });
        }
      }
    }
  }
  return { files, missing };
}

export async function exportDump(): Promise<{ attached: number; missing: string[] }> {
  const { project } = useEditor.getState();
  const serialized = serializeProject(project);
  const { files, missing } = await collectMedia(project);
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(serialized, null, 2));
  for (const f of files) zip.file(f.fileName, f.blob);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${slugify(project.name, 'memeit-dump')}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  if (missing.length > 0) {
    alert(`Dump exported without ${missing.length} missing file(s) (re-link them in Media):\n- ${missing.join('\n- ')}`);
  }
  return { attached: files.length, missing };
}

export async function importDump(file: File): Promise<{ missing: string[] }> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(file);
  const projFile = zip.file('project.json');
  if (!projFile) throw new Error('Not a memeit dump — project.json missing.');
  const parsed = ProjectSchema.safeParse(JSON.parse(await projFile.async('text')));
  if (!parsed.success) throw new Error('Invalid project.json inside dump.');
  // stash every bundled asset into IDB so rehydrateProject can pick it up
  const saves: Promise<void>[] = [];
  zip.forEach((relPath, entry) => {
    if (entry.dir) return;
    if (!relPath.startsWith('assets/') || relPath === 'assets/') return;
    const base = relPath.slice('assets/'.length).split('/').pop() ?? '';
    const dot = base.lastIndexOf('.');
    const assetId = dot > 0 ? base.slice(0, dot) : base;
    if (!assetId) return;
    saves.push(entry.async('blob').then((blob) => saveAsset(assetId, blob)));
  });
  await Promise.all(saves);
  const { project: hydrated, missing } = await rehydrateProject(parsed.data);
  const st = useEditor.getState();
  st.updateProject(() => fitProjectToClips(hydrated));
  st.select(null);
  st.setTime(0);
  if (missing.length > 0) {
    const names = hydrated.clips.filter((c) => missing.includes(c.id)).map((c) => c.name ?? c.id);
    alert(`Dump loaded, but ${missing.length} file(s) are still missing:\n- ${names.join('\n- ')}`);
  }
  return { missing };
}

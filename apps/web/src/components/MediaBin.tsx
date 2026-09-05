import { useRef, useState } from 'react';
import { ProjectSchema, formatSrt, parseSrt } from '@memeit/timeline';
import { useEditor, uid } from '../store';
import { addMediaFiles } from '../lib/media';
import TtsPanel from './TtsPanel';
import { addCaptionPersist, addSubtitleAfterLast, baseTextStyle } from '../lib/captions';

const DOT: Record<string, string> = {
  video: '#5b8cff',
  image: '#9b7ff7',
  text: '#f7b84f',
  audio: '#4fd78a',
};

function IconButton({
  icon,
  title,
  kbd,
  accept,
  multiple,
}: {
  icon: string;
  title: string;
  kbd?: string;
  accept: string;
  multiple?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className="icon-tool" onClick={() => ref.current?.click()} title={kbd ? `${title} (${kbd})` : title}>
        {icon}
      </button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void addMediaFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
}

export default function MediaBin() {
  const project = useEditor((s) => s.project);
  const updateProject = useEditor((s) => s.updateProject);
  const removeClip = useEditor((s) => s.removeClip);
  const select = useEditor((s) => s.select);
  const selectedId = useEditor((s) => s.selectedId);
  const unsupportedIds = useEditor((s) => s.unsupportedIds);
  const srtRef = useRef<HTMLInputElement>(null);
  const jsonRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState(false);

  // (moved to lib/captions.ts so keybindings share the same behavior)
  const addText = addCaptionPersist;

  const importSrt = async (f: File) => {
    const raw = await f.text();
    const cues = parseSrt(raw);
    if (cues.length === 0) {
      alert('No valid SRT cues found.');
      return;
    }
    const st = useEditor.getState();
    const maxEnd = Math.max(...cues.map((c) => c.endMs));
    if (maxEnd > st.project.durationMs) {
      st.updateProject((p) => ({ ...p, durationMs: Math.min(300_000, maxEnd + 1000) }));
    }
    cues.forEach((cue, i) => {
      st.addClip({
        id: uid(),
        kind: 'text',
        text: cue.text,
        startMs: Math.round(cue.startMs),
        durationMs: Math.max(500, Math.round(cue.endMs - cue.startMs)),
        ...baseTextStyle(i % 2 === 1 ? 0.35 : -0.35),
      });
    });
  };

  const exportSrt = () => {
    const cues = project.clips
      .filter((c) => c.kind === 'text')
      .sort((a, b) => a.startMs - b.startMs)
      .map((c) => ({
        startMs: c.kind === 'text' ? c.startMs : 0,
        endMs: c.startMs + c.durationMs,
        text: c.kind === 'text' ? c.text : '',
      }));
    if (cues.length === 0) {
      alert('No text clips to export.');
      return;
    }
    download('memeit-subtitles.srt', formatSrt(cues), 'text/plain');
  };

  const exportJson = async () => {
    const { serializeProject } = await import('../lib/persist');
    download('memeit-project.json', JSON.stringify(serializeProject(project), null, 2), 'application/json');
  };

  const importJson = async (f: File) => {
    try {
      const parsed = ProjectSchema.safeParse(JSON.parse(await f.text()));
      if (!parsed.success) {
        alert('Invalid project JSON.');
        return;
      }
      const { rehydrateProject } = await import('../lib/persist');
      const { project: hydrated, missing } = await rehydrateProject(parsed.data);
      const st = useEditor.getState();
      st.updateProject(() => hydrated);
      st.select(null);
      st.setTime(0);
      if (missing.length > 0) {
        const names = hydrated.clips.filter((c) => missing.includes(c.id)).map((c) => c.name ?? c.id);
        alert(`Project loaded, but ${missing.length} file(s) are missing (re-link them in Media):\n- ${names.join('\n- ')}`);
      }
    } catch {
      alert('Could not read project JSON.');
    }
  };

  return (
    <div>
      {/* tight icon toolbar — window itself is the dropzone */}
      <div className="tool-row">
        <IconButton icon="🎬" title="Add video" accept="video/*" />
        <IconButton icon="🖼" title="Add image" accept="image/*" />
        <IconButton icon="🎵" title="Add audio" accept="audio/*" multiple />
        <button className="icon-tool" onClick={addText} title="New caption at playhead (t)">
          <b>T+</b>
        </button>
        <button className="icon-tool" onClick={addSubtitleAfterLast} title="Next subtitle line (s)">
          <b>S+</b>
        </button>
        <div style={{ position: 'relative', marginLeft: 'auto' }}>
          <button className="icon-tool" onClick={() => setMenu((v) => !v)} title="Subtitles / project files">
            ⋯
          </button>
          {menu && (
            <>
              <div className="menu-scrim" onClick={() => setMenu(false)} />
              <div className="menu">
                <button onClick={() => { setMenu(false); srtRef.current?.click(); }}>⬆ Import SRT</button>
                <button onClick={() => { setMenu(false); exportSrt(); }}>⬇ Export SRT</button>
                <div className="menu-sep" />
                <button onClick={() => { setMenu(false); jsonRef.current?.click(); }}>⬆ Import JSON</button>
                <button onClick={() => { setMenu(false); exportJson(); }}>⬇ Export JSON</button>
              </div>
            </>
          )}
        </div>
      </div>
      <input
        ref={srtRef}
        type="file"
        accept=".srt,text/plain"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importSrt(f);
          e.target.value = '';
        }}
      />
      <input
        ref={jsonRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importJson(f);
          e.target.value = '';
        }}
      />

      <TtsPanel />

      <div className="field" style={{ marginTop: 12 }}>
        <span>Timeline length (s)</span>
        <input
          className="num-input"
          type="number"
          min={1}
          max={300}
          value={project.durationMs / 1000}
          onChange={(e) =>
            updateProject((p) => ({
              ...p,
              durationMs: Math.max(1000, Math.min(300_000, Number(e.target.value) * 1000 || 10000)),
            }))
          }
        />
      </div>

      <div className="clip-list">
        {project.clips.length === 0 && (
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>No clips yet — drop a file anywhere to start.</div>
        )}
        {project.clips
          .slice()
          .sort((a, b) => a.startMs - b.startMs)
          .map((c) => {
            const missing = (c.kind === 'video' || c.kind === 'image' || c.kind === 'audio') && c.src.startsWith('missing:');
            const unsupported = !!unsupportedIds[c.id];
            return (
              <div
                key={c.id}
                className={`clip-row${selectedId === c.id ? ' selected' : ''}${missing ? ' missing' : ''}`}
                onClick={() => select(c.id)}
                style={{ cursor: 'pointer' }}
              >
              <span className="dot" style={{ background: missing || unsupported ? 'var(--danger)' : DOT[c.kind] }} />
              <span className="nm" title={unsupported ? 'This browser cannot decode this file — Render MP4 still includes it' : c.kind === 'text' ? c.text : c.name ?? c.id}>
                {missing ? '⚠️ ' : ''}
                {unsupported && !missing ? '🔇 ' : ''}
                  {c.kind}: {(c.kind === 'text' ? c.text : c.name ?? c.id).slice(0, 28).replace(/\n/g, ' ')}
                  {c.kind === 'text' && (c.keyframes?.length ?? 0) > 0 && (
                    <span className="kf-badge">◆{c.keyframes!.length}</span>
                  )}
                </span>
                <span className="tm">{(c.durationMs / 1000).toFixed(1)}s</span>
                {missing && <RelinkButton clipId={c.id} kind={c.kind} />}
                <button
                  className="icon-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeClip(c.id);
                  }}
                  title="Delete"
                >
                  ✕
                </button>
              </div>
            );
          })}
      </div>
    </div>
  );
}

function RelinkButton({ clipId, kind }: { clipId: string; kind: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const accept = kind === 'video' ? 'video/*' : kind === 'image' ? 'image/*' : 'audio/*';
  return (
    <>
      <button
        className="btn btn-sm"
        title="Pick the file again to re-link this clip"
        onClick={(e) => {
          e.stopPropagation();
          ref.current?.click();
        }}
      >
        Relink
      </button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const { relinkClipFile } = await import('../lib/media');
          const url = await relinkClipFile(clipId, f);
          const st = useEditor.getState();
          st.updateClip(clipId, { src: url, name: f.name } as never);
        }}
      />
    </>
  );
}

function download(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

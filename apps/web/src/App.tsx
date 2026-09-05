import { useEffect, useRef, useState } from 'react';
import Preview from './components/Preview';
import Timeline from './components/Timeline';
import MediaBin from './components/MediaBin';
import Inspector from './components/Inspector';
import CheatSheet from './components/CheatSheet';
import { addMediaFiles } from './lib/media';
import { handleShortcut } from './lib/keys';
import { useEditor } from './store';

export default function App() {
  const [dragging, setDragging] = useState(false);
  const dragCount = useRef(0);

  const resetDrag = () => {
    dragCount.current = 0;
    setDragging(false);
  };

  // Failsafe: window-level reset so overlay can never stick
  useEffect(() => {
    const onWinDrop = () => resetDrag();
    const onDragEnd = () => resetDrag();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') resetDrag();
    };
    // auto-clear after 4s as last resort (e.g. drag cancelled outside window)
    let t: number | undefined;
    if (dragging) {
      t = window.setTimeout(resetDrag, 4000);
    }
    window.addEventListener('drop', onWinDrop);
    window.addEventListener('dragend', onDragEnd);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('drop', onWinDrop);
      window.removeEventListener('dragend', onDragEnd);
      window.removeEventListener('keydown', onKey);
      if (t) window.clearTimeout(t);
    };
  }, [dragging]);

  // Vim-style shortcuts (single listener; typing in inputs is ignored inside)
  const [sheet, setSheet] = useState(false);
  const sheetCtl = useRef({ open: () => setSheet(true), close: () => setSheet(false), toggle: () => setSheet((v) => !v) });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Space scroll prevention + arrows only when handled
      const r = handleShortcut(e, sheetCtl.current);
      if (r === 'sheet') {
        e.preventDefault();
        setSheet((v) => !v);
      } else if (r === true) {
        if (e.code === 'Space' || e.key.startsWith('Arrow')) e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="app"
      onDragEnter={(e) => {
        e.preventDefault();
        if (!e.dataTransfer.types.includes('Files')) return;
        dragCount.current += 1;
        setDragging(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        if (!e.dataTransfer.types.includes('Files')) return;
        dragCount.current = Math.max(0, dragCount.current - 1);
        if (dragCount.current === 0) setDragging(false);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        // Single handler for the whole app — children must NOT stopPropagation
        e.preventDefault();
        resetDrag();
        if (e.dataTransfer.files?.length) void addMediaFiles(e.dataTransfer.files);
      }}
    >
      <header className="topbar">
        <div className="logo">
          <span className="logo-mark">🎭</span> memeit
        </div>
        <span className="topbar-sub">meme video editor · 10s clips, up to 3 min · <kbd>?</kbd> shortcuts</span>
        <div className="topbar-right">
          <button className="btn btn-ghost btn-sm" onClick={() => setSheet((v) => !v)} title="Keyboard shortcuts (?)">⌨</button>
          <TopActions />
        </div>
      </header>
      <div className="main">
        <div className="panel">
          <p className="panel-title">Media</p>
          <MediaBin />
        </div>
        <div className="panel stage">
          <Preview />
        </div>
        <div className="panel">
          <p className="panel-title">Inspector</p>
          <Inspector />
        </div>
      </div>
      <Timeline />
      {sheet && <CheatSheet onClose={() => setSheet(false)} />}
      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <h2>Drop to import</h2>
            <p>Video · Image · Audio — released files go straight to the timeline</p>
          </div>
        </div>
      )}
    </div>
  );
}

function TopActions() {
  const project = useEditor((s) => s.project);
  const [busy, setBusy] = useState<string | null>(null);
  const newProject = async () => {
    if (project.clips.length > 0 && !window.confirm('Start a new project? Unsaved timeline will be replaced (export JSON first if needed).')) return;
    const { createDefaultProject } = await import('@memeit/timeline');
    const st = useEditor.getState();
    st.setPlaying(false);
    st.updateProject(() => createDefaultProject());
    st.select(null);
    st.setTime(0);
  };
  const exportJson = async () => {
    const { serializeProject } = await import('./lib/persist');
    const blob = new Blob([JSON.stringify(serializeProject(project), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'memeit-project.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const render = async () => {
    const { renderProject } = await import('./lib/render');
    setBusy('Starting…');
    try {
      await renderProject((s) => setBusy(s));
      setBusy(null);
    } catch (e) {
      setBusy(null);
      alert(`Render failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <>
      <span className="time">{busy ?? ''}</span>
      <button className="btn btn-ghost btn-sm" onClick={newProject} disabled={!!busy} title="Clear timeline and start fresh">
        New
      </button>
      <button className="btn btn-ghost btn-sm" onClick={exportJson} disabled={!!busy}>
        Export JSON
      </button>
      <button className="btn btn-primary btn-sm" onClick={render} disabled={!!busy}>
        {busy ? '⏳ Rendering…' : '⬇ Render MP4'}
      </button>
    </>
  );
}

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
  const { leftW, rightW, leftOpen, rightOpen, setLeftOpen, setRightOpen, startLeftDrag, startRightDrag } =
    usePanelLayout();

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
      <div className="main main-flex">
        {!leftOpen && (
          <button className="rail" onClick={() => setLeftOpen(true)} title="Show media panel">
            ▸
          </button>
        )}
        {leftOpen && (
          <div className="panel panel-side" style={{ width: leftW }}>
            <div className="panel-head">
              <p className="panel-title">Media</p>
              <button className="icon-btn" onClick={() => setLeftOpen(false)} title="Hide media panel">
                ◂
              </button>
            </div>
            <MediaBin />
          </div>
        )}
        {leftOpen && <div className="resize-handle" onPointerDown={startLeftDrag} title="Drag to resize" />}
        <div className="panel stage panel-center">
          <Preview />
        </div>
        {rightOpen && <div className="resize-handle" onPointerDown={startRightDrag} title="Drag to resize" />}
        {rightOpen && (
          <div className="panel panel-side" style={{ width: rightW }}>
            <div className="panel-head">
              <p className="panel-title">Inspector</p>
              <button className="icon-btn" onClick={() => setRightOpen(false)} title="Hide inspector panel">
                ▸
              </button>
            </div>
            <Inspector />
          </div>
        )}
        {!rightOpen && (
          <button className="rail" onClick={() => setRightOpen(true)} title="Show inspector panel">
            ◂
          </button>
        )}
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

function usePanelLayout() {
  const read = (k: string, fb: number) => {
    try {
      const v = Number(localStorage.getItem(k));
      return Number.isFinite(v) && v > 0 ? v : fb;
    } catch {
      return fb;
    }
  };
  const readOpen = (k: string, fb = true) => {
    try {
      const v = localStorage.getItem(k);
      return v === null ? fb : v === '1';
    } catch {
      return fb;
    }
  };
  const [leftW, setLeftW] = useState(() => Math.min(480, Math.max(220, read('memeit-left-w', 300))));
  const [rightW, setRightW] = useState(() => Math.min(480, Math.max(240, read('memeit-right-w', 320))));
  const [leftOpen, setLeftOpen] = useState(() => readOpen('memeit-left-open', true));
  const [rightOpen, setRightOpen] = useState(() => readOpen('memeit-right-open', true));

  useEffect(() => {
    try {
      localStorage.setItem('memeit-left-w', String(leftW));
      localStorage.setItem('memeit-right-w', String(rightW));
      localStorage.setItem('memeit-left-open', leftOpen ? '1' : '0');
      localStorage.setItem('memeit-right-open', rightOpen ? '1' : '0');
    } catch { /* ignore */ }
  }, [leftW, rightW, leftOpen, rightOpen]);

  const startDrag = (side: 'left' | 'right') => (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === 'left' ? leftW : rightW;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const next = side === 'left' ? startW + dx : startW - dx;
      const clamped = Math.min(480, Math.max(side === 'left' ? 220 : 240, next));
      if (side === 'left') setLeftW(clamped);
      else setRightW(clamped);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return {
    leftW,
    rightW,
    leftOpen,
    rightOpen,
    setLeftOpen,
    setRightOpen,
    startLeftDrag: startDrag('left'),
    startRightDrag: startDrag('right'),
  };
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

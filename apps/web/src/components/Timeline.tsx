import { useMemo, useRef, useState } from 'react';
import type { AnyClip } from '@memeit/timeline';
import { useEditor } from '../store';

const COLORS: Record<string, string> = {
  video: '#5b8cff',
  image: '#9b7ff7',
  text: '#f7b84f',
  audio: '#4fd78a',
};

const KINDS = ['video', 'image', 'text', 'audio'] as const;
type Kind = (typeof KINDS)[number];

type Row = { kind: Kind; label: string; clips: AnyClip[] };

function packRows(clips: AnyClip[]): Row[] {
  const rows: Row[] = [];
  for (const kind of KINDS) {
    const sorted = clips
      .filter((c) => c.kind === kind)
      .sort((a, b) => a.startMs - b.startMs);
    const sub: AnyClip[][] = [];
    for (const clip of sorted) {
      const end = clip.startMs + clip.durationMs;
      let placed = false;
      for (const row of sub) {
        const overlap = row.some((o) => clip.startMs < o.startMs + o.durationMs && end > o.startMs);
        if (!overlap) {
          row.push(clip);
          placed = true;
          break;
        }
      }
      if (!placed) sub.push([clip]);
    }
    if (sub.length === 0) {
      rows.push({ kind, label: cap(kind), clips: [] });
    } else {
      sub.forEach((clipRow, i) => {
        rows.push({
          kind,
          label: sub.length > 1 ? `${cap(kind)} ${i + 1}` : cap(kind),
          clips: clipRow,
        });
      });
    }
  }
  return rows;
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export default function Timeline() {
  const project = useEditor((s) => s.project);
  const currentTimeMs = useEditor((s) => s.currentTimeMs);
  const setTime = useEditor((s) => s.setTime);
  const [zoom, setZoom] = useState(1);

  const pxPerSec = 8 * zoom;
  const totalWidth = Math.max(800, (project.durationMs / 1000) * pxPerSec);
  const rows = useMemo(() => packRows(project.clips), [project.clips]);
  const contentH = 22 + rows.length * 30 + 8;

  const ticks = useMemo(() => {
    const step = zoom > 2 ? 5_000 : zoom > 1 ? 10_000 : 21_000;
    const out: number[] = [];
    for (let t = 0; t <= project.durationMs; t += step) out.push(t);
    return out;
  }, [project.durationMs, zoom]);

  const seekPx = (e: React.MouseEvent<HTMLDivElement>) => {
    // only seek when clicking lane background, clips stopPropagation
    // Use measured scrollWidth — .tl-content has min-width:100% so it can be
    // wider than totalWidth on wide screens; totalWidth alone mis-maps clicks.
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left + el.scrollLeft;
    const w = el.scrollWidth || totalWidth;
    const ratio = Math.max(0, Math.min(1, x / w));
    setTime(ratio * project.durationMs);
  };

  return (
    <div className="timeline">
      <div className="tl-bar">
        <b style={{ fontSize: 12 }}>Timeline</b>
        <span className="time">
          {(currentTimeMs / 1000).toFixed(2)}s / {(project.durationMs / 1000).toFixed(1)}s · {project.clips.length} clips
        </span>
        <div className="zoom">
          <button className="btn btn-sm" onClick={() => setZoom((z) => Math.max(0.5, z / 1.5))}>−</button>
          <span style={{ fontSize: 11 }}>{zoom.toFixed(1)}x</span>
          <button className="btn btn-sm" onClick={() => setZoom((z) => Math.min(8, z * 1.5))}>+</button>
        </div>
        <span className="tl-hint">New text/audio gets its own row · drag to move · edges to resize · double-click to delete</span>
      </div>
      <div className="tl-body">
        <div className="tl-lanes">
          {rows.map((r, i) => (
            <div key={`${r.kind}-${i}`} className="tl-lane-label" title={r.kind}>
              <span className="dot" style={{ background: COLORS[r.kind], width: 7, height: 7 }} />
              {r.label}
            </div>
          ))}
        </div>
        <div className="tl-scroll" onClick={seekPx}>
          <div className="tl-content" style={{ width: totalWidth, height: contentH }}>
            {ticks.map((t) => (
              <div key={t} className="tl-tick" style={{ left: `${(t / project.durationMs) * 100}%` }}>
                {(t / 1000).toFixed(0)}s
              </div>
            ))}
            <div className="playhead" style={{ left: `${(currentTimeMs / project.durationMs) * 100}%` }} />
            {rows.map((r, ri) => (
              <div key={`${r.kind}-${ri}`} className="tl-lane" style={{ top: 22 + ri * 30 }}>
                {r.clips.map((clip) => (
                  <ClipBlock key={clip.id} clip={clip} totalWidth={totalWidth} durationMs={project.durationMs} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ClipBlock({ clip, totalWidth, durationMs }: { clip: AnyClip; totalWidth: number; durationMs: number }) {
  const selectedId = useEditor((s) => s.selectedId);
  const selectedKeyframeId = useEditor((s) => s.selectedKeyframeId);
  const drag = useRef<{ mode: 'move' | 'l' | 'r'; startX: number; origStart: number; origDur: number } | null>(null);

  const msPerPx = (el: HTMLElement) => {
    const dur = useEditor.getState().project.durationMs;
    const scroll = el.closest('.tl-scroll') as HTMLElement | null;
    const w = scroll?.scrollWidth || totalWidth;
    return dur / w;
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const st = useEditor.getState();
    st.select(clip.id);
    st.setPlaying(false);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const edge = 10;
    const mode = e.clientX - rect.left < edge ? 'l' : rect.right - e.clientX < edge ? 'r' : 'move';
    drag.current = { mode, startX: e.clientX, origStart: clip.startMs, origDur: clip.durationMs };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    e.stopPropagation();
    const st = useEditor.getState();
    const dxMs = (e.clientX - drag.current.startX) * msPerPx(e.currentTarget as HTMLElement);
    const projDur = st.project.durationMs;
    const { mode, origStart, origDur } = drag.current;
    const MIN = 200;

    if (mode === 'move') {
      const ns = Math.max(0, Math.min(projDur - origDur, origStart + dxMs));
      st.updateClip(clip.id, { startMs: Math.round(ns) } as never);
    } else if (mode === 'r') {
      const nd = Math.max(MIN, Math.min(projDur - origStart, origDur + dxMs));
      st.updateClip(clip.id, { durationMs: Math.round(nd) } as never);
    } else {
      const ns = Math.max(0, Math.min(origStart + origDur - MIN, origStart + dxMs));
      const nd = origDur - (ns - origStart);
      st.updateClip(clip.id, { startMs: Math.round(ns), durationMs: Math.round(nd) } as never);
    }
  };

  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    drag.current = null;
  };

  return (
    <div
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={() => useEditor.getState().removeClip(clip.id)}
      title={`${clip.kind} — drag to move, drag edges to resize, double-click to delete`}
      className={`tl-clip${selectedId === clip.id ? ' selected' : ''}`}
      style={{
        left: `${(clip.startMs / durationMs) * 100}%`,
        width: `${Math.max(3, (clip.durationMs / durationMs) * 100)}%`,
        background: COLORS[clip.kind],
        touchAction: 'none',
      }}
    >
      <span className="tl-handle tl-handle-l" />
      <span className="tl-clip-label">
        {clip.kind === 'text' ? clip.text : clip.name ?? clip.id}
      </span>
      <span className="tl-handle tl-handle-r" />
      {clip.kind === 'text' &&
        (clip.keyframes ?? []).map((k) => {
          const abs = clip.startMs + k.offsetMs;
          const leftPct = clip.durationMs > 0 ? (k.offsetMs / clip.durationMs) * 100 : 0;
          return (
            <span
              key={k.id}
              title={`keyframe @${(abs / 1000).toFixed(2)}s — click to jump`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const st = useEditor.getState();
                st.select(clip.id);
                st.selectKeyframe(k.id);
                st.setTime(abs);
              }}
              className={`kf-diamond${selectedKeyframeId === k.id ? ' selected' : ''}`}
              style={{ left: `${leftPct}%` }}
            />
          );
        })}
    </div>
  );
}

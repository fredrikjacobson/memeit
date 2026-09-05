import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnyClip } from '@memeit/timeline';
import { useEditor } from '../store';
import { slicePeaks, useWaveform } from '../lib/waveform';
import { Button } from './ui/button';
import { RotateCcw } from 'lucide-react';

const COLORS: Record<string, string> = {
  video: 'var(--chart-2)',
  image: 'var(--chart-4)',
  text: 'var(--chart-1)',
  audio: 'var(--chart-3)',
};

const TEXT_ON: Record<string, string> = {
  video: 'var(--foreground)',
  image: 'var(--foreground)',
  text: 'var(--background)',
  audio: 'var(--background)',
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
      // Collapse empty lanes to save vertical space — always keep video as drop hint.
      if (kind !== 'video') continue;
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
  // While a clip is being dragged/resized, freeze the lane layout captured at
  // grab time: the dragged clip stays pinned to its origin sub-row (so
  // horizontal moves reorder in time instead of jumping lanes), and all other
  // clips stay exactly where they were (otherwise excluding the dragged clip
  // lets overlapping neighbours collapse into fewer rows — the lane you
  // grabbed visibly collapses the moment the drag starts).
  const [dragging, setDragging] = useState<{
    id: string;
    kind: Kind;
    sub: number;
    layout: Record<string, { kind: Kind; sub: number }>;
  } | null>(null);

  const fullRows = useMemo(() => packRows(project.clips), [project.clips]);
  const rows = useMemo(() => {
    if (!dragging) return fullRows;
    // Skeleton: one lane per sub-row seen at grab time (never fewer).
    // Start empty (except video) so collapsed empty lanes stay collapsed mid-drag.
    const counts: Record<Kind, number> = { video: 1, image: 0, text: 0, audio: 0 };
    for (const slot of Object.values(dragging.layout)) {
      counts[slot.kind] = Math.max(counts[slot.kind], slot.sub + 1);
    }
    const next: Row[] = [];
    const flatIdx: Record<Kind, number[]> = { video: [], image: [], text: [], audio: [] };
    const relabel = (kind: Kind) => {
      // numbered iff >1 lane (matches packRows)
      const n = counts[kind]!;
      flatIdx[kind]!.forEach((fi, i) => {
        next[fi]!.label = n > 1 ? `${cap(kind)} ${i + 1}` : cap(kind);
      });
    };
    const ensure = (kind: Kind, sub: number) => {
      while (flatIdx[kind]!.length <= sub) {
        flatIdx[kind]!.push(next.length);
        next.push({ kind, label: '', clips: [] });
        counts[kind]! += 1;
      }
      relabel(kind);
    };
    for (const kind of KINDS) {
      if (counts[kind]! > 0) ensure(kind, counts[kind]! - 1);
    }
    const place = (clip: AnyClip, kind: Kind, sub: number) => {
      ensure(kind, sub);
      next[flatIdx[kind]![sub]!]!.clips.push(clip);
    };
    for (const clip of project.clips) {
      if (clip.id === dragging.id) {
        place(clip, dragging.kind, dragging.sub);
      } else {
        const slot = dragging.layout[clip.id];
        if (slot) {
          place(clip, slot.kind, slot.sub);
        } else {
          // Clip added mid-drag: first fit within its kind's lanes.
          const k = clip.kind as Kind;
          const end = clip.startMs + clip.durationMs;
          let s = 0;
          for (; s < counts[k]!; s++) {
            const row = next[flatIdx[k]![s]!]!;
            if (!row.clips.some((o) => clip.startMs < o.startMs + o.durationMs && end > o.startMs)) break;
          }
          place(clip, k, s);
        }
      }
    }
    return next;
  }, [fullRows, dragging, project.clips]);

  const beginDrag = (info: { id: string; kind: Kind; sub: number }) => {
    // Snapshot the pre-drag lane assignment so nothing moves vertically.
    const layout: Record<string, { kind: Kind; sub: number }> = {};
    const counters: Record<string, number> = {};
    rows.forEach((r) => {
      const s = counters[r.kind] ?? 0;
      counters[r.kind] = s + 1;
      r.clips.forEach((c) => {
        layout[c.id] = { kind: r.kind, sub: s };
      });
    });
    const own = layout[info.id] ?? { kind: info.kind, sub: info.sub };
    setDragging({ id: info.id, kind: own.kind, sub: own.sub, layout });
  };

  const pxPerSec = 8 * zoom;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportW, setViewportW] = useState(800);

  // Track the scroll viewport width so content can be sized exactly to it —
  // a fixed min-width floor or stale measurement leaves a residual scrollbar.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportW(el.clientWidth || 800);
    const ro = new ResizeObserver(() => setViewportW(el.clientWidth || 800));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Never narrower than the viewport (minus a 2px epsilon for subpixel
  // rounding, which otherwise brings back a tiny scrollbar right after fit).
  const totalWidth = Math.max(viewportW - 2, (project.durationMs / 1000) * pxPerSec);
  const contentH = 22 + rows.length * 30 + 8;

  const fitZoom = () => {
    const w = (scrollRef.current?.clientWidth || viewportW || 800) - 2;
    const durSec = project.durationMs / 1000;
    if (durSec > 0) setZoom(Math.max(0.1, Math.min(8, w / (durSec * 8))));
  };

  const ticks = useMemo(() => {
    const step = zoom > 2 ? 5_000 : zoom > 1 ? 10_000 : 21_000;
    const out: number[] = [];
    for (let t = 0; t <= project.durationMs; t += step) out.push(t);
    return out;
  }, [project.durationMs, zoom]);

  const seekPx = (e: React.MouseEvent<HTMLDivElement>) => {
    // only seek when clicking lane background, clips stopPropagation
    // Map through the content box itself — clips/ticks/playhead are all
    // positioned as % of .tl-content, so its measured width is the exact
    // scale (scrollWidth can over-report due to borders/scrollbars, which
    // made seeks land short).
    const content = e.currentTarget.querySelector('.tl-content') as HTMLElement | null;
    const rect = (content ?? e.currentTarget).getBoundingClientRect();
    const w = rect.width || 1;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / w));
    setTime(ratio * project.durationMs);
  };

  return (
    <div className="border-t border-border bg-card px-4 pb-3 pt-2.5">
      <div className="mb-2 flex flex-wrap items-center gap-2.5">
        <b className="text-xs">Timeline</b>
        <span className="text-xs tabular-nums text-muted-foreground">
          {(currentTimeMs / 1000).toFixed(2)}s / {(project.durationMs / 1000).toFixed(1)}s · {project.clips.length} clips
        </span>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setZoom((z) => Math.max(0.1, z / 1.5))}>−</Button>
          <span className="text-[11px] tabular-nums">{zoom.toFixed(1)}x</span>
          <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setZoom((z) => Math.min(8, z * 1.5))}>+</Button>
          <Button size="sm" variant="outline" className="h-7 px-2" onClick={fitZoom} title="Reset zoom to fit whole timeline"><RotateCcw className="size-3.5" /></Button>
        </div>
        <span className="ml-auto text-[11px] text-muted-foreground">New text/audio gets its own row · drag to move · edges to resize (audio fixed length) · double-click to delete</span>
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: '76px 1fr' }}>
        <div className="flex flex-col overflow-hidden pt-[22px]">
          {rows.map((r, i) => (
            <div key={`${r.kind}-${i}`} className="flex h-[30px] items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] font-bold text-muted-foreground" title={r.kind}>
              <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: COLORS[r.kind] }} />
              {r.label}
            </div>
          ))}
        </div>
        <div className="tl-scroll" ref={scrollRef} onClick={seekPx}>
          <div className="tl-content" style={{ width: totalWidth, height: contentH }}>
            {ticks.map((t) => (
              <div key={t} className="tl-tick" style={{ left: `${(t / project.durationMs) * 100}%` }}>
                {(t / 1000).toFixed(0)}s
              </div>
            ))}
            <div className="playhead" style={{ left: `${(currentTimeMs / project.durationMs) * 100}%` }} />
            {rows.map((r, ri) => {
              // sub-row index within this kind (stable origin for pinning during drag)
              let sub = 0;
              for (let i = 0; i < ri; i++) if (rows[i]!.kind === r.kind) sub++;
              return (
                <div key={`${r.kind}-${ri}`} className="tl-lane" style={{ top: 22 + ri * 30 }}>
                  {r.clips.map((clip) => (
                    <ClipBlock
                      key={clip.id}
                      clip={clip}
                      totalWidth={totalWidth}
                      durationMs={project.durationMs}
                      kind={r.kind as Kind}
                      sub={sub}
                      active={dragging?.id === clip.id}
                      onDragStart={beginDrag}
                      onDragEnd={() => setDragging(null)}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function ClipBlock({
  clip,
  totalWidth,
  durationMs,
  kind,
  sub,
  active,
  onDragStart,
  onDragEnd,
}: {
  clip: AnyClip;
  totalWidth: number;
  durationMs: number;
  kind: Kind;
  sub: number;
  active: boolean;
  onDragStart: (info: { id: string; kind: Kind; sub: number }) => void;
  onDragEnd: () => void;
}) {
  const selectedId = useEditor((s) => s.selectedId);
  const selectedKeyframeId = useEditor((s) => s.selectedKeyframeId);

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const st = useEditor.getState();
    st.select(clip.id);
    st.setPlaying(false);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const edge = 10;
    // Audio clips have fixed length tied to the source file — disable edge resize.
    const resizable = clip.kind !== 'audio';
    const mode = !resizable ? 'move' : e.clientX - rect.left < edge ? 'l' : rect.right - e.clientX < edge ? 'r' : 'move';
    const startX = e.clientX;
    const origStart = clip.startMs;
    const origDur = clip.durationMs;
    const clipId = clip.id;
    onDragStart({ id: clip.id, kind, sub });
    // Window-level move/up so the drag survives the pinned-row remount
    // (setting `dragging` re-parents this element, invalidating element
    // handlers + pointer capture — so ALL move/up handling lives here).
    // NOTE: do NOT setPointerCapture and do NOT stopPropagation on up,
    // otherwise the window pointerup never fires and listeners leak
    // (clip keeps following the mouse).
    const msPerPxWin = () => {
      // Clips are positioned as % of .tl-content, so its measured box is the
      // exact scale. scrollWidth over-reports (borders, scrollbar, subpixel),
      // which shrank ms-per-px and made clips lag behind the cursor.
      const dur = useEditor.getState().project.durationMs;
      const content = document.querySelector('.tl-content') as HTMLElement | null;
      const w = content?.getBoundingClientRect().width || 0;
      if (w > 0) return dur / w;
      const scroll = document.querySelector('.tl-scroll') as HTMLElement | null;
      return dur / (scroll?.scrollWidth || totalWidth);
    };
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      window.removeEventListener('pointermove', onWinMove);
      window.removeEventListener('pointerup', onWinUp);
      window.removeEventListener('pointercancel', onWinUp);
      onDragEnd();
    };
    const onWinMove = (ev: PointerEvent) => {
      const dxMs = (ev.clientX - startX) * msPerPxWin();
      const s = useEditor.getState();
      const projDur = s.project.durationMs;
      const MIN = 200;
      if (mode === 'move') {
        const ns = Math.max(0, Math.min(projDur - origDur, origStart + dxMs));
        s.updateClip(clipId, { startMs: Math.round(ns) } as never);
      } else if (mode === 'r') {
        const nd = Math.max(MIN, Math.min(projDur - origStart, origDur + dxMs));
        s.updateClip(clipId, { durationMs: Math.round(nd) } as never);
      } else {
        const ns = Math.max(0, Math.min(origStart + origDur - MIN, origStart + dxMs));
        const nd = origDur - (ns - origStart);
        s.updateClip(clipId, { startMs: Math.round(ns), durationMs: Math.round(nd) } as never);
      }
    };
    const onWinUp = () => cleanup();
    window.addEventListener('pointermove', onWinMove);
    window.addEventListener('pointerup', onWinUp);
    window.addEventListener('pointercancel', onWinUp);
  };

  return (
    <div
      onPointerDown={onDown}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={() => useEditor.getState().removeClip(clip.id)}
      title={`${clip.kind === 'text' ? clip.text : clip.name ?? clip.id} · ${(clip.startMs / 1000).toFixed(1)}s → ${((clip.startMs + clip.durationMs) / 1000).toFixed(1)}s — drag to move${clip.kind === 'audio' ? ' (fixed length)' : ', edges to resize'}, double-click to delete`}
      className={`tl-clip${selectedId === clip.id ? ' selected' : ''}`}
      style={{
        left: `${(clip.startMs / durationMs) * 100}%`,
        width: `${Math.max(3, (clip.durationMs / durationMs) * 100)}%`,
        background: COLORS[clip.kind],
        color: TEXT_ON[clip.kind] ?? 'var(--foreground)',
        touchAction: 'none',
        zIndex: active ? 5 : undefined,
        opacity: active ? 0.92 : undefined,
      }}
    >
      {(clip.kind === 'audio' || clip.kind === 'video') && (
        <ClipWaveform
          src={clip.src}
          srcOffsetMs={clip.kind === 'audio' || clip.kind === 'video' ? (clip.srcOffsetMs ?? 0) : 0}
          durationMs={clip.durationMs}
          dark={clip.kind === 'audio'}
        />
      )}
      <span className="tl-clip-label">
        {clip.kind === 'text' ? clip.text : clip.name ?? clip.id}
      </span>
      {clip.kind !== 'audio' && (
        <>
          <span className="tl-handle tl-handle-l" />
          <span className="tl-handle tl-handle-r" />
        </>
      )}
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

function ClipWaveform({
  src,
  srcOffsetMs,
  durationMs,
  dark,
}: {
  src: string;
  srcOffsetMs: number;
  durationMs: number;
  dark: boolean;
}) {
  const data = useWaveform(src);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !data) return;
    let raf = 0;
    const draw = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // Match the backing store to the displayed size so no CSS
        // upscaling blurs the bars (the old fixed 400px canvas stretched
        // blurry on wide clips).
        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;
        if (!cw || !ch) return;
        const dpr = window.devicePixelRatio || 1;
        const W = Math.max(1, Math.round(cw * dpr));
        const H = Math.max(1, Math.round(ch * dpr));
        if (canvas.width !== W || canvas.height !== H) {
          canvas.width = W;
          canvas.height = H;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const peaks = slicePeaks(data, srcOffsetMs, durationMs);
        ctx.clearRect(0, 0, W, H);
        if (peaks.length === 0) return;
        ctx.fillStyle = dark ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.65)';
        const n = peaks.length;
        const mid = H / 2;
        const maxH = H - 2 * dpr;
        for (let x = 0; x < W; x++) {
          // Max over the peaks landing on this device pixel: proper
          // downsampling when zoomed out, no aliasing gaps when zoomed in.
          const lo = Math.floor((x / W) * n);
          const hi = Math.max(lo + 1, Math.ceil(((x + 1) / W) * n));
          let p = 0;
          for (let i = lo; i < hi && i < n; i++) {
            const v = peaks[i] ?? 0;
            if (v > p) p = v;
          }
          if (p < 0.06) p = 0.06;
          const h = Math.max(dpr, p * maxH);
          const y = Math.round(mid - h / 2);
          ctx.fillRect(x, y, 1, Math.max(1, Math.round(h)));
        }
      });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [data, srcOffsetMs, durationMs, dark]);

  if (!data) return null;
  return <canvas ref={ref} className="tl-wave" aria-hidden />;
}

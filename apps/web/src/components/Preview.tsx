import { useEffect, useRef, type CSSProperties } from 'react';
import { evalTextAt, isClipActiveAt, nearestKeyframe, uid, type TextClip } from '@memeit/timeline';
import { useEditor } from '../store';
import { Button } from './ui/button';
import { Slider } from './ui/slider';

export default function Preview() {
  const project = useEditor((s) => s.project);
  const currentTimeMs = useEditor((s) => s.currentTimeMs);
  const playing = useEditor((s) => s.playing);
  const setTime = useEditor((s) => s.setTime);
  const setPlaying = useEditor((s) => s.setPlaying);
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const lastTick = useRef<number>(0);

  const videoClips = project.clips.filter((c) => c.kind === 'video');
  const activeVideo = videoClips.find((c) => isClipActiveAt(c, currentTimeMs)) ?? videoClips[0];
  const activeTexts = project.clips.filter((c) => c.kind === 'text' && isClipActiveAt(c, currentTimeMs));
  const activeImages = project.clips.filter((c) => c.kind === 'image' && isClipActiveAt(c, currentTimeMs));
  const audioClips = project.clips.filter((c) => c.kind === 'audio');
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());

  // keep video volume in sync (video carries its own sound + extra audio tracks mix)
  useEffect(() => {
    if (videoRef.current && activeVideo && activeVideo.kind === 'video') {
      videoRef.current.volume = Math.max(0, Math.min(1, activeVideo.volume));
    }
  }, [activeVideo]);

  // audio mixer: sync all audio tracks to playhead
  useEffect(() => {
    for (const clip of audioClips) {
      if (clip.kind !== 'audio') continue;
      const el = audioRefs.current.get(clip.id);
      if (!el) continue;
      el.volume = Math.max(0, Math.min(1, clip.volume));
      const active = isClipActiveAt(clip, currentTimeMs);
      const localSec = Math.max(0, ((clip.srcOffsetMs ?? 0) + currentTimeMs - clip.startMs) / 1000);
      if (playing && active) {
        if (Math.abs(el.currentTime - localSec) > 0.35) {
          try {
            el.currentTime = Math.min(localSec, (el.duration || localSec + 1) - 0.05);
          } catch { /* ignore seek errors before metadata */ }
        }
        if (el.paused) el.play().catch(() => {});
      } else {
        if (!el.paused) el.pause();
        // keep paused position in sync for scrubbing
        if (!playing && active && Math.abs(el.currentTime - localSec) > 0.15) {
          try {
            el.currentTime = Math.min(localSec, (el.duration || localSec + 1) - 0.05);
          } catch { /* ignore */ }
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, currentTimeMs, project]);

  useEffect(() => {
    if (!playing) {
      cancelAnimationFrame(rafRef.current);
      videoRef.current?.pause();
      for (const el of audioRefs.current.values()) el.pause();
      return;
    }
    lastTick.current = performance.now();
    const loop = (now: number) => {
      const dt = now - lastTick.current;
      lastTick.current = now;
      const next = useEditor.getState().currentTimeMs + dt;
      if (next >= project.durationMs) {
        setTime(project.durationMs);
        setPlaying(false);
        videoRef.current?.pause();
        for (const el of audioRefs.current.values()) el.pause();
        return;
      }
      setTime(next);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    if (videoRef.current && activeVideo) {
      const off = activeVideo.kind === 'video' ? (activeVideo.srcOffsetMs ?? 0) : 0;
      const localSec = Math.max(0, (off + useEditor.getState().currentTimeMs - activeVideo.startMs) / 1000);
      if (Math.abs(videoRef.current.currentTime - localSec) > 0.35) {
        try {
          videoRef.current.currentTime = localSec;
        } catch { /* ignore */ }
      }
    }
    videoRef.current?.play().catch(() => {});
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, project.durationMs, setTime, setPlaying]);

  useEffect(() => {
    if (!playing && videoRef.current && activeVideo) {
      const off = activeVideo.kind === 'video' ? (activeVideo.srcOffsetMs ?? 0) : 0;
      const localSec = (off + currentTimeMs - activeVideo.startMs) / 1000;
      if (Number.isFinite(localSec) && localSec >= 0) {
        const v = videoRef.current;
        if (Math.abs(v.currentTime - localSec) > 0.15) v.currentTime = Math.max(0, localSec);
      }
    }
  }, [currentTimeMs, playing, activeVideo]);

  const videoMissing = !!activeVideo && activeVideo.kind === 'video' && activeVideo.src.startsWith('missing:');

  const aspect = `${project.width} / ${project.height}`;
  const ratioW = project.width / Math.max(1, project.height);
  const ratioH = project.height / Math.max(1, project.width);

  const step = (dir: 1 | -1) => {
    const fps = project.fps || 30;
    setPlaying(false);
    setTime(currentTimeMs + (dir * 1000) / fps);
  };

  return (
    <div className="flex h-full w-full flex-col items-center gap-2.5 overflow-auto" style={{ width: '100%', height: '100%' }}>
      <div className="flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden" style={{ containerType: 'size' } as CSSProperties}>
      <div
        ref={frameRef}
        className="relative m-auto max-h-full max-w-full overflow-hidden rounded-[14px] border border-border bg-black shadow-2xl"
        style={{
          aspectRatio: aspect,
          width: `min(100%, calc(100cqh * ${ratioW}))`,
          height: `min(100%, calc(100cqw * ${ratioH}))`,
          maxWidth: '100%',
          maxHeight: '100%',
          margin: 'auto',
        }}
      >
        {activeVideo && activeVideo.kind === 'video' && !videoMissing ? (
          <video
            ref={videoRef}
            src={activeVideo.src}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            playsInline
            onError={() => useEditor.getState().markUnsupported(activeVideo.id)}
          />
        ) : videoMissing ? (
          <div
            style={{
              width: '100%', height: '100%', display: 'grid', placeItems: 'center',
              color: 'var(--destructive)', padding: 24, textAlign: 'center', background: 'var(--muted)',
            }}
          >
            <div>
              <div style={{ fontSize: 28, marginBottom: 8 }}>⚠️</div>
              Video file missing — relink it in Media.
              <br />
              <span style={{ fontSize: 12 }}>{activeVideo.kind === 'video' ? activeVideo.name ?? '' : ''}</span>
            </div>
          </div>
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'grid',
              placeItems: 'center',
              color: 'var(--muted-foreground)',
              padding: 24,
              textAlign: 'center',
              background: 'repeating-linear-gradient(45deg,var(--muted),var(--muted) 12px,var(--card) 12px,var(--card) 24px)',
            }}
          >
            <div>
              <div style={{ fontSize: 28, marginBottom: 8 }}>🎬</div>
              Drop a video anywhere
              <br />
              <span style={{ fontSize: 12 }}>or use Media → choose file</span>
            </div>
          </div>
        )}
        {activeImages.map((c) =>
          c.kind === 'image' && !c.src.startsWith('missing:') ? (
            <img
              key={c.id}
              src={c.src}
              onError={() => useEditor.getState().markUnsupported(c.id)}
              style={{
                position: 'absolute',
                left: `${50 + c.x * 100}%`,
                top: `${50 + c.y * 100}%`,
                transform: 'translate(-50%,-50%)',
                maxWidth: `${c.scale * 60}%`,
                borderRadius: 6,
              }}
            />
          ) : null
        )}
        {activeTexts.map((c) =>
          c.kind === 'text' ? <DraggableText key={c.id} clip={c} frameRef={frameRef} /> : null
        )}
      </div>
      </div>
      {/* hidden audio tracks — synced to playhead in mixer effect above */}
      {audioClips.map((c) =>
        c.kind === 'audio' && !c.src.startsWith('missing:') ? (
          <audio
            key={c.id}
            ref={(el) => {
              if (el) audioRefs.current.set(c.id, el);
              else audioRefs.current.delete(c.id);
            }}
            src={c.src}
            preload="auto"
            onError={() => useEditor.getState().markUnsupported(c.id)}
          />
        ) : null
      )}
      <div className="flex w-full max-w-[560px] items-center gap-2.5 rounded-full border border-border bg-card px-3.5 py-1.5">
        <Button size="icon" className="h-8 w-8 shrink-0 rounded-full bg-foreground text-background hover:bg-foreground/90" onClick={() => setPlaying(!playing)} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
          {playing ? '❚❚' : '▶'}
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => step(-1)} title="Step back 1 frame (h / ←)">
          ⏮
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => step(1)} title="Step forward 1 frame (l / →)">
          ⏭
        </Button>
        <Slider
          className="min-w-[80px] flex-1"
          min={0}
          max={project.durationMs}
          step={1}
          value={[currentTimeMs]}
          onValueChange={([v]) => setTime(v ?? 0)}
        />
        <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
          {(currentTimeMs / 1000).toFixed(2)}s / {(project.durationMs / 1000).toFixed(1)}s
        </span>
      </div>
      <div className="text-[11px] text-muted-foreground">
        Drag text on canvas to move · auto-creates keyframe when moved off start
      </div>
    </div>
  );
}

function DraggableText({ clip, frameRef }: { clip: TextClip; frameRef: React.RefObject<HTMLDivElement> }) {
  const currentTimeMs = useEditor((s) => s.currentTimeMs);
  const selectedId = useEditor((s) => s.selectedId);
  const selectedKeyframeId = useEditor((s) => s.selectedKeyframeId);
  const drag = useRef<{ startX: number; startY: number; origX: number; origY: number; kfId: string | null; isNew: boolean } | null>(null);

  const t = evalTextAt(clip, currentTimeMs);
  const isSel = selectedId === clip.id;
  const nearKf = nearestKeyframe(clip, currentTimeMs, 200);

  const commit = (nx: number, ny: number) => {
    const st = useEditor.getState();
    const cx = Math.max(-0.6, Math.min(0.6, nx));
    const cy = Math.max(-0.6, Math.min(0.6, ny));
    const offset = Math.max(0, Math.round(currentTimeMs - clip.startMs));

    // dragging near start → move base position
    if (offset < 200) {
      st.updateClip(clip.id, { x: cx, y: cy });
      return { kfId: null as string | null, isNew: false };
    }
    const existing = nearestKeyframe(clip, currentTimeMs, 250);
    if (existing) {
      const kfs = (clip.keyframes ?? []).map((k) => (k.id === existing.id ? { ...k, x: cx, y: cy } : k));
      st.updateClip(clip.id, { keyframes: kfs } as never);
      return { kfId: existing.id, isNew: false };
    }
    if (st.autoKey) {
      const id = uid();
      const kfs = [...(clip.keyframes ?? []), { id, offsetMs: offset, x: cx, y: cy, fontSize: t.fontSize }];
      st.updateClip(clip.id, { keyframes: kfs } as never);
      st.selectKeyframe(id);
      return { kfId: id, isNew: true };
    }
    st.updateClip(clip.id, { x: cx, y: cy });
    return { kfId: null, isNew: false };
  };

  return (
    <div
      onPointerDown={(e) => {
        e.stopPropagation();
        const st = useEditor.getState();
        st.select(clip.id);
        if (nearKf) st.selectKeyframe(nearKf.id);
        st.setPlaying(false);
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        drag.current = { startX: e.clientX, startY: e.clientY, origX: t.x, origY: t.y, kfId: nearKf?.id ?? null, isNew: false };
      }}
      onPointerMove={(e) => {
        if (!drag.current || !frameRef.current) return;
        const rect = frameRef.current.getBoundingClientRect();
        const dx = (e.clientX - drag.current.startX) / rect.width;
        const dy = (e.clientY - drag.current.startY) / rect.height;
        const r = commit(drag.current.origX + dx, drag.current.origY + dy);
        drag.current.kfId = r.kfId;
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      title="Drag to move — creates keyframe"
      style={{
        position: 'absolute',
        left: `${50 + t.x * 100}%`,
        top: `${50 + t.y * 100}%`,
        transform: 'translate(-50%,-50%)',
        fontFamily: `${clip.font}, Impact, sans-serif`,
        fontSize: Math.max(15, t.fontSize * 0.38),
        fontWeight: 900,
        color: clip.color,
        WebkitTextStroke: `${clip.strokeWidth * 0.38}px ${clip.strokeColor}`,
        paintOrder: 'stroke fill',
        textAlign: 'center',
        width: '92%',
        lineHeight: 1.05,
        textTransform: 'uppercase',
        whiteSpace: 'pre-line',
        cursor: 'move',
        userSelect: 'none',
        touchAction: 'none',
        outline: isSel ? '2px dashed var(--ring)' : 'none',
        outlineOffset: 4,
        borderRadius: 4,
      }}
    >
      {clip.text}
      {nearKf && selectedKeyframeId === nearKf.id && (
        <span style={{ fontSize: 10, display: 'block', WebkitTextStroke: '0', textTransform: 'none', color: 'var(--ring)' }}>
          ◆ keyframe @{(nearKf.offsetMs / 1000).toFixed(2)}s
        </span>
      )}
    </div>
  );
}

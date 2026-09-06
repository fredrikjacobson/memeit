import { useEffect, useRef, type CSSProperties } from 'react';
import { bgImageIds, evalImageAt, evalTextAt, isClipActiveAt, nearestKeyframe, uid, type ImageClip, type TextClip } from '@memeit/timeline';
import { useEditor } from '../store';
import { aiDisplaySrc, useBgAi } from '../lib/bgai';
import { Button } from './ui/button';
import { Slider } from './ui/slider';

export default function Preview() {
  const project = useEditor((s) => s.project);
  const currentTimeMs = useEditor((s) => s.currentTimeMs);
  const playing = useEditor((s) => s.playing);
  const setTime = useEditor((s) => s.setTime);
  const setPlaying = useEditor((s) => s.setPlaying);
  const selectedId = useEditor((s) => s.selectedId);
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const lastTick = useRef<number>(0);

  const videoClips = project.clips.filter((c) => c.kind === 'video');
  const activeVideo = videoClips.find((c) => isClipActiveAt(c, currentTimeMs)) ?? videoClips[0];
  const activeTexts = project.clips.filter((c) => c.kind === 'text' && isClipActiveAt(c, currentTimeMs));
  // images picked as this video's replacement backgrounds live behind the video
  // (export consumes them as [bg]) — don't also draw them as foreground overlays
  const activeBgImageIds =
    activeVideo && activeVideo.kind === 'video' &&
    (activeVideo.bgRemove ?? 'off') !== 'off' &&
    (activeVideo.bgReplace ?? 'black') === 'image'
      ? bgImageIds(activeVideo)
      : [];
  // AI cutout ready? swap the video src for the processed transparent WebM
  const activeVideoSrc =
    activeVideo && activeVideo.kind === 'video'
      ? (aiDisplaySrc(activeVideo) ?? activeVideo.src)
      : null;
  const activeAiJob = useBgAi((s) => (activeVideo ? s.jobs[activeVideo.id] : undefined));
  const activeAiRunning =
    !!activeAiJob && (activeAiJob.phase === 'loading' || activeAiJob.phase === 'processing' || activeAiJob.phase === 'encoding');
  const activeImages = project.clips.filter(
    (c) => c.kind === 'image' && isClipActiveAt(c, currentTimeMs) && !activeBgImageIds.includes(c.id)
  );
  // sizing mode: selected image is some chroma video's replacement background —
  // solo it fullscreen (video hidden) so Size/Position sliders visibly affect it
  const selectedClip = project.clips.find((c) => c.id === selectedId);
  const sizingBg =
    selectedClip && selectedClip.kind === 'image' && !selectedClip.src.startsWith('missing:') &&
    project.clips.some(
      (c) =>
        c.kind === 'video' &&
        (c.bgRemove ?? 'off') !== 'off' &&
        (c.bgReplace ?? 'black') === 'image' &&
        bgImageIds(c).includes(selectedClip.id)
    )
      ? selectedClip
      : null;
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
        {sizingBg && sizingBg.kind === 'image' ? (
          <>
            <DraggableImage clip={sizingBg} frameRef={frameRef} cover />
            <div
              style={{
                position: 'absolute', top: 8, left: 8, fontSize: 11,
                background: 'var(--accent)', color: 'var(--accent-foreground)',
                padding: '2px 8px', borderRadius: 999,
              }}
              title="Video hidden while you size its replacement background"
            >
              🖼 sizing background — video hidden · drag to move
            </div>
          </>
        ) : activeVideo && activeVideo.kind === 'video' && !videoMissing ? (
          <>
            <PreviewBackdrop videoId={activeVideo.id} />
            <video
              ref={videoRef}
              key={activeVideoSrc}
              src={activeVideoSrc ?? activeVideo.src}
              style={{
                position: 'absolute',
                left: `${50 + (activeVideo.x ?? 0) * 100}%`,
                top: `${50 + (activeVideo.y ?? 0) * 100}%`,
                transform: 'translate(-50%,-50%)',
                width: '100%',
                height: '100%',
                objectFit: (activeVideo.fit ?? 'cover') === 'contain' ? 'contain' : (activeVideo.fit ?? 'cover') === 'stretch' ? 'fill' : 'cover',
                display: 'block',
                background: 'transparent',
              }}
              playsInline
              onError={() => useEditor.getState().markUnsupported(activeVideo.id)}
            />
            {(activeVideo.bgRemove ?? 'off') !== 'off' && (
              <div
                style={{
                  position: 'absolute', top: 8, left: 8, fontSize: 11,
                  background: 'var(--accent)', color: 'var(--accent-foreground)',
                  padding: '2px 8px', borderRadius: 999,
                }}
                title={
                  (activeVideo.bgRemove ?? 'off') === 'ai'
                    ? 'On-device AI cutout'
                    : 'Chroma-key applies on export — backdrop ghosted at 50% so you can see it; drag the ghost to track'
                }
              >
                {(activeVideo.bgRemove ?? 'off') === 'ai'
                  ? (aiDisplaySrc(activeVideo)
                    ? `✨ AI cutout${activeVideo.bgReplace === 'image' ? ' → image' : activeVideo.bgReplace === 'color' ? ` → ${activeVideo.bgColor ?? '#000000'}` : ''}`
                    : activeAiRunning
                      ? `✨ ${activeAiJob!.label} · ${Math.round(activeAiJob!.progress * 100)}%`
                      : `✨ AI cutout pending…`)
                  : (activeVideo.bgReplace === 'image'
                    ? `🔑 key → image on export`
                    : activeVideo.bgReplace === 'color'
                      ? `🔑 key → ${activeVideo.bgColor ?? '#000000'} on export`
                      : `🔑 chroma-key on export`)}
              </div>
            )}
          </>
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
        {!sizingBg && activeVideo && activeVideo.kind === 'video' && !videoMissing &&
          (activeVideo.bgRemove ?? 'off') !== 'off' &&
          (activeVideo.bgReplace ?? 'black') === 'image' && (
          <>
            {bgImageIds(activeVideo).map((id) => (
              <DraggableBgGhost key={id} videoId={activeVideo.id} clipId={id} frameRef={frameRef} />
            ))}
          </>
        )}
        {!sizingBg && activeImages.map((c) =>
          c.kind === 'image' && !c.src.startsWith('missing:') ? (
            <DraggableImage key={c.id} clip={c} frameRef={frameRef} />
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
        Drag text / images on canvas to move · auto-creates keyframe when moved off start · green-screen backdrop shows as a ghost — drag it to track
      </div>
    </div>
  );
}

function PreviewBackdrop({ videoId }: { videoId: string }) {
  const clip = useEditor((s) => s.project.clips.find((c) => c.id === videoId));
  const currentTimeMs = useEditor((s) => s.currentTimeMs);
  if (!clip || clip.kind !== 'video' || (clip.bgRemove ?? 'off') === 'off') {
    return null;
  }
  // AI cutout not ready yet — nothing transparent to composite over, skip
  if ((clip.bgRemove ?? 'off') === 'ai' && !aiDisplaySrc(clip)) {
    return null;
  }
  if ((clip.bgReplace ?? 'black') === 'color') {
    return (
      <div style={{ position: 'absolute', inset: 0, background: clip.bgColor ?? '#000000' }} />
    );
  }
  if ((clip.bgReplace ?? 'black') === 'image') {
    // One <img> per layer, bottom-to-top like the export's [bg] stack.
    // Mirrors the export: outside a layer's own timeline window it falls back
    // to the layers below (renderer gates each [bg] overlay on startMs/durationMs).
    const layers = bgImageIds(clip)
      .map((id) => useEditor.getState().project.clips.find((c) => c.id === id))
      .filter(
        (img): img is ImageClip =>
          !!img && img.kind === 'image' && !img.src.startsWith('missing:') && isClipActiveAt(img, currentTimeMs)
      );
    if (layers.length === 0) return null;
    return (
      <>
        {layers.map((bgImage) => {
          const s = Math.max(0.1, Math.min(4, bgImage.scale ?? 1));
          const pos = evalImageAt(bgImage, currentTimeMs);
          return (
            <img
              key={bgImage.id}
              src={bgImage.src}
              style={{
                position: 'absolute',
                left: `${50 + pos.x * 100}%`,
                top: `${50 + pos.y * 100}%`,
                transform: 'translate(-50%,-50%)',
                width: `${s * 100}%`,
                height: `${s * 100}%`,
                objectFit: 'cover',
              }}
            />
          );
        })}
      </>
    );
  }
  return null;
}

function DraggableImage({ clip, frameRef, cover }: { clip: ImageClip; frameRef: React.RefObject<HTMLDivElement>; cover?: boolean }) {
  const currentTimeMs = useEditor((s) => s.currentTimeMs);
  const selectedId = useEditor((s) => s.selectedId);
  const selectedKeyframeId = useEditor((s) => s.selectedKeyframeId);
  const drag = useRef<{ startX: number; startY: number; origX: number; origY: number; kfId: string | null; isNew: boolean } | null>(null);

  const t = evalImageAt(clip, currentTimeMs);
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
      const kfs = [...(clip.keyframes ?? []), { id, offsetMs: offset, x: cx, y: cy }];
      st.updateClip(clip.id, { keyframes: kfs } as never);
      st.selectKeyframe(id);
      return { kfId: id, isNew: true };
    }
    st.updateClip(clip.id, { x: cx, y: cy });
    return { kfId: null, isNew: false };
  };

  const s = Math.max(0.1, Math.min(4, clip.scale ?? 1));
  return (
    <img
      src={aiDisplaySrc(clip) ?? clip.src}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      onError={() => useEditor.getState().markUnsupported(clip.id)}
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
        ...(cover
          ? { width: `${s * 100}%`, height: `${s * 100}%`, objectFit: 'cover' as const }
          : { maxWidth: `${s * 60}%`, borderRadius: 6 }),
        cursor: 'move',
        userSelect: 'none',
        touchAction: 'none',
        outline: isSel ? '2px dashed var(--ring)' : 'none',
        outlineOffset: 4,
      }}
    />
  );
}

// Replacement background shown ghosted *above* the opaque preview video so it
// can be seen (and dragged) at all — export composites it behind the keyed
// subject instead. Selection is deferred to pointer-up (a clean click): selecting
// on pointer-down would jump into fullscreen sizing mode mid-drag and hide the
// video reference being tracked against.
function DraggableBgGhost({ videoId, clipId, frameRef }: { videoId: string; clipId: string; frameRef: React.RefObject<HTMLDivElement> }) {
  const clip = useEditor((s) => s.project.clips.find((c) => c.id === videoId));
  const currentTimeMs = useEditor((s) => s.currentTimeMs);
  const selectedId = useEditor((s) => s.selectedId);
  const selectedKeyframeId = useEditor((s) => s.selectedKeyframeId);
  const drag = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null);
  const bgImage = useEditor((s) => {
    if (!clip || clip.kind !== 'video') return null;
    if ((clip.bgRemove ?? 'off') === 'off' || (clip.bgReplace ?? 'black') !== 'image') return null;
    if (!bgImageIds(clip).includes(clipId)) return null;
    const img = s.project.clips.find((c) => c.id === clipId);
    return img && img.kind === 'image' && !img.src.startsWith('missing:') ? img : null;
  });
  if (!clip || clip.kind !== 'video') return null;
  // AI cutout with a processed file is genuinely transparent in preview — the
  // real backdrop already shows through, so no ghost needed.
  if ((clip.bgRemove ?? 'off') === 'ai' && aiDisplaySrc(clip)) return null;
  if (!bgImage || bgImage.kind !== 'image') return null;
  if (!isClipActiveAt(bgImage, currentTimeMs)) return null;

  const pos = evalImageAt(bgImage, currentTimeMs);
  const s = Math.max(0.1, Math.min(4, bgImage.scale ?? 1));
  const nearKf = nearestKeyframe(bgImage, currentTimeMs, 200);
  const isSel = selectedId === bgImage.id || (nearKf != null && selectedKeyframeId === nearKf.id);

  const commit = (nx: number, ny: number) => {
    const st = useEditor.getState();
    const cx = Math.max(-0.6, Math.min(0.6, nx));
    const cy = Math.max(-0.6, Math.min(0.6, ny));
    const offset = Math.max(0, Math.round(currentTimeMs - bgImage.startMs));
    if (offset < 200) {
      st.updateClip(bgImage.id, { x: cx, y: cy });
      return;
    }
    const existing = nearestKeyframe(bgImage, currentTimeMs, 250);
    if (existing) {
      const kfs = (bgImage.keyframes ?? []).map((k) => (k.id === existing.id ? { ...k, x: cx, y: cy } : k));
      st.updateClip(bgImage.id, { keyframes: kfs } as never);
      return;
    }
    if (st.autoKey) {
      const id = uid();
      st.updateClip(bgImage.id, { keyframes: [...(bgImage.keyframes ?? []), { id, offsetMs: offset, x: cx, y: cy }] } as never);
      st.selectKeyframe(id);
      return;
    }
    st.updateClip(bgImage.id, { x: cx, y: cy });
  };

  return (
    <img
      src={bgImage.src}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        e.stopPropagation();
        useEditor.getState().setPlaying(false);
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        drag.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y, moved: false };
      }}
      onPointerMove={(e) => {
        if (!drag.current || !frameRef.current) return;
        const rect = frameRef.current.getBoundingClientRect();
        const dx = (e.clientX - drag.current.startX) / rect.width;
        const dy = (e.clientY - drag.current.startY) / rect.height;
        if (Math.abs(e.clientX - drag.current.startX) + Math.abs(e.clientY - drag.current.startY) > 3) {
          drag.current.moved = true;
        }
        commit(drag.current.origX + dx, drag.current.origY + dy);
      }}
      onPointerUp={() => {
        // Clean click (no drag) selects the backdrop for fullscreen sizing.
        if (drag.current && !drag.current.moved) useEditor.getState().select(bgImage.id);
        drag.current = null;
      }}
      title="Replacement background (ghost) — drag to track · click to size"
      style={{
        position: 'absolute',
        left: `${50 + pos.x * 100}%`,
        top: `${50 + pos.y * 100}%`,
        transform: 'translate(-50%,-50%)',
        width: `${s * 100}%`,
        height: `${s * 100}%`,
        objectFit: 'cover',
        opacity: 0.5,
        cursor: 'move',
        userSelect: 'none',
        touchAction: 'none',
        outline: isSel ? '2px dashed var(--ring)' : 'none',
        outlineOffset: 4,
      }}
    />
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

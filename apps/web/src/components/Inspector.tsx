import { evalTextAt, uid } from '@memeit/timeline';
import { useEditor } from '../store';
import { addCaptionPersist, addSubtitleAfterLast, findJoinPartner, focusTextEditor, joinSelectedWithNext, splitSelectedAtPlayhead } from '../lib/captions';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import { Badge } from './ui/badge';
import { Card } from './ui/card';
import { Slider } from './ui/slider';
import { Checkbox } from './ui/checkbox';
import { Separator } from './ui/separator';

const PRESETS = [
  { label: '9:16', w: 1080, h: 1920 },
  { label: '1:1', w: 1080, h: 1080 },
  { label: '16:9', w: 1920, h: 1080 },
];

export default function Inspector() {
  const project = useEditor((s) => s.project);
  const selectedId = useEditor((s) => s.selectedId);
  const selectedKeyframeId = useEditor((s) => s.selectedKeyframeId);
  const selectKeyframe = useEditor((s) => s.selectKeyframe);
  const autoKey = useEditor((s) => s.autoKey);
  const setAutoKey = useEditor((s) => s.setAutoKey);
  const updateClip = useEditor((s) => s.updateClip);
  const updateProject = useEditor((s) => s.updateProject);
  const setTime = useEditor((s) => s.setTime);
  const currentTimeMs = useEditor((s) => s.currentTimeMs);

  const clip = project.clips.find((c) => c.id === selectedId);
  const counts = {
    video: project.clips.filter((c) => c.kind === 'video').length,
    image: project.clips.filter((c) => c.kind === 'image').length,
    text: project.clips.filter((c) => c.kind === 'text').length,
    audio: project.clips.filter((c) => c.kind === 'audio').length,
    missing: project.clips.filter((c) => (c.kind === 'video' || c.kind === 'image' || c.kind === 'audio') && c.src.startsWith('missing:')).length,
  };

  return (
    <div>
      <div className="mb-2.5 flex flex-col gap-1">
        <Label>Canvas preset</Label>
        <div className="flex gap-1.5">
          {PRESETS.map((p) => (
            <Button
              key={p.label}
              size="sm"
              variant={project.width === p.w && project.height === p.h ? 'default' : 'outline'}
              onClick={() => updateProject((pr) => ({ ...pr, width: p.w, height: p.h }))}
            >
              {p.label}
            </Button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="mb-2.5 flex flex-col gap-1">
          <Label>W</Label>
          <Input
            type="number"
            value={project.width}
            onChange={(e) => updateProject((p) => ({ ...p, width: Number(e.target.value) || 1080 }))}
          />
        </div>
        <div className="mb-2.5 flex flex-col gap-1">
          <Label>H</Label>
          <Input
            type="number"
            value={project.height}
            onChange={(e) => updateProject((p) => ({ ...p, height: Number(e.target.value) || 1920 }))}
          />
        </div>
      </div>

      <Card className="mb-3 bg-muted/30 p-3">
        <div className="mb-1.5 flex flex-col gap-1">
          <Label>Timeline length (s)</Label>
          <Input
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
        <div className="text-xs text-muted-foreground">
          {counts.video} video · {counts.image} img · {counts.text} text · {counts.audio} audio
          {counts.missing > 0 && <span className="font-bold text-destructive"> · ⚠️ {counts.missing} missing</span>}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" onClick={() => { addCaptionPersist(); focusTextEditor(); }} title="New caption at playhead (t)">T+ caption</Button>
          <Button size="sm" variant="outline" onClick={() => { addSubtitleAfterLast(); focusTextEditor(); }} title="Next subtitle line (s)">S+ line</Button>
        </div>
      </Card>

      {!clip && (
        <Card className="mb-3 border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
          <div className="text-[22px]">👆</div>
          <b className="text-foreground">Select a clip to edit timing, text and motion.</b>
          <span>Click a row in Media or a block in the Timeline. Drag text directly on the canvas to move it.</span>
        </Card>
      )}

      {clip && (
        <div>
          <div className="mb-2.5 flex items-center gap-2">
            <Badge variant="secondary" className="uppercase">{clip.kind}</Badge>
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-bold">{clip.name ?? (clip.kind === 'text' ? clip.text : clip.id)}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="mb-2.5 flex flex-col gap-1">
              <Label>Start (s)</Label>
              <Input
                type="number"
                step={0.1}
                value={Number(clip.startMs / 1000).toFixed(1)}
                onChange={(e) => updateClip(clip.id, { startMs: Number(e.target.value) * 1000 } as never)}
              />
            </div>
            <div className="mb-2.5 flex flex-col gap-1">
              <Label>Duration (s){clip.kind === 'audio' ? ' · fixed' : ''}</Label>
              <Input
                type="number"
                step={0.1}
                min={0.1}
                value={Number(clip.durationMs / 1000).toFixed(1)}
                disabled={clip.kind === 'audio'}
                title={clip.kind === 'audio' ? 'Audio length is fixed to the source file — cut (S) to trim' : undefined}
                onChange={(e) => updateClip(clip.id, { durationMs: Number(e.target.value) * 1000 } as never)}
              />
            </div>
          </div>
          <Button variant="outline" size="sm" className="w-full" onClick={() => setTime(clip.startMs)}>
            Jump to clip start
          </Button>

          {clip.kind === 'text' && (
            <>
              <div className="mb-2.5 mt-3 flex flex-col gap-1">
                <Label>Text (multiline = SRT lines)</Label>
                <Textarea
                  id="insp-text"
                  rows={3}
                  value={clip.text}
                  onChange={(e) => updateClip(clip.id, { text: e.target.value.slice(0, 500) })}
                  className="resize-y leading-relaxed"
                />
              </div>
              <TextTimingTools clipId={clip.id} />
              <div className="mb-2.5 flex flex-col gap-2">
                <Label>Base position — drag on canvas or use sliders</Label>
                <label className="flex items-center gap-2 text-xs">X <Slider min={-0.5} max={0.5} step={0.01} value={[clip.x]} onValueChange={([v]) => updateClip(clip.id, { x: v ?? 0 })} /></label>
                <label className="flex items-center gap-2 text-xs">Y <Slider min={-0.5} max={0.5} step={0.01} value={[clip.y]} onValueChange={([v]) => updateClip(clip.id, { y: v ?? 0 })} /></label>
              </div>
              <div className="mb-2.5 flex flex-col gap-1.5">
                <Label>Size ({clip.fontSize}px)</Label>
                <Slider min={20} max={150} value={[clip.fontSize]} onValueChange={([v]) => updateClip(clip.id, { fontSize: v ?? 20 })} />
              </div>

              <KeyframeEditor clipId={clip.id} />
            </>
          )}
          {(clip.kind === 'video' || clip.kind === 'audio') && (
            <div className="mb-2.5 mt-3 flex flex-col gap-1.5">
              <Label>Volume ({clip.volume.toFixed(2)})</Label>
              <Slider
                min={0}
                max={clip.kind === 'audio' ? 2 : 1}
                step={0.05}
                value={[clip.volume]}
                onValueChange={([v]) => updateClip(clip.id, { volume: v ?? 0 } as never)}
              />
            </div>
          )}
          {clip.kind === 'image' && (
            <div className="mb-2.5 mt-3 flex flex-col gap-2">
              <div className="flex flex-col gap-1.5">
                <Label>Size ({clip.scale.toFixed(2)}x)</Label>
                <Slider
                  min={0.1}
                  max={4}
                  step={0.05}
                  value={[clip.scale]}
                  onValueChange={([v]) => updateClip(clip.id, { scale: v ?? 1 } as never)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label>Position</Label>
                <label className="flex items-center gap-2 text-xs">X <Slider min={-0.5} max={0.5} step={0.01} value={[clip.x]} onValueChange={([v]) => updateClip(clip.id, { x: v ?? 0 } as never)} /></label>
                <label className="flex items-center gap-2 text-xs">Y <Slider min={-0.5} max={0.5} step={0.01} value={[clip.y]} onValueChange={([v]) => updateClip(clip.id, { y: v ?? 0 } as never)} /></label>
              </div>
              {project.clips.some((c) => c.kind === 'video' && c.bgImageClipId === clip.id) && (
                <div className="text-[11px] text-muted-foreground">
                  Used as a replacement background — Size/Position above apply to the backdrop too. Select the image to size it fullscreen (video hidden).
                </div>
              )}
            </div>
          )}
          {clip.kind === 'video' && (
            <div className="mb-2.5 mt-3 flex flex-col gap-2">
              <Label>Position</Label>
              <label className="flex items-center gap-2 text-xs">X <Slider min={-0.5} max={0.5} step={0.01} value={[clip.x ?? 0]} onValueChange={([v]) => updateClip(clip.id, { x: v ?? 0 } as never)} /></label>
              <label className="flex items-center gap-2 text-xs">Y <Slider min={-0.5} max={0.5} step={0.01} value={[clip.y ?? 0]} onValueChange={([v]) => updateClip(clip.id, { y: v ?? 0 } as never)} /></label>
              <div className="text-[11px] text-muted-foreground">
                Pans the video — with cover, this picks which part gets cropped.
              </div>
            </div>
          )}
          {clip.kind === 'video' && (
            <div className="mb-2.5 mt-3 flex flex-col gap-1">
              <Label>Fit</Label>
              <div className="flex gap-1.5">
                {(['cover', 'contain', 'stretch'] as const).map((f) => (
                  <Button
                    key={f}
                    size="sm"
                    variant={(clip.fit ?? 'cover') === f ? 'default' : 'outline'}
                    onClick={() => updateClip(clip.id, { fit: f } as never)}
                    title={
                      f === 'cover'
                        ? 'Fill canvas, crop sides (current)'
                        : f === 'contain'
                          ? 'Fit whole video, black bars'
                          : 'Stretch to exact size (may distort)'
                    }
                  >
                    {f}
                  </Button>
                ))}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {(clip.fit ?? 'cover') === 'cover' && 'Fills canvas — sides get cropped on aspect mismatch.'}
                {(clip.fit ?? 'cover') === 'contain' && 'Shows the whole frame — black bars fill the rest.'}
                {(clip.fit ?? 'cover') === 'stretch' && 'Stretches to exact size — may look squished.'}
              </div>
            </div>
          )}
          {clip.kind === 'video' && (
            <Card className="mb-2.5 mt-3 bg-muted/30 p-3">
              <label className="flex cursor-pointer items-center gap-2 text-xs font-bold">
                <Checkbox
                  checked={(clip.bgRemove ?? 'off') === 'chroma'}
                  onCheckedChange={(v) => updateClip(clip.id, { bgRemove: v === true ? 'chroma' : 'off' } as never)}
                />
                Remove background (green-screen)
              </label>
              {(clip.bgRemove ?? 'off') === 'chroma' && (
                <div className="mt-2 flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-xs">
                    <Label>Key color</Label>
                    <Input
                      type="color"
                      className="h-7 w-12 p-1"
                      value={clip.chromaColor ?? '#00FF00'}
                      onChange={(e) => updateClip(clip.id, { chromaColor: e.target.value } as never)}
                    />
                    <span className="text-muted-foreground">{clip.chromaColor ?? '#00FF00'}</span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Similarity ({(clip.chromaSimilarity ?? 0.3).toFixed(2)})</Label>
                    <Slider
                      min={0}
                      max={1}
                      step={0.01}
                      value={[clip.chromaSimilarity ?? 0.3]}
                      onValueChange={([v]) => updateClip(clip.id, { chromaSimilarity: v ?? 0.3 } as never)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Blend ({(clip.chromaBlend ?? 0.1).toFixed(2)})</Label>
                    <Slider
                      min={0}
                      max={1}
                      step={0.01}
                      value={[clip.chromaBlend ?? 0.1]}
                      onValueChange={([v]) => updateClip(clip.id, { chromaBlend: v ?? 0.1 } as never)}
                    />
                  </div>
                  <Separator />
                  <div className="flex flex-col gap-1.5">
                    <Label>Replacement background</Label>
                    <div className="flex gap-1.5">
                      {(['black', 'color', 'image'] as const).map((b) => (
                        <Button
                          key={b}
                          size="sm"
                          variant={(clip.bgReplace ?? 'black') === b ? 'default' : 'outline'}
                          onClick={() => updateClip(clip.id, { bgReplace: b } as never)}
                        >
                          {b}
                        </Button>
                      ))}
                    </div>
                    {(clip.bgReplace ?? 'black') === 'color' && (
                      <div className="flex items-center gap-2 text-xs">
                        <Input
                          type="color"
                          className="h-7 w-12 p-1"
                          value={clip.bgColor ?? '#000000'}
                          onChange={(e) => updateClip(clip.id, { bgColor: e.target.value } as never)}
                        />
                        <span className="text-muted-foreground">{clip.bgColor ?? '#000000'}</span>
                      </div>
                    )}
                    {(clip.bgReplace ?? 'black') === 'image' && (
                      <BackgroundImagePicker
                        videoId={clip.id}
                        selectedId={clip.bgImageClipId}
                      />
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Applies on export via ffmpeg chromakey. Preview shows the original — export to check the key.
                  </div>
                </div>
              )}
            </Card>
          )}
        </div>
      )}

      <details className="mt-3 text-muted-foreground">
        <summary className="cursor-pointer text-xs">Project JSON</summary>
        <pre className="mt-1 max-h-40 overflow-auto rounded-lg border border-border bg-black/40 p-2 text-[10px]">{JSON.stringify(project, null, 1).slice(0, 3000)}</pre>
      </details>
    </div>
  );

  function BackgroundImagePicker({ videoId, selectedId }: { videoId: string; selectedId?: string }) {
    const images = useEditor((s) => s.project.clips.filter((c) => c.kind === 'image'));
    const updateClipInner = useEditor((s) => s.updateClip);
    if (images.length === 0) {
      return (
        <div className="text-[11px] text-muted-foreground">
          No images in timeline — add one via Media (🖼) first.
        </div>
      );
    }
    return (
      <select
        className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs"
        value={selectedId ?? ''}
        onChange={(e) => updateClipInner(videoId, { bgImageClipId: e.target.value || undefined } as never)}
      >
        <option value="">— pick background image —</option>
        {images.map((c) => (
          <option key={c.id} value={c.id}>
            {(c.kind === 'image' ? (c.name ?? c.id) : c.id).slice(0, 40)}
          </option>
        ))}
      </select>
    );
  }

  function TextTimingTools({ clipId }: { clipId: string }) {
    const c = useEditor.getState().project.clips.find((x) => x.id === clipId);
    if (!c) return null;
    const st = useEditor.getState();
    const joinable = findJoinPartner(c.id);
    const nudge = (dMs: number) =>
      st.updateClip(c.id, { startMs: Math.max(0, Math.round(c.startMs + dMs)) } as never);
    const extendToEnd = () =>
      st.updateClip(c.id, { durationMs: Math.max(500, Math.round(st.project.durationMs - c.startMs)) } as never);
    const endAtPlayhead = () => {
      const d = Math.round(st.currentTimeMs - c.startMs);
      if (d >= 300) st.updateClip(c.id, { durationMs: d } as never);
    };
    const startAtPlayhead = () => {
      const ns = Math.round(st.currentTimeMs);
      const end = c.startMs + c.durationMs;
      if (end > ns + 300) {
        st.updateClip(c.id, { startMs: ns, durationMs: Math.round(end - ns) } as never);
      } else {
        st.updateClip(c.id, { startMs: ns } as never);
      }
    };
    const split = () => {
      splitSelectedAtPlayhead();
    };
    return (
      <div className="mb-1.5 flex flex-wrap gap-1.5">
        {(c.kind === 'audio' || c.kind === 'video') && (c.srcOffsetMs ?? 0) > 0 && (
          <span className="w-full text-[11px] text-muted-foreground">
            Starts {((c.srcOffsetMs ?? 0) / 1000).toFixed(2)}s into the file (cut piece)
          </span>
        )}
        <Button size="sm" variant="outline" onClick={() => nudge(-500)} title="Move 0.5s earlier">−0.5s</Button>
        <Button size="sm" variant="outline" onClick={() => nudge(500)} title="Move 0.5s later">+0.5s</Button>
        <Button size="sm" variant="outline" onClick={startAtPlayhead} title="Set start to playhead">Start=▶</Button>
        <Button size="sm" variant="outline" onClick={endAtPlayhead} title="Set end to playhead">End=▶</Button>
        <Button size="sm" variant="outline" onClick={extendToEnd} title="Persist to end of timeline">Persist ▸end</Button>
        <Button size="sm" variant="outline" onClick={split} title="Cut clip at playhead (S)">Cut ✂</Button>
        {joinable && (
          <Button size="sm" variant="outline" onClick={() => joinSelectedWithNext()} title="Join with next same-file clip (J)">
            Join ⏭
          </Button>
        )}
      </div>
    );
  }

  function KeyframeEditor({ clipId }: { clipId: string }) {
    const c = useEditor.getState().project.clips.find((x) => x.id === clipId);
    if (!c || c.kind !== 'text') return null;
    const kfs = [...(c.keyframes ?? [])].sort((a, b) => a.offsetMs - b.offsetMs);
    const offset = Math.max(0, Math.round(currentTimeMs - c.startMs));
    const cur = evalTextAt(c, currentTimeMs);

    const addKf = () => {
      // replace keyframe within 120ms to avoid stacking
      const near = kfs.find((k) => Math.abs(k.offsetMs - offset) < 120);
      if (near) {
        selectKeyframe(near.id);
        setTime(c.startMs + near.offsetMs);
        return;
      }
      const id = uid();
      updateClip(c.id, { keyframes: [...kfs, { id, offsetMs: offset, x: cur.x, y: cur.y, fontSize: cur.fontSize }] } as never);
      selectKeyframe(id);
    };

    return (
      <Card className="mt-3 bg-muted/30 p-3">
        <div className="mb-1.5 flex items-center justify-between">
          <b className="text-xs">Motion keyframes ({kfs.length})</b>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Checkbox checked={autoKey} onCheckedChange={(v) => setAutoKey(v === true)} /> auto-key on drag
          </label>
        </div>
        <div className="mb-1.5 text-[11px] text-muted-foreground">
          Move playhead, drag text or press add — position interpolates linearly between keys.
        </div>
        <Button size="sm" variant="outline" className="w-full" onClick={addKf}>
          ◆ Add keyframe @{(offset / 1000).toFixed(2)}s
        </Button>
        <Separator className="my-2" />
        {kfs.map((k) => (
          <div key={k.id} className={`flex items-center gap-1.5 rounded-md px-1 py-0.5 ${selectedKeyframeId === k.id ? 'bg-accent' : ''}`}>
            <Button variant="ghost" size="sm" className={`h-7 px-2 text-xs ${selectedKeyframeId === k.id ? 'text-ring' : ''}`} title="Jump" onClick={() => { setTime(c.startMs + k.offsetMs); selectKeyframe(k.id); }}>
              ◆ {(k.offsetMs / 1000).toFixed(2)}s
            </Button>
            <span className="text-[11px] text-muted-foreground">
              x{k.x.toFixed(2)} y{k.y.toFixed(2)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto h-6 w-6 text-muted-foreground hover:text-destructive"
              title="Delete keyframe"
              onClick={() => {
                updateClip(c.id, { keyframes: kfs.filter((x) => x.id !== k.id) } as never);
                if (selectedKeyframeId === k.id) selectKeyframe(null);
              }}
            >
              ✕
            </Button>
          </div>
        ))}
      </Card>
    );
  }
}

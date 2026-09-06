import { useState } from 'react';
import { bgImageIds } from '@memeit/timeline';
import { useEditor } from '../store';
import { trackTargetClip } from '../lib/track';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Separator } from './ui/separator';

/** Auto-track a green/blue screen into this image clip's position keyframes. */
export default function TrackPanel({ clipId }: { clipId: string }) {
  const project = useEditor((s) => s.project);
  const updateClip = useEditor((s) => s.updateClip);
  const clip = project.clips.find((c) => c.id === clipId);
  const videos = project.clips.filter((c) => c.kind === 'video');
  const linked = videos.find((v) => v.kind === 'video' && bgImageIds(v).includes(clipId));

  const [videoId, setVideoId] = useState(linked?.id ?? videos[0]?.id ?? '');
  const [fromS, setFromS] = useState('');
  const [toS, setToS] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!clip || clip.kind !== 'image') return null;

  const video = videos.find((v) => v.id === videoId);
  const effStart = Math.max(clip.startMs, video?.startMs ?? 0);
  const effEnd = Math.min(
    clip.startMs + clip.durationMs,
    video ? video.startMs + video.durationMs : Number.POSITIVE_INFINITY
  );

  const run = async () => {
    if (!videoId) {
      setError('Pick a video clip to track.');
      return;
    }
    setBusy('Starting…');
    setNote(null);
    setError(null);
    try {
      const fromMs = fromS.trim() === '' ? undefined : Math.max(0, Math.round(Number(fromS) * 1000));
      const toMs = toS.trim() === '' ? undefined : Math.max(0, Math.round(Number(toS) * 1000));
      if ((fromS.trim() !== '' && !Number.isFinite(fromMs)) || (toS.trim() !== '' && !Number.isFinite(toMs))) {
        throw new Error('from/to must be seconds (numbers).');
      }
      const { keyframes, log } = await trackTargetClip(videoId, clipId, { fromMs, toMs }, setBusy);
      updateClip(clipId, { keyframes } as never);
      setNote(`${keyframes.length} keyframes — ${log}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="mt-3 bg-muted/30 p-3">
      <b className="text-xs">Auto-track screen</b>
      <div className="mb-1.5 mt-1 text-[11px] text-muted-foreground">
        Tracks the green/blue screen in a video and writes the motion here as keyframes.
        Keeps this clip's position as the base — replaces existing keyframes.
      </div>
      {videos.length === 0 ? (
        <div className="text-[11px] text-muted-foreground">Add a video clip first.</div>
      ) : (
        <>
          <div className="mb-1.5 flex flex-col gap-1">
            <Label>Video to track</Label>
            <select
              value={videoId}
              onChange={(e) => setVideoId(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
            >
              {videos.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.kind === 'video' ? (v.name ?? v.id) : v.id} ({(v.startMs / 1000).toFixed(1)}s–
                  {((v.startMs + v.durationMs) / 1000).toFixed(1)}s)
                </option>
              ))}
            </select>
          </div>
          <div className="mb-2 flex gap-2">
            <label className="flex flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
              from (s, blank = image start)
              <Input
                value={fromS}
                onChange={(e) => setFromS(e.target.value)}
                placeholder={(clip.startMs / 1000).toFixed(1)}
                inputMode="decimal"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
              to (s, blank = image end)
              <Input
                value={toS}
                onChange={(e) => setToS(e.target.value)}
                placeholder={((clip.startMs + clip.durationMs) / 1000).toFixed(1)}
                inputMode="decimal"
              />
            </label>
          </div>
          {video && effEnd > effStart && (
            <div className="mb-2 text-[11px] text-muted-foreground">
              Tracks {(effStart / 1000).toFixed(1)}s–{(effEnd / 1000).toFixed(1)}s
              (this image ∩ video) — blank from/to uses the full overlap.
            </div>
          )}
          <Button size="sm" variant="outline" className="w-full" disabled={busy != null} onClick={() => void run()}>
            {busy != null ? `◌ ${busy}` : '◎ Track screen into keyframes'}
          </Button>
        </>
      )}
      {note && (
        <>
          <Separator className="my-2" />
          <div className="text-[11px] text-ring">✓ {note}</div>
        </>
      )}
      {error && (
        <>
          <Separator className="my-2" />
          <div className="text-[11px] text-destructive">⚠ {error}</div>
        </>
      )}
    </Card>
  );
}

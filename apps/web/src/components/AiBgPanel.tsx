import { useState } from 'react';
import { useEditor } from '../store';
import {
  AI_DEFAULT_MODEL,
  AI_MODELS,
  aiThreadInfo,
  cancelAiJob,
  clearAiBackground,
  formatDur,
  GPU_TRIAL_ENABLED,
  startAiBackgroundRemoval,
  useBgAi,
  type AiDeviceOpt,
  type AiModelId,
  type AiTiming,
} from '../lib/bgai';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';

export default function AiBgPanel({ clipId }: { clipId: string }) {
  const clip = useEditor((s) => s.project.clips.find((c) => c.id === clipId));
  const job = useBgAi((s) => s.jobs[clipId]);
  const last = useBgAi((s) => s.lastTiming[clipId]);
  const [model, setModel] = useState<AiModelId>(
    ((clip?.kind === 'video' || clip?.kind === 'image' ? clip.bgAiModel : undefined) as AiModelId | undefined) ??
      AI_DEFAULT_MODEL,
  );
  const [starting, setStarting] = useState(false);
  const [keepAudio, setKeepAudio] = useState(true);
  const [deviceOpt, setDeviceOpt] = useState<AiDeviceOpt>('auto');
  // isolation is fixed for the page lifetime — read once
  const [threads] = useState(aiThreadInfo);

  if (!clip || (clip.kind !== 'video' && clip.kind !== 'image')) return null;
  const status = clip.bgAiStatus ?? 'idle';
  const progress = job?.progress ?? clip.bgAiProgress ?? 0;
  const running = !!job && (job.phase === 'loading' || job.phase === 'processing' || job.phase === 'encoding');
  const done = status === 'done' && !!clip.bgAiSrc;

  const start = async () => {
    setStarting(true);
    try {
      await startAiBackgroundRemoval(clipId, { model, keepAudio, device: deviceOpt });
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        <Label>Model</Label>
        <select
          className="flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-xs"
          value={model}
          disabled={running || starting}
          onChange={(e) => setModel(e.target.value as AiModelId)}
          title={AI_MODELS.find((m) => m.id === model)?.note}
        >
          {AI_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      {GPU_TRIAL_ENABLED && (
        <div className="flex items-center gap-2 text-xs">
          <Label>Backend</Label>
          <select
            className="flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-xs"
            value={deviceOpt}
            disabled={running || starting}
            onChange={(e) => setDeviceOpt(e.target.value as AiDeviceOpt)}
            title="Auto tries WebGPU and falls back to CPU; GPU fails loudly if unavailable"
          >
            <option value="auto">Auto (try GPU)</option>
            <option value="cpu">CPU only</option>
            <option value="gpu">GPU only</option>
          </select>
        </div>
      )}

      {clip.kind === 'video' && !running && !done && (
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={keepAudio} onCheckedChange={(v) => setKeepAudio(v === true)} disabled={starting} />
          Keep camera audio as a separate track
        </label>
      )}
      {!running && !done && (
        <Button size="sm" variant="default" disabled={starting} onClick={start} title="Cut out the subject on-device (no upload)">
          {starting ? 'Starting…' : '✨ Remove background (AI)'}
        </Button>
      )}
      {running && (
        <>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-foreground transition-all"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[11px] tabular-nums text-muted-foreground">
              {job?.label ?? 'Working…'} · {Math.round(progress * 100)}%
              {job?.backend && <> · {job.backend}</>}
              {job?.avgFrameMs != null && (
                <>
                  <br />~{(job.avgFrameMs / 1000).toFixed(1)}s/frame · ETA {formatDur(job.etaMs)}
                </>
              )}
            </span>
            <Button size="sm" variant="outline" onClick={() => cancelAiJob(clipId)}>
              Cancel
            </Button>
          </div>
        </>
      )}
      {job?.phase === 'error' && (
        <div className="text-[11px] text-destructive">AI failed: {job.error ?? clip.bgAiError ?? 'unknown error'}</div>
      )}
      {status === 'error' && !job && (
        <div className="text-[11px] text-destructive">AI failed: {clip.bgAiError ?? 'unknown error'}</div>
      )}
      {done && !running && (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[11px] text-muted-foreground">✨ Cutout ready — preview + export use it.</span>
          <Button size="sm" variant="outline" onClick={start} title="Re-run with the selected model">
            Re-run
          </Button>
          <Button size="sm" variant="outline" onClick={() => void clearAiBackground(clipId)} title="Drop the cutout, restore original">
            Revert
          </Button>
        </div>
      )}
      {!running && last && last.totalMs > 0 && <TimingLine t={last} />}
      <div className="text-[11px] text-muted-foreground">
        Runs on-device (~540p, 15fps, clips up to 15s). First run downloads the model (~40–170MB, cached after).
        {clip.kind === 'video' && ' The cutout WebM is silent — camera audio is kept as a separate 🎵 track.'}
        <br />
        {threads.isolated
          ? `⚡ multithreaded inference (${threads.threads} threads, ${threads.cores} cores)`
          : '🐢 single-threaded inference — restart the dev server to pick up COOP/COEP headers for ~2–4x'}
      </div>
    </div>
  );
}

function TimingLine({ t }: { t: AiTiming }) {
  const pct = (v: number) => (t.totalMs > 0 ? `${Math.round((v / t.totalMs) * 100)}%` : '–');
  return (
    <div className="text-[11px] tabular-nums text-muted-foreground" title="Wall-clock breakdown of the last run (audio extraction overlaps segmentation)">
      Last run: {t.frames}f in {formatDur(t.totalMs)} · {(t.inferMs / Math.max(1, t.frames) / 1000).toFixed(2)}s/frame{t.backend ? ` · ${t.backend}` : ''}
      <br />
      infer {pct(t.inferMs)} · seek/draw {pct(t.seekDrawMs)} · smooth/store {pct(t.smoothStoreMs)} · model {formatDur(t.modelLoadMs)} · encode {formatDur(t.encodeMs)}
    </div>
  );
}

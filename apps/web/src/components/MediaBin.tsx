import { useRef } from 'react';
import { useEditor } from '../store';
import { addMediaFiles } from '../lib/media';
import { cancelAiJob, startAiBackgroundRemoval, useBgAi } from '../lib/bgai';
import TtsPanel from './TtsPanel';
import YoutubePanel from './YoutubePanel';
import { addCaptionPersist, addSubtitleAfterLast } from '../lib/captions';
import { Button } from './ui/button';
import { Badge } from './ui/badge';

const DOT: Record<string, string> = {
  video: 'var(--chart-2)',
  image: 'var(--chart-4)',
  text: 'var(--chart-1)',
  audio: 'var(--chart-3)',
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
      <Button variant="outline" size="icon" className="h-[34px] w-[38px] text-base" onClick={() => ref.current?.click()} title={kbd ? `${title} (${kbd})` : title}>
        {icon}
      </Button>
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
  const removeClip = useEditor((s) => s.removeClip);
  const select = useEditor((s) => s.select);
  const selectedId = useEditor((s) => s.selectedId);
  const unsupportedIds = useEditor((s) => s.unsupportedIds);

  // (moved to lib/captions.ts so keybindings share the same behavior)
  const addText = addCaptionPersist;

  return (
    <div>
      {/* tight icon toolbar — window itself is the dropzone */}
      <div className="flex items-center gap-1.5">
        <IconButton icon="🎬" title="Add video" accept="video/*" />
        <IconButton icon="🖼" title="Add image" accept="image/*" />
        <IconButton icon="🎵" title="Add audio" accept="audio/*" multiple />
        <Button variant="outline" size="icon" className="h-[34px] w-[38px] text-xs font-bold" onClick={addText} title="New caption at playhead (t)">
          T+
        </Button>
        <Button variant="outline" size="icon" className="h-[34px] w-[38px] text-xs font-bold" onClick={addSubtitleAfterLast} title="Next subtitle line (s)">
          S+
        </Button>
      </div>

      <div className="mt-3 flex flex-col gap-1.5">
        <YoutubePanel />
        <TtsPanel />
      </div>

      <div className="mt-3 flex flex-col gap-1.5">
        {project.clips.length === 0 && (
          <div className="text-xs text-muted-foreground">No clips yet — drop a file anywhere to start.</div>
        )}
        {project.clips
          .slice()
          .sort((a, b) => a.startMs - b.startMs)
          .map((c) => {
            const missing = (c.kind === 'video' || c.kind === 'image' || c.kind === 'audio') && c.src.startsWith('missing:');
            const unsupported = !!unsupportedIds[c.id];
            const selected = selectedId === c.id;
            return (
              <div
                key={c.id}
                onClick={() => select(c.id)}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border bg-muted/30 px-2 py-1.5 text-xs transition-colors hover:border-ring/60 ${selected ? 'border-ring' : 'border-border'} ${missing ? 'border-destructive' : ''}`}
              >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: missing || unsupported ? 'var(--destructive)' : DOT[c.kind] }} />
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-foreground" title={unsupported ? 'This browser cannot decode this file — Render MP4 still includes it' : c.kind === 'text' ? c.text : c.name ?? c.id}>
                {missing ? '⚠️ ' : ''}
                {unsupported && !missing ? '🔇 ' : ''}
                  {c.kind}: {(c.kind === 'text' ? c.text : c.name ?? c.id).slice(0, 28).replace(/\n/g, ' ')}
                  {(c.kind === 'text' || c.kind === 'image') && (c.keyframes?.length ?? 0) > 0 && (
                    <Badge variant="outline" className="ml-1.5 px-1 py-0 text-[10px] text-ring">◆{c.keyframes!.length}</Badge>
                  )}
                </span>
                <span className="tabular-nums text-muted-foreground">{(c.durationMs / 1000).toFixed(1)}s</span>
                {(c.kind === 'video' || c.kind === 'image') && !missing && <AiBgQuickButton clipId={c.id} />}
                {missing && <RelinkButton clipId={c.id} kind={c.kind} />}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 text-muted-foreground hover:bg-white/10 hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeClip(c.id);
                  }}
                  title="Delete"
                >
                  ✕
                </Button>
              </div>
            );
          })}
      </div>
    </div>
  );
}

function AiBgQuickButton({ clipId }: { clipId: string }) {
  const clip = useEditor((s) => s.project.clips.find((c) => c.id === clipId));
  const job = useBgAi((s) => s.jobs[clipId]);
  if (!clip || (clip.kind !== 'video' && clip.kind !== 'image')) return null;
  const running = !!job && (job.phase === 'loading' || job.phase === 'processing' || job.phase === 'encoding');
  const done = (clip.bgRemove ?? 'off') === 'ai' && (clip.bgAiStatus ?? 'idle') === 'done' && !!clip.bgAiSrc;
  if (running) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 px-1.5 text-[10px] tabular-nums text-muted-foreground"
        title={`${job.label} — click to cancel`}
        onClick={(e) => {
          e.stopPropagation();
          cancelAiJob(clipId);
        }}
      >
        ✨ {Math.round((job.progress ?? 0) * 100)}%
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className={`h-6 w-6 shrink-0 ${done ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
      title={done ? 'AI cutout ready — see Inspector to re-run or revert' : 'Remove background with on-device AI (see Inspector)'}
      onClick={(e) => {
        e.stopPropagation();
        if (done) {
          useEditor.getState().select(clipId);
          return;
        }
        useEditor.getState().updateClip(clipId, { bgRemove: 'ai' } as never);
        useEditor.getState().select(clipId);
        void startAiBackgroundRemoval(clipId).catch((err) => alert(err instanceof Error ? err.message : String(err)));
      }}
    >
      ✨
    </Button>
  );
}

function RelinkButton({ clipId, kind }: { clipId: string; kind: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const accept = kind === 'video' ? 'video/*' : kind === 'image' ? 'image/*' : 'audio/*';
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        title="Pick the file again to re-link this clip"
        onClick={(e) => {
          e.stopPropagation();
          ref.current?.click();
        }}
      >
        Relink
      </Button>
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
          // new bytes invalidate any AI cutout of the old file
          const { clearAiBackground } = await import('../lib/bgai');
          await clearAiBackground(clipId);
          st.updateClip(clipId, { src: url, name: f.name } as never);
        }}
      />
    </>
  );
}

import { useRef } from 'react';
import { ProjectSchema, formatSrt, parseSrt } from '@memeit/timeline';
import { useEditor, uid } from '../store';
import { addMediaFiles } from '../lib/media';
import TtsPanel from './TtsPanel';
import { addCaptionPersist, addSubtitleAfterLast, baseTextStyle } from '../lib/captions';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';

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
  const srtRef = useRef<HTMLInputElement>(null);
  const jsonRef = useRef<HTMLInputElement>(null);

  // (moved to lib/captions.ts so keybindings share the same behavior)
  const addText = addCaptionPersist;

  const importSrt = async (f: File) => {
    const raw = await f.text();
    const cues = parseSrt(raw);
    if (cues.length === 0) {
      alert('No valid SRT cues found.');
      return;
    }
    const st = useEditor.getState();
    const maxEnd = Math.max(...cues.map((c) => c.endMs));
    if (maxEnd > st.project.durationMs) {
      st.updateProject((p) => ({ ...p, durationMs: Math.min(300_000, maxEnd + 1000) }));
    }
    cues.forEach((cue, i) => {
      st.addClip({
        id: uid(),
        kind: 'text',
        text: cue.text,
        startMs: Math.round(cue.startMs),
        durationMs: Math.max(500, Math.round(cue.endMs - cue.startMs)),
        ...baseTextStyle(i % 2 === 1 ? 0.35 : -0.35),
      });
    });
  };

  const exportSrt = () => {
    const cues = project.clips
      .filter((c) => c.kind === 'text')
      .sort((a, b) => a.startMs - b.startMs)
      .map((c) => ({
        startMs: c.kind === 'text' ? c.startMs : 0,
        endMs: c.startMs + c.durationMs,
        text: c.kind === 'text' ? c.text : '',
      }));
    if (cues.length === 0) {
      alert('No text clips to export.');
      return;
    }
    download('memeit-subtitles.srt', formatSrt(cues), 'text/plain');
  };

  const exportJson = async () => {
    const { serializeProject } = await import('../lib/persist');
    download('memeit-project.json', JSON.stringify(serializeProject(project), null, 2), 'application/json');
  };

  const importJson = async (f: File) => {
    try {
      const parsed = ProjectSchema.safeParse(JSON.parse(await f.text()));
      if (!parsed.success) {
        alert('Invalid project JSON.');
        return;
      }
      const { rehydrateProject, fitProjectToClips } = await import('../lib/persist');
      const { project: hydrated, missing } = await rehydrateProject(parsed.data);
      const st = useEditor.getState();
      st.updateProject(() => fitProjectToClips(hydrated));
      st.select(null);
      st.setTime(0);
      if (missing.length > 0) {
        const names = hydrated.clips.filter((c) => missing.includes(c.id)).map((c) => c.name ?? c.id);
        alert(`Project loaded, but ${missing.length} file(s) are missing (re-link them in Media):\n- ${names.join('\n- ')}`);
      }
    } catch {
      alert('Could not read project JSON.');
    }
  };

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
        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="h-[34px] w-[38px]" title="Subtitles / project files">⋯</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => srtRef.current?.click()}>⬆ Import SRT</DropdownMenuItem>
              <DropdownMenuItem onClick={exportSrt}>⬇ Export SRT</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => jsonRef.current?.click()}>⬆ Import JSON</DropdownMenuItem>
              <DropdownMenuItem onClick={exportJson}>⬇ Export JSON</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <input
        ref={srtRef}
        type="file"
        accept=".srt,text/plain"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importSrt(f);
          e.target.value = '';
        }}
      />
      <input
        ref={jsonRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importJson(f);
          e.target.value = '';
        }}
      />

      <div className="mt-3">
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
                  {c.kind === 'text' && (c.keyframes?.length ?? 0) > 0 && (
                    <Badge variant="outline" className="ml-1.5 px-1 py-0 text-[10px] text-ring">◆{c.keyframes!.length}</Badge>
                  )}
                </span>
                <span className="tabular-nums text-muted-foreground">{(c.durationMs / 1000).toFixed(1)}s</span>
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
          st.updateClip(clipId, { src: url, name: f.name } as never);
        }}
      />
    </>
  );
}

function download(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

import { useRef } from 'react';
import { ProjectSchema, formatSrt, parseSrt } from '@memeit/timeline';
import { useEditor, uid } from '../store';
import { baseTextStyle } from '../lib/captions';
import { slugify } from '../lib/projectName';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';

function download(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export default function ProjectMenu({ disabled, onBusy }: { disabled?: boolean; onBusy?: (s: string | null) => void }) {
  const srtRef = useRef<HTMLInputElement>(null);
  const jsonRef = useRef<HTMLInputElement>(null);
  const dumpRef = useRef<HTMLInputElement>(null);

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
    const { project } = useEditor.getState();
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
    download(`${slugify(project.name, 'memeit-subtitles')}.srt`, formatSrt(cues), 'text/plain');
  };

  const exportJson = async () => {
    const { project } = useEditor.getState();
    const { serializeProject } = await import('../lib/persist');
    download(`${slugify(project.name, 'memeit-project')}.json`, JSON.stringify(serializeProject(project), null, 2), 'application/json');
  };

  const exportDump = async () => {
    const { exportDump } = await import('../lib/dump');
    onBusy?.('Packing…');
    try {
      await exportDump();
      onBusy?.(null);
    } catch (e) {
      onBusy?.(null);
      alert(`Dump export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const importDump = async (f: File) => {
    try {
      const { importDump } = await import('../lib/dump');
      await importDump(f);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not read data dump.');
    }
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
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={disabled} title="Subtitles / project files">⋯</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => srtRef.current?.click()}>⬆ Import SRT</DropdownMenuItem>
          <DropdownMenuItem onClick={exportSrt}>⬇ Export SRT</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => jsonRef.current?.click()}>⬆ Import JSON</DropdownMenuItem>
          <DropdownMenuItem onClick={exportJson}>⬇ Export JSON</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => dumpRef.current?.click()}>⬆ Import data dump (.zip)</DropdownMenuItem>
          <DropdownMenuItem onClick={exportDump}>⬇ Export data dump (.zip)</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
      <input
        ref={dumpRef}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importDump(f);
          e.target.value = '';
        }}
      />
    </>
  );
}

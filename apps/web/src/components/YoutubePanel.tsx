import { useState } from 'react';
import {
  addYoutubeToProject,
  downloadYoutube,
  formatBytes,
  isYouTubeUrl,
  parseTimeInput,
  saveYoutubeFile,
  type YoutubeJob,
  type YoutubeMode,
} from '../lib/youtube';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

export default function YoutubePanel() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<YoutubeMode>('video');
  const [start, setStart] = useState('');
  const [duration, setDuration] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [last, setLast] = useState<YoutubeJob | null>(null);

  if (!open) {
    return (
      <Button variant="outline" className="w-full" onClick={() => setOpen(true)} title="Paste a YouTube link to download it into the project">
        ▶ Import from YouTube
      </Button>
    );
  }

  const busy = status !== null;

  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) setUrl(t.trim());
    } catch {
      // clipboard API unavailable (non-secure context) — user pastes manually
    }
  };

  const run = async (addToProject: boolean) => {
    const u = url.trim();
    if (!isYouTubeUrl(u)) {
      alert('Paste a YouTube link (youtube.com or youtu.be).');
      return;
    }
    const startSec = start.trim() ? parseTimeInput(start) : undefined;
    if (start.trim() && !(typeof startSec === 'number' && Number.isFinite(startSec) && startSec >= 0)) {
      alert('Start time must be seconds ("90") or m:ss ("1:23") / h:mm:ss.');
      return;
    }
    const durationSec = duration.trim() ? Number(duration.trim()) : undefined;
    if (duration.trim() && !(Number.isFinite(durationSec) && (durationSec as number) > 0 && (durationSec as number) <= 300)) {
      alert('Duration must be 1–300 seconds.');
      return;
    }
    setStatus('Starting…');
    setLast(null);
    try {
      const job = await downloadYoutube({
        url: u,
        mode,
        startSec: startSec ?? undefined,
        durationSec: durationSec ?? undefined,
        onStatus: (s) => setStatus(s),
      });
      setLast(job);
      if (addToProject) {
        setStatus('Adding to project…');
        await addYoutubeToProject(job);
      }
      setStatus(null);
    } catch (e) {
      setStatus(null);
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Card className="bg-muted/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <b className="text-xs">▶ YouTube import</b>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setOpen(false)} title="Close">✕</Button>
      </div>
      <div className="mb-2 flex flex-col gap-1">
        <Label>Link</Label>
        <div className="flex gap-1.5">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=…"
            className="font-mono"
          />
          <Button variant="outline" size="sm" className="shrink-0" onClick={paste} title="Paste from clipboard">
            ⧉
          </Button>
        </div>
      </div>
      <div className="mb-2 grid grid-cols-3 gap-1.5">
        <div className="flex flex-col gap-1">
          <Label>Type</Label>
          <Select value={mode} onValueChange={(v) => setMode(v as YoutubeMode)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="video">Video</SelectItem>
              <SelectItem value="audio">Audio</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label>Start (opt)</Label>
          <Input value={start} onChange={(e) => setStart(e.target.value)} placeholder="1:23" className="tabular-nums" />
        </div>
        <div className="flex flex-col gap-1">
          <Label>Length s (opt)</Label>
          <Input value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="10" inputMode="numeric" className="tabular-nums" />
        </div>
      </div>
      <div className="flex gap-1.5">
        <Button size="sm" className="flex-1" onClick={() => run(true)} disabled={busy || !url.trim()}>
          {status ? `⏳ ${status}` : 'Download → add to project'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => run(false)} disabled={busy || !url.trim()} title="Download without adding to the timeline">
          ⬇ File
        </Button>
      </div>
      {last && (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate" title={last.title}>
            ✓ {last.title ?? last.filename} {last.size ? `· ${formatBytes(last.size)}` : ''}
          </span>
          <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-[11px]" onClick={() => saveYoutubeFile(last)}>
            ⬇ Save
          </Button>
        </div>
      )}
      {!last && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          via ./bin/yt-dlp · section cut when start/length set
        </div>
      )}
    </Card>
  );
}

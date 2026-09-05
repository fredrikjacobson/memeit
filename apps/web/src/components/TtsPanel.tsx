import { useEffect, useState } from 'react';
import { fetchVoices, generateTtsAudio, type TtsVoice } from '../lib/tts';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Slider } from './ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

const FALLBACK: TtsVoice[] = [
  { name: 'en-US-Standard-A', languageCode: 'en-US', label: 'Standard A (cheap)' },
  { name: 'en-US-Chirp3-HD-Kore', languageCode: 'en-US', label: 'Chirp 3 HD Kore (best)' },
];

export default function TtsPanel() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [voices, setVoices] = useState<TtsVoice[]>(FALLBACK);
  const [voiceName, setVoiceName] = useState(FALLBACK[0].name);
  const [rate, setRate] = useState(1);
  const [status, setStatus] = useState<string | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchVoices()
      .then((r) => {
        if (cancelled) return;
        if (r.voices.length > 0) {
          setVoices(r.voices);
          setVoiceName((v) => (r.voices.some((x) => x.name === v) ? v : r.voices[0].name));
        }
        setUnconfigured(!r.configured);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open ]);

  const voice = voices.find((v) => v.name === voiceName);
  const isChirp = /chirp/i.test(voiceName);

  const generate = async () => {
    setStatus('Synthesizing…');
    try {
      await generateTtsAudio({
        text,
        voiceName,
        languageCode: voice?.languageCode,
        speakingRate: rate,
        onStatus: (s) => setStatus(s || null),
      });
      setStatus(null);
      setText('');
    } catch (e) {
      setStatus(null);
      alert(`TTS failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (!open) {
    return (
      <Button variant="outline" className="w-full" onClick={() => setOpen(true)} title="Generate voiceover with Google TTS">
        🔊 Generate voiceover
      </Button>
    );
  }

  return (
    <Card className="bg-muted/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <b className="text-xs">🔊 Text to speech</b>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setOpen(false)} title="Close">✕</Button>
      </div>
      {unconfigured && (
        <div className="mb-1.5 text-[11px] text-muted-foreground">
          Server may lack Google credentials — generation will report setup steps if so.
        </div>
      )}
      <div className="mb-2.5 flex flex-col gap-1">
        <Label>Text (max 5000 chars)</Label>
        <Textarea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 5000))}
          placeholder="This is a meme test…"
          className="resize-y leading-relaxed"
        />
      </div>
      <div className="mb-2.5 flex flex-col gap-1">
        <Label>Voice</Label>
        <Select value={voiceName} onValueChange={setVoiceName}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {voices.map((v) => (
              <SelectItem key={v.name} value={v.name}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {!isChirp && (
        <div className="mb-2.5 flex flex-col gap-1.5">
          <Label>Speed ({rate.toFixed(2)}x)</Label>
          <Slider min={0.5} max={2} step={0.05} value={[rate]} onValueChange={([v]) => setRate(v ?? 1)} />
        </div>
      )}
      <Button size="sm" className="w-full" onClick={generate} disabled={!text.trim() || !!status}>
        {status ? `⏳ ${status}` : 'Generate → add as audio clip'}
      </Button>
      <div className="mt-1 text-[11px] text-muted-foreground">
        {text.trim().length} chars · cached server-side in data/tts
      </div>
    </Card>
  );
}

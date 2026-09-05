import { useEffect, useState } from 'react';
import { fetchVoices, generateTtsAudio, type TtsVoice } from '../lib/tts';

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
      <button className="btn btn-block" onClick={() => setOpen(true)} title="Generate voiceover with Google TTS">
        🔊 Generate voiceover
      </button>
    );
  }

  return (
    <div className="kf-box">
      <div className="kf-head">
        <b>🔊 Text to speech</b>
        <button className="icon-btn" onClick={() => setOpen(false)} title="Close">✕</button>
      </div>
      {unconfigured && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
          Server may lack Google credentials — generation will report setup steps if so.
        </div>
      )}
      <div className="field">
        <span>Text (max 5000 chars)</span>
        <textarea
          className="text-input"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 5000))}
          placeholder="This is a meme test…"
          style={{ resize: 'vertical', lineHeight: 1.4 }}
        />
      </div>
      <div className="field">
        <span>Voice</span>
        <select className="text-input" value={voiceName} onChange={(e) => setVoiceName(e.target.value)}>
          {voices.map((v) => (
            <option key={v.name} value={v.name}>{v.label}</option>
          ))}
        </select>
      </div>
      {!isChirp && (
        <div className="field">
          <span>Speed ({rate.toFixed(2)}x)</span>
          <input type="range" min={0.5} max={2} step={0.05} value={rate} onChange={(e) => setRate(Number(e.target.value))} />
        </div>
      )}
      <button className="btn btn-primary btn-block btn-sm" onClick={generate} disabled={!text.trim() || !!status}>
        {status ? `⏳ ${status}` : 'Generate → add as audio clip'}
      </button>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
        {text.trim().length} chars · cached server-side in data/tts
      </div>
    </div>
  );
}

import { addMediaFiles } from './media';

export type TtsVoice = { name: string; languageCode: string; label: string };

export async function fetchVoices(): Promise<{ configured: boolean; voices: TtsVoice[] }> {
  const res = await fetch('/api/voices');
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function generateTtsAudio(opts: {
  text: string;
  voiceName: string;
  languageCode?: string;
  speakingRate?: number;
  onStatus?: (s: string) => void;
}): Promise<void> {
  const text = opts.text.trim().slice(0, 5000);
  if (!text) throw new Error('Enter some text first.');
  opts.onStatus?.('Synthesizing…');
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      voiceName: opts.voiceName,
      languageCode: opts.languageCode,
      speakingRate: opts.speakingRate,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    try {
      const j = JSON.parse(body) as { error?: unknown };
      throw new Error(typeof j.error === 'string' ? j.error : body);
    } catch (e) {
      if (e instanceof Error && e.message !== body) throw e;
      throw new Error(body.slice(0, 500));
    }
  }
  const blob = await res.blob();
  const file = new File([blob], `tts-${Date.now()}.mp3`, { type: 'audio/mpeg' });
  opts.onStatus?.('Adding to timeline…');
  await addMediaFiles([file]);
  opts.onStatus?.(null as unknown as string);
}

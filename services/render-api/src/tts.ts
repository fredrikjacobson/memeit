import express, { Router } from 'express';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const BodySchema = z.object({
  text: z.string().min(1).max(5000),
  voiceName: z.string().max(100).optional(),
  languageCode: z.string().regex(/^[a-z]{2,3}-[A-Z]{2}$/).optional(),
  speakingRate: z.number().min(0.25).max(4).optional(),
});

const DEFAULT_VOICE = process.env.TTS_VOICE ?? 'en-US-Standard-A';
const DEFAULT_LANG = process.env.TTS_LANG ?? 'en-US';

export const CURATED_VOICES = [
  { name: 'en-US-Standard-A', languageCode: 'en-US', label: 'Standard A (cheap, free 4M/mo)' },
  { name: 'en-US-Standard-C', languageCode: 'en-US', label: 'Standard C (cheap)' },
  { name: 'en-US-Wavenet-D', languageCode: 'en-US', label: 'Wavenet D (natural)' },
  { name: 'en-US-Neural2-A', languageCode: 'en-US', label: 'Neural2 A' },
  { name: 'en-US-Chirp3-HD-Kore', languageCode: 'en-US', label: 'Chirp 3 HD Kore (best, free 1M/mo)' },
  { name: 'en-US-Chirp3-HD-Aoede', languageCode: 'en-US', label: 'Chirp 3 HD Aoede' },
  { name: 'en-GB-Standard-A', languageCode: 'en-GB', label: 'British Standard A' },
  { name: 'sv-SE-Standard-A', languageCode: 'sv-SE', label: 'Swedish Standard A' },
];

function cachePath(dataDir: string, key: string): string {
  const dir = join(dataDir, 'tts');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${key}.mp3`);
}

export function createTtsRouter(dataDir: string): Router {
const ttsRouter = Router();
ttsRouter.use(express.json({ limit: '32kb' }));

ttsRouter.get('/api/voices', async (_req, res) => {
  // Try live list if credentials exist, fall back to curated.
  try {
    const { TextToSpeechClient } = await import('@google-cloud/text-to-speech');
    const client = new TextToSpeechClient();
    const [r] = await client.listVoices({});
    const voices = (r.voices ?? [])
      .filter((v) => (v.languageCodes ?? []).some((l) => l.startsWith('en') || l.startsWith('sv')))
      .slice(0, 60)
      .map((v) => ({
        name: v.name ?? '',
        languageCode: v.languageCodes?.[0] ?? '',
        label: `${v.name} (${v.ssmlGender})`,
      }));
    if (voices.length > 0) return res.json({ configured: true, voices });
  } catch {
    // fall through to curated
  }
  const configured = !!process.env.GOOGLE_APPLICATION_CREDENTIALS || !!process.env.GOOGLE_API_KEY;
  res.json({ configured, voices: CURATED_VOICES });
});

ttsRouter.post('/api/tts', async (req, res) => {
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { text } = parsed.data;
  const voiceName = parsed.data.voiceName ?? DEFAULT_VOICE;
  const languageCode = parsed.data.languageCode ?? voiceName.split('-').slice(0, 2).join('-') ?? DEFAULT_LANG;
  const speakingRate = parsed.data.speakingRate ?? 1;

  const isChirp = /chirp/i.test(voiceName);
  const key = createHash('sha1').update(`${voiceName}|${languageCode}|${speakingRate}|${text}`).digest('hex');
  const cached = cachePath(dataDir, key);
  if (existsSync(cached)) {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-TTS-Cache', 'HIT');
    return res.send(readFileSync(cached));
  }

  try {
    const { TextToSpeechClient } = await import('@google-cloud/text-to-speech');
    const client = new TextToSpeechClient();
    const [response] = await client.synthesizeSpeech({
      input: { text },
      voice: { languageCode, name: voiceName },
      // Chirp 3 HD rejects speakingRate/pitch — only send it for Standard/Wavenet/Neural2.
      audioConfig: isChirp ? { audioEncoding: 'MP3' } : { audioEncoding: 'MP3', speakingRate },
    });
    const audio = response.audioContent;
    if (!audio) return res.status(502).json({ error: 'TTS returned empty audio' });
    const buf = Buffer.isBuffer(audio) ? audio : Buffer.from(audio as Uint8Array);
    writeFileSync(cached, buf);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-TTS-Cache', 'MISS');
    res.send(buf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.error('[tts] synthesize failed:', msg);
    const hint = /quota project/i.test(msg)
      ? ' You are using user ADC credentials, which need a quota/billing project: run `gcloud auth application-default set-quota-project YOUR_PROJECT_ID` (then `gcloud services enable texttospeech.googleapis.com --project=YOUR_PROJECT_ID`) and restart the API. Or switch to a service-account key via GOOGLE_APPLICATION_CREDENTIALS, which does not need this.'
      : /invalid_grant|metadata from plugin/i.test(msg)
        ? ' Auth is stale/invalid: if GOOGLE_APPLICATION_CREDENTIALS points to an authorized_user file, re-run `gcloud auth application-default login --quota-project=YOUR_PROJECT_ID` and restart the API; if it points to a service-account key, the key was revoked/deleted — create a new key in IAM > Service Accounts and restart the API.'
        : /could not load|ENOENT|auth|credentials|billing|PERMISSION_DENIED|API has not been used/i.test(msg)
          ? ' Set GOOGLE_APPLICATION_CREDENTIALS to your service-account JSON and enable billing + texttospeech.googleapis.com.'
          : '';
    res.status(503).json({ error: `TTS failed: ${msg}.${hint}` });
  }
});
  return ttsRouter;
}

// Back-compat for existing dev entry (uses cwd ./data).
export const ttsRouter = createTtsRouter(join(process.cwd(), 'data'));

#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../../services/render-api/src/app.js';
import { runRender } from './render-cmd.js';
import { runTrack } from './track-cmd.js';
import { runVerify } from './verify-cmd.js';

const execFileAsync = promisify(execFile);

function pkgVersion(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function embeddedPublicDir(): string | null {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
  try {
    if (existsSync(join(dir, 'index.html'))) return dir;
  } catch {
    /* ignore */
  }
  return null;
}

function printHelp(): void {
  console.log(`memeit v${pkgVersion()} — local meme video editor (server + web UI)

Usage: memeit [options] | memeit <command> [options]

Commands (headless, agent-friendly — no server needed):
  verify <project.json>   Validate a project file (schema + media files)
  render <project.json>   Render a project file to MP4 locally (needs ffmpeg)
  track <project.json>    Auto-track a green/blue screen into image keyframes
  (no command)            Start the server + web UI (default)

Examples:
  memeit verify docs/examples/text-only.json
  memeit render docs/examples/text-only.json --out /tmp/meme.mp4
  memeit track meme.json --video bg --target card --out meme.tracked.json

Options:
  -p, --port <n>       Port to listen on (default: $PORT or 3001)
  --host <addr>        Host to bind (default: localhost)
  --data-dir <path>    Job data dir (default: $MEMEIT_DATA_DIR or ./memeit-data)
  --public-dir <path>  Built web UI dir (default: embedded ./public if present)
  --open / --no-open   Open browser on start (default: open when UI is served)
  -h, --help           Show this help
  -v, --version        Show version

Env:
  PORT, MEMEIT_DATA_DIR, MEMEIT_PUBLIC_DIR, YTDLP_PATH
  GOOGLE_APPLICATION_CREDENTIALS (optional, enables cloud TTS voices)

System deps (warn, don't fail, when missing):
  ffmpeg + ffprobe on PATH (rendering), yt-dlp on PATH or YTDLP_PATH (YouTube import)

Examples:
  npx meme-it
  npx meme-it --port 4200 --no-open
  npx meme-it --data-dir ~/.memeit-data
`);
}

type Args = {
  port?: number;
  host?: string;
  dataDir?: string;
  publicDir?: string;
  open?: boolean;
  help?: boolean;
  version?: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-v' || a === '--version') out.version = true;
    else if (a === '-p' || a === '--port') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice('--port='.length));
    else if (a === '--host') out.host = argv[++i];
    else if (a.startsWith('--host=')) out.host = a.slice('--host='.length);
    else if (a === '--data-dir') out.dataDir = argv[++i];
    else if (a.startsWith('--data-dir=')) out.dataDir = a.slice('--data-dir='.length);
    else if (a === '--public-dir') out.publicDir = argv[++i];
    else if (a.startsWith('--public-dir=')) out.publicDir = a.slice('--public-dir='.length);
    else if (a === '--open') out.open = true;
    else if (a === '--no-open') out.open = false;
    else {
      console.error(`unknown argument: ${a}\n`);
      printHelp();
      process.exit(1);
    }
  }
  return out;
}

function openBrowser(url: string): void {
  const [cmd, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '""', url]
        : ['xdg-open', url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* opening the browser is best-effort */
  }
}

async function checkBin(bin: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 15_000 });
    return stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [sub, ...rest] = argv;
  // Headless subcommands (validate / render project JSON without a server).
  if (sub === 'verify') process.exit(runVerify(rest));
  if (sub === 'render') process.exit(await runRender(rest));
  if (sub === 'track') process.exit(await runTrack(rest));
  if (sub === 'help') return printHelp();

  const args = parseArgs(argv);
  if (args.help) return printHelp();
  if (args.version) {
    console.log(pkgVersion());
    return;
  }

  const port = args.port ?? (process.env.PORT ? Number(process.env.PORT) : 3001);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`invalid port: ${args.port ?? process.env.PORT}`);
    process.exit(1);
  }
  const host = args.host ?? 'localhost';
  const dataDir = resolve(args.dataDir ?? process.env.MEMEIT_DATA_DIR ?? join(process.cwd(), 'memeit-data'));
  const publicDir = args.publicDir ?? process.env.MEMEIT_PUBLIC_DIR ?? embeddedPublicDir() ?? undefined;
  const shouldOpen = args.open ?? (publicDir != null);

  mkdirSync(dataDir, { recursive: true });

  const ffmpegVer = await checkBin('ffmpeg', ['-version']);
  if (!ffmpegVer) {
    console.warn('[memeit] WARNING: ffmpeg not found on PATH — /api/health will report unhealthy and renders will fail.');
    console.warn('[memeit] Install it: https://ffmpeg.org/download.html (macOS: `brew install ffmpeg`)');
  }
  const ytVer = await checkBin(process.env.YTDLP_PATH ?? 'yt-dlp', ['--version']);
  if (!ytVer) {
    console.warn('[memeit] NOTE: yt-dlp not found on PATH (or $YTDLP_PATH) — YouTube import will be unavailable; renders/uploads still work.');
  }

  const { app } = createApp({ dataDir, publicDir });
  const server = app.listen(port, host, () => {
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
    console.log(`memeit v${pkgVersion()} on ${url}`);
    console.log(`data: ${dataDir}`);
    console.log(publicDir ? `ui:   ${publicDir}` : '(api-only mode: no web UI found)');
    if (ffmpegVer) console.log(`ffmpeg: ${ffmpegVer}`);
    if (shouldOpen && publicDir) {
      console.log('opening browser…');
      openBrowser(url);
    }
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();

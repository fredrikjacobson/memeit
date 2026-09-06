import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildFfmpegArgs, type ResolvedAsset } from '@memeit/renderer';
import { renderTextPng } from '../../../services/render-api/src/text.js';
import { resolveMediaSrc } from './files.js';
import { formatSummary, loadAndVerify, printReportText } from './verify-cmd.js';

const execFileAsync = promisify(execFile);

export function printUsage(): void {
  console.log(`Usage: memeit render <project.json> [options]

Headless local render: validates the project, resolves media files,
builds the ffmpeg filter graph and writes an MP4. No server needed.

Options:
  --assets-dir <dir>  Where to look for media files (default: project dir)
  --project-dir <dir> Base dir for relative src paths (default: dirname of project.json)
  --out <path>        Output MP4 (default: <project-dir>/out.mp4)
  --dry-run           Print the ffmpeg command without running it
  --force             Render even when verification reports errors
  -h, --help          Show this help

Requires ffmpeg + ffprobe on PATH.
`);
}

async function hasAudioStream(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      path,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

const shQuote = (s: string) => ( /^[a-zA-Z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** CLI entry: returns a process exit code. */
export async function runRender(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    printUsage();
    return 0;
  }
  let projectPath: string | undefined;
  let projectDir: string | undefined;
  let assetsDir: string | undefined;
  let out: string | undefined;
  let dryRun = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run') dryRun = true;
    else if (a === '--force') force = true;
    else if (a === '--assets-dir') assetsDir = argv[++i];
    else if (a.startsWith('--assets-dir=')) assetsDir = a.slice('--assets-dir='.length);
    else if (a === '--project-dir') projectDir = argv[++i];
    else if (a.startsWith('--project-dir=')) projectDir = a.slice('--project-dir='.length);
    else if (a === '--out') out = argv[++i];
    else if (a.startsWith('--out=')) out = a.slice('--out='.length);
    else if (a.startsWith('-')) {
      console.error(`unknown option: ${a}\n`);
      printUsage();
      return 2;
    } else if (!projectPath) {
      projectPath = a;
    } else {
      console.error(`unexpected argument: ${a}\n`);
      printUsage();
      return 2;
    }
  }
  if (!projectPath) {
    console.error('missing <project.json>\n');
    printUsage();
    return 2;
  }

  const loaded = loadAndVerify(projectPath, { projectDir, assetsDir });
  printReportText(loaded.file, loaded.result);
  if (!loaded.result.ok && !force) {
    console.error('\nrefusing to render an invalid project (use --force to override)');
    return 1;
  }
  const project = loaded.result.project;
  if (!project) return 1;

  const outPath = resolve(out ?? join(loaded.projectDir, `${basename(loaded.file, '.json')}.mp4`));

  // Resolve media clips to local files (same rule as verify's checkFiles).
  const assets: ResolvedAsset[] = [];
  let mediaClips = 0;
  for (const c of project.clips) {
    if (c.kind !== 'video' && c.kind !== 'image' && c.kind !== 'audio') continue;
    mediaClips += 1;
    const r = resolveMediaSrc(c.src, loaded.projectDir, loaded.assetsDir);
    if ('path' in r) {
      assets.push({ clipId: c.id, kind: c.kind, path: r.path });
    } else {
      console.warn(`  WARN  [SKIP_CLIP] (${c.id}) ${r.reason} — skipped`);
    }
  }
  if (mediaClips > 0 && assets.length === 0) {
    console.error('\nno media files resolved — re-attach files or fix src paths (text-only projects render fine without any)');
    return 1;
  }

  // Pre-render text overlays to full-frame PNGs (same as the API server).
  const workDir = mkdtempSync(join(tmpdir(), 'memeit-render-'));
  const textPngs: { clipId: string; path: string }[] = [];
  for (const c of project.clips) {
    if (c.kind !== 'text') continue;
    const pngPath = join(workDir, `text-${c.id}.png`);
    await renderTextPng(c, project.width, project.height, pngPath);
    textPngs.push({ clipId: c.id, path: pngPath });
  }

  // Probe base video audio (mirrors services/render-api/src/app.ts).
  const videos = project.clips
    .filter((c) => c.kind === 'video')
    .sort((a, b) => a.startMs - b.startMs);
  let baseHasAudio = false;
  const base = videos[0];
  if (base) {
    const p = assets.find((a) => a.clipId === base.id)?.path;
    if (p && existsSync(p)) baseHasAudio = await hasAudioStream(p);
  }

  const plan = buildFfmpegArgs(project, assets, textPngs, { baseHasAudio }, outPath);
  console.log(`\nplan: ${plan.description} — ${formatSummary(loaded.result)}`);
  for (const w of plan.warnings) console.log(`  WARN  [RENDER] ${w}`);

  if (dryRun) {
    console.log(`\nffmpeg ${plan.args.map(shQuote).join(' ')}`);
    console.log(`(dry run — ${outPath} not written)`);
    return 0;
  }

  console.log(`\nrendering -> ${outPath}`);
  try {
    await execFileAsync('ffmpeg', plan.args, { timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    console.error(`\nffmpeg failed: ${err.message ?? e}`);
    const tail = String(err.stderr ?? '').slice(-3000);
    if (tail) console.error(tail);
    return 1;
  }
  console.log(`done -> ${outPath}`);
  return 0;
}

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { trackGreenScreen, type TrackParams } from '@memeit/tracker';
import { resolveMediaSrc } from './files.js';
import { formatSummary, loadAndVerify, printReportText } from './verify-cmd.js';

export function printUsage(): void {
  console.log(`Usage: memeit track <project.json> --video <id> --target <id> [options]

Auto-track a solid-color screen (green/blue) in a video clip and write the
motion into an image clip's position keyframes — e.g. lock a business card
to a moving phone screen. No new dependencies: ffmpeg extracts frames, sharp
finds the screen's centroid per frame, deltas become keyframes (the card keeps
its manual base alignment; tracking only adds relative motion).

Options:
  --video <id>       Video clip to track (required)
  --target <id>      Image clip receiving keyframes (required)
  --assets-dir <dir> Where to look for media files (default: project dir)
  --project-dir <dir> Base dir for relative src paths (default: dirname of project.json)
  --out <path>       Output project JSON (default: <name>.tracked.json next to input)
  --track-fps <n>    Frames sampled per second (default: 8)
  --threshold <n>    Key-channel dominance margin 0..255 (default: 60)
  --smooth <n>       Centered moving-average window in frames, odd (default: 3, 1 = off)
  --min-delta <f>    Min normalized move to keep a keyframe (default: 0.002)
  --max-keys <n>     Cap on keyframes written (default: 80)
  --roi x,y,w,h      Restrict detection to a source-pixel box (default: full frame)
  --from-ms <n>      Project-time tracking start (default: target clip start)
  --to-ms <n>        Project-time tracking end (default: target clip end)
  --force            Track even when verification reports errors
  -h, --help         Show this help

Key color comes from the video clip's chromaColor (default #00FF00).
Requires ffmpeg + ffprobe on PATH.
`);
}

function parseNum(v: string | undefined, name: string): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`invalid ${name}: ${v}`);
  return n;
}

function parseArgs(argv: string[]): { projectPath?: string; params: TrackParams; extra: { projectDir?: string; assetsDir?: string; out?: string; force: boolean } } | { error: string } {
  const params: TrackParams = { videoId: '', targetId: '' };
  const extra: { projectDir?: string; assetsDir?: string; out?: string; force: boolean } = { force: false };
  let projectPath: string | undefined;
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      const val = (flag: string): string => {
        if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
        const next = argv[++i];
        if (next == null || next.startsWith('-')) throw new Error(`missing value for ${flag}`);
        return next;
      };
      if (a === '-h' || a === '--help') return { projectPath, params, extra: { ...extra, help: true } as typeof extra };
      else if (a === '--force') extra.force = true;
      else if (a === '--video' || a.startsWith('--video=')) params.videoId = val('--video');
      else if (a === '--target' || a.startsWith('--target=')) params.targetId = val('--target');
      else if (a === '--assets-dir' || a.startsWith('--assets-dir=')) extra.assetsDir = val('--assets-dir');
      else if (a === '--project-dir' || a.startsWith('--project-dir=')) extra.projectDir = val('--project-dir');
      else if (a === '--out' || a.startsWith('--out=')) extra.out = val('--out');
      else if (a === '--track-fps' || a.startsWith('--track-fps=')) params.trackFps = parseNum(val('--track-fps'), '--track-fps');
      else if (a === '--threshold' || a.startsWith('--threshold=')) params.threshold = parseNum(val('--threshold'), '--threshold');
      else if (a === '--smooth' || a.startsWith('--smooth=')) params.smooth = Math.max(1, Math.round(parseNum(val('--smooth'), '--smooth')!));
      else if (a === '--min-delta' || a.startsWith('--min-delta=')) params.minDelta = parseNum(val('--min-delta'), '--min-delta');
      else if (a === '--max-keys' || a.startsWith('--max-keys=')) params.maxKeys = Math.max(2, Math.round(parseNum(val('--max-keys'), '--max-keys')!));
      else if (a === '--from-ms' || a.startsWith('--from-ms=')) params.fromMs = parseNum(val('--from-ms'), '--from-ms');
      else if (a === '--to-ms' || a.startsWith('--to-ms=')) params.toMs = parseNum(val('--to-ms'), '--to-ms');
      else if (a === '--roi' || a.startsWith('--roi=')) {
        const parts = val('--roi').split(',').map(Number);
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0)) throw new Error(`invalid --roi (want x,y,w,h): ${val('--roi')}`);
        params.roi = { x: parts[0]!, y: parts[1]!, w: parts[2]!, h: parts[3]! };
      } else if (a.startsWith('-')) return { error: `unknown option: ${a}` };
      else if (!projectPath) projectPath = a;
      else return { error: `unexpected argument: ${a}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  return { projectPath, params, extra };
}

/** CLI entry: returns a process exit code. */
export async function runTrack(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    printUsage();
    return 0;
  }
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    console.error(`${parsed.error}\n`);
    printUsage();
    return 2;
  }
  const { projectPath, params, extra } = parsed;
  if ((extra as { help?: boolean }).help) {
    printUsage();
    return 0;
  }
  if (!projectPath) {
    console.error('missing <project.json>\n');
    printUsage();
    return 2;
  }
  if (!params.videoId || !params.targetId) {
    console.error('missing --video <id> and/or --target <id>\n');
    printUsage();
    return 2;
  }

  const loaded = loadAndVerify(projectPath, { projectDir: extra.projectDir, assetsDir: extra.assetsDir });
  printReportText(loaded.file, loaded.result);
  if (!loaded.result.ok && !extra.force) {
    console.error('\nrefusing to track an invalid project (use --force to override)');
    return 1;
  }
  const project = loaded.result.project;
  if (!project) return 1;

  const video = project.clips.find((c) => c.id === params.videoId);
  if (!video || video.kind !== 'video') {
    console.error(`video clip "${params.videoId}" not found`);
    return 1;
  }
  const r = resolveMediaSrc(video.src, loaded.projectDir, loaded.assetsDir);
  if (!('path' in r)) {
    console.error(`video "${video.id}" media not resolved (${r.reason})`);
    return 1;
  }

  let result;
  try {
    result = await trackGreenScreen(project, r.path, params);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  // Mutate the raw JSON (not the zod-stripped parse) so unknown fields survive.
  const rawJson = JSON.parse(readFileSync(loaded.file, 'utf8')) as {
    clips?: { id?: string; keyframes?: unknown }[];
  };
  const rawTarget = rawJson.clips?.find((c) => c?.id === params.targetId);
  if (!rawTarget) {
    console.error(`target clip "${params.targetId}" missing in ${loaded.file}`);
    return 1;
  }
  const replaced = Array.isArray(rawTarget.keyframes) ? rawTarget.keyframes.length : 0;
  rawTarget.keyframes = result.keyframes;
  const outPath = resolve(extra.out ?? join(loaded.projectDir, `${basename(loaded.file, '.json')}.tracked.json`));
  writeFileSync(outPath, `${JSON.stringify(rawJson, null, 2)}\n`);

  console.log(`tracked ${params.videoId} ${result.stats.windowStartMs}-${result.stats.windowEndMs}ms: ${result.summary}`);
  console.log(`wrote ${result.keyframes.length} keyframes to ${params.targetId} (replaced ${replaced}) -> ${outPath} — ${formatSummary(loaded.result)}`);
  return 0;
}

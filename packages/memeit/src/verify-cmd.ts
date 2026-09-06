import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { verifyProject, type FileCheck, type Project, type VerifyResult } from '@memeit/timeline';
import { resolveMediaSrc } from './files.js';

export type LoadedProject = {
  file: string;
  projectDir: string;
  assetsDir: string;
  result: VerifyResult;
  project: Project | null;
};

export function printUsage(): void {
  console.log(`Usage: memeit verify <project.json> [options]

Validates a memeit project file (schema + semantic checks + media files).

Options:
  --assets-dir <dir>  Where to look for media files (default: project dir)
  --project-dir <dir> Base dir for relative src paths (default: dirname of project.json)
  --json              Machine-readable output (exit codes unchanged)
  --strict            Exit 1 when there are warnings, not just errors
  -h, --help          Show this help

Exit codes: 0 = valid (or warnings only), 1 = errors/IO failure.
`);
}

export function formatSummary(result: VerifyResult): string {
  const s = result.summary;
  if (!s) return '(unparseable)';
  return `${s.clips} clips (${s.video} video, ${s.image} image, ${s.text} text, ${s.audio} audio), ${s.width}x${s.height}@${s.fps}fps, ${s.durationMs}ms`;
}

export function printReportText(file: string, result: VerifyResult): void {
  console.log(`verify: ${file}`);
  if (result.ok && result.warnings.length === 0) {
    console.log(`ok — ${formatSummary(result)}`);
    return;
  }
  console.log(`${result.ok ? 'ok with warnings' : 'FAILED'} — ${formatSummary(result)}`);
  for (const e of result.errors) {
    console.log(`  ERROR [${e.code}]${e.clipId ? ` (${e.clipId})` : ''} ${e.message}`);
  }
  for (const w of result.warnings) {
    console.log(`  WARN  [${w.code}]${w.clipId ? ` (${w.clipId})` : ''} ${w.message}`);
  }
}

/** Read + parse + verify a project file. Never throws — failures land in `result`. */
export function loadAndVerify(
  projectPath: string,
  opts: { projectDir?: string; assetsDir?: string } = {}
): LoadedProject {
  const file = resolve(projectPath);
  const projectDir = resolve(opts.projectDir ?? dirname(file));
  const assetsDir = resolve(opts.assetsDir ?? projectDir);

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    const result: VerifyResult = {
      ok: false,
      errors: [{ level: 'error', code: 'READ_ERROR', message: `cannot read ${file}: ${String(e)}` }],
      warnings: [],
      project: null,
      summary: null,
    };
    return { file, projectDir, assetsDir, result, project: null };
  }

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    const result: VerifyResult = {
      ok: false,
      errors: [{ level: 'error', code: 'JSON_PARSE', message: `invalid JSON in ${basename(file)}: ${String(e)}` }],
      warnings: [],
      project: null,
      summary: null,
    };
    return { file, projectDir, assetsDir, result, project: null };
  }

  const checkFiles: FileCheck = (clip) => {
    const r = resolveMediaSrc(clip.src, projectDir, assetsDir);
    if ('path' in r) return { found: true };
    return { found: false, detail: r.reason };
  };

  const result = verifyProject(input, { checkFiles });
  return { file, projectDir, assetsDir, result, project: result.project };
}

/** CLI entry: returns a process exit code. */
export function runVerify(argv: string[]): number {
  if (argv.includes('-h') || argv.includes('--help')) {
    printUsage();
    return 0;
  }
  let projectPath: string | undefined;
  let projectDir: string | undefined;
  let assetsDir: string | undefined;
  let json = false;
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') json = true;
    else if (a === '--strict') strict = true;
    else if (a === '--assets-dir') assetsDir = argv[++i];
    else if (a.startsWith('--assets-dir=')) assetsDir = a.slice('--assets-dir='.length);
    else if (a === '--project-dir') projectDir = argv[++i];
    else if (a.startsWith('--project-dir=')) projectDir = a.slice('--project-dir='.length);
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
  if (json) {
    console.log(
      JSON.stringify(
        {
          file: loaded.file,
          ok: loaded.result.ok,
          strict,
          summary: loaded.result.summary,
          errors: loaded.result.errors,
          warnings: loaded.result.warnings,
        },
        null,
        2
      )
    );
  } else {
    printReportText(loaded.file, loaded.result);
  }

  if (!loaded.result.ok) return 1;
  if (strict && loaded.result.warnings.length > 0) return 1;
  return 0;
}

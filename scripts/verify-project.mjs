#!/usr/bin/env node
// Validates a Project JSON file against the canonical zod schema, and
// (unless --no-render) proves it actually renders by self-starting a
// render-api instance in-process and driving the real /api/renders flow.
//
// Requires `pnpm -r build` to have run first, so @memeit/timeline and
// @memeit/render-api have built `dist/` output (see docs/project-format.md
// and docs/render-api.md for the format/API this script exercises).
//
// Usage:
//   node scripts/verify-project.mjs <project.json> [--assets id=path ...] [--no-render] [--timeout-ms N]
//
// Exit codes: 0 = ok, 1 = validation/render failure, 2 = usage error.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function printUsage() {
  console.error(`Usage: node scripts/verify-project.mjs <project.json> [options]

Options:
  --assets id=path       Map a clip id to a local asset file (repeatable).
                          Only used for the render check; field name = clip id,
                          NOT the clip's "src" — see docs/render-api.md.
  --no-render             Validate the schema only, skip the render check.
  --timeout-ms <n>        Max time to wait for the render job (default 120000).
`);
}

function parseArgs(argv) {
  const out = { projectPath: null, assets: [], noRender: false, timeoutMs: 120_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--assets') {
      const pair = argv[++i];
      const eq = pair?.indexOf('=') ?? -1;
      if (!pair || eq <= 0) throw new Error(`--assets expects id=path, got: ${pair ?? '(none)'}`);
      out.assets.push([pair.slice(0, eq), pair.slice(eq + 1)]);
    } else if (a === '--no-render') {
      out.noRender = true;
    } else if (a === '--timeout-ms') {
      out.timeoutMs = Number(argv[++i]);
    } else if (a === '-h' || a === '--help') {
      out.help = true;
    } else if (!a.startsWith('--') && out.projectPath == null) {
      out.projectPath = a;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

async function waitListening(server) {
  await new Promise((res, rej) => {
    server.once('listening', res);
    server.once('error', rej);
  });
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message ?? e));
    printUsage();
    process.exit(2);
  }
  if (args.help || !args.projectPath) {
    printUsage();
    process.exit(args.help ? 0 : 2);
  }

  let raw;
  try {
    raw = readFileSync(resolve(args.projectPath), 'utf8');
  } catch (e) {
    console.error(`Could not read ${args.projectPath}: ${e.message ?? e}`);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error(`Invalid JSON in ${args.projectPath}: ${e.message ?? e}`);
    process.exit(1);
  }

  const { ProjectSchema } = await import(join(repoRoot, 'packages/timeline/dist/index.js'));
  const parsed = ProjectSchema.safeParse(data);
  if (!parsed.success) {
    console.error(`Project failed schema validation (${args.projectPath}):`);
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || '(root)';
      console.error(`  ${path}: ${issue.message} [${issue.code}]`);
    }
    process.exit(1);
  }
  const project = parsed.data;
  const byKind = project.clips.reduce((m, c) => ((m[c.kind] = (m[c.kind] ?? 0) + 1), m), {});
  const kindsSummary = Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ') || 'no clips';
  console.log(
    `Project OK — ${project.width}x${project.height}@${project.fps}fps, ${project.durationMs}ms, ${kindsSummary}`
  );

  if (args.noRender) {
    console.log('Skipping render check (--no-render).');
    process.exit(0);
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'memeit-verify-'));
  const { createApp } = await import(join(repoRoot, 'services/render-api/dist/app.js'));
  const { app } = createApp({ dataDir, publicDir: null });
  const server = app.listen(0, '127.0.0.1');
  await waitListening(server);
  const base = `http://127.0.0.1:${server.address().port}`;

  let exitCode = 0;
  try {
    const health = await fetch(`${base}/api/health`)
      .then((r) => r.json())
      .catch(() => null);
    if (!health?.ok) {
      console.error(
        'ffmpeg not available on PATH — cannot verify render. Install ffmpeg (https://ffmpeg.org/download.html), or pass --no-render to validate the schema only.'
      );
      exitCode = 1;
      return;
    }

    const fd = new FormData();
    fd.append('project', JSON.stringify(project));
    for (const [id, path] of args.assets) {
      const bytes = readFileSync(resolve(path));
      fd.append(id, new Blob([bytes]), basename(path));
    }

    const postRes = await fetch(`${base}/api/renders`, { method: 'POST', body: fd });
    const postJson = await postRes.json();
    if (!postRes.ok) {
      console.error('Render request failed:', postJson);
      exitCode = 1;
      return;
    }
    const jobId = postJson.jobId;
    console.log(`Render job ${jobId} queued...`);

    const deadline = Date.now() + args.timeoutMs;
    let job = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      job = await fetch(`${base}/api/renders/${jobId}`).then((r) => r.json());
      if (job.status === 'done' || job.status === 'error') break;
    }

    if (!job || (job.status !== 'done' && job.status !== 'error')) {
      console.error(`Render did not finish within ${args.timeoutMs}ms (last status: ${job?.status ?? 'unknown'}).`);
      exitCode = 1;
      return;
    }
    if (job.status === 'error') {
      console.error('Render failed:');
      console.error(job.log);
      exitCode = 1;
      return;
    }
    if (job.warnings?.length) {
      console.log('Warnings:');
      for (const w of job.warnings) console.log(`  - ${w}`);
    }
    console.log(`Render succeeded: ${base}/api/renders/${jobId}/file`);
  } finally {
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

await main();

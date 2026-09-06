# AGENTS.md — writing and rendering memes programmatically

This repo is `memeit`, a local meme video editor. As an agent you don't need the
web UI: **write a `project.json`, verify it, render it to MP4**.

Start with the canonical docs (kept in sync with the zod source of truth —
don't duplicate their field tables here):

- [`docs/project-format.md`](docs/project-format.md) — `Project`/clip JSON
  reference, coordinate conventions, known limitations, worked example.
- [`docs/render-api.md`](render-api.md) — the `POST /api/renders` HTTP
  contract (note: `-F "project=<file"` with `<`, not `@`; field name = clip id).
  `POST /api/tracks` (same multipart shape) auto-tracks a screen into image
  keyframes and returns them as JSON — prefer it over hand-writing keyframes.
- [`packages/timeline/schema/project.schema.json`](packages/timeline/schema/project.schema.json) —
  generated JSON Schema (regenerated from zod every build; never drifts).
  Point your file at it via `"$schema"` so editors validate live.

Examples in [`docs/examples/`](docs/examples/):

- `basic-project.json` (+ `sample.mp4`) — video + sliding caption, used by the
  canonical verify script.
- `text-only.json` — captions over black; renders with **zero media files**
  (best smoke test).
- `image-overlay.json` — image + sequenced captions; needs a `photo.jpg` in
  `docs/examples/assets/` (absent on purpose — verify reports `MISSING_FILE`).

## Quick local loop (no server)

```bash
pnpm install                                   # once
cp docs/examples/text-only.json /tmp/meme/project.json
pnpm verify /tmp/meme/project.json             # schema + semantic + file checks (~0.1s)
pnpm render /tmp/meme/project.json --out /tmp/meme/out.mp4
ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/meme/out.mp4
```

`verify` / `render` build their (small, UI-less) prerequisites and delegate to
the `memeit verify` / `memeit render` subcommands (`packages/memeit/src/cli.ts`).
Only `ffmpeg` + `ffprobe` on PATH are needed. The slower end-to-end check
(same verdict core + real render through the API server) is
`pnpm verify:api <project.json> [--assets id=path ...]`
(`scripts/verify-project.mjs`).

## `memeit verify` issue codes

`memeit verify <project.json> [--assets-dir <dir>] [--json] [--strict]`
runs `ProjectSchema` plus the semantic checks in
`verifyProject(input, { checkFiles })` (`packages/timeline/src/verify.ts` —
pure, no I/O). Exit 0 = valid (warnings ok) · 1 = errors (or warnings with
`--strict`) · 2 = usage/IO.

- `ERROR` (blocks `render`): `SCHEMA`, `JSON_PARSE`, `DUPLICATE_ID`
  (the schema can't enforce this — see `docs/project-format.md#known-limitations`),
  `CLIP_START_BEYOND_DURATION`, `KEYFRAME_OUT_OF_RANGE`, `SRC_EMPTY`,
  `CANVAS_WIDTH/HEIGHT`.
- `WARN` (render proceeds, quality may suffer): `MISSING_FILE` (clip skipped),
  `CLIP_OVERFLOW` (tail cut), `V1_EXTRA_VIDEO`,
  `KEYFRAME_FONTSIZE_PREVIEW_ONLY`, `H264_ODD_DIMENSIONS`, `BG_IMAGE_MISSING`,
  `SRC_REMOTE`/`SRC_UNRESOLVED`.

`memeit render <project.json> --out out.mp4 [--assets-dir <dir>] [--dry-run]
[--force]` validates first (refuses on errors unless `--force`), resolves
`src` relative to the project dir, and runs the same `buildFfmpegArgs` filter
graph as the server (H.264 + AAC, `+faststart`).

`memeit track <project.json> --video <id> --target <id> [--assets-dir <dir>]
[--out tracked.json]` auto-tracks a solid-color screen in the video clip
(ffmpeg frames + sharp centroid, no new deps) and writes the relative motion
as position keyframes on the image clip — the card keeps its manual base
alignment, tracking only adds deltas. Key color comes from the video clip's
`chromaColor`. Narrow `--from-ms/--to-ms` to the stable full-screen segment;
entry/exit slivers are auto-dropped.

## Agent checklist

1. Copy the closest example; keep `"$schema"`.
2. Read `docs/project-format.md#known-limitations` first (single base video,
   font-size keyframes preview-only, caller-owned id uniqueness).
3. `pnpm verify` → fix every `ERROR`; read every `WARN`.
4. `pnpm render --out …` → confirm with `ffprobe`
   (duration ≈ `durationMs`).
5. For the canonical check, `pnpm verify:api <project.json>` (same verdict
   core + real render through the API server).

Repo map: `packages/timeline` (schemas/types/semantic verify) ·
`packages/renderer` (`buildFfmpegArgs`) · `services/render-api` (HTTP API +
text PNG pre-render) · `packages/memeit` (CLI: serve/verify/render/track) ·
`apps/web` (editor UI) · `docs/` (agent docs + examples) ·
`scripts/verify-project.mjs` (same verdict core + API render check).

# Render API

The render service (`services/render-api`, also embedded in `npx memeit`) is a plain
Express HTTP server — no browser involved. This document is the contract for driving it
directly (e.g. from an agent or a script), given a `Project` JSON as described in
[`docs/project-format.md`](project-format.md).

## Running the server

```bash
pnpm --filter @memeit/render-api dev   # dev server on :3001
# or
npx memeit --no-open                   # embeds the same server + built UI
```

## `GET /api/health`

Preflight check — call this before assuming a render will work.

```json
{ "ok": true, "ffmpeg": "ffmpeg version 7.1.1 ..." }
```

If `ffmpeg`/`ffprobe` aren't on `PATH`, this returns `{ "ok": false, "error": "..." }`
with HTTP 500, and any render will fail.

## `POST /api/renders`

Multipart form data with exactly one non-file field and zero-or-more file fields:

- **`project`** (text field, *not* a file): the `Project` JSON, as a string (e.g.
  `JSON.stringify(project)`). Validated server-side against the same schema described in
  `docs/project-format.md`; an invalid project gets HTTP 400 with
  `{ "error": <zod flatten() output> }`.

  With `curl`, `-F project=@file.json` sends it as a **file** upload (with a filename),
  which lands in `req.files`, not `req.body.project` — the server will reject it with
  `{"error":"missing project field"}`. Use `-F "project=<file.json"` (a leading `<`, not
  `@`) instead, which reads the file's content into a plain field with no filename
  attached (see the worked example below).
- **one file field per `video`/`image`/`audio` clip that needs actual bytes.**

### The one rule that matters most: field name = clip `id`, not `src`

> **Every uploaded file's multipart field name must be exactly that clip's `id`.**
> The `src` string inside the `Project` JSON is descriptive only and is **never** used
> to look up a file server-side.

```
❌ Wrong:  -F "cat.mp4=@./cat.mp4"
✅ Right:  -F "bg=@./cat.mp4"      # clip { "id": "bg", "src": "cat.mp4", ... }
```

A clip with no matching file field (and no cached file from a previous attempt at the
same job) is simply skipped — video/audio clips get silently dropped, images get skipped
with a warning. There's no error for a "missing" file; check the job's `warnings` (below).

### Response

```json
{ "jobId": "a1b2c3d4", "status": "queued", "warnings": [] }
```

`warnings` can already be non-empty here — e.g. "N extra video clip(s) ignored" or
"Font-size keyframes (...) are preview-only" (see `docs/project-format.md#known-limitations`).

## `GET /api/renders/:id`

Poll this until `status` is `done` or `error`:

```json
{ "id": "a1b2c3d4", "status": "rendering", "log": "...", "warnings": [] }
```

`status` is one of `queued | rendering | done | error`. `log` accumulates the render
plan description and, on failure, the tail of ffmpeg's stderr.

## `GET /api/renders/:id/file`

Once `status === 'done'`, downloads the rendered `.mp4`. Returns HTTP 409 with the job's
`log` if called before the job is done, or 404 if the job id doesn't exist.

## Complete example

Using the fixture from `docs/project-format.md` (clip ids `bg` and `caption`; only `bg`
needs an uploaded file — `caption` is a text clip, rendered server-side from its own
`text` field, no upload needed):

```bash
curl -F "project=<docs/examples/basic-project.json" \
     -F "bg=@docs/examples/sample.mp4" \
     http://localhost:3001/api/renders
# => {"jobId":"a1b2c3d4","status":"queued","warnings":[]}

curl http://localhost:3001/api/renders/a1b2c3d4
# repeat until status is "done" (or "error")

curl -OJ http://localhost:3001/api/renders/a1b2c3d4/file
```

## Automated verification

`scripts/verify-project.mjs` (shortcut: `pnpm verify:api <project.json> [--assets id=path ...]`) validates a
`Project` JSON — same verdict core as `memeit verify` (schema + semantic
checks) — and, unless `--no-render` is passed, self-starts a render-api
instance in-process and drives this exact flow end-to-end — the same round
trip described above, so it doubles as a regression check that this document
stays accurate:

```bash
# schema only
node scripts/verify-project.mjs docs/examples/basic-project.json --no-render

# schema + a real render (spins up its own server, no manual setup needed)
node scripts/verify-project.mjs docs/examples/basic-project.json --assets bg=docs/examples/sample.mp4
```

Exit code `0` on success, `1` on a schema or render failure, `2` on bad CLI usage. See
`node scripts/verify-project.mjs --help` for all options.

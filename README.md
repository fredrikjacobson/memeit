# memeit — meme video editor

Web app, local single-user. 10s typical, up to 3 min.

## Run

```bash
pnpm install
pnpm --filter @memeit/render-api dev  # :3001
pnpm --filter @memeit/web dev          # :5173
```

## Run as one server (`npx memeit`)

```bash
pnpm --filter meme-it build
node packages/memeit/dist/cli.js --no-open   # serves API + built UI on :3001
# after `npm publish`: npx meme-it
```

Publishable package in `packages/memeit/` (`bin: memeit`, tsup bundle + embedded
`apps/web` build). Details: `packages/memeit/README.md`.

## Flow

1. Import video/image/audio in MediaBin (preview via blob URLs).
2. Add timed captions, scrub timeline, edit in Inspector.
3. Render MP4 -> `POST /api/renders` (ffmpeg stub now, full filter_complex next).

## For agents / API consumers

The project JSON format and render API are documented independently of this UI —
useful for writing/rendering memes programmatically:

- [`docs/project-format.md`](docs/project-format.md) — the `Project`/clip JSON schema
  (also available as generated JSON Schema: `packages/timeline/schema/project.schema.json`).
- [`docs/render-api.md`](docs/render-api.md) — the `POST /api/renders` HTTP contract.
- `node scripts/verify-project.mjs <project.json> [--assets id=path ...]` validates a
  project against the schema and, by default, test-renders it end-to-end (self-starts a
  render-api instance, no manual server setup needed). Run `pnpm -r build` first.

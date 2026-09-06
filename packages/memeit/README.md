# meme-it (npx distribution)

Local meme video editor — one command runs the API + web UI:

```bash
npx meme-it
npx meme-it --port 4200 --no-open
npx meme-it --data-dir ~/.memeit-data
```

## How it works

* `src/cli.ts` parses args, checks `ffmpeg`/`yt-dlp`, then starts the Express app from
  `services/render-api/src/app.ts` via `createApp({ dataDir, publicDir })`.
  With a `verify`/`render` subcommand it instead validates or renders a
  project file headlessly (no server) — see [AGENTS.md](../../AGENTS.md).
* The web UI is the production `apps/web` build, copied to `public/` at build time
  (`scripts/build-ui.mjs`) and served with the COOP/COEP headers the WASM background
  removal needs. Non-`/api` GETs fall back to `index.html` (SPA).
* `tsup` bundles `src/cli.ts` + `services/render-api/src` + `@memeit/*` workspace
  packages into a single `dist/cli.js`. Runtime npm deps stay external
  (`express`, `sharp`, `zod`, …); `@google-cloud/text-to-speech` is optional
  (dynamically imported — TTS endpoints 503 with a hint when unconfigured).

## Build / publish

```bash
pnpm install
pnpm --filter meme-it build        # web UI -> public/, server -> dist/cli.js
pnpm --filter meme-it typecheck
cd packages/memeit && npm publish --access public  # note: npm can't see pnpm workspaces, publish from the package dir
```

Test the tarball locally before publishing:

```bash
pnpm --filter meme-it build
(cd packages/memeit && npm pack --pack-destination /tmp)
npx --yes /tmp/meme-it-0.1.0.tgz --help
```

## System deps (not bundled)

* `ffmpeg` + `ffprobe` on `PATH` — required for renders (`brew install ffmpeg`).
  Missing binary warns at startup and `/api/health` reports it.
* `yt-dlp` on `PATH` or `$YTDLP_PATH` — optional, only for YouTube import.
  The macOS-only `bin/yt-dlp` in this repo is dev-only (git-ignored) and is NOT shipped.

# memeit — meme video editor

Web app, local single-user. 10s typical, up to 3 min.

## Run

```bash
pnpm install
pnpm --filter @memeit/render-api dev  # :3001
pnpm --filter @memeit/web dev          # :5173
```

## Flow

1. Import video/image/audio in MediaBin (preview via blob URLs).
2. Add timed captions, scrub timeline, edit in Inspector.
3. Render MP4 -> `POST /api/renders` (ffmpeg stub now, full filter_complex next).

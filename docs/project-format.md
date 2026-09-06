# Project format

A **Project** is the JSON document that describes a meme/video: canvas size, frame rate,
duration, and a flat list of **clips** (video, image, text, audio) placed on a single timeline.

This document is written for anyone — human or AI agent — writing `Project` JSON from
scratch, without having read the source. The canonical, always-up-to-date source of truth
is the zod schema at [`packages/timeline/src/index.ts`](../packages/timeline/src/index.ts)
(`ProjectSchema`, `AnyClipSchema`); a generated JSON Schema for non-TypeScript tooling
lives at [`packages/timeline/schema/project.schema.json`](../packages/timeline/schema/project.schema.json)
and is regenerated from that same zod schema on every build (see `gen:schema` in
`packages/timeline/package.json`) — it can never drift from this document's field tables below.

Once you have a `Project` JSON, see [`docs/render-api.md`](render-api.md) for how to
actually render it to a video file, and `scripts/verify-project.mjs` (below) to validate
and test-render one from the command line.

## Known limitations — read this first

1. **Font-size keyframes are preview-only.** Position (`x`/`y`) keyframes on a text clip
   *are* honored by the final render, but a keyframe's `fontSize` is not — the export
   always uses the clip's base `fontSize`. Only animate `x`/`y` if you need the exported
   video (not just the live editor preview) to match.
2. **Only one video clip renders.** If a project has multiple `video` clips, only the one
   with the earliest `startMs` is used as the render's base layer; the rest are silently
   dropped (with a warning in the render job's `warnings` array — see `docs/render-api.md`).
   Use `image`/`audio`/`text` clips layered on top of a single base video instead.
3. **`id` uniqueness is the caller's responsibility.** IDs are plain strings compared for
   equality; nothing in the schema enforces uniqueness within a project. The editor
   generates them with `uid()` (a `crypto.randomUUID()`), but an agent generating a
   project from scratch must ensure its own clip ids don't collide — this matters because
   file uploads for the render API are matched to clips **by id** (see `docs/render-api.md`).

## Top-level `Project`

| Field | Type | Range / default | Required |
|---|---|---|---|
| `version` | `number` | must be exactly `1` | **yes** (no default) |
| `width` | `number` | default `1080` | no |
| `height` | `number` | default `1920` | no |
| `fps` | `number` | 15–60, default `30` | no |
| `durationMs` | `number` | 500–300000, default `10000` | no |
| `clips` | array of clips (below) | default `[]` | no |

`durationMs` is the render's total length — clips extending past it are simply cut off.

## Coordinate systems

Two different, intentionally different, conventions are used:

- **Clip-level `x`/`y`** (on `video`, `image`, and `text` clips): normalized offsets from
  canvas center, conventionally in **-0.5..0.5** (`0,0` = centered). This isn't enforced
  by the schema — the renderer allows panning off-canvas on purpose — but agents/tools
  generating projects should stick to this range unless deliberately positioning something
  off-screen.
- **`Keyframe.x`/`y`**: strictly **-1..1**, enforced by the schema. This is a wider range
  because a keyframe describes a motion *target* across the full canvas span, not a
  centered offset — interpolation runs directly between a clip's base `x`/`y` and each
  keyframe's `x`/`y`, in whatever units each happens to use.

## Clip kinds

Every clip (any kind) has these base fields:

| Field | Type | Range / default | Required |
|---|---|---|---|
| `id` | `string` | — | **yes** |
| `name` | `string` | — | no |
| `startMs` | `number` | 0–300000 | **yes** |
| `durationMs` | `number` | 100–300000 | **yes** |
| `kind` | `'video' \| 'image' \| 'text' \| 'audio'` | — | **yes** |

### `video`

| Field | Type | Range / default | Required |
|---|---|---|---|
| `src` | `string` | — | **yes** (descriptive only, see below) |
| `volume` | `number` | 0–1, default `1` | no |
| `scale` | `number` | 0.1–4, default `1` | no |
| `x`, `y` | `number` | default `0` | no |
| `srcOffsetMs` | `number` | 0–300000, default `0` | no |
| `fit` | `'cover' \| 'contain' \| 'stretch'` | default `'cover'` | no |
| `bgRemove` | `'off' \| 'chroma' \| 'ai'` | default `'off'` | no |
| `bgAiSrc`, `bgAiStatus`, `bgAiProgress`, `bgAiModel`, `bgAiError` | — | client-side AI cutout state | no |
| `chromaColor` | `string` (hex) | default `'#00FF00'` | no |
| `chromaSimilarity`, `chromaBlend` | `number` | 0–1, default `0.3` / `0.1` | no |
| `bgReplace` | `'black' \| 'color' \| 'image'` | default `'black'` | no |
| `bgColor` | `string` (hex) | default `'#000000'` | no |
| `bgImageClipId` | `string` | id of an `image` clip | no |

`fit`: `cover` fills and crops, `contain` fits inside with black letterboxing, `stretch`
fills exactly (may distort). `bgRemove: 'ai'` expects `bgAiSrc` to already be a
transparent-alpha WebM (client-side ML segmentation output) — an agent producing projects
programmatically should generally leave `bgRemove: 'off'` unless it's also supplying that
pre-cut asset.

### `image`

| Field | Type | Range / default | Required |
|---|---|---|---|
| `src` | `string` | — | **yes** (descriptive only) |
| `scale` | `number` | 0.1–4, default `1` | no |
| `x`, `y` | `number` | default `0` | no |
| `bgRemove` | `'off' \| 'ai'` | default `'off'` | no |
| `bgAiSrc`, `bgAiStatus`, `bgAiProgress`, `bgAiModel`, `bgAiError` | — | client-side AI cutout state | no |

### `text`

| Field | Type | Range / default | Required |
|---|---|---|---|
| `text` | `string` | 1–280 chars | **yes** |
| `font` | `string` | default `'Impact'` | no |
| `fontSize` | `number` | 12–200, default `64` | no |
| `color` | `string` (hex) | default `'#ffffff'` | no |
| `strokeColor` | `string` (hex) | default `'#000000'` | no |
| `strokeWidth` | `number` | 0–20, default `4` | no |
| `x`, `y` | `number` | default `0` / `-0.35` | no |
| `keyframes` | array of `Keyframe` | default `[]` | no |

`text` is rendered uppercase automatically. A `Keyframe` is:

| Field | Type | Range | Required |
|---|---|---|---|
| `id` | `string` | — | **yes** |
| `offsetMs` | `number` | 0–300000, relative to the clip's own `startMs` | **yes** |
| `x`, `y` | `number` | **-1..1** | **yes** |
| `fontSize` | `number` | 12–200 | no (preview-only, see limitations above) |

There's always an implicit keyframe at `offsetMs: 0` equal to the clip's own base `x`/`y`
— you don't need to add one yourself unless you want to explicitly override it.

### `audio`

| Field | Type | Range / default | Required |
|---|---|---|---|
| `src` | `string` | — | **yes** (descriptive only) |
| `volume` | `number` | 0–2, default `1` | no |
| `srcOffsetMs` | `number` | 0–300000, default `0` | no |

## Worked example

[`docs/examples/basic-project.json`](examples/basic-project.json) — a 4-second, 1080×1920
project with one background video and one text clip whose caption slides from the top of
the frame to the bottom over the clip's duration (demonstrating position keyframes):

```json
{
  "version": 1,
  "width": 1080,
  "height": 1920,
  "fps": 30,
  "durationMs": 4000,
  "clips": [
    {
      "id": "bg",
      "kind": "video",
      "startMs": 0,
      "durationMs": 4000,
      "src": "sample.mp4",
      "fit": "cover"
    },
    {
      "id": "caption",
      "kind": "text",
      "startMs": 0,
      "durationMs": 4000,
      "text": "when the render finally works",
      "x": 0,
      "y": -0.35,
      "fontSize": 64,
      "keyframes": [
        { "id": "k1", "offsetMs": 0, "x": 0, "y": -0.35 },
        { "id": "k2", "offsetMs": 4000, "x": 0, "y": 0.35 }
      ]
    }
  ]
}
```

Note `"src": "sample.mp4"` on the `bg` clip — that string is **purely descriptive**. See
[`docs/render-api.md`](render-api.md) for how the actual video bytes get attached to this
clip when rendering (hint: it's matched by the clip's `id`, `"bg"`, not by this `src`
string).

## Validating a project

```bash
node scripts/verify-project.mjs docs/examples/basic-project.json --no-render
```

See [`docs/render-api.md`](render-api.md) for the full render-and-verify flow.

import { bgImageIds, ProjectSchema, type AnyClip, type Project } from './index.js';

export type VerifyIssueLevel = 'error' | 'warning';

export type VerifyIssue = {
  level: VerifyIssueLevel;
  code: string;
  message: string;
  clipId?: string;
};

export type VerifySummary = {
  clips: number;
  video: number;
  image: number;
  text: number;
  audio: number;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
};

export type VerifyResult = {
  ok: boolean;
  errors: VerifyIssue[];
  warnings: VerifyIssue[];
  project: Project | null;
  summary: VerifySummary | null;
};

/**
 * Optional file check injected by the caller (the timeline package itself is
 * platform-agnostic, so it never touches the filesystem).
 *
 * Return `{ found: true }` when the clip's media resolves, otherwise
 * `{ found: false, detail }` with a human-readable reason (e.g. which paths
 * were tried). Return `null`/`undefined` to skip the check for that clip
 * (e.g. remote URLs the caller handles separately).
 */
export type FileCheck = (
  clip: Extract<AnyClip, { kind: 'video' | 'image' | 'audio' }>
) => { found: boolean; detail?: string } | null | undefined;

export type VerifyOptions = {
  checkFiles?: FileCheck;
};

const err = (code: string, message: string, clipId?: string): VerifyIssue => ({
  level: 'error',
  code,
  message,
  clipId,
});

const warn = (code: string, message: string, clipId?: string): VerifyIssue => ({
  level: 'warning',
  code,
  message,
  clipId,
});

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;

function isRemoteSrc(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

function isUnresolvedRef(src: string): boolean {
  return src.startsWith('blob:') || src.startsWith('missing:');
}

/**
 * Validate unknown input as a memeit project.
 *
 * Runs in two layers:
 * 1. zod `ProjectSchema` — types, ranges, enums (failures are `errors`).
 * 2. semantic checks — cross-field rules the schema can't express
 *    (duplicate ids, clips overflowing the timeline, dangling
 *    `bgImageClipId`, V1 renderer limitations, …).
 *
 * Pure function: no I/O. Pass `opts.checkFiles` to also verify that media
 * `src` values resolve to real files.
 */
export function verifyProject(input: unknown, opts: VerifyOptions = {}): VerifyResult {
  const errors: VerifyIssue[] = [];
  const warnings: VerifyIssue[] = [];

  const parsed = ProjectSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      errors.push(err('SCHEMA', `${path}: ${issue.message}`));
    }
    return { ok: false, errors, warnings, project: null, summary: null };
  }
  const project = parsed.data;

  // --- canvas sanity (zod only enforces defaults/presence) ---
  if (!Number.isInteger(project.width) || project.width < 16 || project.width > 4096) {
    errors.push(err('CANVAS_WIDTH', `width must be an integer 16..4096, got ${project.width}`));
  }
  if (!Number.isInteger(project.height) || project.height < 16 || project.height > 4096) {
    errors.push(err('CANVAS_HEIGHT', `height must be an integer 16..4096, got ${project.height}`));
  }
  if (
    Number.isInteger(project.width) &&
    Number.isInteger(project.height) &&
    (project.width % 2 === 1 || project.height % 2 === 1)
  ) {
    warnings.push(
      warn(
        'H264_ODD_DIMENSIONS',
        `canvas ${project.width}x${project.height} has an odd side — libx264 requires even dimensions; use e.g. ${project.width + (project.width % 2)}x${project.height + (project.height % 2)}`
      )
    );
  }
  if (project.durationMs > 120_000) {
    warnings.push(
      warn('LONG_RENDER', `durationMs ${project.durationMs} (>2min) will render slowly; typical memes are ~10s`)
    );
  }

  // --- duplicate ids ---
  const seen = new Set<string>();
  for (const c of project.clips) {
    if (seen.has(c.id)) errors.push(err('DUPLICATE_ID', `duplicate clip id "${c.id}"`, c.id));
    seen.add(c.id);
  }

  const videos = project.clips.filter((c) => c.kind === 'video');
  const images = project.clips.filter((c) => c.kind === 'image');
  const texts = project.clips.filter((c) => c.kind === 'text');
  const audios = project.clips.filter((c) => c.kind === 'audio');

  if (project.clips.length === 0) {
    warnings.push(warn('EMPTY_PROJECT', 'no clips — renders a black video; add a text or media clip'));
  }
  if (videos.length > 1) {
    warnings.push(
      warn(
        'V1_EXTRA_VIDEO',
        `${videos.length} video clips found — V1 renders only the earliest as the base; extras are ignored`
      )
    );
  }
  // Position (x/y) keyframes are honored by the export; only font-size
  // keyframes are preview-only (mirrors the @memeit/renderer warning).
  const fontSizeKfCount = texts.reduce(
    (n, t) =>
      n +
      (t.keyframes ?? []).filter((k) => k.fontSize != null && k.fontSize !== t.fontSize).length,
    0
  );
  if (fontSizeKfCount > 0) {
    warnings.push(
      warn(
        'KEYFRAME_FONTSIZE_PREVIEW_ONLY',
        `font-size keyframes (${fontSizeKfCount}) are preview-only — export uses each clip's base fontSize; position keyframes are honored`
      )
    );
  }

  const imageIds = new Set(images.map((c) => c.id));

  for (const c of project.clips) {
    const endMs = c.startMs + c.durationMs;
    if (c.startMs >= project.durationMs) {
      errors.push(
        err(
          'CLIP_START_BEYOND_DURATION',
          `"${c.id}" starts at ${c.startMs}ms but the timeline is only ${project.durationMs}ms — it will never show`,
          c.id
        )
      );
    } else if (endMs > project.durationMs) {
      warnings.push(
        warn(
          'CLIP_OVERFLOW',
          `"${c.id}" ends at ${endMs}ms, past the ${project.durationMs}ms timeline — tail is cut (or extend durationMs)`,
          c.id
        )
      );
    }

    if (c.kind === 'text' || c.kind === 'image') {
      if (c.kind === 'text' && c.durationMs < 800) {
        warnings.push(warn('TEXT_SHORT', `"${c.id}" shows for only ${c.durationMs}ms — viewers can't read it; use >=800ms`, c.id));
      }
      for (const k of c.keyframes ?? []) {
        if (k.offsetMs > c.durationMs) {
          errors.push(
            err(
              'KEYFRAME_OUT_OF_RANGE',
              `"${c.id}" keyframe "${k.id}" offset ${k.offsetMs}ms exceeds the clip duration ${c.durationMs}ms`,
              c.id
            )
          );
        }
      }
    }

    if (c.kind === 'video' || c.kind === 'image' || c.kind === 'audio') {
      if (!c.src.trim()) {
        errors.push(err('SRC_EMPTY', `"${c.id}" has an empty src — point it at a media file`, c.id));
        continue;
      }
      if (isUnresolvedRef(c.src)) {
        warnings.push(
          warn(
            'SRC_UNRESOLVED',
            `"${c.id}" src "${c.src}" is a browser-only reference — re-attach the file before rendering (render skips it)`,
            c.id
          )
        );
      } else if (isRemoteSrc(c.src)) {
        warnings.push(
          warn(
            'SRC_REMOTE',
            `"${c.id}" src is a remote URL — download it to a local file first (renderers don't fetch URLs)`,
            c.id
          )
        );
      } else if (opts.checkFiles) {
        const res = opts.checkFiles(c);
        if (res && !res.found) {
          warnings.push(
            warn('MISSING_FILE', `"${c.id}" media not resolved (${res.detail ?? 'unknown reason'}) — render skips it`, c.id)
          );
        }
      }
    }

    if (c.kind === 'video') {
      if (c.bgRemove === 'chroma') {
        if (!HEX_RE.test(c.chromaColor.trim())) {
          warnings.push(warn('COLOR_FORMAT', `"${c.id}" chromaColor "${c.chromaColor}" is not a #RRGGBB hex color`, c.id));
        }
        if (c.bgReplace === 'image') {
          const ids = bgImageIds(c);
          if (ids.length === 0) {
            warnings.push(warn('BG_IMAGE_MISSING', `"${c.id}" bgReplace is "image" but bgImageClipId is unset — falls back to black`, c.id));
          }
          for (const id of ids) {
            if (!imageIds.has(id)) {
              warnings.push(
                warn(
                  'BG_IMAGE_MISSING',
                  `"${c.id}" bgImageClipId "${id}" matches no image clip — skipped (falls back to black if none remain)`,
                  c.id
                )
              );
            }
          }
        }
        if (c.bgReplace === 'color' && !HEX_RE.test((c.bgColor ?? '').trim())) {
          warnings.push(warn('COLOR_FORMAT', `"${c.id}" bgColor "${c.bgColor}" is not a #RRGGBB hex color — falls back to black`, c.id));
        }
      }
      if (c.bgRemove === 'ai') {
        warnings.push(
          warn(
            'AI_CUTOUT_SILENT',
            `"${c.id}" uses AI background removal — the cutout file is silent; add an audio clip if you need the original sound`,
            c.id
          )
        );
      }
    }
  }

  const summary: VerifySummary = {
    clips: project.clips.length,
    video: videos.length,
    image: images.length,
    text: texts.length,
    audio: audios.length,
    width: project.width,
    height: project.height,
    fps: project.fps,
    durationMs: project.durationMs,
  };

  return { ok: errors.length === 0, errors, warnings, project, summary };
}

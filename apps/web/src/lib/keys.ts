import { evalTextAt } from '@memeit/timeline';
import { useEditor, uid } from '../store';
import { addCaptionPersist, addSubtitleAfterLast, focusTextEditor, joinSelectedWithNext, splitSelectedAtPlayhead } from './captions';

export type SheetCtl = { open: () => void; close: () => void; toggle: () => void };

let pendingG = 0;

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

function togglePlay() {
  const st = useEditor.getState();
  if (!st.playing && st.currentTimeMs >= st.project.durationMs - 50) st.setTime(0);
  st.setPlaying(!st.playing);
}

function stepFrame(dir: 1 | -1, big: boolean) {
  const st = useEditor.getState();
  const fps = st.project.fps || 30;
  st.setTime(st.currentTimeMs + dir * (big ? 1000 : 1000 / fps));
}

function selectedClip() {
  const st = useEditor.getState();
  return st.project.clips.find((c) => c.id === st.selectedId) ?? null;
}

function jumpCaption(dir: 1 | -1) {
  const st = useEditor.getState();
  const texts = st.project.clips.filter((c) => c.kind === 'text').sort((a, b) => a.startMs - b.startMs);
  if (texts.length === 0) return;
  const t = st.currentTimeMs;
  const next =
    dir > 0 ? texts.find((c) => c.startMs > t + 50) ?? texts[0]! : [...texts].reverse().find((c) => c.startMs < t - 50) ?? texts[texts.length - 1]!;
  st.select(next.id);
  st.setTime(next.startMs);
}

function duplicateSelected() {
  const st = useEditor.getState();
  const c = selectedClip();
  if (!c) return;
  const startMs = Math.min(st.project.durationMs - c.durationMs, Math.max(0, c.startMs + 500));
  st.addClip({ ...c, id: uid(), name: c.name ? `${c.name} copy` : undefined, startMs: Math.round(startMs) } as never);
  st.setTime(Math.round(startMs));
}

function addKeyframeHere() {
  const st = useEditor.getState();
  const c = selectedClip();
  if (!c || c.kind !== 'text') return;
  const offset = Math.max(0, Math.round(st.currentTimeMs - c.startMs));
  if (offset > c.durationMs) return;
  const cur = evalTextAt(c, st.currentTimeMs);
  const near = (c.keyframes ?? []).find((k) => Math.abs(k.offsetMs - offset) < 120);
  if (near) {
    st.selectKeyframe(near.id);
    return;
  }
  const id = uid();
  st.updateClip(c.id, { keyframes: [...(c.keyframes ?? []), { id, offsetMs: offset, x: cur.x, y: cur.y, fontSize: cur.fontSize }] } as never);
  st.selectKeyframe(id);
}

// Returns 'sheet' when the cheat sheet should toggle, true when handled.
export function handleShortcut(e: KeyboardEvent, sheet: SheetCtl): boolean | 'sheet' {
  if (isTyping(e.target)) {
    if (e.key === 'Escape') (e.target as HTMLElement).blur();
    return false;
  }
  const st = useEditor.getState();
  const k = e.key;

  if (k === 'Escape') {
    pendingG = 0;
    sheet.close();
    if (st.selectedId) st.select(null);
    else if (st.playing) st.setPlaying(false);
    return true;
  }
  if (k === '?') return 'sheet';

  // gg -> timeline start (second g), G -> timeline end
  if (k === 'g') {
    const now = Date.now();
    if (now - pendingG < 600) {
      pendingG = 0;
      st.setTime(0);
      return true;
    }
    pendingG = now;
    return true;
  }
  if (k === 'G') {
    pendingG = 0;
    st.setTime(st.project.durationMs);
    return true;
  }
  pendingG = 0;

  switch (k) {
    case ' ':
    case 'k':
      togglePlay();
      return true;
    case 'ArrowLeft':
    case 'h':
      stepFrame(-1, e.shiftKey);
      return true;
    case 'ArrowRight':
    case 'l':
      stepFrame(1, e.shiftKey);
      return true;
    case 'Home':
      st.setTime(0);
      return true;
    case 'End':
      st.setTime(st.project.durationMs);
      return true;
    case '0': {
      const c = selectedClip();
      if (c) st.setTime(c.startMs);
      return true;
    }
    case '$': {
      const c = selectedClip();
      if (c) st.setTime(c.startMs + c.durationMs);
      return true;
    }
    case 't':
      addCaptionPersist();
      focusTextEditor();
      return true;
    case 's':
      addSubtitleAfterLast();
      focusTextEditor();
      return true;
    case 'S':
      splitSelectedAtPlayhead();
      return true;
    case 'j':
    case 'J':
      joinSelectedWithNext();
      return true;
    case 'e':
    case 'Enter': {
      const c = selectedClip();
      if (c?.kind === 'text') focusTextEditor();
      return true;
    }
    case 'n':
      jumpCaption(1);
      return true;
    case 'N':
      jumpCaption(-1);
      return true;
    case 'd': {
      const c = selectedClip();
      if (c) st.removeClip(c.id);
      return true;
    }
    case 'D':
      duplicateSelected();
      return true;
    case 'Delete':
    case 'Backspace': {
      const c = selectedClip();
      if (c) st.removeClip(c.id);
      return true;
    }
    case 'm':
      addKeyframeHere();
      return true;
    case ',':
    case '.': {
      const c = selectedClip();
      if (c) {
        const d = (k === ',' ? -100 : 100) * (e.shiftKey ? 5 : 1);
        st.updateClip(c.id, { startMs: Math.max(0, Math.round(c.startMs + d)) } as never);
      }
      return true;
    }
    default:
      return false;
  }
}

export const CHEAT_ROWS: { keys: string; what: string }[][] = [
  [
    { keys: 'Space / k', what: 'Play / pause' },
    { keys: 'h / l  ← →', what: '±1 frame (Shift: ±1s)' },
    { keys: 'g g / G', what: 'Timeline start / end' },
    { keys: '0 / $', what: 'Selected clip start / end' },
    { keys: 'Home / End', what: 'Timeline start / end' },
  ],
  [
    { keys: 't', what: 'New caption at playhead (persists)' },
    { keys: 's', what: 'Next subtitle line after last' },
    { keys: 'n / N', what: 'Next / prev caption' },
    { keys: 'e / Enter', what: 'Edit selected text' },
    { keys: 'S (⇧s)', what: 'Cut clip at playhead' },
    { keys: 'j / J', what: 'Join with next same-file clip' },
  ],
  [
    { keys: 'd / Del', what: 'Delete selected clip' },
    { keys: 'D (⇧d)', what: 'Duplicate selected clip' },
    { keys: ', / .', what: 'Nudge clip ∓0.1s (⇧: ∓0.5s)' },
    { keys: 'm', what: 'Add motion keyframe here' },
    { keys: '? / Esc', what: 'Cheat sheet / close · deselect' },
  ],
];

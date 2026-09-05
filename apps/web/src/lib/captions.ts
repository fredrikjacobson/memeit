import { useEditor, uid } from '../store';

export const baseTextStyle = (y = -0.35) => ({
  font: 'Impact',
  fontSize: 64,
  color: '#ffffff',
  strokeColor: '#000000',
  strokeWidth: 4,
  x: 0,
  y,
  keyframes: [],
});

// Caption at playhead that persists to end of timeline (min 3s)
export function addCaptionPersist() {
  const st = useEditor.getState();
  const start = Math.round(st.currentTimeMs);
  const remaining = st.project.durationMs - start;
  const durationMs = Math.max(3000, Math.min(300_000, remaining > 500 ? remaining : 4000));
  if (start + durationMs > st.project.durationMs) {
    st.updateProject((p) => ({ ...p, durationMs: Math.min(300_000, start + durationMs) }));
  }
  const textCount = st.project.clips.filter((c) => c.kind === 'text').length;
  st.addClip({
    id: uid(),
    kind: 'text',
    text: 'TOP TEXT',
    startMs: start,
    durationMs,
    ...baseTextStyle(textCount % 2 === 1 ? 0.35 : -0.35),
  });
  st.setTime(start);
}

// Next chained subtitle line starting where the last caption ends
export function addSubtitleAfterLast() {
  const st = useEditor.getState();
  const texts = st.project.clips.filter((c) => c.kind === 'text');
  const start = texts.length
    ? Math.max(...texts.map((c) => c.startMs + c.durationMs))
    : Math.round(st.currentTimeMs);
  const durationMs = 3000;
  if (start + durationMs > st.project.durationMs) {
    st.updateProject((p) => ({ ...p, durationMs: Math.min(300_000, start + durationMs) }));
  }
  const at = Math.min(start, st.project.durationMs - 500);
  st.addClip({
    id: uid(),
    kind: 'text',
    text: 'NEXT LINE',
    startMs: Math.max(0, at),
    durationMs,
    ...baseTextStyle(-0.35),
  });
  st.setTime(Math.max(0, at));
}

export function focusTextEditor() {
  // Inspector textarea carries id="insp-text"
  requestAnimationFrame(() => {
    const el = document.getElementById('insp-text') as HTMLTextAreaElement | null;
    if (el) {
      el.focus();
      el.select();
    }
  });
}

// Cut whichever clip is selected at the playhead. The second half keeps
// playing from where the cut happened via srcOffsetMs (audio/video).
// Returns true when a split happened.
export function splitSelectedAtPlayhead(): boolean {
  const st = useEditor.getState();
  const c = st.project.clips.find((x) => x.id === st.selectedId);
  if (!c) return false;
  const at = Math.round(st.currentTimeMs);
  if (at <= c.startMs + 300 || at >= c.startMs + c.durationMs - 300) return false;
  const cutOffset = at - c.startMs;
  const secondDur = c.startMs + c.durationMs - at;
  st.updateClip(c.id, { durationMs: cutOffset } as never);
  const second: Record<string, unknown> = { ...c, id: uid(), startMs: at, durationMs: secondDur };
  if (c.kind === 'video' || c.kind === 'audio') {
    second.srcOffsetMs = (c.srcOffsetMs ?? 0) + cutOffset;
  }
  st.addClip(second as never);
  if (c.kind === 'text') focusTextEditor();
  return true;
}

// Find the clip that can join with the given one: same kind + same file,
// starting where this one ends with a contiguous file offset.
export function findJoinPartner(clipId: string) {
  const st = useEditor.getState();
  const c = st.project.clips.find((x) => x.id === clipId);
  if (!c || (c.kind !== 'audio' && c.kind !== 'video' && c.kind !== 'text')) return null;
  const end = c.startMs + c.durationMs;
  const next = st.project.clips
    .filter((x) => x.id !== c.id && x.kind === c.kind)
    .sort((a, b) => a.startMs - b.startMs)
    .find((x) => Math.abs(x.startMs - end) < 150);
  if (!next) return null;
  if (c.kind === 'audio' || c.kind === 'video') {
    if ((c as { src: string }).src !== (next as { src: string }).src) return null;
    const off = (c as { srcOffsetMs?: number }).srcOffsetMs ?? 0;
    const noff = (next as { srcOffsetMs?: number }).srcOffsetMs ?? 0;
    if (Math.abs(noff - (off + c.durationMs)) > 150) return null;
  }
  return next;
}

// Merge the selected clip with its join partner. Returns true on success.
export function joinSelectedWithNext(): boolean {
  const st = useEditor.getState();
  const c = st.project.clips.find((x) => x.id === st.selectedId);
  if (!c) return false;
  const next = findJoinPartner(c.id);
  if (!next) return false;
  st.updateClip(c.id, { durationMs: next.startMs + next.durationMs - c.startMs } as never);
  // removeClip clears selection if it was the removed one — re-select survivor
  const keepId = c.id;
  st.removeClip(next.id);
  st.select(keepId);
  return true;
}

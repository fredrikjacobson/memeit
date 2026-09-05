import { evalTextAt, uid } from '@memeit/timeline';
import { useEditor } from '../store';
import { findJoinPartner, focusTextEditor, joinSelectedWithNext, splitSelectedAtPlayhead } from '../lib/captions';

const PRESETS = [
  { label: '9:16', w: 1080, h: 1920 },
  { label: '1:1', w: 1080, h: 1080 },
  { label: '16:9', w: 1920, h: 1080 },
];

export default function Inspector() {
  const project = useEditor((s) => s.project);
  const selectedId = useEditor((s) => s.selectedId);
  const selectedKeyframeId = useEditor((s) => s.selectedKeyframeId);
  const selectKeyframe = useEditor((s) => s.selectKeyframe);
  const autoKey = useEditor((s) => s.autoKey);
  const setAutoKey = useEditor((s) => s.setAutoKey);
  const updateClip = useEditor((s) => s.updateClip);
  const updateProject = useEditor((s) => s.updateProject);
  const setTime = useEditor((s) => s.setTime);
  const currentTimeMs = useEditor((s) => s.currentTimeMs);

  const clip = project.clips.find((c) => c.id === selectedId);

  return (
    <div>
      <div className="field">
        <span>Canvas preset</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              className={`btn btn-sm${project.width === p.w && project.height === p.h ? ' active' : ''}`}
              onClick={() => updateProject((pr) => ({ ...pr, width: p.w, height: p.h }))}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="row2">
        <div className="field">
          <span>W</span>
          <input
            className="num-input"
            type="number"
            value={project.width}
            onChange={(e) => updateProject((p) => ({ ...p, width: Number(e.target.value) || 1080 }))}
          />
        </div>
        <div className="field">
          <span>H</span>
          <input
            className="num-input"
            type="number"
            value={project.height}
            onChange={(e) => updateProject((p) => ({ ...p, height: Number(e.target.value) || 1920 }))}
          />
        </div>
      </div>

      {!clip && <div style={{ color: 'var(--muted)', fontSize: 12 }}>Select a clip to edit timing, text and motion.</div>}

      {clip && (
        <div>
          <div className="clip-head">
            <span className={`pill ${clip.kind}`}>{clip.kind}</span>
            <span className="clip-name">{clip.name ?? (clip.kind === 'text' ? clip.text : clip.id)}</span>
          </div>
          <div className="row2">
            <div className="field">
              <span>Start (s)</span>
              <input
                className="num-input"
                type="number"
                step={0.1}
                value={Number(clip.startMs / 1000).toFixed(1)}
                onChange={(e) => updateClip(clip.id, { startMs: Number(e.target.value) * 1000 } as never)}
              />
            </div>
            <div className="field">
              <span>Duration (s)</span>
              <input
                className="num-input"
                type="number"
                step={0.1}
                min={0.1}
                value={Number(clip.durationMs / 1000).toFixed(1)}
                onChange={(e) => updateClip(clip.id, { durationMs: Number(e.target.value) * 1000 } as never)}
              />
            </div>
          </div>
          <button className="btn btn-block btn-sm" onClick={() => setTime(clip.startMs)}>
            Jump to clip start
          </button>

          {clip.kind === 'text' && (
            <>
              <div className="field" style={{ marginTop: 12 }}>
                <span>Text (multiline = SRT lines)</span>
                <textarea
                  id="insp-text"
                  className="text-input"
                  rows={3}
                  value={clip.text}
                  onChange={(e) => updateClip(clip.id, { text: e.target.value.slice(0, 500) })}
                  style={{ resize: 'vertical', lineHeight: 1.4 }}
                />
              </div>
              <TextTimingTools clipId={clip.id} />
              <div className="field">
                <span>Base position — drag on canvas or use sliders</span>
                <label style={{ fontSize: 12 }}>X <input type="range" min={-0.5} max={0.5} step={0.01} value={clip.x} onChange={(e) => updateClip(clip.id, { x: Number(e.target.value) })} /></label>
                <label style={{ fontSize: 12 }}>Y <input type="range" min={-0.5} max={0.5} step={0.01} value={clip.y} onChange={(e) => updateClip(clip.id, { y: Number(e.target.value) })} /></label>
              </div>
              <div className="field">
                <span>Size ({clip.fontSize}px)</span>
                <input type="range" min={20} max={150} value={clip.fontSize} onChange={(e) => updateClip(clip.id, { fontSize: Number(e.target.value) })} />
              </div>

              <KeyframeEditor clipId={clip.id} />
            </>
          )}
          {(clip.kind === 'video' || clip.kind === 'audio') && (
            <div className="field" style={{ marginTop: 12 }}>
              <span>Volume ({clip.volume.toFixed(2)})</span>
              <input
                type="range"
                min={0}
                max={clip.kind === 'audio' ? 2 : 1}
                step={0.05}
                value={clip.volume}
                onChange={(e) => updateClip(clip.id, { volume: Number(e.target.value) } as never)}
              />
            </div>
          )}
        </div>
      )}

      <details className="json">
        <summary style={{ cursor: 'pointer' }}>Project JSON</summary>
        <pre>{JSON.stringify(project, null, 1).slice(0, 3000)}</pre>
      </details>
    </div>
  );

  function TextTimingTools({ clipId }: { clipId: string }) {
    const c = useEditor.getState().project.clips.find((x) => x.id === clipId);
    if (!c) return null;
    const st = useEditor.getState();
    const joinable = findJoinPartner(c.id);
    const nudge = (dMs: number) =>
      st.updateClip(c.id, { startMs: Math.max(0, Math.round(c.startMs + dMs)) } as never);
    const extendToEnd = () =>
      st.updateClip(c.id, { durationMs: Math.max(500, Math.round(st.project.durationMs - c.startMs)) } as never);
    const endAtPlayhead = () => {
      const d = Math.round(st.currentTimeMs - c.startMs);
      if (d >= 300) st.updateClip(c.id, { durationMs: d } as never);
    };
    const startAtPlayhead = () => {
      const ns = Math.round(st.currentTimeMs);
      const end = c.startMs + c.durationMs;
      if (end > ns + 300) {
        st.updateClip(c.id, { startMs: ns, durationMs: Math.round(end - ns) } as never);
      } else {
        st.updateClip(c.id, { startMs: ns } as never);
      }
    };
    const split = () => {
      splitSelectedAtPlayhead();
    };
    return (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
        {(c.kind === 'audio' || c.kind === 'video') && (c.srcOffsetMs ?? 0) > 0 && (
          <span style={{ fontSize: 11, color: 'var(--muted)', width: '100%' }}>
            Starts {((c.srcOffsetMs ?? 0) / 1000).toFixed(2)}s into the file (cut piece)
          </span>
        )}
        <button className="btn btn-sm" onClick={() => nudge(-500)} title="Move 0.5s earlier">−0.5s</button>
        <button className="btn btn-sm" onClick={() => nudge(500)} title="Move 0.5s later">+0.5s</button>
        <button className="btn btn-sm" onClick={startAtPlayhead} title="Set start to playhead">Start=▶</button>
        <button className="btn btn-sm" onClick={endAtPlayhead} title="Set end to playhead">End=▶</button>
        <button className="btn btn-sm" onClick={extendToEnd} title="Persist to end of timeline">Persist ▸end</button>
        <button className="btn btn-sm" onClick={split} title="Cut clip at playhead (S)">Cut ✂</button>
        {joinable && (
          <button className="btn btn-sm" onClick={() => joinSelectedWithNext()} title="Join with next same-file clip (J)">
            Join ⏭
          </button>
        )}
      </div>
    );
  }

  function KeyframeEditor({ clipId }: { clipId: string }) {
    const c = useEditor.getState().project.clips.find((x) => x.id === clipId);
    if (!c || c.kind !== 'text') return null;
    const kfs = [...(c.keyframes ?? [])].sort((a, b) => a.offsetMs - b.offsetMs);
    const offset = Math.max(0, Math.round(currentTimeMs - c.startMs));
    const cur = evalTextAt(c, currentTimeMs);

    const addKf = () => {
      // replace keyframe within 120ms to avoid stacking
      const near = kfs.find((k) => Math.abs(k.offsetMs - offset) < 120);
      if (near) {
        selectKeyframe(near.id);
        setTime(c.startMs + near.offsetMs);
        return;
      }
      const id = uid();
      updateClip(c.id, { keyframes: [...kfs, { id, offsetMs: offset, x: cur.x, y: cur.y, fontSize: cur.fontSize }] } as never);
      selectKeyframe(id);
    };

    return (
      <div className="kf-box">
        <div className="kf-head">
          <b>Motion keyframes ({kfs.length})</b>
          <label style={{ fontSize: 11, display: 'flex', gap: 4, alignItems: 'center' }}>
            <input type="checkbox" checked={autoKey} onChange={(e) => setAutoKey(e.target.checked)} /> auto-key on drag
          </label>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
          Move playhead, drag text or press add — position interpolates linearly between keys.
        </div>
        <button className="btn btn-sm btn-block" onClick={addKf}>
          ◆ Add keyframe @{(offset / 1000).toFixed(2)}s
        </button>
        {kfs.map((k) => (
          <div key={k.id} className={`kf-row${selectedKeyframeId === k.id ? ' selected' : ''}`}>
            <button className="icon-btn" title="Jump" onClick={() => { setTime(c.startMs + k.offsetMs); selectKeyframe(k.id); }}>
              ◆ {(k.offsetMs / 1000).toFixed(2)}s
            </button>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
              x{k.x.toFixed(2)} y{k.y.toFixed(2)}
            </span>
            <button
              className="icon-btn"
              title="Delete keyframe"
              onClick={() => {
                updateClip(c.id, { keyframes: kfs.filter((x) => x.id !== k.id) } as never);
                if (selectedKeyframeId === k.id) selectKeyframe(null);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    );
  }
}

import { CHEAT_ROWS } from '../lib/keys';

export default function CheatSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <b>⌨ Keyboard shortcuts</b>
          <span className="time">vim-style · inactive while typing · Esc closes</span>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
        <div className="sheet-grid">
          {CHEAT_ROWS.map((group, i) => (
            <div key={i} className="sheet-col">
              {group.map((r) => (
                <div key={r.keys} className="sheet-row">
                  <kbd>{r.keys}</kbd>
                  <span>{r.what}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="sheet-foot">
          Tips: <kbd>t</kbd> then type immediately · <kbd>s</kbd> chains the next line · <kbd>n</kbd> hops between captions · <kbd>0</kbd>/<kbd>$</kbd> jump to the selected clip's edges · <kbd>g</kbd><kbd>g</kbd>/<kbd>G</kbd> timeline ends.
        </div>
      </div>
    </div>
  );
}

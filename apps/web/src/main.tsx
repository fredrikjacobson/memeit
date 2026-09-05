import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { useEditor } from './store';
import { loadProjectLocal, rehydrateProject, saveProjectLocal } from './lib/persist';

async function boot() {
  // restore autosaved project, then re-link media blobs from IndexedDB
  const saved = loadProjectLocal();
  if (saved) {
    const { project, missing } = await rehydrateProject(saved);
    useEditor.setState({ project, selectedId: null, selectedKeyframeId: null, currentTimeMs: 0, playing: false });
    if (missing.length > 0) {
      console.warn('Missing media after reload:', missing);
    }
  }

  // autosave (debounced) — blobs live in IDB, localStorage only holds asset refs
  let t: number | undefined;
  useEditor.subscribe((s) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => saveProjectLocal(s.project), 400);
  });

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void boot();

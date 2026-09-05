import { createApp } from './app.js';
import { resolveDataDir, resolvePublicDir } from './paths.js';

const { app, dataDir, publicDir } = createApp({
  dataDir: resolveDataDir(),
  publicDir: resolvePublicDir() ?? undefined,
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`render-api on http://localhost:${port}`);
  console.log(`data: ${dataDir}`);
  if (publicDir) console.log(`ui: ${publicDir}`);
});

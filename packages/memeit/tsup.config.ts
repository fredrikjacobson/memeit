import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  outDir: 'dist',
  // Inline workspace packages so the published tarball is self-contained.
  // Everything else (express, sharp, zod, …) stays external and installs via npm.
  // @google-cloud/text-to-speech is dynamically imported — keep it external/optional.
  noExternal: [/@memeit\/.+/],
  // Dynamically imported + optional — must stay a runtime import so the
  // package installs and runs without Google credentials (or without the dep).
  external: ['@google-cloud/text-to-speech'],
  // NOTE: no banner — esbuild preserves the #! from src/cli.ts.
  // Adding banner.js here would emit a duplicate shebang (syntax error).
});

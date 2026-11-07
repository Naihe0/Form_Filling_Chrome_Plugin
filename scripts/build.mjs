/**
 * Bundles the extension into dist/. Load that folder via "Load unpacked".
 *
 * Every entry point is a self-contained IIFE: content scripts cannot use ES
 * modules without exposing web-accessible resources, and one format keeps the
 * service worker, popup and content scripts uniform.
 */
import { context, build } from 'esbuild';
import { cp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, 'dist');
const watching = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  absWorkingDir: root,
  entryPoints: {
    background: 'src/background/index.ts',
    fill: 'src/content/fill.ts',
    'quick-query': 'src/content/quick-query.ts',
    popup: 'src/popup/index.ts',
  },
  outdir,
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  // Chrome refuses content scripts that are not valid UTF-8; keep CJK literal.
  charset: 'utf8',
  logLevel: 'info',
};

await rm(outdir, { recursive: true, force: true });
await cp(resolve(root, 'public'), outdir, { recursive: true });

if (watching) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
